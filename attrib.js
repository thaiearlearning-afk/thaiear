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

  /* ⭐ THE CONSENT-FREE FALLBACK (2026-08-20). Reads the click straight off the CURRENT URL.

     WHY IT HAD TO EXIST. capture()/stored() above are the good path, but both are gated on
     advertising consent, and since `BANNER_OFF` (sw v372) nobody is ever asked, so nobody ever
     grants. On /start there is no consent.js at all. The gate is therefore shut permanently,
     and `ad_attribution.gclid` was being written on 0 of 0 signups -- while the reply to
     Google's Ads API compliance team on 18 Aug already claimed "our site captures the gclid
     first-party at landing". This is what makes that true.

     ⚠⚠ IT TOUCHES NO DEVICE STORAGE, AND THAT IS THE ENTIRE POINT. Reading a URL the browser
     was just sent is not "access to terminal equipment", so PECR reg 6 is not engaged and no
     consent is required -- the same reasoning that keeps the /api/seen ping consent-free. Do
     NOT "tidy" this into localStorage to share code with capture(); that would silently move
     it behind a gate that is closed, which is the bug it exists to fix.

     ⚠ IT ONLY WORKS WHERE SIGNUP HAPPENS ON THE LANDING PAGE. Verified live on 2026-08-20:
     signing in from `/start?gclid=TEST123&nogo=1` returns to that exact URL, params intact.
     The header comment at the top of this file says the round trip leaves "the query string
     long gone" -- that is true of ordinary pages, where people navigate before signing in, and
     NOT of /start, whose only exit is sign-in. That is precisely why /start is the ads landing
     page. Someone who lands on "/" with a gclid and signs up three pages later is still only
     covered by the consented path above.

     ⚠ `referrer` and `first_seen` are deliberately NOT set here.
       * referrer  -- at this moment document.referrer is Google's OAuth origin, not the ad's
                      referrer. Recording it would be worse than recording nothing.
       * first_seen -- we do not know when the click happened, only that it was this session.
                      The row's own created_at carries signup time. Stamping "now" would look
                      like a click-to-signup latency of zero and quietly corrupt that read.
     Both columns are nullable; the endpoint skips absent fields. */
  function fromUrl() {
    var q = ls(function () { return new URLSearchParams(location.search); }, null);
    if (!q) return null;

    var hit = {}, any = false;
    PARAMS.forEach(function (p) {
      var v = q.get(p);
      if (v) { hit[p] = String(v).slice(0, 512); any = true; }
    });
    if (!any) return null;

    hit.landing_page = location.pathname;   // path only -- never the query string
    return hit;
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

  /* ⭐ 3. auth.js's IN-MEMORY session, tried FIRST (added 2026-08-23).
     ------------------------------------------------------------------
     Sources 1 and 2 both go to localStorage for a token that auth.js is already
     holding in RAM (`currentSession.access_token`, exposed as getAccessToken()
     at auth.js:969). That indirection is what lost two signups outright.

     THE FAILURE IT FIXES. onAuth() fires both writes this file makes -- the
     retention ping AND the signup attribution -- and BOTH begin by calling this
     function. When it returns null they both `return` silently: no row, no
     error, no retry marker, nothing recorded anywhere that it happened. Measured
     2026-08-23 across every confirmed post-deploy signup: 17 accounts have BOTH
     an ad_attribution and a user_activity row, 2 accounts have NEITHER. Perfect
     separation, which is what a single shared dependency looks like. Two known
     ways for the storage read to come back empty while the session is perfectly
     valid: (a) storage blocked or partitioned -- an in-app WebView, private
     mode, a privacy browser; (b) supabase-js has not yet persisted the session
     at the instant auth.js fires `thaiear:auth`.

     ⚠ THE localStorage SCAN BELOW STAYS, AS THE FALLBACK. attrib.js loads BEFORE
     auth.js on /start (and via nav.js elsewhere), so on an early call
     window.ThaiEarAuth may not exist yet, and auth.js resolves its session
     asynchronously in any case -- getAccessToken() legitimately returns null for
     the first moments of a page load. Removing the scan would trade one silent
     hole for another. Try memory, then disk, then give up.

     ⚠ Do NOT reach into auth.js's private `currentSession` directly. The public
     getter is the contract; the closure variable is not (same reasoning as the
     ownersim note in auth.js -- reading privates is what silently breaks it). */
  function memToken() {
    return ls(function () {
      var A = window.ThaiEarAuth;
      return (A && typeof A.getAccessToken === 'function' && A.getAccessToken()) || null;
    }, null);
  }

  function accessToken() {
    return memToken() || ls(function () {
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

  /* ---------- 2b. retention ping --------------------------------------
     Answers the one question nothing else can: what share of accounts are seen
     on a day AFTER they signed up. See RETENTION_MEASUREMENT.md.

     ⚠ NOTHING IS STORED ON THE DEVICE. Both guards below are in memory, and the
     server decides what counts as a new day or a new session from last_seen_at.
     That is what keeps this outside PECR reg 6 and therefore consent-free --
     unlike the click capture above, which needed a gate. Do NOT "improve" this
     with a sessionStorage flag.

     ⚠ It must never be awaited, never retried, and never surface an error. A
     missed ping is worth nothing; a slowed page load is worth less than nothing. */
  /* ⚠ 30s, NOT 5 MINUTES (changed 2026-08-21). Plays inside the window live only in
     memory until something flushes them, so the window IS the amount of listening a bad
     exit can destroy -- an app kill or a crash gives neither pagehide nor
     visibilitychange. Five minutes was chosen defensively against a request-volume
     problem this site does not have: 30s costs at most 2 POSTs per minute per ACTIVELY
     LISTENING user, and the site has ~50 accounts. Raise it again if Supabase round trips
     ever become a real line item -- /api/seen makes two per ping (verify + upsert). */
  var SEEN_THROTTLE_MS = 30 * 1000;
  var seenSent = false;          // the plain once-per-page-load ping
  var lastSeenPing = 0;          // throttle for the listen pings
  var pendingListens = 0;        // plays counted but not yet sent
  var tallySent = false;         // has ANY listen tally left this page load yet?

  /* The only thing that actually sends. Kept separate from the decision to send,
     because a forced flush must not disturb the tally it is flushing. */
  function sendSeen() {
    var tok = accessToken();
    if (!tok) return;                                 // signed out: nothing to record
    lastSeenPing = Date.now();

    var body = {};
    if (pendingListens > 0) { body.listen = true; body.count = pendingListens; pendingListens = 0; }

    ls(function () {
      fetch('/api/seen', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,                              // survives the navigation that triggered it
      }).catch(function () {});                       // offline or down: drop it, silently
    });
  }

  /* `kind` is one of:
       'load'  — the once-per-page-load ping
       'touch' — refresh last_seen_at only, no tally (see onPlay)
       a NUMBER — that many SENTENCES were heard

     ⚠⚠ `listens` COUNTS SENTENCES, NOT AUDIO STARTS (changed 2026-08-20, PLAYS_COUNTER.md).
     It used to increment straight off the media `play` event, which was wrong in both
     directions on the dyn player: a built session is ONE mp3 on ONE audio element, so
     listening straight through a 32-sentence topic recorded **1**, while five pause/resumes
     recorded **6**. It now increments from the same place `sentence_plays` does — the
     `.dyn-live` card becoming live, gated by the same 2s-or-clip-end dwell — so listening
     through 32 sentences reads 32, and three Thai repeats of one sentence still read 1.

     ⚠ BOTH COUNTERS MUST FIRE FROM THE SAME EVENT AND THE SAME GATE. player.js calls
     notePlaySentence() once per sentence and that function drives both. If one ever counted
     without the dwell they would drift apart permanently for a reason nobody could
     reconstruct.

     ⚠ THE INVARIANT IS ABOUT INCREMENTS, NOT TOTALS, and stating it absolutely misleads anyone
     who checks. From v357 onward every increment to `listens` is the same increment applied to
     `sentence_plays.reps` (the REPETITIONS counter since v368 — four Thai repeats are four
     listens, not one). But the running totals do NOT match on an existing row: `listens`
     accumulated under the old audio-STARTS semantics before v357 and was never reset. Measured
     live on 2026-08-20: listens 122 against a sum of 71. That is history, not a bug. */
  function postSeen(kind) {
    if (!accessToken()) return;
    var now = Date.now();

    /* ⚠ COUNT FIRST, SEND LATER. A naive throttle made `listens` a count of
       five-minute WINDOWS rather than of sentences: three inside one window sent
       one ping, and on a long listen that undercounts by about 3x. Tally them in
       memory and hand the tally to whichever ping goes next, so the requests stay
       bounded and the number stays true. */
    if (typeof kind === 'number') {
      pendingListens += kind;
      /* ⭐ THE FIRST SENTENCE OF A PAGE LOAD ALWAYS SENDS, throttle or not.
         The single most valuable fact about a visitor is whether they played ANYTHING,
         and under a pure throttle that fact is the one most easily lost: the page-load
         ping starts the window, so the first play is always inside it and lives only in
         memory. Measured 2026-08-21 -- of eleven signups, four recorded zero listens, and
         for at least one of them a lost tally is a better explanation than not listening.
         Everything AFTER the first is throttled as before, so a long session still costs
         two requests a minute, not one per clip. */
      if (tallySent && now - lastSeenPing < SEEN_THROTTLE_MS) return;
      tallySent = true;
    } else if (kind === 'touch') {
      /* Refresh last_seen_at WITHOUT tallying, so that a LONG UNINTERRUPTED LISTEN is
         not mistaken for a second session. /api/seen only hears from us on a page load
         otherwise, so someone who opens one topic and listens for 40 minutes would look
         like a 40-minute absence. One request per 5 minutes, not per play.
         ⚠ This is why onPlay still fires at all. It matters most on the READ arm, whose
         audio is not sentences and so contributes nothing to the tally — without this
         touch, a long reading session would be counted as two visits. */
      if (now - lastSeenPing < SEEN_THROTTLE_MS) return;
    } else {
      if (seenSent) return;                           // auth.js notifies 3-4x per load
      seenSent = true;
    }
    sendSeen();
  }

  /* ⚠⚠ FLUSH BEFORE THE PAGE GOES, OR MOST LISTENING IS NEVER RECORDED.
     Plays inside the throttle window live only in memory, and a navigation
     re-executes this whole file with the tally reset. Walked through:
       0:00 load -> ping.  0:30/1:00/1:30 play three clips -> all throttled.
       2:00 navigate -> pendingListens resets. THREE CLIPS PLAYED, ZERO RECORDED.
     Moving to the next topic inside five minutes is completely ordinary, so this
     was not an edge case, it was the common one. `keepalive` on the fetch is what
     lets the POST outlive the page; nothing was firing it.
     ⚠ `pagehide` AND `visibilitychange`, because iOS Safari frequently gives no
     pagehide when the user switches apps or locks the phone. */
  function flushSeen() {
    if (pendingListens > 0) sendSeen();
  }

  /* ---------- 3. signup ------------------------------------------------ */

  var inFlight = {};                                // user id -> a POST is already going out

  function onAuth(ev) {
    var user = ev && ev.detail;
    if (!user || !user.id) return;

    /* ⚠ THE RETENTION PING RUNS FIRST AND DEPENDS ON NOTHING ELSE. It fires for every
       signed-in load, not only new accounts, and deliberately does NOT require
       created_at -- a missing created_at is exactly what killed ad attribution for
       weeks (v338), and this must not be able to die the same way. */
    postSeen('load');

    if (!user.created_at) return;

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
    /* Stored click first: when consent IS granted it is the richer record (real referrer,
       real click time, and it survives navigation away from the landing page). The URL is the
       fallback that works when the gate is shut -- i.e. right now, on every signup. */
    var hit = stored() || fromUrl() || {};

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
        /* ⚠⚠ KEEPALIVE IS LOAD-BEARING ON /start, AND ONLY THERE (added 2026-08-20).
           /start is the only page that navigates away BY ITSELF after sign-in -- render()
           calls location.replace(homeHref()) 900 ms after the auth event (600 ms on the code
           route). Without keepalive the browser cancels this request when the document goes,
           so a signup on the ads landing page -- the ONE page where a gclid actually exists --
           silently records nothing whenever the round trip loses that race. And the retry
           cannot save it: the page is gone, so no further `thaiear:auth` event ever fires.

           Observed live: of two confirmed signups in the 40 minutes after the capture shipped,
           one landed and one did not. Same code, different luck. The /api/seen ping thirty
           lines above has carried this flag since it was written, for exactly this reason.
           ⚠ Do not remove it to "match" the other fetches in this file. The body is a few
           hundred bytes, far inside the 64 KB keepalive limit. */
        keepalive: true,
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
    /* ⚠ 'touch', NOT a tally. Audio STARTING is no longer what `listens` counts — player.js
       reports sentences instead (see postSeen). This still fires so that last_seen_at keeps
       moving during a long listen, which is what stops one 40-minute session being recorded
       as two. Throttled to one request per 5 minutes. */
    postSeen('touch');
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

  /* ⭐ ON-LOAD RECONCILIATION (added 2026-08-23) --------------------------
     Everything this file writes hangs off ONE `thaiear:auth` event. Miss it and
     the page records nothing at all -- and there is no second chance, because the
     only retry is another page load: measured 2026-08-23, 13 of the 17 signups
     that DID record never returned to the site either. A one-shot success is the
     normal case here, not the lucky one, so the one shot has to be reliable.

     This is the backstop: if identity.js -- the synchronous pre-auth reader that
     every page already loads in <head> -- can see a signed-in user, drive onAuth
     once from that, without waiting to be told. `thaiear_identity` holds the FULL
     supabase user object (auth.js writeIdentity), so `created_at` is present and
     the attribution path is reachable, not just the retention ping.

     ⚠ SAFE TO DOUBLE-FIRE, BY CONSTRUCTION, AND THAT IS WHY IT NEEDS NO GUARD OF
     ITS OWN. If the real event also arrives, `inFlight` suppresses the duplicate
     signup POST and `seenSent` suppresses the duplicate load ping. Should one
     still get through, /api/attrib is keyed on user_id and treats 409 as success.
     Do NOT "tidy" this into a fired-once flag -- the existing guards are the ones
     that have to work anyway, and a second flag would only hide it when they stop.

     ⚠ It runs on a TIMEOUT, not inline. auth.js is deferred and resolves its
     session asynchronously, so at this point in the load memToken() is usually
     still null; firing immediately would mean the fallback races the very thing
     it is backing up and loses. One turn of the event loop after the page settles
     is enough for the normal path to have won, in which case the guards above
     make this a no-op.

     ⚠ This still reads localStorage (via identity.js), so it does NOT rescue a
     browser with storage genuinely blocked -- the in-memory token in
     accessToken() is the half that covers that. The two fixes are complementary
     and neither replaces the other. */
  setTimeout(function () {
    ls(function () {
      var I = window.ThaiEarIdentity;
      if (!I || typeof I.guess !== 'function') return;
      var g = I.guess();
      if (!g || g.state !== 'in' || !g.user || !g.user.id) return;
      onAuth({ detail: g.user });
    });
  }, 1500);

  document.addEventListener('play', onPlay, true);  // capture: media events don't bubble
  window.addEventListener('pagehide', flushSeen);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSeen();
  });

  window.ThaiEarAttrib = {
    /* Called by player.js's notePlaySentence(), once per sentence heard, already gated by the
       dwell rule. ⚠ This is the ONLY thing that may increment `listens` — see postSeen(). */
    noteListen: function (n) { postSeen(Math.max(1, parseInt(n, 10) || 1)); },
    click:  stored,                                 // what click is on file
    events: function () { return queue.slice(); },  // what would have been sent
    track:  track,
    send:   function () {},                         // replaced when the tag is installed
  };
})();
