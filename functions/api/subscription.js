/* ============================================================
   functions/api/subscription.js — live subscription state for the account page
   ------------------------------------------------------------
   GET /api/subscription (authenticated). Reads the caller's current subscription
   straight from Stripe so the account page is always accurate immediately (the
   Supabase copy, written by the webhook, can lag a few seconds). Returns:
     { subscribed, status, cancel_at_period_end, current_period_end }

   The audio gate still uses the Supabase copy; this is display-only.
   Env: SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY
   ============================================================ */

export async function onRequestGet({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  let user;
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return json({ error: 'forbidden' }, 403);
    user = await who.json();
  } catch (_) { return json({ error: 'auth_unavailable' }, 503); }

  if (!env.STRIPE_SECRET_KEY) return json({ subscribed: false }, 200);

  try {
    // Resolve the customer: stored id (if still valid) else by email.
    let customer = await storedCustomerId(env, token, user.id);
    if (customer) {
      const c = await stripeGet(env, 'customers/' + customer);
      if (!c || c.deleted || c.error) customer = null;
    }
    if (!customer && user.email) {
      const list = await stripeGet(env, 'customers?limit=1&email=' + encodeURIComponent(user.email));
      customer = (list && list.data && list.data[0] && list.data[0].id) || null;
    }
    if (!customer) return json({ subscribed: false }, 200);

    const subs = await stripeGet(env, 'subscriptions?status=all&limit=10&customer=' + customer);
    const list = (subs && subs.data) || [];
    const chosen = list.find(function (s) { return s.status === 'active' || s.status === 'trialing'; }) || list[0] || null;
    if (!chosen) return json({ subscribed: false }, 200);

    return json({
      subscribed: chosen.status === 'active' || chosen.status === 'trialing',
      status: chosen.status,
      cancel_at_period_end: !!chosen.cancel_at_period_end,
      current_period_end: chosen.current_period_end ? new Date(chosen.current_period_end * 1000).toISOString() : null,
    }, 200);
  } catch (e) {
    return json({ error: 'lookup_failed', detail: String(e && e.message || e) }, 200);
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
  return r.json();
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
