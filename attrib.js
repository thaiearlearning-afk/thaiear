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

  /* ⚠⚠ PECR GATE (2026-08-19). Everything this file puts on the DEVICE is behind
     advertising consent. Reading or writing localStorage is "access to terminal
     equipment" (PECR reg 6) and needs consent; a legitimate-interests basis in the
     privacy policy does NOT substitute for it. The SERVER-side geography in
     functions/api/attrib.js is a different matter and is deliberately not gated —
     it touches no device storage. See ADS_OPERATIONS.md and privacy.html §1.
     ⚠ FAILS CLOSED: if consent.js has not loaded, nothing is stored. */
  function adConsent() {
    var c = window.ThaiEarConsent;
    return !!(c && typeof c.granted === 'function' && c.granted('advertising'));
  }

  var STORE      = 'te_attrib';                     // the captured click
  var DONE       = 'te_attrib_sent:';               // + user id, once-guard
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;        // 30 days
  /* "created just now" window. ⚠ 60 min, not 5 — on the MAGIC-LINK path Supabase stamps
     created_at when the link is REQUESTED, not when it is clicked, so a user who checks
     their email a quarter of an hour later would otherwise never be attributed. 60 min
     matches Supabase's own link expiry. It cannot create false positives: a returning
     user's created_at is days old under either figure. */
  var NEW_USER_MS = 60 * 60 * 1000;
  var PARAMS = ['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  function ls(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

  /* ---------- 1. capture the click ------------------------------------ */

  function capture() {
    if (!adConsent()) return;                       // PECR: no consent, no device write
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
    if (!adConsent()) return null;                  // PECR: reading is access as well
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
     a persisted session out of localStorage. Two sources, in order:

       1. supabase-js's own key, shape `sb-<ref>-auth-token`. Matched by
          PATTERN rather than hardcoded so a project ref change or a
          supabase-js storage tweak degrades to "no attribution" rather
          than to a thrown error.

       2. ⭐ auth.js's DURABLE IDENTITY (`thaiear_identity`) — added
          2026-08-18. Source 1 alone is not enough: supabase-js DELETES its
          key when a refresh fails on an already-expired token, which is the
          whole reason the durable identity exists (see auth.js "DURABLE
          OFFLINE IDENTITY"). On any path where that has happened we would
          silently record nothing — a second, quieter route to the zero-rows
          bug fixed the same day. Its token can be STALE, in which case
          /api/attrib returns 403 and no row is written; that is no worse
          than the nothing we would otherwise have sent, and the once-guard
          below now lets it be retried. ------------------------------- */

  var ID_KEY = 'thaiear_identity';                  // auth.js:179 — keep in step

  function accessToken() {
    return ls(function () {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(k || '')) continue;
        var s = JSON.parse(localStorage.getItem(k));
        var tok = s && (s.access_token || (s.currentSession && s.currentSession.access_token));
        if (tok) return tok;
      }
      var id = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      return (id && id.access_token) || null;
    }, null);
  }

  /* ---------- 3. signup ------------------------------------------------ */

  var inFlight = {};                                // user id -> a POST is already going out

  function onAuth(ev) {
    var user = ev && ev.detail;
    if (!user || !user.id || !user.created_at) return;

    // Only a genuinely NEW account counts. Every later sign-in fires the
    // same event, and the once-guard covers the case where a new user
    // reloads inside the five-minute window.
    if (Date.now() - Date.parse(user.created_at) > NEW_USER_MS) return;
    /* The durable once-guard is itself device storage, so it is gated too. Without it
       the endpoint's own primary-key dedup (409 = success) does the job, at the cost of
       a few redundant POSTs inside NEW_USER_MS. Cheap, and it keeps the promise absolute. */
    if (adConsent() && ls(function () { return localStorage.getItem(DONE + user.id); }, null)) return;

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

    /* ⚠ THE DURABLE ONCE-GUARD IS SET ON SUCCESS, NOT BEFORE THE REQUEST (changed 2026-08-18).
       It used to be written first, so a POST that failed — a stale token from the durable
       identity above, or simply being offline at the moment of signup — marked the user
       done FOREVER and the row could never be recovered. The endpoint is keyed on user_id
       and treats a 409 as success, so a retry is free. A page closed mid-flight now just
       tries again on the next auth event, which is the behaviour we want.

       ⚠⚠ WHICH IS EXACTLY WHY `inFlight` HAS TO EXIST. auth.js calls notify() SEVERAL times
       on a single load — once when the session resolves (auth.js:1738) and again as
       refreshSubscription / refreshLifetime / refreshProfile each settle — so every one of
       those fires `thaiear:auth`. The old synchronous write happened to suppress the repeats.
       Without this in-memory guard the same signup POSTs three or four times per page load.
       Harmless at the endpoint (idempotent), but it is still three wasted requests during
       signup, which is the one moment we promised not to slow down. */
    if (inFlight[user.id]) return;
    inFlight[user.id] = true;

    ls(function () {
      fetch('/api/attrib', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify(hit),
      }).then(function (r) {
        if (r && r.ok) { if (adConsent()) ls(function () { localStorage.setItem(DONE + user.id, '1'); }); }
        else inFlight[user.id] = false;              // failed → let a later auth event retry
      }).catch(function () { inFlight[user.id] = false; });
    });
  }

  /* ---------- 3b. consent changes -------------------------------------
     The banner is answered AFTER the page has loaded, so the first capture()
     ran while consent was still undecided and correctly stored nothing. If the
     visitor then says yes we are usually still on the landing page with the
     params in the URL, so capture again. If they later withdraw, erase what we
     hold — a withdrawal that leaves the data in place is not a withdrawal. */
  ls(function () {
    if (!window.ThaiEarConsent || !window.ThaiEarConsent.onChange) return;
    window.ThaiEarConsent.onChange(function () {
      if (adConsent()) { capture(); return; }
      ls(function () {
        localStorage.removeItem(STORE);
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf(DONE) === 0) localStorage.removeItem(k);
        }
      });
    });
  });

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
