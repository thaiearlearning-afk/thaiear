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
    '.offline-bar.te-appcta-host{display:block;margin:0 0 1.25rem}';

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
    noDownloadUi: noDownloadUi
  };
})();
