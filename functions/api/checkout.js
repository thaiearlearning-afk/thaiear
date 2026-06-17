/* ============================================================
   functions/api/checkout.js — start a Stripe subscription (Phase 4)
   ------------------------------------------------------------
   POST /api/checkout  (subscribe.html "Subscribe" button calls it with the
   Supabase session token in an Authorization header). Verifies the user, then
   creates a Stripe Checkout Session in subscription mode and returns its URL.

   Env (Cloudflare Pages → Variables & Secrets):
     SUPABASE_URL, SUPABASE_ANON_KEY      verify the caller + read their own row
     STRIPE_SECRET_KEY  (secret)          create the checkout session
     STRIPE_PRICE_ID                      the monthly price (price_...)
     SITE_URL            (optional)        e.g. https://thaiear.com (else request origin)
   ============================================================ */

export async function onRequestPost(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    return json({ error: 'exception', detail: String(e && e.message || e) }, 500);
  }
}

async function handle({ request, env }) {
  const token = bearer(request);
  const user = await verifyUser(token, env);
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'config', detail: 'STRIPE_SECRET_KEY missing (set it in Pages → Production, then redeploy)' }, 500);
  if (!env.STRIPE_PRICE_ID) return json({ error: 'config', detail: 'STRIPE_PRICE_ID missing (set it in Pages → Production, then redeploy)' }, 500);

  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');

  const p = new URLSearchParams();
  p.set('mode', 'subscription');
  p.set('line_items[0][price]', env.STRIPE_PRICE_ID);
  p.set('line_items[0][quantity]', '1');
  p.set('success_url', site + '/account.html?sub=success');
  p.set('cancel_url', site + '/subscribe.html');
  p.set('client_reference_id', user.id);
  p.set('subscription_data[metadata][user_id]', user.id);
  p.set('allow_promotion_codes', 'true');

  // Reuse the existing Stripe customer if this user subscribed before (avoids dupes);
  // otherwise let Checkout create one from their email.
  const existing = await ownCustomerId(token, user.id, env);
  if (existing) {
    p.set('customer', existing);
    p.set('customer_update[address]', 'auto'); // needed so Stripe Tax can save the collected address
  } else if (user.email) {
    p.set('customer_email', user.email);
  }

  // Stripe Tax: calculate VAT/sales tax by the buyer's location (Checkout collects the address).
  p.set('automatic_tax[enabled]', 'true');

  let res = await createSession(env, p);
  // The stored customer can be stale (e.g. deleted in Stripe). If reusing it failed,
  // retry once letting Checkout create/find a customer from the email — the webhook
  // then heals the stored id on the next subscribe.
  if (!res.ok && p.has('customer')) {
    p.delete('customer');
    p.delete('customer_update[address]');
    if (user.email) p.set('customer_email', user.email);
    res = await createSession(env, p);
  }
  if (!res.ok) return json({ error: 'stripe_error', detail: res.data && res.data.error && res.data.error.message }, 502);
  return json({ url: res.data.url }, 200);
}

async function createSession(env, p) {
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: p.toString(),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  return { ok: r.ok, data };
}

function bearer(request) {
  return (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
}

async function verifyUser(token, env) {
  if (!token) return null;
  try {
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

// Read the user's own subscription row via RLS (their token) to find a stored customer id.
async function ownCustomerId(token, uid, env) {
  try {
    const r = await fetch(
      env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + uid + '&select=stripe_customer_id',
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] && rows[0].stripe_customer_id || null;
  } catch (_) { return null; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
