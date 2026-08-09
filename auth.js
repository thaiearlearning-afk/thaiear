/* ============================================================
   auth.js — ThaiEar authentication (Supabase + Google).
   ------------------------------------------------------------
   Loaded automatically by nav.js when the members UI is on, so
   no page needs its own <script>. Responsibilities:
     • create the Supabase client
     • expose window.ThaiEarAuth.{ getUser, signInWithGoogle, sendMagicLink, signOut, isReady }
     • keep the cached current user in sync and tell the nav to re-render

   getUser() is SYNCHRONOUS (the nav calls it during render) and returns
   the cached user — null until the session resolves, then the real user.
   On any auth change we refresh the nav and fire a `thaiear:auth` event.

   The publishable key + project URL below are PUBLIC by design (Supabase
   Row-Level Security protects the data). The secret service-role key is
   NEVER here — it only ever lives in Cloudflare environment settings.
   ============================================================ */

(function () {
  'use strict';
  if (window.ThaiEarAuth) return; // load once

  // Custom auth domain (Supabase custom-domain add-on) so the Google OAuth consent
  // screen shows a ThaiEar-branded host instead of the raw project domain. The old
  // pyfyyiegmxwmfshgwvze.supabase.co URL still works server-side (functions use it via env).
  var SUPABASE_URL = 'https://auth.thaiear.com';
  var SUPABASE_KEY = 'sb_publishable_Msf5wsXw0KdugHGd5C2-mA_TNxbhT0e';
  var SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';

  var client = null;
  var currentUser = null;
  var currentSession = null;
  var currentSubscribed = false; // active Stripe subscription? (read from Supabase via RLS)
  /* Did a CLEAN server read actually answer this session? The offline grace window exists for when
     we CANNOT check; once the server has told us authoritatively that someone is not subscribed,
     the window must not keep granting access. Set true only on an error-free read, cleared on
     sign-out and on any failure, so the fallback stays generous exactly when it should. */
  var subFresh = false;
  var subFreshAt = 0;
  /* Freshness must EXPIRE. It was set once on a clean read and never cleared, so loading a page
     online and then switching on airplane mode left it true in memory — the app went on believing
     it had a live server answer while offline, and the whole offline branch stayed unreachable.
     That is why the 51-day case passed once (reloaded while already offline) and never again.
     Two bounds: a short TTL, and an explicit clear when the device reports going offline. */
  var SUB_FRESH_TTL_MS = 5 * 60 * 1000;
  /* The offline grace window — the FALLBACK for when no real period end was ever captured. A paying
     member is governed by thaiear_sub_until (their actual billing period), which is checked first.
     ⚠ Keep player.js + nav.js in step. Moved here 2026-07-31 with canUseOffline below. */
  var OFFLINE_GRACE_MS = 50 * 24 * 60 * 60 * 1000;
  // In-memory throttle for canUseOffline's licence stamp — see the note at that call site for why
  // it deliberately does NOT read thaiear_lastVerified.
  var lastStampAttempt = 0;
  // The offline manifest, read-only. player.js owns writing it; this is only ever asked "does this
  // prefix have an entry", for the member-tier rule in lockedFor().
  function hasOfflineEntry(prefix) {
    try { return !!(JSON.parse(localStorage.getItem('thaiear_offline') || '{}') || {})[prefix]; }
    catch (_) { return false; }
  }
  var currentSub = null;         // {status, cancel_at_period_end, current_period_end}
  var currentConsent = false;    // opted in to marketing email? (profiles row)
  var consentLoaded = false;     // has that consent flag been read from profiles yet?
  var currentProgress = null;    // { goal:int, topics:{ key:count } } — lazy-loaded from `progress`
  var progressLoaded = false;    // has the progress row been read yet?
  var currentFlags = null;       // map "topicKey:num" -> {topic_key,num,sentence} — lazy from `sentence_flags`
  var flagsLoaded = false;       // has the flag set been read yet?

  // Goal steps the loading bars snap to. The goal auto-advances to the smallest
  // step that still contains the highest count, so a bar can never overflow.
  var GOAL_STEPS = [5, 10, 20, 50, 100];
  function nextGoalFor(n) {
    for (var i = 0; i < GOAL_STEPS.length; i++) { if (GOAL_STEPS[i] >= n) return GOAL_STEPS[i]; }
    return GOAL_STEPS[GOAL_STEPS.length - 1]; // cap at 100
  }
  function maxCount(topics) {
    var m = 0; for (var k in topics) { if (topics[k] > m) m = topics[k]; } return m;
  }

  function userFromSession(session) {
    if (!session || !session.user) return null;
    var u = session.user;
    var meta = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || '',
      username: meta.full_name || meta.name || (u.email ? u.email.split('@')[0] : 'Member'),
      avatar: meta.avatar_url || ''
    };
  }

  // Read the persisted Supabase session straight from localStorage (key: sb-<ref>-auth-token). Used
  // as an OFFLINE fallback for init: client.auth.getSession() fires a network token-refresh when the
  // access token is expired, which hangs ~8s offline before returning. supabase-js@2 stores the
  // session object directly (older builds wrapped it in { currentSession }).
  var SB_REF = (SUPABASE_URL.match(/\/\/([^.]+)\./) || [])[1] || '';
  var SB_STORAGE_KEY = 'sb-' + SB_REF + '-auth-token';
  function readStoredSession() {
    try {
      var raw = localStorage.getItem(SB_STORAGE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      var s = (o && o.currentSession) ? o.currentSession : o;
      return (s && s.user) ? s : null;
    } catch (_) { return null; }
  }

  /* ══ DURABLE OFFLINE IDENTITY (2026-07-29) ═══════════════════════════════════════════════════
     THE BUG THIS FIXES: after ~8 h offline both the PWA and the app showed the user as logged
     OUT, and tapping sign-in did nothing — so every offline download became unplayable, because
     entitlement needs a user.

     MEASURED CAUSE (read out of the pinned bundle, @supabase/supabase-js@2 → 2.111.0):
       catch (err) { if (isAuthError(err)) { if (!isAuthRetryableFetchError(err)) {
           const stored = await getItem(storage, storageKey);
           if (stored?.expires_at * 1000 > Date.now()) { ...preserve... }
           else await this._removeSession();      // ← DELETES sb-<ref>-auth-token
     Once the access token has expired, a refresh failure that is NOT classified as a retryable
     FETCH error makes supabase-js purge its own stored session. Offline that is easy to hit —
     auth.thaiear.com is a custom domain behind Cloudflare, so a dead network can yield an edge
     HTML response that parses as an API error rather than a network error. There is a second
     purge on the getUser() path too.
     The old guard below asked readStoredSession() — the SUPABASE-owned key. Once supabase had
     deleted it the guard could not fire, the genuine-logout path ran, and the refresh token that
     would have restored them silently was gone as well. Hence "sign in did nothing": offline
     OAuth cannot complete, and the recovery material had been destroyed.

     THE FIX: keep our OWN copy of who is signed in, under a key supabase-js never touches.
     It is the source of truth for "is someone signed in" while offline; supabase remains the
     source of truth whenever it can actually answer. Storing the tokens here is no weaker than
     today — supabase-js already keeps exactly these in the same localStorage, same origin; this
     is a duplicate so a library-internal purge cannot strand the user. Cleared ONLY by a real
     signOut(). */
  // Boot trace (test build only; inert without sim.js) — see sim.js BOOT TRACE.
  var ID_KEY = 'thaiear_identity';
  var SIGNED_OUT_KEY = 'thaiear_signed_out';
  function readIdentity() {
    try {
      if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return null;  // they really did log out
      var o = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      return (o && o.user && o.user.id) ? o : null;
    } catch (_) { return null; }
  }
  // Mirror a live session into our own store. Called on every auth resolution that has a user.
  function writeIdentity(session) {
    try {
      var u = session && session.user;
      if (!u) return;
      localStorage.setItem(ID_KEY, JSON.stringify({
        user: u,
        access_token: session.access_token || null,
        refresh_token: session.refresh_token || null,
        at: Date.now()
      }));
      localStorage.removeItem(SIGNED_OUT_KEY);
    } catch (_) {}
  }
  function clearIdentity() {
    try { localStorage.removeItem(ID_KEY); localStorage.setItem(SIGNED_OUT_KEY, '1'); } catch (_) {}
  }
  /* Any durable evidence this device is signed in — ours first (survives a supabase purge), then
     supabase's own copy for accounts that signed in before this mechanism existed.
     The signed-out marker is checked HERE as well as inside readIdentity(): supabase's signOut()
     can settle after forceLocal() has already wiped its key and write session state back, and a
     second tab can do the same. Without this check that stale key resurrects the user and a real
     logout silently undoes itself. */
  function anySignedIn() {
    try { if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return null; } catch (_) {}
    var id = readIdentity();
    if (id) return id;
    var s = readStoredSession();
    return s ? { user: s.user } : null;
  }

  /* Reconnect recovery: if supabase has no session but we still hold tokens, hand them back so
     the user is restored WITHOUT a fresh OAuth round trip. This is what makes sign-in work again
     after a long offline spell — the refresh token long outlives the 1 h access token, so this
     normally succeeds the moment the network returns. */
  // The actual OAuth kick-off, factored out of signInWithGoogle so the offline recovery path
  // above can fall through to it. Native app → deep-link flow; web → ordinary page redirect.
  function startGoogleSignIn() {
    if (!client) return;
    if (isNative()) { nativeGoogleSignIn(); return; }
    client.auth.signInWithOAuth({
      provider: 'google',
      // prompt=select_account → Google always shows the account chooser, so signing
      // in is a deliberate confirmation rather than a silent re-auth.
      options: { redirectTo: window.location.href, queryParams: { prompt: 'select_account' } }
    });
  }

  var reseeding = false;
  var restoredFromIdentity = false;   // true while the app is running on OUR record, not supabase's
  function reseedSession() {
    if (reseeding || !client) return Promise.resolve(false);
    var id = readIdentity();
    if (!id || !id.refresh_token) return Promise.resolve(false);
    reseeding = true;
    return client.auth.setSession({ access_token: id.access_token || '', refresh_token: id.refresh_token })
      .then(function (r) {
        reseeding = false;
        var s = r && r.data && r.data.session;
        if (s) {
          writeIdentity(s);
          restoredFromIdentity = false;   // supabase owns a real session again
          currentSession = s;             // so getAccessToken() stops handing out the stale token
          return true;
        }
        return false;
      })
      .catch(function () { reseeding = false; return false; });
  }

  function notify() {
    try { if (window.ThaiEarNav && window.ThaiEarNav.refresh) window.ThaiEarNav.refresh(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('thaiear:auth', { detail: currentUser })); } catch (e) {}
  }

  // Read the user's own subscription row (RLS) and cache active/not, then re-notify
  // so cards/pages re-render once we know. Logged out → not subscribed.
  // Write the offline-licence markers read by player.js/nav.js canUseOffline: WHEN we last confirmed
  // the membership online + its real end date. Mirrors player.js stampVerified but lives here so it
  // fires on any page the moment auth confirms an active sub — including the index grid download path,
  // where player.js never loads. (current_period_end may be an ISO string or epoch s/ms.)
  /* P3 cleanup (r135): the owner entitlement simulator went with the test space. */
  function stampOfflineLicence() {
    try {
      localStorage.setItem('thaiear_lastVerified', String(Date.now()));
      var end = currentSub && currentSub.current_period_end;
      if (end != null && end !== '') {
        var t = (typeof end === 'number') ? (end < 1e12 ? end * 1000 : end) : Date.parse(end);
        if (t && !isNaN(t)) localStorage.setItem('thaiear_sub_until', String(t));
      }
    } catch (_) {}
  }
  function refreshSubscription() {
    if (!client || !currentUser) {
      currentSubscribed = false; currentSub = null; subFresh = false;
      // Drop only the cached subscription STATUS here (so the nav/account render logged-out). Do NOT
      // clear the premium OFFLINE licence stamps (thaiear_lifetime/lastVerified/sub_until) on a bare
      // currentUser == null: supabase-js emits a null-session auth change when it can't refresh an
      // EXPIRED access token OFFLINE (~1h in — the JWT lifetime), which is NOT a real sign-out. Wiping
      // the stamps here locked a signed-in (even lifetime) member out of their downloads mid-flight.
      // A deliberate sign-out still scrubs them via signOut()'s forceLocal; a different account signing
      // in re-derives them online (stampOfflineLicence/refreshLifetime). See onAuthStateChange guard.
      try { localStorage.removeItem('thaiear_sub_cache'); } catch (_) {}
      notify(); return;
    }
    // Seed from the last KNOWN-GOOD cache for THIS user FIRST, so a premium member is recognised
    // instantly — including OFFLINE, where the live query below hangs ~8s then fails. Without this,
    // isSubscribed() was false offline and premium topic cards wrongly routed to subscribe.html
    // instead of opening (or showing the "you're offline" page). The live read confirms/corrects when
    // online. (Audio is still licence-gated by canUseOffline, so this is UX/routing only.)
    try {
      var cached = JSON.parse(localStorage.getItem('thaiear_sub_cache') || 'null');
      if (cached && cached.uid === currentUser.id && cached.sub) {
        currentSub = cached.sub;
        currentSubscribed = (cached.sub.status === 'active' || cached.sub.status === 'trialing');
      }
    } catch (_) {}
    notify(); // reflect the cached status immediately (cards/nav) before the live read returns
    client.from('subscriptions').select('status,cancel_at_period_end,current_period_end').maybeSingle()
      .then(function (res) {
        /* Only a CLEAN read may overwrite the cached seed. postgrest-js converts a failed fetch
           into a RESOLVED {data:null, error} — it does not reject — so offline this .then ran
           with data:null and blanked currentSubscribed to false, undoing the cache seed above
           and reading a paid-up member as unsubscribed. The .catch below never saw it. */
        if (res && res.error) return;
        subFresh = true; subFreshAt = Date.now();   // authoritative answer, whatever it says
        currentSub = (res && res.data) || null;
        var s = currentSub && currentSub.status;
        currentSubscribed = (s === 'active' || s === 'trialing');
        // Persist the last KNOWN-GOOD subscription (only on a clean read) so the account page can show
        // the real "Premium — active until …" status while OFFLINE (when the live query can't run).
        try { if (res && !res.error) localStorage.setItem('thaiear_sub_cache', JSON.stringify({ uid: currentUser.id, sub: currentSub })); } catch (_) {}
        // Stamp the offline-licence markers on EVERY page (not just when player.js is loaded) so a
        // member who downloads from the index grid — without ever opening a topic page — can still play
        // offline. player.js/nav.js's canUseOffline reads these. Only on a clean ONLINE read of an
        // active membership; offline failures (catch below) leave the existing stamps intact.
        if (res && !res.error && currentSubscribed) stampOfflineLicence();
      })
      .catch(function () { /* offline / failed → KEEP the cached seed above; don't blank to not-subscribed */ })
      .then(function () { notify(); refreshLifetime(); });
  }

  // Maintain the OFFLINE lifetime flag (thaiear_lifetime) used by player.js/nav.js to let true
  // "lifetime" members (£0-forever) keep downloaded premium audio with NO offline timeout. Kept
  // SEPARATE and error-tolerant from the core subscription query above, so it can never affect normal
  // subscription detection: if the `lifetime` column doesn't exist yet, or we're offline, we leave the
  // cached flag untouched. The flag is ONLY ever set when the server confirms lifetime AND active, and
  // ONLY when online — so a regular paying user can never be flagged, and a revoked member is cleared
  // the next time they connect. Offline, the last-known value persists (that's the whole point).
  function refreshLifetime() {
    /* Owner simulator: while ANY account state is simulated, stop maintaining the REAL lifetime
       flag — we are pretending to be a different account, so the real server answer must not be
       written back. Applies to EVERY simulated state, not just 'premium-nolife' (that narrower
       version was a bug): `thaiear_lifetime` short-circuits canUseOffline before any date
       arithmetic runs, so on a genuinely-lifetime device this re-granted full offline access a
       second after every page load — which is why "Expired" and the 31/41/51-day buttons appeared
       to do nothing. Overrides the SERVER's answer only; the expiry decision still runs for real. */
    if (!client || !currentUser || !navigator.onLine) return; // offline → keep whatever's cached
    client.from('subscriptions').select('lifetime,status').maybeSingle()
      .then(function (res) {
        if (!res || res.error) return;                        // column missing / query error → don't touch flag
        var d = res.data;
        var subbed = d && (d.status === 'active' || d.status === 'trialing');
        try {
          if (d && d.lifetime && subbed) localStorage.setItem('thaiear_lifetime', '1');
          else localStorage.removeItem('thaiear_lifetime');   // not lifetime (or not active) → clear
        } catch (_) {}
      })
      .catch(function () {});                                  // network/error → leave cached flag intact
  }

  /* ══ DESKTOP MP3 DOWNLOAD ENTITLEMENT (2026-08-07) ═══════════════════════════════════════════
     Answers two questions for the whole site: may I save MP3s to this computer, and may I grant
     that to other people. Both come from /api/desktop-dl, which re-derives them from the caller's
     JWT — this is a CACHE OF A SERVER ANSWER, never a decision made here.

     ⚠ NOT DERIVED FROM `lifetime`, AND NOT PERSISTED TO localStorage. Deliberately different from
     the offline-licence markers a few functions above. Those exist so a paid-up member keeps their
     downloads while offline; this one has no offline job at all — you cannot save a new MP3 without
     the clips anyway. Persisting it would create exactly the forgeable flag this feature was
     designed to avoid: a monk who loses access must lose the button, and a localStorage boolean
     anyone can set is not a permission. Unknown/offline reads as NO. */
  var dlAllowed = false, dlAdmin = false, dlChecked = false;
  function refreshDesktopDl() {
    if (!currentUser || !currentSession) { dlAllowed = false; dlAdmin = false; dlChecked = false; return; }
    var tok = currentSession.access_token;
    if (!tok || !navigator.onLine) return;
    fetch('/api/desktop-dl', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        // A failed/absent answer leaves the previous state alone rather than granting anything —
        // the initial state is already "no", so a first-load failure is a closed door, not an open one.
        if (!d) return;
        dlAllowed = !!d.canDownload; dlAdmin = !!d.isAdmin; dlChecked = true;
        notify();   // player.js re-checks on thaiear:auth and mounts the button then
      })
      .catch(function () {});
  }

  // Read the user's marketing-consent flag (profiles row), cache it, re-notify.
  function refreshProfile() {
    if (!client || !currentUser) { currentConsent = false; consentLoaded = false; return; }
    client.from('profiles').select('marketing_opt_in').maybeSingle()
      .then(function (res) { currentConsent = !!(res && res.data && res.data.marketing_opt_in); })
      .catch(function () { currentConsent = false; })
      .then(function () { consentLoaded = true; notify(); });
  }

  // ---- offline-first sync for progress + flags ---------------------------
  // Edits apply to a LOCAL cache immediately (so progress + flags work with NO connection) and write
  // through to Supabase; if the write can't happen (offline), it's queued and flushed on reconnect.
  // This is single-user data, so reconnect is simply last-write-wins (the device's local state wins).
  // All keys are uid-scoped in localStorage so a different sign-in never reads stale data.
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function uid() { return currentUser && currentUser.id; }

  function persistProgress() { if (uid()) lsSet('thaiear_progress', { uid: uid(), data: currentProgress }); }
  function loadPersistedProgress() { var c = lsGet('thaiear_progress'); return (c && c.uid === uid()) ? c.data : null; }
  function progressDirty() { return lsGet('thaiear_progress_dirty') === uid(); }
  function markProgressDirty() { if (uid()) lsSet('thaiear_progress_dirty', uid()); }
  function clearProgressDirty() { try { localStorage.removeItem('thaiear_progress_dirty'); } catch (_) {} }
  function flushProgress() {
    if (!client || !currentUser || !navigator.onLine || !progressDirty()) return;
    saveProgress().then(clearProgressDirty).catch(function () {});
  }

  function persistFlags() { if (uid()) lsSet('thaiear_flags', { uid: uid(), map: currentFlags }); }
  function loadPersistedFlags() { var c = lsGet('thaiear_flags'); return (c && c.uid === uid()) ? c.map : null; }
  function pendingFlags() { var c = lsGet('thaiear_flags_pending'); return (c && c.uid === uid()) ? c.ops : {}; }
  function setPendingFlags(ops) { if (uid()) lsSet('thaiear_flags_pending', { uid: uid(), ops: ops }); }
  function queueFlag(key, tk, num, nugget, flagged) { var o = pendingFlags(); o[key] = { tk: tk, num: num, nugget: nugget, flagged: flagged }; setPendingFlags(o); }
  function unqueueFlag(key) { var o = pendingFlags(); delete o[key]; setPendingFlags(o); }
  function pushFlag(key, tk, num, nugget, flagged) {
    if (!client || !currentUser) return;
    var op = flagged
      ? client.from('sentence_flags').upsert({ user_id: currentUser.id, topic_key: tk, num: num, sentence: nugget, created_at: new Date().toISOString() })
      : client.from('sentence_flags').delete().eq('user_id', currentUser.id).eq('topic_key', tk).eq('num', num);
    return op.then(function (res) { if (res && res.error) throw res.error; unqueueFlag(key); }).catch(function () {});
  }
  function flushFlags() {
    if (!client || !currentUser || !navigator.onLine) return;
    var ops = pendingFlags();
    Object.keys(ops).forEach(function (key) { var o = ops[key]; pushFlag(key, o.tk, o.num, o.nugget, o.flagged); });
  }
  // Overlay any unsynced local flag toggles on top of a freshly-fetched server map.
  function applyPendingFlags() {
    var ops = pendingFlags();
    Object.keys(ops).forEach(function (key) {
      var o = ops[key];
      if (o.flagged) currentFlags[key] = { topic_key: o.tk, num: o.num, sentence: o.nugget };
      else delete currentFlags[key];
    });
  }
  /* Flush queued writes whenever the connection returns.
     ⚠ plFlush() is declared further down (with the playlists API) — a hoisted function
     declaration, and this listener only runs on an event, so the ordering is safe. It matters
     more than the others: until the playlist outbox drains, playlists.authoritative() stays false
     and dlReconcileRefs() cannot reap ghost download claims. */
  window.addEventListener('online', function () { flushProgress(); flushFlags(); dpFlush(); plFlush(); });

  // ---- listening progress (own `progress` row, RLS) ----------------------
  // One jsonb row per user: { goal, topics:{ topicKey:count } }. Read on demand
  // (topic pages + the progress page), not on every page load. Read-modify-write
  // is fine here — a user only touches their own single row.
  // Offline, the WebView's fetch to Supabase hangs ~8s before rejecting, and navigator.onLine can't
  // be trusted to detect that (it reports "online" in airplane mode). So for read fetches we RACE the
  // server query against a short timer: if the server hasn't answered in OFFLINE_FALLBACK_MS, resolve
  // with the last-known LOCAL copy at once. The query keeps running in the background, so a slow-but-
  // online client still refreshes the cache for next time. localFn must set the *Loaded flag + cache.
  var OFFLINE_FALLBACK_MS = 1200;
  function raceLocal(query, localFn) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(localFn()); } }, OFFLINE_FALLBACK_MS);
      query.then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function () { if (!done) { done = true; clearTimeout(t); resolve(localFn()); } }
      );
    });
  }

  function fetchProgress() {
    if (!client || !currentUser) { currentProgress = { goal: 5, topics: {} }; progressLoaded = true; return Promise.resolve(currentProgress); }
    if (progressDirty()) {                       // unsynced local edits win — don't let the server clobber them
      var ld = loadPersistedProgress();
      if (ld) { currentProgress = ld; progressLoaded = true; flushProgress(); return Promise.resolve(currentProgress); }
    }
    var localProgress = function () {            // offline / slow → last-known local copy (or a fresh default)
      currentProgress = loadPersistedProgress() || { goal: 5, topics: {} };
      progressLoaded = true;
      return currentProgress;
    };
    var query = client.from('progress').select('goal,topics').maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var d = (res && res.data) || null;
        currentProgress = { goal: (d && d.goal) || 5, topics: (d && d.topics) || {} };
        progressLoaded = true; persistProgress();
        return currentProgress;
      });
    return raceLocal(query, localProgress);
  }
  function saveProgress() {
    if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
    var row = {
      user_id: currentUser.id,
      goal: currentProgress.goal,
      topics: currentProgress.topics,
      updated_at: new Date().toISOString()
    };
    return client.from('progress').upsert(row).then(function (res) {
      if (res && res.error) throw res.error;
      return currentProgress;
    });
  }
  // Ensure the cache is populated, run fn (which mutates currentProgress), update the LOCAL copy
  // immediately (optimistic), then write through. Offline → stays queued + flushed on reconnect.
  function mutateProgress(fn) {
    if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
    var ready = (progressLoaded && currentProgress) ? Promise.resolve(currentProgress) : fetchProgress();
    return ready.then(function () {
      fn(currentProgress);
      persistProgress(); markProgressDirty();
      // Optimistic: resolve IMMEDIATELY on the local cache so the button never hangs offline, then
      // write through in the BACKGROUND. If the write fails/offline, the dirty flag keeps it queued
      // and the 'online' event flushes it (flushProgress). Mirrors toggleFlag. (Previously this
      // AWAITED saveProgress(), so offline the button spun ~8s while the WebView's Supabase fetch
      // hung — and could even revert when navigator.onLine wrongly reported "online" in airplane mode.)
      saveProgress().then(clearProgressDirty).catch(function () {});
      return currentProgress;
    });
  }

  // ---- flagged sentences (own `sentence_flags` rows, RLS) ----------------
  // One row per flagged sentence; the sentence nugget is stored so the My-sentences
  // page is self-contained. Cached as a map keyed by "topicKey:num".
  function flagKey(tk, num) { return tk + ':' + num; }
  function fetchFlags() {
    if (!client || !currentUser) { currentFlags = {}; flagsLoaded = true; return Promise.resolve(currentFlags); }
    var localFlags = function () {                  // offline / slow → last-known local set
      currentFlags = loadPersistedFlags() || {};
      flagsLoaded = true;
      return currentFlags;
    };
    var query = client.from('sentence_flags').select('topic_key,num,sentence')
      .then(function (res) {
        if (res && res.error) throw res.error;
        var map = {};
        (res && res.data || []).forEach(function (r) { map[flagKey(r.topic_key, r.num)] = r; });
        currentFlags = map; flagsLoaded = true;
        applyPendingFlags();                        // overlay any unsynced local toggles, then push them
        persistFlags(); flushFlags();
        return currentFlags;
      });
    return raceLocal(query, localFlags);
  }

  // ---- Capacitor native OAuth (app only) ---------------------------------
  // In a web browser, Google sign-in is an ordinary page redirect. Inside the
  // Capacitor app that bounces out to an external browser and the session never
  // comes back. So when running NATIVELY we open Google in a system browser tab,
  // return via the com.thaiear.app:// deep link, and complete the session here in
  // the webview. All of this is gated by isNative(), so the website is unaffected.
  var NATIVE_REDIRECT = 'com.thaiear.app://auth-callback';
  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }
  function capPlugin(name) {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  }
  // App-only: Stripe checkout returns via checkout-return.html → the com.thaiear.app://checkout-return
  // deep link → here. Close the in-app browser, refresh membership, and land on the right page. The
  // webview never lost its session, so the user is still logged in (the broken bit was the return trip).
  function handleCheckoutReturn(url) {
    if (!url || url.indexOf('checkout-return') === -1) return;
    var Browser = capPlugin('Browser');
    try { if (Browser && Browser.close) Browser.close(); } catch (_) {}
    var status = 'success';
    try { status = (new URLSearchParams(url.split('?')[1] || '')).get('status') || 'success'; } catch (_) {}
    if (status === 'cancel') { try { window.location.href = '/subscribe.html'; } catch (_) {} return; }
    refreshSubscription();   // re-read the (now active) subscription, then show the success page
    try { window.location.href = '/account.html?sub=success'; } catch (_) {}
  }
  function nativeGoogleSignIn() {
    var Browser = capPlugin('Browser');
    client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: NATIVE_REDIRECT,
        skipBrowserRedirect: true, // don't navigate the webview; we open the tab ourselves
        queryParams: { prompt: 'select_account' }
      }
    }).then(function (res) {
      var url = res && res.data && res.data.url;
      if (!url) { console.warn('[native-auth] no OAuth url returned'); return; }
      if (Browser && Browser.open) Browser.open({ url: url });
      else window.location.href = url; // last-resort fallback
    }).catch(function (e) { console.error('[native-auth] sign-in failed', e); });
  }
  // The deep link returns from Google → Supabase → app. Handle BOTH Supabase
  // flows: implicit (tokens in the URL hash) and PKCE (?code= exchanged here).
  function handleAuthDeepLink(url) {
    if (!url || url.indexOf('auth-callback') === -1) return;
    var Browser = capPlugin('Browser');
    var close = function () { try { if (Browser && Browser.close) Browser.close(); } catch (_) {} };
    try {
      var hp = new URLSearchParams(url.split('#')[1] || '');
      var at = hp.get('access_token'), rt = hp.get('refresh_token');
      if (at && rt) {
        client.auth.setSession({ access_token: at, refresh_token: rt })
          .then(close).catch(function (e) { console.error('[native-auth] setSession', e); close(); });
        return;
      }
      var code = new URLSearchParams((url.split('?')[1] || '').split('#')[0]).get('code');
      if (code) {
        client.auth.exchangeCodeForSession(code)
          .then(close).catch(function (e) { console.error('[native-auth] exchangeCode', e); close(); });
        return;
      }
      console.warn('[native-auth] deep link had no token or code:', url);
    } catch (e) { console.error('[native-auth] deep link parse failed', e); }
  }

  // Public API. getUser() is synchronous; the rest are no-ops until the
  // Supabase client has loaded (avoids errors if a button is hit very early).
  window.ThaiEarAuth = {
    isReady: false,
    getUser: function () { return currentUser; },
    // The Supabase session JWT, for authorising premium-audio requests to /api/audio.
    // Synchronous + cached; null until the session resolves or when logged out.
    getAccessToken: function () { return currentSession ? currentSession.access_token : null; },
    // Synchronous + cached. False until the subscription row resolves (or when not subscribed).
    // The real gate is server-side (/api/audio); this just drives the unlocked/locked UX.
    isSubscribed: function () { return currentSubscribed; },
    // True only when a clean server read answered this session — see subFresh.
    isSubscriptionFresh: function () { return subFresh && (Date.now() - subFreshAt) < SUB_FRESH_TTL_MS; },
    getSubscription: function () { return currentSub; }, // {status, cancel_at_period_end, current_period_end}

    /* ── desktop MP3 download (see refreshDesktopDl) ────────────────────────────────────────
       Synchronous + cached, like isSubscribed(). False until the server answers, and false again
       the moment the user signs out. player.js calls this to decide whether the button exists at
       all; account.html calls isDesktopDlAdmin() to decide whether the granting panel exists. */
    canDesktopDownload: function () { return dlAllowed; },
    isDesktopDlAdmin: function () { return dlAdmin; },
    isDesktopDlChecked: function () { return dlChecked; },
    // Re-ask the server — used by the admin panel after it grants or revokes, so an admin who
    // changes their OWN access sees it take effect without a reload.
    refreshDesktopDl: function () { refreshDesktopDl(); },

    /* ══ THE ONE OFFLINE-ENTITLEMENT PREDICATE (added 2026-07-31) ═══════════════════════════════
       Both surfaces ask THIS. Previously player.js decided entitlement and playlists.html had no
       tier awareness at all — so its download path fetched locked clips, hit 401/402 and failed
       wholesale, while r31's content-based dlHasAll() then demanded those same clips forever.
       Keeping one copy is the point: the SAME rule fixed in one place and missed in the other is
       bug #7 (sentLocked vs entitledForPage) and §B4 (stampVerified's two call sites) — twice.
       It lives in auth.js because auth.js already owns all three licence markers
       (thaiear_lastVerified / thaiear_sub_until / thaiear_lifetime) and writes them via
       stampOfflineLicence(), and because EVERY surface loads auth.js while only the `?pl=` view
       loads player.js.

       ⚠⚠ MUST call this.isSubscribed() / this.isSubscriptionFresh() / this.getUser() — NEVER the
       module-private currentSubscribed / subFresh / currentUser. sim.js wraps ThaiEarAuth with
       Object.create(real) (sim.js:88), so ONLY property lookups can be overridden. Reading the
       closure variables directly would silently bypass the simulator and make every entitlement
       test (A/B/X/R/1.x/2.x) pass vacuously against the owner's real lifetime account — a failure
       that looks exactly like success. */
    canUseOffline: function (tier) {
      if (tier !== 'premium') return true;
      // Lifetime members never time out offline. auth.js only sets this flag when the server
      // confirms lifetime+active while online, so a regular paying user cannot reach it.
      try { if (localStorage.getItem('thaiear_lifetime') === '1') return true; } catch (_) {}
      /* ONE question decides everything: DID THE SERVER ANSWER US THIS SESSION? navigator.onLine
         reports online in airplane mode and isSubscribed() reads a cached flag — neither can be
         trusted. isSubscriptionFresh() is true only after a clean subscriptions read.
           answered + subscribed → grant, and stamp (an authoritative confirmation)
           answered + not        → deny outright; the server has spoken
           no answer             → fall through to the offline rules below */
      if (this.isSubscriptionFresh && this.isSubscriptionFresh()) {
        if (this.isSubscribed && this.isSubscribed()) {
          /* Stamp at most once a minute. This runs PER SENTENCE per render (sentLocked → here), so
             an unthrottled stamp meant dozens of localStorage writes — and dozens of trace lines —
             for a single playlist paint. Re-stamping a licence stamped seconds ago adds nothing.
             ⚠ THROTTLED ON AN IN-MEMORY CLOCK, NOT ON thaiear_lastVerified. The first attempt keyed
             off the persisted marker and did NOT WORK: while the owner simulator is armed
             stampOfflineLicence() returns early without writing, so the marker never advances and
             the throttle re-fires forever — 299 calls in one burst in the r42 trace, with a
             backdated "Last verified". A guard must never depend on a value the guarded call is
             free to skip writing. */
          if (Date.now() - lastStampAttempt > 60000) { lastStampAttempt = Date.now(); stampOfflineLicence(); }
          return true;
        }
        return false;
      }
      // Server did NOT answer. Trust the captured real period end first (correct billing: cancel =
      // access until period end); the grace window is only the fallback when none was captured.
      // Past both, deny — which surfaces as "Reconnect to keep listening", NOT the paywall,
      // because we are not claiming they lapsed, only that we can no longer vouch for them.
      var last = 0, until = 0;
      try {
        last = parseInt(localStorage.getItem('thaiear_lastVerified') || '0', 10);
        until = parseInt(localStorage.getItem('thaiear_sub_until') || '0', 10);
      } catch (_) {}
      if (until && Date.now() < until) return true;
      return !!last && (Date.now() - last) < OFFLINE_GRACE_MS;
    },

    /* Is THIS item locked for the current visitor? The one lock rule, shared by player.js's
       sentLocked() and playlists.html's dlGroup(). Pass {tier, prefix}.
       `opts.canStoreOffline` is the CALLER's storage-backend capability (player.js:
       OFFLINE||WEB_DL||DYN_WEB_DL; playlists.html: DL_OK). It is passed in rather than re-derived
       here so behaviour stays byte-identical to what each surface did before this consolidation. */
    lockedFor: function (item, opts) {
      var tier = (item && item.tier) || 'free';
      if (tier !== 'member' && tier !== 'premium') return false;
      if (tier === 'premium') return !this.canUseOffline('premium');
      // MEMBER = any signed-in user. A download of theirs stays open (nothing to expire).
      var pfx = item && item.prefix;
      if (opts && opts.canStoreOffline && pfx && hasOfflineEntry(pfx)) return false;
      if (!this.isReady) return false;          // auth still resolving → never lock a paying user
      return !(this.getUser && this.getUser());
    },
    // True inside the Capacitor app. Pages use this to HIDE any upgrade-to-premium / checkout CTA
    // (Google Play reader-app rule: no in-app purchase or steering to web payment). Web is unaffected.
    isNative: function () { return isNative(); },
    // Marketing-email consent (cached). setMarketingConsent upserts the profiles row.
    getMarketingConsent: function () { return currentConsent; },
    // Has the consent flag finished loading from the profiles row? Lets the account
    // UI hold off rendering until it knows, so it never flashes the wrong state.
    isMarketingConsentLoaded: function () { return consentLoaded; },
    setMarketingConsent: function (optIn) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var row = {
        user_id: currentUser.id,
        email: currentUser.email || null,
        marketing_opt_in: !!optIn,
        marketing_opt_in_at: optIn ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };
      return client.from('profiles').upsert(row).then(function (res) {
        if (res && res.error) throw res.error;
        currentConsent = !!optIn;
        // Best-effort sync to MailerLite. Pull a FRESH token from the client (the cached
        // session can be momentarily stale), and log the outcome so failures are visible in
        // the console rather than silently swallowed. Consent is already saved in Supabase
        // above, so we never fail the save if MailerLite is briefly unavailable.
        return client.auth.getSession().then(function (s) {
          var tok = s && s.data && s.data.session && s.data.session.access_token;
          if (!tok) { console.warn('[marketing] no access token — MailerLite sync skipped'); return true; }
          return fetch('/api/marketing', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
            body: JSON.stringify({ optIn: !!optIn })
          }).then(function (r) {
            return r.text().then(function (t) {
              if (r.ok) console.log('[marketing] MailerLite sync ok:', t);
              else console.warn('[marketing] MailerLite sync failed', r.status, t);
              return true;
            });
          }, function (e) { console.warn('[marketing] MailerLite sync error', e); return true; });
        });
      });
    },
    // ---- listening progress -------------------------------------------------
    // The bar goal steps (5,10,20,50,100) — the progress page reads this to build
    // the toggle so the values live in one place.
    progressGoalSteps: function () { return GOAL_STEPS.slice(); },
    // Synchronous, cached. getProgressData() is null until loadProgress() resolves.
    getProgressData: function () { return currentProgress; },
    isProgressLoaded: function () { return progressLoaded; },
    getProgressGoal: function () { return currentProgress ? currentProgress.goal : 5; },
    getTopicProgress: function (key) { return (currentProgress && currentProgress.topics[key]) || 0; },
    // Async. Resolves the cached row (fetching once); safe to call repeatedly.
    loadProgress: function () {
      if (progressLoaded && currentProgress) return Promise.resolve(currentProgress);
      return fetchProgress();
    },
    addProgress: function (key) {
      return mutateProgress(function (p) {
        var n = (p.topics[key] || 0) + 1;
        p.topics[key] = n;
        if (n > p.goal) p.goal = nextGoalFor(n); // auto-advance so the bar never overflows
      });
    },
    removeProgress: function (key) {
      return mutateProgress(function (p) {
        var n = Math.max(0, (p.topics[key] || 0) - 1);
        if (n === 0) delete p.topics[key]; else p.topics[key] = n;
      });
    },
    // Set the global goal. Never below the highest count (the bars can't overflow),
    // so a goal smaller than the current max is clamped up to the next valid step.
    setProgressGoal: function (goal) {
      return mutateProgress(function (p) {
        var floor = nextGoalFor(maxCount(p.topics));
        p.goal = Math.max(goal, floor);
      });
    },
    // Wipe all counts (the goal is left as-is). (Caller confirms first.)
    resetProgress: function () {
      return mutateProgress(function (p) { p.topics = {}; });
    },
    // ---- flagged sentences --------------------------------------------------
    loadFlags: function () {
      if (flagsLoaded && currentFlags) return Promise.resolve(currentFlags);
      return fetchFlags();
    },
    isFlagsLoaded: function () { return flagsLoaded; },
    isFlagged: function (tk, num) { return !!(currentFlags && currentFlags[flagKey(tk, num)]); },
    // All flagged records: [{ topic_key, num, sentence }, …]
    getFlags: function () {
      if (!currentFlags) return [];
      return Object.keys(currentFlags).map(function (k) { return currentFlags[k]; });
    },
    // Toggle a sentence flag. nugget = { num, preview, thai, english, gloss, cultural, audioPrefix }.
    // Resolves to the new state (true = now flagged, false = now unflagged).
    // Optimistic: toggle the LOCAL cache + persist immediately (works offline), queue the desired state,
    // and write through. Resolves to the new state right away; a failed/offline write is flushed later.
    toggleFlag: function (tk, nugget) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var num = nugget.num, key = flagKey(tk, num);
      var ready = (flagsLoaded && currentFlags) ? Promise.resolve() : fetchFlags();
      return ready.then(function () {
        var nowFlagged = !currentFlags[key];
        if (nowFlagged) currentFlags[key] = { topic_key: tk, num: num, sentence: nugget };
        else delete currentFlags[key];
        persistFlags();
        queueFlag(key, tk, num, nugget, nowFlagged);
        pushFlag(key, tk, num, nugget, nowFlagged); // write through (clears the queue entry on success)
        return nowFlagged;
      });
    },
    // Remove a flag by (topicKey, num) — used by the My-sentences page's remove button.
    removeFlag: function (tk, num) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var key = flagKey(tk, num);
      var ready = (flagsLoaded && currentFlags) ? Promise.resolve() : fetchFlags();
      return ready.then(function () {
        var nugget = (currentFlags[key] && currentFlags[key].sentence) || { num: num };
        delete currentFlags[key];
        persistFlags();
        queueFlag(key, tk, num, nugget, false);
        pushFlag(key, tk, num, nugget, false);
        return true;
      });
    },
    signInWithGoogle: function () {
      if (!client) { console.warn('ThaiEar auth still loading…'); return; }
      /* Safety net for the offline-logout case: if we still hold tokens for this device, restore
         the session from them rather than starting an OAuth round trip that cannot complete
         without a network. Costs one promise when it doesn't apply, and turns the reported
         "tapping sign in did nothing" into an actual sign-in the moment there IS a connection. */
      if (!currentUser && readIdentity()) {
        reseedSession().then(function (ok) {
          if (ok) return;                       // restored — onAuthStateChange re-renders
          if (!navigator.onLine) { alert('You’re offline. You’ll be signed back in automatically when you reconnect — your downloads keep working in the meantime.'); return; }
          startGoogleSignIn();
        });
        return;
      }
      startGoogleSignIn();
    },
    // Passwordless "magic link": Supabase emails a one-click sign-in link. Creating an
    // account and signing in are the same action (shouldCreateUser defaults true). The
    // returned session is picked up automatically when the link lands back on the site
    // (detectSessionInUrl), so onAuthStateChange logs them in — no extra handling here.
    // Returns the Supabase promise ({ data, error }) so the caller can show feedback.
    sendMagicLink: function (email) {
      if (!client) return Promise.reject(new Error('auth still loading'));
      return client.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + '/account.html' }
      });
    },
    signOut: function () {
      if (!client) return Promise.resolve();
      // Logout must work even with NO connection. Supabase's signOut() POSTs to /logout to revoke the
      // token (and even scope:'local' can make that network call), which hangs forever offline — and
      // navigator.onLine is unreliable in the webview (frequently reports "online" in airplane mode),
      // so we can't branch on it. Strategy: attempt a local sign-out but RACE it against a short timeout,
      // then ALWAYS finish with a guaranteed local teardown (wipe the cached Supabase session, reset the
      // cached state, and notify) so the UI logs out within ~1.5s no matter what the network does.
      var forceLocal = function () {
        try {
          for (var i = localStorage.length - 1; i >= 0; i--) {
            var k = localStorage.key(i);
            if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) localStorage.removeItem(k);
          }
        } catch (_) {}
        currentSession = null; currentUser = null;
        currentSubscribed = false; currentSub = null;
        dlAllowed = false; dlAdmin = false; dlChecked = false;   // desktop-dl: never survives a sign-out
        // Clear the premium OFFLINE licence stamps too, so a DIFFERENT account signing in on this
        // device can't reuse the previous user's verification to play their premium downloads offline.
        // (A real premium user re-stamps automatically next time they're online — see stampVerified.)
        try {
          localStorage.removeItem('thaiear_lifetime');
          localStorage.removeItem('thaiear_lastVerified');
          localStorage.removeItem('thaiear_sub_until');
        } catch (_) {}
        // Drop OUR durable identity too and raise the signed-out marker — this is the ONLY thing
        // that may log a user out now, so it has to be unambiguous. Without it the offline
        // fallback would faithfully sign them straight back in.
        clearIdentity();
        notify();   // re-render nav + account page as logged-out
      };
      var attempt = client.auth.signOut({ scope: 'local' }).catch(function () {});
      var timeout = new Promise(function (res) { setTimeout(res, 1500); });
      return Promise.race([attempt, timeout]).then(forceLocal);
    }
  };

  // ---- playlists (2026-07-27, DYNAMIC_PLAYER_PLAN.md → PLAYLISTS) -----------------------------
  // Free feature for ANY signed-in account (not premium-gated). Tables playlists/playlist_items
  // (top-level playlists_schema.sql, RLS on user_id). Items carry a display nugget
  // (thai/translit/english) + prefix/tier so playlist pages render and build audio without
  // loading topic pages. Cached in localStorage (thaiear_playlists) for offline reads.
  // All methods are additive and guarded — if the tables don't exist yet, load() degrades to
  // the local cache and the UI just shows what it has.
  var plCache = null;
  /* r76 — MUTATION SEQUENCE GUARD. `load()` ends in a wholesale `plCache = lists`, and it is a
     TWO-step fetch (playlists, then items), so it holds a stale snapshot across a wide window.
     playlists.html fires `load(true)` on EVERY `thaiear:auth` event, including TOKEN_REFRESHED,
     which arrives on its own schedule. A local mutation landing inside that window was therefore
     overwritten by the older server copy — the user created a playlist, saw it appear, then saw it
     vanish, assumed the save had failed, created it again, and ended up with a real duplicate.
     (Owner, 2026-08-01: "on about two occasions of about 20 trials"; the rate is just how often a
     token refresh overlaps a create.)
     Every mutating method bumps plSeq. load() captures it at the start and, if it has moved by the
     time the response lands, DISCARDS the response rather than overwriting a newer local state.
     The cost is a slightly staler read until the next load; the alternative is silently destroying
     a write the user just made. This protects create/remove/rename/addItem/removeItem alike — they
     were all exposed to the same overwrite, not just create. */
  var plSeq = 0;
  /* Was the value the LAST resolved load() handed back an authoritative server read?
     ⚠ LOAD-BEARING: dlReconcileRefs() frees download claims for playlists that "no longer exist",
     and its contract says it may only ever see an authoritative list — reconciling against a
     cache-only or failed load could read "no playlists" and free clips that are legitimately
     claimed. But load() CATCHES INTERNALLY AND RESOLVES with plLocal(), so a failed load already
     looked identical to a good one at the call site (pre-existing; the sequence guard adds a
     second such path). Callers that act destructively on the result MUST check this first. */
  var plLoadAuth = false;
  function plStore() { try { localStorage.setItem('thaiear_playlists', JSON.stringify(plCache)); } catch (_) {} }
  function plLocal() { try { return JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) { return null; } }

  /* ══ OFFLINE WRITE OUTBOX (2026-08-09, OFFLINE_PLAYLISTS_PLAN.md Part A) ═════════════════════
     Every playlist mutation used to POST and reject with no connection, so nothing a user did
     offline survived — you could flag a sentence on a plane but not add it to a playlist. This is
     the flags outbox (pendingFlags/pushFlag/flushFlags/applyPendingFlags above) generalised to
     four operation types, and it is keyed by uid() for the same non-negotiable reason: a queued
     write must never leak into whichever account signs in next.

     ⚠ IDS ARE MINTED CLIENT-SIDE AND ARE FINAL FROM BIRTH. `playlists.id` is a plain uuid primary
     key and RLS only checks user_id, so an explicit id is allowed. DO NOT "simplify" this into a
     temporary id that gets replaced by a server id on reconnect: a playlist id is not just a
     database key, it is a NAMESPACE across four local stores —
        · manifest download claims   refs: ['pl-<id>']        (pl-list.js dlReconcileRefs)
        · download records           dlPlMap()[<id>]
        · built session metadata     te_dyn_meta_pl-<id>_<mode>
        · the stitched audio itself  /dyn/pl-<id>/<mode>.(wav|m4a|ogg)
     — and the code that walks them is the one function on this project that can DELETE the user's
     downloaded audio. Remapping an id means rewriting all four. Minting the real UUID up front
     means nothing is ever remapped.

     SHAPE — a collapsed two-tier outbox, not a raw op log. Playlists have ordering constraints
     (a list must exist before its items) but the ops still COLLAPSE, exactly like flags:
        lists:   { <listId>: {op:'create'|'delete', name, position, at} }
        renames: { <listId>: name }
        items:   { '<listId>:<topicKey>:<num>': {op:'add'|'remove', listId, tk, num, payload, at} }
     Toggling an item on/off/on collapses to ONE entry. A list created AND deleted while offline
     collapses to nothing sent at all. Flush order per round: creates → renames → items → deletes,
     and every push is idempotent (upsert / delete) so an interrupted flush is safely re-runnable. */
  var PL_PEND_KEY = 'thaiear_pl_pending';
  var PL_PEND_MAX_AGE = 30 * 24 * 3600 * 1000;   // see plPendPrune()
  function plPendGet() {
    var c = lsGet(PL_PEND_KEY);
    var o = (c && c.uid === uid())
      ? { lists: c.lists || {}, renames: c.renames || {}, items: c.items || {} }
      : { lists: {}, renames: {}, items: {} };
    return plPendPrune(o);
  }
  function plPendSet(o) { if (uid()) lsSet(PL_PEND_KEY, { uid: uid(), lists: o.lists, renames: o.renames, items: o.items }); }
  function plPendEmpty(o) {
    o = o || plPendGet();
    return !Object.keys(o.lists).length && !Object.keys(o.renames).length && !Object.keys(o.items).length;
  }
  /* AGE CAP — the release valve for anything plOpFatal() fails to recognise. An op that can never
     succeed but is not classified fatal would sit in the outbox forever, and because
     authoritative() is gated on the outbox being empty (see below) that would permanently disable
     dlReconcileRefs — the garbage collector for downloads. The device would quietly stop
     reclaiming space, with no symptom until it is full. Unknown errors stay TRANSIENT on purpose
     (discarding a user's write on an unclassified blip is worse than a delayed reap), so this cap
     is what guarantees the outbox always drains eventually. */
  function plPendPrune(o) {
    var now = Date.now(), changed = false;
    ['lists', 'items'].forEach(function (bucket) {
      Object.keys(o[bucket]).forEach(function (k) {
        var e = o[bucket][k];
        if (e && e.at && (now - e.at) > PL_PEND_MAX_AGE) {
          delete o[bucket][k]; changed = true;
          console.warn('[pl] dropped a queued playlist op older than 30 days (' + bucket + ' ' + k + ')');
        }
      });
    });
    if (changed) plPendSet(o);
    return o;
  }
  function plItemKey(listId, tk, num) { return listId + ':' + tk + ':' + num; }
  /* crypto.randomUUID() needs a secure context AND Safari 15.4+ — the app and thaiear.com are both
     https, but an older iPhone still on 15.0 would otherwise throw here and take create() with it.
     getRandomValues() is available far further back; the version/variant bits are set by hand so
     the result is a well-formed v4 and Postgres accepts it as a uuid. */
  function plUuidFallback() {
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [], i;
    for (i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
           '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }
  /* Can this error EVER succeed on a retry? Only a known-semantic failure is dropped; everything
     else — fetch failure, 5xx, 429, timeout, an expired token (401 recovers after a refresh), a
     missing table mid-migration — stays queued. Direction chosen deliberately: unknown → retry,
     because losing a user's write is worse than a late reap, and the age cap catches the rest. */
  function plOpFatal(e) {
    if (!e) return false;
    var code = String(e.code || '');
    // 23503 FK violation (the playlist was deleted on another device — the canonical case),
    // 23505 unique violation, 42501 insufficient privilege / RLS refusal.
    if (code === '23503' || code === '23505' || code === '42501') return true;
    var st = e.status || (e.originalError && e.originalError.status) || 0;
    return st === 403 || st === 404 || st === 409;
  }
  function plUnqueue(bucket, key) {
    var o = plPendGet();
    if (o[bucket] && o[bucket][key] !== undefined) { delete o[bucket][key]; plPendSet(o); }
  }
  // Forget every queued op belonging to a list — used when a create+delete pair collapses, and
  // when a create is dropped as unsyncable (its items could only ever FK-fail after it).
  function plPendPurgeList(id, o) {
    var own = !o; o = o || plPendGet();
    delete o.lists[id]; delete o.renames[id];
    Object.keys(o.items).forEach(function (k) { if (o.items[k].listId === id) delete o.items[k]; });
    if (own) plPendSet(o);
    return o;
  }
  function plQueueCreate(id, name, position) {
    var o = plPendGet();
    o.lists[id] = { op: 'create', name: name, position: position || 0, at: Date.now() };
    plPendSet(o);
  }
  function plQueueDelete(id) {
    var o = plPendGet();
    // Created AND deleted while offline → nothing ever reaches the server.
    if (o.lists[id] && o.lists[id].op === 'create') { plPendPurgeList(id, o); plPendSet(o); return; }
    plPendPurgeList(id, o);                                  // its item ops are moot now
    o.lists[id] = { op: 'delete', at: Date.now() };
    plPendSet(o);
  }
  function plQueueRename(id, name) {
    var o = plPendGet();
    // A list that has not been created on the server yet is renamed in place, not separately.
    if (o.lists[id] && o.lists[id].op === 'create') o.lists[id].name = name;
    else o.renames[id] = name;
    plPendSet(o);
  }
  function plQueueItem(op, listId, tk, num, payload) {
    var o = plPendGet();
    o.items[plItemKey(listId, tk, num)] = { op: op, listId: listId, tk: tk, num: num, payload: payload || null, at: Date.now() };
    plPendSet(o);
  }

  /* The raw server calls, factored out so the immediate attempt and the replay share ONE
     implementation (in particular the plNotes fallback below, which must not be duplicated). */
  function plChk(r) { if (r && r.error) throw r.error; return r; }
  function plPushCreate(rec) {
    return client.from('playlists')
      .upsert({ id: rec.id, user_id: currentUser.id, name: rec.name, position: rec.position || 0 })
      .then(plChk);
  }
  function plPushRename(id, name) {
    return client.from('playlists').update({ name: name }).eq('id', id).then(plChk);
  }
  function plPushDelete(id) {
    return client.from('playlists').delete().eq('id', id).then(plChk);
  }
  function plPushItemAdd(row) {
    var conflict = { onConflict: 'playlist_id,topic_key,num' };
    var send = {};
    Object.keys(row).forEach(function (k) { send[k] = row[k]; });
    if (!plNotes) { delete send.gloss; delete send.cultural; }
    return client.from('playlist_items').upsert(send, conflict)
      .then(function (r) {
        // r145: the notes columns may not exist yet — demote once and retry without them.
        if (r.error && plNotes && plSchemaErr(r.error)) {
          plNotes = false;
          delete send.gloss; delete send.cultural;
          return client.from('playlist_items').upsert(send, conflict);
        }
        return r;
      })
      .then(plChk);
  }
  function plPushItemRemove(listId, tk, num) {
    return client.from('playlist_items').delete()
      .eq('playlist_id', listId).eq('topic_key', tk).eq('num', num).then(plChk);
  }
  /* One attempt at one queued op. Resolves either way — the caller is a fire-and-forget write
     path, never a place to surface an exception. Returns true if the op left the outbox. */
  function plRunOp(bucket, key, fn, onFatal) {
    if (!client || !currentUser) return Promise.resolve(false);
    return fn()
      .then(function () { plUnqueue(bucket, key); return true; })
      .catch(function (e) {
        if (!plOpFatal(e)) return false;                     // transient — stays queued, retried later
        /* SILENT BY DESIGN (owner, 2026-08-09): a console line and nothing else. The op that gets
           dropped is nearly always one whose intent is already moot — you deleted the playlist on
           another device, so "add a sentence to it" no longer means anything — and a dialog saying
           "1 offline change couldn't be saved" invites worry about a deliberate action. */
        console.warn('[pl] dropped an unsyncable queued op (' + bucket + ' ' + key + '):', e && (e.code || e.message));
        plUnqueue(bucket, key);
        if (onFatal) onFatal();
        return true;
      });
  }
  var plFlushing = null;
  /* Replay the outbox in dependency order: creates → renames → items → deletes. Sequential, not
     parallel — a list has to exist before its items can reference it. Re-entrant-safe (the online
     event and a thaiear:auth event routinely arrive together). */
  function plFlush() {
    if (!client || !currentUser || !navigator.onLine) return Promise.resolve();
    if (plFlushing) return plFlushing;
    var o = plPendGet();
    if (plPendEmpty(o)) return Promise.resolve();
    var chain = Promise.resolve(), blocked = {};
    Object.keys(o.lists).forEach(function (id) {
      if (o.lists[id].op !== 'create') return;
      chain = chain.then(function () {
        var rec = { id: id, name: o.lists[id].name, position: o.lists[id].position }, fatal = false;
        return plRunOp('lists', id, function () { return plPushCreate(rec); },
          function () { fatal = true; plPendPurgeList(id); })   // fatal create → its items can never land
          /* Block on EITHER outcome. Not-left = transient, retry next round. Fatal = the items were
             just purged from storage, but this chain still holds their closures from the snapshot
             taken at the top of plFlush(), so without this they would be attempted anyway. */
          .then(function (left) { if (!left || fatal) blocked[id] = true; });
      });
    });
    Object.keys(o.renames).forEach(function (id) {
      chain = chain.then(function () {
        if (blocked[id]) return false;
        return plRunOp('renames', id, function () { return plPushRename(id, o.renames[id]); });
      });
    });
    Object.keys(o.items).forEach(function (k) {
      var it = o.items[k];
      chain = chain.then(function () {
        /* ⚠ SKIP, DO NOT ATTEMPT, items whose parent create is still queued. A create that failed
           transiently leaves the list absent server-side, so its items would FK-fail — and an FK
           violation is classified FATAL, so attempting them here would silently DELETE the user's
           queued additions on a passing network blip. */
        if (blocked[it.listId]) return false;
        // A malformed 'add' with no payload could only come from a hand-edited or truncated
        // localStorage record; drop it rather than push `undefined` at PostgREST.
        if (it.op === 'add' && !it.payload) { plUnqueue('items', k); return true; }
        return plRunOp('items', k, function () {
          return it.op === 'add' ? plPushItemAdd(it.payload) : plPushItemRemove(it.listId, it.tk, it.num);
        });
      });
    });
    Object.keys(o.lists).forEach(function (id) {
      if (o.lists[id].op !== 'delete') return;
      chain = chain.then(function () { return plRunOp('lists', id, function () { return plPushDelete(id); }); });
    });
    plFlushing = chain.then(function () { plFlushing = null; }, function () { plFlushing = null; });
    return plFlushing;
  }
  /* Overlay unsynced local ops on top of a freshly-fetched server list — the exact role
     applyPendingFlags() plays for flags. Without it a server read that predates the flush would
     silently undo whatever the user just did offline. Mutates and returns `lists`. */
  function applyPendingPlaylistOps(lists) {
    var o = plPendGet();
    if (plPendEmpty(o)) return lists;
    var by = {};
    lists.forEach(function (p) { by[p.id] = p; });
    Object.keys(o.lists).forEach(function (id) {
      var e = o.lists[id];
      if (e.op === 'create' && !by[id]) {
        var p = { id: id, name: e.name, position: e.position || lists.length, items: [] };
        lists.push(p); by[id] = p;
      } else if (e.op === 'delete' && by[id]) {
        lists.splice(lists.indexOf(by[id]), 1); delete by[id];
      }
    });
    Object.keys(o.renames).forEach(function (id) { if (by[id]) by[id].name = o.renames[id]; });
    Object.keys(o.items).forEach(function (k) {
      var it = o.items[k], p = by[it.listId];
      if (!p) return;
      p.items = p.items || [];
      var at = -1, i;
      for (i = 0; i < p.items.length; i++) {
        if (p.items[i].topic_key === it.tk && p.items[i].num === it.num) { at = i; break; }
      }
      if (it.op === 'add') { if (at < 0 && it.payload) p.items.push(it.payload); }
      else if (at >= 0) p.items.splice(at, 1);
    });
    return lists;
  }

  /* ── r145: the notes columns (gloss jsonb, cultural text) — see playlists_gloss_migration.sql ──
     The nugget gained two fields so the playlist player can open a card to its third stage (gloss
     chips + cultural note) exactly like a topic page. They are ADDITIVE and the deploy is not
     ordered against the migration: if this JS reaches a browser before the SQL has been run,
     PostgREST answers a select/insert naming an unknown column with a hard error, which would
     empty every playlist read and break every "add to playlist" write.
     So the first schema error demotes this flag once, for the session, and the call is retried
     without the two fields — old behaviour, no notes, nothing broken. Once the columns exist the
     flag never trips and the retry never runs. Do NOT "simplify" this away before confirming the
     migration has run on production; it is the only thing making the two deploys order-free. */
  var plNotes = true;
  var PL_COLS = 'id,playlist_id,topic_key,num,prefix,tier,thai,translit,english,position';
  // PGRST204 = "column not found in schema cache"; the message text catches the 42703 variants.
  function plSchemaErr(e) {
    if (!e) return false;
    if (e.code === 'PGRST204' || e.code === '42703') return true;
    return /gloss|cultural/.test(String(e.message || '')) && /column|schema/i.test(String(e.message || ''));
  }
  function plItemsQuery(c) {
    var sel = PL_COLS + (plNotes ? ',gloss,cultural' : '');
    return c.from('playlist_items').select(sel).order('position').order('created_at')
      .then(function (r) {
        if (r.error && plNotes && plSchemaErr(r.error)) {
          plNotes = false;
          return c.from('playlist_items').select(PL_COLS).order('position').order('created_at');
        }
        return r;
      });
  }
  window.ThaiEarAuth.playlists = {
    // Resolves [{id, name, position, items:[{topic_key,num,prefix,tier,thai,translit,english,
    //                                        gloss,cultural}]}]   (r145 added the last two)
    load: function (force) {
      if (plCache && !force) { plLoadAuth = false; return Promise.resolve(plCache); }
      if (!client || !currentUser) { plCache = plLocal() || []; plLoadAuth = false; return Promise.resolve(plCache); }
      var seq = plSeq;   // r76: anything that mutates locally while this is in flight wins
      return client.from('playlists').select('id,name,position').order('position').order('created_at')
        .then(function (r) {
          if (r.error) throw r.error;
          var lists = r.data || [];
          if (plSeq !== seq) { plLoadAuth = false; return plCache; }
          if (!lists.length) { plCache = []; plStore(); plLoadAuth = true; return plCache; }
          return plItemsQuery(client)
            .then(function (ri) {
              if (ri.error) throw ri.error;
              /* Re-check: the items fetch is the SECOND round trip, and it is the wider half of the
                 window. Without this the guard would only cover the first query. */
              if (plSeq !== seq) { plLoadAuth = false; return plCache; }
              var by = {};
              lists.forEach(function (p) { p.items = []; by[p.id] = p; });
              (ri.data || []).forEach(function (it) { if (by[it.playlist_id]) by[it.playlist_id].items.push(it); });
              applyPendingPlaylistOps(lists);   // unsynced offline ops win over the server copy
              plCache = lists; plStore(); plLoadAuth = true; plFlush(); return plCache;
            });
        })
        .catch(function () { plCache = plLocal() || []; plLoadAuth = false; return plCache; });
    },
    /* True only if the last resolved load() was a real server read that was not superseded by a
       local mutation. Check this before any destructive action derived from the list.
       ⚠ ALSO FALSE WHILE THE OUTBOX IS NON-EMPTY (2026-08-09). dlReconcileRefs() frees download
       claims for playlists that "no longer exist" — and a playlist created offline does not exist
       on the server until the outbox flushes. The reconnect race is real: pl-list.js fires
       load(true) from thaiear:auth/pageshow, which can easily beat the flush, and the reconciler
       would then read a brand-new playlist as a ghost and delete its downloaded audio. Never
       reconcile against a read we already know is incomplete. */
    authoritative: function () {
      /* ⚠ Evaluated BEFORE the && on purpose — do not fold this back into one expression.
         plPendEmpty() → plPendGet() → plPendPrune() is what applies the 30-day age cap, and
         short-circuiting on a false plLoadAuth would skip it exactly when the outbox is most
         likely to be holding something stuck. */
      var outboxClear = plPendEmpty();
      return plLoadAuth && outboxClear;
    },
    get: function () { return plCache; },
    // Read-only view of the localStorage copy — safe to call BEFORE the client/auth resolve
    // and never touches plCache (playlists.html uses it for an instant cache-first paint).
    peek: function () { return plLocal(); },
    /* ── The four mutations, all offline-capable since 2026-08-09 ────────────────────────────
       Uniform shape, taken from pushFlag(): apply to plCache OPTIMISTICALLY, bump plSeq, queue the
       op, then attempt one push that unqueues on success. There is deliberately NO branch on
       navigator.onLine — it reports *online* in airplane mode in this WebView (documented all over
       player.js), so only a failed attempt proves anything. Offline the attempt simply fails and
       the op stays queued for the next `online` event.
       They therefore RESOLVE rather than reject on a lost connection; that is the point. A genuine
       server refusal still drops the op (plOpFatal) and the local copy self-corrects on the next
       authoritative load. */
    create: function (name) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      // ⚠ Client-minted and FINAL — never remapped later. See the outbox header for why.
      var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : plUuidFallback();
      var p = { id: id, name: name, position: (plCache || []).length, items: [] };
      plSeq++;   /* r76: this write must survive any load() already in flight */
      (plCache = plCache || []).push(p); plStore();
      plQueueCreate(id, name, p.position);
      return plRunOp('lists', id, function () { return plPushCreate(p); },
        function () {   // unsyncable → undo the optimistic insert rather than show a ghost list
          plPendPurgeList(id);
          if (plCache) { plCache = plCache.filter(function (x) { return x.id !== id; }); plStore(); }
        })
        .then(function () { return p; });   // resolves with the row either way — the id is already real
    },
    remove: function (id) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      plSeq++;   /* r76 */
      if (plCache) { plCache = plCache.filter(function (p) { return p.id !== id; }); plStore(); }
      var o = plPendGet();
      var neverExisted = !!(o.lists[id] && o.lists[id].op === 'create');
      plQueueDelete(id);
      // Created and deleted before it ever reached the server — nothing to push.
      if (neverExisted) return Promise.resolve();
      return plRunOp('lists', id, function () { return plPushDelete(id); }).then(function () {});
    },
    // Metadata only — touches no prefix, claim or manifest, so it can never affect a download.
    rename: function (id, name) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      plSeq++;   /* r76 */
      if (plCache) {
        plCache.forEach(function (p) { if (p.id === id) p.name = name; });
        plStore();
      }
      plQueueRename(id, name);
      var o = plPendGet();
      // Still queued as a create → the new name travels with it; nothing separate to push.
      if (o.lists[id] && o.lists[id].op === 'create') return Promise.resolve();
      return plRunOp('renames', id, function () { return plPushRename(id, name); }).then(function () {});
    },
    addItem: function (id, item) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      var p = (plCache || []).filter(function (x) { return x.id === id; })[0];
      var row = {
        playlist_id: id, topic_key: item.topic_key, num: item.num,
        prefix: item.prefix, tier: item.tier || 'free',
        thai: item.thai, translit: item.translit || null, english: item.english,
        position: p ? p.items.length : 0
      };
      // r145: the notes travel with the nugget (see plNotes above for why this is conditional).
      // Always carried in the QUEUED payload; plPushItemAdd() strips them if the columns are absent.
      row.gloss = item.gloss || null; row.cultural = item.cultural || null;
      plSeq++;   /* r76 */
      if (p && !p.items.some(function (i) { return i.topic_key === row.topic_key && i.num === row.num; })) {
        p.items.push(row); plStore();
      }
      plQueueItem('add', id, row.topic_key, row.num, row);
      return plRunOp('items', plItemKey(id, row.topic_key, row.num),
        function () { return plPushItemAdd(row); }).then(function () {});
    },
    removeItem: function (id, topicKey, num) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      plSeq++;   /* r76 */
      var p = (plCache || []).filter(function (x) { return x.id === id; })[0];
      if (p) { p.items = p.items.filter(function (i) { return !(i.topic_key === topicKey && i.num === num); }); plStore(); }
      var key = plItemKey(id, topicKey, num);
      var o = plPendGet();
      // Added and removed before either reached the server — the pair cancels.
      if (o.items[key] && o.items[key].op === 'add') { delete o.items[key]; plPendSet(o); return Promise.resolve(); }
      plQueueItem('remove', id, topicKey, num, null);
      return plRunOp('items', key, function () { return plPushItemRemove(id, topicKey, num); }).then(function () {});
    },
    // Which playlists contain this sentence? (from cache — call load() first)
    idsFor: function (topicKey, num) {
      return (plCache || []).filter(function (p) {
        return p.items.some(function (i) { return i.topic_key === topicKey && i.num === num; });
      }).map(function (p) { return p.id; });
    }
  };

  // ── Dynamic-player settings sync (public.dyn_prefs — see dyn_prefs_schema.sql) ──
  // One row per user per scope: 'global' = {pf, rp, en}; '<dynKey>' = {excl:[nums]}.
  // Additive and guarded exactly like the playlists API: signed-out or missing table →
  // degrade to the localStorage mirror ('thaiear_dyn_prefs', keyed by scope).
  var dpCache = null;   // { scope: dataObj }
  function dpStore() { try { localStorage.setItem('thaiear_dyn_prefs', JSON.stringify(dpCache)); } catch (_) {} }
  function dpLocal() { try { return JSON.parse(localStorage.getItem('thaiear_dyn_prefs') || 'null'); } catch (_) { return null; } }
  /* A settings change made OFFLINE used to be written locally, attempted, and the failure
     swallowed — so it never reached the server and no other device ever saw it. Nothing
     re-sent it either. Scopes whose upsert failed are now remembered and flushed when the
     connection (or auth) comes back.
     Only ever marked while a user IS signed in: pushing a signed-out device's local settings
     into whatever account signs in next would overwrite that account's real settings. */
  function dpPending() { try { return JSON.parse(localStorage.getItem('thaiear_dyn_prefs_dirty') || '{}'); } catch (_) { return {}; } }
  function dpSetPending(m) { try { localStorage.setItem('thaiear_dyn_prefs_dirty', JSON.stringify(m)); } catch (_) {} }
  function dpMarkDirty(scope) { var m = dpPending(); m[scope] = 1; dpSetPending(m); }
  function dpClearDirty(scope) { var m = dpPending(); delete m[scope]; dpSetPending(m); }
  function dpFlush() {
    if (!client || !currentUser) return Promise.resolve();
    var m = dpPending(), scopes = Object.keys(m);
    if (!scopes.length) return Promise.resolve();
    var cache = dpCache || dpLocal() || {};
    var chain = Promise.resolve();
    scopes.forEach(function (scope) {
      var data = cache[scope];
      if (data === undefined) { dpClearDirty(scope); return; }   // nothing local to send
      chain = chain.then(function () {
        return client.from('dyn_prefs')
          .upsert({ user_id: currentUser.id, scope: scope, data: data, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,scope' })
          .then(function (r) { if (r.error) throw r.error; dpClearDirty(scope); })
          .catch(function () {});                                 // still offline — keep it pending
      });
    });
    return chain;
  }
  window.ThaiEarAuth.dynPrefs = {
    // Resolves { scope: data } for every row the user has.
    load: function (force) {
      if (dpCache && !force) return Promise.resolve(dpCache);
      if (!client || !currentUser) { dpCache = dpLocal() || {}; return Promise.resolve(dpCache); }
      return client.from('dyn_prefs').select('scope,data')
        .then(function (r) {
          if (r.error) throw r.error;
          var map = {};
          (r.data || []).forEach(function (row) { if (row && row.scope) map[row.scope] = row.data || {}; });
          dpCache = map; dpStore();
          return dpCache;
        })
        .catch(function () { dpCache = dpLocal() || {}; return dpCache; });
    },
    get: function (scope) { return dpCache ? dpCache[scope] : null; },
    // Read-only localStorage view — safe before the client/auth resolve; never touches dpCache.
    peek: function () { return dpLocal(); },
    // Optimistic: cache + mirror written synchronously; the upsert follows (and is swallowed
    // on failure — the local copy still holds the value, like the playlists degrade path).
    set: function (scope, data) {
      dpCache = dpCache || dpLocal() || {};
      dpCache[scope] = data;
      dpStore();
      if (!client || !currentUser) return Promise.resolve();      // signed out → local only, as before
      return client.from('dyn_prefs')
        .upsert({ user_id: currentUser.id, scope: scope, data: data, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,scope' })
        .then(function (r) { if (r.error) throw r.error; dpClearDirty(scope); })
        .catch(function () { dpMarkDirty(scope); });               // retried on reconnect
    },
    // Retry anything that failed while offline. Safe to call at any time.
    flush: function () { return dpFlush(); }
  };

  import(SUPABASE_ESM)
    .then(function (mod) {
      client = mod.createClient(SUPABASE_URL, SUPABASE_KEY);
      // getSession() fires a network token-refresh when the access token is expired, which hangs
      // ~8s offline (and navigator.onLine can't detect that in the WebView). Race it against a short
      // timer that restores the session from localStorage, so the app becomes ready fast offline.
      // Any later refresh / sign-in change still propagates via onAuthStateChange below.
      var gs = client.auth.getSession().then(
        function (res) { return (res && res.data && res.data.session) || null; },
        function () { return readStoredSession() || readIdentity(); }   // ours survives a purge
      );
      var timer = new Promise(function (resolve) {
        setTimeout(function () { resolve(readStoredSession() || readIdentity()); }, OFFLINE_FALLBACK_MS);
      });
      return Promise.race([gs, timer]);
    })
    .then(function (session) {
      // Offline (or supabase already purged its copy): fall back to OUR durable identity, so a
      // long spell without a network can never present as logged out. userFromSession reads
      // .user, which both shapes carry.
      // restoredFromIdentity is load-bearing, not bookkeeping: when we restore this way SUPABASE
      // still has no session, but our record carries an access_token — so a "do we have a token?"
      // test looks satisfied while getAccessToken() is handing /api/audio a STALE one. Gated audio
      // would then 401 on a page that looks perfectly signed in. Track it explicitly and re-seed.
      if (!session || !session.user) {
        var restored = readIdentity();
        if (restored) { session = restored; restoredFromIdentity = true; }
      }
      currentSession = session || null;
      currentUser = userFromSession(currentSession);
      if (currentSession && currentSession.access_token) writeIdentity(currentSession);
      window.ThaiEarAuth.isReady = true;
      notify();
      refreshSubscription(); // async; fires another notify when it resolves
      refreshProfile();      // marketing-consent flag
      refreshDesktopDl();    // desktop MP3 download entitlement (server-derived, not cached to disk)
      dpFlush();             // push any dyn settings changed while offline
      // keep in sync on login / logout / token refresh
      client.auth.onAuthStateChange(function (_event, session) {
        var user = userFromSession(session);
        // Offline, supabase-js can't refresh an expired access token, so ~1h in it fires a null-session
        // change even though the user never signed out. If the persisted session is STILL on disk this
        // is that transient blip — keep the current user (so downloads + offline licence survive and the
        // nav doesn't flip to logged-out). A real signOut() purges the stored session (forceLocal), so
        // readStoredSession() returns null there and we fall through to genuine logout handling.
        // Was readStoredSession() alone — the supabase-owned key, which supabase DELETES when a
        // refresh fails on an already-expired token (see DURABLE OFFLINE IDENTITY above). Once
        // that happened the guard could not fire and the user was logged out for good. anySignedIn()
        // consults our own record first, so only a real signOut() (which clears it and sets the
        // signed-out marker) can now reach the logout path.
        if (!user && anySignedIn()) { return; }
        currentSession = session || null;
        currentUser = user;
        if (session && session.access_token) { writeIdentity(session); }
        currentProgress = null; progressLoaded = false; // re-fetch for the new (or no) user
        currentFlags = null; flagsLoaded = false;
        notify();
        refreshSubscription();
        refreshProfile();
        refreshDesktopDl();
        dpFlush();
      });
      /* Back online → if supabase lost its session while we were away, hand our tokens back so
         the user is silently restored instead of facing a sign-in screen. Also runs once at
         startup for the case where the app is opened online after a long offline spell. */
      /* Losing the network invalidates any live server answer we were holding. Without this,
         loading a page online and then switching on airplane mode kept subFresh true in memory,
         so the app went on believing it had a current verdict and the offline rules never ran —
         the reported "it worked once and then never again". Coming back online, re-ask. */
      window.addEventListener('offline', function () { subFresh = false; });
      window.addEventListener('online', function () {
        refreshSubscription();          // get a real answer again before anything relies on one
        if (restoredFromIdentity || !currentSession || !currentSession.access_token) reseedSession();
      });
      // And immediately, if we booted on our own record while a network is available — otherwise
      // supabase stays sessionless for the whole visit and gated audio 401s behind a signed-in UI.
      if (restoredFromIdentity && navigator.onLine) reseedSession();
      // In the native app, complete Google sign-in when the OAuth deep link returns.
      if (isNative()) {
        var AppPlugin = capPlugin('App');
        if (AppPlugin && AppPlugin.addListener) {
          AppPlugin.addListener('appUrlOpen', function (data) {
            var u = data && data.url;
            handleAuthDeepLink(u);       // Google OAuth callback
            handleCheckoutReturn(u);     // Stripe checkout return
          });
        }
      }
    })
    .catch(function (err) {
      console.error('ThaiEar auth failed to initialise:', err);
      window.ThaiEarAuth.isReady = true;
      notify(); // nav stays in logged-out state
    });
})();
