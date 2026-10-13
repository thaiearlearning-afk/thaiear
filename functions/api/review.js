/* ============================================================
   functions/api/review.js — may the app show Google's rating card now?
   ------------------------------------------------------------
   POST /api/review  → { ok, ask, reason? }  the moment itself: decides AND records an ask
   GET  /api/review  → { ok, ask, reason? }  the same answer, recorded nowhere (owner panel)

   Called only by Live/review.js: inside the Android app 1.8+ (the InAppReview plugin), at the
   end of a quiz, signed in. Plan: GOOGLE_PAYMENTS_PLAN.md §8b.

   THE RULE (owner, 2026-10-13: days, server memory, any score, quizzes only):
     · the first quiz finished on or after the account's 3rd day of use → ask;
     · the first one after 6 MORE days of use → ask again (3rd → 9th for a new account; an
       account already past day 9 when this shipped is not asked twice in a row);
     · then never.
   "Days of use" = user_activity.days_active, the activity tracking's count of UTC days on which
   the account was seen signed in (functions/api/seen.js; RETENTION_MEASUREMENT.md §3).

   ⛔ NOTHING ON THE DEVICE. The asks live beside that count (user_activity.review_asks,
      review_last_day), so this stays outside PECR reg 6 like the rest of the table.
   ⛔ AN ANSWER, NOT A CARD. Google decides whether its card appears (a quota it never reveals)
      and never says whether a review was left. An ask is spent the moment it is given.
   ⚠ NEVER AN ERROR A PAGE HAS TO HANDLE. Every expected state is 200 { ask: false, reason }.
      Until supabase_user_activity_review.sql has run, the columns do not exist and every answer
      is { ask: false, reason: 'not_ready' }. Reasons: not_ready · no_row · not_yet · gap · done ·
      raced. Nothing about the account is returned beyond ask and reason.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY (verify), SUPABASE_SERVICE_ROLE_KEY (read + write)
   ============================================================ */

const FIRST_DAY = 3;   // the first ask: on or after the 3rd day of use
const GAP_DAYS = 6;    // the second: 6 more days of use after the first (the 3rd → 9th gap)
const MAX_ASKS = 2;    // then never

export async function onRequestPost(context) { return handle(context, true); }
export async function onRequestGet(context) { return handle(context, false); }

async function handle({ request, env }, record) {
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

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: true, ask: false, reason: 'not_ready' }, 200);

  const H = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
  const ROW = env.SUPABASE_URL + '/rest/v1/user_activity?user_id=eq.' + encodeURIComponent(user.id);

  try {
    const got = await fetch(ROW + '&select=days_active,review_asks,review_last_day', { headers: H });
    if (!got.ok) {
      /* 400 = a named column does not exist: the SQL has not run yet. That is a state, not a
         fault, and the page must never see it as one. */
      if (got.status === 400) return json({ ok: true, ask: false, reason: 'not_ready' }, 200);
      return json({ ok: false, ask: false, error: 'db_error', status: got.status }, 502);
    }
    const rows = await got.json();
    if (!rows.length) return json({ ok: true, ask: false, reason: 'no_row' }, 200);

    const d = decide(rows[0]);
    if (!d.ask || !record) return json(d.ask ? { ok: true, ask: true } : { ok: true, ask: false, reason: d.reason }, 200);

    /* Record it, but only if no ask was recorded since we read: two quizzes finishing at once on
       two devices must not both be told yes. Zero rows back = the other one won. */
    const upd = await fetch(ROW + '&review_asks=eq.' + d.asks, {
      method: 'PATCH',
      headers: Object.assign({ Prefer: 'return=representation' }, H),
      body: JSON.stringify({ review_asks: d.asks + 1, review_last_day: d.days }),
    });
    if (!upd.ok) return json({ ok: false, ask: false, error: 'db_error', status: upd.status }, 502);
    const done = await upd.json();
    if (!Array.isArray(done) || !done.length) return json({ ok: true, ask: false, reason: 'raced' }, 200);
    return json({ ok: true, ask: true }, 200);
  } catch (_) {
    return json({ ok: false, ask: false, error: 'db_unavailable' }, 502);
  }
}

function decide(row) {
  const days = row.days_active || 0;
  const asks = row.review_asks || 0;
  if (asks >= MAX_ASKS) return { ask: false, reason: 'done', days: days, asks: asks };
  const due = asks === 0 ? FIRST_DAY
    : (row.review_last_day == null ? FIRST_DAY : row.review_last_day) + GAP_DAYS;
  if (days < due) return { ask: false, reason: asks === 0 ? 'not_yet' : 'gap', days: days, asks: asks };
  return { ask: true, days: days, asks: asks };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
