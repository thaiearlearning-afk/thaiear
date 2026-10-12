/* ============================================================
   functions/api/delete-account.js — GDPR erasure (delete my account)
   ------------------------------------------------------------
   POST /api/delete-account (authenticated). For the signed-in user:
     1. cancel every Stripe subscription across all their customers (immediately),
     2. remove them from MailerLite (best-effort),
     3. delete the Supabase auth user — which cascades their profiles/subscriptions rows,
     4. erase their RevenueCat customer (best-effort, when RevenueCat is configured).
   The client then signs out. ⚠ Refused with 409 google_subscription_active while a Google Play
   subscription would still charge them (step 0), unless the body says { google_ack: true }.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (secret),
        STRIPE_SECRET_KEY (secret), MAILERLITE_API_KEY (optional)
   ============================================================ */

export async function onRequestPost({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  let user;
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return json({ error: 'forbidden', detail: 'auth ' + who.status + ' (session likely expired — sign in again)' }, 403);
    user = await who.json();
  } catch (_) { return json({ error: 'auth_unavailable' }, 503); }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'config', detail: 'SUPABASE_SERVICE_ROLE_KEY missing' }, 500);
  let body = {};
  try { body = (await request.json()) || {}; } catch (_) {}

  try {
    /* 0. ⚠ A GOOGLE PLAY SUBSCRIPTION SURVIVES THE ACCOUNT (GOOGLE_PAYMENTS_PLAN.md §4). Stripe
       is cancelled below; Google cannot be from here, and deleting the account does not stop
       Google charging. So while one would still renew (or is on hold and may yet charge), the
       delete is refused with a code the page can explain, unless the request says it has
       been told: { google_ack: true }. A Google subscription already set to end goes ahead. */
    const own = await svcRow(env, user.id);
    if (own && own.source === 'google' && !own.cancel_at_period_end && body.google_ack !== true &&
        (own.status === 'active' || own.status === 'trialing' || own.status === 'past_due')) {
      // ⚠ DRAFT wording, not yet approved (GOOGLE_PAYMENTS_PLAN.md §7). Nobody can reach this
      // before the in-app purchase ships, and the page will word it from the code.
      return json({ error: 'google_subscription_active',
                    detail: 'Your Premium is billed by Google Play. Cancel it in the Play Store first, then delete your account.' }, 409);
    }

    // 1. Cancel all Stripe subscriptions across every customer for this user.
    if (env.STRIPE_SECRET_KEY) {
      const ids = new Set();
      if (user.email) {
        const l = await stripeGet(env, 'customers?limit=100&email=' + encodeURIComponent(user.email));
        (l && l.data || []).forEach(function (c) { ids.add(c.id); });
      }
      const stored = await storedCustomerId(env, token, user.id);
      if (stored) ids.add(stored);
      for (const id of ids) {
        const subs = await stripeGet(env, 'subscriptions?status=all&limit=100&customer=' + id);
        for (const s of (subs && subs.data || [])) {
          if (s.status === 'canceled' || s.status === 'incomplete_expired') continue;
          await stripeDelete(env, 'subscriptions/' + s.id);
        }
      }
    }

    // 2. Remove from MailerLite (best-effort — don't block deletion on it).
    if (env.MAILERLITE_API_KEY && user.email) {
      try {
        const g = await fetch('https://connect.mailerlite.com/api/subscribers/' + encodeURIComponent(user.email),
          { headers: { Authorization: 'Bearer ' + env.MAILERLITE_API_KEY, Accept: 'application/json' } });
        if (g.ok) {
          const d = await g.json();
          const sid = d && d.data && d.data.id;
          if (sid) await fetch('https://connect.mailerlite.com/api/subscribers/' + sid,
            { method: 'DELETE', headers: { Authorization: 'Bearer ' + env.MAILERLITE_API_KEY } });
        }
      } catch (_) {}
    }

    // 3. Delete the Supabase auth user (cascades profiles + subscriptions via FK).
    const del = await fetch(env.SUPABASE_URL + '/auth/v1/admin/users/' + user.id, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
    });
    if (!del.ok) return json({ error: 'delete_failed', detail: (await del.text()).slice(0, 200) }, 500);

    // 4. Erase the RevenueCat customer too (purchase history keyed by this user id). Best-effort,
    //    after the account is gone, and never the reason a deletion reports failure.
    await rcDeleteCustomer(env, user.id);

    return json({ ok: true }, 200);
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
// The whole row (select=*, so it reads whether or not `source` exists yet), service role.
async function svcRow(env, uid) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + encodeURIComponent(uid) + '&select=*', {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!r.ok) throw new Error('supabase read ' + r.status);
  const rows = await r.json();
  return (rows && rows[0]) || null;
}
// RevenueCat API v2: DELETE a customer (needs customer_information:customers:read_write). Its 404
// = never a RevenueCat customer. Capped at 5 s so a slow RevenueCat never holds the reply.
async function rcDeleteCustomer(env, uid) {
  if (!env.REVENUECAT_SECRET_KEY || !env.REVENUECAT_PROJECT_ID) return 'skipped';
  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  const t = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
  try {
    const r = await fetch('https://api.revenuecat.com/v2/projects/' + encodeURIComponent(env.REVENUECAT_PROJECT_ID) +
      '/customers/' + encodeURIComponent(uid), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + env.REVENUECAT_SECRET_KEY },
      signal: ctrl ? ctrl.signal : undefined,
    });
    return r.status;
  } catch (_) { return 'failed'; }
  finally { if (t) clearTimeout(t); }
}
async function stripeGet(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
  return r.json();
}
async function stripeDelete(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
  return r.json();
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
