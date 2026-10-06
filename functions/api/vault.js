/* ============================================================
   functions/api/vault.js — a small private area for a short allow-list of accounts.
   ------------------------------------------------------------
   Served at /api/vault on the same origin. Everything it hands out lives under the `v-` key
   prefix in the PRIVATE R2 bucket (R2_PREMIUM_BUCKET), and is reachable ONLY through here.

   ⛔ THE ISOLATION RESTS ON TWO FACTS — keep both:
     1. audio.js, the only other reader of that bucket, refuses every name that is not
        /^[A-Za-z0-9_]+\.mp3$/ — so a `v-` key (it has a hyphen) can never be signed there.
        test_vault.js asserts that against audio.js's own source.
     2. This endpoint answers 404 to EVERYONE who is not signed in AND on VAULT_ALLOW — the same
        404, the same body, whether the reason is no token, a bad token, an unlisted account or a
        missing setting. A caller cannot tell "not allowed" from "nothing here".

   Env (Cloudflare Pages → Settings → Variables & Secrets):
     VAULT_ALLOW   SECRET — comma list of account emails. Unset = the area is closed to everyone.
     plus the SUPABASE_* and R2_* settings audio.js already uses.

   Routes (all GET, all need Authorization: Bearer <supabase access token>):
     ?q=me             → the small entry object (v-me.json): what the entry button shows.
     ?q=data           → the area's data (v-data.json).
     ?file=a.mp3       → one presigned URL, the same contract as /api/audio?file= ({url, expiresIn}).
     ?files=a.mp3,b…   → presigned URLs for clips, the same contract as /api/audio?files=
                         ({urls, denied, expiresIn}); a name is mapped to its `v-` key here.
   ⚠ Nothing here is cacheable by anyone: every response is no-store, and sw.js never caches /api/.
   ============================================================ */
import { json, signerFor, presignR2Get } from './audio.js';

const URL_TTL = 21600;   // same lifetime as audio.js (player.js clamps its own cache below it)
const MAX_BATCH = 120;
const CLIP_RE = /^X\d_S9\d{4}_(DE|EN|TH)\.mp3$/;

const nothing = () => json({ error: 'not_found' }, 404);

async function allowed(request, env) {
  const list = String(env.VAULT_ALLOW || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return null;
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return null;
    const user = await who.json();
    const email = String((user && user.email) || '').toLowerCase();
    if (!email || !(user.email_confirmed_at || user.confirmed_at)) return null;
    return list.includes(email) ? user : null;
  } catch (_) {
    return null;
  }
}

async function readObject(env, key) {
  const url = await presignR2Get(env, key, 60);
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.text();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const user = await allowed(request, env);
  if (!user) return nothing();

  const q = params.get('q');
  if (q === 'me' || q === 'data') {
    let body = null;
    try { body = await readObject(env, q === 'me' ? 'v-me.json' : 'v-data.json'); } catch (_) {}
    if (body == null) return nothing();
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const one = params.get('file');
  if (one) {
    if (!CLIP_RE.test(one)) return nothing();
    try { return json({ url: await presignR2Get(env, 'v-' + one, URL_TTL), expiresIn: URL_TTL }, 200); }
    catch (_) { return json({ error: 'sign_failed' }, 500); }
  }

  const files = params.get('files');
  if (files) {
    const names = files.split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length || names.length > MAX_BATCH || names.some(n => !CLIP_RE.test(n))) return nothing();
    const signer = await signerFor(env);
    const urls = {}, denied = {};
    for (const name of names) {
      try { urls[name] = await presignR2Get(env, 'v-' + name, URL_TTL, signer); }
      catch (_) { denied[name] = 'sign_failed'; }
    }
    return json({ urls, denied, expiresIn: URL_TTL }, 200);
  }
  return nothing();
}
