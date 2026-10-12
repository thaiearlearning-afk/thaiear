/* ============================================================
   functions/api/google-play.js — Premium bought in the Android app (Google Play, via RevenueCat)
   ------------------------------------------------------------
   The THIRD writer of public.subscriptions. Stripe's webhook and the comp grants are the other
   two, and every gate (audio.js, auth.js, the account page) reads only that one row, so a Google
   member is Premium on the website too, and a website member in the app. GOOGLE_PAYMENTS_PLAN.md
   (tooling repo) §3c–§3e is the plan; billing.js is the app half.

     GET  /api/google-play                  signed in   → { apiKey, serverReady }
          apiKey = RevenueCat's PUBLIC SDK key for the Play app. Public by design: it ships
          inside every app that uses RevenueCat. Kept here so changing it needs no deploy.
          ?check=1 adds `revenuecat`: ok | bad_key | missing_permission | project_not_found | …
          (the server's own secret key and project id, tested; the owner panel's billing check).
     POST /api/google-play                  signed in   → sync the CALLER (after buy / restore)
     POST /api/google-play?from=revenuecat  RevenueCat  → the webhook: sync each user it names

   ⭐ BOTH POSTS DO ONE THING: ask RevenueCat what this user's Google subscription is NOW, map it
   onto the row's columns (deriveGoogleState, §3c), and write it under the precedence rules
   (planGoogleWrite). A webhook body is trusted for WHO, never for WHAT — so a duplicated,
   retried, late or forged notification can only cause a re-read of the truth. That is
   RevenueCat's own advice ("call GET /subscribers after any webhook"), done with API v2.

   Env (Cloudflare Pages → Settings → Variables and Secrets, Production):
     REVENUECAT_PUBLIC_KEY      goog_…  the Play Store app's public SDK key (served to billing.js)
     REVENUECAT_SECRET_KEY      a V2 secret key with customer_information:subscriptions:read
                                (delete-account.js also needs customer_information:customers:read_write)
     REVENUECAT_PROJECT_ID      the RevenueCat project id (proj…)
     REVENUECAT_WEBHOOK_AUTH    the exact Authorization value set on the RevenueCat webhook
     REVENUECAT_WEBHOOK_SECRET  optional: the webhook's HMAC signing secret (checked when set)
     SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
   ⚠ Needs the `source` column (supabase_subscriptions_source.sql) before the first Google write.
   ============================================================ */

const RC_API = 'https://api.revenuecat.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function onRequestGet({ request, env }) {
  const v = await verifyUser(request, env);
  if (v.error) return v.error;
  const out = { apiKey: env.REVENUECAT_PUBLIC_KEY || null, serverReady: serverReady(env) };
  // ?check=1, from the owner panel's billing check: do the server's OWN RevenueCat credentials work?
  if (new URL(request.url).searchParams.get('check') === '1') out.revenuecat = await rcCheck(env);
  return json(out, 200);
}

/* ⚠ A WRONG PROJECT ID IS SILENT EVERYWHERE ELSE. RevenueCat answers 404 for an unknown project as it
   does for a customer who never bought, and a sync reads 404 as "no Google subscription", so every
   buyer would quietly stay Free. Listing ONE customer of the project tells them apart: 200 = the key
   and the project are both right. Nothing from the answer leaves this function. */
async function rcCheck(env) {
  if (!env.REVENUECAT_SECRET_KEY || !env.REVENUECAT_PROJECT_ID) return 'not_set';
  try {
    const r = await fetch(RC_API + '/v2/projects/' + encodeURIComponent(env.REVENUECAT_PROJECT_ID) + '/customers?limit=1', {
      headers: { Authorization: 'Bearer ' + env.REVENUECAT_SECRET_KEY, Accept: 'application/json' },
    });
    if (r.ok) return 'ok';
    if (r.status === 401) return 'bad_key';
    if (r.status === 403) return 'missing_permission';
    if (r.status === 404) return 'project_not_found';
    return 'error_' + r.status;
  } catch (_) { return 'unreachable'; }
}

