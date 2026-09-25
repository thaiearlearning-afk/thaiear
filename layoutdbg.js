/* layoutdbg.js — LAYOUT FLASH / SHIFT DEBUGGER (owner-only). Keep this file.
   ------------------------------------------------------------------------------------------
   WHAT IT IS FOR. Any bug of the shape "something paints, then is replaced by something else"
   or "the page jumps once it loads". Those are invisible in a desktop browser and hard to catch
   by eye on a phone, and four blind attempts at one of them failed precisely because nobody
   could see what the DEVICE reported. This prints the sequence, with timings.
   (The project's rule, learned repeatedly: measure on the device. Inference has lost every time.)

   ── TURNING IT ON AND OFF ─────────────────────────────────────────────────────────────────
   ON   : it shows automatically for the owner while `te_layoutdbg` is not 'off'.
          Anywhere with an address bar you can also force it with ?layoutdbg=1.
   OFF  : tap ✕ on the overlay. That persists — it stays off on that device until re-armed.
   BACK : visit any page with ?layoutdbg=1 (web / desktop), or clear the key.
   ⚠ Once the owner hash has matched once on a device, it is remembered in te_layoutdbg_ok, so
     the tool KEEPS WORKING AFTER LOGOUT — the signed-out state is exactly what it is for.
   ⚠ The app and the installed PWA have NO ADDRESS BAR, so ?layoutdbg=1 does not exist there.
   That is why ON is the default rather than something you arm — on the two devices where these
   bugs actually appear, an arm-by-URL switch would make the tool unreachable.

   ── HOW IT IS GATED ───────────────────────────────────────────────────────────────────────
   Same two-stage gate as ownersim.js: the localStorage flag decides whether the file is
   FETCHED, the ACCOUNT decides whether it does anything.
   ⚠ The owner check reads `thaiear_identity`, NOT getUser(). That record survives sign-out, so
   the probe keeps working in the signed-OUT state — which matters, because several of these
   bugs ONLY appear when signed out, and a gate needing a live session could never see them.
   For anyone else: no overlay, no listeners, no cost.

   ── WHAT IT SHOWS ─────────────────────────────────────────────────────────────────────────
   One line per DISTINCT state, so the ORDER is visible rather than the end state: isReady,
   whether getUser() has a user, whether auth is running on the durable identity, which of the
   two localStorage records exist, and what the progress slot / offline bar are rendering at
   that instant. Polls at 40ms for 12s then stops by itself. "copy" puts the log on the
   clipboard. Extend snap() when you need a different element in the trace. */
