/* ============================================================
   auth.js — ThaiEar authentication (Supabase + Google).
   ------------------------------------------------------------
   Loaded automatically by nav.js when the members UI is on, so
   no page needs its own <script>. Responsibilities:
     • create the Supabase client
     • expose window.ThaiEarAuth.{ getUser, signInWithGoogle, signOut, isReady }
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

  // Public API. getUser() is synchronous; the rest are no-ops until the
  // Supabase client has loaded (avoids errors if a button is hit very early).
  window.ThaiEarAuth = {
    isReady: false,
    getUser: function () { return currentUser; },
    signInWithGoogle: function () {
      if (!client) { console.warn('ThaiEar auth still loading…'); return; }
      client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href }
      });
    },
    signOut: function () {
      if (!client) return;
      client.auth.signOut();
    }
  };

  import(SUPABASE_ESM)
    .then(function (mod) {
      client = mod.createClient(SUPABASE_URL, SUPABASE_KEY);
      return client.auth.getSession();
    })
    .then(function (res) {
      currentUser = userFromSession(res && res.data && res.data.session);
      window.ThaiEarAuth.isReady = true;
      notify();
      // keep in sync on login / logout / token refresh
      client.auth.onAuthStateChange(function (_event, session) {
        currentUser = userFromSession(session);
        notify();
      });
    })
    .catch(function (err) {
      console.error('ThaiEar auth failed to initialise:', err);
      window.ThaiEarAuth.isReady = true;
      notify(); // nav stays in logged-out state
    });
})();
