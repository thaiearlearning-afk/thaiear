/* ============================================================
   functions/api/stripe-webhook.js — Stripe → Supabase sync (Phase 4)
   ------------------------------------------------------------
   POST /api/stripe-webhook  (registered in the Stripe dashboard). Verifies the
   Stripe signature, then writes the subscriber's status into the Supabase
   `subscriptions` table using the SERVICE-ROLE key (bypasses RLS).

   Events handled:
     checkout.session.completed         → activate (first subscribe)
     customer.subscription.updated      → renew / past_due / cancel-at-period-end
     customer.subscription.deleted      → ended → status canceled

   Env: STRIPE_WEBHOOK_SECRET (secret), STRIPE_SECRET_KEY (secret),
        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (secret)
   ============================================================ */

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  const ok = await verifySig(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response('bad signature', { status: 400 });

  let event;
  try { event = JSON.parse(raw); } catch (_) { return new Response('bad json', { status: 400 }); }
  const obj = event.data && event.data.object;

  try {
    if (event.type === 'checkout.session.completed') {
      const uid = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      if (uid && obj.subscription) {
        const sub = await stripeGet(env, 'subscriptions/' + obj.subscription);
        await upsert(env, rowFromSub(uid, sub, obj.customer));
      }
    } else if (event.type === 'customer.subscription.updated' ||
               event.type === 'customer.subscription.created' ||
               event.type === 'customer.subscription.deleted') {
      const uid = (obj.metadata && obj.metadata.user_id) || await uidByCustomer(env, obj.customer);
      if (uid) await upsert(env, rowFromSub(uid, obj, obj.customer));
    }
  } catch (e) {
    // 500 → Stripe retries later; the message shows in Stripe's delivery log.
    return new Response('handler error: ' + (e && e.message || e), { status: 500 });
  }
  return new Response('ok', { status: 200 });
}

function rowFromSub(uid, sub, customer) {
  return {
    user_id: uid,
    stripe_customer_id: customer || sub.customer || null,
    stripe_subscription_id: sub.id || null,
    status: sub.status || null,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

async function upsert(env, row) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/subscriptions', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error('supabase upsert ' + r.status + ': ' + (await r.text()).slice(0, 300));
}

async function uidByCustomer(env, customer) {
  if (!customer) return null;
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/subscriptions?stripe_customer_id=eq.' + customer + '&select=user_id',
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] && rows[0].user_id || null;
}

async function stripeGet(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  return r.json();
}

// ---- Stripe webhook signature: HMAC-SHA256 over `${t}.${body}`, ≤5 min old ----
async function verifySig(body, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const items = header.split(',').map(s => s.split('='));
  const t = (items.find(i => i[0] === 't') || [])[1];
  const sigs = items.filter(i => i[0] === 'v1').map(i => i[1]);
  if (!t || !sigs.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;
  const expected = await hmacHex(secret, t + '.' + body);
  return sigs.some(s => timingSafeEqual(s, expected));
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