(function () {
  'use strict';
  if (window.__teAuthDbg) return;
  window.__teAuthDbg = true;

  /* ⚠ ONE ACCOUNT ONLY (owner, 2026-08-27). The second address was removed so that the
     other account sees the site exactly as a normal member does — no owner card, no panel,
     no unlisted section. Adding an account back means adding its SHA-256 here; the plain
     address must never appear in the file (Golden Rule 0 covers the owner's own too). */
  var OWNER_SHA = [
    'f158e8ba0177149ebd33d06f08ac400709d39133f9f366f7bdb3ac17bcb1c171'
  ];
  function realEmail() {
    try {
      var id = JSON.parse(localStorage.getItem('thaiear_identity') || 'null');
      var e = id && id.user && id.user.email;
      return e ? String(e).trim().toLowerCase() : '';
    } catch (_) { return ''; }
  }
  function checkOwner() {
    var e = realEmail(), sub, enc;
    try {
      sub = window.crypto && window.crypto.subtle;
      enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
    } catch (_) { return Promise.resolve(false); }
    if (!e || !sub || !enc) return Promise.resolve(false);
    return sub.digest('SHA-256', enc.encode(e)).then(function (buf) {
      var h = Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return (b + 0x100).toString(16).slice(1);
      }).join('');
      return OWNER_SHA.indexOf(h) >= 0;
    }).catch(function () { return false; });
  }

  /* ⚠ THE RECORDER LIVES IN player.js, NOT HERE — see the block at the top of that file.
     This file is injected by nav.js, which runs LAST on a topic page, so by the time it exists
     auth has already resolved and any flash is over. It renders window.__teLayoutLog, which was
     being filled from before the player mounted. Do not move recording back into this file. */
  /* ── SHIFTS + TEXT SCALE (2026-09-25) ───────────────────────────────────────────────────
     For "it loads, then gets a few px taller" on surfaces with no recorder of their own (the
     band pages, Favourites, the grammar hub — the player.js recorder exists only on unit
     pages). Chromium keeps a BUFFERED record of every layout shift since navigation start, so a
     late-injected file like this one still sees the first paint: `buffered: true` replays them.
     Each source says which element moved and its box before → after, so a card growing reads as
     its own height changing and everything below it moving down.
     ⚠ Android WebView / Chrome only — WebKit has no layout-shift entries, so the iPhone shows
     "(no layout-shift API)". Shifts within 500ms of a tap are flagged `input` and are not bugs.
     The scale line is what nav.js's uiScale() measured: --te-ui below 1 means every card was
     first painted at 1 and then re-sized when nav.js (deferred) ran — TEXT_SCALING.md §2. */
  var shifts = [];
  function nodeName(n) {
    if (!n || !n.tagName) return '?';
    var s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    else if (typeof n.className === 'string' && n.className.trim()) s += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
    var page = n.getAttribute && n.getAttribute('data-page');
    if (page) s += '[' + page.replace(/\.html$/, '') + ']';
    return s;
  }
  function r4(r) { return r ? Math.round(r.y) + '/' + Math.round(r.height) + 'h' : '-'; }
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        /* The overlay grows as it fills and would log itself — drop its own nodes. */
        var real = (e.sources || []).filter(function (s) {
          return !(s.node && s.node.closest && s.node.closest('#te-layout-dbg'));
        });
        if (e.sources && e.sources.length && !real.length) return;
        var src = real.slice(0, 4).map(function (s) {
          return '      ' + nodeName(s.node) + '  y/h ' + r4(s.previousRect) + ' -> ' + r4(s.currentRect);
        });
        shifts.push('SHIFT +' + String(Math.round(e.startTime)).padStart(5) + 'ms  score ' +
          e.value.toFixed(4) + (e.hadRecentInput ? '  (input)' : ''));
        shifts = shifts.concat(src);
      });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (_) { shifts.push('(no layout-shift API on this browser)'); }
  function scaleLine() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var U = window.ThaiEarUIScale;
      return 'SCALE  measured ' + (U ? U.raw().toFixed(3) : '?') +
        '  --te-ui ' + (cs.getPropertyValue('--te-ui').trim() || 'unset(=1)') +
        '  --te-ui-raw ' + (cs.getPropertyValue('--te-ui-raw').trim() || 'unset(=1)') +
        '  width ' + window.innerWidth + '  dpr ' + window.devicePixelRatio;
    } catch (_) { return 'SCALE ?'; }
  }
  function cardLine() {
    var cards = document.querySelectorAll('.topic-grid .topic-card');
    if (!cards.length) return null;
    var hs = {};
    for (var i = 0; i < cards.length; i++) hs[Math.round(cards[i].getBoundingClientRect().height * 10) / 10] = 1;
    return 'CARDS  ' + cards.length + ' now, heights ' + Object.keys(hs).join(' / ') + 'px';
  }

  /* ── WHICH PART OF A CARD MOVED (2026-09-25, Pixel 7a: every card +2.6px at ~370ms) ──────
     A shift entry names the elements that MOVED, not the one that grew. So: the first card's
     parts, re-measured on every DOM change and every frame for 6s, one line per distinct state.
     Plus the facts that decide the theories — when this file started (if AFTER the shift, the
     part log begins in the settled state and says so), first paint, and when each font file
     arrived and whether it is in use (font-display:optional can paint the fallback first). */
  var t0 = Math.round(performance.now());
  var partLog = [], lastParts = '';
  var PARTS = [['pill', '.topic-card-top'], ['name', '.topic-card-link'], ['meta', '.topic-meta-row'],
               ['plays', '.topic-plays'], ['strip', '.topic-quiz']];
  function partSnap(tag) {
    var card = document.querySelector('.topic-grid .topic-card');
    if (!card) return;
    var h = function (el) { return el ? (Math.round(el.getBoundingClientRect().height * 10) / 10) : '-'; };
    var s = 'card ' + h(card) + ' = ' + PARTS.map(function (p) { return p[0] + ' ' + h(card.querySelector(p[1])); }).join(' · ') +
      ' | html ' + ['te-dl', 'te-plays'].filter(function (c) { return document.documentElement.classList.contains(c); }).join(',');
    if (s === lastParts) return;
    lastParts = s;
    partLog.push('+' + String(Math.round(performance.now())).padStart(5) + 'ms ' + s + (tag ? '  <' + tag + '>' : ''));
  }
  try {
    partSnap('probe start');
    new MutationObserver(function () { partSnap(''); })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    var tEnd = performance.now() + 6000;
    (function loop() { partSnap(''); if (performance.now() < tEnd) requestAnimationFrame(loop); })();
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', function () { partSnap('fonts loadingdone'); });
    }
  } catch (_) {}
  function timingLines() {
    var out = [];
    try {
      var fcp = performance.getEntriesByType('paint').filter(function (e) { return e.name === 'first-contentful-paint'; })[0];
      out.push('TIMING probe started +' + t0 + 'ms · first paint ' + (fcp ? '+' + Math.round(fcp.startTime) + 'ms' : '?'));
      performance.getEntriesByType('resource').filter(function (e) { return /\.woff2?(\?|$)/.test(e.name); })
        .forEach(function (e) {
          out.push('FONT   ' + e.name.split('/').pop().split('?')[0] + ' done +' + Math.round(e.responseEnd) + 'ms' +
            (e.transferSize === 0 ? ' (cache)' : ''));
        });
      if (document.fonts) {
        var used = [];
        document.fonts.forEach(function (f) { if (f.status === 'loaded') used.push(f.family.replace(/"/g, '') + ' ' + f.weight); });
        out.push('FONTS  loaded: ' + (used.join(', ') || 'none') + ' · status ' + document.fonts.status);
      }
    } catch (_) {}
    return out;
  }

  function lines() {
    var out = (window.__teLayoutLog || []).slice();
    out.push(scaleLine());
    var c = cardLine(); if (c) out.push(c);
    out = out.concat(timingLines());
    if (partLog.length) out = out.concat(['--- first card, part heights (px) ---'], partLog);
    out.push(shifts.length ? '--- layout shifts since page start ---' : '--- no layout shifts recorded ---');
    return out.concat(shifts);
  }
  var box = null;

  function paint() {
    if (!box) return;
    box.textContent = lines().join('\n');
  }

  function mount() {
    box = document.createElement('pre');
    box.id = 'te-layout-dbg';
    box.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;margin:0;max-height:45vh;' +
      'overflow:auto;background:rgba(0,0,0,.88);color:#8f8;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;' +
      'padding:8px 10px 10px;white-space:pre;-webkit-overflow-scrolling:touch';
    var hide = document.createElement('button');
    hide.textContent = '✕';
    hide.title = 'Hide (stays off on this device until re-armed with ?layoutdbg=1)';
    hide.style.cssText = 'position:fixed;left:8px;bottom:calc(45vh + 6px);z-index:2147483647;' +
      'font:12px system-ui;padding:6px 12px;border-radius:6px;border:0;background:#555;color:#fff';
    hide.onclick = function () {
      try { localStorage.setItem('te_layoutdbg', 'off'); } catch (_) {}
      [box, close, hide].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    };
    var close = document.createElement('button');
    close.textContent = 'copy';
    close.style.cssText = 'position:fixed;right:8px;bottom:calc(45vh + 6px);z-index:2147483647;' +
      'font:12px system-ui;padding:6px 12px;border-radius:6px;border:0;background:#261B65;color:#fff';
    close.onclick = function () {
      try { navigator.clipboard.writeText(lines().join('\n')); close.textContent = 'copied'; }
      catch (_) { close.textContent = 'select manually'; }
    };
    (document.body || document.documentElement).appendChild(box);
    (document.body || document.documentElement).appendChild(close);
    (document.body || document.documentElement).appendChild(hide);
    paint();

    /* Poll rather than rely on events: the whole question is what happens BETWEEN them, and a
       missed transition is the one that matters. 40ms for 12s is plenty to catch a 1200ms race
       and a swap, and it stops on its own so it cannot sit burning battery. */
    /* Repaint while the recorder is still collecting. The recorder stops itself at 15s. */
    var iv = setInterval(paint, 150);
    setTimeout(function () { clearInterval(iv); paint(); }, 16000);
  }

  function armed() {
    try {
      if (/[?&]layoutdbg=1/.test(location.search)) { localStorage.setItem('te_layoutdbg', 'on'); return true; }
      return localStorage.getItem('te_layoutdbg') !== 'off';
    } catch (_) { return true; }
  }
  /* ⚠ REMEMBER THAT THE OWNER WAS VERIFIED — thaiear_identity does NOT survive an explicit
     logout. auth.js's clearIdentity() removes it and raises the signed-out marker, so a gate
     reading only that record vanished the moment the owner signed out (reported 2026-08-15) —
     which is precisely when several of these bugs appear. It survives a session EXPIRY, not a
     deliberate sign-out; those are different things and this depended on the wrong one.
     So once the hash has matched on this device, keep our own key. It is ours, so nothing in the
     auth flow clears it, and ?layoutdbg=0 / the ✕ still turn the tool off.
     Privacy, not security — same reasoning as ownersim.js: a stranger who set this by hand would
     see a readout of their OWN auth state and nothing else. */
  var OK_KEY = 'te_layoutdbg_ok';
  function remember() { try { localStorage.setItem(OK_KEY, '1'); } catch (_) {} }
  function wasOwner() { try { return localStorage.getItem(OK_KEY) === '1'; } catch (_) { return false; } }

  if (armed()) {
    if (wasOwner()) mount();
    else checkOwner().then(function (ok) { if (ok) { remember(); mount(); } });
  }
})();
