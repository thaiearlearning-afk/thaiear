/* ============================================================
   functions/api/plays.js — per-sentence play counts
   ------------------------------------------------------------
   POST /api/plays  { batchId: "<uuid>", deltas: { "1220": 3, "1221": 1 } }
   GET  /api/plays                       -> { counts: { "1220": 5, ... } }

   Owning doc: PLAYS_COUNTER.md. Schema + the atomic increment: sentence_plays_schema.sql.

   ⚠⚠ DELTAS, NOT STATE — AND THAT IS THE WHOLE POINT.
   Every other sync path on this site (flags, playlists, dyn_prefs, progress) queues the desired
   FINAL VALUE and lets the newest write win. Correct for a toggle; catastrophic for a counter.
   Play sentence 1220 three times on the phone offline and twice in the browser offline, reconnect
   both, and last-write-wins stores 3 or 2 when the answer is 5. So the client sends what CHANGED
   and the database adds it on. Do not "harmonise" this with the outbox pattern next door.

   ⚠ THE TRAP THAT COMES WITH DELTAS: a retried POST that actually landed double-counts. Increments
   are not idempotent and a flaky mobile connection retries constantly. So every batch carries a
   client-minted uuid, which is INSERTED FIRST into play_batches; a primary-key conflict means
   "already applied" and we return 200 having applied nothing. That is exactly-once, no locking.
   ⚠ Order matters: claim the batch BEFORE applying it. The other way round, a crash between the
   two would leave the increment applied and unclaimed, and the retry would double it — which is
   the exact bug the batch id exists to prevent.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY (verify), SUPABASE_SERVICE_ROLE_KEY (write)

   ⚠ FAILS SOFT ON THE WAY IN, HONEST ON THE WAY OUT. A user must never be blocked or slowed by
   this — but unlike /api/seen it must NOT lie about success, because the client discards a batch
   it believes landed. A 5xx here means "still queued, try again"; only a 4xx tells the client to
   throw the batch away. Returning a cheerful 200 on a database failure would silently delete
   somebody's listening.
   ============================================================ */

/* Bounds. These arrive from a browser and an unbounded increment is not something to take on
   trust. Generous enough that no honest client ever meets them: 2,271 sentences exist in total,
   and the largest plausible offline burst is one long session. */
const MAX_KEYS = 3000;      // > the whole corpus, so a legitimate batch cannot be truncated
const MAX_DELTA = 500;      // per sentence, per batch
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const user = auth.user;

  let body = {};
  try { body = (await request.json()) || {}; } catch (_) {}

  const batchId = String(body.batchId || '');
  if (!UUID_RE.test(batchId)) return json({ error: 'bad_batch_id' }, 400);

  /* Validate here as well as in apply_plays(). The SQL function is the backstop that means the
     table cannot be corrupted even if this stops; this is the layer that tells the CLIENT its
     batch was malformed (400 → discard) rather than letting it retry something unusable for ever. */
  const raw = body.deltas;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return json({ error: 'bad_deltas' }, 400);

  const keys = Object.keys(raw);
  if (!keys.length) return json({ ok: true, empty: true }, 200);
  if (keys.length > MAX_KEYS) return json({ error: 'too_many_keys' }, 400);

  const deltas = {};
  let total = 0;
  for (const k of keys) {
    if (!/^[0-9]{1,6}$/.test(k)) return json({ error: 'bad_key', key: String(k).slice(0, 20) }, 400);
    const v = parseInt(raw[k], 10);
    if (!Number.isFinite(v) || v <= 0) continue;          // nothing to add — drop it silently
    deltas[k] = Math.min(v, MAX_DELTA);
    total += deltas[k];
  }
  if (!Object.keys(deltas).length) return json({ ok: true, empty: true }, 200);

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'config' }, 500);
  const H = svcHeaders(env);

  /* 1. CLAIM THE BATCH. A 409 is not an error — it is the happy path of a retry: the increment
        already happened, so report success and apply nothing. */
  try {
    const claim = await fetch(env.SUPABASE_URL + '/rest/v1/play_batches', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'return=minimal' }, H),
      body: JSON.stringify({ batch_id: batchId, user_id: user.id }),
    });
    if (claim.status === 409) return json({ ok: true, duplicate: true }, 200);
    if (!claim.ok) {
      return json({ error: 'db_error', stage: 'claim', status: claim.status,
                    detail: (await claim.text()).slice(0, 300) }, 502);
    }
  } catch (e) {
    return json({ error: 'db_unavailable', stage: 'claim', detail: msg(e) }, 502);
  }

  /* 2. APPLY. Atomically, in one statement, inside the database — see the note on apply_plays()
        in sentence_plays_schema.sql for why this is not a read-modify-write up here. */
  try {
    const rpc = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/apply_plays', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ p_user: user.id, p_deltas: deltas }),
    });
    if (!rpc.ok) {
      /* The claim landed but the increment did not, so this batch id would block its own retry
         for ever. Release it. Best-effort: if the release also fails the client retries, gets a
         409, and believes a batch landed that never did — the one place this design can lose
         data, and it needs two consecutive failures against a database that is already down. */
      await releaseBatch(env, H, batchId);
      return json({ error: 'db_error', stage: 'apply', status: rpc.status,
                    detail: (await rpc.text()).slice(0, 300) }, 502);
    }
  } catch (e) {
    await releaseBatch(env, H, batchId);
    return json({ error: 'db_unavailable', stage: 'apply', detail: msg(e) }, 502);
  }

  return json({ ok: true, applied: total }, 200);
}

/* Read the whole blob. One request, ~25 KB at the absolute ceiling (a fully-played corpus).
   The INDEX PAGE needs every count to compute per-topic minimums, which is exactly why the
   counts live in one jsonb row rather than 2,271 rows. */
export async function onRequestGet({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'config' }, 500);

  try {
    const got = await fetch(
      env.SUPABASE_URL + '/rest/v1/sentence_plays?user_id=eq.' +
        encodeURIComponent(auth.user.id) + '&select=counts',
      { headers: svcHeaders(env) });
    if (!got.ok) {
      return json({ error: 'db_error', status: got.status,
                    detail: (await got.text()).slice(0, 300) }, 502);
    }
    const rows = await got.json();
    // No row yet is not an error — it is a user who has not played anything.
    return json({ counts: (rows[0] && rows[0].counts) || {} }, 200);
  } catch (e) {
    return json({ error: 'db_unavailable', detail: msg(e) }, 502);
  }
}

/* ---- helpers ---------------------------------------------------------- */

async function authenticate(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: json({ error: 'unauthorized' }, 401) };
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return { error: json({ error: 'forbidden' }, 403) };
    const user = await who.json();
    if (!user || !user.id) return { error: json({ error: 'no_user' }, 400) };
    return { user };
  } catch (_) {
    /* 503, not 403. An unreachable auth service is transient, and the client must keep its
       batch queued rather than treat it as a rejection and discard it. */
    return { error: json({ error: 'auth_unavailable' }, 503) };
  }
}

function svcHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
}

async function releaseBatch(env, H, batchId) {
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/play_batches?batch_id=eq.' + encodeURIComponent(batchId), {
      method: 'DELETE', headers: Object.assign({ Prefer: 'return=minimal' }, H),
    });
  } catch (_) {}
}

function msg(e) { return String((e && e.message) || e); }

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
