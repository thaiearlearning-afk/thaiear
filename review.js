/* ============================================================
   review.js — Google Play's rating card, offered at the end of a quiz (2026-10-13)
   ------------------------------------------------------------
   window.ThaiEarReview: quizDone() · check() · has()
   Loaded on demand: by quiz.js's results screen inside the Android app only, and by the owner
   panel for its check. Plan: GOOGLE_PAYMENTS_PLAN.md (tooling repo) §8b. THE RULE (3rd day of use,
   6 more days, then never) is the SERVER's: functions/api/review.js. Nothing here decides it.

   ⛔ NOTHING ON THE DEVICE. No localStorage, no sessionStorage, no cookie. The one guard here is in
      memory (one question per page load); the count and the asks are the server's. Device storage
      for this would need consent (PECR reg 6).
   ⛔ NEVER FROM A BUTTON a learner presses: only quizDone(), from a quiz's results screen. The owner
      panel's "Show review card" calls the plugin itself and only the owner sees it.
   ⛔ NO QUESTION FIRST: the card is Google's own, and nothing of ours appears before or around it.
   ⚠ EVERY CALL RESOLVES, NONE REJECTS: { asked: true, ms } or { asked: false, reason }.
   Not in sw.js PRECACHE: asking needs the network anyway.
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarReview) return;

  var API = '/api/review';
  var CARD_DELAY_MS = 1200;   // let the score land before Google's card slides over it
  var askedThisPage = false;  // in memory only: one question to the server per page load

  function cap() { return window.Capacitor || null; }
  function isApp() {
    var c = cap();
    try { return !!(c && c.isNativePlatform && c.isNativePlatform()); } catch (_) { return false; }
  }
  /* The INSTALLED app decides, not this file: 1.8+ publishes an InAppReview entry in
     Capacitor.PluginHeaders (the same test billing.js makes for Purchases). */
  function has() {
    if (!isApp()) return false;
    try {
      var hs = cap().PluginHeaders || [];
      for (var i = 0; i < hs.length; i++) {
        if (hs[i] && hs[i].name === 'InAppReview') {
          return (hs[i].methods || []).some(function (m) { return m && m.name === 'requestReview'; });
        }
      }
    } catch (_) {}
    return false;
  }
  function plugin() { var c = cap(); return has() ? ((c.Plugins && c.Plugins.InAppReview) || null) : null; }
  function signedIn() {
    try {
      var a = window.ThaiEarAuth, u = a && a.getUser && a.getUser();
      return !!(u && u.id);
    } catch (_) { return false; }
  }
  function token() {
    var a = window.ThaiEarAuth;
    if (!a) return Promise.resolve(null);
    try {
      return Promise.resolve(a.freshToken ? a.freshToken() : (a.getAccessToken ? a.getAccessToken() : null))
        .catch(function () { return null; });
    } catch (_) { return Promise.resolve(null); }
  }
  function visible() { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }
  function online() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function no(reason) { return { asked: false, reason: reason }; }

  function ask(method) {
    return token().then(function (t) {
      if (!t) return { reason: 'no_token' };
      return fetch(API, { method: method, headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : { reason: 'server_' + r.status }; });
    });
  }

  /* The quiz's results screen calls this once the score is drawn. */
  function quizDone() {
    return Promise.resolve().then(function () {
      if (!isApp()) return no('website');
      if (!plugin()) return no('old_app');
      if (askedThisPage) return no('this_page');
      if (!signedIn()) return no('signed_out');
      if (!online()) return no('offline');
      if (!visible()) return no('hidden');
      askedThisPage = true;
      return ask('POST').then(function (j) {
        if (!j || !j.ask) return no((j && j.reason) || 'server');
        return wait(CARD_DELAY_MS).then(function () {
          /* The ask is spent either way (the server recorded it). A learner who switched away in
             these 1.2 s is not shown a card over whatever they went to. */
          if (!visible()) return no('hidden');
          var P = plugin();
          if (!P) return no('old_app');
          return Promise.resolve().then(function () { return P.requestReview(); }).then(
            function (out) { return { asked: true, ms: (out && typeof out.ms === 'number') ? out.ms : null }; },
            function (e) { var r = no('plugin'); r.code = (e && e.code) || null; return r; });
        });
      });
    }).catch(function () { return no('error'); });
  }

  /* The owner panel: what the server would answer now. Records nothing, shows nothing. */
  function check() {
    return Promise.resolve().then(function () {
      if (!signedIn()) return { ok: false, reason: 'signed_out', plugin: has() };
      return ask('GET').then(function (j) {
        return { ok: !!(j && j.ok), ask: !!(j && j.ask), reason: (j && j.reason) || null, plugin: has() };
      });
    }).catch(function () { return { ok: false, reason: 'error', plugin: has() }; });
  }

  window.ThaiEarReview = { quizDone: quizDone, check: check, has: has };
})();
