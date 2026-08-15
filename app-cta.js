/* app-cta.js — "Study ThaiEar offline" APP CARD (owner-approved 2026-08-11).

   WHAT THIS IS FOR. Offline download is app/installed-PWA only (§1f): the Android app and an
   installed home-screen PWA get the download controls, and a plain browser tab — desktop or
   phone — gets nothing at all, the layout simply closing over the gap. So the single biggest
   reason to install anything was invisible to exactly the visitors who had not installed it.
   This card fills that space instead: same slot, same width, pointing at app.html.

   FOUR SURFACES, ONE SOURCE. It appears wherever a download control is withheld:
     1. topic page          player.js  renderOfflineBar()   (#offline-bar)
     2. index / Topics      index.html the te-no-dl block   (before #dl-batch-bar)
     3. index / Playlists   pl-list.js the te-no-dl block   (before #dl-batch-bar)
     4. Read Thai hub       read.js    mountDlCard()        (the .read-dl slot)
   Each call site keeps its OWN "can this device download?" predicate and renders this in the
   else-branch, so exactly one of the two always appears and the two can never both show. The
   markup, the copy and the CSS live here and only here — §B8's lesson is that a rule shared by
   several surfaces drifts the moment each surface carries its own copy of it.

   ⚠ THE COPY IS DELIBERATELY NOT "get the app" (owner, 2026-08-11). On iPhone there IS no App
   Store app — the offline route is Add to Home Screen (see app.html). A title or button that
   promises "the app" is a promise that half the audience arrives to find unkept, so the title
   names the BENEFIT, the body names BOTH REAL ROUTES, and the control is a bare chevron. Do not
   "tighten" the body back to "free on Android and iPhone": that phrasing was rejected for making
   the same overpromise more quietly. */
