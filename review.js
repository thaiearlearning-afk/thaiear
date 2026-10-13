/* ============================================================
   review.js — Google Play's rating card, offered at the end of a quiz (2026-10-13)
   ------------------------------------------------------------
   window.ThaiEarReview: quizDone() · check() · has()
   Loaded on demand: by quiz.js's results screen inside the Android app only, and by the owner
   panel for its check. Plan: GOOGLE_PAYMENTS_PLAN.md (tooling repo) §8b. THE RULE (3rd day of use,
   6 more days, then never) is the SERVER's: functions/api/review.js. Nothing here decides it.

   ⛔ NOTHING ON THE DEVICE. No localStorage, no sessionStorage, no cookie. The guards here are in
      memory (settled / busy, per page load); the count and the asks are the server's. Device
      storage for this would need consent (PECR reg 6).
   ⛔ NEVER FROM A BUTTON a learner presses: only quizDone(), from a quiz's results screen. The owner
      panel's "Show review card" calls the plugin itself and only the owner sees it.
   ⛔ NO QUESTION FIRST: the card is Google's own, and nothing of ours appears before or around it.
   ⭐ AN ASK IS COUNTED ONLY WHEN THE CARD IS REALLY REQUESTED (owner, 2026-10-13: "what if i
      navigate away quickly at end of quiz like a user might"). The server is asked first with a GET,
      which counts nothing; after the pause, if the learner is still here and not already in another
      quiz, the card is requested and THEN the ask is recorded (POST, keepalive). Leaving in the
      pause costs nothing: the next finished quiz gets the chance instead.
   ⚠ EVERY CALL RESOLVES, NONE REJECTS: { asked: true, ms } or { asked: false, reason }.
   Not in sw.js PRECACHE: asking needs the network anyway.
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarReview) return;

  var API = '/api/review';
  var CARD_DELAY_MS = 500;    // let the score land first (owner, 2026-10-13: "shorten it to 0.5 seconds")
  /* In memory only. `settled`: this page load is done (the server said not now, or the card was
     requested), so no further questions from it. `busy`: one question at a time. A quiz whose
     moment was skipped (the learner left, or started another quiz) settles nothing. */
  var settled = false;
  var busy = false;

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

  function ask(method, t) {
    if (!t) return Promise.resolve({ reason: 'no_token' });
    return fetch(API, { method: method, headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { reason: 'server_' + r.status }; });
  }
  /* Records the ask. keepalive: it must outlive a learner who leaves the page while the card is up. */
  function record(t) {
    try {
      fetch(API, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, cache: 'no-store', keepalive: true })
        .catch(function () {});
    } catch (_) {}
  }
  function stillHere(stillOk) {
    if (!visible()) return 'hidden';
    try { if (typeof stillOk === 'function' && !stillOk()) return 'busy'; } catch (_) { return 'busy'; }
    return null;
  }

  /* The quiz's results screen calls this once the score is drawn. stillOk(): false while another
     quiz is under way (quiz.js passes it), so the card never covers a question. */
  function quizDone(stillOk) {
    return Promise.resolve().then(function () {
      if (!isApp()) return no('website');
      if (!plugin()) return no('old_app');
      if (settled || busy) return no('this_page');
      if (!signedIn()) return no('signed_out');
      if (!online()) return no('offline');
      if (!visible()) return no('hidden');
      busy = true;
      var tok = null;
      return token().then(function (t) {
        tok = t;
        return ask('GET', t);                       // counts nothing
      }).then(function (j) {
        if (!j || !j.ask) {
          if (j && j.reason !== 'no_token' && !/^server_/.test(j.reason || '')) settled = true;
          busy = false;
          return no((j && j.reason) || 'server');
        }
        return wait(CARD_DELAY_MS).then(function () {
          busy = false;
          var gone = stillHere(stillOk);
          if (gone) return no(gone);                // left, or another quiz began: nothing counted
          var P = plugin();
          if (!P) return no('old_app');
          settled = true;
          record(tok);                              // the ask is counted NOW, as the card is requested
          return Promise.resolve().then(function () { return P.requestReview(); }).then(
            function (out) { return { asked: true, ms: (out && typeof out.ms === 'number') ? out.ms : null }; },
            function (e) { var r = no('plugin'); r.code = (e && e.code) || null; return r; });
        });
      });
    }).catch(function () { busy = false; return no('error'); });
  }

  /* The owner panel: what the server would answer now. Records nothing, shows nothing. */
  function check() {
    return Promise.resolve().then(function () {
      if (!signedIn()) return { ok: false, reason: 'signed_out', plugin: has() };
      return token().then(function (t) { return ask('GET', t); }).then(function (j) {
        return { ok: !!(j && j.ok), ask: !!(j && j.ask), reason: (j && j.reason) || null, plugin: has() };
      });
    }).catch(function () { return { ok: false, reason: 'error', plugin: has() }; });
  }

  window.ThaiEarReview = { quizDone: quizDone, check: check, has: has };
})();
