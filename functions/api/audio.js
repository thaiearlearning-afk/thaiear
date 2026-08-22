/* ============================================================
   functions/api/audio.js — ThaiEar premium-audio gate (Phase 3).
   ------------------------------------------------------------
   Cloudflare Pages Function, served at  /api/audio?file=<name>.mp3
   on the same origin (thaiear.com). It is the REAL lock: premium
   MP3s live in a PRIVATE R2 bucket and only this endpoint can hand
   them out, after checking the caller.

   Flow (presigned-URL design — see MEMBERSHIP_PAYWALL.md §4):
     1. player.js fetches this with the Supabase access token in an
        Authorization: Bearer <jwt> header (a header an <audio> tag
        can't send, which is why we do the two-step dance).
     2. We verify the token with Supabase (logged in = entitled, for
        now — Phase 4 will also require an active subscription).
     3. We return a short-lived presigned R2 GET URL. The audio bytes
        go browser ↔ R2 directly; they never pass through this Worker.
        The URL self-expires, so it can't be shared for long.
     Anything unverified gets 401/403 and no URL.

   Tiers (Phase 4): a gated file is either MEMBER (login-only) or PREMIUM
   (subscription). Both live in the private bucket; the prefix decides which.
   Premium-subscription enforcement is held behind ENFORCE_SUBSCRIPTION so premium
   keeps gating on "logged in" until Stripe is wired, then the flag flips it on.

   Env (Cloudflare Pages → Settings → Variables & Secrets):
     SUPABASE_URL            e.g. https://pyfyyiegmxwmfshgwvze.supabase.co
     SUPABASE_ANON_KEY       the publishable key (public by design)
     R2_ACCOUNT_ID           R2 account id (S3 endpoint host)
     R2_ACCESS_KEY_ID        SECRET — R2 token id with read on the premium bucket
     R2_SECRET_ACCESS_KEY    SECRET — its secret
     R2_PREMIUM_BUCKET       private bucket name, e.g. thaiear-audio-premium
     PREMIUM_PREFIXES        comma list, default "CommSurvival_BEG,Colours_BEG"
     MEMBER_PREFIXES         comma list of login-only audio prefixes (default none)
     ENFORCE_SUBSCRIPTION    "true" to require an active subscription for premium
   ============================================================ */

const URL_TTL = 3600; // seconds the signed URL stays valid (covers full-file streaming + seeking)

/* BATCH MINTING (2026-08-19). `?files=a.mp3,b.mp3,…` signs many keys in ONE request.
   Why: every signed URL used to cost a full round trip — page → this Function → Supabase →
   back — and the client mints one PER CLIP. A dynamic-player build of a 47-clip topic therefore
   opened 47 of them (6 at a time), and every individual sentence tap paid another before the
   audio fetch could even start. The auth check is the expensive half and it is per USER, not per
   file, so doing it once for the whole list removes essentially all of that.
   ⚠ THE TIER DECISION STAYS PER FILE. A batch must never become a way to smuggle a premium key
   in beside a cheaper one: each name is tiered and authorised on its own, refusals are reported
   per file in `denied`, and the allowed ones are still returned. The single-file contract below
   is untouched — old cached clients keep working exactly as they did. */
const MAX_BATCH = 120;   // a long split topic is ~50 clips; this is headroom, not a target

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const file = params.get('file') || '';
  const filesParam = params.get('files') || '';

  if (filesParam) return batch(filesParam, request, env);

  // Flat filenames only — no slashes / traversal. The premium bucket holds only these.
  if (!/^[A-Za-z0-9_]+\.mp3$/.test(file)) return json({ error: 'bad_request' }, 400);

  const tier = tierFor(file, env);

  // 2) Any gated file needs a signed-in user.
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

  // 3) Premium also needs an active subscription — once enforcement is switched on.
  //    Until ENFORCE_SUBSCRIPTION="true", premium behaves like member (logged-in is enough),
  //    so premium audio keeps working before Stripe is live (the Phase-4 cutover flips this).
  if (tier === 'premium' && env.ENFORCE_SUBSCRIPTION === 'true') {
    if (!(await isSubscribed(env, token, user.id))) return json({ error: 'subscription_required' }, 402);
  }

  // 2) Hand back a short-lived presigned URL straight to R2.
  let url;
  try {
    url = await presignR2Get(env, file, URL_TTL);
  } catch (_) {
    return json({ error: 'sign_failed' }, 500);
  }
  return json({ url, expiresIn: URL_TTL }, 200);
}

