/* ============================================================
   functions/api/attrib.js — record the ad click that made an account
   ------------------------------------------------------------
   POST /api/attrib  { gclid, utm_*, landing_page, referrer, first_seen }
   (called by attrib.js the first time a NEW user's session appears).

   Verifies the caller's Supabase token, then writes ONE row per user
   with the service role. First write wins: a returning user re-posting
   never overwrites the click that originally produced the account.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY (verify), SUPABASE_SERVICE_ROLE_KEY (write)
   Table + why it exists: supabase_ad_attribution.sql

   ⚠ Fails SILENTLY from the caller's point of view — attribution is
   measurement, never something a user should notice or be blocked by.
   Errors are returned for debugging but attrib.js ignores them.
   ============================================================ */

const FIELDS = [
  'gclid', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'landing_page', 'referrer',
];

/* ⚠⚠ WHERE A CLICK IDENTIFIER MAY NOT BE RECORDED AT ALL (2026-08-20).

   The gclid/utm capture runs on LEGITIMATE INTERESTS, not consent, because attrib.js reads it out
   of the URL and writes nothing to the device (PECR reg 6 is not engaged). That reasoning is
   written up as LIA C in DATA_PROTECTION.md. It is deliberately NOT relied on here:

     • Google's own EU user consent policy and Consent Mode v2 apply in the EEA, the UK and
       Switzerland, and require consent signals we do not have while the banner is suppressed. An
       unconsented conversion from those regions cannot be used for matching — so storing the id
       would be processing personal data for a purpose it cannot actually serve, which fails the
       necessity limb before the balancing test is even reached.
     • It keeps the most consent-sensitive audience out of a judgement call.

   ⚠ THE STRIP IS SERVER-SIDE ON PURPOSE. The browser cannot be trusted to know or report its own
   country, and a client-side check would be bypassable; `request.cf.country` is resolved by
   Cloudflare at the edge. Do NOT move this into attrib.js.

   ⚠ GEOGRAPHY IS NOT STRIPPED — only the click fields. geo_country/city/asn run on a separate
   basis (LIA A, ROPA row 7) and are wanted for every signup, including these.

   ⚠ It keys on the country AT SIGNUP, the only signal available at that moment. Someone who clicks
   in Bangkok and signs up in London is treated as UK. Accepted, and recorded in LIA C §4.

   ⚠ An UNKNOWN country (cf.country absent — local wrangler, or an edge that could not resolve it)
   FAILS CLOSED and is treated as consent-required. Recording nothing is recoverable; recording
   something we should not have is not. */
const CONSENT_REQUIRED_COUNTRIES = new Set([
  // EU 27
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // rest of the EEA
  'IS', 'LI', 'NO',
  // + UK and Switzerland
  'GB', 'CH',
]);

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
  } catch (_) {
    return json({ error: 'auth_unavailable' }, 503);
  }
  if (!user.id) return json({ error: 'no_user' }, 400);

  let body = {};
  try { body = (await request.json()) || {}; } catch (_) {}

  // Whitelist + clamp. Nothing here is displayed anywhere, but an
  // unbounded string from a URL is still not something to store.
  const row = { user_id: user.id };
  for (const f of FIELDS) {
    const v = body[f];
    if (typeof v === 'string' && v.trim()) row[f] = v.trim().slice(0, 512);
  }
  if (body.first_seen && typeof body.first_seen === 'string') {
    const t = Date.parse(body.first_seen);
    if (!isNaN(t)) row.first_seen = new Date(t).toISOString();
  }

  /* ⭐ SIGNUP GEOGRAPHY (2026-08-17). Cloudflare resolves this at the edge for free, so it costs
     nothing and needs no extra credential. Deliberately COARSE: country, city and network name —
     never the IP itself. The raw IP does exist, in the Supabase auth log, but that expires after
     7 days and needs an account-scoped Personal Access Token to read; this is permanent, lives in
     our own table, and is the lighter-touch thing to store.
     ⚠ `request.cf` is undefined under local wrangler, hence the guard. */
  const cf = request.cf || {};
  if (cf.country) row.geo_country = String(cf.country).slice(0, 8);
  /* ⛔ CITY AND NETWORK OPERATOR ARE DELIBERATELY NOT STORED (owner decision 2026-08-21).
     request.cf offers `city` and `asOrganization` free, and both were written per user for a
     month. NOTHING beyond the country was ever used by any analysis -- the carve-out, the
     drop-rate measurement and every geography question this project has asked are all
     country-level. A city and an ISP tied to an account is a standing liability for no
     return, so they go. `privacy.html` now promises country only; re-adding either would
     make the published notice false. Guarded by test_attrib_geo.mjs, whose stub still sends
     both on purpose. */

  /* ⬛ THE CARVE-OUT. Runs AFTER the geo block above, because it needs cf.country -- and because
     the geography is deliberately kept. See CONSENT_REQUIRED_COUNTRIES at the top of this file.
     Fails closed on an unknown country. */
  const country = cf.country ? String(cf.country).toUpperCase() : null;
  if (!country || CONSENT_REQUIRED_COUNTRIES.has(country)) {
    for (const f of FIELDS) delete row[f];
    delete row.first_seen;
  }

  /* ⚠ THE `if (!any) return` EARLY EXIT WAS REMOVED HERE (2026-08-17). It used to skip organic
     signups entirely, which is why "no row" meant "not from paid". Every signup now writes a row
     so the geography above is captured for organic users too.
     ⚠ ORGANIC IS NOW `gclid is null and utm_campaign is null`, not the absence of a row. That is
     an improvement — organic signups become countable rather than inferred from a gap — but it
     is written down in attrib.js and supabase_ad_attribution.sql as well, and all three must
     agree. */

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: true, skipped: 'no_key' }, 200);

  try {
    // Plain insert, NOT upsert: the FIRST click that produced the account is
    // the true one. A 409 here means we already have it, which is success.
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/ad_attribution', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (r.status === 409) return json({ ok: true, already: true }, 200);
    if (!r.ok) {
      return json({ error: 'db_error', status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
    }
  } catch (e) {
    return json({ error: 'db_unavailable', detail: String((e && e.message) || e) }, 502);
  }

  return json({ ok: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
