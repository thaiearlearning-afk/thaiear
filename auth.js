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
  function reseedSession() {
    if (reseeding || !client) return Promise.resolve(false);
    var id = readIdentity();
    if (!id || !id.refresh_token) return Promise.resolve(false);
    reseeding = true;
    return client.auth.setSession({ access_token: id.access_token || '', refresh_token: id.refresh_token })
      .then(function (r) {
        reseeding = false;
        var s = r && r.data && r.data.session;
        if (s) { writeIdentity(s); return true; }
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
      currentSubscribed = false; currentSub = null;
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
  // Flush queued writes whenever the connection returns.
  window.addEventListener('online', function () { flushProgress(); flushFlags(); dpFlush(); });

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
    getSubscription: function () { return currentSub; }, // {status, cancel_at_period_end, current_period_end}
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
  function plStore() { try { localStorage.setItem('thaiear_playlists', JSON.stringify(plCache)); } catch (_) {} }
  function plLocal() { try { return JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) { return null; } }
  window.ThaiEarAuth.playlists = {
    // Resolves [{id, name, position, items:[{topic_key,num,prefix,tier,thai,translit,english}]}]
    load: function (force) {
      if (plCache && !force) return Promise.resolve(plCache);
      if (!client || !currentUser) { plCache = plLocal() || []; return Promise.resolve(plCache); }
      return client.from('playlists').select('id,name,position').order('position').order('created_at')
        .then(function (r) {
          if (r.error) throw r.error;
          var lists = r.data || [];
          if (!lists.length) { plCache = []; plStore(); return plCache; }
          return client.from('playlist_items')
            .select('id,playlist_id,topic_key,num,prefix,tier,thai,translit,english,position')
            .order('position').order('created_at')
            .then(function (ri) {
              if (ri.error) throw ri.error;
              var by = {};
              lists.forEach(function (p) { p.items = []; by[p.id] = p; });
              (ri.data || []).forEach(function (it) { if (by[it.playlist_id]) by[it.playlist_id].items.push(it); });
              plCache = lists; plStore(); return plCache;
            });
        })
        .catch(function () { plCache = plLocal() || []; return plCache; });
    },
    get: function () { return plCache; },
    // Read-only view of the localStorage copy — safe to call BEFORE the client/auth resolve
    // and never touches plCache (playlists.html uses it for an instant cache-first paint).
    peek: function () { return plLocal(); },
    create: function (name) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      return client.from('playlists')
        .insert({ user_id: currentUser.id, name: name, position: (plCache || []).length })
        .select('id,name,position').single()
        .then(function (r) {
          if (r.error) throw r.error;
          r.data.items = [];
          (plCache = plCache || []).push(r.data); plStore();
          return r.data;
        });
    },
    remove: function (id) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      return client.from('playlists').delete().eq('id', id).then(function (r) {
        if (r.error) throw r.error;
        if (plCache) { plCache = plCache.filter(function (p) { return p.id !== id; }); plStore(); }
      });
    },
    addItem: function (id, item) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var p = (plCache || []).filter(function (x) { return x.id === id; })[0];
      var row = {
        playlist_id: id, topic_key: item.topic_key, num: item.num,
        prefix: item.prefix, tier: item.tier || 'free',
        thai: item.thai, translit: item.translit || null, english: item.english,
        position: p ? p.items.length : 0
      };
      return client.from('playlist_items').upsert(row, { onConflict: 'playlist_id,topic_key,num' })
        .then(function (r) {
          if (r.error) throw r.error;
          if (p && !p.items.some(function (i) { return i.topic_key === row.topic_key && i.num === row.num; })) {
            p.items.push(row); plStore();
          }
        });
    },
    removeItem: function (id, topicKey, num) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      return client.from('playlist_items').delete()
        .eq('playlist_id', id).eq('topic_key', topicKey).eq('num', num)
        .then(function (r) {
          if (r.error) throw r.error;
          var p = (plCache || []).filter(function (x) { return x.id === id; })[0];
          if (p) { p.items = p.items.filter(function (i) { return !(i.topic_key === topicKey && i.num === num); }); plStore(); }
        });
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
      if (!session || !session.user) session = readIdentity() || session;
      currentSession = session || null;
      currentUser = userFromSession(currentSession);
      if (currentSession && currentSession.access_token) writeIdentity(currentSession);
      window.ThaiEarAuth.isReady = true;
      notify();
      refreshSubscription(); // async; fires another notify when it resolves
      refreshProfile();      // marketing-consent flag
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
        if (!user && anySignedIn()) return;
        currentSession = session || null;
        currentUser = user;
        if (session && session.access_token) writeIdentity(session);   // keep our copy fresh
        currentProgress = null; progressLoaded = false; // re-fetch for the new (or no) user
        currentFlags = null; flagsLoaded = false;
        notify();
        refreshSubscription();
        refreshProfile();
        dpFlush();
      });
      /* Back online → if supabase lost its session while we were away, hand our tokens back so
         the user is silently restored instead of facing a sign-in screen. Also runs once at
         startup for the case where the app is opened online after a long offline spell. */
      window.addEventListener('online', function () {
        if (!currentUser || !currentSession || !currentSession.access_token) reseedSession();
      });
      if (currentUser && (!currentSession || !currentSession.access_token)) reseedSession();
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
