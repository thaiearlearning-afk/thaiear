/* ============================================================
   functions/api/portal.js — open the Stripe Customer Portal (Phase 4)
   ------------------------------------------------------------
   POST /api/portal  (account.html "Manage subscription" button). Verifies the
   user, finds their Stripe customer id, and returns a Billing Portal URL where
   they can update payment details or cancel.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY, SITE_URL (optional)
   ============================================================ */

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
  } catch (_) { return json({ error: 'auth_unavailable' }, 503); }

  // Their own subscription row (RLS) gives the Stripe customer id.
  let customer = null;
  try {
    const r = await fetch(
      env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + user.id + '&select=stripe_customer_id',
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    const rows = r.ok ? await r.json() : [];
    customer = rows[0] && rows[0].stripe_customer_id;
  } catch (_) {}
  if (!customer) return json({ error: 'no_customer' }, 404);

  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const p = new URLSearchParams();
  p.set('customer', customer);
  p.set('return_url', site + '/account.html');

  const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: p.toString(),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: 'stripe_error', detail: data && data.error && data.error.message }, 502);
  return json({ url: data.url }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
