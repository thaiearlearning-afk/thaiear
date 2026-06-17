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
    if (!client || !currentUser) { currentConsent = false; return; }
    client.from('profiles').select('marketing_opt_in').maybeSingle()
      .then(function (res) { currentConsent = !!(res && res.data && res.data.marketing_opt_in); })
      .catch(function () { currentConsent = false; })
      .then(function () { notify(); });
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
    signInWithGoogle: function () {
      if (!client) { console.warn('ThaiEar auth still loading…'); return; }
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
        notify();
        refreshSubscription();
        refreshProfile();
      });
    })
    .catch(function (err) {
      console.error('ThaiEar auth failed to initialise:', err);
      window.ThaiEarAuth.isReady = true;
      notify(); // nav stays in logged-out state
    });
})();