export async function onRequestPost(ctx) {
  const from = new URL(ctx.request.url).searchParams.get('from');
  if (from === 'revenuecat') {
    try { return await webhook(ctx); }
    // Anything but a 200 makes RevenueCat retry (5, 10, 20, 40, 80 min); every retry re-reads.
    catch (e) { return text('sync failed: ' + errMsg(e), 500); }
  }
  return userSync(ctx.request, ctx.env);
}

function serverReady(env) {
  return !!(env.REVENUECAT_SECRET_KEY && env.REVENUECAT_PROJECT_ID &&
            env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/* ── the signed-in route: billing.js after a purchase or restore ───────────────────────────── */
async function userSync(request, env) {
  const v = await verifyUser(request, env);
  if (v.error) return v.error;
  if (!serverReady(env)) return json({ error: 'not_configured' }, 503);
  let out;
  try { out = await syncUser(env, v.user.id); }
  catch (e) {
    return json({ error: e && e.revenuecat ? 'revenuecat_unavailable' : 'sync_failed', detail: errMsg(e) }, 502);
  }
  return json({
    ok: true,
    premium: grants(out.row),                       // the row AFTER the write: what every gate sees
    source: (out.row && out.row.source) || null,
    action: out.plan.action, reason: out.plan.reason,
  }, 200);
}

/* ── the webhook ───────────────────────────────────────────────────────────────────────────── */
async function webhook(ctx) {
  const { request, env } = ctx;
  const raw = await request.text();
  const a = await webhookAuth(request, raw, env);
  if (!a.configured) return text('webhook not configured', 503);   // fail CLOSED
  if (!a.ok) return text('unauthorized', 401);
  let body;
  try { body = JSON.parse(raw); } catch (_) { return text('bad json', 400); }
  const ev = body && body.event;
  if (!ev || typeof ev !== 'object') return text('no event', 400);
  if (ev.type === 'TEST') return text('ok: test event', 200);      // the dashboard's "Send test"
  if (!serverReady(env)) return text('sync not configured', 503);
  const ids = eventUserIds(ev);
  for (const uid of ids) await syncUser(env, uid);                 // a throw → 500 → a retry
  /* Piggyback repair: a Google row still "active" a day after its period ended has probably
     lost its EXPIRATION delivery (all six attempts failed). The gate reads only `status`, so
     without this such a row would unlock audio until the user's next event, which for an
     expired subscription never comes. Never allowed to fail the event it rides on. */
  const heal = reconcile(env).catch(function () { return 0; });
  if (typeof ctx.waitUntil === 'function') ctx.waitUntil(heal); else await heal;
  return text('ok: ' + ids.length + ' synced', 200);
}

/* WHO an event is about: every ThaiEar user id in it (a TRANSFER names both sides). RevenueCat's
   anonymous ids ($RCAnonymousID:…) are never ours — billing.js never configures anonymously. */
function eventUserIds(ev) {
  const list = [ev.app_user_id, ev.original_app_user_id]
    .concat(arr(ev.aliases), arr(ev.transferred_from), arr(ev.transferred_to));
  const out = [];
  for (const x of list) {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    if (UUID.test(s) && out.indexOf(s) < 0) out.push(s);
  }
  return out.slice(0, 10);
}
function arr(x) { return Array.isArray(x) ? x : []; }

/* RevenueCat sends the Authorization value set on the webhook, and (when HMAC signing is on)
   X-RevenueCat-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. Every check
   that is configured must pass; with neither configured nothing is accepted. */
async function webhookAuth(request, raw, env) {
  const want = String(env.REVENUECAT_WEBHOOK_AUTH || '').trim();
  const secret = String(env.REVENUECAT_WEBHOOK_SECRET || '').trim();
  if (!want && !secret) return { configured: false, ok: false };
  if (want && !safeEqual(String(request.headers.get('Authorization') || '').trim(), want)) {
    return { configured: true, ok: false };
  }
  if (secret && !(await verifySig(raw, request.headers.get('X-RevenueCat-Webhook-Signature'), secret))) {
    return { configured: true, ok: false };
  }
  return { configured: true, ok: true };
}

/* ── one user: RevenueCat → the mapping → the row ─────────────────────────────────────────── */
async function syncUser(env, uid, opts) {
  const subs = await rcSubscriptions(env, uid);
  const derived = deriveGoogleState(subs);
  const res = await writeGoogleState(env, uid, derived, opts || {});
  return { derived, plan: res.plan, row: res.row };
}

/* Every subscription RevenueCat holds for this customer, sandbox included: licence testers buy in
   the sandbox, and only accounts the owner adds as testers can. A customer RevenueCat has never
   seen is a 404 = no Google subscription. The secret key only ever goes to api.revenuecat.com. */
async function rcSubscriptions(env, uid) {
  let url = RC_API + '/v2/projects/' + encodeURIComponent(env.REVENUECAT_PROJECT_ID) +
    '/customers/' + encodeURIComponent(uid) + '/subscriptions?limit=100';
  const items = [];
  for (let page = 0; url && page < 5; page++) {
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: 'Bearer ' + env.REVENUECAT_SECRET_KEY, Accept: 'application/json' } });
    } catch (e) { throw rcErr('revenuecat unreachable'); }
    if (r.status === 404) return items;
    if (!r.ok) throw rcErr('revenuecat ' + r.status);
    const j = await r.json();
    for (const s of arr(j && j.items)) items.push(s);
    url = nextPage(j && j.next_page);
  }
  return items;
}
function nextPage(p) {
  if (!p || typeof p !== 'string') return null;
  if (p.indexOf(RC_API + '/') === 0) return p;
  if (p.indexOf('/v2/') === 0) return RC_API + p;
  return null;                       // anywhere else: never send the secret there
}
function rcErr(m) { const e = new Error(m); e.revenuecat = true; return e; }

