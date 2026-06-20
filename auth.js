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

  function notify() {
    try { if (window.ThaiEarNav && window.ThaiEarNav.refresh) window.ThaiEarNav.refresh(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('thaiear:auth', { detail: currentUser })); } catch (e) {}
  }

  // Read the user's own subscription row (RLS) and cache active/not, then re-notify
  // so cards/pages re-render once we know. Logged out → not subscribed.
  function refreshSubscription() {
    if (!client || !currentUser) { currentSubscribed = false; currentSub = null; notify(); return; }
    client.from('subscriptions').select('status,cancel_at_period_end,current_period_end').maybeSingle()
      .then(function (res) {
        currentSub = (res && res.data) || null;
        var s = currentSub && currentSub.status;
        currentSubscribed = (s === 'active' || s === 'trialing');
      })
      .catch(function () { currentSubscribed = false; currentSub = null; })
      .then(function () { notify(); });
  }

  // Read the user's marketing-consent flag (profiles row), cache it, re-notify.
  function refreshProfile() {
    if (!client || !currentUser) { currentConsent = false; consentLoaded = false; return; }
    client.from('profiles').select('marketing_opt_in').maybeSingle()
      .then(function (res) { currentConsent = !!(res && res.data && res.data.marketing_opt_in); })
      .catch(function () { currentConsent = false; })
      .then(function () { consentLoaded = true; notify(); });
  }

  // ---- listening progress (own `progress` row, RLS) ----------------------
  // One jsonb row per user: { goal, topics:{ topicKey:count } }. Read on demand
  // (topic pages + the progress page), not on every page load. Read-modify-write
  // is fine here — a user only touches their own single row.
  function fetchProgress() {
    if (!client || !currentUser) { currentProgress = { goal: 5, topics: {} }; progressLoaded = true; return Promise.resolve(currentProgress); }
    return client.from('progress').select('goal,topics').maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var d = (res && res.data) || null;
        currentProgress = { goal: (d && d.goal) || 5, topics: (d && d.topics) || {} };
        progressLoaded = true;
        return currentProgress;
      });
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
  // Ensure the cache is populated, then run fn (which mutates currentProgress) and save.
  function mutateProgress(fn) {
    if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
    var ready = (progressLoaded && currentProgress) ? Promise.resolve(currentProgress) : fetchProgress();
    return ready.then(function () { fn(currentProgress); return saveProgress(); });
  }

  // ---- flagged sentences (own `sentence_flags` rows, RLS) ----------------
  // One row per flagged sentence; the sentence nugget is stored so the My-sentences
  // page is self-contained. Cached as a map keyed by "topicKey:num".
  function flagKey(tk, num) { return tk + ':' + num; }
  function fetchFlags() {
    if (!client || !currentUser) { currentFlags = {}; flagsLoaded = true; return Promise.resolve(currentFlags); }
    return client.from('sentence_flags').select('topic_key,num,sentence')
      .then(function (res) {
        if (res && res.error) throw res.error;
        var map = {};
        (res && res.data || []).forEach(function (r) { map[flagKey(r.topic_key, r.num)] = r; });
        currentFlags = map; flagsLoaded = true;
        return currentFlags;
      });
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
    toggleFlag: function (tk, nugget) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var num = nugget.num;
      var key = flagKey(tk, num);
      var ready = (flagsLoaded && currentFlags) ? Promise.resolve() : fetchFlags();
      return ready.then(function () {
        if (currentFlags[key]) {
          return client.from('sentence_flags').delete()
            .eq('user_id', currentUser.id).eq('topic_key', tk).eq('num', num)
            .then(function (res) { if (res && res.error) throw res.error; delete currentFlags[key]; return false; });
        }
        var row = { user_id: currentUser.id, topic_key: tk, num: num, sentence: nugget, created_at: new Date().toISOString() };
        return client.from('sentence_flags').upsert(row)
          .then(function (res) { if (res && res.error) throw res.error; currentFlags[key] = { topic_key: tk, num: num, sentence: nugget }; return true; });
      });
    },
    // Remove a flag by (topicKey, num) — used by the My-sentences page's remove button.
    removeFlag: function (tk, num) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      return client.from('sentence_flags').delete()
        .eq('user_id', currentUser.id).eq('topic_key', tk).eq('num', num)
        .then(function (res) { if (res && res.error) throw res.error; if (currentFlags) delete currentFlags[flagKey(tk, num)]; return true; });
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
      return client.auth.signOut();
    }
  };

  import(SUPABASE_ESM)
    .then(function (mod) {
      client = mod.createClient(SUPABASE_URL, SUPABASE_KEY);
      return client.auth.getSession();
    })
    .then(function (res) {
      currentSession = (res && res.data && res.data.session) || null;
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
          AppPlugin.addListener('appUrlOpen', function (data) { handleAuthDeepLink(data && data.url); });
        }
      }
    })
    .catch(function (err) {
      console.error('ThaiEar auth failed to initialise:', err);
      window.ThaiEarAuth.isReady = true;
      notify(); // nav stays in logged-out state
    });
})();
