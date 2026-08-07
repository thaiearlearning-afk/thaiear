/* ============================================================================================
   functions/api/desktop-dl.js — the desktop MP3 download allow-list (2026-08-07)

   Two jobs, one endpoint:
     GET   → "what am I?"  { email, canDownload, isAdmin } — every signed-in visitor asks this,
             and auth.js caches the answer. Admins additionally get the list and the audit trail.
     POST  → grant / revoke / grant_lifetime. Admins only.

   ⚠ THE PERMISSION CHECK LIVES HERE, NOT IN THE UI. account.html renders the admin panel only
   for admins and player.js shows the button only to the allow-listed, but both of those are
   conveniences — a hidden control is not a permission. Every request re-derives the caller from
   their JWT and re-reads desktop_dl_admins. Never accept an email, a user id, or an "isAdmin"
   claim from the request body; the only identity that counts is the one the token proves.

   ⚠ WHY EMAIL AND NOT user_id: see the header of desktop_dl_schema.sql. An address may be granted
   before its owner has an account. That is the feature, and it is why `grant` reports a DIFFERENT
   result when no account exists yet rather than failing.

   ⚠ grant_lifetime IS NOT THE SAME SWITCH as grant. Download access is about a file leaving the
   browser; lifetime is about money. They are granted separately and revoked separately, and the
   UI says so, because conflating them is how someone ends up with free access nobody meant to
   give. Unlike `grant`, lifetime REQUIRES an existing account (it writes a subscriptions row
   keyed by user_id), so it can genuinely fail with "no account yet".

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (secret).
   ============================================================================================ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestGet({ request, env }) {
  const who = await caller(request, env);
  if (who.error) return who.error;
  const email = who.email;

  const [enabled, admin] = await Promise.all([isEnabled(env, email), isAdmin(env, email)]);
  const out = { email, canDownload: enabled, isAdmin: admin };
  if (!admin) return json(out);

  // Admin view: the whole list, newest grant first, plus the recent trail. Both are small by
  // construction (a handful of monks), so there is no pagination and none is wanted — a list you
  // have to page through is a list nobody checks.
  const [list, audit] = await Promise.all([
    sbGet(env, '/rest/v1/desktop_dl?select=email,enabled,note,added_by_email,added_at,updated_at&order=added_at.desc'),
    sbGet(env, '/rest/v1/desktop_dl_audit?select=at,actor_email,action,target_email,detail&order=at.desc&limit=50'),
  ]);
  out.list = list || [];
  out.audit = audit || [];
  return json(out);
}

export async function onRequestPost({ request, env }) {
  const who = await caller(request, env);
  if (who.error) return who.error;
  if (!(await isAdmin(env, who.email))) return json({ error: 'forbidden' }, 403);

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const action = String(body.action || '');
  const target = String(body.email || '').trim().toLowerCase();
  const note = body.note ? String(body.note).slice(0, 200) : null;

  if (!EMAIL_RE.test(target)) return json({ result: 'bad_email' });

  try {
    if (action === 'grant')          return json(await grant(env, who, target, note));
    if (action === 'revoke')         return json(await revoke(env, who, target));
    if (action === 'grant_lifetime') return json(await grantLifetime(env, who, target));
  } catch (e) {
    return json({ error: 'failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
  return json({ error: 'bad_action' }, 400);
}

/* ── actions ────────────────────────────────────────────────────────────────────────────── */

async function grant(env, actor, target, note) {
  const rows = await sbGet(env, '/rest/v1/desktop_dl?email=eq.' + enc(target) + '&select=email,enabled');
  const existing = rows && rows[0];
  if (existing && existing.enabled) {
    // Not an error and not a write: re-granting must not quietly rewrite who granted it and when.
    return { result: 'already', email: target };
  }

  const account = await accountFor(env, target);
  await sbUpsert(env, '/rest/v1/desktop_dl', {
    email: target,
    enabled: true,
    note,
    added_by: actor.id || null,
    added_by_email: actor.email,   // text too: the trail must survive the granting account's deletion
  });
  await log(env, actor.email, 'grant', target,
    account ? 'account exists' : 'no account yet — access begins at signup');
  return { result: account ? 'granted' : 'granted_no_account', email: target };
}