/* ══ §3c THE MAPPING — Google's states onto the columns Stripe already fills ══════════════════
   The one place this can go wrong: wrong one way and a payer loses audio, wrong the other and a
   lapsed user keeps it. RevenueCat v2's Subscription carries `gives_access` ("the source of
   truth for access") and a `status`:
     gives_access, status trialing           → trialing, renews unless auto-renew is off
     gives_access, active / in_grace_period  → active. Grace = the card failed and Google is
                                               retrying; Google REQUIRES access to continue
     not, in_billing_retry (account hold)    → past_due: no access, recoverable (Stripe's word)
     not, paused                             → past_due: no access until it resumes
     not, expired (incl. refunded + revoked) → canceled
   cancel_at_period_end = auto-renew is off (will_not_renew / will_pause) and access continues;
   never during grace, which is a renewal still being attempted.
   current_period_end = the later of current_period_ends_at and ends_at (they differ only when
   Google has already renewed, and then ends_at is the end of the period already paid for).
   ⚠ Only `play_store` subscriptions count. Several (a lapse, then a new purchase) → the one
   giving access, then the one renewing, then the latest. */
function deriveGoogleState(items) {
  const play = arr(items).filter(function (s) { return s && s.store === 'play_store'; });
  if (!play.length) return { kind: 'none' };
  const best = play.slice().sort(function (a, b) {
    return (access(b) - access(a)) ||
           ((b.auto_renewal_status === 'will_renew') - (a.auto_renewal_status === 'will_renew')) ||
           (endMs(b) - endMs(a));
  })[0];
  let status, cap = false;
  if (access(best)) {
    status = best.status === 'trialing' ? 'trialing' : 'active';
    cap = best.status !== 'in_grace_period' &&
          (best.auto_renewal_status === 'will_not_renew' || best.auto_renewal_status === 'will_pause');
  } else {
    status = (best.status === 'in_billing_retry' || best.status === 'paused') ? 'past_due' : 'canceled';
  }
  const end = endMs(best);
  return {
    kind: 'state', status: status, cancel_at_period_end: cap,
    current_period_end: end ? new Date(end).toISOString() : null,
    grants: status === 'active' || status === 'trialing',
  };
}
// `gives_access` is the field to trust; the status list is only a fallback should it ever vanish.
function access(s) {
  if (typeof s.gives_access === 'boolean') return s.gives_access ? 1 : 0;
  return (s.status === 'active' || s.status === 'trialing' || s.status === 'in_grace_period') ? 1 : 0;
}
function endMs(s) {
  const a = Number(s.current_period_ends_at), b = Number(s.ends_at);
  const m = Math.max(isFinite(a) ? a : 0, isFinite(b) ? b : 0);
  return m > 0 ? m : 0;
}

