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

  // Don't let an already-subscribed user start a second subscription (avoids double billing).
  if (await hasActiveSub(token, user.id, env)) return json({ error: 'already_subscribed' }, 409);

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
  // Don't demand a card when nothing is due now — lets a 100%-off-forever comp code
  // (see the VIP coupon in Stripe) check out with no payment method. Paying users are
  // unaffected: their amount is > 0, so Stripe still collects a card.
  p.set('payment_method_collection', 'if_required');

  // ONE Stripe customer per user, stored durably in profiles (survives subscription
  // row resets). This prevents the duplicate-customer mess that made cancellations
  // look stuck. We always pass a real customer id (never customer_email, which would
  // make Stripe spin up a fresh customer each time).
  let customer;
  try {
    customer = await ensureCustomer(env, token, user);
  } catch (e) {
    return json({ error: 'customer_failed', detail: String(e && e.message || e) }, 502);
  }
  p.set('customer', customer);
  p.set('customer_update[address]', 'auto'); // let Stripe Tax save the collected address
  p.set('automatic_tax[enabled]', 'true');   // VAT/sales tax by buyer location

  const res = await createSession(env, p);
  if (!res.ok) return json({ error: 'stripe_error', detail: res.data && res.data.error && res.data.error.message }, 502);
  return json({ url: res.data.url }, 200);
}

// Durable customer: reuse profiles.stripe_customer_id if still valid, else create a
// fresh customer and store it. Guarantees exactly one customer per user.
async function ensureCustomer(env, token, user) {
  let cid = await profileCustomerId(token, user.id, env);
  if (cid) {
    const c = await stripeGet(env, 'customers/' + cid);
    if (c && !c.deleted && !c.error) return cid;
  }
  const params = new URLSearchParams();
  if (user.email) params.set('email', user.email);
  params.set('metadata[user_id]', user.id);
  const r = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const c = await r.json();
  if (!r.ok) throw new Error('create customer: ' + (c.error && c.error.message));
  // store durably (service role; profiles row may not exist yet → upsert)
  await fetch(env.SUPABASE_URL + '/rest/v1/profiles', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ user_id: user.id, email: user.email || null, stripe_customer_id: c.id, updated_at: new Date().toISOString() }]),
  });
  return c.id;
}

async function profileCustomerId(token, uid, env) {
  try {
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?user_id=eq.' + uid + '&select=stripe_customer_id',
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] && rows[0].stripe_customer_id || null;
  } catch (_) { return null; }
}

async function stripeGet(env, path) {
  try {
    const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
    return await r.json();
  } catch (_) { return null; }
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

// Already has a live subscription? (their own row, via RLS)
async function hasActiveSub(token, uid, env) {
  try {
    const r = await fetch(
      env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + uid + '&select=status',
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return false;
    const rows = await r.json();
    const s = rows[0] && rows[0].status;
    return s === 'active' || s === 'trialing';
  } catch (_) { return false; }
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