async function revoke(env, actor, target) {
  const rows = await sbGet(env, '/rest/v1/desktop_dl?email=eq.' + enc(target) + '&select=email,enabled');
  if (!rows || !rows.length) return { result: 'not_listed', email: target };
  // Disabled, never deleted: the row IS the record that this person once had access, and a
  // delete would take the grant date with it.
  await sbPatch(env, '/rest/v1/desktop_dl?email=eq.' + enc(target), { enabled: false });
  await log(env, actor.email, 'revoke', target, null);
  return { result: 'revoked', email: target };
}

async function grantLifetime(env, actor, target) {
  const account = await accountFor(env, target);
  if (!account) return { result: 'no_account', email: target };
  /* Only the columns being changed are sent. PostgREST's merge-duplicates upsert updates exactly
     the columns present, so an existing Stripe-managed row keeps its customer/subscription ids —
     sending them as null here would wipe the link to Stripe. */
  await sbUpsert(env, '/rest/v1/subscriptions', {
    user_id: account.id,
    status: 'active',
    lifetime: true,
    cancel_at_period_end: false,
    updated_at: new Date().toISOString(),
  });
  await log(env, actor.email, 'grant_lifetime', target, 'user_id ' + account.id);
  return { result: 'lifetime_granted', email: target };
}

/* ── identity ───────────────────────────────────────────────────────────────────────────── */

// Resolve the caller from their bearer token. Returns { email } or { error: Response }.
async function caller(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: json({ error: 'unauthorized' }, 401) };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: json({ error: 'config', detail: 'SUPABASE_SERVICE_ROLE_KEY missing' }, 500) };
  }
  let user;
  try {
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!r.ok) return { error: json({ error: 'forbidden', detail: 'auth ' + r.status }, 403) };
    user = await r.json();
  } catch (_) { return { error: json({ error: 'auth_unavailable' }, 503) }; }
  const email = String((user && user.email) || '').trim().toLowerCase();
  if (!email) return { error: json({ error: 'forbidden', detail: 'no email on account' }, 403) };
  return { email, id: user.id };
}

async function isAdmin(env, email) {
  const r = await sbGet(env, '/rest/v1/desktop_dl_admins?email=eq.' + enc(email) + '&enabled=is.true&select=email');
  return !!(r && r.length);
}
async function isEnabled(env, email) {
  const r = await sbGet(env, '/rest/v1/desktop_dl?email=eq.' + enc(email) + '&enabled=is.true&select=email');
  return !!(r && r.length);
}

/* Does a ThaiEar account exist for this address? GoTrue's admin `filter` is a PARTIAL match, so
   the result is re-checked for exact equality — "som@x.com" must not match "awesom@x.com". */
async function accountFor(env, email) {
  try {
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/admin/users?filter=' + enc(email), {
      headers: svc(env),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const users = (d && d.users) || (Array.isArray(d) ? d : []);
    return users.find((u) => String(u.email || '').toLowerCase() === email) || null;
  } catch (_) { return null; }
}

/* ── supabase helpers (service role — bypasses RLS) ──────────────────────────────────────── */

function svc(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
}
async function sbGet(env, path) {
  const r = await fetch(env.SUPABASE_URL + path, { headers: svc(env) });
  if (!r.ok) throw new Error('supabase GET ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function sbUpsert(env, path, row) {
  // Strip undefined so an omitted column is genuinely absent from the payload rather than null.
  const clean = {};
  Object.keys(row).forEach((k) => { if (row[k] !== undefined) clean[k] = row[k]; });
  const r = await fetch(env.SUPABASE_URL + path, {
    method: 'POST',
    headers: { ...svc(env), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([clean]),
  });
  if (!r.ok) throw new Error('supabase upsert ' + r.status + ': ' + (await r.text()).slice(0, 200));
}
async function sbPatch(env, path, row) {
  const r = await fetch(env.SUPABASE_URL + path, {
    method: 'PATCH',
    headers: { ...svc(env), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error('supabase patch ' + r.status + ': ' + (await r.text()).slice(0, 200));
}
// Audit writes are best-effort: a full log must never be the reason a grant fails. A missing line
// is recoverable; a monk who cannot be granted access at the moment someone is standing there
// waiting is not.
async function log(env, actorEmail, action, targetEmail, detail) {
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/desktop_dl_audit', {
      method: 'POST',
      headers: { ...svc(env), Prefer: 'return=minimal' },
      body: JSON.stringify([{ actor_email: actorEmail, action, target_email: targetEmail, detail }]),
    });
  } catch (_) {}
}

const enc = encodeURIComponent;
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