/* One auth check, N signatures. Mirrors the single-file path decision for decision — the tier
   lists, the login requirement and the subscription requirement are the SAME code below — so the
   two routes can never drift into disagreeing about who may have what. */
async function batch(filesParam, request, env) {
  const names = filesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length || names.length > MAX_BATCH) return json({ error: 'bad_request' }, 400);
  if (names.some(n => !/^[A-Za-z0-9_]+\.mp3$/.test(n))) return json({ error: 'bad_request' }, 400);

  // A batch is only ever asked for by a signed-in client; no token is a flat 401, as for one file.
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

  // The subscription lookup is the second expensive call, so it runs AT MOST once per batch —
  // and only if some file in the list actually needs it.
  let subOk = null;
  const enforcing = env.ENFORCE_SUBSCRIPTION === 'true';
  const urls = {}, denied = {};
  const signer = await signerFor(env);   // derive the SigV4 signing key once for the whole batch

  for (const name of names) {
    if (tierFor(name, env) === 'premium' && enforcing) {
      if (subOk === null) subOk = await isSubscribed(env, token, user.id);
      if (!subOk) { denied[name] = 'subscription_required'; continue; }
    }
    try {
      urls[name] = await presignR2Get(env, name, URL_TTL, signer);
    } catch (_) {
      denied[name] = 'sign_failed';
    }
  }
  return json({ urls, denied, expiresIn: URL_TTL }, 200);
}

/* The tier decision, shared by the single-file and batch routes so they cannot drift apart.
   Pure: filename + env in, tier out — no auth, no I/O. */
