/* ============================================================
   functions/api/seen.js — record that a signed-in user was here
   ------------------------------------------------------------
   POST /api/seen  { listen?: true }
   (called by auth.js once per page load, and by attrib.js's play
   handler at most once every 5 minutes — see RETENTION_MEASUREMENT.md §3.)

   Answers ONE question that nothing else on the site can: what share of
   accounts are seen on a day AFTER they signed up. `progress` needs a
   manual tap, `last_sign_in_at` only moves on a fresh sign-in, and
   `updated_at` moves for reasons that have nothing to do with the user
   (ten rows share one timestamp from a bulk server-side event).

   Env: SUPABASE_URL, SUPABASE_ANON_KEY (verify), SUPABASE_SERVICE_ROLE_KEY (write)
   Table + the whole rationale: RETENTION_MEASUREMENT.md

   ⚠ FAILS SILENTLY from the caller's point of view. This is measurement;
   a user must never be blocked, slowed, or shown an error because of it.
   It always answers 200 unless the caller is unauthenticated.

   ⚠ NO DEVICE STORAGE IS INVOLVED, anywhere in this feature. The dedupe
   guards are in memory, and the session rule is decided HERE from
   last_seen_at. That is what keeps it outside PECR reg 6 and therefore
   consent-free — see RETENTION_MEASUREMENT.md §4a before changing it.
   ============================================================ */

/* A visit is "the same session" until this much time has passed with no
   ping. ⚠ The play handler refreshes last_seen_at every 5 minutes precisely
   so that a long uninterrupted listen does not fall through this gap and
   get counted as a second session (§3). */
const SESSION_GAP_MS = 30 * 60 * 1000;

export async function onRequestPost({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  let user;
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return json({ error: 'forbidden' }, 403);
    user = await who.json();
  } catch (_) {
    return json({ error: 'auth_unavailable' }, 503);
  }
  if (!user || !user.id) return json({ error: 'no_user' }, 400);

  let body = {};
  try { body = (await request.json()) || {}; } catch (_) {}
  const isListen = body.listen === true;
  /* The client batches plays and sends the tally, so `listens` is a real count of
     clips rather than of five-minute windows. Clamped: this arrives from a browser,
     and an unbounded increment is not something to take on trust. */
  const listenCount = isListen ? Math.max(1, Math.min(500, parseInt(body.count, 10) || 1)) : 0;

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: true, skipped: 'no_key' }, 200);

  const H = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
  const BASE = env.SUPABASE_URL + '/rest/v1/user_activity';

  try {
    // 1. What do we already hold for this user?
    const got = await fetch(BASE + '?user_id=eq.' + encodeURIComponent(user.id) +
                            '&select=last_seen_at,days_active,sessions,listens', { headers: H });
    if (!got.ok) {
      return json({ error: 'db_error', status: got.status, detail: (await got.text()).slice(0, 300) }, 502);
    }
    const rows = await got.json();

    // 2. First time we have ever seen them: one row, defaults are already right.
    if (!rows.length) {
      const ins = await fetch(BASE, {
        method: 'POST',
        headers: Object.assign({ Prefer: 'return=minimal' }, H),
        body: JSON.stringify({ user_id: user.id, listens: listenCount }),
      });
      /* 409 = another tab inserted first. That is success, not an error — auth.js
         fires several times per load, and two of them can race. */
      if (!ins.ok && ins.status !== 409) {
        return json({ error: 'db_error', status: ins.status, detail: (await ins.text()).slice(0, 300) }, 502);
      }
      return json({ ok: true, created: true }, 200);
    }

    // 3. Returning: decide the two counters SERVER-SIDE from what we hold.
    const row = rows[0];
    const now = new Date();
    const last = new Date(row.last_seen_at);
    const gapMs = now.getTime() - last.getTime();

    /* ⚠ UTC DAYS, deliberately and permanently. Every timestamp on this project is
       recorded in UTC, so a Bangkok user active at 06:00 ICT counts against the
       previous UTC day. That is a definition, not a bug: switching it to a local
       timezone later would make the numbers before and after incomparable. If ICT
       is ever wanted it is a NEW column, not an edit. See RETENTION_MEASUREMENT.md §3. */
    const newDay = now.toISOString().slice(0, 10) !== last.toISOString().slice(0, 10);
    const newSession = gapMs > SESSION_GAP_MS;

    const patch = { last_seen_at: now.toISOString() };
    if (newDay) patch.days_active = (row.days_active || 0) + 1;
    if (newSession) patch.sessions = (row.sessions || 0) + 1;
    if (isListen) patch.listens = (row.listens || 0) + listenCount;

    const upd = await fetch(BASE + '?user_id=eq.' + encodeURIComponent(user.id), {
      method: 'PATCH',
      headers: Object.assign({ Prefer: 'return=minimal' }, H),
      body: JSON.stringify(patch),
    });
    if (!upd.ok) {
      return json({ error: 'db_error', status: upd.status, detail: (await upd.text()).slice(0, 300) }, 502);
    }
    return json({ ok: true, newDay: newDay, newSession: newSession }, 200);
  } catch (e) {
    return json({ error: 'db_unavailable', detail: String((e && e.message) || e) }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