(function () {
  'use strict';
  if (window.ThaiEarAppCTA) return;        // script included twice — the export is already there

  var STYLE_ID = 'te-appcta-css';
  var HREF = 'app.html';

  /* Title + platform line are shared; only the first clause changes, naming what THIS surface
     would have let the visitor download. */
  var TITLE = 'Study ThaiEar offline';
  var PLATFORMS = 'Free on the Android app, or add ThaiEar to your iPhone Home Screen.';
  var SURFACE = {
    topic:    'Download this topic and listen with no internet.',
    index:    'Download whole topics and listen with no internet.',
    playlist: 'Download your playlists and listen with no internet.',
    read:     'Take the whole course offline and learn with no internet.'
  };

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10.5 5h3"/>' +
      '<path d="M12 8v6"/><path d="M9 11l3 3 3-3"/></svg>';
  var CHEV =
    '<svg class="te-appcta-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="9 18 15 12 9 6"/></svg>';

  /* Card skin, chosen over a quieter hairline row and a solid-accent CTA (owner: "not too light
     — missable — not too dark — in your face"). Deliberately the same visual language as the Read
     Thai "Take the course offline" card it stands in for: --accent-light ground, hairline border,
     rounded icon tile. Plain px type, no calc(… * var(--te-ui)) — matching .read-dl and
     .dl-batch-bar, its neighbours in every slot. Under text inflation the row WRAPS rather than
     being capped, which is what keeps it WCAG 1.4.4-clean (see TEXT_SCALING.md).
     The per-slot margins live here too, each matching the control this replaces, so spacing is
     one file's problem rather than four. */
  var CSS =
    '.te-appcta{display:block;text-decoration:none;-webkit-tap-highlight-color:transparent;' +
      'background:var(--accent-light);border:0.5px solid var(--border);border-radius:var(--radius-lg);' +
      'padding:1.05rem 1.2rem;transition:border-color .15s,background .15s}' +
    '.te-appcta:hover{border-color:var(--accent);background:#E7E5FD}' +
    '.te-appcta-row{display:flex;align-items:center;gap:14px}' +
    '.te-appcta-ico{flex-shrink:0;width:34px;height:34px;padding:7px;border-radius:10px;' +
      'background:var(--accent);color:#fff;display:inline-flex;align-items:center;justify-content:center}' +
    '.te-appcta-ico svg{width:100%;height:100%}' +
    '.te-appcta-text{min-width:0;flex:1}' +
    '.te-appcta-title{display:block;font-size:14.5px;font-weight:600;letter-spacing:-0.005em;' +
      'color:var(--text-primary);margin-bottom:2px}' +
    '.te-appcta-desc{display:block;font-size:13px;line-height:1.5;color:var(--text-secondary)}' +
    '.te-appcta-chev{flex-shrink:0;width:18px;height:18px;color:var(--text-tertiary);transition:color .15s}' +
    '.te-appcta:hover .te-appcta-chev{color:var(--accent)}' +
    /* per-slot spacing — each matches the control it stands in for */
    '.te-appcta--index{margin:0 0 0.9rem}' +
    '.te-appcta--playlist{margin:0 0 1rem}' +
    '.te-appcta--read{margin:1.5rem 0 0.25rem}' +
    /* topic page: #offline-bar is a flex ROW built for small buttons — the card needs the whole
       width, and the row's -0.75rem lift would tuck it under the player. */
    '.offline-bar.te-appcta-host{display:block;margin:0 0 1.25rem}' +
    /* ---- SIGNED-OUT SIGNUP CARD (2026-08-15) — one card, two zones ----
       Same slot as the app card, and mutually exclusive with it: signed out gets this, signed in
       gets the plain app card. Zone 1 asks for the account, zone 2 keeps conveying that a real
       app exists (credibility the ask benefits from) WITHOUT advertising it twice on one screen.
       ⚠ Self-contained on purpose. The first version leaned on .prog-ctl-card for its ground and
       border, which exists only in player.js's STYLES — so it rendered unstyled on index.html,
       which does not load player.js. Do not reintroduce that dependency.
       ⚠ Zone 2's wording is the app card's, verbatim, and is bound by the same copy rule above. */
    /* ⚠ ACCENT-LIGHT GROUND, not --surface (owner, 2026-08-15): on plain white the card read
       as "a paragraph of words" and was easy to skip. Same ground as the app card it replaces,
       so the two are visually interchangeable in the slot they share. */
    '.te-signup{background:var(--accent-light);border:0.5px solid var(--border);' +
      'border-radius:var(--radius-lg);overflow:hidden}' +
    '.te-signup-main{padding:0.7rem 0.9rem 0.65rem}' +
    '.te-signup-title{display:block;font-size:14.5px;font-weight:600;letter-spacing:-0.005em;' +
      'color:var(--text-primary);margin-bottom:3px}' +
    '.te-signup-desc{display:block;font-size:13px;line-height:1.5;color:var(--text-secondary);margin-bottom:8px}' +
    /* A FILLED BUTTON, not a text link — the other half of "easily ignored". */
    '.te-signup-cta{display:inline-block;font-size:13px;font-weight:600;color:#fff;' +
      'background:var(--accent);border-radius:var(--radius-sm);padding:8px 14px;text-decoration:none;' +
      'transition:background .15s}' +
    '.te-signup-cta:hover{background:var(--accent-mid);color:#fff}' +
    '.te-signup-app{display:flex;align-items:center;gap:10px;padding:0.6rem 0.9rem;' +
      'border-top:0.5px solid var(--border-strong);text-decoration:none;-webkit-tap-highlight-color:transparent}' +
    '.te-signup-app:hover .te-signup-chev{color:var(--accent)}' +
    '.te-signup-app-txt{min-width:0;flex:1}' +   /* min-width:0 → the desc wraps, never pushes the chevron out */
    '.te-signup-app-t{display:block;font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:1px}' +
    '.te-signup-app-d{display:block;font-size:12.5px;line-height:1.45;color:var(--text-secondary)}' +
    '.te-signup-chev{flex-shrink:0;width:16px;height:16px;color:var(--text-tertiary);transition:color .15s}' +
    /* per-slot spacing, mirroring the app card's */
    '.te-signup--index{margin:0 0 0.9rem}' +
    '.te-signup--playlist{margin:0 0 1rem}' +
    '.te-signup--read{margin:1.5rem 0 0.25rem}' +
    '.offline-bar.te-signup-host{display:block;margin:0 0 1.25rem}';

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // Is this a plain browser tab — i.e. a device with no download UI? Provided for call sites that
  // do NOT already own a predicate; the four in-tree ones all do, and keep theirs.
  function noDownloadUi() {
    var C = window.Capacitor;
    if (!C && window.parent && window.parent !== window) { try { C = window.parent.Capacitor; } catch (_) {} }
    var native = !!(C && C.isNativePlatform && C.isNativePlatform());
    var standalone = false;
    try {
      standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
                   window.navigator.standalone === true;
    } catch (_) {}
    return !(native || standalone);
  }

  function html(surface) {
    injectCss();
    return '<a class="te-appcta te-appcta--' + surface + '" href="' + HREF + '">' +
      '<span class="te-appcta-row">' +
        '<span class="te-appcta-ico">' + ICON + '</span>' +
        '<span class="te-appcta-text">' +
          '<span class="te-appcta-title">' + TITLE + '</span>' +
          '<span class="te-appcta-desc">' + SURFACE[surface] + ' ' + PLATFORMS + '</span>' +
        '</span>' + CHEV +
      '</span>' +
    '</a>';
  }
  function el(surface) {
    var d = document.createElement('div');
    d.innerHTML = html(surface);
    return d.firstChild;
  }

  /* ---- the signed-out variant: signup ask + the app line, in one card ----
     `next` is the page to return to after sign-in, and is optional — index.html has nowhere
     particular to send anyone back to. ⚠ join.html's nextUrl() accepts a bare clean-URL segment
     with an optional .html and strips any ?query, so pass the page name, not a full URL. */
  /* Per-surface copy. Zone 1 names what an account actually saves HERE — the reading course keeps
     quiz results, not listens or playlists, so the generic line was simply wrong there (owner,
     2026-08-15). Zone 2's title names what there is to download on this surface. */
  var SIGNUP_DESC = {
    topic:    'A free account keeps track of what you’ve listened to and lets you build playlists.',
    index:    'A free account keeps track of what you’ve listened to and lets you build playlists.',
    playlist: 'A free account keeps track of what you’ve listened to and lets you build playlists.',
    read:     'A free account keeps track of your reading course quiz results.'
  };
  var SIGNUP_APP_TITLE = {
    topic:    'Study offline — download audio by topic',
    index:    'Study offline — download audio by topic',
    playlist: 'Study offline — download playlists',
    read:     'Study offline — download the reading course'
  };

  /* ⚠ ZONE 2 IS OMITTED IN THE APP AND THE INSTALLED PWA (owner, 2026-08-15).
     Telling someone already inside the app to go and get the app is noise, and the download
     controls they would use are on the same screen. Everything else is identical, so a signed-out
     app user sees the same ask as a signed-out web user, minus the part that does not apply.
     noDownloadUi() is the same predicate every call site already uses to decide app vs browser —
     do not introduce a second one. */
  function signupHtml(surface, next, opts) {
    injectCss();
    var href = 'join.html?feature=1' + (next ? '&next=' + encodeURIComponent(next) : '');
    var withApp = (opts && typeof opts.app === 'boolean') ? opts.app : noDownloadUi();
    var desc = SIGNUP_DESC[surface] || SIGNUP_DESC.topic;
    var appT = SIGNUP_APP_TITLE[surface] || SIGNUP_APP_TITLE.topic;
    return '<div class="te-signup te-signup--' + surface + (withApp ? '' : ' te-signup--noapp') + '">' +
      '<div class="te-signup-main">' +
        '<span class="te-signup-title">Save your progress</span>' +
        '<span class="te-signup-desc">' + desc + '</span>' +
        '<a class="te-signup-cta" href="' + href + '">Create a free account →</a>' +
      '</div>' +
      (withApp
        ? '<a class="te-signup-app" href="' + HREF + '">' +
            '<span class="te-signup-app-txt">' +
              '<span class="te-signup-app-t">' + appT + '</span>' +
              '<span class="te-signup-app-d">' + PLATFORMS.replace(/\.$/, '') + '</span>' +
            '</span>' + CHEV.replace('te-appcta-chev', 'te-signup-chev') +
          '</a>'
        : '') +
    '</div>';
  }
  function signupEl(surface, next) {
    var d = document.createElement('div');
    d.innerHTML = signupHtml(surface, next);
    return d.firstChild;
  }
  function insertSignupBefore(anchor, surface, next) {
    if (!anchor || !anchor.parentNode) return null;
    var node = signupEl(surface, next);
    anchor.parentNode.insertBefore(node, anchor);
    return node;
  }

  /* THE ONE ENTRY POINT ALL FOUR SURFACES SHOULD USE. Signed out gets the signup card (which
     carries the app line in its second zone), signed in gets the plain app card. Keeping the
     choice here rather than at each call site is the same reasoning as the header comment: a rule
     shared by four surfaces drifts the moment each one holds its own copy of it. */
  function insertAutoBefore(anchor, surface, next) {
    return authGuess() === 'out' ? insertSignupBefore(anchor, surface, next)
                                 : insertBefore(anchor, surface);
  }

  /* ⚠ HOLD UNTIL AUTH RESOLVES — do NOT paint the app card while `isReady` is false.
     The two cards are chosen by sign-in state, so rendering either one early means repainting it
     a moment later. That is exactly the blue flash the owner saw on mobile (2026-08-15): the app
     card painted first, then `thaiear:auth` fired and swapped in the signup card.
     Safe to wait: auth.js sets isReady on BOTH its success path and its durable-identity failure
     path, so this always resolves — it is never a permanent hold. */
  function authState() {
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) return 'pending';
    return (a.getUser && a.getUser()) ? 'in' : 'out';
  }

  /* ---- SYNCHRONOUS auth GUESS, so the right card can render at first paint ----
     Holding until auth resolved removed the flash but left the slot empty meanwhile, so the card
     landed late and shoved the playlist row down — owner-reported 2026-08-15, and the reason a
     plain "hold" is not enough.

     Reserving a height instead does not work either: the signup card and the app card differ by
     60–80px at every width (measured: 198 vs 118.6 at 430px), so any single reserve is wrong for
     one of them and shows as a gap.

     So: read the SAME durable evidence auth.js itself falls back to when supabase is unavailable
     — our own identity record, minus the explicit signed-out marker. It is written at sign-in and
     cleared at sign-out, so it is right for every returning visitor and every fresh one; the only
     way to be wrong is a session that expired server-side since the last visit, which then costs
     exactly one swap when auth settles.

     ⚠ Read localStorage DIRECTLY rather than calling into auth.js: this has to answer before
     auth.js has finished loading, which is the entire point. The two key names must stay in step
     with ID_KEY / SIGNED_OUT_KEY in auth.js. */
  function authGuess() {
    var st = authState();
    if (st !== 'pending') return st;                 // real answer beats the guess
    try {
      if (localStorage.getItem('thaiear_signed_out') === '1') return 'out';
      return localStorage.getItem('thaiear_identity') ? 'in' : 'out';
    } catch (_) { return 'out'; }
  }
  // Put the card where the withheld control would have been. No-op on a missing anchor, so a
  // call site whose markup changed shape fails quiet rather than throwing mid-render.
  function insertBefore(anchor, surface) {
    if (!anchor || !anchor.parentNode) return null;
    var node = el(surface);
    anchor.parentNode.insertBefore(node, anchor);
    return node;
  }

  window.ThaiEarAppCTA = {
    html: html,
    el: el,
    insertBefore: insertBefore,
    injectCss: injectCss,
    noDownloadUi: noDownloadUi,
    signupHtml: signupHtml,
    signupEl: signupEl,
    insertSignupBefore: insertSignupBefore,
    insertAutoBefore: insertAutoBefore,
    authState: authState,
    authGuess: authGuess
  };
})();
