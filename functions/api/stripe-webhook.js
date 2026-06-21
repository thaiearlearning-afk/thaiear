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
        // Expand the coupon so we can detect a "lifetime" (forever-free) grant.
        const sub = await stripeGet(env, 'subscriptions/' + obj.subscription + '?expand[]=discounts.coupon');
        const row = rowFromSub(uid, sub, obj.customer);
        if (sub && !sub.error && isLifetimeFromSub(sub)) row.lifetime = true; // STICKY: only ever auto-set true
        await upsert(env, row);
      }
    } else if (event.type === 'customer.subscription.updated' ||
               event.type === 'customer.subscription.created' ||
               event.type === 'customer.subscription.deleted') {
      const uid = (obj.metadata && obj.metadata.user_id) || await uidByCustomer(env, obj.customer);
      if (uid) {
        // Re-fetch with the coupon expanded — the event payload may carry only discount IDs.
        let full = obj, expanded = false;
        try {
          const f = await stripeGet(env, 'subscriptions/' + obj.id + '?expand[]=discounts.coupon');
          if (f && !f.error) { full = f; expanded = true; }
        } catch (_) {}
        const row = rowFromSub(uid, full, obj.customer);
        if (expanded && isLifetimeFromSub(full)) row.lifetime = true; // STICKY: only ever auto-set true
        await upsert(env, row);
      }
    }
  } catch (e) {
    // 500 → Stripe retries later; the message shows in Stripe's delivery log.
    return new Response('handler error: ' + (e && e.message || e), { status: 500 });
  }
  return new Response('ok', { status: 200 });
}

// A "lifetime" member = effectively free FOREVER: a forever coupon that zeroes the price, or a £0
// recurring price. Detected server-side from Stripe (can't be spoofed, needs no manual step) so a
// trusted monk can pass the forever-comp coupon to another monk and lifetime offline access just works.
// We only ever auto-SET lifetime=true (sticky) — never write false — so a transient/odd event can't
// strip a genuine lifetime member; ordinary revocation still works via subscription status (canceled →
// the app denies access regardless of this flag). A normal paying user never matches → never flagged.
function isLifetimeFromSub(sub) {
  if (!sub || sub.error) return false;
  const item = sub.items && sub.items.data && sub.items.data[0];
  const planAmount = item && item.price && typeof item.price.unit_amount === 'number'
    ? item.price.unit_amount : null;
  if (planAmount === 0) return true;                       // genuinely £0 recurring price
  const discs = [];
  if (Array.isArray(sub.discounts)) for (const d of sub.discounts) discs.push(d);
  if (sub.discount) discs.push(sub.discount);              // legacy single-discount field
  for (const d of discs) {
    const c = (d && typeof d === 'object') ? (d.coupon || d) : null;
    if (!c || c.valid === false || c.duration !== 'forever') continue;
    if (c.percent_off === 100) return true;                // 100%-off forever
    if (c.amount_off && planAmount != null && c.amount_off >= planAmount) return true; // amount covers the price, forever
  }
  return false;
}

function rowFromSub(uid, sub, customer) {
  return {
    user_id: uid,
    stripe_customer_id: customer || sub.customer || null,
    stripe_subscription_id: sub.id || null,
    status: sub.status || null,
    // Portal cancels record a scheduled `cancel_at` rather than the boolean — treat either as cancelling.
    cancel_at_period_end: !!(sub.cancel_at_period_end || sub.cancel_at),
    current_period_end: (sub.cancel_at || subPeriodEnd(sub)) ? new Date((sub.cancel_at || subPeriodEnd(sub)) * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

// current_period_end moved onto the item in recent Stripe API versions.
function subPeriodEnd(sub) {
  if (sub && sub.current_period_end) return sub.current_period_end;
  const it = sub && sub.items && sub.items.data && sub.items.data[0];
  return (it && it.current_period_end) || null;
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
