/* ============================================================
   functions/api/cancel.js — cancel (or resume) the caller's membership
   ------------------------------------------------------------
   POST /api/cancel        → set cancel_at_period_end = true  (won't renew)
   POST /api/cancel {resume:true} → set it back to false      (keep renewing)

   Finds the caller's ACTIVE subscription across ALL their Stripe customers (so
   it works even with leftover duplicate customers) and flips the flag directly —
   no dependence on which customer a hosted portal happens to open. Cancels at
   period end, so access continues until the paid period ends.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY
   ============================================================ */

export async function onRequestPost({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'config', detail: 'STRIPE_SECRET_KEY missing' }, 500);

  let user;
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return json({ error: 'forbidden' }, 403);
    user = await who.json();
  } catch (_) { return json({ error: 'auth_unavailable' }, 503); }

  let resume = false;
  try { const b = await request.json(); resume = b && b.resume === true; } catch (_) {}

  try {
    const ids = new Set();
    const stored = await storedCustomerId(env, token, user.id);
    if (stored) ids.add(stored);
    if (user.email) {
      const l = await stripeGet(env, 'customers?limit=100&email=' + encodeURIComponent(user.email));
      (l && l.data || []).forEach(function (c) { ids.add(c.id); });
    }

    let changed = 0;
    for (const id of ids) {
      const subs = await stripeGet(env, 'subscriptions?status=all&limit=100&customer=' + id);
      for (const s of (subs && subs.data || [])) {
        if (s.status !== 'active' && s.status !== 'trialing') continue;
        if (!!s.cancel_at_period_end === !resume) continue; // already in the desired state
        await stripePost(env, 'subscriptions/' + s.id, { cancel_at_period_end: resume ? 'false' : 'true' });
        changed++;
      }
    }
    return json({ ok: true, changed: changed, resume: resume }, 200);
  } catch (e) {
    return json({ error: 'failed', detail: String(e && e.message || e) }, 500);
  }
}

async function storedCustomerId(env, token, uid) {
  try {
    for (const table of ['profiles', 'subscriptions']) {
      const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + table + '?user_id=eq.' + uid + '&select=stripe_customer_id',
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
      if (!r.ok) continue;
      const rows = await r.json();
      if (rows[0] && rows[0].stripe_customer_id) return rows[0].stripe_customer_id;
    }
  } catch (_) {}
  return null;
}

async function stripeGet(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
  return r.json();
}
async function stripePost(env, path, fields) {
  const body = new URLSearchParams(fields).toString();
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body,
  });
  const d = await r.json();
  if (!r.ok) throw new Error('stripe POST ' + path + ': ' + (d && d.error && d.error.message));
  return d;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
