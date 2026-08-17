/* ============================================================
   attrib.js — first-party ad attribution + conversion events
   ------------------------------------------------------------
   STANDALONE BY DESIGN. This file edits nothing and is edited by nothing:
   it hooks the site through interfaces that already exist, so it could be
   built while another session was working inside player.js.

     • CLICK CAPTURE — reads gclid / utm_* off the URL on arrival and holds
       them for 30 days. MANDATORY to do it here rather than at signup:
       auth.js uses `redirectTo: window.location.href`, so the OAuth round
       trip returns to a URL with the query string long gone.

     • SIGNUP — listens for the `thaiear:auth` CustomEvent that auth.js
       already dispatches (auth.js:214). No edit to auth.js.

     • ACTIVATION — a CAPTURING document listener for 'play'. Media events
       do not bubble but they DO capture, so this sees player.js's
       `new Audio()` without player.js knowing. No edit to player.js.
       ⚠ It cannot see the Capacitor NATIVE audio path (the `NA` branch),
       which fires no DOM event. That is fine and deliberate: ad clicks
       land in a browser, never inside the installed app.

   ⚠ The two warnings that used to sit here — "NOT WIRED UP YET" and "THE
   GOOGLE TAG IS NOT INSTALLED" — were both STALE and actively misleading
   (corrected 2026-08-17). This file is loaded site-wide, is in sw.js
   PRECACHE, and the tag shipped 2026-08-12 (SESSION_2026-08-12_TRACKING.md).

   ⚠ `track()` still routes through gtag.js, which is consent-gated. The
   first-party POST below is NOT — it is first-party data about an account
   the user is deliberately creating, not an advertising cookie. That
   asymmetry is the whole point: it is the only signup signal that survives
   a declined consent prompt. See MARKETING_VIDEO_AD_STRATEGY.md.

   Table: supabase_ad_attribution.sql · Endpoint: functions/api/attrib.js
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarAttrib) return;                 // load once

  var STORE      = 'te_attrib';                     // the captured click
  var DONE       = 'te_attrib_sent:';               // + user id, once-guard
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;        // 30 days
  var NEW_USER_MS = 5 * 60 * 1000;                  // "created just now" window
  var PARAMS = ['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  function ls(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

  /* ---------- 1. capture the click ------------------------------------ */

  function capture() {
    var q = ls(function () { return new URLSearchParams(location.search); }, null);
    if (!q) return;

    var hit = {}, any = false;
    PARAMS.forEach(function (p) {
      var v = q.get(p);
      if (v) { hit[p] = String(v).slice(0, 512); any = true; }
    });
    if (!any) return;                               // ordinary visit, leave any earlier click alone

    hit.landing_page = location.pathname;           // path only — never the query string
    hit.referrer = ls(function () {
      return document.referrer ? new URL(document.referrer).origin : '';
    }, '');
    hit.first_seen = new Date().toISOString();

    // Last paid click wins. Someone who clicks a Search ad, leaves, then
    // clicks a YouTube ad and signs up was converted by the video.
    ls(function () { localStorage.setItem(STORE, JSON.stringify(hit)); });
  }

  function stored() {
    var raw = ls(function () { return localStorage.getItem(STORE); }, null);
    if (!raw) return null;
    var hit = ls(function () { return JSON.parse(raw); }, null);
    if (!hit || !hit.first_seen) return null;
    if (Date.now() - Date.parse(hit.first_seen) > MAX_AGE_MS) {
      ls(function () { localStorage.removeItem(STORE); });
      return null;
    }
    return hit;
  }

  /* ---------- 2. the access token -------------------------------------
     attrib.js cannot reach auth.js's private supabase client, so it reads
     the session supabase-js persists. Key shape is `sb-<ref>-auth-token`;
     matched by pattern rather than hardcoded so a project ref change or a
     supabase-js storage tweak degrades to "no attribution" rather than to
     a thrown error. ------------------------------------------------- */

  function accessToken() {
    return ls(function () {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(k || '')) continue;
        var s = JSON.parse(localStorage.getItem(k));
        var tok = s && (s.access_token || (s.currentSession && s.currentSession.access_token));
        if (tok) return tok;
      }
      return null;
    }, null);
  }

  /* ---------- 3. signup ------------------------------------------------ */

  function onAuth(ev) {
    var user = ev && ev.detail;
    if (!user || !user.id || !user.created_at) return;

    // Only a genuinely NEW account counts. Every later sign-in fires the
    // same event, and the once-guard covers the case where a new user
    // reloads inside the five-minute window.
    if (Date.now() - Date.parse(user.created_at) > NEW_USER_MS) return;
    if (ls(function () { return localStorage.getItem(DONE + user.id); }, null)) return;

    track('signup');

    /* ⚠ 2026-08-17 — POST EVEN WITH NO STORED CLICK. This used to `return` on an organic
       signup, so "no row" meant "came from nowhere we paid for". The endpoint now stamps
       signup GEOGRAPHY (country / city / network, off the Cloudflare edge) onto every row,
       and that is worth having for organic signups too — it is the only durable record of
       where a user came from. The Supabase auth log carries the IP but expires after 7 days.
       ⚠ The organic test therefore MOVED: it is now `gclid is null and utm_campaign is null`,
       NOT the absence of a row. supabase_ad_attribution.sql says the same. */
    var hit = stored() || {};

    var tok = accessToken();
    if (!tok) return;

    ls(function () { localStorage.setItem(DONE + user.id, '1'); });

    // Fire and forget. Attribution must never delay or break a signup.
    ls(function () {
      fetch('/api/attrib', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify(hit),
      }).catch(function () {});
    });
  }

  /* ---------- 4. activation ------------------------------------------- */

  var activated = false;
  function onPlay() {
    if (activated) return;
    activated = true;                               // once per page view
    track('activation');
  }

  /* ---------- 5. the conversion queue ---------------------------------
     The Google tag does not exist yet. Events are queued so that whichever
     way it lands later — gtag on the page, or an offline import keyed off
     the gclid we just stored — nothing that already happened is lost in
     the meantime. ------------------------------------------------- */

  var queue = [];
  function track(name) {
    queue.push({ event: name, at: new Date().toISOString() });
    if (typeof window.gtag === 'function' && window.ThaiEarConsent &&
        window.ThaiEarConsent.granted && window.ThaiEarConsent.granted('advertising')) {
      // Wired in the step that installs the tag; deliberately inert today.
      try { window.ThaiEarAttrib.send(name); } catch (_) {}
    }
  }

  /* ---------- go ------------------------------------------------------- */

  capture();
  window.addEventListener('thaiear:auth', onAuth);
  document.addEventListener('play', onPlay, true);  // capture: media events don't bubble

  window.ThaiEarAttrib = {
    click:  stored,                                 // what click is on file
    events: function () { return queue.slice(); },  // what would have been sent
    track:  track,
    send:   function () {},                         // replaced when the tag is installed
  };
})();
