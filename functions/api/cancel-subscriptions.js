/* ============================================================
   functions/api/cancel-subscriptions.js — cancel ALL of the caller's subs
   ------------------------------------------------------------
   POST /api/cancel-subscriptions  (authenticated). Finds every Stripe customer
   matching the signed-in user's email, cancels every non-cancelled subscription
   on them IMMEDIATELY, and clears the user's Supabase row. Scoped to the caller's
   own email, so it can only affect their own data. Runs in whatever Stripe
   environment the site's key belongs to (test now), so no dashboard needed.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (secret),
        STRIPE_SECRET_KEY (secret)
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
  if (!user.email) return json({ error: 'no_email' }, 400);

  try {
    // Every customer for this email (+ any stored id), de-duplicated.
    const customers = new Set();
    const byEmail = await stripeGet(env, 'customers?limit=100&email=' + encodeURIComponent(user.email));
    (byEmail.data || []).forEach(function (c) { customers.add(c.id); });
    const stored = await storedCustomerId(env, token, user.id);
    if (stored) customers.add(stored);

    let canceled = 0;
    for (const cid of customers) {
      const subs = await stripeGet(env, 'subscriptions?status=all&limit=100&customer=' + cid);
      for (const s of (subs.data || [])) {
        if (s.status === 'canceled' || s.status === 'incomplete_expired') continue;
        await stripeDelete(env, 'subscriptions/' + s.id); // cancel immediately
        canceled++;
      }
    }

    // Reset the app's view: drop the user's subscription row (service role).
    await fetch(env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + user.id, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
    });

    return json({ ok: true, customers: customers.size, canceled }, 200);
  } catch (e) {
    return json({ error: 'cleanup_failed', detail: String(e && e.message || e) }, 500);
  }
}

async function storedCustomerId(env, token, uid) {
  try {
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + uid + '&select=stripe_customer_id',
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] && rows[0].stripe_customer_id || null;
  } catch (_) { return null; }
}

async function stripeGet(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
  const d = await r.json();
  if (!r.ok) throw new Error('stripe GET ' + path + ': ' + (d && d.error && d.error.message));
  return d;
}
async function stripeDelete(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
  const d = await r.json();
  if (!r.ok) throw new Error('stripe DELETE ' + path + ': ' + (d && d.error && d.error.message));
  return d;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