/* ══ PRECEDENCE — when may the Google writer touch the row? ═══════════════════════════════════
   One row, several writers. The rules, each the floor under a real failure:
   · A Google state that GRANTS access creates the row, or takes over one that grants nothing
     (a lapsed website member who now buys in the app).
   · A row that grants access through ANOTHER source (Stripe, a comp, a legacy row with no
     source) is never touched: whoever is paying elsewhere stays Premium, and a double purchase
     is a refund by hand (§4), not a row fight.
   · An active lifetime row is never touched, whatever its source: a comp outranks a store.
   · A Google row follows Google, all the way down to canceled.
   · A lapsed Google state never relabels another source's lapsed row; and with no Google
     subscription at all, only a Google row changes (it is canceled: e.g. transferred away).
   Taking a row over clears stripe_subscription_id and lifetime: that row is no longer about
   that subscription. stripe_customer_id stays (the durable customer also lives in profiles). */
function grants(row) { return !!row && (row.status === 'active' || row.status === 'trialing'); }
function planGoogleWrite(row, d, nowIso) {
  if (d.kind === 'none') {
    if (row && row.source === 'google' && !(row.lifetime === true && grants(row)) && row.status !== 'canceled') {
      return { action: 'update', reason: 'google_gone',
               patch: { status: 'canceled', cancel_at_period_end: false, updated_at: nowIso } };
    }
    return { action: 'none', reason: row ? 'no_google_subscription' : 'no_google_subscription_no_row' };
  }
  const want = { source: 'google', status: d.status, cancel_at_period_end: d.cancel_at_period_end,
                 current_period_end: d.current_period_end, updated_at: nowIso };
  if (!row) {
    if (!d.grants) return { action: 'none', reason: 'lapsed_no_row' };
    return { action: 'insert', reason: 'new_google_member', patch: want };
  }
  if (row.lifetime === true && grants(row)) return { action: 'none', reason: 'lifetime_row_wins' };
  if (row.source === 'google') {
    if (sameState(row, want)) return { action: 'none', reason: 'unchanged' };
    return { action: 'update', reason: 'google_update', patch: want };
  }
  if (grants(row)) return { action: 'none', reason: 'other_source_active' };
  if (!d.grants) return { action: 'none', reason: 'both_lapsed' };
  return { action: 'update', reason: 'google_takeover',
           patch: Object.assign({}, want, { stripe_subscription_id: null, lifetime: false }) };
}
function sameState(row, want) {
  return row.status === want.status &&
         !!row.cancel_at_period_end === !!want.cancel_at_period_end &&
         sameTime(row.current_period_end, want.current_period_end);
}
function sameTime(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Date.parse(a) === Date.parse(b);
}

/* ── the write: read, decide, write ONLY IF NOTHING CHANGED UNDER US ──────────────────────────
   A purchase lands as two near-simultaneous syncs (billing.js and the webhook), and Stripe's
   webhook writes the same row. So an update is conditional on the updated_at it was decided
   from; zero rows back = someone wrote in between = read again and decide again. An insert
   that collides with another insert is the same case. */
