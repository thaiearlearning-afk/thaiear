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

  const params = new URL(request.url).searchParams;

  // QA: ?simulate=active|canceling|past_due|free returns a synthetic state for the
  // caller's own view only (no real Stripe/Supabase change) so the UI can be eyeballed.
  const sim = params.get('simulate');
  if (sim) {
    const end = new Date(Date.now() + 30 * 864e5).toISOString();
    if (sim === 'active') return json({ subscribed: true, status: 'active', cancel_at_period_end: false, current_period_end: end }, 200);
    if (sim === 'canceling') return json({ subscribed: true, status: 'active', cancel_at_period_end: true, current_period_end: end }, 200);
    if (sim === 'past_due' || sim === 'pastdue') return json({ subscribed: false, needsPayment: true, status: 'past_due', current_period_end: end }, 200);
    return json({ subscribed: false }, 200); // simulate=free / anything else
  }

  const debug = params.get('debug');

  /* ⚠⚠ A COMPED MEMBERSHIP HAS NO STRIPE SUBSCRIPTION, AND THIS ENDPOINT USED TO BE
     STRIPE-ONLY. Testers, and anyone granted lifetime access, get a row in Supabase
     `subscriptions` with status='active' and lifetime=true and NOTHING in Stripe. auth.js
     reads that row, so the nav, subscribe.html and the audio gate all correctly said
     "member" — while this endpoint asked Stripe, got nothing, and answered
     {subscribed:false}. The account page renders instantly from cache and then refines from
     here, so the visible symptom was a granted account flashing "Premium" and settling on
     "Free", with subscribe.html insisting "You're a member" on the very next page. The grant
     was never broken; this was.

     ⚠ IT IS CHECKED FIRST, AND IT WINS. A comped row is a deliberate act by the owner; a
     missing Stripe subscription is the expected state for one, not evidence against it.
     ⚠ AND IT IS REPORTED AS `comped` SO THE UI KNOWS NOT TO OFFER STRIPE ACTIONS. There is
     no subscription to cancel and no card to update — showing those buttons would hand
     someone a control that can only fail. */
  const comped = await compedRow(env, token, user.id);
  if (comped) {
    return json({ subscribed: true, status: 'active', comped: true,
                  lifetime: !!comped.lifetime, cancel_at_period_end: false,
                  current_period_end: comped.current_period_end || null }, 200);
  }

  if (!env.STRIPE_SECRET_KEY) return json({ subscribed: false }, 200);

  try {
    // Gather EVERY customer for this user (stored + all email matches) — there may
    // be leftover duplicates, and we must consider all of them to be honest.
    const ids = new Set();
    const stored = await storedCustomerId(env, token, user.id);
    if (stored) ids.add(stored);
    if (user.email) {
      const list = await stripeGet(env, 'customers?limit=100&email=' + encodeURIComponent(user.email));
      (list && list.data || []).forEach(function (c) { ids.add(c.id); });
    }

    // All their subscriptions across all those customers.
    const all = [];
    for (const id of ids) {
      const subs = await stripeGet(env, 'subscriptions?status=all&limit=100&customer=' + id);
      (subs && subs.data || []).forEach(function (s) { all.push(s); });
    }

    if (debug) {
      return json({
        email: user.email,
        customers: Array.from(ids),
        subscriptions: all.map(function (s) {
          return { id: s.id, customer: s.customer, status: s.status,
            cancel_at_period_end: !!s.cancel_at_period_end, cancel_at: s.cancel_at || null,
            current_period_end: periodEnd(s) };
        }),
      }, 200);
    }

    // Honest state: a fully-active sub wins; else an active-but-cancelling one; else a
    // payment-failed (past_due/unpaid) one that can be recovered; else none.
    const liveSubs = all.filter(function (s) { return s.status === 'active' || s.status === 'trialing'; });
    let chosen = liveSubs.find(function (s) { return !isCanceling(s); }) ||
                 liveSubs.find(function (s) { return isCanceling(s); }) || null;
    let needsPayment = false;
    if (!chosen) {
      chosen = all.find(function (s) { return s.status === 'past_due' || s.status === 'unpaid'; }) || null;
      needsPayment = !!chosen;
    }
    if (!chosen) return json({ subscribed: false }, 200);

    // End date = the scheduled cancel_at (how the portal records it) if present, else period end.
    const endTs = chosen.cancel_at || periodEnd(chosen);
    return json({
      subscribed: !needsPayment,         // past_due → not entitled, but recoverable
      needsPayment: needsPayment,
      status: chosen.status,
      cancel_at_period_end: isCanceling(chosen),
      current_period_end: endTs ? new Date(endTs * 1000).toISOString() : null,
    }, 200);
  } catch (e) {
    return json({ error: 'lookup_failed', detail: String(e && e.message || e) }, 200);
  }
}

// A subscription is "cancelling" if it ends at period end (the boolean) OR has a scheduled
// cancel_at date — the Stripe Customer Portal records a period-end cancel via `cancel_at`,
// not `cancel_at_period_end`, so we must check both or portal cancellations look active.
function isCanceling(s) { return !!(s && (s.cancel_at_period_end || s.cancel_at)); }

// Stripe moved current_period_end onto the subscription item in recent API versions.
function periodEnd(s) {
  if (s && s.current_period_end) return s.current_period_end;
  const it = s && s.items && s.items.data && s.items.data[0];
  return (it && it.current_period_end) || null;
}

/* The user's own subscriptions row, read under THEIR token so RLS applies exactly as it does
   for auth.js — this endpoint must not be able to see more than the client already can.
   A row only counts as comped when it is active AND carries no Stripe subscription: a real
   paying member also has a row here, and for them Stripe stays the authority on dates,
   cancellation and card state. */
async function compedRow(env, token, uid) {
  try {
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + uid +
      '&select=status,lifetime,current_period_end,stripe_subscription_id',
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const rows = await r.json();
    const row = rows && rows[0];
    if (!row) return null;
    if (row.status !== 'active' && row.status !== 'trialing') return null;
    if (row.stripe_subscription_id) return null;      // a real Stripe sub — let Stripe answer
    return row;
  } catch (_) { return null; }
}

async function storedCustomerId(env, token, uid) {
  // Durable customer lives in profiles (written by checkout); fall back to the
  // subscriptions row for users who subscribed before that change.
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
