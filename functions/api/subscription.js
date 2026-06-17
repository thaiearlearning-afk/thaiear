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
  const debug = new URL(request.url).searchParams.get('debug');

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
          return { id: s.id, customer: s.customer, status: s.status, cancel_at_period_end: !!s.cancel_at_period_end };
        }),
      }, 200);
    }

    // Honest state: a fully-active sub wins; else an active-but-cancelling one; else none.
    const liveSubs = all.filter(function (s) { return s.status === 'active' || s.status === 'trialing'; });
    const chosen = liveSubs.find(function (s) { return !s.cancel_at_period_end; }) ||
                   liveSubs.find(function (s) { return s.cancel_at_period_end; }) || null;
    if (!chosen) return json({ subscribed: false }, 200);

    const pend = periodEnd(chosen);
    return json({
      subscribed: true,
      status: chosen.status,
      cancel_at_period_end: !!chosen.cancel_at_period_end,
      current_period_end: pend ? new Date(pend * 1000).toISOString() : null,
    }, 200);
  } catch (e) {
    return json({ error: 'lookup_failed', detail: String(e && e.message || e) }, 200);
  }
}

// Stripe moved current_period_end onto the subscription item in recent API versions.
function periodEnd(s) {
  if (s && s.current_period_end) return s.current_period_end;
  const it = s && s.items && s.items.data && s.items.data[0];
  return (it && it.current_period_end) || null;
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
