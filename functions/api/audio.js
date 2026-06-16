/* ============================================================
   functions/api/audio.js — ThaiEar premium-audio gate (Phase 3).
   ------------------------------------------------------------
   Cloudflare Pages Function, served at  /api/audio?file=<name>.mp3
   on the same origin (thaiear.com). It is the REAL lock: premium
   MP3s live in a PRIVATE R2 bucket and only this endpoint can hand
   them out, after checking the caller.

   Flow (presigned-URL design — see MEMBERS_PAYWALL_PLAN.md §4):
     1. player.js fetches this with the Supabase access token in an
        Authorization: Bearer <jwt> header (a header an <audio> tag
        can't send, which is why we do the two-step dance).
     2. We verify the token with Supabase (logged in = entitled, for
        now — Phase 4 will also require an active subscription).
     3. We return a short-lived presigned R2 GET URL. The audio bytes
        go browser ↔ R2 directly; they never pass through this Worker.
        The URL self-expires, so it can't be shared for long.
     Anything unverified gets 401/403 and no URL.

   Env (Cloudflare Pages → Settings → Variables & Secrets):
     SUPABASE_URL            e.g. https://pyfyyiegmxwmfshgwvze.supabase.co
     SUPABASE_ANON_KEY       the publishable key (public by design)
     R2_ACCOUNT_ID           R2 account id (S3 endpoint host)
     R2_ACCESS_KEY_ID        SECRET — R2 token id with read on the premium bucket
     R2_SECRET_ACCESS_KEY    SECRET — its secret
     R2_PREMIUM_BUCKET       private bucket name, e.g. thaiear-audio-premium
   ============================================================ */

const URL_TTL = 3600; // seconds the signed URL stays valid (covers full-file streaming + seeking)

export async function onRequestGet(context) {
  const { request, env } = context;
  const file = new URL(request.url).searchParams.get('file') || '';

  // Flat filenames only — no slashes / traversal. The premium bucket holds only these.
  if (!/^[A-Za-z0-9_]+\.mp3$/.test(file)) return json({ error: 'bad_request' }, 400);

  // 1) Verify the Supabase session token that player.js sends.
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  let who;
  try {
    who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
  } catch (_) {
    return json({ error: 'auth_unavailable' }, 503);
  }
  if (!who.ok) return json({ error: 'forbidden' }, 403);

  // --- Phase 4 hook: also require an active subscription -------------------
  // const user = await who.json();
  // const sub = await lookupSubscription(env, user.id);
  // if (!sub || !sub.active) return json({ error: 'subscription_required' }, 402);
  // ------------------------------------------------------------------------

  // 2) Hand back a short-lived presigned URL straight to R2.
  let url;
  try {
    url = await presignR2Get(env, file, URL_TTL);
  } catch (_) {
    return json({ error: 'sign_failed' }, 500);
  }
  return json({ url, expiresIn: URL_TTL }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/* ---- minimal AWS SigV4 query presigner for Cloudflare R2 (S3 API, path-style) ----
   Validated to produce byte-identical signatures to boto3's generate_presigned_url. */
async function presignR2Get(env, key, expires) {
  const region = 'auto', service = 's3';
  const host = env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com';
  const bucket = env.R2_PREMIUM_BUCKET;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

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

  const signingKey = await signingKeyFor(secretKey, dateStamp, region, service);
  const signature = hex(await hmac(signingKey, stringToSign));

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
