/* ============================================================
   functions/api/attrib.js — record the ad click that made an account
   ------------------------------------------------------------
   POST /api/attrib  { gclid, utm_*, landing_page, referrer, first_seen }
   (called by attrib.js the first time a NEW user's session appears).

   Verifies the caller's Supabase token, then writes ONE row per user
   with the service role. First write wins: a returning user re-posting
   never overwrites the click that originally produced the account.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY (verify), SUPABASE_SERVICE_ROLE_KEY (write)
   Table + why it exists: supabase_ad_attribution.sql

   ⚠ Fails SILENTLY from the caller's point of view — attribution is
   measurement, never something a user should notice or be blocked by.
   Errors are returned for debugging but attrib.js ignores them.
   ============================================================ */

const FIELDS = [
  'gclid', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'landing_page', 'referrer',
];

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
  if (!user.id) return json({ error: 'no_user' }, 400);

  let body = {};
  try { body = (await request.json()) || {}; } catch (_) {}

  // Whitelist + clamp. Nothing here is displayed anywhere, but an
  // unbounded string from a URL is still not something to store.
  const row = { user_id: user.id };
  let any = false;
  for (const f of FIELDS) {
    const v = body[f];
    if (typeof v === 'string' && v.trim()) {
      row[f] = v.trim().slice(0, 512);
      any = true;
    }
  }
  if (body.first_seen && typeof body.first_seen === 'string') {
    const t = Date.parse(body.first_seen);
    if (!isNaN(t)) row.first_seen = new Date(t).toISOString();
  }

  // An organic signup has nothing to attribute. Don't write an empty row —
  // absence of a row IS the "came from nowhere we paid for" signal.
  if (!any) return json({ ok: true, skipped: 'no_attribution' }, 200);

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: true, skipped: 'no_key' }, 200);

  try {
    // Plain insert, NOT upsert: the FIRST click that produced the account is
    // the true one. A 409 here means we already have it, which is success.
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/ad_attribution', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (r.status === 409) return json({ ok: true, already: true }, 200);
    if (!r.ok) {
      return json({ error: 'db_error', status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
    }
  } catch (e) {
    return json({ error: 'db_unavailable', detail: String((e && e.message) || e) }, 502);
  }

  return json({ ok: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