function tierFor(file, env) {
  // 1) Which tier does this file require? Prefix = name before _S###_TH / _S###_EN / _TE / _ET.
  // _EN (per-sentence English, added for the dynamic player) MUST be listed here: an unmatched
  // filename falls through to the whole name as the "prefix", which is in no tier list, so it
  // defaults to premium — silently demanding a subscription for a MEMBER topic's English clips.
  const m = file.match(/^(.+?)_(?:S\d+_(?:TH|EN)|TE|ET)\.mp3$/);
  const prefix = m ? m[1] : file.replace(/\.mp3$/, '');
  // ── TIER LISTS — source of truth (edit here in git; no dashboard needed) ──
  // Keep in sync with topics.js `access` flags + each page's `tier`. The env vars are
  // just optional overrides; normally these code defaults decide the tier.
  // ⚠ THE MEMBER TIER WAS RETIRED 2026-08-10. Two tiers now: FREE and PREMIUM.
  // Model: the 3 standalone free topics PLUS the 9 former-member first-parts are free — their
  // MP3s live in the PUBLIC bucket and never reach this endpoint at all. Everything else is
  // premium. `memberList` is therefore EMPTY, and any private file defaults to premium, which
  // is the stricter and correct answer.
  //   Retired from memberList → now FREE (moved to the public bucket by r2_demote_to_public.py):
  //   ColoursAndDescriptions_BEG, ShoppingAndMoney_BEG, Feelings_BEG, Occupations_BEG,
  //   Temple_LI1, Romance_LI1, ThaiCulture_LI1, Tech_LI1.
  //   ⚠ Food_BEG WAS in that free list and was taken back to PREMIUM on 2026-08-22 (owner: trim
  //   the free tier). That is the ONLY tier change since 2026-08-10, and it is not just a flag:
  //   its 86 objects had to be copied PUBLIC → PRIVATE first, because this endpoint presigns
  //   from the private bucket only. Flag-before-copy = a 404 on every clip for entitled users;
  //   copy-without-deleting-and-purging-the-public-side = the padlock is decorative for up to
  //   30 days (s-maxage=2592000). See TOPIC_REASSIGNMENT_2026-08-22.md §3.
  // Keep in sync with topics.js `access` (absent = free) and each page's `tier` (absent = free).
  // The member CODE PATH below is deliberately left intact rather than ripped out: it costs
  // nothing, and it is what makes re-introducing a login-only tier a one-line list edit.
  // (History: HomeAndDailyRoutine_BEG, Transport_BEG, Health_BEG, Cooking_BEG demoted member →
  // premium 2026-06-23; Places_BEG, Clothing_BEG, Plans_BEG, Schooling_LI1, GeoRegions_LI1,
  // Community_LI1, Sport_LI1, Nature_LI1, FoodSocial_LI1, Job_LI1 promoted member → premium
  // 2026-07-01; the 9 above retired member → free 2026-08-10.)
  const premiumList = listEnv(env.PREMIUM_PREFIXES, ['ColoursAndDescriptions2_BEG', 'ShoppingAndMoney2_BEG', 'HomeAndDailyRoutine_BEG', 'HomeAndDailyRoutine2_BEG', 'Weather_BEG', 'Time_BEG', 'Dates_BEG', 'Family_BEG', 'Food_BEG', 'Food_LI1', 'Transport_BEG', 'Transport_LI1', 'Emergency_BEG', 'BodyHealth_BEG', 'Health_BEG', 'Health_LI1', 'Feelings_LI1', 'Hobbies_BEG', 'SocialLife_BEG', 'Idiom_BEG', 'Plans_LI1', 'Appearance_LI1', 'Cooking_BEG', 'Recipes_LI1', 'Workplace_LI1', 'Career_LI2', 'Study_LI1', 'System_LI2', 'School_LI1', 'Campus_LI1', 'FoodCulture_LI2', 'ToneTwister_LI1', 'Animals_BEG', 'Groceries_BEG', 'Places2_BEG', 'Occupations_LI1', 'Dhamma_LI2', 'Monastic_LI2', 'Sport_LI2', 'Nature_LI2', 'Travel_LI1', 'Travel2_LI1', 'Travel_LI2', 'HolyDays_LI1', 'Meditation_LI2', 'Romance2_LI1', 'Romance3_LI1', 'Romance4_LI1', 'ThaiCulture_LI2', 'Tech2_LI1', 'Tech3_LI1', 'GeoRegions_LI2', 'Community_LI2', 'Compliments_LI1', 'Opinions_LI1', 'Places_BEG', 'Clothing_BEG', 'Plans_BEG', 'Schooling_LI1', 'GeoRegions_LI1', 'Community_LI1', 'Sport_LI1', 'Nature_LI1', 'FoodSocial_LI1', 'Job_LI1']);
  const memberList = listEnv(env.MEMBER_PREFIXES, []);   // member tier retired 2026-08-10 — see above
  // Member only if explicitly listed (and not premium); unknown private files default to premium.
  return (memberList.includes(prefix) && !premiumList.includes(prefix)) ? 'member' : 'premium';

}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function listEnv(v, def) {
  if (!v) return def;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// Active subscription? Reads the user's own row via RLS (their token), so no service key here.
async function isSubscribed(env, token, uid) {
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

/* ---- minimal AWS SigV4 query presigner for Cloudflare R2 (S3 API, path-style) ----
   Validated to produce byte-identical signatures to boto3's generate_presigned_url. */
/* Derive the SigV4 signing key ONCE for a whole batch. It depends only on the secret, the date
   and the scope — never on the object key — so re-deriving it per file (4 chained HMACs each) was
   pure waste: 47 clips cost 188 HMACs where 4 will do. Single-file callers omit it and get the
   old behaviour. The date is captured with the key so a batch that straddles midnight UTC can't
   sign with a stamp that disagrees with its own credential scope. */
async function signerFor(env) {
  const region = 'auto', service = 's3';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  return {
    amzDate, dateStamp,
    key: await signingKeyFor(env.R2_SECRET_ACCESS_KEY, dateStamp, region, service),
  };
}

async function presignR2Get(env, key, expires, signer) {
  const region = 'auto', service = 's3';
  const host = env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com';
  const bucket = env.R2_PREMIUM_BUCKET;
  const accessKey = env.R2_ACCESS_KEY_ID;

  if (!signer) signer = await signerFor(env);
  const amzDate = signer.amzDate;
  const dateStamp = signer.dateStamp;

  const canonicalUri = '/' + enc(bucket) + '/' + enc(key);
  const credential = `${accessKey}/${dateStamp}/${region}/${service}/aws4_request`;

  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');

  const canonicalRequest = [
    'GET', canonicalUri, canonicalQuery, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const signature = hex(await hmac(signer.key, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// RFC3986 encoding: leave A-Za-z0-9-_.~ ; escape everything else (incl. !*'() that encodeURIComponent skips).
function enc(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
async function sha256Hex(msg) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)));
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
}
async function signingKeyFor(secret, dateStamp, region, service) {
  let key = new TextEncoder().encode('AWS4' + secret);
  key = await hmac(key, dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  return hmac(key, 'aws4_request');
}
function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
