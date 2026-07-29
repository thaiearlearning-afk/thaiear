/* ============================================================================
   sim.js — OWNER ENTITLEMENT SIMULATOR (test build only)
   ----------------------------------------------------------------------------
   Lets the owner exercise premium/member gating — online AND offline — without
   touching a real Supabase account or waiting a month for a subscription to
   lapse. Loaded by playlists.html and the topic-test pages; read by player.js.

   THE DESIGN RULE THAT MAKES IT A REAL TEST:
     It overrides only the AUTH ANSWER, never a decision. The simulated account
     is injected at the ThaiEarAuth boundary (getUser / isSubscribed) — exactly
     where the real Supabase answer enters the app — and every downstream check
     then runs UNMODIFIED on it: canUseOffline, the 30-day grace arithmetic,
     sentLocked, entitledForPage, the licence overlay.
     A switch that forced canUseOffline() to return false would prove nothing;
     it would bypass the code under test. Likewise `elapse()` overrides nothing
     at all — it BACKDATES the real localStorage markers and lets the real
     arithmetic decide.

   WHAT IT CANNOT DO: change the SERVER's answer. /api/audio still sees the
   owner's real, valid token, so a genuinely-subscribed owner is still handed
   signed URLs. setDeny(true) covers that gap by making the client treat every
   gated request as refused (402) — which is what exercises the
   "server disagrees with the client" fallback in dynBuildSessionFor.

   Everything here is INERT unless a flag is set, and the whole file (plus its
   <script> tags and the ~10 lines in player.js that call it) is deleted at
   rollout.
   ============================================================================ */
(function () {
  'use strict';

  var K_TIER = 'te_sim_tier';       // '' | 'premium' | 'expired' | 'signedout'
  var K_DENY = 'te_sim_deny';       // '1' = pretend /api/audio returns 402
  var K_ELAPSED = 'te_sim_elapsed'; // days backdated, for the panel's own display
  var K_BACKUP = 'te_sim_backup';   // originals, so Restore is exact

  // The real markers canUseOffline() reads. Backdating these IS the elapsed-time test.
  //   thaiear_lastVerified — when the subscription was last confirmed online
  //   thaiear_sub_until    — captured real period end; an OR-branch that grants access on its
  //                          own, so it has to move too or nothing changes
  //   thaiear_lifetime     — lifetime members never time out, so it must be lifted
  var LICENCE_KEYS = ['thaiear_lastVerified', 'thaiear_sub_until', 'thaiear_lifetime'];

  function get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (_) {} }

  function tier() { var v = get(K_TIER) || ''; return v === 'off' ? '' : v; }
  function denies() { return get(K_DENY) === '1'; }
  function elapsedDays() { var v = get(K_ELAPSED); return v ? parseInt(v, 10) : 0; }

  /* The auth VIEW every entitlement check reads. With no simulation this returns the real
     ThaiEarAuth untouched; with one, a read-only shim of the same shape, so callers cannot
     tell the difference. */
  function authView(real) {
    var s = tier();
    if (!real || !s) return real;
    var signedIn = (s !== 'signedout');
    var subbed = (s === 'premium');
    return {
      isReady: true,
      getUser: function () { return signedIn ? (real.getUser ? real.getUser() : { sim: true }) : null; },
      isSubscribed: function () { return subbed; },
      getSubscription: function () { return (subbed && real.getSubscription) ? real.getSubscription() : null; },
      getAccessToken: function () { return real.getAccessToken ? real.getAccessToken() : null; },
      isFlagged: function () { return real.isFlagged ? real.isFlagged.apply(real, arguments) : false; },
      loadFlags: function () { return real.loadFlags ? real.loadFlags.apply(real, arguments) : Promise.resolve(); }
    };
  }

  // Backdate the licence markers by `days`. Stashes the originals once, so repeated calls (or a
  // different day count) never lose the true values.
  function elapse(days) {
    if (!days) { restore(); return; }
    if (!get(K_BACKUP)) {
      var b = {};
      LICENCE_KEYS.forEach(function (k) { b[k] = get(k); });
      set(K_BACKUP, JSON.stringify(b));
    }
    var past = Date.now() - days * 24 * 60 * 60 * 1000;
    set('thaiear_lastVerified', past);
    set('thaiear_sub_until', past);      // period end in the past too
    set('thaiear_lifetime', null);       // lifetime would otherwise never expire
    set(K_ELAPSED, days);
  }

  function restore() {
    var raw = get(K_BACKUP);
    if (raw) {
      var b = {};
      try { b = JSON.parse(raw) || {}; } catch (_) {}
      LICENCE_KEYS.forEach(function (k) { set(k, b[k]); });
      set(K_BACKUP, null);
    }
    set(K_ELAPSED, null);
  }

  function reset() { set(K_TIER, null); set(K_DENY, null); restore(); }

  function active() { return !!tier() || !!elapsedDays() || denies(); }

  window.ThaiEarSim = {
    tier: tier,
    denies: denies,
    authView: authView,
    elapse: elapse,
    restore: restore,
    reset: reset,
    active: active,
    get: function () { return { tier: tier(), elapsedDays: elapsedDays(), deny: denies() }; },
    setTier: function (v) { set(K_TIER, v || null); },
    setDeny: function (on) { set(K_DENY, on ? '1' : null); }
  };
})();
