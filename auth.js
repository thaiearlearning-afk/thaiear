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

  var SUPABASE_URL = 'https://pyfyyiegmxwmfshgwvze.supabase.co';
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

  function notify() {
    try { if (window.ThaiEarNav && window.ThaiEarNav.refresh) window.ThaiEarNav.refresh(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('thaiear:auth', { detail: currentUser })); } catch (e) {}
  }

  // Read the user's own subscription row (RLS) and cache active/not, then re-notify
  // so cards/pages re-render once we know. Logged out → not subscribed.
  function refreshSubscription() {
    if (!client || !currentUser) {
      currentSubscribed = false; currentSub = null;
      try { localStorage.removeItem('thaiear_lifetime'); localStorage.removeItem('thaiear_sub_cache'); } catch (_) {} // logged out
      notify(); return;
    }
    client.from('subscriptions').select('status,cancel_at_period_end,current_period_end').maybeSingle()
      .then(function (res) {
        currentSub = (res && res.data) || null;
        var s = currentSub && currentSub.status;
        currentSubscribed = (s === 'active' || s === 'trialing');
        // Persist the last KNOWN-GOOD subscription (only on a clean read) so the account page can show
        // the real "Premium — active until …" status while OFFLINE (when the live query can't run).
        try { if (res && !res.error) localStorage.setItem('thaiear_sub_cache', JSON.stringify({ uid: currentUser.id, sub: currentSub })); } catch (_) {}
      })
      .catch(function () { currentSubscribed = false; currentSub = null; })
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
  window.addEventListener('online', function () { flushProgress(); flushFlags(); });

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
      return saveProgress()
        .then(function () { clearProgressDirty(); return currentProgress; })
        .catch(function (e) {
          if (!navigator.onLine) return currentProgress; // offline → optimistic; flushed when back online
          throw e;                                        // genuine ONLINE failure → surface it (caller reverts)
        });
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
      // Native app → deep-link flow; web → ordinary page redirect.
      if (isNative()) { nativeGoogleSignIn(); return; }
      client.auth.signInWithOAuth({
        provider: 'google',
        // prompt=select_account → Google always shows the account chooser, so signing
        // in is a deliberate confirmation rather than a silent re-auth.
        options: { redirectTo: window.location.href, queryParams: { prompt: 'select_account' } }
      });
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
        try { localStorage.removeItem('thaiear_lifetime'); } catch (_) {}
        notify();   // re-render nav + account page as logged-out
      };
      var attempt = client.auth.signOut({ scope: 'local' }).catch(function () {});
      var timeout = new Promise(function (res) { setTimeout(res, 1500); });
      return Promise.race([attempt, timeout]).then(forceLocal);
    }
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
        function () { return readStoredSession(); }
      );
      var timer = new Promise(function (resolve) {
        setTimeout(function () { resolve(readStoredSession()); }, OFFLINE_FALLBACK_MS);
      });
      return Promise.race([gs, timer]);
    })
    .then(function (session) {
      currentSession = session || null;
      currentUser = userFromSession(currentSession);
      window.ThaiEarAuth.isReady = true;
      notify();
      refreshSubscription(); // async; fires another notify when it resolves
      refreshProfile();      // marketing-consent flag
      // keep in sync on login / logout / token refresh
      client.auth.onAuthStateChange(function (_event, session) {
        currentSession = session || null;
        currentUser = userFromSession(session);
        currentProgress = null; progressLoaded = false; // re-fetch for the new (or no) user
        currentFlags = null; flagsLoaded = false;
        notify();
        refreshSubscription();
        refreshProfile();
      });
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