async function writeGoogleState(env, uid, d, opts) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await readRow(env, uid);
    const now = new Date().toISOString();
    const plan = planGoogleWrite(row, d, now);
    if (plan.action === 'none') {
      // reconcile(): an unchanged row is stamped as checked, or it would be re-checked every event.
      if (opts.touch && plan.reason === 'unchanged') {
        const t = await sb(env, 'PATCH', rowFilter(uid, row), { updated_at: now }, 'return=minimal');
        if (!t.ok) throw new Error('supabase touch ' + t.status);
      }
      return { plan: plan, row: row };
    }
    if (plan.action === 'insert') {
      const r = await sb(env, 'POST', '/rest/v1/subscriptions',
        [Object.assign({ user_id: uid }, plan.patch)], 'return=representation');
      if (r.ok) return { plan: plan, row: first(await r.json()) };
      const t = await r.text();
      if (r.status === 409 && /23505|duplicate/i.test(t)) continue;             // inserted under us
      if (r.status === 409 && /23503|foreign key/i.test(t)) {                    // account deleted
        return { plan: { action: 'none', reason: 'no_such_user' }, row: null };
      }
      throw new Error('supabase insert ' + r.status + ': ' + t.slice(0, 200));
    }
    const r = await sb(env, 'PATCH', rowFilter(uid, row), plan.patch, 'return=representation');
    if (!r.ok) throw new Error('supabase update ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const rows = await r.json();
    if (rows && rows.length) return { plan: plan, row: rows[0] };
  }
  throw new Error('the row kept changing during the write');
}
function rowFilter(uid, row) {
  return '/rest/v1/subscriptions?user_id=eq.' + encodeURIComponent(uid) + '&' +
    (row.updated_at == null ? 'updated_at=is.null' : 'updated_at=eq.' + encodeURIComponent(row.updated_at));
}
async function readRow(env, uid) {
  // select=* on purpose: it reads correctly whether or not a column has been added yet.
  const r = await sb(env, 'GET', '/rest/v1/subscriptions?user_id=eq.' + encodeURIComponent(uid) + '&select=*');
  if (!r.ok) throw new Error('supabase read ' + r.status);
  return first(await r.json());
}
function first(rows) { return (Array.isArray(rows) && rows[0]) || null; }

/* At most five rows per event, and each at most once every six hours. */
async function reconcile(env) {
  const now = Date.now();
  const ended = new Date(now - 24 * 3600e3).toISOString();
  const checked = new Date(now - 6 * 3600e3).toISOString();
  const r = await sb(env, 'GET', '/rest/v1/subscriptions?source=eq.google&status=in.(active,trialing)' +
    '&current_period_end=lt.' + encodeURIComponent(ended) + '&updated_at=lt.' + encodeURIComponent(checked) +
    '&select=user_id&limit=5');
  if (!r.ok) return 0;
  let n = 0;
  for (const row of arr(await r.json())) {
    try { await syncUser(env, String(row.user_id), { touch: true }); n++; } catch (_) {}
  }
  return n;
}

/* ── helpers ──────────────────────────────────────────────────────────────────────────────── */
function sb(env, method, path, body, prefer) {
  const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (prefer) h.Prefer = prefer;
  return fetch(env.SUPABASE_URL + path, { method: method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body) });
}

async function verifyUser(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: json({ error: 'unauthorized' }, 401) };
  try {
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!r.ok) return { error: json({ error: 'forbidden' }, 403) };
    const u = await r.json();
    if (!u || !u.id) return { error: json({ error: 'forbidden' }, 403) };
    return { user: u };
  } catch (_) { return { error: json({ error: 'auth_unavailable' }, 503) }; }
}

async function verifySig(body, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const items = String(header).split(',').map(function (s) { return s.trim().split('='); });
  const t = (items.find(function (i) { return i[0] === 't'; }) || [])[1];
  const sigs = items.filter(function (i) { return i[0] === 'v1'; }).map(function (i) { return i[1]; });
  if (!t || !sigs.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;
  const expected = await hmacHex(secret, t + '.' + body);
  return sigs.some(function (s) { return safeEqual(String(s), expected); });
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function errMsg(e) { return String((e && e.message) || e).slice(0, 300); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function text(s, status) {
  return new Response(s, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
}
