/* ============================================================
   player.js — SINGLE SOURCE OF TRUTH for the ThaiEar topic player.
   ------------------------------------------------------------
   Every topic page is identical except for two things: which MP3s
   it points at, and its sentence list. So the page supplies only
   that data and this file supplies everything else — the styles,
   the transport-bar markup, the sentence cards, and all behaviour.

   Each topic page must:
     1. define the design tokens + page-chrome CSS in its <head>
        (every page already does — :root, .page-wrap, .topic-*).
     2. declare its data BEFORE loading this file:
          <script>
            window.ThaiEarTopic = {
              audioPrefix: "Weather_BEG",   // {TopicShort}_{Level}
              sentences: [ { num, display?, preview, thai, english, gloss, cultural }, ... ]
            };
          </script>
     3. contain  <div id="player-root"></div>  where the player goes.
     4. load this file:  <script src="player.js" defer></script>

   To change how the player looks or behaves — or to add a control —
   you edit THIS FILE ONLY; every topic page updates at once.

   NEW BEHAVIOUR (2026-06): if the big top player is playing and you
   tap an individual sentence, the top player pauses for the duration
   of that sentence and then resumes from where it left off. See the
   "main-pause coordination" marks below.
   ============================================================ */

/* ── layoutdbg RECORDER (owner-only; renderer is layoutdbg.js) ────────────────────────────────
   ⚠ RECORDING AND RENDERING ARE SPLIT ON PURPOSE, and this is why. layoutdbg.js is injected by
   nav.js, which runs LAST on a topic page — after app-cta.js, player.js, topics.js, consent.js.
   By the time it loaded, auth had already resolved and the flash was over, so its first sample
   read `rdy=Y` at its own "0ms" and it recorded nothing at all while the owner could plainly see
   a flash (2026-08-15). A probe that starts after the event cannot see the event.
   This runs at the TOP of player.js instead — before the player mounts, before anything is
   painted into the slots — and timestamps against performance.now(), i.e. PAGE start, not script
   start. layoutdbg.js later just renders what this collected.
   Same two-stage gate as everything else: cheap flag check here, owner hash in the renderer. */
(function () {
  'use strict';
  try {
    if (localStorage.getItem('te_layoutdbg') === 'off') return;
    /* ⚠ 'on' counts too. nav.js writes te_layoutdbg='on' when it sees ?layoutdbg=1, but this gate
       only accepted te_layoutdbg_ok / an identity / the param itself — so arming by URL on one
       page left the RECORDER silent on the next, and the overlay then had nothing to show. */
    if (localStorage.getItem('te_layoutdbg') !== 'on' &&
        localStorage.getItem('te_layoutdbg_ok') !== '1' &&
        !localStorage.getItem('thaiear_identity') &&
        !/[?&]layoutdbg=1/.test(location.search)) return;
  } catch (_) { return; }
  var log = window.__teLayoutLog = (window.__teLayoutLog || []);
  var last = '';
  function has(k) { try { return localStorage.getItem(k) ? 'Y' : '-'; } catch (_) { return '?'; } }
  function snap(tag) {
    var a = window.ThaiEarAuth;
    var prog = document.getElementById('progress-controls');
    var bar = document.getElementById('offline-bar');
    var root = document.getElementById('player-root');
    var slot = !prog ? '-' : prog.querySelector('.te-signup') ? 'CARD'
      : (prog.innerHTML.trim() === '' ? 'empty' : '?');
    var obar = !bar ? '-' : bar.querySelector('.te-signup') ? 'CARD'
      : bar.querySelector('.te-appcta') ? 'APP'
      : (bar.style.display === 'none' ? 'hidden' : (bar.innerHTML.trim() === '' ? 'empty' : 'DL'));
    var rec = 'rdy=' + (a && a.isReady ? 'Y' : a ? 'N' : '-') +
      ' usr=' + (a && a.getUser && a.getUser() ? 'Y' : 'N') +
      ' id=' + has('thaiear_identity') + ' out=' + has('thaiear_signed_out') +
      ' | slot=' + slot + ' bar=' + obar +
      ' rootH=' + (root ? Math.round(root.getBoundingClientRect().height) : '-');
    if (rec === last) return;
    last = rec;
    log.push('+' + String(Math.round(performance.now())).padStart(5) + 'ms ' + rec + (tag ? '  <' + tag + '>' : ''));
  }
  /* ⚠ POLLING ALONE IS NOT ENOUGH, and that is why the first traces disagreed with what the
     owner could see. A 20ms poll misses anything shorter than 20ms, and bucketing the slot into
     CARD/BAR/empty hides a render this file has mislabelled. A MutationObserver fires on EVERY
     DOM change synchronously, so nothing can slip between samples, and recording the actual
     markup means the trace shows what really rendered rather than my classification of it. */
  function sig(el) {
    if (!el) return '-';
    var h = el.innerHTML.trim();
    if (!h) return 'EMPTY';
    var first = el.firstElementChild;
    return (first ? first.className || first.tagName : '?') + ' :: ' + h.replace(/\s+/g, ' ').slice(0, 70);
  }
  function deep(tag) {
    var prog = document.getElementById('progress-controls');
    log.push('    ' + String(Math.round(performance.now())).padStart(5) + 'ms  SLOT<' + tag + '> ' + sig(prog));
  }
  var watched = false;
  function watch() {
    if (watched) return;
    var root = document.getElementById('player-root');
    if (!root || !window.MutationObserver) return;
    watched = true;
    /* ⚠ LOG addedNodes FROM THE RECORD, NOT THE SLOT'S CURRENT CONTENTS. The callback is a
       MICROTASK: several mutations batch into one call, so reading innerHTML there reports only
       the LAST state and silently swallows anything that was inserted and replaced in between —
       which is exactly the "it flashed then was replaced" case this tool exists to catch. The
       MutationRecord keeps what was really added, so a superseded render still appears. */
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i], t = m.target;
        /* Both slots, tagged — the owner's other hypothesis is the APP CARD appearing in the
           offline bar and then being replaced once the app realises it can download. That would
           look identical and sit in the same region, so watch it too rather than assume. */
        var where = !t ? null
          : (t.id === 'progress-controls' || (t.closest && t.closest('#progress-controls'))) ? 'SLOT'
          : (t.id === 'offline-bar' || (t.closest && t.closest('#offline-bar'))) ? 'OBAR' : null;
        if (!where) continue;
        var added = m.addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          log.push('    ' + String(Math.round(performance.now())).padStart(5) + 'ms  ' + where + ' ADDED ' +
            (n.className || n.tagName) + ' :: ' +
            String(n.outerHTML || '').replace(/\s+/g, ' ').slice(0, 90));
        }
        if (!added.length && m.removedNodes && m.removedNodes.length) {
          log.push('    ' + String(Math.round(performance.now())).padStart(5) + 'ms  ' + where + ' REMOVED ' +
            ((m.removedNodes[0] && (m.removedNodes[0].className || m.removedNodes[0].tagName)) || '?'));
        }
      }
      snap('');
    }).observe(root, { childList: true, subtree: true, attributes: true });
    deep('watch-start');
  }

  snap('player.js');
  /* ⚠ ATTACH THE OBSERVER NOW, not on the first interval tick. #player-root is static markup so it
     already exists here, and on a fast (warm/local) load the whole mount-and-render completes
     inside 20ms — so waiting for the first tick meant the observer missed every mutation and the
     log came back empty. Same late-start mistake as loading the recorder from nav.js. */
  watch();
  var iv = setInterval(function () { watch(); snap(''); }, 20);
  setTimeout(function () { clearInterval(iv); snap('stop'); }, 15000);
  window.addEventListener('thaiear:auth', function () { snap('auth'); deep('auth'); });
  window.__teLayoutSnap = snap;
})();

(function () {
  'use strict';

  var cfg = window.ThaiEarTopic || {};
  var AUDIO_BASE = 'https://audio.thaiear.com';
  var AUDIO_API = '/api/audio';            // premium gate (Pages Function) — see functions/api/audio.js
  // Gated topics route audio through /api/audio. TIER drives the not-entitled UX:
  // 'member' → prompt a (free) sign-in; 'premium' → send to the paywall. Back-compat:
  // an old `premium: true` page is treated as tier 'premium'.
  var TIER = cfg.tier || (cfg.premium === true ? 'premium' : null);
  var GATED = !!TIER;
  var PREFIX = cfg.audioPrefix;
  var sentences = cfg.sentences || [];
  // Topics that ship a per-sentence transliteration (currently 01–03) get the toggle pill.
  var HAS_TRANSLIT = sentences.some(function (s) { return !!s.translit; });
  // SSR/hydration mode: when a page sets cfg.ssr, it ships its sentence cards as static,
  // source-visible HTML and we hydrate them (toggle a stage class) instead of building from
  // JS. Pages WITHOUT cfg.ssr keep the original build-from-JS path, byte-for-byte unchanged.
  var SSR = cfg.ssr === true;
  // Playlist mode (round-10): playlists.html?pl={id} renders a playlist AS a dyn topic page —
  // same player.js machinery, but flags + progress tracking don't apply and every sentence
  // carries its OWN audio prefix/tier (a playlist mixes topics).
  var PLMODE = cfg.playlistMode === true;

  /* ══ ?lat=1 — THE SENTENCE-AUDIO LATENCY PROBE (2026-08-26, diagnostic) ═══════════════════
     WHY IT EXISTS. "The first sentence takes 3-4 seconds, the rest are instant" is a claim
     about WHEN the idle prewarm has bytes, not about how fast a fetch is — and the two are
     indistinguishable from the outside. Resource Timing can show that /api/audio ran at
     3423ms, but not whether the clip the user tapped was warm at the moment they tapped it,
     which is the only number that decides anything. This records that.

     ARMED BY URL, REMEMBERED IN localStorage — the same reasoning as ownersim.js: the iPhone
     PWA and the Android app have NO ADDRESS BAR, so a query-string-only switch does not exist
     in the two places the measurement is most needed. `?lat=0` disarms.

     ⚠ EVERY CALL SITE MUST BE A STRICT NO-OP WHEN DISARMED. latMark() returns on its first
     line; nothing else in this file may branch on LAT. If a probe call ever changes what the
     player DOES, the measurement is measuring itself.

     Read it off the panel (top-right), or window.__teLat() for the raw JSON. */
  var LAT = (function () {
    var on = /[?&]lat=1(&|$)/.test(location.search);
    var off = /[?&]lat=0(&|$)/.test(location.search);
    try {
      if (off) { localStorage.removeItem('te_lat'); return false; }
      if (on) localStorage.setItem('te_lat', '1');
      return on || localStorage.getItem('te_lat') === '1';
    } catch (_) { return on; }
  })();
  var latLog = [];
  var latWarm = 0, latWant = 0, latTapT = null;
  var latEl = null, latBody = null, latQueued = false;
  /* t is ms since NAVIGATION START (performance.now()'s origin), so every number in the panel
     is directly comparable with a Resource Timing entry and with "how long after I tapped the
     link did I tap the sentence". */
  function latMark(name, extra) {
    if (!LAT) return;
    latLog.push({ t: Math.round(performance.now()), n: name, x: (extra == null ? null : extra) });
    /* ⚠⚠ setTimeout, NOT requestAnimationFrame. rAF DOES NOT FIRE IN A BACKGROUNDED TAB OR A
       backgrounded app — so the panel never painted, and because latQueued had already latched
       true nothing ever scheduled another paint even once the page came back to the foreground.
       A diagnostic that disappears exactly when the app is backgrounded is worse than none, and
       backgrounding mid-load is ordinary phone behaviour. A debug panel does not need to be
       frame-aligned anyway.
       (The old form also called rAF UNBOUND, which throws Illegal invocation in strict mode the
       moment window.requestAnimationFrame is missing and setTimeout is used instead.) */
    if (!latQueued) {
      latQueued = true;
      setTimeout(function () { latQueued = false; latPaint(); }, 0);
    }
  }
  // ms since the tap being timed — the number the owner actually feels.
  function latSinceTap() { return latTapT == null ? null : Math.round(performance.now() - latTapT); }
  function latPaint() {
    if (!LAT) return;
    try {
      if (!latEl) {
        latEl = document.createElement('div');
        latEl.id = 'te-lat';
        /* ⚠ SIZED FOR A PHONE, because a phone is what this measures. 46vw is a readable
           column on a laptop and an unreadable ribbon on a handset. */
        latEl.style.cssText = 'position:fixed;right:6px;top:6px;z-index:99999;width:min(92vw,360px);' +
          'max-height:60vh;overflow:auto;background:rgba(8,10,22,.9);color:#cfe;' +
          'font:10px/1.35 ui-monospace,monospace;padding:6px 8px;border-radius:7px;' +
          'white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 12px rgba(0,0,0,.4)';
        var h = document.createElement('div');
        h.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px;color:#ffd76a;font-weight:700';
        h.innerHTML = '<span style="flex:1">lat probe</span>';
        var cp = document.createElement('button');
        cp.id = 'te-lat-copy';
        cp.textContent = 'copy';
        cp.style.cssText = 'font:10px monospace;cursor:pointer;background:#ffd76a;border:0;border-radius:4px;padding:1px 6px';
        /* ⚠⚠ THE TEXTAREA IS THE DELIVERY; THE CLIPBOARD IS A CONVENIENCE. In the Android app
           and an installed PWA there is no console and no address bar, and navigator.clipboard
           can be absent, refused, or a silent no-op — so a copy button that only writes to the
           clipboard produces a trace the owner cannot get off the device, which is the same as
           no measurement at all. Rendering it into a selectable field always works: long-press,
           select all, share. */
        cp.onclick = function () { latDump(); };
        /* ⚠ THE CLIPBOARD IS NOT A RELIABLE WAY OFF A PHONE. In a WebView execCommand('copy')
           needs user activation and navigator.clipboard can be refused outright, and when both
           fail the owner is left hand-selecting a 1,600-character box on a handset. The share
           sheet has neither problem and lands the trace straight in a message. Only rendered
           where the API exists, so desktop is unchanged. */
        var sh = null;
        if (navigator.share) {
          sh = document.createElement('button');
          sh.id = 'te-lat-share';
          sh.textContent = 'share';
          sh.style.cssText = 'font:10px monospace;cursor:pointer;background:#ffd76a;border:0;border-radius:4px;padding:1px 6px';
          sh.onclick = function () {
            var s2;
            try { s2 = JSON.stringify(window.__teLat(), null, 1); } catch (_) { return; }
            try { navigator.share({ title: 'ThaiEar latency trace', text: s2 }).catch(function () {}); }
            catch (_) { latDump(); }
          };
        }
        var off = document.createElement('button');
        off.textContent = 'off';
        off.style.cssText = cp.style.cssText;
        off.onclick = function () { try { localStorage.removeItem('te_lat'); } catch (_) {} latEl.remove(); };
        h.appendChild(cp); if (sh) h.appendChild(sh); h.appendChild(off);
        latBody = document.createElement('div');
        latEl.appendChild(h); latEl.appendChild(latBody);
        (document.body || document.documentElement).appendChild(latEl);
      }
      var out = '';
      for (var i = 0; i < latLog.length; i++) {
        var e = latLog[i];
        out += String(e.t).padStart(6) + ' ' + e.n + (e.x == null ? '' : '  ' + e.x) + '\n';
      }
      latBody.textContent = out;
      latEl.scrollTop = latEl.scrollHeight;
    } catch (_) {}
  }
  /* Put the trace on screen in something a finger can select, and opportunistically on the
     clipboard. Exposed as __teLatDump so the owner panel can trigger it too. */
  /* ⚠⚠ SELECTING A READ-ONLY TEXTAREA DOES NOT WORK ON A PHONE. iOS refuses .select() on one
     outright, and an Android WebView focuses the field while leaving the selection empty — which
     is exactly what the owner saw: a box full of trace and nothing selected. The field must be
     made writable for the duration and selected with setSelectionRange (NOT .select(), which iOS
     ignores here); the contentEditable/Range dance is the long-standing iOS recipe and is inert
     elsewhere. Everything is restored afterwards so the box stays read-only to a stray tap. */
  function latSelectAll(box) {
    try {
      var ce = box.contentEditable, ro = box.readOnly, r = document.createRange();
      box.contentEditable = 'true';
      box.readOnly = false;
      r.selectNodeContents(box);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      if (box.setSelectionRange) box.setSelectionRange(0, box.value.length);
      box.contentEditable = ce;
      box.readOnly = ro;
      /* Restoring readOnly can drop the selection on some engines, so reassert it last — the
         selection has to still be live when execCommand runs, and has to still be visible
         afterwards for the manual route. */
      if (box.setSelectionRange) box.setSelectionRange(0, box.value.length);
      return true;
    } catch (_) { return false; }
  }

  /* Put the trace on screen, select all of it, and get it onto the clipboard.
     ⚠ execCommand('copy') is what works in a WebView, and it needs BOTH a live selection and the
     user's gesture — so this whole function runs synchronously inside the click. Do not make it
     async, and do not await the clipboard promise before copying. */
  function latDump() {
    var s;
    try { s = JSON.stringify(window.__teLat(), null, 1); } catch (_) { return; }
    try { console.log(s); } catch (_) {}
    var copied = false;
    try {
      latPaint();
      var box = document.getElementById('te-lat-dump');
      if (!box) {
        box = document.createElement('textarea');
        box.id = 'te-lat-dump';
        box.readOnly = true;
        box.style.cssText = 'width:100%;height:150px;margin-top:6px;font:10px/1.35 ui-monospace,monospace;' +
          '-webkit-user-select:text;user-select:text;background:#fff;color:#111;border-radius:4px';
        latEl.appendChild(box);
      }
      box.value = s;
      box.focus();
      latSelectAll(box);
      try { copied = document.execCommand && document.execCommand('copy'); } catch (_) { copied = false; }
      // Bonus path, and the only one on browsers that have dropped execCommand. Async, so it can
      // never be what the button reports — it may resolve long after this returns.
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s); } catch (_) {}
      // Leave it selected either way: if the copy failed, the manual route is all he has.
      latSelectAll(box);
    } catch (_) {}
    /* Say which happened. "copied" and "select all + copy" are the difference between pasting a
       trace and fighting a text box, and the owner cannot tell them apart by looking. */
    try {
      var btn = document.getElementById('te-lat-copy');
      if (btn) {
        btn.textContent = copied ? 'copied ✓' : 'select all + copy';
        setTimeout(function () { try { btn.textContent = 'copy'; } catch (_) {} }, 2500);
      }
    } catch (_) {}
    return copied;
  }
  window.__teLatDump = latDump;
  window.__teLat = function () {
    return {
      page: location.pathname, tier: TIER || 'free', prefix: PREFIX || '(playlist)',
      sentences: sentences.length, warmed: latWarm, wanted: latWant,
      nav: (function () {
        var n = performance.getEntriesByType('navigation')[0];
        return n ? { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null;
      })(),
      marks: latLog
    };
  };
  if (LAT) latMark('boot', 'player.js');

  /* ---- native (Capacitor app) audio engine ----
     In a browser the TOP player is an HTML5 <audio>. Inside the app that won't play with
     the screen locked, so audio is routed to a native ExoPlayer plugin (NativeAudio) that
     owns background + lock-screen playback. makeNativeAudio() returns a shim with the SAME
     surface player.js already uses on `mainAudio` (src / paused / currentTime / duration /
     play / pause / load / addEventListener), so the rest of this file is unchanged. All of
     this is gated on NATIVE — the website keeps using <audio>. It plays whatever URL the
     existing buildUrl() resolves (public CDN or signed /api/audio), so the free/member/
     premium tiers all work with no extra logic. */
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var NA = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.NativeAudio : null;
  var nativeMeta = { title: 'ThaiEar', subtitle: 'ThaiEar', artwork: 'https://thaiear.com/apple-touch-icon.png' };

  // Best title for whatever the TOP player is on. Prefer the topics.js unit name; fall back to
  // the page <title> (in case topics.js hasn't run yet on a cold open — that left the lock-screen
  // showing "ThaiEar" on the very first direct play).
  function resolveMainTitle() {
    var T = window.ThaiEarTopics;
    if (T && T.pageUnit) { try { var u = T.pageUnit(mainPage); if (u && u.name) return u.name; } catch (_) {} }
    return (document.title || 'ThaiEar')
      .replace(/^ThaiEar\s*[—–-]\s*Topic\s*\d+\s*:\s*/i, '')
      .replace(/\s*[·—–-]\s*ThaiEar.*$/i, '')
      .trim() || 'ThaiEar';
  }

  function makeNativeAudio() {
    var L = { loadedmetadata: [], timeupdate: [], ended: [] };
    var st = { src: '', preparedSrc: null, paused: true, currentTime: 0, duration: 0 };
    function emit(t) { (L[t] || []).forEach(function (fn) { try { fn(); } catch (e) {} }); }
    NA.addListener('ready', function (d) { st.duration = (d && d.duration) || 0; emit('loadedmetadata'); });
    NA.addListener('time', function (d) { if (d) { st.currentTime = d.position || 0; if (d.duration) st.duration = d.duration; } emit('timeupdate'); });
    NA.addListener('ended', function () { st.paused = true; emit('ended'); });
    NA.addListener('playing', function (d) { st.paused = !(d && d.playing); });
    // Lock-screen / notification buttons (prev/next/repeat). ±10 is seeked natively.
    NA.addListener('command', function (d) {
      var a = d && d.action;
      if (a === 'thaiear.NEXT') advanceTopic(1);
      else if (a === 'thaiear.PREV') advanceTopic(-1);
      else if (a === 'thaiear.REPEAT') toggleRepeat();
    });
    return {
      get paused() { return st.paused; },
      get duration() { return st.duration; },
      get currentTime() { return st.currentTime; },
      set currentTime(v) { st.currentTime = v; if (NA) NA.seekTo({ seconds: v }); },
      get src() { return st.src; },
      set src(v) { if (v !== st.src) { st.src = v; st.preparedSrc = null; } },
      set preload(v) {},
      load: function () {},
      play: function () {
        if (!NA) return Promise.resolve();
        // resume (same track already prepared) → just play; new track → prepare with metadata first
        if (st.preparedSrc === st.src && st.src) { st.paused = false; return NA.play(); }
        // Lock screen shows the unit ACTUALLY playing: dyn chain hops set dynTitle explicitly
        // (round-11 item 2); classic keeps the resolveMainTitle lookup.
        nativeMeta.title = (DYN && dynTitle) ? dynTitle : resolveMainTitle();
        writeNowPlaying();                       // share what's now playing across pages (now-playing bar + sync)
        var prep = { url: st.src, title: nativeMeta.title, subtitle: nativeMeta.subtitle, artwork: nativeMeta.artwork };
        if (DYN) {
          // dyn session (this page's, or an adopted neighbour's persisted one) → 'dyn' + marks;
          // adopted static placeholder (no session) → plain 'std'.
          if (dynSession && !dynStdRemote) { prep.mode = 'dyn'; prep.marks = dynSession.map.map(function (m) { return m.start; }); }
          else prep.mode = 'std';
        }
        return NA.prepare(prep)
          .then(function () { st.preparedSrc = st.src; st.paused = false; return NA.play(); })
          .catch(function (e) {
            // r17: the WebView's decoders and Media3's are different codebases, and only the
            // WebView's can be verified silently at encode time. If Media3 refuses an encoded
            // session, demote this device to WAV and let the next play rebuild — rather than
            // leaving it permanently unable to play.
            if (DYN && dynSession && dynSession.ext && dynSession.ext !== 'wav' && dynDemoteFormat('native prepare failed')) {
              dynStatus('Rebuilding this session for your device — press play again.', false);
              return Promise.reject({ code: 'refmt' });
            }
            return Promise.reject(e);
          });
      },
      pause: function () { st.paused = true; return NA ? NA.pause() : Promise.resolve(); },
      // Attach this (fresh-page) shim to a track already playing in the native engine, WITHOUT
      // re-preparing it — so play/pause/seek control the live track and it doesn't restart.
      attach: function () { st.src = st.preparedSrc = '__live__'; st.paused = false; },
      addEventListener: function (t, fn) { if (L[t]) L[t].push(fn); }
    };
  }

  /* ---- shared "now playing" across page loads ----
     The native engine keeps playing when you navigate, so we stash what it's on (in localStorage)
     so ANY page can show a now-playing bar and a topic page can sync its top player to the live track. */
  function writeNowPlaying() {
    try {
      if (DYN) resolveDynChain();   // D4 first-use lazy retry — see resolveDynChain's own note
      var np = { page: mainPage, name: nativeMeta.title, prefix: mainPrefix, mode: currentMode, access: mainTier || 'free' };
      // Dyn units also stamp their chain key (playlists have no prefix — the key is their identity).
      if (DYN) np.key = (dynChain && dynChain[dynChainIdx]) ? dynChain[dynChainIdx].dynKey : (cfg.dynKey || null);
      localStorage.setItem('thaiear_np', JSON.stringify(np));
    } catch (_) {}
  }
  // Set true once the user starts playback on THIS page's own player. Guards syncToPlayingTrack so a
  // late "time" tick from the user's OWN audio can't adopt a stale other-topic label (bug: open a fresh
  // topic, press Play, and the strip showed a different topic). Genuine continuation from another page
  // (where the user hasn't pressed Play here) still adopts correctly.
  var userStartedHere = false;
  // On mount, if the engine is already playing (a time tick arrives), sync this page's TOP player to
  // it — adopting another topic's identity if needed — so it shows + controls the live track.
  function syncToPlayingTrack() {
    if (!NA) return;
    if (DYN_PREBUILD) return;   // a prebuild frame must not adopt (or hijack) the live track
    var np; try { np = JSON.parse(localStorage.getItem('thaiear_np') || 'null'); } catch (_) { np = null;  }
    if (!np || (!np.prefix && !np.key)) return;   // dyn playlist units have no prefix — their key identifies them
    var done = false;
    NA.addListener('time', function () {
      if (done) return;
      if (userStartedHere) { done = true; return; } // user is driving THIS page → never hijack its label
      done = true;
      if (DYN) {
        resolveDynChain();   // D4 first-use lazy retry — see resolveDynChain's own note
        // Round-11 item 3: dyn adoption is chain-based and is the ONE source of page state
        // (icon, strip, pointer) — fixes the r10 "bar moves but icon shows play" desync,
        // where the pre-r11 guard bailed on prefix-less playlist units and nothing set state.
        var ownKey = cfg.dynKey || null;
        var isForeign = np.key ? (np.key !== ownKey) : (np.prefix !== mainPrefix);
        if (isForeign) {
          var idx = -1;
          if (dynChain) {
            dynChain.forEach(function (u, j) {
              if (idx >= 0 || !u) return;
              if ((np.key && u.dynKey === np.key) || (!np.key && np.prefix && u.prefix === np.prefix)) idx = j;
            });
          }
          var t;
          if (idx >= 0) {
            // in THIS page's space → the pointer follows the playing unit
            t = dynChain[idx];
            dynChainIdx = idx;
            dynAdopted = (idx === dynHomeIdx) ? null : t;
          } else {
            // Round-12 item 3: a unit from ANOTHER space (topic playing on a playlist page,
            // or vice versa) — adopt for DISPLAY + control only. The chain pointer stays
            // home: nav buttons keep walking THIS page's own chain (their next hop takes
            // the audio over), and ↩ Return plays this page's own unit.
            t = { page: np.page, prefix: np.prefix || '', tier: (np.access && np.access !== 'free') ? np.access : 'free', name: np.name || 'Now playing', dynKey: np.key || null };
            dynAdopted = t;
          }
          dynTitle = t.name;
          mainPage = t.page;
          mainPrefix = t.prefix || '';
          mainTier = (t.tier === 'member' || t.tier === 'premium') ? t.tier : null;
          mainGated = !!mainTier;
          if (np.mode === 'te' || np.mode === 'et') currentMode = np.mode;
          nativeMeta.title = t.name;
          // Round-15 item 1: hydrate a DISPLAY session from the playing unit's persisted meta
          // so ① skip, snap scrubbing and position memory work here. No url/blob — the audio
          // is engine-owned (dynAttached blocks any re-sourcing from this object; the
          // .display flag keeps it out of the src-providing fast paths).
          var dm = t.dynKey ? dynReadMeta(t.dynKey, currentMode) : null;
          dynSession = dm ? { url: null, fileUri: null, blob: null, map: dm.map, key: dm.key, duration: dm.duration, display: true } : null;
          dynSessionIsLocal = false;               // foreign map — never highlight this page's cards with it
          dynStdRemote = false;
          if (dynAdopted) dynStripPaint(t, false); // "Now playing: X" + ↩ Return
        } else {
          dynTitle = (dynChain && dynChain[dynHomeIdx]) ? dynChain[dynHomeIdx].name : dynTitle;
          // Own unit playing (its page opened mid-play): adopt the live mode and hydrate from
          // OUR meta — the map's nums match this page's cards, so highlight works too.
          if (np.mode === 'te' || np.mode === 'et') currentMode = np.mode;
          if (!dynSession) {
            var dm2 = dynReadMeta(DYN_KEY_NS, currentMode);
            if (dm2) {
              dynSession = { url: null, fileUri: null, blob: null, map: dm2.map, key: dm2.key, duration: dm2.duration, display: true };
              dynSessionIsLocal = true;
              dynStdRemote = false;
            }
          }
        }
        // r16: adopting the live track can flip the direction — settings are per mode, so the
        // controls must repaint onto THIS unit's settings for the mode now playing.
        dynLoadSettings(); dynPrefsRepaintControls();
        dynAttached = true;                        // src belongs to the live engine — never rebuild under it
        mainSrcReady = true;
        if (mainAudio.attach) mainAudio.attach();  // control the live track without restarting it (position preserved)
        setMainIcon(true);
        dynSyncSentBtns();                         // ① buttons follow the hydrated (or absent) map
        return;
      }
      if (np.prefix !== mainPrefix) {            // a DIFFERENT topic is playing → adopt it on the top player
        mainPage = np.page; mainPrefix = np.prefix;
        if (np.mode === 'te' || np.mode === 'et') currentMode = np.mode;
        var T = window.ThaiEarTopics, unit = (T && T.pageUnit) ? T.pageUnit(np.page) : null;
        if (unit) { mainTier = (unit.access && unit.access !== 'free') ? unit.access : null; mainGated = !!mainTier; }
        currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
        nativeMeta.title = np.name || (unit && unit.name) || 'ThaiEar';
        if (unit) updateNowPlaying(unit);
      }
      mainSrcReady = true;
      if (mainAudio.attach) mainAudio.attach();  // control the live track without restarting it
      setMainIcon(true);
    });
  }

  /* ---- web-only cross-page resume ----
     On the website there is no native engine, so a full page navigation destroys the <audio>: clicking
     the now-playing topic link used to restart that topic from 0:00. We stash the TOP player's live
     position + side (keyed by audio-prefix); when a page boots onto the SAME topic that was just
     playing, we seek back and continue. The app keeps playing across nav (native engine), so this is
     web-only and guarded on !NATIVE. */
  var lastResumeWrite = 0;
  function writeWebResume(force) {
    if (NATIVE) return;
    var now = Date.now();
    if (!force && now - lastResumeWrite < 1000) return;   // throttle the timeupdate firehose
    lastResumeWrite = now;
    try {
      localStorage.setItem('thaiear_resume', JSON.stringify({
        prefix: mainPrefix, mode: currentMode,
        t: mainAudio.currentTime || 0, playing: !mainAudio.paused, ts: now
      }));
    } catch (_) {}
  }
  function maybeWebResume() {
    if (NATIVE) return;
    var r; try { r = JSON.parse(localStorage.getItem('thaiear_resume') || 'null'); } catch (_) { r = null; }
    if (!r || !PREFIX || r.prefix !== PREFIX) return; // only continue THIS page's own topic (playlists: no cross-resume)
    if (!r.playing) return;                         // only auto-continue something that was actually playing
    if (Date.now() - (r.ts || 0) > 60000) return;   // stale → ignore (don't hijack a much later visit)
    if (!(r.t > 1)) return;                         // negligible position
    if (mainGated && !entitledForPage()) return;    // gated + not entitled → leave it to the gate
    try { localStorage.removeItem('thaiear_resume'); } catch (_) {}   // consume; live playback re-stamps it
    // restore the TE/ET side if it differed from this page's default
    if ((r.mode === 'te' || r.mode === 'et') && r.mode !== currentMode) {
      currentMode = r.mode;
      currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
      mainSrcReady = false;
      if (!mainGated && !OFFLINE && !(WEB_DL && isDownloaded(mainPrefix))) { mainAudio.src = AUDIO_BASE + '/' + currentMainFile; mainSrcReady = true; }
      var bte = $('btn-te'), bet = $('btn-et');
      if (bte) bte.classList.toggle('active', currentMode === 'te');
      if (bet) bet.classList.toggle('active', currentMode === 'et');
      applyDirClass();   // restored ET side → reveal order should open English-first too
      if (DYN) { dynLoadSettings(); dynPrefsRepaintControls(); }   // r16: settings are per mode
    }
    var target = r.t;
    ensureMainSrc().then(function () {
      // Paint the scrubber + time label at the restored spot straight away. A manual currentTime set
      // fires 'seeked', not 'timeupdate', and the bar is only painted on 'timeupdate' (during playback)
      // — so when iOS blocks autoplay after a navigation the bar would read 0:00 even though the
      // position IS restored, which reads as "lost my place". Painting here makes it visible while paused.
      function paintAt(t) {
        if (mainAudio.duration) { var f = $('scrubber-fill'); if (f) f.style.width = ((t / mainAudio.duration) * 100) + '%'; }
        var c = $('time-cur'); if (c) c.textContent = formatTime(t);
      }
      function applySeek() {
        try { mainAudio.currentTime = Math.max(0, Math.min(target, mainAudio.duration || target)); } catch (_) {}
        paintAt(target);
      }
      function seekAndPlay() {
        applySeek();
        userStartedHere = true;
        mainAudio.play().then(function () { setMainIcon(true); setupMediaSession(); })
          .catch(function () { setMainIcon(false); paintAt(target); });   // autoplay blocked → show restored spot, paused
        // iOS drops a currentTime set on a not-yet-buffered NETWORK stream (only metadata loaded) and
        // snaps back to ~0. A downloaded topic is a fully-cached blob that always seeks, which is why
        // this only bit non-downloaded topics. Re-verify once enough data is buffered and re-seek if
        // the position drifted away from where we asked.
        mainAudio.addEventListener('canplay', function reseek() {
          mainAudio.removeEventListener('canplay', reseek);
          if (mainAudio.currentTime < target - 1.5) applySeek();
        });
      }
      if (mainAudio.readyState >= 1 && isFinite(mainAudio.duration)) seekAndPlay();
      else mainAudio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    }).catch(function () {});
  }
  // capture the exact spot at the moment we navigate away (web)
  window.addEventListener('pagehide', function () {
    writeWebResume(true);
    /* ⚠ AN EXIT PATH FOR THE PLAY COUNT TOO. The repetitions heard in the block that is playing
       are banked, not yet reported — closing the tab mid-sentence would otherwise lose them.
       auth.js queues into a durable store, so it survives even if its own pagehide flush has
       already run and this credit rides the next one. */
    try { plysDwellReset(); } catch (_) {}
  });

  /* ---- offline downloads (Capacitor app only) ----
     A topic can be downloaded for offline listening: the two combined files (_TE/_ET) plus every
     per-sentence clip, stored in app-private storage (Filesystem DATA). Playback then prefers the
     local copy — the native engine plays the file:// directly; the web sentence <audio> uses
     Capacitor.convertFileSrc. PREMIUM downloads carry an offline LICENCE: they only play offline if
     the subscription was verified online within OFFLINE_GRACE_MS (a lapsed/cancelled member loses
     offline access once that window passes). Free + member topics have no expiry. Guarded on NATIVE;
     the website never shows any of this. */
  // PRODUCTION VALUE — 30 days. A member verified online (incl. at download) within this window keeps
  // offline access; a genuinely lapsed member who stays offline past it is asked to reconnect. (Was
  // 1 min for testing — too short: a download made >1 min before reopening offline wrongly expired.)
  // Keep nav.js OFFLINE_GRACE_MS in sync.
  // 50 days (was 30, raised 2026-07-29). This is ONLY the fallback for when no real period end
  // was ever captured — a paying member is governed by thaiear_sub_until (their actual billing
  // period), which is checked first and is unaffected by this number. Raised because the window
  // is what stands between a long-offline member and losing everything they downloaded.
  var OFFLINE_GRACE_MS = 50 * 24 * 60 * 60 * 1000;
  var Filesystem = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.Filesystem : null;
  var OFFLINE = !!(NATIVE && Filesystem);

  /* ---- web / PWA offline downloads (the browser equivalent of the native engine above) ----
     iPhones can't install the native app, so the iOS route to offline listening is "Add to Home
     Screen" + this Cache-Storage port: a browser "Download" button fetch()es the same MP3s and
     stores them in a dedicated Cache Storage bucket (thaiear-audio-dl), preserved across SW
     updates. Playback then serves a same-origin blob: URL from the cache (seekable). It reuses ALL
     the shared bookkeeping below — the thaiear_offline manifest, contentHash/audio-version staleness,
     and the premium offline LICENCE (canUseOffline / 30-day grace) — only the storage backend
     differs (Cache Storage instead of @capacitor/filesystem).

     A cross-origin fetch needs CORS on the audio (Access-Control-Allow-Origin) or it rejects; that's
     enabled on both R2 buckets.
     ROLLOUT P2a (§1f, owner 2026-08-02): the old `thaiear_webdl` beta flag is RETIRED. Download UI
     is for the native app and the INSTALLED PWA only — standalone-display detection replaces the
     flag, so an installed iPhone PWA gets downloads automatically and a plain browser tab (Safari
     or Chrome, desktop or phone) never sees them. Never active in the native app path (which uses
     Filesystem). Absence leaves no hole: the bar is display:none, normal flow closes over it. */
  var STANDALONE_PWA = (function () {
    try {
      return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
             window.navigator.standalone === true;
    } catch (_) { return false; }
  })();
  var CACHES = (window.caches && window.isSecureContext) ? window.caches : null;
  var WEB_DL = !NATIVE && !!CACHES && STANDALONE_PWA;
  /* r23: the DYN test space must not be behind that dark flag. dyn-index.html enables its own
     Cache-Storage download whenever caches exist, so on an iPhone the clips DID download — but
     player.js then refused to READ them (WEB_DL false without the flag), went to the network,
     and failed offline. That is exactly the "no connection — your settings have been put back"
     the owner hit on a topic that showed a tick. The flag still governs the CLASSIC web
     download for real topics; dyn paths use this instead. */
  var DYN_WEB_DL = !NATIVE && !!CACHES;
  var AUDIO_DL_CACHE = 'thaiear-audio-dl';
  // Same-origin string used purely as a Cache Storage key (never actually fetched from this path),
  // so the stored entry is stable even though a premium file's signed source URL changes each mint.
  function webCacheKey(prefix, file) { return '/__offline-audio/' + prefix + '/' + file; }

  /* A unit's `page` ("topic-NN.html") is the IDENTITY key — cache keys, dynKey, pageUnit() lookups
     all use it, so it must not change. But an emitted HREF must be the CLEAN url: Cloudflare Pages
     308-redirects /topic-NN.html → /topic-NN, the redirect is `cf-cache-status: DYNAMIC` (an
     uncached origin round trip, 127–1315 ms measured), and it happens BEFORE the service worker
     starts, so Navigation Preload cannot cover it. Mirrors hrefFor() in topics.js; kept local so
     player.js never depends on topics.js having loaded first. */
  var LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(location.hostname);
  function pageLinkHref(p) {
    var s = String(p || '').replace(/\.html$/i, '');
    return (LOCAL_HOST && s) ? s + '.html' : s;   // localhost has no clean-URL resolution
  }

  // Persist a downloaded topic's PAGE (+ shared scripts) in a cache the service worker never
  // version-wipes, so the page still opens offline after an SW update. Self-heals whenever we're
  // online on a downloaded topic's page. (The SW's activate step preserves the 'thaiear-dl' cache.)
  var DL_PAGE_CACHE = 'thaiear-dl';
  /* ⚠ PAGES ONLY — DO NOT PUT THE SHARED SCRIPTS BACK IN HERE (2026-08-12).
     This used to also add /player.js, /topics.js, /nav.js, /auth.js and /footer.js. Because
     `thaiear-dl` is never version-wiped AND the service worker's precache lookup used
     `caches.match()` (which searches every cache in CREATION order), those copies SHADOWED the
     version-keyed ones on any device that had ever downloaded a topic — frozen at whenever this
     last ran, immune to every VERSION bump. It could not self-heal either: `c.add('/topics.js')`
     fetches through the worker, which handed the stale copy straight back.
     It showed up as retired "coming soon" topics reappearing on the index and grossly oversized
     padlocks — a stale topics.js rendering against fresh CSS.
     They were never needed here: all five are PRECACHE entries, so the version cache already holds
     them and activate() repairs any gap. The page and audio-versions.json are NOT precached (there
     are ~93 topic pages), which is exactly why those two belong in this durable cache. */
  function cachePage() {
    if (!window.caches || !navigator.onLine) return;
    try {
      caches.open(DL_PAGE_CACHE).then(function (c) {
        [location.href, '/audio-versions.json'].forEach(function (u) {
          c.add(u).catch(function () {});
        });
      }).catch(function () {});
    } catch (_) {}
  }

  // A JS-driven download stops if the page unloads, so warn before leaving mid-download.
  var downloadingNow = false;
  window.addEventListener('beforeunload', function (e) { if (downloadingNow) { e.preventDefault(); e.returnValue = ''; } });

  function offlineDir(prefix) { return 'offline/' + prefix; }
  function topicFiles() {
    var files = [PREFIX + '_TE.mp3', PREFIX + '_ET.mp3'];
    sentences.forEach(function (s) { files.push(PREFIX + '_S' + String(s.num).padStart(2, '0') + '_TH.mp3'); });
    return files;
  }
  function getManifest() { try { return JSON.parse(localStorage.getItem('thaiear_offline') || '{}'); } catch (_) { return {}; } }
  function setManifest(m) { try { localStorage.setItem('thaiear_offline', JSON.stringify(m)); } catch (_) {} }
  function isDownloaded(prefix) { return !!getManifest()[prefix]; }
  /* Is THIS FILE actually on the device? isDownloaded() only says the PREFIX appears in the
     manifest, which is not the same thing — and the difference broke live playback.
     A dyn download stores per-sentence CLIPS (…_S12_TH.mp3); the classic player plays the
     COMBINED …_TE.mp3. They share a prefix, so downloading the dyn test mirror of a topic made
     the live topic page believe its combined file was local. Filesystem.getUri() does not check
     existence — it just builds a path — so the player got a valid-looking file:// URI to a file
     that was never there and played nothing at all.
     An entry with no file list is a legacy full download: trust it, as before. */
  function hasLocalFile(prefix, file) {
    var e = getManifest()[prefix];
    if (!e) return false;
    if (!e.files || !e.files.length) return true;
    for (var i = 0; i < e.files.length; i++) if (e.files[i] === file) return true;
    return false;
  }
  // av: '' = no stamp for this topic yet · 'x' = a real stamp · null = couldn't read the map at
  // download (kept null, NOT '', so a later successful load adopts the real stamp instead of false-flagging).
  function markDownloaded(prefix, tier, files, ver, av) { var m = getManifest(); m[prefix] = { tier: tier || 'free', files: files, at: Date.now(), ver: ver || '', av: (av == null ? null : av) }; setManifest(m); }
  function removeDownloaded(prefix) { var m = getManifest(); delete m[prefix]; setManifest(m); }
  function downloadedTier(prefix) { var e = getManifest()[prefix]; return e ? e.tier : null; }

  // Content fingerprint of the CURRENT page's sentences (num + thai + english). This is the
  // can't-drift backstop: the text lives in the page, which self-heals online, so any change to the
  // sentences is caught even if audio-versions.json is ever missed. It does NOT see a pure audio
  // re-render with unchanged text (e.g. an English TE/ET fix, or a voice swap) — that's what the
  // audio stamp (loadAudioVers/currentAv) covers. Stored in the manifest at download time and
  // compared on each open. cyrb53 — fast, dependency-free, plenty for change-detection.
  function contentHash() {
    var str = sentences.map(function (x) {
      return [x.num, x.thai || '', x.english || ''].join('');
    }).join('');
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // audio-versions.json (written by generate_topic_audio.py, keyed by {Short}_{Level}) fingerprints
  // each topic's COMBINED audio. It catches the one thing contentHash can't: a pure audio re-render
  // with unchanged page text (e.g. fixing the English TE/ET clips). Fetched once per page; SW-caches
  // network-first and cachePage() persists it in 'thaiear-dl', so a downloaded topic still resolves
  // it offline. Any failure → null, which makes currentAv() return null and the audio-staleness check
  // is skipped (never a false positive offline). The text hash remains the can't-drift backstop.
  var _audioVers;   // undefined = not loaded yet · object = loaded · null = load failed
  function loadAudioVers() {
    if (_audioVers !== undefined) return Promise.resolve(_audioVers);
    return fetch('/audio-versions.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (m) { _audioVers = (m && typeof m === 'object') ? m : {}; return _audioVers; })
      .catch(function () { _audioVers = null; return null; });
  }
  // '' = loaded but no stamp for this topic yet · null = map unavailable (→ skip the audio check).
  function currentAv() { return _audioVers ? (_audioVers[PREFIX] || '') : null; }

  function parseExpiry(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;  // epoch seconds vs ms
    var t = Date.parse(v); return isNaN(t) ? 0 : t;             // ISO string
  }
  // On each successful online check, record WHEN we checked + the membership's real end date.
  /* P3 cleanup (r135): the owner entitlement simulator (sim.js) went with the test space. */
  function stampVerified() {
    try {
      // Owner simulator: hold the licence markers still while an account state is armed. Without
      // this, setting "51 days" online and THEN going offline lost the backdating on the way out
      // (this fires from canUseOffline's online-and-subscribed branch), so the offline half of the
      // test could never be set up. The simulator owns these inputs while armed.
      localStorage.setItem('thaiear_lastVerified', String(Date.now()));
      var a = window.ThaiEarAuth, sub = a && a.getSubscription && a.getSubscription();
      var end = sub && sub.current_period_end;
      if (end) localStorage.setItem('thaiear_sub_until', String(parseExpiry(end)));
    } catch (_) {}
  }
  /* ══ ENTITLEMENT SIMULATOR (owner test tool — see playlists.html "Simulate account") ═══════
     Lets the owner flip entitlement without touching a real Supabase account or waiting for a
     subscription to actually expire. Stored in localStorage so it SURVIVES going offline and
     restarting the app — which is the whole point: the offline entitlement check is itself
     100% client-side (canUseOffline reads localStorage, never the network), so simulating it
     here exercises the REAL offline code path, not a stand-in for it.
       ''/'off'    — use the real auth state (default; nothing is overridden)
       'premium'   — entitled: active subscription + valid offline licence
       'expired'   — signed in, subscription gone AND the offline licence lapsed (premium locks,
                     member stays open — member only ever requires a signed-in user)
       'signedout' — no user at all (member AND premium lock)
     ⚠ IT OVERRIDES ONLY THE AUTH ANSWER — never a decision. The simulated state is injected at
     the ThaiEarAuth boundary (getUser/isSubscribed), exactly where the real Supabase answer
     enters; everything downstream — canUseOffline, the 30-day grace arithmetic, sentLocked,
     entitledForPage, the licence overlay — then runs UNMODIFIED on it. A switch that forced
     canUseOffline's return value would prove nothing: it would bypass the very code under test.
     The elapsed-time case works the same way and is even purer: simElapse() below just BACKDATES
     the real localStorage markers, so the real grace-window arithmetic decides the outcome.
     ⚠ What it CANNOT simulate: the SERVER's answer. /api/audio still sees the real token, so a
     really-subscribed owner would still be handed signed URLs. Use the separate "simulate server
     denial" switch to exercise that path. */

  /* May an offline download of this tier be played right now? free/member: always.
     premium: live subscription when online; else within the verified-online window.
     ⚠ THE RULE NOW LIVES IN auth.js (ThaiEarAuth.canUseOffline) — one predicate shared with
     playlists.html's download path, which previously had NO tier awareness at all. This is a thin
     delegate; every existing call site is unchanged. */
  function canUseOffline(tier) {
    var a = window.ThaiEarAuth;
    if (a && typeof a.canUseOffline === 'function') return a.canUseOffline(tier);
    return canUseOfflineLegacy(tier);
  }
  /* ⚠ STALE-CACHE FALLBACK ONLY — DO NOT EDIT THIS TO CHANGE BEHAVIOUR, AND DO NOT ADD LOGIC HERE.
     It exists solely because player.js and auth.js are separately cached, so a browser could hold a
     new player.js against an auth.js predating ThaiEarAuth.canUseOffline. It is a byte-for-byte
     copy of the pre-2026-07-31 rule, kept identical on purpose. Edit auth.js instead — editing one
     and not the other is precisely the bug this consolidation removes. Delete at D.1/rollout. */
  function canUseOfflineLegacy(tier) {
    if (tier !== 'premium') return true;
    // Lifetime members (£0-forever) never time out offline — they may be off-grid for months.
    // The flag is maintained by auth.js ONLY when the server confirms lifetime+active while online,
    // so a regular paying user can never reach this early-return.
    try { if (localStorage.getItem('thaiear_lifetime') === '1') return true; } catch (_) {}
    var a = window.ThaiEarAuth;
    var subbed = a && a.isSubscribed && a.isSubscribed();
    /* ONE question decides everything here: DID THE SERVER ANSWER US THIS SESSION?
       This used to ask navigator.onLine, which the WebView lies about — it reports online in
       airplane mode — so `onLine && subbed` granted on a cached flag and the 50-day arithmetic
       below was never reached at all. That is why a member 51 days unverified still played
       offline, and why the whole window looked like dead code.
       isSubscriptionFresh() is the truthful version of the same question: true only when a clean
       subscriptions read completed. It cannot be faked by a flight-mode radio.
         answered + subscribed  → grant, and stamp (an authoritative confirmation)
         answered + not         → deny outright; the server has spoken
         no answer              → fall through to the offline rules below, unchanged */
    var fresh = !!(a && a.isSubscriptionFresh && a.isSubscriptionFresh());
    if (fresh) {
      if (subbed) { stampVerified(); return true; }
      return false;
    }
    // Offline (or online-but-not-freshly-confirmed). Trust the membership's REAL end date when we
    // captured one: a paid member can play offline right through their current period without needing
    // a recent re-verify — that's correct subscription billing (cancel = access until period end). The
    // download stamps this end date, so a member who downloads then immediately goes offline keeps
    // access for the whole period (fixes the "reconnect straight away if you never opened the player"
    // bug). The short backstop window is only a FALLBACK for when no end date was ever captured.
    var last = parseInt(localStorage.getItem('thaiear_lastVerified') || '0', 10);
    var until = parseInt(localStorage.getItem('thaiear_sub_until') || '0', 10);
    // Entitled if EITHER the captured real end date is still in the future, OR we verified online
    // within the backstop window. OR (not AND) so a missing/stale end date can't short-circuit a
    // valid member into denial — the download itself stamps lastVerified, so a recent download plays.
    // Reached only when the server did NOT answer, i.e. we genuinely cannot check. The captured
    // period end wins if we have one; otherwise the 50-day window from the last confirmation.
    // Past that, deny — which surfaces as "Reconnect to keep listening", not the paywall, because
    // we are not claiming they lapsed; we are saying we can no longer vouch for them.
    if (until && Date.now() < until) return true;
    return !!last && (Date.now() - last) < OFFLINE_GRACE_MS;
  }

  function localUri(prefix, file) {
    if (!Filesystem) return Promise.resolve(null);
    return Filesystem.getUri({ directory: 'DATA', path: offlineDir(prefix) + '/' + file })
      .then(function (r) { return (r && r.uri) ? r.uri : null; })
      .catch(function () { return null; });
  }
  // Read a downloaded clip and hand back a same-origin blob: URL. The sentence <audio> element used
  // convertFileSrc(file://) URLs, which DON'T play in newer Android WebViews (Android 13+, e.g. the
  // Pixel) when the page is served from a remote server.url — the localhost scheme is treated as a
  // cross-origin/opaque media source and silently fails (older WebViews like the Moto are lenient).
  // A blob: URL is same-origin to the document and plays everywhere. Clips are tiny, so reading them
  // into memory is cheap. (The combined TE/ET file uses the NATIVE engine, which plays file:// fine.)
  function b64ToBlob(b64, type) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'audio/mpeg' });
  }
  function localBlobUrl(prefix, file) {
    if (!Filesystem) return Promise.resolve(null);
    return Filesystem.readFile({ directory: 'DATA', path: offlineDir(prefix) + '/' + file })
      .then(function (r) { return (r && r.data) ? URL.createObjectURL(b64ToBlob(r.data, 'audio/mpeg')) : null; })
      .catch(function () { return null; });
  }
  // Web/PWA equivalent: read a downloaded clip out of Cache Storage and hand back a same-origin
  // blob: URL (plays AND seeks offline). Null if not cached, so callers fall back to the remote URL.
  function cachedBlobUrl(prefix, file) {
    if (!CACHES) return Promise.resolve(null);
    return caches.open(AUDIO_DL_CACHE)
      .then(function (c) { return c.match(webCacheKey(prefix, file)); })
      .then(function (res) { return res ? res.blob() : null; })
      .then(function (blob) { return blob ? URL.createObjectURL(blob) : null; })
      .catch(function () { return null; });
  }
  // Main (native) player: local file:// if downloaded + licence ok, else the remote URL.
  function mainSrcFor(file) {
    // hasLocalFile, not isDownloaded: the combined file must itself be on disk (see above).
    if (OFFLINE && hasLocalFile(mainPrefix, file)) {
      if (canUseOffline(mainTier)) return localUri(mainPrefix, file).then(function (uri) { return uri || buildUrl(file, mainGated); });
      if (!navigator.onLine) return Promise.reject({ code: 'licence' }); // downloaded premium, offline licence lapsed
    }
    if (WEB_DL && hasLocalFile(mainPrefix, file)) {
      if (canUseOffline(mainTier)) return cachedBlobUrl(mainPrefix, file).then(function (url) { return url || buildUrl(file, mainGated); });
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    return buildUrl(file, mainGated);
  }
  // Sentence (web <audio>) player: a same-origin blob: URL of the downloaded clip if available
  // (plays reliably across WebViews — see localBlobUrl), else the free CDN / signed remote URL.
  /* prefix/tier are per SENTENCE on a playlist, which mixes topics — the page-level PREFIX there
     is '' and TIER is 'free'. This used to read the page values, so hasLocalFile('', file) was
     always false: single-sentence playback skipped the downloaded clip and went to the network,
     and offline it simply failed. The stitched session worked throughout because dynClipUrl uses
     the per-sentence ref. Topic pages pass nothing and behave exactly as before. */
  function sentSrcFor(file, gated, prefix, tier) {
    var pfx = prefix || PREFIX;
    var tr = tier || TIER;
    if (OFFLINE && hasLocalFile(pfx, file)) {
      if (canUseOffline(tr)) {
        return localBlobUrl(pfx, file).then(function (url) { return url || buildUrl(file, gated); });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    if (WEB_DL && hasLocalFile(pfx, file)) {
      if (canUseOffline(tr)) {
        return cachedBlobUrl(pfx, file).then(function (url) { return url || buildUrl(file, gated); });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    /* Prewarmed bytes (see prewarmSentences) — the clip is already in memory, so the tap costs
       an object URL instead of two network round trips. The URL is revoked by the existing
       revokeSentBlob() swap; the Blob itself stays cached for the life of the page. */
    if (sentBlobs[file]) {
      try { return Promise.resolve(URL.createObjectURL(sentBlobs[file])); } catch (_) {}
    }
    /* ⚠ ADOPT A DOWNLOAD ALREADY IN FLIGHT rather than starting a second one for the same bytes.
       prewarmYield() now spares the tapped clip, so on a fresh topic this is the common case: the
       head pass is mid-fetch exactly when the first tap lands.
       ⚠⚠ BOUNDED, AND THAT IS NOT OPTIONAL. Adopting means inheriting the other fetch's stall,
       and armSentStall() is only armed AFTER this promise resolves — so an unbounded await would
       leave the button lit with no watchdog behind it at all. Past the budget, fall through to
       the ordinary path, which is exactly the behaviour this replaces. */
    if (warmInflight[file]) {
      var waited = false;
      return Promise.race([
        warmInflight[file].then(function () { waited = true; }),
        new Promise(function (r) { setTimeout(r, SENT_ADOPT_MS); })
      ]).then(function () {
        if (sentBlobs[file]) {
          try { return URL.createObjectURL(sentBlobs[file]); } catch (_) {}
        }
        if (!waited) latMark('adopt:timeout', file);
        return buildUrl(file, gated);
      });
    }
    return buildUrl(file, gated);
  }

  /* ---- prewarm the topic's own sentence clips, at idle (2026-08-19) ----
     A sentence clip averages 7–10 KB and a whole topic's Thai clips are 170–500 KB — less than
     player.js itself. Every millisecond of the "few seconds" a tap used to take was latency, not
     bytes, so the fix is simply to have the bytes already. Fetching them at idle turns the FIRST
     tap of every sentence into an object URL.
     The guards matter more than the fetching:
       · save-data / 2g → skip entirely; this is a convenience, not a requirement;
       · already downloaded → skip, sentSrcFor serves those from the device;
       · locked or not entitled → skip, there is nothing we may fetch;
       · a dynamic build in flight → wait for it. The build is the thing the owner says already
         works well, and it runs its own pool of 6; adding lanes underneath it would trade a fast
         build for a fast tap, which is a bad trade.
     Failures are silent by design: anything that does not warm just falls through to the ordinary
     path. In particular a bucket without CORS makes every fetch here reject, and the site must
     behave exactly as it did before. */
  var PREWARM_MAX_FILES = 60;
  var PREWARM_MAX_BYTES = 3 * 1024 * 1024;
  var PREWARM_POOL = 3;
  var PREWARM_WAIT_MS = 6000;
  var PREWARM_WAIT_TRIES = 5;
  var PREWARM_YIELD_MS = 10000;   // hard cap: a tap that never settles must not stall the prewarm for ever
  var PREWARM_MAX_ATTEMPTS = 2;   // a clip dropped for a tap gets one more go, then it is left to the tap path
  /* How long a tap will wait for a prewarm fetch of the SAME clip that is already running.
     Generous enough to be worth adopting (the clips that matter land in well under a second
     on the owner's phone) and short enough that a stalled one cannot hold the button. */
  var SENT_ADOPT_MS = 2000;
  /* ⚠ THE HEAD PASS (2026-08-26). The bulk prewarm runs at idle, which is correct for 40 clips
     and wrong for the two or three a visitor actually taps first: measured on the live site, the
     batch mint did not even START until 3.4s (topic-08) / 7.8s (topic-06), so the first clip was
     not in memory until ~5.0s / ~9.4s. Nobody reads a topic intro for nine seconds. These few are
     warmed as soon as we are ALLOWED to, with no idle wait — ~32 KB, less than one of the fonts.
     ⚠ Keep it small. The reason the bulk pass waits for idle is that it must never compete with
     first paint, and that reasoning still applies to everything past the head. */
  /* ⚠ SIZED TO WHAT A PHONE SHOWS, not to what looks tidy. At 4 it covered the first four
     sentences and nothing else, so the owner scrolling slightly and tapping the 11th got a
     cold clip on a page where everything else was ready (measured: `warm 4/0 -> COLD: net`).
     Eight clips is ~64 KB — still less than one of the fonts. */
  var PREWARM_HEAD = 8;
  var PREWARM_HEAD_POOL = 6;   // all at once, but not so many that WebKit throttles the burst
  var prewarmHeadDone = false;
  var sentBlobs = {};       // file -> Blob of the raw mp3
  var sentBlobBytes = 0;
  var prewarmStarted = false;
  var prewarmCtrls = [];    // AbortControllers for the fetches currently in flight
  /* file -> true while its bytes are on the wire. `sentBlobs` only answers "already warm",
     which is not the same question once TWO passes are running: the head pass and the bulk
     pass overlap by design, so without this each head clip is fetched twice. */
  var warmInflight = {};
  var sentBusyUntil = 0;    // while in the future, a tap owns the network and the prewarm waits

  function sentBusy() { return Date.now() < sentBusyUntil; }
  /* Called the moment a tap begins. Aborts the prewarm fetches in flight and holds the queue,
     so the clip the user is actually waiting for is not queued behind three they are not. The
     aborted clips go back on the queue; nothing is lost but a few kilobytes of progress. */
  /* ⚠⚠ SPARE THE CLIP THE USER ACTUALLY ASKED FOR. Aborting everything in flight is right for
     the clips they did not tap and precisely wrong for the one they did: with a 4-clip head pass
     and a tap near the top of the list, the download being thrown away is very often the tapped
     one, and the tap then re-fetches the same bytes from zero. Measured on the owner's phone:
       2031  yield  aborted 4 in-flight prewarm fetches
       2034  TAP    s395 … -> mint-cached + net
       3204  PLAYING  1170ms after tap
     `keepFile` is the file the tap is about to want. Its controller stays live and stays in
     prewarmCtrls, so its own done() still removes it. */
  function prewarmYield(keepFile) {
    sentBusyUntil = Date.now() + PREWARM_YIELD_MS;
    var live = prewarmCtrls, kept = [], killed = 0;
    for (var i = 0; i < live.length; i++) {
      if (keepFile && live[i].teFile === keepFile) { kept.push(live[i]); continue; }
      try { live[i].abort(); killed++; } catch (_) {}
    }
    prewarmCtrls = kept;
    if (killed || kept.length) {
      latMark('yield', 'aborted ' + killed + ' in-flight prewarm fetches' +
        (kept.length ? ' — KEPT the tapped clip' : ''));
    }
  }

  // The clip filename for a sentence. Topic pages fall back to the page prefix and the sentence's
  // own num; a playlist item carries its own prefix and the real spreadsheet num in clipNum.
  function sentFileFor(s, num) {
    var clipN = (s && s.clipNum != null) ? s.clipNum : num;
    return ((s && s.prefix) ? s.prefix : PREFIX) + '_S' + String(clipN).padStart(2, '0') + '_TH.mp3';
  }

  function prewarmSentences(tries, head) {
    if (prewarmStarted) return;              // the bulk pass covers the head too
    if (head && prewarmHeadDone) return;
    if (!sentences || !sentences.length) { latMark('prewarm:SKIP', 'no sentences yet'); return; }
    if (!navigator.onLine || !mayListen()) { latMark('prewarm:SKIP', 'offline or may not listen'); return; }   // no account → nothing to prewarm
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) { latMark('prewarm:SKIP', 'save-data/2g'); return; }
    if (dynBuilding) {   // let the build have the network to itself
      latMark('prewarm:wait', 'dyn build in flight, try ' + (tries || 0));
      if ((tries || 0) >= PREWARM_WAIT_TRIES) return;
      setTimeout(function () { prewarmSentences((tries || 0) + 1); }, PREWARM_WAIT_MS);
      return;
    }
    var refs = [];
    for (var i = 0; i < sentences.length && refs.length < PREWARM_MAX_FILES; i++) {
      var s = sentences[i];
      if (sentLocked(s)) continue;
      var pfx = s.prefix || PREFIX;
      if (!pfx || isDownloaded(pfx)) continue;
      var tr = s.tier || TIER;
      refs.push({ file: sentFileFor(s, s.num), gated: tr === 'member' || tr === 'premium' });
    }
    if (!refs.length) return;

    /* One batch mint for every gated clip, then the fetches — so the whole topic costs ONE
       /api/audio round trip instead of one per clip.
       ⚠⚠ THE HEAD PASS MINTS THE WHOLE TOPIC, NOT JUST ITS OWN FOUR CLIPS, AND THE ORDER OF
       THESE TWO LINES IS THE REASON. gatedFiles is taken from the FULL ref list; only then is
       `refs` narrowed to the head. The mint's cost is per USER, not per file — that is the
       premise batch minting rests on, and it measures out: 907ms for 4 files vs 495ms for 38
       on the same page load, so the count is noise. Minting only the head's four therefore
       bought nothing and cost a second round trip, because mintMany() dedupes against
       mintCache and a batch does not populate that until it RESOLVES — so the bulk pass,
       starting 168ms later, could not see them and re-issued all four.
       ⛔ Do not 'optimise' this back to `gatedFiles` after the slice. Signed-URL ISSUANCE is
       the counter audio_quota reads as an extraction signal; four spurious issuances on every
       page view is a constant added to a number whose whole job is to look unusual. */
    var gatedFiles = refs.filter(function (r) { return r.gated; }).map(function (r) { return r.file; });
    if (head) refs = refs.slice(0, PREWARM_HEAD);
    /* ⚠ WAIT FOR THE TOKEN — DO NOT LATCH WITHOUT ONE. This runs at idle (~2.5–4 s), and auth.js
       only resolves after a dynamic esm.sh import, so on a cold load the token can easily arrive
       later. mintMany() and buildUrl() both no-op silently on a null token, so latching here left
       a gated topic with NO warm blob and NO cached mint for the rest of the page's life — which
       puts every first tap on the slow, ASYNCHRONOUS path, and that is the path the stale-event
       race and the user-gesture rule both live on. Same wait as the dynBuilding case above. */
    /* ⚠ ONLY THE FILES WE STILL HAVE TO MINT NEED A TOKEN. Measured on a SECOND visit, with all
       42 urls restored from the persisted cache: the prewarm still stopped at 789ms to wait for
       auth and did not start until 1245ms — 456ms of doing nothing, for a page that needed no
       /api/audio call at all. On a phone, where auth resolves seconds rather than hundreds of ms
       after mount, that wait is the whole benefit of the persisted cache thrown away. */
    var needMint = gatedFiles.filter(function (f) { return !mintGet(f); });
    if (needMint.length && !authToken()) {
      latMark('prewarm:NO-TOKEN', 'try ' + (tries || 0) + ' — retry in ' + PREWARM_WAIT_MS + 'ms');
      if ((tries || 0) >= PREWARM_WAIT_TRIES) return;
      setTimeout(function () { prewarmSentences((tries || 0) + 1); }, PREWARM_WAIT_MS);
      return;
    }
    if (head) prewarmHeadDone = true; else prewarmStarted = true;
    // Both passes are warming toward the same total; a head-only `warm 4/0` reads as a bug.
    latWant = sentences.length;
    latMark(head ? 'HEAD:start' : 'prewarm:start', refs.length + ' clips, ' + gatedFiles.length + ' gated');

    var latMintT = performance.now();
    (gatedFiles.length ? mintMany(gatedFiles) : Promise.resolve()).then(function () {
      if (gatedFiles.length) latMark('mint:done', Math.round(performance.now() - latMintT) + 'ms for ' + gatedFiles.length + ' files');
      var queue = refs.slice();
      function lane() {
        if (!queue.length || sentBlobBytes > PREWARM_MAX_BYTES) return Promise.resolve();
        // A tap is loading: wait rather than compete with it. Re-checked, not slept through.
        if (sentBusy()) return new Promise(function (r) { setTimeout(r, 250); }).then(lane);
        var ref = queue.shift();
        return warmClip(ref).then(function (aborted) {
          ref.tries = (ref.tries || 0) + 1;
          if (aborted && ref.tries < PREWARM_MAX_ATTEMPTS) queue.push(ref);
          return lane();
        });
      }
      var lanes = [];
      // The head is small and it is what the user is waiting for: run it all at once.
      var pool = head ? Math.min(refs.length, PREWARM_HEAD_POOL) : PREWARM_POOL;
      for (var l = 0; l < Math.min(pool, refs.length); l++) lanes.push(lane());
      return Promise.all(lanes);
    }).then(function () {
      /* ⚠ THE BULK PASS STARTS HERE, NOT ON A TIMER. Its 2500ms wait exists so it can never
         compete with first paint — but the head pass only begins at mount, so by the time it
         has finished, paint is over by construction and the wait is pure dead time. Measured
         on a free topic (no mint to hide it): head done at 242ms, bulk not until 2541ms, and
         a tap at 1828ms found 26 of 30 clips still cold. The timer stays as a backstop for
         the case where the head never runs at all. */
      if (head) schedulePrewarmBulk(true);
    }).catch(function () {});
  }

  /* Resolves true when the fetch was ABORTED for a tap (so the caller can re-queue it) and false
     for success or any ordinary failure. Never rejects: a clip that will not warm is simply left
     to the normal tap path. */
  function warmClip(ref) {
    if (sentBlobs[ref.file]) return Promise.resolve(false);
    if (warmInflight[ref.file]) return Promise.resolve(false);   // the other pass has it
    if (sentBusy()) return Promise.resolve(true);
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (_) { ctrl = null; }
    // The controller carries its filename so prewarmYield can tell the tapped clip apart.
    if (ctrl) { ctrl.teFile = ref.file; prewarmCtrls.push(ctrl); }
    function done(v) {
      delete warmInflight[ref.file];
      if (ctrl) { var i = prewarmCtrls.indexOf(ctrl); if (i > -1) prewarmCtrls.splice(i, 1); }
      return v;
    }
    var run = buildUrl(ref.file, ref.gated)
      .then(function (u) {
        return fetch(u, ctrl ? { signal: ctrl.signal } : undefined)
          .then(function (r) { return r.ok ? r.blob() : null; });
      })
      .then(function (b) {
        if (b && b.size && !sentBlobs[ref.file]) {
          sentBlobs[ref.file] = b; sentBlobBytes += b.size;
          latWarm++;
          if (latWarm === 1) latMark('warm:FIRST', ref.file);
          if (latWarm === latWant) latMark('warm:ALL', latWarm + ' clips');
        }
        return done(false);
      })
      .catch(function (e) {
        var aborted = !!(e && (e.name === 'AbortError' || e.code === 20));
        return done(aborted);
      });
    /* Hold the PROMISE, not a flag: a tap arriving mid-download has to be able to wait for
       these exact bytes instead of asking for them again. Assigned after the chain is built
       and before any of it can run, since every link is asynchronous. */
    warmInflight[ref.file] = run;
    return run;
  }

  // A native downloadFile has no built-in deadline, so a stalled connection (slow network, or
  // contention from playing audio mid-download) would hang the whole sequential chain forever with
  // no error and no recovery. Cap each file with the native connect/read timeouts — Capacitor aborts
  // and rejects cleanly, so a retry to the SAME path is safe (no two concurrent writers) — plus a
  // generous app-level race as a backstop in case the native timeout is ever a no-op, and retry a few
  // times with a short backoff before failing the whole download. buildUrl() is re-minted per attempt
  // so an expired signed URL (or a transient /api/audio blip) also recovers.
  var DL_CONNECT_TIMEOUT_MS = 15000;
  var DL_READ_TIMEOUT_MS = 20000;
  var DL_RACE_TIMEOUT_MS = 45000;   // backstop, set > the native timeouts so the clean native abort wins
  var DL_MAX_TRIES = 3;
  function downloadFileWithRetry(file) {
    var dest = offlineDir(PREFIX) + '/' + file;
    function attempt(tryNo) {
      return buildUrl(file, GATED).then(function (url) {
        var dl = Filesystem.downloadFile({
          url: url, path: dest, directory: 'DATA', recursive: true,
          connectTimeout: DL_CONNECT_TIMEOUT_MS, readTimeout: DL_READ_TIMEOUT_MS
        });
        var backstop = new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('download timed out: ' + file)); }, DL_RACE_TIMEOUT_MS);
        });
        return Promise.race([dl, backstop]);
      }).catch(function (err) {
        if (tryNo >= DL_MAX_TRIES) throw err;
        console.warn('player.js: download retry ' + (tryNo + 1) + '/' + DL_MAX_TRIES + ' for ' + file, err);
        return new Promise(function (r) { setTimeout(r, 600 * tryNo); }).then(function () { return attempt(tryNo + 1); });
      });
    }
    return attempt(1);
  }

  // Web/PWA download of one file: fetch the remote MP3 (signed URL for premium) and store the
  // RESPONSE in Cache Storage under its stable same-origin key. With the default cors fetch mode a
  // missing Access-Control-Allow-Origin REJECTS the fetch (no silent opaque entry), so a CORS gap
  // surfaces as a clean error → retry → "Download failed" rather than caching an unseekable blob.
  // Mirrors the native retry policy (DL_MAX_TRIES, backoff, per-file deadline, URL re-minted/attempt).
  function webDownloadFileWithRetry(cache, file) {
    function attempt(tryNo) {
      return buildUrl(file, GATED).then(function (url) {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, DL_RACE_TIMEOUT_MS);
        return fetch(url, { mode: 'cors', cache: 'no-store', signal: ctrl.signal }).then(function (res) {
          clearTimeout(timer);
          if (!res || !res.ok) throw new Error('http ' + (res && res.status) + ' for ' + file);
          if (res.type === 'opaque') throw new Error('CORS not enabled (opaque) for ' + file);
          return cache.put(webCacheKey(PREFIX, file), res);
        }, function (e) { clearTimeout(timer); throw e; });
      }).catch(function (err) {
        if (tryNo >= DL_MAX_TRIES) throw err;
        console.warn('player.js: web download retry ' + (tryNo + 1) + '/' + DL_MAX_TRIES + ' for ' + file, err);
        return new Promise(function (r) { setTimeout(r, 600 * tryNo); }).then(function () { return attempt(tryNo + 1); });
      });
    }
    return attempt(1);
  }

  function webDownloadTopic(files) {
    var done = 0;
    // Ask the browser to make this origin's storage durable so iOS/WebKit is less likely to evict
    // the downloads under storage pressure. Best-effort — may be denied; we still proceed.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
    caches.open(AUDIO_DL_CACHE).then(function (cache) {
      var chain = Promise.resolve();
      files.forEach(function (file) {
        chain = chain.then(function () {
          return webDownloadFileWithRetry(cache, file).then(function () { done++; setOfflineState('downloading', done, files.length); });
        });
      });
      return chain;
    })
      .then(function () { return loadAudioVers(); })   // capture the audio stamp as the download's baseline
      .then(function () {
        markDownloaded(PREFIX, TIER || 'free', files, contentHash(), currentAv());
        stampVerified();                      // they were online + entitled at download time
        cachePage();                          // persist the page so it opens offline (survives SW updates)
        downloadingNow = false;
        setOfflineState('downloaded');
      })
      .catch(function (err) {
        var msg = dlErrText(err);   // NEVER String(err): a bare {code:402} renders as "[object Object]"
        console.warn('player.js: web offline download failed', err);
        downloadingNow = false;
        offlineBarFlash('error', msg, 6000);   // transient — restore the real state after (2026-08-09)
      });
  }

  // Delete a web download: drop every cached clip for this topic (from the manifest's file list,
  // falling back to the current file set) out of the audio cache.
  function webDeleteTopic() {
    if (!CACHES) return Promise.resolve();
    var ent = getManifest()[PREFIX];
    var files = (ent && ent.files) || topicFiles();
    return caches.open(AUDIO_DL_CACHE).then(function (c) {
      return Promise.all(files.map(function (file) { return c.delete(webCacheKey(PREFIX, file)).catch(function () {}); }));
    }).catch(function () {});
  }


  /* ══ r21: the offline bar on DYN pages ═══════════════════════════════════════════════
     Topic pages and the playlist player get the SAME download control the live site has —
     the same button, the same "✓ Available offline", the same Delete → "Delete this
     download?" → Delete/Keep confirm, the same states. Only what it downloads differs: a dyn
     unit needs its per-sentence _TH + _EN clips, not the prefab TE/ET pair.
     Written per-SENTENCE-prefix so it serves a playlist (whose clips span several topics)
     and a topic page (whose sentences carry no prefix and fall back to this page's) with one
     implementation. EXCLUDED sentences are downloaded too — exclusion is a playback choice,
     and re-including one later must not need a connection. */
  function dynDlRef() { return PLMODE ? DYN_KEY_NS : 'topic'; }
  /* r24: the update prompt now means what it should — THE AUDIO ON R2 HAS CHANGED. (It used to
     mean "your settings no longer match the stored mp3", which was noise: pressing play
     reconstructs anyway, so it resolved itself and never needed a button.)
     Reuses the live site's existing mechanism: audio-versions.json stamps each topic's audio,
     the stamp is recorded per prefix at download time, and a mismatch means the clips were
     re-rendered. A missing stamp ADOPTS the current value rather than nagging, exactly as the
     classic path does for downloads that predate the mechanism. */
  function dynDropSessions() {
    /* r137 — ONE IMPLEMENTATION WHEREVER BOTH EXIST. dl-core.js now carries this too, because the
       index and the playlists list change a unit's clips as well and until r137 neither dropped
       the session that was built from the old ones. Topic pages do NOT load dl-core.js — folding
       player.js into it is still the separate pass dl-core's own header describes — so the inline
       copy below stays as the fallback rather than adding a script tag to 93 pages for one
       function. The shared version also deletes the file for a MALFORMED meta, which dynReadMeta's
       validation makes this one skip (it would orphan the bytes until the cap sweep). */
    if (window.ThaiEarDL && window.ThaiEarDL.dropSessions) {
      var FSP = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.Filesystem : null;
      window.ThaiEarDL.dropSessions(DYN_KEY_NS, { native: NATIVE, fs: FSP }, AUDIO_DL_CACHE);
      dynSession = null; mainSrcReady = false;
      return;
    }
    ['te', 'et'].forEach(function (mode) {
      var meta = dynReadMeta(DYN_KEY_NS, mode);
      try { localStorage.removeItem(dynMetaLsKey(DYN_KEY_NS, mode)); } catch (_) {}
      if (!meta) return;
      if (NATIVE && meta.file) {
        var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
        if (FS) FS.deleteFile({ path: meta.file, directory: 'DATA' }).catch(function () {});
      } else if (window.caches) {
        caches.open(AUDIO_DL_CACHE).then(function (c) {
          c.delete(dynCachePath(DYN_KEY_NS, mode, meta.ext)).catch(function () {});
        }).catch(function () {});
      }
    });
    dynSession = null; mainSrcReady = false;
  }
  /* ── r137: a PLAYLIST's audio baseline lives in ITS OWN download record ──────────────────
     Twin of pl-list.js's dlPlAv/dlAvSnapshot — the long note there carries the reasoning. Short
     version: the published stamp fingerprints a whole TOPIC's audio, but a playlist holds a SUBSET
     of a prefix's clips and spans several prefixes, so writing the shared prefix-level `av` from a
     playlist download would tell the index card and the topic page that the entire topic is
     current when only a few of its clips were fetched — suppressing a real update prompt.
     The list and this player MUST read the same record or they will disagree about the same
     playlist, which is the two-surfaces-drift this file's own comments keep flagging. */
  function dynPlKeyId() { var k = String(cfg.dynKey || ''); return k.indexOf('pl-') === 0 ? k.slice(3) : null; }
  function dynPlRecMap() { try { return JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}'); } catch (_) { return {}; } }
  function dynPlAv() { var id = dynPlKeyId(); if (!id) return null; var r = dynPlRecMap()[id]; return (r && r.av) || null; }
  function dynPlAvSet(avByPfx) {
    var id = dynPlKeyId(); if (!id) return;
    try {
      var pm = dynPlRecMap(), r = pm[id] || (pm[id] = {});
      r.av = avByPfx;
      localStorage.setItem('thaiear_offline_pl', JSON.stringify(pm));
    } catch (_) {}
  }
  function dynCheckAudioUpdate() {
    // &avtest=1 forces the prompt so the flow can be SEEN without editing audio-versions.json.
    // That file is shared with the LIVE site — the test pages use live topics' audio prefixes —
    // so bumping a real entry would nag every user who downloaded topic 3 into re-fetching
    // identical files. A URL flag costs nothing and touches no live data.
    /* r83: ALSO a sim-panel checkbox. The URL flag is unusable in the app and the home-screen PWA —
       neither has an address bar — which is the same wall ?dbg=1 and webdl hit (r49). */
    var force = /[?&]avtest=1(&|$)/.test(location.search);
    try { if (localStorage.getItem('thaiear_avtest') === '1') force = true; } catch (_) {}
    if (!navigator.onLine && !force) return;   // can't check it, and couldn't act on it either
    loadAudioVers().then(function (map) {
      if (!map && !force) return;
      map = map || {};
      var by = dynDlGroups(), m = getManifest(), adopted = false, stale = false;
      // r137: a playlist compares against its OWN baseline (see dynPlAv), a topic against the
      // prefix-level one. Same question, different record, because they hold different things.
      var plAv = PLMODE ? (dynPlAv() || {}) : null;
      Object.keys(by).forEach(function (pfx) {
        var e = m[pfx]; if (!e) return;
        var cur = map[pfx];
        /* ⚠ r84 — THE FLAG PERTURBS THE PUBLISHED STAMP, IT DOES NOT SHORT-CIRCUIT THE CHECK.
           Owner's challenge, 2026-08-01: is this an actual TEST or a dumb UI switcher? It was the
           latter — `if (force) stale = true` sat AFTER this loop and skipped every real question.
           Now the flag only changes the value we pretend R2 published, and the production path runs
           in full: the map must load, a manifest entry must exist, the `av` baseline must have been
           recorded at download time, and the genuine `e.av !== cur` comparison decides.
           The tell that it is real: a topic that is NOT downloaded, or downloaded before any stamp
           existed, correctly stays quiet under the flag — a dumb switch would light those up. */
        if (force && cur != null) cur = String(cur) + '#avtest';
        if (cur == null) return;                                  // nothing published for it
        var base = PLMODE ? plAv[pfx] : e.av;
        if (base == null) {                                       // baseline, don't nag
          if (PLMODE) plAv[pfx] = cur; else e.av = cur;
          adopted = true; return;
        }
        if (base !== cur) stale = true;
      });
      /* ⚠ Do NOT persist an adopted baseline while the flag is on — it would write the perturbed
         value into the manifest and the topic would stay "stale" after the flag came off. */
      if (adopted && !force) { if (PLMODE) dynPlAvSet(plAv); else setManifest(m); }
      if (!stale) return;
      var bar = $('offline-bar'); if (!bar) return;
      bar.innerHTML = '<span class="offline-status">⟳ Download audio update?</span>' +
        '<button class="offline-btn" onclick="dynUpdateAudio()">Update</button>' +
        '<button class="offline-btn offline-del" onclick="confirmDelete()">Delete</button>';
    }).catch(function () {});
  }
  function dynUpdateAudio() {
    // Transient too — same reasoning as downloadTopic's offline guard: keep Update/Delete reachable.
    if (!navigator.onLine) { offlineBarFlash('error', 'you’re offline — reconnect to update'); return; }
    /* Update FETCHES NEW BYTES, so it needs the same account requirement as a fresh download —
       it reaches dynDownloadHere() directly and would otherwise slip past downloadTopic()'s guard.
       Only reachable on an already-downloaded topic, so this bites only if someone downloaded and
       then signed out; their EXISTING download keeps working (Delete stays available), they just
       can't pull new audio without signing back in. */
    if (!entitledForPage()) { gate(TIER); return; }
    if (downloadNeedsSignIn()) {
      window.location.href = 'join.html?feature=1&next=' +
        encodeURIComponent(PAGE_FILE + location.search);
      return;
    }
    // The stored mp3 was built from the OLD clips, and its key encodes settings, not clip
    // content — so it would NOT rebuild by itself and would keep playing superseded audio.
    dynDropSessions();
    dynDownloadHere();
  }
  /* r22: how much room this download actually takes, shown next to "Available offline".
     Measured, not estimated — the clip files plus the constructed sessions — and cached into
     the manifest so the per-file stat/cache-read happens once, not on every render. Measuring
     lazily (rather than tallying during the download) means downloads made BEFORE this existed
     get a figure too, with one code path instead of two. */
  /* Which prefixes does this unit actually HOLD on disk? dynDlGroups() answers "what does it NEED",
     which is empty when every sentence is locked — and an empty set made the size read a confident
     "0.00 MB" for a download that genuinely occupies space (owner, on a downloaded premium playlist
     after a lapse). Same empty-set trap as r40. When there is nothing needed but a download record
     exists, fall back to what the RECORD says was stored. */
  /* Did the TOPIC itself download this prefix, as opposed to a playlist merely claiming clips under
     it? A classic download writes no `refs` field at all and is read as an implicit topic claim —
     the same assumption dynDeleteHere() and deleteTopic() make (r32). */
  function hasTopicClaim(prefix) {
    var e = getManifest()[prefix];
    if (!e) return false;
    return !e.refs || e.refs.indexOf('topic') >= 0;
  }
  /* Every clip THIS unit is made of, per prefix, IGNORING locks — `{prefix: {file: 1}}`.
     dynDlGroups() cannot answer this: it filters locked sentences, so it is empty for a gated
     playlist. Needed because the manifest records files per PREFIX, shared by every claimant, and
     a playlist holding three sentences of a topic must not report the whole topic's size. */
  function dynUnitFileSet() {
    var by = {};
    sentences.forEach(function (s) {
      var th = dynClipRef(s, 'TH'), en = dynClipRef(s, 'EN');
      (by[th.prefix] = by[th.prefix] || {})[th.file] = 1;
      (by[en.prefix] = by[en.prefix] || {})[en.file] = 1;
    });
    return by;
  }
  /* Does this unit need EVERY file recorded under `pfx`? Only then is the manifest's cached
     `bytes` (a per-prefix total) a truthful answer for this unit. */
  function dynOwnsWholePrefix(pfx, own) {
    var e = getManifest()[pfx]; if (!e) return false;
    var files = e.files || [], mine = own[pfx] || {};
    for (var i = 0; i < files.length; i++) if (!mine[files[i]]) return false;
    return true;
  }
  /* r75 — WHICH PREFIXES HAS THIS UNIT ACTUALLY CLAIMED ON DISK? Lock-INDEPENDENT, deliberately.
     `dynDlGroups()` answers a different question — "what may this visitor FETCH" — because it
     filters locked sentences so a denied clip can't abort a download. Reusing it to decide what to
     RELEASE meant a gated playlist released only its unlocked prefixes (and an ALL-premium one
     released nothing at all) while still deleting its download record, stranding clips that were
     claimed by a ref whose record no longer existed. Owner found it from the size figure, 2026-08-01.
     ⚠ TOPIC PAGES WERE NEVER AFFECTED — `sentLocked()` returns false when `!PLMODE` (player.js:2020),
     so a topic's group is never lock-filtered. That is why the r60–r62 removal work passed T-4/T-6c
     on topics and left this half undone; the owner called that split correctly.
     Ground truth is the manifest's own refs: an entry carrying OUR ref is a clip we claimed,
     regardless of what we may fetch today. The download record is then unioned in as belt-and-braces
     (it lists what was stored at download time, while entitled), restricted to prefixes that still
     exist so a stale record can never resurrect a released prefix.
     ⚠ PLAYLIST-ONLY SCAN. For a topic page the ref is the literal string 'topic', which EVERY
     classic download writes (§B2d) — scanning for it would match every downloaded topic on the
     device and delete all of them. Topic pages therefore return their own PREFIX and nothing else. */
  function dynOwnedPrefixes() {
    if (!PLMODE) return PREFIX ? [PREFIX] : [];
    var ref = dynDlRef(), m = getManifest(), out = [];
    Object.keys(m).forEach(function (pfx) {
      var e = m[pfx];
      if (e && e.refs && e.refs.indexOf(ref) >= 0) out.push(pfx);
    });
    try {
      var rec = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}')[String(ref).replace(/^pl-/, '')];
      if (rec && rec.prefixes) rec.prefixes.forEach(function (p) {
        if (m[p] && out.indexOf(p) < 0) out.push(p);
      });
    } catch (_) {}
    return out;
  }
  function dynClaimedPrefixes() {
    /* r75: ask what we HOLD before what we may fetch, so a gated unit reports (and releases) the
       clips it actually occupies. Falling back to the group keeps the r66 "available offline"
       state intact — a unit with no claim of its own owns nothing here and must still be able to
       report the borrowed clips it can play. */
    var owned = dynOwnedPrefixes();
    if (owned.length) return owned;
    var keys = Object.keys(dynDlGroups());
    if (keys.length) return keys;
    if (PLMODE) {
      var id = String(cfg.dynKey || '').replace(/^pl-/, '');
      try {
        var rec = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}')[id];
        if (rec && rec.prefixes && rec.prefixes.length) return rec.prefixes;
      } catch (_) {}
      return [];
    }
    return PREFIX ? [PREFIX] : [];
  }
  function dynDlSizeCached() {
    var by = {}, m = getManifest(), total = 0, known = true;
    var own = dynUnitFileSet();
    dynClaimedPrefixes().forEach(function (k) { by[k] = 1; });
    Object.keys(by).forEach(function (pfx) {
      var e = m[pfx];
      if (!e || typeof e.bytes !== 'number') { known = false; return; }
      /* `bytes` is a PER-PREFIX total, shared with every other claimant. It is only this unit's
         answer when this unit needs the whole prefix; otherwise fall through to a real measure,
         or a playlist of three sentences reports the entire topic's size (owner: 0.57 MB on a
         handful of sentences). */
      if (!dynOwnsWholePrefix(pfx, own)) { known = false; return; }
      total += e.bytes;
    });
    // r24: RAW CLIPS ONLY. Counting the constructed mp3 made the figure move every time the
    // settings changed, which looked like the download changing when only the working file had.
    // The clips are what was actually downloaded; the mp3 is explicitly "replaced each time you
    // generate a new dynamic mp3", so it is not part of what this number promises.
    return known ? total : null;
  }
  function dynDlMeasure() {
    var m = getManifest();
    /* Measure every claimed prefix whose per-unit size we cannot already answer. The `bytes`
       shortcut only applies when this unit owns the whole prefix — see dynDlSizeCached. */
    var own = dynUnitFileSet();
    var prefixes = dynClaimedPrefixes().filter(function (p) {   // HOLDS, not NEEDS — see the helper
      var e = m[p];
      if (!e) return false;
      return typeof e.bytes !== 'number' || !dynOwnsWholePrefix(p, own);
    });
    if (!prefixes.length) return Promise.resolve(dynDlSizeCached());
    var partial = {};                 // pfx -> this unit's measured bytes (may be a subset)
    var chain = Promise.resolve();
    prefixes.forEach(function (pfx) {
      chain = chain.then(function () {
        /* ⚠ ONLY THIS UNIT'S CLIPS. The manifest lists files per PREFIX, shared by every
           claimant, so summing them all made a three-sentence playlist report the whole topic's
           size. Intersect with the unit's own set. */
        var mine = own[pfx] || {};
        var files = ((getManifest()[pfx] || {}).files || []).filter(function (f) { return mine[f]; });
        var whole = dynOwnsWholePrefix(pfx, own), sum = 0;
        return dynPool(files, function (f) {
          if (DYN_WEB_DL) {
            return caches.open(AUDIO_DL_CACHE)
              .then(function (c) { return c.match(webCacheKey(pfx, f)); })
              .then(function (r) { return r ? r.blob() : null; })
              .then(function (b) { if (b) sum += b.size; })
              .catch(function () {});
          }
          if (!Filesystem) return null;
          return Filesystem.stat({ path: offlineDir(pfx) + '/' + f, directory: 'DATA' })
            .then(function (r) { sum += (r && r.size) || 0; })
            .catch(function () {});
        }).then(function () {
          /* Cache the per-prefix total ONLY when this unit is the whole prefix. Writing a
             partial sum here would poison the shared figure for the topic that owns it. */
          partial[pfx] = sum;
          if (!whole) return;
          var mm = getManifest();
          if (mm[pfx]) { mm[pfx].bytes = sum; setManifest(mm); }
        });
      });
    });
    /* Total from what we just measured, plus the cached figure for any prefix this unit owns
       whole and therefore skipped. Deliberately NOT `dynDlSizeCached()` alone: that reads the
       shared per-prefix `bytes`, which is not this unit's answer for a partial claim. */
    return chain.then(function () {
      var mm = getManifest(), total = 0, ownSet = dynUnitFileSet();
      dynClaimedPrefixes().forEach(function (pfx) {
        if (partial[pfx] != null) { total += partial[pfx]; return; }
        var e = mm[pfx];
        if (e && typeof e.bytes === 'number' && dynOwnsWholePrefix(pfx, ownSet)) total += e.bytes;
      });
      return total;
    });
  }
  /* "Available offline" now means something WEAKER on a playlist — its clips may be here on another
     download's coat-tails (r66). Reaching this label at all means the unit has its own claim, so on
     a playlist say DOWNLOADED, which is the durable promise the row caption also makes.
     r74 (owner, 2026-08-01): a DYN TOPIC now says "Downloaded for offline" too. Same reasoning one
     step further — reaching this label means an own claim, and "available" is now the site's word
     for the borrowed state, so using it for a topic contradicts the vocabulary the playlist rows
     and the info box teach. V-7 originally asserted the OLD wording; it is updated with this.
     P2a ROLLOUT (2026-08-02): the deliberate three-way split (non-DYN live pages said
     "✓ Available offline") is RETIRED — every topic page is dyn:true now, so the held-back DYN
     test was deleted exactly as §C-PORT item 7 planned. Two-way: playlist vs topic. */
  function dynOkLabel() {
    if (PLMODE) return '✓ Downloaded';
    return '✓ Downloaded for offline';   // P2a rollout: the DYN test is gone — every topic page is dyn now
  }
  function dynFmtMb(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function dynPaintOfflineSize() {
    var el = document.querySelector('#offline-bar .offline-ok');
    if (!el) return;
    var cached = dynDlSizeCached();
    if (cached != null) { el.textContent = dynOkLabel() + ' (' + dynFmtMb(cached) + ')'; return; }
    dynDlMeasure().then(function (t) {
      var e2 = document.querySelector('#offline-bar .offline-ok');   // may have re-rendered meanwhile
      if (e2 && t != null) e2.textContent = dynOkLabel() + ' (' + dynFmtMb(t) + ')';
    }).catch(function () {});
  }

  function dynDlGroups() {
    var by = {};
    // Never try to DOWNLOAD a locked sentence: its clips would 401/402 and, because dynDlFile
    // throws after its retries, one denied clip aborts the whole download — the same
    // all-or-nothing failure the playback path had. Topic pages are unaffected (sentLocked is
    // PLMODE-only), and a per-session EXCLUDED sentence is still downloaded on purpose, so it
    // is there the moment the user re-includes it.
    sentences.filter(function (s) { return !sentLocked(s); }).forEach(function (s) {
      var th = dynClipRef(s, 'TH'), en = dynClipRef(s, 'EN');
      by[th.prefix] = by[th.prefix] || { tier: th.tier, files: [] };
      by[th.prefix].files.push(th.file, en.file);
    });
    return by;
  }
  /* Is there anything at all this visitor may download? False for an all-premium unit with no
     entitlement. Kept as a named helper because "every needed clip is present" is VACUOUSLY TRUE
     over an empty set, so every caller of dynDlHasAll() has to rule the empty case out first. */
  dynDlGroups.hasAny = function () { return Object.keys(dynDlGroups()).length > 0; };
  // Reality, not a flag: is every clip this unit needs actually in the store? Self-healing,
  // and it catches an interrupted download or a partial eviction.
  function dynDlHasAll() {
    var by = dynDlGroups(), m = getManifest(), pfx, i;
    for (pfx in by) {
      var have = (m[pfx] && m[pfx].files) || [];
      var seen = {};
      have.forEach(function (f) { seen[f] = true; });
      for (i = 0; i < by[pfx].files.length; i++) if (!seen[by[pfx].files[i]]) return false;
    }
    return true;
  }
  /* Was this unit downloaded BEFORE and is now incomplete? Only worth distinguishing for a
     playlist the user downloaded and then ADDED sentences to: the new clips were never fetched, so
     an offline build dies on a plain network error (dynBuildSessionFor forgives GATE codes only).
     "Download for offline" is technically true there but tells them nothing — the button is the
     one place we can say WHY before they are offline and out of options.
     The record lives in the playlists page's thaiear_offline_pl map keyed by playlist id, and
     dynKey already carries that id as 'pl-{id}', so nothing new has to be threaded through cfg. */
  function dynDlWasDownloaded() {
    if (!PLMODE) return false;
    var key = String(cfg.dynKey || '');
    if (key.indexOf('pl-') !== 0) return false;
    try { return !!JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}')[key.slice(3)]; }
    catch (_) { return false; }
  }
  /* r79 — twin of playlists.html's dlOwnedNeeded(). Does OUR ref cover every prefix this unit
     needs, with the files actually present, and does it cover any at all?
     ⚠ A topic page is unaffected by design: its ref is 'topic', and a classic download writes NO
     refs field, which is read as an implicit topic claim (§B2d) — so `mine` is true exactly as
     before. Only PLMODE consults this. */
  /* ⚠ r81 — COUNTED PER FILE, NOT PER PREFIX. See the twin in playlists.html for the full note:
     treating a prefix as a unit made partial ownership invisible for any unit drawn from a SINGLE
     topic (the common case), so the bar fell through to "Download for offline" and never offered
     the update. 12 of 14 files owned must read as `update`, not as nothing. */
  function dynDlOwnedNeeded() {
    var by = dynDlGroups(), m = getManifest(), ref = dynDlRef();
    var need = 0, owned = 0, pfx, i;
    for (pfx in by) {
      var e = m[pfx];
      var ours = !!(e && (e.refs || ['topic']).indexOf(ref) >= 0);
      var seen = {};
      if (ours) (e.files || []).forEach(function (f) { seen[f] = true; });
      var files = by[pfx].files;
      for (i = 0; i < files.length; i++) { need++; if (seen[files[i]]) owned++; }
    }
    return { all: need > 0 && owned === need, some: owned > 0 };
  }
  function dynDlFile(cache, pfx, tier, file) {
    var gated = (tier === 'member' || tier === 'premium');
    function attempt(tryNo) {
      return buildUrl(file, gated).then(function (url) {
        if (DYN_WEB_DL) {
          var ctrl = new AbortController();
          var timer = setTimeout(function () { ctrl.abort(); }, DL_RACE_TIMEOUT_MS);
          return fetch(url, { mode: 'cors', cache: 'no-store', signal: ctrl.signal }).then(function (res) {
            clearTimeout(timer);
            if (!res || !res.ok) throw new Error('http ' + (res && res.status) + ' for ' + file);
            if (res.type === 'opaque') throw new Error('CORS not enabled (opaque) for ' + file);
            return cache.put(webCacheKey(pfx, file), res);
          }, function (e) { clearTimeout(timer); throw e; });
        }
        var dl = Filesystem.downloadFile({ url: url, path: offlineDir(pfx) + '/' + file, directory: 'DATA',
          recursive: true, connectTimeout: DL_CONNECT_TIMEOUT_MS, readTimeout: DL_READ_TIMEOUT_MS });
        var backstop = new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('download timed out: ' + file)); }, DL_RACE_TIMEOUT_MS);
        });
        return Promise.race([dl, backstop]);
      }).catch(function (err) {
        if (tryNo >= DL_MAX_TRIES) throw err;
        return new Promise(function (r) { setTimeout(r, 600 * tryNo); }).then(function () { return attempt(tryNo + 1); });
      });
    }
    return attempt(1);
  }
  function dynDownloadHere() {
    /* Transient (2026-08-09): this used to replace the bar PERMANENTLY, so on an already-downloaded
       unit one tap on Download hid Update and Delete behind a dead "You're offline" line with no
       way back short of a reload. Flash it, then restore the real state. */
    if (!navigator.onLine) { offlineBarFlash('offline'); return; }   // don't grind through retries
    var by = dynDlGroups(), prefixes = Object.keys(by), total = 0, done = 0;
    prefixes.forEach(function (k) { total += by[k].files.length; });
    if (!total) return;
    function step() { done++; setOfflineState('downloading', done, total); }
    downloadingNow = true;
    setOfflineState('downloading', 0, total);
    if (DYN_WEB_DL) { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {} }
    /* ⚠⚠ r137 — "DOWNLOAD AUDIO UPDATE?" DID NOT DOWNLOAD THE AUDIO UPDATE.
       D0b's skip (below) asks hasLocalFile(), which reads the MANIFEST, not the bytes — so for a
       fully-downloaded topic whose clips had been re-rendered on R2, EVERY file was "already
       present" and every one was skipped. dynUpdateAudio() therefore dropped the built session,
       re-stitched from the very same superseded clips, and then stamped the current audio version
       onto the entry — after which no surface would ever offer the update again. The prompt was
       real, the button was not.
       The skip is still right for its actual purpose (topping up a partial or classic download).
       It is wrong exactly when the published stamp says this prefix has MOVED, so that is the one
       case it now yields to. Per prefix, because a playlist spans several topics and only some of
       them may have been re-rendered.
       Deliberately conservative: no published map, no recorded baseline, or a matching stamp all
       mean "not stale" and leave the resume behaviour untouched. */
    var chain = loadAudioVers().catch(function () { return null; }).then(function (avMap) {
      var forceAll = {}, anyForced = false, mNow = getManifest();
      var plBase = PLMODE ? (dynPlAv() || {}) : null;   // r137: playlists compare their own baseline
      prefixes.forEach(function (pfx) {
        var e = mNow[pfx];
        if (!avMap || !e) return;
        var base = PLMODE ? plBase[pfx] : e.av;
        if (base == null) return;
        var cur = avMap[pfx];
        if (cur != null && base !== cur) { forceAll[pfx] = true; anyForced = true; }
      });
      // The stitched session was built from the clips we are about to replace, and its key encodes
      // settings rather than clip content — so it cannot notice. Drop it here as well as in
      // dynUpdateAudio(), which covers the routes that reach this function without going through
      // that button (the !dynDlHasAll 'update' branch calls downloadTopic() directly).
      if (anyForced) dynDropSessions();
      return { force: forceAll, cache: null };
    }).then(function (st) {
      return (DYN_WEB_DL ? caches.open(AUDIO_DL_CACHE) : Promise.resolve(null))
        .then(function (cache) { st.cache = cache; return st; });
    });
    chain = chain.then(function (st) {
      var cache = st.cache, c = Promise.resolve();
      prefixes.forEach(function (pfx) {
        c = c.then(function () {
          return OFFLINE ? Filesystem.mkdir({ directory: 'DATA', path: offlineDir(pfx), recursive: true })
            .catch(function () {}) : null;      // downloadFile does NOT create parents on Android
        }).then(function () {
          /* D0b (rollout P1): a clip already on disk — a classic download's TH clips (same
             filenames as the dyn set), or a clip a previous partial dyn download already fetched
             — doesn't need re-fetching. Skip the network call but still count it via step(), so
             an "Update" over a classic download reads as a genuine top-up (only the missing _EN
             clips actually move) instead of grinding through everything again.
             r137: unless this prefix is SUPERSEDED — see the note above. */
          return dynPool(by[pfx].files, function (f) {
            if (!st.force[pfx] && hasLocalFile(pfx, f)) { step(); return Promise.resolve(); }
            return dynDlFile(cache, pfx, by[pfx].tier, f).then(step);
          });
        });
      });
      return c;
    });
    chain.then(function () { return loadAudioVers(); }).then(function (avMap) {
      // Merge into whatever is already recorded — a playlist and a topic can legitimately both
      // claim the same prefix, and neither may erase the other's files or ref.
      var m = getManifest(), ref = dynDlRef();
      var purgeFiles = [];   // D0c (rollout P1): TE/ET this topic's own dyn download makes redundant
      prefixes.forEach(function (pfx) {
        var existed = !!m[pfx];
        var e = m[pfx] || { tier: by[pfx].tier, files: [], ver: '', av: null };
        var seen = {};
        (e.files || []).concat(by[pfx].files).forEach(function (f) { seen[f] = true; });
        e.files = Object.keys(seen);
        /* DATA LOSS GUARD. A classic topic download records no refs at all, so its claim is
           IMPLICIT — and dynDeleteHere() honours that by defaulting to ['topic']. This line
           defaulted to [] instead, silently discarding it: download a playlist sharing the
           prefix, then clear that playlist, and refs emptied → recursive rmdir of
           offline/<prefix>/ → the TOPIC's combined _TE/_ET files were deleted with it.
           Match the delete path's assumption: a pre-existing entry keeps its implicit claim. */
        e.refs = (e.refs || (existed ? ['topic'] : [])).filter(function (r) { return r !== ref; });
        e.refs.push(ref);
        e.tier = by[pfx].tier; e.at = Date.now(); e.dyn = true;
        delete e.bytes;                       // file set changed → re-measure rather than lie
        /* r137 — TOPIC DOWNLOADS ONLY. A topic download fetches every clip under the prefix, so
           stamping the shared prefix-level baseline is honest. A PLAYLIST download fetches a
           subset, and writing it here would claim the whole topic is current — silencing a real
           update prompt on the index card and the topic page. A playlist records its own baseline
           in its own download record instead (dynPlAvSet, below). */
        if (!PLMODE && avMap && avMap[pfx] != null) e.av = avMap[pfx];   // baseline for "audio update?"
        /* r137 — record the complete-download file count for the INDEX's benefit (dl-core
           hasNeeded / index isDownloaded). Only for a topic's own download: a playlist needs just
           a SUBSET of a prefix's clips, so stamping its count would tell the index grid that a
           partial holding is a whole topic — the very confusion this field exists to end. Written
           at finalize, where every file has landed, so the number is true when it is written. */
        if (!PLMODE && ref === 'topic') e.need = by[pfx].files.length;
        /* D0c (rollout P1): this topic's OWN dyn download now covers everything the player needs
           (mainSrcFor/ensureMainSrc never touch the combined file once DYN is true — see
           dynEnsureMainSrc), so the classic TE/ET pair is dead weight the moment the per-sentence
           clips are in. Topic pages only, and only THIS topic's own claim: a playlist sharing the
           prefix has ref !== 'topic' and must never drop a pair it doesn't own. */
        if (!PLMODE && ref === 'topic') {
          ['_TE.mp3', '_ET.mp3'].forEach(function (suf) {
            var f = pfx + suf, idx = e.files.indexOf(f);
            if (idx >= 0) { e.files.splice(idx, 1); purgeFiles.push({ pfx: pfx, file: f }); }
          });
        }
        m[pfx] = e;
      });
      setManifest(m);
      /* Best-effort, fire-and-forget: the manifest entry has already dropped these filenames
         above, so nothing reads them for playback — a failed physical delete just leaves harmless
         orphaned bytes, never a broken download. Mirrors dynDeleteHere's native/web split. */
      if (purgeFiles.length) {
        try {
          purgeFiles.forEach(function (pf) {
            if (OFFLINE) {
              Filesystem.deleteFile({ path: offlineDir(pf.pfx) + '/' + pf.file, directory: 'DATA' }).catch(function () {});
            } else if (CACHES) {
              caches.open(AUDIO_DL_CACHE).then(function (c) {
                c.delete(webCacheKey(pf.pfx, pf.file)).catch(function () {});
              }).catch(function () {});
            }
          });
        } catch (_) {}
      }
      if (PLMODE) {   // so the playlists page's own Clear knows which prefixes to release
        try {
          // r137: …and its own audio baseline, in the same shape pl-list.js writes (dlAvSnapshot),
          // so a playlist downloaded from the player and one downloaded from the list are
          // indistinguishable afterwards.
          var snap = {};
          if (avMap) prefixes.forEach(function (pfx) { if (avMap[pfx] != null) snap[pfx] = avMap[pfx]; });
          var pm = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}');
          pm[String(DYN_KEY_NS).replace(/^pl-/, '')] = { prefixes: prefixes, at: Date.now(), av: snap };
          localStorage.setItem('thaiear_offline_pl', JSON.stringify(pm));
        } catch (_) {}
      }
      stampVerified();
      cachePage();
      downloadingNow = false;
      setOfflineState('downloaded');
      dynPaintOfflineSize();
    }).catch(function (err) {
      downloadingNow = false;
      console.warn('player.js: dyn download failed', err);
      // navigator.onLine lies in the WebView (often "online" in airplane mode), so treat a
      // network-shaped failure as offline too — "Download failed: load failed" is not an
      // explanation, and this matches the wording the real index already uses.
      var msg = dlErrText(err);   // NEVER String(err): a bare {code:402} renders as "[object Object]"
      /* Flashed, not left up (2026-08-09). A failed download is worth reading, but it is not the
         unit's STATE — leaving it there hid Update and Delete on a unit that still had a perfectly
         good partial download. 6s, then the bar re-derives what is actually on the device. */
      if (!navigator.onLine || /failed to fetch|load failed|network|timed out|networkerror/i.test(msg)) {
        offlineBarFlash('offline', null, 6000);
      } else {
        offlineBarFlash('error', msg, 6000);
      }
    });
  }
  /* Which files under `pfx` are still needed by claimants OTHER than the one being released?
     Recomputed from first principles instead of tracked per file: the downloaded-playlist map
     (thaiear_offline_pl) says WHICH playlists hold a download, and the cached playlist contents
     (thaiear_playlists) say exactly which clips each one needs.
     Returns null when it cannot answer — no cached list, or a surviving pl-* claim whose playlist
     is not in the cache. null means "keep everything": deleting a clip a playlist needs is the one
     mistake that actually breaks playback. */
  function dynNeededByOthers(pfx, dropRef, survivingRefs) {
    var dl = {}, lists = null;
    try { dl = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}'); } catch (_) {}
    try { lists = JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) {}
    if (!lists) return null;
    var known = {};
    lists.forEach(function (p) { known['pl-' + p.id] = p; });
    for (var i = 0; i < survivingRefs.length; i++) {
      var r = survivingRefs[i];
      if (r.indexOf('pl-') === 0 && !known[r]) return null;   // a claim we cannot evaluate
    }
    var need = {};
    lists.forEach(function (p) {
      var ref = 'pl-' + p.id;
      if (ref === dropRef || !dl[p.id]) return;               // not a surviving DOWNLOADED claimant
      (p.items || []).forEach(function (it) {
        if (it.prefix !== pfx) return;
        var n = String(it.num).padStart(2, '0');
        need[pfx + '_S' + n + '_TH.mp3'] = true;
        need[pfx + '_S' + n + '_EN.mp3'] = true;
      });
    });
    return need;
  }
  function dynDeleteHere() {
    /* r75: release what we HOLD (dynOwnedPrefixes), never what we may currently FETCH
       (dynDlGroups). The old group-based loop skipped every locked prefix, so on a gated playlist
       this button deleted the record while leaving the premium clips claimed and unreclaimable —
       and on an all-premium one it iterated nothing whatsoever. See the helper for the full note. */
    var m = getManifest(), ref = dynDlRef();
    var chain = Promise.resolve();
    dynOwnedPrefixes().forEach(function (pfx) {
      var e = m[pfx]; if (!e) return;
      /* Release our claim at FILE level, not directory level. Keeping the whole prefix because one
         playlist holds ONE sentence meant a user who deleted a 25-sentence topic reclaimed nothing
         — 0.58 MB of clips with no remaining claim. Correct is: keep exactly the clips the
         surviving claimants need, delete the rest.
         It also fixes the UI for free: once the other clips are gone dynDlHasAll() is false, so the
         bar drops to "Download for offline" by itself instead of insisting "Available offline"
         immediately after a delete. */
      e.refs = (e.refs || ['topic']).filter(function (r) { return r !== ref; });
      var files = e.files || [];
      var keep = null;
      if (e.refs.length) {
        // The topic claim needs every clip, so nothing can be trimmed while it survives.
        if (e.refs.indexOf('topic') !== -1) { m[pfx] = e; return; }
        var need = dynNeededByOthers(pfx, ref, e.refs);
        if (!need) { m[pfx] = e; return; }                    // can't answer safely → keep it all
        keep = files.filter(function (f) { return need[f]; });
        if (!keep.length) { e.refs = []; }                    // nothing survives after all
      }
      var go = keep ? files.filter(function (f) { return !need[f]; }) : files;
      if (keep && keep.length) { e.files = keep; delete e.bytes;   /* r65: the cached per-prefix total is now WRONG - it still counts the files just removed. Leaving it made a playlist read the deleted TOPIC's size (owner: 0.13 MB -> 0.58 MB after a topic-page delete). The download path has always done this; the delete paths never did. */ m[pfx] = e; } else { delete m[pfx]; }
      chain = chain.then(function () {
        var wipeAll = !(keep && keep.length);
        if (OFFLINE) {
          return wipeAll
            ? Filesystem.rmdir({ directory: 'DATA', path: offlineDir(pfx), recursive: true }).catch(function () {})
            : Promise.all(go.map(function (f) {
                return Filesystem.deleteFile({ path: offlineDir(pfx) + '/' + f, directory: 'DATA' }).catch(function () {});
              }));
        }
        if (!CACHES) return null;
        return caches.open(AUDIO_DL_CACHE).then(function (c) {
          return Promise.all(go.map(function (f) { return c.delete(webCacheKey(pfx, f)).catch(function () {}); }));
        }).catch(function () {});
      });
    });
    setManifest(m);
    dynDropSessions();   // "Delete" has to actually free the space
    if (PLMODE) {
      try {
        var pm = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}');
        delete pm[String(DYN_KEY_NS).replace(/^pl-/, '')];
        localStorage.setItem('thaiear_offline_pl', JSON.stringify(pm));
      } catch (_) {}
    }
    /* Re-derive rather than assert 'idle'. When another unit still claims these clips the files
       are deliberately RETAINED (see the refs check above), so declaring "not downloaded" was a
       display lie of exactly the kind r31 removed from the playlists list: the bar said idle, the
       next page load said downloaded again, and the delete button looked broken. renderOfflineBar
       asks dynDlHasAll() — the content question — so it reports what actually happened. */
    return chain.then(function () { renderOfflineBar(); });
  }

  /* Downloads need an ACCOUNT on every tier, including free (member tier retired 2026-08-10).
     ⚠ entitledForPage() CANNOT carry this: it answers the ACCESS question and returns true for a
     free topic, which is correct — a free topic streams for anyone, signed in or not. Access and
     download are different questions now, exactly as auth.js's lockedFor() vs downloadLockedFor().
     This is the topic-page twin of that split; index.html and pl-list.js go via ThaiEarDL.dlLocked.
     (Shipped in r161 without this check, so free topics were briefly downloadable signed out.) */
  function downloadNeedsSignIn() {
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) return false;                 // auth resolving → never block a payer
    return !(a.getUser && a.getUser());
  }
  function downloadTopic() {
    // P2a (§1f): app + installed PWA only — WEB_DL now carries the standalone test, and the old
    // `DYN && DYN_WEB_DL` escape (any cache-capable browser) is gone with the beta flag.
    if (!OFFLINE && !WEB_DL) return;
    // Gated topic + not entitled → same preview-only gate as play/reveal/flag (premium → the
    // neutral sheet in-app, the paywall on web), instead of attempting the download and erroring
    // on /api/audio. Tier FIRST: on a premium topic the tier is the real blocker, so the visitor
    // gets the premium message rather than a sign-in prompt that wouldn't actually unlock it.
    if (!entitledForPage()) { gate(TIER); return; }
    if (downloadNeedsSignIn()) {
      window.location.href = 'join.html?feature=1&next=' +
        encodeURIComponent(PAGE_FILE + location.search);
      return;
    }
    if (DYN) { dynDownloadHere(); return; }   // clips, not the prefab pair
    var files = topicFiles();
    var done = 0;
    downloadingNow = true;
    setOfflineState('downloading', 0, files.length);
    if (WEB_DL) { webDownloadTopic(files); return; }   // browser/PWA path (Cache Storage)
    // ---- native (Capacitor) path ----
    // Create the topic's folder first (downloadFile won't always make parent dirs).
    Filesystem.mkdir({ directory: 'DATA', path: offlineDir(PREFIX), recursive: true })
      .catch(function () {})                  // already exists → fine
      .then(function () {
        var chain = Promise.resolve();
        files.forEach(function (file) {
          chain = chain.then(function () {
            return downloadFileWithRetry(file).then(function () { done++; setOfflineState('downloading', done, files.length); });
          });
        });
        return chain;
      })
      .then(function () { return loadAudioVers(); })   // capture the audio stamp as the download's baseline
      .then(function () {
        markDownloaded(PREFIX, TIER || 'free', files, contentHash(), currentAv());
        stampVerified();                      // they were online + entitled at download time
        cachePage();                          // persist the page so it opens offline (survives SW updates)
        downloadingNow = false;
        setOfflineState('downloaded');
      })
      .catch(function (err) {
        var msg = dlErrText(err);   // NEVER String(err): a bare {code:402} renders as "[object Object]"
        console.warn('player.js: offline download failed', err);
        downloadingNow = false;
        offlineBarFlash('error', msg, 6000);   // transient — restore the real state after (2026-08-09)
      });
  }
  // Confirm before deleting a download (parity with the grid's Clear-downloads warning).
  function confirmDelete() {
    var bar = $('offline-bar'); if (!bar) return;
    bar.innerHTML = '<span class="offline-status">Delete this download?</span>' +
      '<button class="offline-btn offline-del" onclick="deleteTopic()">Delete</button>' +
      '<button class="offline-btn" onclick="cancelDelete()">Keep</button>';
  }
  /* ⚠ RE-DERIVE, do not assume 'downloaded' (2026-08-09, owner-reported: "if i click delete, then
     keep, it shows me a tick and 'downloaded' which is wrong"). Backing out of the delete prompt
     hard-coded the downloaded state, so a unit that actually had an audio UPDATE pending — or was
     stale, or only partly downloaded — came back showing a tick and "Downloaded". The update offer
     was silently lost and the bar was lying about what is on the device. renderOfflineBar() works
     the state out from the manifest instead of guessing. */
  function cancelDelete() { renderOfflineBar(); }
  // Re-download after the content was regenerated online: wipe the stale folder (so files for any
  // removed sentences don't linger) then re-run the normal download, which re-stamps the new hash.
  function refreshTopic() {
    if ((!OFFLINE && !WEB_DL) || !navigator.onLine) return;
    if (WEB_DL) { webDeleteTopic().then(function () { removeDownloaded(PREFIX); downloadTopic(); }); return; }
    Filesystem.rmdir({ directory: 'DATA', path: offlineDir(PREFIX), recursive: true })
      .catch(function () {})
      .then(function () { removeDownloaded(PREFIX); downloadTopic(); });
  }
  function deleteTopic() {
    if (!OFFLINE && !WEB_DL && !(DYN && DYN_WEB_DL)) return;
    if (DYN) { dynDeleteHere(); return; }
    /* REF-AWARE, mirroring dynDeleteHere. This path used to rmdir the WHOLE prefix directory and
       `delete m[prefix]` unconditionally — so deleting a topic download destroyed any playlist's
       per-sentence clips stored under the same prefix, and wiped the other claimants' refs with
       them. That is the exact mirror of the playlist-clear data loss already fixed on the other
       side; the fix was never brought across to the classic path.
       Released at FILE level, like dynDeleteHere: the combined _TE/_ET are pulled ONLY by a classic
       topic download so they always go, and the per-sentence clips are trimmed to exactly what the
       surviving playlists still need. Keeping the whole directory because one playlist holds one
       sentence reclaimed nothing, which is not what "delete" means. */
    var dm = getManifest(), de = dm[PREFIX];
    var rest = de ? (de.refs || ['topic']).filter(function (r) { return r !== 'topic'; }) : [];
    if (de && rest.length) {
      var need = dynNeededByOthers(PREFIX, 'topic', rest);
      var all = de.files || [];
      var combined = [PREFIX + '_TE.mp3', PREFIX + '_ET.mp3'];
      // need === null → cannot evaluate a surviving claim, so keep every per-sentence clip.
      var keepC = all.filter(function (f) {
        return combined.indexOf(f) === -1 && (!need || need[f]);
      });
      var goC = all.filter(function (f) { return keepC.indexOf(f) === -1; });
      if (keepC.length) { de.refs = rest; de.files = keepC; delete de.bytes;   /* r65 - see dynDeleteHere */ dm[PREFIX] = de; }
      else { delete dm[PREFIX]; }
      setManifest(dm);
      var freed = WEB_DL
        ? (CACHES ? caches.open(AUDIO_DL_CACHE).then(function (c) {
            return Promise.all(goC.map(function (f) { return c.delete(webCacheKey(PREFIX, f)).catch(function () {}); }));
          }).catch(function () {}) : Promise.resolve())
        : (keepC.length
            ? Promise.all(goC.map(function (f) {
                return Filesystem.deleteFile({ path: offlineDir(PREFIX) + '/' + f, directory: 'DATA' }).catch(function () {});
              }))
            : Filesystem.rmdir({ directory: 'DATA', path: offlineDir(PREFIX), recursive: true }).catch(function () {}));
      freed.then(function () { renderOfflineBar(); });
      return;
    }
    if (WEB_DL) { webDeleteTopic().then(function () { removeDownloaded(PREFIX); setOfflineState('idle'); }); return; }
    Filesystem.rmdir({ directory: 'DATA', path: offlineDir(PREFIX), recursive: true })
      .catch(function () {})
      .then(function () { removeDownloaded(PREFIX); setOfflineState('idle'); });
  }
  var DL_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  /* ── TRANSIENT BAR MESSAGES MUST PUT THE REAL STATE BACK (2026-08-09, owner-reported) ────────
     The bar is a STATE display, but several call sites used it as a notification: "You're offline
     — reconnect to download" replaced the whole bar and stayed there forever, taking the Update
     and Delete buttons with it. On a downloaded playlist with an update available, one tap on
     Download left the user with a dead message and no way back to either action short of a reload.
     offlineBarFlash() shows the message, then re-DERIVES the true state via renderOfflineBar().
     The sequence guard is what makes it safe: setOfflineState() bumps offBarSeq on every paint, so
     any newer state (a download starting, a delete finishing) cancels a pending revert instead of
     being stomped by it a few seconds later. */
  var offBarSeq = 0;
  function offlineBarFlash(state, arg, ms) {
    setOfflineState(state, arg);
    var seq = offBarSeq;
    setTimeout(function () { if (seq === offBarSeq) renderOfflineBar(); }, ms || 4000);
  }
  function setOfflineState(state, done, total) {
    offBarSeq++;                 // invalidates any pending flash revert — see offlineBarFlash
    var bar = $('offline-bar'); if (!bar) return;
    /* ⚠ IDEMPOTENCE GUARD — this branch owns the DOWNLOAD BUTTON, and renderOfflineBar() runs on
       every thaiear:auth (auth.js legitimately notifies ~5 times during startup). Rebuilding it
       destroys the button, so a tap landing in that window is silently lost and the user has to
       tap again — the same "click twice" the topic grid and playlists panel had (2026-08-15).
       ⚠ A SEPARATE ATTRIBUTE from the card branches' data-sig, on the same element: the two must
       not be able to satisfy each other's guard. Each clears the other's on the way in, so
       switching between the signup card and the download UI always repaints.
       ⚠ offBarSeq++ stays ABOVE the guard — it invalidates a pending flash revert, and that must
       happen whether or not the markup changes.
       ⚠ The signature carries everything the branches below read: progress counts, connectivity
       and the label. A real state change therefore always renders; only a repeat is skipped. */
    var dlSig = [state, done, total, navigator.onLine ? 1 : 0,
                 state === 'downloaded' ? dynOkLabel() : '',
                 state === 'error' ? String(done) : ''].join('|');
    if (bar.getAttribute('data-dlsig') === dlSig) return;
    bar.setAttribute('data-dlsig', dlSig);
    bar.removeAttribute('data-sig');   // the card branches no longer own this element
    if (state === 'downloading') {
      bar.innerHTML = '<span class="offline-status"><span class="prog-spin"></span> Downloading ' + (done || 0) + '/' + (total || '?') + ' — keep this page open</span>';
    } else if (state === 'downloaded') {
      bar.innerHTML = '<span class="offline-status offline-ok">' + dynOkLabel() + '</span>' +
        '<button class="offline-btn offline-del" onclick="confirmDelete()">Delete</button>';
    } else if (state === 'stale') {
      // Content was regenerated online since this topic was downloaded (page text refreshed via the
      // self-heal, but the stored audio didn't). Don't block playback — old audio beats nothing
      // offline — just warn, and offer a re-download when there's a connection to fetch it.
      if (navigator.onLine) {
        bar.innerHTML = '<span class="offline-status">⟳ Updated content available</span>' +
          '<button class="offline-btn" onclick="refreshTopic()">Re-download</button>' +
          '<button class="offline-btn offline-del" onclick="confirmDelete()">Delete</button>';
      } else {
        bar.innerHTML = '<span class="offline-status">⚠ This download may be out of date — reconnect to update</span>' +
          '<button class="offline-btn offline-del" onclick="confirmDelete()">Delete</button>';
      }
    } else if (state === 'offline') {
      bar.innerHTML = '<span class="offline-status">You’re offline — reconnect to download</span>' +
        '<button class="offline-btn" onclick="downloadTopic()">Retry</button>';
    } else if (state === 'error') {
      var msg = done ? (': ' + escapeHtml(dlErrText(done).slice(0, 160))) : '.';
      bar.innerHTML = '<span class="offline-status">Download failed' + msg + '</span>' +
        '<button class="offline-btn" onclick="downloadTopic()">Retry</button>';
    } else if (state === 'update') {
      // Downloaded before, incomplete now — sentences were added and their clips were never
      // fetched. Same action as idle (downloadTopic re-fetches what is missing); only the wording
      // differs, because the missing information is WHY, not how.
      /* r82: DELETE SITS ALONGSIDE UPDATE. Owner, 2026-08-01: *"if showing 'update available' users
         cannot clear a download."* True everywhere — this bar offered only the update, and the list
         row's control selects for download only — so a part-owned download was unremovable by any
         control on any surface. That breaks the standing rule that REMOVAL IS AVAILABLE AT ALL
         TIMES (§B9): the user is holding real bytes with no way to reclaim them, and the only
         offered escape is to download MORE. */
      /* r83 — ONE WORDING FOR BOTH UPDATE ROUTES. Owner, 2026-08-01: *"you're missing clips vs
         your clips are superseded — a pointless distinction. It should just always be
         'Download audio update?'"* Correct: the user's action is identical either way, and the
         reason is our bookkeeping. This branch (clips MISSING) and dynCheckAudioUpdate's branch
         (clips SUPERSEDED) now read the same and offer the same pair of buttons. Only the handler
         differs, because the work differs: downloadTopic() fetches what is absent, while
         dynUpdateAudio() must ALSO drop the built session — a stitched mp3 is keyed on settings,
         not clip content, so it would otherwise keep playing superseded audio forever. */
      bar.innerHTML = '<span class="offline-status">⟳ Download audio update?</span>' +
        '<button class="offline-btn" onclick="downloadTopic()">Update</button>' +
        '<button class="offline-btn offline-del" onclick="confirmDelete()">Delete</button>';
    } else { // idle
      bar.innerHTML = '<button class="offline-btn" onclick="downloadTopic()">' + DL_ICON_SVG +
        ' Download for offline</button>';
    }
  }
  /* Turn a rejection into something a person can read. `String(err)` on a plain rejection object
     yields "[object Object]" — which is what the owner saw as "Download failed: [object Object]".
     ⚠ NOT simulation-only: every gate rejection in this file is a bare {code:…} literal, so ANY
     real 401/402 during a download produced the same useless string.
     A refusal is also not a failure, so gate codes get their own wording rather than being reported
     as a broken download. No bespoke "server unreachable" message: a genuine connection problem
     already has its own `offline` state above, and a second one would just be another string to
     keep in step. */
  function dlErrText(e) {
    if (!e) return '';
    /* ⚠ CALL THIS AT THE CATCH SITE, ON THE ERROR OBJECT — not at render time on an
       already-stringified message. r44 added it only to renderOfflineBar(), but all three download
       catches had ALREADY collapsed the object with `String(err)`, so this received the literal
       string "[object Object]" and faithfully returned it. The fix has to happen before the
       information is destroyed. (Owner re-reported it unchanged after r44 — a fix applied one layer
       too late is indistinguishable from no fix at all.) */
    if (typeof e === 'string') return e;
    var c = e.code;
    /* On a PREMIUM topic a 401/403 is not really "you're logged out" — it's "you aren't entitled",
       and telling someone to sign in points them at a page promising it's free. The gates upstream
       should stop a non-entitled tap reaching here at all, so this is the backstop for the case
       they don't (owner-reported 2026-08-10). */
    if (c === 401 || c === 403 || c === 'noauth') {
      return TIER === 'premium' ? 'premium membership needed' : 'sign in to download this';
    }
    if (c === 402 || c === 'licence') return 'premium membership needed';
    if (e.message) return String(e.message);
    if (c != null) return 'error ' + c;
    return 'please try again';
  }
  /* r137 — BACKFILL THE NEED COUNT ONTO DOWNLOADS THAT PREDATE IT. The index can only tell a
     partial download from a complete one if `need` was recorded, and every entry written before
     this existed carries none — including the interrupted premium download that exposed the bug,
     which would otherwise keep reading "downloaded" on the grid forever. A topic page already
     knows the true count for its own prefix with no fetch, so record it on any visit: one integer,
     written only when it differs, after which the index is right about that topic even though the
     download itself long predates the field.
     Topic pages only, and only onto an entry that already exists — a playlist needs a SUBSET of a
     prefix's clips (see the finalize note in dynDownloadHere), and stamping a count onto a prefix
     nobody has downloaded would invent a claim. */
  function dynStampNeed() {
    if (PLMODE || !sentences.length) return;
    var g = dynDlGroups()[PREFIX];
    if (!g || !g.files.length) return;
    var m = getManifest(), e = m[PREFIX];
    if (!e || e.need === g.files.length) return;
    e.need = g.files.length; m[PREFIX] = e; setManifest(m);
  }
  function renderOfflineBar() {
    var bar = $('offline-bar'); if (!bar) return;
    /* §1f: plain browser tab (not app, not installed PWA). No download is possible here, so the
       bar used to be display:none and normal flow closed over it. It now carries the app card
       instead (app-cta.js) — the visitors who cannot download are precisely the ones who have not
       installed anything, and hiding the feature from them meant they never learned it existed.
       Falls back to the original hide when app-cta.js is absent (stale cache / script blocked),
       so the worst case is today's behaviour, never a broken bar. */
    if (!OFFLINE && !WEB_DL) {
      /* SIGNED OUT → no app card here (2026-08-15). The signed-out signup card in the progress
         slot carries the app line in its second zone, and the two slots sit a few hundred pixels
         apart on the same screen — showing both advertises the app twice in one view. Signed-in
         visitors are unaffected and still get the card exactly as before, which is what keeps the
         2026-08-11 decision (browser tabs must learn the app exists) intact.
         ⚠ Auth resolves LATE, so this repaints on the thaiear:auth listener further down; without
         that a signed-in visitor would keep the hidden state from first paint. */
      /* SIGNED OUT → the merged signup card lands HERE, not in the progress slot, because this
         slot is below .player-card and the progress slot is above it (measured — see the note in
         renderProgress). Zone 2 of the card carries the app line, so the app is still conveyed
         and is never advertised twice. Signed-IN visitors get the plain app card exactly as
         before, which keeps the 2026-08-11 decision intact. */
      /* ⚠ HOLD WHILE AUTH IS PENDING — do not fall through and paint the app card.
         Which card belongs here depends on sign-in state, and auth resolves AFTER first paint.
         Painting the app card meanwhile and swapping it for the signup card on thaiear:auth is
         exactly the blue flash the owner reported on mobile (2026-08-15). Rendering nothing until
         we know is the only version with no repaint. auth.js sets isReady on both its success and
         its durable-identity failure path, so this is never a permanent hold. */
      var st = window.ThaiEarAppCTA && window.ThaiEarAppCTA.authGuess
             ? window.ThaiEarAppCTA.authGuess() : 'in';
      /* ⚠ IDEMPOTENCE GUARD, same reason as renderProgress: auth.js legitimately notifies ~5
         times during startup, so this branch rebuilt the card FIVE times in ~140ms (measured
         2026-08-15). Both card branches are pure functions of `st`, so a signature is enough.
         ⚠ ONLY the card branches. The download-UI branch below must keep re-rendering — it
         reflects live download progress, and freezing it would be a real regression. */
      var barSig = 'card|' + st + '|' + (PLMODE ? 'pl' : 'topic');
      if (bar.getAttribute('data-sig') === barSig) return;
      bar.setAttribute('data-sig', barSig);
      bar.removeAttribute('data-dlsig');   // the download UI no longer owns this element
      if (st === 'out') {
        bar.className = 'offline-bar te-signup-host';
        bar.style.display = 'block';
        bar.innerHTML = window.ThaiEarAppCTA.signupHtml('topic', PAGE_FILE);
        return;
      }
      if (window.ThaiEarAppCTA) {
        bar.className = 'offline-bar te-appcta-host';
        bar.style.display = 'block';
        bar.innerHTML = window.ThaiEarAppCTA.html(PLMODE ? 'playlist' : 'topic');
      } else {
        bar.style.display = 'none';
      }
      return;
    }
    bar.removeAttribute('data-sig');  // leaving the card branches — the download UI owns the bar now
    bar.className = 'offline-bar';   // drop te-appcta-host if a previous paint took the branch above
    bar.style.display = 'flex';
    if (DYN) {
      dynStampNeed();   // r137: keep the index honest about downloads made before `need` existed
      /* NOTHING THIS VISITOR MAY PLAY → no download bar at all (r40, owner-reported).
         dynDlGroups() excludes locked sentences, so an all-premium playlist without entitlement
         produces an EMPTY group — and "is every needed clip present?" over an empty set is
         VACUOUSLY TRUE. The bar therefore announced "✓ Available offline (0.00 MB)" for a playlist
         holding nothing the visitor can hear. Hidden rather than shown as "Download for offline",
         because the download would fetch zero clips and report success. Mirrors the same guard on
         the list side (playlists.html dlState/dlControl).
         ⚠ THIS IS THE SIBLING MISS AGAIN — the empty-set guard was added to playlists.html in r38
         and NOT here, which is exactly the two-surfaces-drift this consolidation exists to stop.
         The lock RULE is shared; its CONSUMERS still have to be kept in step. */
      if (PLMODE && sentences.length && !dynDlGroups.hasAny() && !dynDlWasDownloaded()) { bar.style.display = 'none'; return; }
      /* ⚠ AND THE SAME RULE FOR A WHOLE GATED TOPIC (r60, owner-specified). A topic page the
         visitor cannot play must not offer a download — the sentence ▶ buttons are already refused
         and the page already gates, so a download button was the one control still inviting an
         action that cannot work.
         ⚠ REMOVAL SURVIVES: both this and the PLMODE guard above now fall through when something is
         ALREADY on disk (`dynDlWasDownloaded()`), so a user whose entitlement lapsed can still see
         the bar and delete it. "A user who has downgraded should not have to hold on to premium
         downloads they cannot use." Hiding the delete alongside the download is precisely the bug
         r38 introduced on the playlists side. */
      /* ⚠ isDownloaded(PREFIX), NOT dynDlWasDownloaded(). r60 used the latter and it returns FALSE
         IMMEDIATELY when !PLMODE — it is a playlist-only helper — so the guard's escape hatch never
         opened and the bar was hidden on a gated premium topic even when it WAS downloaded,
         removing the only way to delete it (owner: T-6). A manifest entry is the right question
         here: it means there is something to remove, and deleteTopic() is ref-aware (r32) so it
         only releases what the topic itself claims. */
      /* ⚠ "HAS THIS TOPIC'S OWN CLAIM", not "does a manifest entry exist" — the r33 lesson again.
         isDownloaded(PREFIX) is true whenever ANY claimant holds that prefix, including a PLAYLIST
         that cached one sentence of it. So a premium topic the visitor never downloaded still
         looked downloaded, the guard's escape hatch opened, and the bar appeared (owner: T-5).
         The topic's own claim is the `'topic'` ref (§B2d). A classic download writes NO refs field
         and is read as an implicit topic claim — matching what dynDeleteHere/deleteTopic assume. */
      /* ⚠⚠ r60 REVERSED BY THE OWNER, 2026-08-10 — THIS GUARD IS DELIBERATELY GONE.
         r60 hid the bar entirely on a gated premium topic ("a topic page the visitor cannot play
         must not offer a download"). The owner has since decided the opposite, and the reasoning
         changed with it: offline download is a headline PREMIUM FEATURE, and hiding it from
         exactly the people who haven't bought yet means they never learn it exists. A visible,
         gated control advertises the feature; an absent one sells nothing.
         Tapping it is safe — downloadTopic() checks entitledForPage() first and routes to
         gate(TIER), so a non-entitled tap gets the premium message (app → neutral sheet, web →
         paywall), never a failed download.
         Do NOT "restore" this guard as a bug fix. Both states were owner-specified; this is the
         current one. The PLMODE empty-set guard above is a DIFFERENT rule and still stands — a
         playlist with nothing playable would download zero clips and report success. */
      // No stale/refresh states here: a dyn session is keyed on its own content and settings,
      // so changed text or a changed setting rebuilds by itself. Downloaded means "the clips
      // are all here", which is the only claim worth making.
      /* ⚠ PLAYLIST: "the clips are here" is NOT "this playlist is downloaded" (r66, owner-specified).
         A playlist whose clips are present only because a TOPIC (or another playlist) holds them
         works today and can vanish the moment that other download is removed. Offering no download
         button there left the user no way to make it durable — and no way to know they needed to.
         So without its own claim we show the ordinary "Download for offline" offer, even though it
         would play right now. A topic is unaffected: a topic download IS its own claim. */
      /* r79: OWNERSHIP, not the download RECORD. `dynDlWasDownloaded()` only asks whether a
         `thaiear_offline_pl` entry exists, so a playlist carrying a STALE record — one claiming a
         prefix since released — passed this test and the bar said "✓ Downloaded" over clips it did
         not own. Same defect the row caption had (playlists.html dlState, r79); fixing one surface
         and not the other is §B8's lesson 3, which has now bitten three times. `some` (partial
         ownership) is the honest "update available": downloaded once, extended since. */
      /* ⚠ ORDER MATTERS: the PLAYLIST verdict is decided ENTIRELY by ownership, so it runs BEFORE
         the content check. Leaving `!dynDlHasAll() → wasDownloaded ? 'update' : 'idle'` ahead of it
         would keep reading a STALE RECORD as "downloaded once" and label a playlist that owns
         nothing "update available" — the very label the owner could not account for. Topic pages
         keep the original content-only path below, unchanged. */
      /* ⚠ r97 — AN ALL-LOCKED UNIT MUST BE ASKED WHAT IT *HOLDS*, NOT WHAT IT MAY *FETCH*.
         dynDlOwnedNeeded() counts over dynDlGroups(), which drops locked sentences, so an
         all-premium playlist without entitlement yields an EMPTY set → need=0 → {all:false,
         some:false} → the bar fell through to "Download for offline" over a playlist that IS
         downloaded and that the visitor cannot re-fetch. No delete, no size, and a button offering
         an action the server would refuse (owner: T-7b, reproduced on BOTH devices; the list row
         was right, so the two surfaces disagreed again).
         This is r75's lesson in a place r75 did not reach: what we HOLD is lock-independent, only
         what we may FETCH is gated. dynOwnedPrefixes() is r75's own helper and is what
         dynDeleteHere() releases from — so the bar now offers Delete exactly when Delete has
         something to do, by construction rather than by two predicates agreeing.
         ⚠ SCOPED TO THE ALL-LOCKED CASE ON PURPOSE. A MIXED playlist still has a non-empty group,
         so it keeps the r79/r81 ownership path untouched — that is what D-L2/D-L3/D-L4 assert
         (downloaded while lapsed reads `· downloaded`, NOT "update available"), and what V and B14
         are written against. `sentences.length` mirrors the r40 guard above: with no sentences yet
         loaded the old path still runs, so an early render cannot blank the bar. */
      if (PLMODE) {
        if (sentences.length && !dynDlGroups.hasAny()) {
          if (!dynOwnedPrefixes().length) { bar.style.display = 'none'; return; }   // stale record, nothing held: nothing to remove and nothing to fetch
          cachePage();
          setOfflineState('downloaded');
          dynPaintOfflineSize();
          return;   // deliberately NO dynCheckAudioUpdate(): an update is a FETCH, and this visitor may not
        }
        var own = dynDlOwnedNeeded();
        if (!own.all) { setOfflineState(own.some ? 'update' : 'idle'); return; }
      } else if (!dynDlHasAll()) {
        /* D0a (rollout P1): a classic-downloaded topic — or a genuinely partial dyn one — still
           holds real bytes on disk, and blindly saying 'idle' here read as "your download is
           gone". dynDlOwnedNeeded() already credits any TH clips that share a filename with the
           dyn set (classic and dyn clips ARE named identically — see dynClipRef/topicFiles), so
           calling it here — the way the PLMODE branch above already does — turns "owned nothing,
           therefore idle" into the correct partial-ownership 'update'. The hasTopicClaim/combined
           check is belt-and-braces for an entry whose overlap the file-count alone might miss (an
           edge dynDlOwnedNeeded() doesn't reach if dynDlGroups() is momentarily empty). A topic
           with NO claim at all — no manifest entry, and none of the combined TE/ET pair a classic
           download always writes — still resolves to 'idle', unchanged. This mirrors r97's own
           lesson (ownership, not the fetchable group) one level up; r97's own all-locked PLMODE
           guard above is untouched. */
        var ownT = dynDlOwnedNeeded();
        var entT = getManifest()[PREFIX];
        var hasCombinedT = !!(entT && entT.files && (entT.files.indexOf(PREFIX + '_TE.mp3') >= 0 || entT.files.indexOf(PREFIX + '_ET.mp3') >= 0));
        setOfflineState((ownT.some || hasTopicClaim(PREFIX) || hasCombinedT) ? 'update' : 'idle');
        return;
      }
      cachePage();
      setOfflineState('downloaded');
      dynPaintOfflineSize();
      dynCheckAudioUpdate();   // async; upgrades the bar only if the CLIPS on R2 have changed
      return;
    }
    /* Entry presence is NOT the claim that matters, and this was the last place still asking it.
       The classic player plays the COMBINED file, and the ref-aware delete deliberately leaves the
       manifest entry behind when a playlist still needs the per-sentence clips — so "entry exists"
       reported "✓ Available offline" for a topic whose _TE had just been removed, and it then
       played nothing offline. Ask for the file this page actually plays. */
    var ent = getManifest()[PREFIX];
    if (!ent || !hasLocalFile(PREFIX, PREFIX + '_TE.mp3')) { setOfflineState('idle'); return; }
    cachePage();                       // self-heal: re-persist the page whenever we open a downloaded topic online
    setOfflineState('downloaded');     // show immediately; the checks below can upgrade it to 'stale'
    var curHash = contentHash();
    // TEXT check — synchronous and offline-safe (the text is in the page itself, which self-heals
    // online). Catches any change that alters the sentences. Skipped for pre-feature downloads (no ver).
    if (ent.ver && ent.ver !== curHash) { setOfflineState('stale'); return; }
    // AUDIO check — needs the versions map; do it async so the bar never waits on the fetch. Catches a
    // pure audio re-render with unchanged text. Adopts a baseline for downloads that predate either
    // mechanism rather than false-flag; only compares when both stamps are actually known.
    loadAudioVers().then(function () {
      var m = getManifest(), e = m[PREFIX]; if (!e) return;
      var av = currentAv();            // string, or null if the map couldn't be loaded
      var changed = false;
      if (!e.ver) { e.ver = curHash; changed = true; }                 // adopt text baseline
      if (e.av == null && av != null) { e.av = av; changed = true; }   // adopt/backfill audio baseline
      if (changed) { m[PREFIX] = e; setManifest(m); return; }          // just established a baseline → no nag
      if (av != null && e.av != null && av !== e.av) setOfflineState('stale');
    });
  }
  // In-page message shown when a downloaded premium topic is played offline after the licence
  // window has lapsed — friendly, no navigation (the SW would otherwise show the offline page).
  function showLicenceOverlay() {
    /* ⚠⚠ "RECONNECT" MEANS EXACTLY ONE THING: WE COULD NOT CHECK. Owner, 2026-07-31 — this message
       must not bleed into any other circumstance. It is only honest when a NON-LIFETIME premium
       member's last clean verification is older than the grace window and we cannot reach the
       server. If a clean read DID answer this session and said "not subscribed", that is an
       authoritative negative — the paywall, not a connectivity problem — and telling that user to
       reconnect sends them to fix something that isn't broken (they could reconnect all day and
       nothing would change). Route those to the premium sheet instead.
       Mirrors canUseOffline's own split: fresh+not-subscribed → deny outright; no answer → grace.
       ⚠ NO RECURSION, and the reason is load-bearing: gate() calls this only when isSubscribed()
       is TRUE (its `lastKnownSubbed` branch), while this guard fires only when it is FALSE. The two
       conditions are mutually exclusive, so control can cross once and never bounce back. If either
       condition is ever loosened, re-check that — it would become an infinite loop, not a bug you
       can see in a diff. */
    var a = window.ThaiEarAuth;
    if (a && a.isSubscriptionFresh && a.isSubscriptionFresh() &&
        !(a.isSubscribed && a.isSubscribed())) { gate(TIER || 'premium'); return; }
    if (document.getElementById('te-licence-overlay')) return;
    var ov = document.createElement('div');
    ov.id = 'te-licence-overlay';
    ov.className = 'te-licence-overlay';
    ov.innerHTML =
      '<div class="te-licence-card">' +
        '<span class="te-licence-eyebrow">' +
          '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg> Premium download</span>' +
        '<h2>Reconnect to keep listening</h2>' +
        '<p>To keep your premium downloads playable offline, ThaiEar checks your membership online every so often — and it’s been a while.</p>' +
        '<p class="te-licence-sub">Connect to the internet once and this topic unlocks again straight away.</p>' +
        '<button type="button" class="te-licence-btn">Got it</button>' +
        '<p class="te-licence-note">Free downloads still play offline; your premium downloads return as soon as you reconnect.</p>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    var btn = ov.querySelector('.te-licence-btn');
    if (btn) btn.addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); }); // tap backdrop to dismiss
  }

  /* Refresh the offline licence whenever auth resolves with a CONFIRMED active subscription.
     This used to ask `navigator.onLine && isSubscribed()` — both untrustworthy, and the same pair
     that made an entire expiry window dead code earlier in this build. navigator.onLine reports
     ONLINE in airplane mode on these WebViews, and isSubscribed() returns the CACHED flag, not a
     fresh answer. So both could read true while genuinely offline with a lapsed subscription: the
     stamp renewed, the 50-day clock reset, and access continued indefinitely.
     isSubscriptionFresh() is the truthful question — "did a clean subscriptions read answer us this
     session?" — which a flight-mode radio cannot fake. Same predicate as canUseOffline's
     fresh+subscribed branch (see stampVerified's other gated call site); the two must stay in step,
     because this is the second time a fix landed on one sibling and missed the other. */
  window.addEventListener('thaiear:auth', function () {
    var a = window.ThaiEarAuth;
    if (a && a.isSubscriptionFresh && a.isSubscriptionFresh() &&
        a.isSubscribed && a.isSubscribed()) stampVerified();
  });

  // Progress is keyed by this page's (frozen) filename, e.g. "topic-09a" — unique
  // per page, matches what the progress page enumerates from topics.js.
  var PAGE_FILE = (location.pathname.split('/').pop() || '').toLowerCase();
  /* A playlist LIVES at playlists.html?pl={id} — the query is its identity, so anything that
     LINKS back here (the now-playing bar, the np stamp) has to keep it, or tapping "now
     playing" lands on the playlist LIST instead of the playlist. PAGE_FILE stays bare for
     filename comparisons; PAGE_HREF is the linkable form. (It also preserves the test-space
     ?k= key, which was being dropped the same way.) */
  var PAGE_HREF = PAGE_FILE + ((cfg.dyn && location.search) ? location.search : '');
  if (!/\.html$/.test(PAGE_FILE)) PAGE_FILE += '.html'; // clean URLs (/topic-02) → topic-02.html
  var TOPIC_KEY = PAGE_FILE.replace(/\.html$/, '');

  // Playlist pages have no page-level audioPrefix — each sentence carries its own.
  var PER_SENT_PREFIX = cfg.dyn === true && sentences.length > 0 &&
    sentences.every(function (s) { return !!s.prefix; });
  if ((!PREFIX && !PER_SENT_PREFIX) || !sentences.length) {
    console.error('player.js: window.ThaiEarTopic { audioPrefix, sentences } is missing.');
    return;
  }

  // Self-heal the visible "N sentences" count in the static <p class="topic-meta"> from the
  // real data, so it can never drift even if a page shipped without re-running ssrify. ssrify
  // also sets this at build time (single source = sentences.length); this is the runtime
  // backstop. No visible flash when the static value is already correct.
  var metaCount = document.querySelector('.topic-meta strong');
  if (metaCount) metaCount.textContent = sentences.length + (sentences.length === 1 ? ' sentence' : ' sentences');

  /* ---- styles (the player owns its own CSS; page keeps only chrome) ----
     Depends on the page's :root design tokens, which every page defines. */
  var STYLES = `
    /* ══ THE PROGRESS CARD'S RESERVED SLOT (r139 — re-measured across the whole width range) ══
       WHY IT IS ALWAYS THE LAST THING TO APPEAR, and why that is not about its size: renderProgress()
       returns early until ThaiEarAuth.isReady, so this card waits on a Supabase auth round trip
       (session restore / token refresh against auth.thaiear.com) and then on the user's progress
       rows. Everything else on the page — the whole dyn player included — is local DOM and local
       CSS and needs no network at all. On a slow connection the card can be seconds behind. That
       is inherent; what must NOT happen is the page moving when it lands.
       ⚠ ONE min-height CANNOT COVER THIS CARD — it has FOUR distinct heights, because the flex row
       wraps at different points in each auth state. Measured (Chrome, real page, per viewport):
           vw ≤374   logged-in 80.4   logged-out 93.4   ← label wraps to 3 lines
           375–438   logged-in 80.4   logged-out 73.4   ← every current iPhone lives here
           439–600   logged-in 46.9   logged-out 73.4
           ≥601      logged-in 52.9   logged-out 44.7
       The old flat 73px was taken from the logged-out card at phone width, so a SIGNED-IN user on
       any iPhone got a 7.4px downshift of everything below when the card landed (owner-reported as
       "downshifts a fraction", 2026-08-03) — and a signed-out user at ≤374 got 20.4px. Below 600 it
       was also over-reserved by up to 26px at tablet widths, leaving a visible gap.
       Each band now reserves its own local maximum, and the card STRETCHES to fill the reservation
       (display:flex + flex:1 on the card) so an over-reserved band reads as a slightly roomier card
       rather than a gap above the player. Net: no shift in any state at any width.
       ⚠ Re-measure these four numbers if the card's copy, padding or type size changes — they are
       measurements, not round numbers. The dyn-plmode display:none rule (2 classes) still beats
       the display:flex here, so the playlist player is unaffected. */
    /* Reserve dropped once the real player is in the DOM — see the note at the mount site.
       Its own height is authoritative from then on, so the guess cannot leave a gap. */
    body.te-player-mounted #player-root { min-height: 0; }
    /* No min-height: with the bar gone this slot is either the signup card (which
       carries its own .te-rsv-card reserve below) or empty. */
    .progress-controls { margin-bottom: 0.9rem; display: flex; }
    @keyframes prog-bump { 0% { transform: scale(1); } 45% { transform: scale(1.35); } 100% { transform: scale(1); } }
    /* ⚠ TWO ORPHANED DECLARATION BLOCKS WERE REMOVED HERE (2026-08-21). When the progress bar
       was retired (6905723) its SELECTORS were deleted and their bodies were left behind, so
       STYLES contained two rule bodies with nothing to belong to — and each carried a closing
       brace. A stray closing brace does not just do nothing: the CSS parser treats it as the end of a
       block and skips to recover, swallowing the NEXT rule with it. That is why
       ".player-top { display: flex }" was in the file but absent from the CSSOM, and why the
       guide page's demo player collapsed into a full-width column while every other surface
       looked fine — the dyn player uses .dyn-* classes, so the guide's classic markup was the
       only thing still depending on the rules that were being eaten.
       Found by counting braces, not by reading: the file looks completely normal. */
    /* Signed out → renderProgress leaves this slot EMPTY (the signup card lives below the player,
       in the offline-bar slot). Without this the measured reserve above becomes ~94px of blank gap
       over the player on a phone. :empty rather than a body class so it tracks the actual render
       with no JS and no ordering risk; the reserve still applies in full to the signed-in counter,
       which is what it was measured for. */
    /* The DEFAULT state now, not the signed-out-in-browser special case. */
    .progress-controls.te-empty { min-height: 0; margin-bottom: 0; }
    /* ⚠ AN EXPLICIT CLASS, NOT :empty. The :empty version was correct CSS and shipped in the
       stylesheet, but measurement on the live page showed it simply not applying — the slot
       matched :empty, had zero child nodes, and still computed margin-bottom: 14.4px. Rather
       than keep chasing it through the cascade, renderProgress() now sets this class in the
       same place it already toggles te-anon and te-rsv-card, so the collapse is decided by the
       code that decides what renders. Deterministic and debuggable. */
    /* ⚠ NO .te-anon REQUIREMENT ANY MORE. With the progress bar gone this slot is either
       the signed-out signup card or genuinely empty, so an empty slot should ALWAYS
       collapse — including in the window before auth resolves and sets any class at all.
       Requiring te-anon left a bare 0.9rem margin between the sentence-count line and the
       player on every load (owner: "almost a finger width on iphone"). */
    /* ---- APP / INSTALLED PWA, SIGNED OUT: the signup card lands in THIS slot ----
       ⚠ THIS SLOT IS THE FIRST CHILD OF #player-root, so when it grows the ENTIRE PLAYER moves
       down. Collapsing it to 0 and then filling it with a 133px card shoved the play button and
       the transport row off the screen — which reads as the player "flashing", because the
       scrubber appears and is then displaced. Confirmed frame-by-frame from an iPhone PWA
       recording, 2026-08-15: player paints, then the card is inserted above it and pushes it out
       of view. In a BROWSER the card goes to the offline bar instead, so this slot really does
       stay empty there and te-anon's collapse above is correct — do not merge the two cases.
       ⚠ Measured, not rounded: swept width by width IN THE REAL PAGE, not a synthetic
       container — 153 up to 337, 133 to 573, 114 above. A first pass measured the card in a
       stand-alone box and got 559 as the upper breakpoint, which left a 19px shift at 560. Re-measure if its copy or padding changes. Higher specificity than the plain
       .progress-controls rules, so it beats them inside their media queries too. */
    /* ⚠ SPACING, MEASURED (owner, 2026-08-21: "very very close" on the app). In the app/PWA
       signed-out case the card's top sat 1px below the "N sentences - Click each sentence..."
       line, because the slot's only margin was on the BOTTOM. It now breathes above and sits a
       little tighter to the player, which is what was asked for.
       ⚠ BOTH MARGINS BELONG ON .te-rsv-card, NOT ON .progress-controls. The plain slot is EMPTY
       in a browser and when signed in, and giving it a top margin there would push the player
       down on every other surface — desktop and mobile web are both fine today and must stay
       that way.
       Net effect on the insertion shift is +9.6px on a 147.4px move (14.4 bottom-only, before;
       14 top + 10 bottom, now), because the card and its margins arrive together with the class.
       Measured at 390 CSS px in the real page: gap above 1px -> 14px, gap below 14px -> 10px. */
    .progress-controls.te-rsv-card { min-height: 133px; margin-top: 14px; margin-bottom: 10px; }
    @media (max-width: 337.98px) { .progress-controls.te-rsv-card { min-height: 153px; } }
    @media (min-width: 574px)    { .progress-controls.te-rsv-card { min-height: 114px; } }
    /* --- end-of-topic ask (2026-08-15). Sits between the last sentence and the prev/next nav.
       No CLS reserve needed: it mounts far below the fold, so a late auth-gated insert there
       shifts nothing the visitor is looking at. --- */
    /* ⚠ ACCENT-LIGHT GROUND (owner, 2026-08-15) — on plain white this read as a block of text and
       was easy to skip past on the way to the Next button. Matches the signup card above it. */
    .te-endcta { background: var(--accent-light); border: 0.5px solid var(--border); border-radius: var(--radius-lg);
      padding: 0.9rem 1rem; margin: 1.5rem 0 0.5rem; }
    .te-endcta-title { display: block; font-size: 14.5px; font-weight: 600; letter-spacing: -0.005em;
      color: var(--text-primary); margin-bottom: 4px; }
    .te-endcta-desc { display: block; font-size: 13px; line-height: 1.55; color: var(--text-secondary); margin-bottom: 9px; }
    .te-endcta-cta { display: inline-block; font-size: 13px; font-weight: 600; color: #fff; background: var(--accent);
      border-radius: var(--radius-sm); padding: 8px 14px; text-decoration: none; transition: background 0.15s; }
    .te-endcta-cta:hover { background: var(--accent-mid); color: #fff; }
    .prog-spin { display: inline-block; width: 13px; height: 13px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: prog-spin 0.6s linear infinite; }
    @keyframes prog-spin { to { transform: rotate(360deg); } }
    .prog-tick { display: inline-block; font-weight: 700; animation: prog-tick-pop 0.4s cubic-bezier(0.2,0.8,0.3,1.3) both; }
    @keyframes prog-tick-pop { 0% { transform: scale(0); opacity: 0; } 60% { transform: scale(1.3); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    @media (max-width: 600px) {
    }
    .player-card { background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: 1.1rem 1.25rem 1rem; margin-bottom: 1.75rem; }
    .player-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.9rem; }
    .audio-toggle { display: flex; flex-wrap: wrap; max-width: 100%; gap: 2px; background: var(--bg); border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 2px; }
    .toggle-btn { font-size: calc(12px * var(--te-ui, 1)); font-family: var(--font-ui); font-weight: 400; color: var(--text-secondary); background: none; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap; }
    .toggle-btn:hover { color: var(--text-primary); }
    .toggle-btn.active { background: var(--accent); color: white; font-weight: 500; }
    .audio-row { display: flex; align-items: center; gap: 12px; }
    .play-btn { width: 38px; height: 38px; border-radius: 50%; background: var(--accent); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.15s; }
    .play-btn:hover { background: var(--accent-mid); }
    .play-btn svg { fill: white; width: 14px; height: 14px; margin-left: 2px; }
    .skip-btn { position: relative; width: 36px; height: 36px; border-radius: 50%; background: none; border: none; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.15s, color 0.15s; }
    .skip-btn:hover { background: var(--bg); color: var(--accent); }
    .skip-btn svg { width: 30px; height: 30px; }
    .skip-num { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 9px; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none; }
    .scrubber-wrap { flex: 1; }
    .scrubber-track { width: 100%; padding: 14px 0; cursor: pointer; margin-bottom: 5px; touch-action: none; }
    .scrubber { width: 100%; height: 3px; background: var(--border); border-radius: 2px; position: relative; pointer-events: none; }
    .scrubber-fill { position: relative; height: 100%; width: 0%; background: var(--accent); border-radius: 2px; transition: width 0.1s linear; }
    .scrubber-fill::after { content: ''; position: absolute; right: -7px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; border-radius: 50%; background: var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
    .time-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .orientation-text { font-size: 13px; color: var(--text-secondary); line-height: 1.65; margin-bottom: 1.25rem; padding: 0.75rem 1rem; background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--radius-md); }
    .orientation-text strong { color: var(--text-primary); font-weight: 500; }
    .orientation-text a { color: var(--accent); font-weight: 500; text-decoration: none; }
    .controls-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; flex-wrap: wrap; gap: 6px; }
    /* ⚠ DELIBERATELY LOUD (owner, 2026-08-15). As a grey outline it read as chrome and got
       skipped, so people never discovered that every sentence carries a word-by-word breakdown —
       the single most under-used thing on the page. It now wears the tone the "Remove all
       downloads" button only shows on HOVER (pl-list.js .dl-removeall-btn:hover), permanently.
       ⚠ Literal hex, not var(--accent): that keeps it identical on premium topics, where --accent
       becomes the bright gold and this would otherwise disappear into it.
       ⚠ #B00020 is the site's ERROR/danger tone (Remove, Delete playlist, payment failure). Used
       here for prominence, not to warn — do not infer from this that red now means "safe". */
    .reveal-all-btn { font-size: calc(12px * var(--te-ui, 1)); font-family: var(--font-ui); color: #B00020; background: #FDF1F2; border: 0.5px solid #E8C4C8; border-radius: var(--radius-sm); padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: background 0.15s; }
    .reveal-all-btn:hover { background: #FBE4E7; }
    /* PREMIUM TOPICS GET GREEN, NOT RED (owner, 2026-08-15). The red sits badly beside the gold
       palette; green and gold is the classic warm/cool pairing and keeps the button just as loud.
       Deliberately NOT the free-topic purple either — a premium page should not borrow the free
       accent, and --accent is the bright gold here so it could not be used anyway.
       ⚠ Literal hex like its base rule, for the same reason: --accent is gold inside
       #player-root / #sentence-list, so any var() here would make the button disappear into it.
       Contrast measured, not eyeballed: #1F5D3A on #EEF6F0 is 7.10:1, comfortably past WCAG AA's
       4.5:1 for normal text (the red it replaces is 6.64:1). Re-measure if either tone changes. */
    body.premium-topic .reveal-all-btn { color: #1F5D3A; background: #EEF6F0; border-color: #C6DFD0; }
    body.premium-topic .reveal-all-btn:hover { background: #E3F0E7; }
    /* ---- transliteration toggle (topics shipping per-sentence translit, currently 01–03) ----
       Default ON (new visitors should see it exists); .translit-off on #sentence-list hides both
       the under-Thai line and the chips' translit. Choice remembered per device via localStorage. */
    .controls-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .translit-btn { font-size: calc(12px * var(--te-ui, 1)); font-family: var(--font-ui); color: var(--text-secondary); background: none; border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .translit-btn:hover { background: var(--surface); }
    .translit-btn.on { background: var(--accent-light); border-color: var(--accent); color: var(--accent); font-weight: 500; }
    .translit-btn .tl-ico { font-size: calc(11px * var(--te-ui, 1)); }
    .translit-btn .tl-ico .th { font-family: var(--font-thai); }
    .thai-translit { font-family: var(--font-ui); font-size: 13px; color: var(--text-tertiary); line-height: 1.55; margin-top: 1px; }
    .g-tl { color: var(--text-secondary); margin-left: 4px; }
    #sentence-list.translit-off .thai-translit, #sentence-list.translit-off .g-tl { display: none; }
    .sent-count-label { font-size: calc(12px * var(--te-ui, 1)); color: var(--text-tertiary); min-width: 0; }
    .sentence-card { background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 7px; overflow: hidden; transition: border-color 0.15s; }
    .sentence-card:hover { border-color: var(--border-strong); }
    .sentence-header { display: flex; align-items: center; gap: 10px; padding: 0.7rem 1rem; cursor: pointer; user-select: none; -webkit-user-select: none; }
    .sent-num { font-size: 11px; font-weight: 500; color: var(--text-tertiary); min-width: 20px; font-variant-numeric: tabular-nums; }
    .sent-play-btn { width: 26px; height: 26px; border-radius: 50%; background: var(--accent-light); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.15s; }
    .sent-play-btn:hover { background: var(--accent); }
    .sent-play-btn:hover svg { fill: white; }
    .sent-play-btn.playing { background: var(--accent); }
    .sent-play-btn svg { fill: var(--accent); width: 10px; height: 10px; margin-left: 1px; }
    .sent-play-btn.playing svg { fill: white; margin-left: 0; }
    .speed-toggle { width: 26px; height: 26px; border-radius: 50%; background: var(--accent-light); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.15s; font-size: 14px; line-height: 1; }
    .speed-toggle:hover { background: var(--accent); }
    .speed-toggle.active { background: var(--accent); }
    .sent-preview { font-family: var(--font-thai); font-size: 16px; color: var(--text-primary); flex: 1; line-height: 1.4; }
    .sent-preview .ell { color: var(--text-tertiary); }
    /* ---- direction-aware PILL HINT (2026-08-18) ----
       The collapsed pill's hint follows the chosen direction, like the reveal order above it:
       Thai-first shows the Thai hint, English-first the authored English one. BOTH ship in the
       markup and only their visibility swaps, so the static SSR card is never rebuilt and the
       crawler still reads the same node the learner reveals.
       Default (no dir class yet, e.g. before player.js runs) = Thai, which is what every page
       shipped before this existed. A sentence with no English hint gets .pv-only on its Thai
       span and no .pv-en at all, so it keeps showing Thai in BOTH directions rather than
       rendering a blank pill — that is the fallback for any page not yet carrying previewEn.
       NB: NO BACKTICKS in this comment. STYLES is a template literal, so one ends the string and
       breaks the entire file — node --check player.js catches it, and so does gen_dyncss.js.
       The html.te-dir-et half of each pair is the PRE-PAINT path: player.js is deferred, so
       without it an English-first visitor would see every Thai hint for a beat and then watch them
       all flip. A 3-line inline script in <head> (ssrify_topic.js) stamps that class from
       localStorage before first paint, and applyDirClass() keeps it in sync afterwards — both
       classes always agree, so switching back to Thai-first doesn't leave the html rule stuck on.
       These rules reach the head via gen_dyncss.js, which extracts STYLES into a linked
       stylesheet — so RE-RUN IT after touching them or the flash comes back for these rules. */
    .sent-preview .pv-en { font-family: var(--font-ui); display: none; }
    #sentence-list.dir-et .pv-th,          html.te-dir-et #sentence-list .pv-th { display: none; }
    #sentence-list.dir-et .pv-th.pv-only,  html.te-dir-et #sentence-list .pv-th.pv-only { display: inline; }
    #sentence-list.dir-et .pv-en,          html.te-dir-et #sentence-list .pv-en { display: inline; }
    .prog-wrap { display: flex; align-items: center; gap: 2.5px; flex-shrink: 0; padding: 2px 0; }
    .prog-seg { width: 5px; height: 16px; border-radius: 3px; background: var(--border); transition: background 0.2s ease; }
    .prog-seg.on { background: var(--accent); }
    .sentence-body { border-top: 0.5px solid var(--border); }
    .reveal-row { padding: 0.6rem 1rem; border-bottom: 0.5px solid var(--border); }
    .reveal-row:last-child { border-bottom: none; }
    /* ---- direction-aware reveal order ----
       Default (Thai-first / no dir class): the page's own reveal CSS opens Thai → English → notes.
       When English-first (et) is selected we override just enough to open English → Thai → notes and
       put English on top. Keyed on #sentence-list.dir-et (id → beats the page's class-only rules), so
       the static SSR cards + st-0..3 stages stay untouched. Only ET needs overrides; TE is unchanged. */
    #sentence-list.dir-et .sentence-body { display: flex; flex-direction: column; }
    #sentence-list.dir-et .row-english { order: 1; }
    #sentence-list.dir-et .row-thai { order: 2; }
    #sentence-list.dir-et .row-notes { order: 3; }
    /* stage 1: show English (not Thai) first */
    #sentence-list.dir-et .sentence-card.st-1 .row-thai { display: none; }
    #sentence-list.dir-et .sentence-card.st-1 .row-english { display: block; }
    /* bottom-border tidy: no rule under the visually-last row at each stage (English@1, Thai@2) */
    #sentence-list.dir-et .sentence-card.st-1 .row-english { border-bottom: none; }
    #sentence-list.dir-et .sentence-card.st-2 .row-english { border-bottom: 0.5px solid var(--border); }
    #sentence-list.dir-et .sentence-card.st-2 .row-thai { border-bottom: none; }
    .row-thai { font-family: var(--font-thai); font-size: 19px; font-weight: 400; color: var(--text-primary); line-height: 1.5; }
    .row-english { font-size: 14px; color: var(--text-secondary); }
    .row-notes { background: var(--bg); }
    .gloss-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }
    .gloss-chip { background: var(--surface); border: 0.5px solid var(--border); border-radius: 20px;
      padding: 2px 9px; font-size: 13px; line-height: 1.5;
      /* SPILL GUARD (2026-08-19). Android's textZoom inflates the chip's TEXT but not its px
         padding or .gloss-row's px gap, so at a large system font size a chip's content can
         outgrow the row. min-width:0 lets the flex item shrink past its min-content width and
         overflow-wrap lets the text break, so the chip wraps to a second line instead of
         spilling. 'anywhere' (not just break-word) is what also corrects the intrinsic
         min-content size; break-word is declared first as the fallback for older WebKit.
         MEASURED, and not where you would expect: the risk is the ENGLISH gloss, NOT the
         Thai. Chrome and the Android WebView apply ICU dictionary line-breaking inside
         Thai script, so even a 25-character Thai head breaks fine on its own. The worst
         token in all 16,797 chips is 'grandmother(pat.)' (topic-08 S198) — 17 characters
         with no space or hyphen, so no break opportunity at all — which spilled 82px out
         of its row at 2.0x on a 320px screen, and 50px at the old 11px size (so this was
         a latent bug the size bump widened, not one it created).
         .gloss-row already wraps, which handles the multi-chip case. */
      min-width: 0; overflow-wrap: break-word; overflow-wrap: anywhere; }
    .g-thai { font-family: var(--font-thai); color: var(--text-primary); font-weight: 500; }
    .g-eq { color: var(--text-tertiary); margin: 0 2px; }
    .g-eng { color: var(--text-secondary); }
    .cultural-note { font-size: 11.5px; color: var(--text-tertiary); font-style: italic; margin-top: 5px; padding-top: 5px; border-top: 0.5px solid var(--border); line-height: 1.5; }
    @media (max-width: 800px) {
      .player-card { padding: 0.9rem 1rem 0.85rem; }
    }
    @media (max-width: 600px) {
      .player-card { padding: 0.85rem 0.9rem 0.8rem; margin-bottom: 1.25rem; }
      .play-btn { width: 34px; height: 34px; }
      .controls-row { margin-bottom: 0.5rem; }
      .reveal-all-btn { font-size: calc(11px * var(--te-ui, 1)); padding: 4px 10px; }
      .translit-btn { font-size: calc(11px * var(--te-ui, 1)); padding: 4px 10px; }
      .sentence-header { padding: 0.6rem 0.85rem; }
      .sent-preview { font-size: 15px; }
      .row-thai { font-size: 17px; }
      .reveal-row { padding: 0.5rem 0.85rem; }
      .gloss-chip { font-size: 12.5px; padding: 2px 7px; }
      .cultural-note { font-size: 11px; }
      .orientation-text { font-size: 12px; }
      /* nudge the page eyebrow (the difficulty, e.g. "BEGINNER") up a hair on phones — applies to
         ALL topic pages (player.js loads on every one) for consistency; overrides their 10px rule. */
      .topic-eyebrow { font-size: 10.5px; }
    }
    @media (max-width: 380px) {
      .row-thai { font-size: 16px; }
    }
    /* ---- continuous-playback controls (autoplay / prev / next / repeat) ---- */
    .player-top { flex-wrap: wrap; gap: 8px; }
    .xtra-controls { display: flex; align-items: center; gap: 4px; }
    .xtra-toggle { font-family: var(--font-ui); font-size: 12px; font-weight: 500; color: var(--text-secondary);
      background: var(--bg); border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm);
      padding: 5px 9px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
      transition: background .15s, color .15s, border-color .15s; white-space: nowrap; }
    .xtra-toggle:hover { color: var(--text-primary); }
    .xtra-toggle svg { width: 13px; height: 13px; }
    .xtra-lbl-short { display: none; }   /* the compact "Auto" label is mobile-only */
    .xtra-toggle.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .xtra-icon { position: relative; width: 32px; height: 32px; border-radius: 50%; background: none; border: none;
      color: var(--text-secondary); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background .15s, color .15s; }
    .xtra-icon:hover { background: var(--bg); color: var(--accent); }
    .xtra-icon svg { width: 17px; height: 17px; }
    .xtra-icon.active { color: var(--accent); }
    .repeat-badge { position: absolute; top: 0; right: 0; min-width: 12px; height: 12px; padding: 0 2px; box-sizing: border-box;
      border-radius: 6px; background: var(--accent); color: #fff; font-size: 8px; font-weight: 700; line-height: 12px;
      text-align: center; display: none; }
    .xtra-icon.active .repeat-badge { display: block; }
    .now-playing { display: none; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text-secondary);
      background: var(--bg); border: 0.5px solid var(--border); border-radius: var(--radius-md); padding: 6px 10px; margin-bottom: 0.85rem; }
    .now-playing.show { display: flex; }
    .now-playing .np-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0; animation: np-pulse 1.4s ease-in-out infinite; }
    @keyframes np-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    .now-playing strong { color: var(--text-primary); font-weight: 600; }
    .now-playing a { color: var(--accent); text-decoration: none; }
    .now-playing a strong { color: var(--accent); }
    /* Colour the link by the PLAYED topic's tier, not the page's. The link sits inside #player-root,
       where a premium PAGE remaps --accent to gold — so member/free destinations are pinned to the
       literal brand purple here to defeat that, and premium destinations to the text-gold. */
    .now-playing a.np-premium, .now-playing a.np-premium strong { color: #B29234; }
    .now-playing a.np-member, .now-playing a.np-member strong { color: #4B41AD; }
    .now-playing a:hover { text-decoration: underline; }
    .now-playing a.np-return { color: #C0392B; font-weight: 600; margin-left: 8px; white-space: nowrap; }
    .offline-bar { display: flex; align-items: center; gap: 10px; margin: -0.75rem 0 1.25rem; flex-wrap: wrap; }
    .offline-btn { font-family: var(--font-ui); font-size: 13px; font-weight: 500; color: var(--accent); background: var(--surface); border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 7px 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s, border-color 0.15s; }
    .offline-btn:hover { border-color: var(--accent); background: var(--accent-light); }
    .offline-btn.offline-del { color: var(--text-secondary); }
    .offline-status { font-size: 13px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 7px; }
    .offline-status.offline-ok { color: var(--accent); font-weight: 500; }
    .te-licence-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(20,16,40,0.55); display: flex; align-items: center; justify-content: center; padding: 1.25rem; }
    .te-licence-card { background: var(--surface); border-radius: var(--radius-lg); max-width: 360px; width: 100%; padding: 1.9rem 1.6rem; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }
    .te-licence-eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: #B29234; background: var(--gold-light, #FBF5DC); padding: 4px 11px; border-radius: 20px; margin-bottom: 0.9rem; }
    .te-licence-card h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.6rem; color: var(--text-primary); }
    .te-licence-card p { color: var(--text-secondary); font-size: 14px; line-height: 1.6; margin: 0 0 0.5rem; }
    .te-licence-card .te-licence-sub { color: var(--text-tertiary); font-size: 13px; margin-bottom: 1.5rem; }
    .te-licence-btn { font-family: var(--font-ui); font-size: 15px; font-weight: 500; background: var(--accent); color: #fff; border: none; border-radius: var(--radius-sm); padding: 11px 20px; cursor: pointer; width: 100%; }
    .te-licence-btn:hover { background: var(--accent-mid); }
    .te-licence-card .te-licence-note { margin-top: 1rem; font-size: 12px; color: var(--text-tertiary); }
    @media (max-width: 600px) {
      /* keep the whole control row on ONE line on phones (portrait) */
      .player-top { gap: 6px; }
      .audio-toggle .toggle-btn { font-size: calc(11px * var(--te-ui, 1)); padding: 4px 7px; }
      .xtra-controls { gap: 2px; }
      .xtra-toggle { font-size: 11px; padding: 5px 7px; gap: 4px; }
      .xtra-toggle svg { width: 12px; height: 12px; }
      .xtra-lbl-full { display: none; }    /* swap "Autoplay" → "Auto" to save width */
      .xtra-lbl-short { display: inline; }
      .xtra-icon { width: 28px; height: 28px; }
      .xtra-icon svg { width: 16px; height: 16px; }
    }
    @media (max-width: 360px) {
      .xtra-lbl-short { display: none; }   /* tightest phones: autoplay icon only */
      .xtra-icon { width: 26px; height: 26px; }
    }
    /* ---- Premium topic skin: recolour the player + sentence controls purple → GOLD so it's clear
       at a glance you're on a premium topic. Scoped to the player and sentence list (variable
       override) so the rest of the page stays brand purple; the eyebrow is recoloured separately.
       Light gold = unselected, brighter gold = selected/active. Web AND app; member topics stay
       purple. ---- */
    body.premium-topic #player-root, body.premium-topic #sentence-list {
      --accent: #F0CC5C;        /* the hero Thai-script gold (homepage .hero-thai) */
      --accent-mid: #E3BC48;    /* hover / darker */
      --accent-light: #FBF5DC;  /* unselected — brand light gold (--gold-light) */
      --purple-mid: #D4A82C;    /* sentence-flag outline (visible on the card) */
    }
    /* Bright-gold FILLS carry DARK text/icons (white/light washes out on the light gold). */
    body.premium-topic .play-btn svg,
    body.premium-topic .sent-play-btn.playing svg,
    body.premium-topic .sent-play-btn:hover svg { fill: #3D2E00; }
    body.premium-topic .toggle-btn.active,
    body.premium-topic .xtra-toggle.active,
    /* Added 2026-08-15 — every newly-FILLED control needs the same treatment. The signup CTA and
       the two playlist buttons are accent-filled, so on a premium topic they sit on bright gold
       and white text was reported as hard to read. Same #3D2E00 as the Thai-first/English-first
       toggle beside them. (.te-endcta-cta is deliberately absent: the end-of-topic ask renders on
       FREE topics only, so it never meets the gold palette.) */
    body.premium-topic .te-signup-cta,
    body.premium-topic .te-signup-cta:hover,
    body.premium-topic .repeat-badge { color: #3D2E00; }
    /* ⚠ The two .te-pl-row buttons are NOT overridden here. Their base rule lives in DYN_STYLES,
       which player.js injects AFTER this block, and both selectors have identical specificity —
       so a rule written here loses the tie and the buttons stayed white on gold. The override
       sits next to its base rule in DYN_STYLES instead. Keep them together. */
    /* The eyebrow, subheading and the small player TEXT (progress count + links) use the canonical
       gold-TEXT tone #B29234 (the "Premium" index-pill colour) — readable on the pale page, distinct
       from the brighter #F0CC5C used for FILLS/graphics. The eyebrow/subtitle sit OUTSIDE the player,
       so they need explicit rules anyway. See the premium-gold-palette memory for the full standard. */
    body.premium-topic .topic-eyebrow,
    body.premium-topic .topic-subtitle,
    body.premium-topic .orientation-text a,
    body.premium-topic .offline-btn,
    body.premium-topic .offline-status.offline-ok { color: #B29234; }
    /* ---- floating mini transport ----
       Slim play/pause + ±10 + progress bar that sticks under the nav once the user has started the
       TE/ET track and the real player is scrolled off. Fixed overlay (no layout shift). Hidden state =
       translated off the top + non-interactive, kept in the DOM so show/hide can transition. */
    .te-mini {
      position: fixed; top: 54px; left: 0; right: 0; z-index: 60;
      display: flex; flex-direction: column;
      max-width: 640px; margin: 0 auto; padding: 8px 12px;
      background: var(--accent-light, #EEEDFE); color: var(--accent, #4B41AD);
      border: 0.5px solid var(--border, rgba(0,0,0,0.1)); border-radius: 0 0 14px 14px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.12);
      font-family: var(--font-ui, system-ui, sans-serif);
      transform: translateY(-130%); opacity: 0; pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    .te-mini.show { transform: translateY(0); opacity: 1; pointer-events: auto; }
    .te-mini-row { display: flex; align-items: center; gap: 10px; }
    .te-mini button { border: 0; background: transparent; color: inherit; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; padding: 0; }
    .te-mini-play { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
      background: var(--accent, #4B41AD); color: #fff; }
    .te-mini-play svg { width: 15px; height: 15px; fill: #fff; }
    .te-mini-skip { position: relative; width: 30px; height: 30px; flex-shrink: 0; }
    .te-mini-skip svg { width: 22px; height: 22px; }
    .te-mini-skip .skip-num { position: absolute; top: 53%; left: 0; right: 0; transform: translateY(-50%);
      font-size: 8px; font-weight: 700; text-align: center; }
    /* Big, easy-to-grab seek zone: 44px tall hit area around a 4px visible track. touch-action:pan-y
       lets the page still scroll vertically while horizontal drags scrub. Stays inside the controls
       row, so it never overlaps the now-playing link below. */
    .te-mini-scrub { flex: 1; min-width: 40px; min-height: 44px; align-self: stretch;
      display: flex; align-items: center; cursor: pointer; touch-action: pan-y; }
    .te-mini-bar { width: 100%; height: 4px; border-radius: 2px; background: rgba(0,0,0,0.12); overflow: hidden; }
    .te-mini-fill { height: 100%; width: 0%; border-radius: 2px; background: var(--accent, #4B41AD); }
    .te-mini-x { width: 26px; height: 26px; flex-shrink: 0; opacity: 0.55; font-size: 20px; line-height: 1; align-self: center; }
    .te-mini-x:hover { opacity: 1; }
    /* "Now playing <other topic>" caption — a separate row beneath the controls, its own click target. */
    .te-mini-np { display: none; margin: 2px 4px 0; padding: 2px 0; text-align: center;
      font-size: 12px; line-height: 1.3; color: inherit; text-decoration: none; opacity: 0.85; }
    .te-mini-np.show { display: block; }
    .te-mini-np strong { font-weight: 700; }
    .te-mini-np:hover strong { text-decoration: underline; }
    body.premium-topic .te-mini { background: #FBF5DC; color: #B29234; }
    body.premium-topic .te-mini-play { background: #F0CC5C; }
    body.premium-topic .te-mini-play svg { fill: #3D2E00; }
    body.premium-topic .te-mini-fill { background: #E3BC48; }
    @media (max-width: 480px) { .te-mini { border-radius: 0; } }
    @media (prefers-reduced-motion: reduce) { .te-mini { transition: opacity 0.15s ease; } }
  `;

  /* ---- player markup (transport bar, how-to, controls, list, audio el) ---- */
  var PLAYER_HTML =
    '<div class="progress-controls" id="progress-controls"></div>' +
    '<div class="player-card">' +
      '<div class="player-top">' +
        '<div class="audio-toggle">' +
          '<button class="toggle-btn active" id="btn-te" onclick="switchAudio(\'te\')">Thai first</button>' +
          '<button class="toggle-btn" id="btn-et" onclick="switchAudio(\'et\')">English first</button>' +
        '</div>' +
        '<div class="xtra-controls">' +
          '<button class="xtra-toggle" id="btn-autoplay" onclick="toggleAutoplay()" aria-pressed="false" title="Autoplay: continue to the next topic when this one ends">' +
            '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="13 5 22 12 13 19"/><polygon points="2 5 11 12 2 19"/></svg>' +
            '<span class="xtra-lbl xtra-lbl-full">Autoplay</span>' +
            '<span class="xtra-lbl xtra-lbl-short">Auto</span>' +
          '</button>' +
          '<button class="xtra-icon" id="btn-prev-topic" onclick="advanceTopic(-1)" aria-label="Previous topic" title="Previous topic">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5"/></svg>' +
          '</button>' +
          '<button class="xtra-icon" id="btn-next-topic" onclick="advanceTopic(1)" aria-label="Next topic" title="Next topic">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg>' +
          '</button>' +
          '<button class="xtra-icon" id="btn-repeat" onclick="toggleRepeat()" aria-pressed="false" title="Repeat this topic">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>' +
            '<span class="repeat-badge">1</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="now-playing" id="now-playing"><span class="np-dot"></span><span id="now-playing-text"></span></div>' +
      '<div class="audio-row">' +
        '<button class="skip-btn" onclick="skip(-10)" aria-label="Back 10 seconds" title="Back 10 seconds">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' +
          '<span class="skip-num">10</span>' +
        '</button>' +
        '<button class="play-btn" id="play-btn" aria-label="Play audio" onclick="togglePlay()">' +
          '<svg id="play-icon" viewBox="0 0 16 16"><polygon points="5,2 14,8 5,14"/></svg>' +
        '</button>' +
        '<button class="skip-btn" onclick="skip(10)" aria-label="Forward 10 seconds" title="Forward 10 seconds">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
          '<span class="skip-num">10</span>' +
        '</button>' +
        '<div class="scrubber-wrap">' +
          '<div class="scrubber-track" id="scrubber"><div class="scrubber"><div class="scrubber-fill" id="scrubber-fill"></div></div></div>' +
          '<div class="time-row"><span id="time-cur">0:00</span><span id="time-total">0:00</span></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="offline-bar" id="offline-bar" style="display:none"></div>' +
    '<p class="orientation-text">' +
      '<strong>How to use:</strong> Listen to the <strong>Thai-first</strong> audio a few times to get familiar, then switch to <strong>English-first</strong> to test your recall — try to say the Thai before it plays. Pause anytime. ' +
      '<a href="guide.html">New to ThaiEar? Read the full guide →</a>' +
    '</p>' +
    '<div class="controls-row">' +
      '<div class="controls-left">' +
        '<button class="reveal-all-btn" id="reveal-all-btn" onclick="toggleAll()">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/></svg>' +
          ' Reveal all' +
        '</button>' +
        (HAS_TRANSLIT
          ? '<button class="translit-btn" id="translit-btn" onclick="toggleTranslit()" title="Show pronunciation under the Thai script">' +
              '<span class="tl-ico"><span class="th">ก</span>→a</span> Transliteration' +
            '</button>'
          : '') +
      '</div>' +
      '<span class="sent-count-label">' + sentences.length + ' sentences</span>' +
    '</div>' +
    (SSR ? '' : '<div id="sentence-list"></div>') +   // SSR pages provide #sentence-list as static cards
    '<audio id="sent-audio-el" preload="none" style="display:none"></audio>';

  /* ---- helpers ---- */
  function dispNum(s) { return s.display != null ? s.display : s.num; }
  function cleanThai(thai) { return thai.replace(/\s*\|\s*/g, ' '); }   // spaced " | " OR bare "|"
  function $(id) { return document.getElementById(id); }

  /* ---- audio URL resolution (free = public CDN; premium = signed via the gate) ----
     Free topics build the public audio.thaiear.com URL synchronously, exactly as before.
     Premium topics ask /api/audio for a short-lived presigned R2 URL, sending the Supabase
     session token in an Authorization header (which an <audio> tag can't carry). The Function
     verifies the user and returns the URL; the bytes then load browser ↔ R2 directly. */
  /* ---- signed-URL cache (2026-08-19) — read this before touching buildUrl ----
     A gated clip used to cost TWO serialised round trips before a single byte of audio moved:
     page → /api/audio → Supabase → back, and only THEN the fetch from R2. Worse, the presigned
     URL carries a fresh X-Amz-Date and signature every time, so it is a different URL on every
     tap and NO cache — browser, service worker or edge — can ever hit. Replaying one 10 KB
     sentence therefore re-paid the whole cost, every time. (Measured 2026-08-19 from the owner's
     connection: free clip off the CDN 0.44 s median with `cf-cache-status: HIT`; the same-sized
     premium clip 0.80 s from the S3 endpoint, which returns NO cf-cache-status and NO
     cache-control at all — an origin read, always.)
     The server signs for URL_TTL (21600 s since 2026-08-23), so holding the URL for 5 hours is
     safe with an hour to spare, and it makes the URL STABLE — which is what lets the browser's own
     HTTP cache serve the replay.
     ⚠ RAISED 45m -> 5h IN TANDEM WITH URL_TTL (1h -> 6h). Not a latency change — it is what stops
     a listener who stays on one topic re-minting its whole URL set every 45 minutes, which was
     generating thousands of issuances a day against a corpus they had barely touched and drowning
     the signal the issuance counter exists to read. ANTI_THEFT_PLAN.md §14b.7.
     ⚠ NEVER SET THIS ABOVE URL_TTL. The Math.min below is the guard; if it is ever removed, a
     cached URL outlives the signature and every gated clip 403s until the cache is dropped. In-flight requests are shared, so the dynamic build's pool of 6 asking for the
     same file mints once, not six times.
     ⚠ Memory only, never localStorage: a signed URL is a bearer token for that object. It is
     dropped wholesale on any auth change (see the listener at the bottom of this block) so a
     sign-out cannot leave one usable. */
  var MINT_TTL_MS = 5 * 60 * 60 * 1000;
  var mintCache = {};        // file -> { url, exp }
  var mintInflight = {};     // file -> Promise<url>, so concurrent asks share one mint
  function mintGet(file) {
    var e = mintCache[file];
    if (e && e.exp > Date.now()) return e.url;
    if (e) delete mintCache[file];
    return null;
  }
  function mintPut(file, url, expiresIn) {
    var serverMs = ((expiresIn || 3600) - 600) * 1000;   // stop trusting it 10 min before it dies
    mintCache[file] = { url: url, exp: Date.now() + Math.max(Math.min(serverMs, MINT_TTL_MS), 60000) };
    mintStoreSave();
  }
  /* Drop a mint we have reason to distrust. Called with a filename when playback fails on a
     cached URL (an R2 token rotation, or a clock skew wide enough to beat the 10-minute margin),
     and with nothing on an auth change. */
  function mintDrop(file) {
    if (file) { delete mintCache[file]; delete mintInflight[file]; }
    else { mintCache = {}; mintInflight = {}; mintStoreClear(); }
  }

  /* ---- the signed-URL cache SURVIVES NAVIGATION (2026-08-26) ----
     R2 signs for 6h (URL_TTL) and mintPut clamps to 5h (MINT_TTL_MS) — but mintCache lived in
     memory only, so it died on every navigation. Every topic open therefore paid a fresh
     /api/audio round trip (measured live: 495ms, 878ms, 1558ms — it is the Worker verifying the
     JWT against Supabase, so the cost is the auth check, not the file count) for urls it had
     minted and thrown away minutes earlier. Persisting it means a topic opened twice in an
     afternoon mints ONCE, and the second open starts fetching audio immediately.
     It also cuts issuance, which makes audio_quota a better extraction signal rather than a
     noisier one (ANTI_THEFT_PLAN.md §14b.7).

     ⚠⚠ KEYED ON THE USER, AND THAT IS NOT TIDINESS — IT IS THE WHOLE SAFETY ARGUMENT. A signed
     url is a bearer token for its clip. Sign out, sign in as someone else, and an unkeyed store
     would hand the new visitor the previous one's PREMIUM urls for up to five hours: an
     entitlement bypass that no padlock anywhere would catch. identity.js answers "who is this"
     SYNCHRONOUSLY, before auth.js has even been appended, which is exactly what a cache read at
     parse time needs — and it is already the one sanctioned pre-auth reader.

     ⚠ The identity.js guess can be STALE (it reads a marker, not a live session), so the first
     real `thaiear:auth` also re-checks it below and drops the store if the resolved user is not
     the one we loaded under. Loading optimistically and correcting on the real answer is the
     same shape nav.js uses to avoid a signed-out flash.

     ⚠ CAPPED. A signed url is ~400 bytes and the corpus is 2,175 gated clips, so an unbounded
     store would eventually throw QuotaExceededError on every write. Keep the ones that live
     longest; the rest were closest to expiring anyway. */
  var MINT_STORE = 'te_mint_v1';
  var MINT_STORE_MAX = 400;
  var MINT_SAVE_DEBOUNCE_MS = 1500;   // mintPut fires 30-40 times in a burst; write once
  var mintLoadedUid = null;
  var mintSaveTimer = null;

  function mintUid() {
    try {
      var I = window.ThaiEarIdentity;
      var g = (I && I.guess) ? I.guess() : null;
      return (g && g.state === 'in' && g.user && g.user.id) ? g.user.id : null;
    } catch (_) { return null; }
  }
  function mintStoreClear() {
    mintLoadedUid = null;
    try { localStorage.removeItem(MINT_STORE); } catch (_) {}
  }
  function mintStoreLoad() {
    try {
      var uid = mintUid();
      if (!uid) return;                       // signed out, or storage unreadable
      var o = JSON.parse(localStorage.getItem(MINT_STORE) || 'null');
      if (!o || o.u !== uid || !o.m) return;  // somebody else's urls - see the note above
      var now = Date.now(), n = 0;
      /* A minute of headroom: a url that expires while the page is opening is worse than no url
         at all, because it fails as a media error rather than a rejected promise. */
      for (var f in o.m) {
        var e = o.m[f];
        if (e && e[1] > now + 60000) { mintCache[f] = { url: e[0], exp: e[1] }; n++; }
      }
      mintLoadedUid = uid;
      if (n) latMark('mint:restored', n + ' urls survived the navigation');
    } catch (_) {}
  }
  function mintStoreSave() {
    if (mintSaveTimer) return;
    mintSaveTimer = setTimeout(function () {
      mintSaveTimer = null;
      try {
        var uid = mintUid();
        if (!uid) return;
        var now = Date.now(), keys = Object.keys(mintCache), m = {}, kept = 0;
        keys.sort(function (a, b) { return mintCache[b].exp - mintCache[a].exp; });
        for (var i = 0; i < keys.length && kept < MINT_STORE_MAX; i++) {
          var e = mintCache[keys[i]];
          if (e && e.exp > now) { m[keys[i]] = [e.url, e.exp]; kept++; }
        }
        localStorage.setItem(MINT_STORE, JSON.stringify({ u: uid, m: m }));
        mintLoadedUid = uid;
      } catch (_) {}   // quota, private mode, storage disabled: the cache just stops persisting
    }, MINT_SAVE_DEBOUNCE_MS);
  }
  mintStoreLoad();

  /* A signed URL outlives a sign-out, so the caches are dropped whenever the identity CHANGES.
     Deliberately keyed on the user id rather than on the event alone: `thaiear:auth` also fires
     on the ordinary sign-in that resolves at load, and wiping a freshly warmed cache there would
     undo the prewarm for the one visitor who is definitely entitled to it. */
  var mintUser = null, mintUserSeen = false;
  window.addEventListener('thaiear:auth', function (e) {
    var id = (e && e.detail && e.detail.id) || null;
    if (mintUserSeen && id !== mintUser) { mintDrop(); sentBlobs = {}; sentBlobBytes = 0; }
    /* ⚠ THE FIRST EVENT MATTERS TOO, NOW THAT THE CACHE OUTLIVES THE PAGE. mintUserSeen is
       false on it, so the branch above deliberately does nothing — correct when the cache
       could only have been built by THIS page, and unsafe once it is restored from disk under
       identity.js's guess. If the real answer names a different user, those urls are not
       theirs. Only ever fires on a genuine mismatch, so the ordinary sign-in that resolves at
       load still keeps its freshly warmed cache. */
    else if (!mintUserSeen && mintLoadedUid && id !== mintLoadedUid) {
      mintDrop(); sentBlobs = {}; sentBlobBytes = 0;
      latMark('mint:DROPPED', 'restored urls belong to another user');
    }
    mintUser = id; mintUserSeen = true;
  });

  /* The Supabase access token /api/audio wants, or null while auth is still resolving. Null is a
     "not yet", never a "no" — callers must not treat it as a permanent answer. */
  function authToken() {
    return (window.ThaiEarAuth && window.ThaiEarAuth.getAccessToken)
      ? window.ThaiEarAuth.getAccessToken() : null;
  }

  /* Mint MANY urls in one request (/api/audio?files=…). The auth check inside the Function is
     per USER, not per file, so one call replaces N round trips — the dynamic build mints one per
     clip. Never rejects: anything unexpected just leaves the cache unfilled and every caller
     falls back to the single-file path, which is unchanged. */
  /* file -> the in-flight batch that will mint it. ⚠⚠ WITHOUT THIS, TWO CALLERS A FEW HUNDRED
     MS APART BOTH MINT THE SAME FILES. mintCache is only populated when a batch RESOLVES, so
     everyone arriving during that window sees an empty cache and asks again. buildUrl() has had
     the same guard since it was written (mintInflight); the batch path never did, and nothing
     overlapped closely enough to show it until the head pass started minting a few hundred ms
     ahead of the bulk pass — live, on topic-08: batch(4) at 1252ms, batch(38) at 1420ms, the
     second re-issuing all four of the first's urls.
     ⚠ THIS IS NOT MERELY WASTE. A signed URL handed out is what audio_quota counts as an
     extraction signal (ANTI_THEFT_PLAN.md §14b.7), so duplicate issuance is a constant added to
     a number whose entire job is to look unusual when someone is scraping. */
  var mintBatchInflight = {};
  function mintMany(files) {
    var want = [], waitOn = [], i, f;
    for (i = 0; i < files.length; i++) {
      f = files[i];
      if (!f || mintGet(f)) continue;
      if (mintBatchInflight[f]) {
        if (waitOn.indexOf(mintBatchInflight[f]) < 0) waitOn.push(mintBatchInflight[f]);
        continue;
      }
      if (want.indexOf(f) < 0) want.push(f);
    }
    // Everything we need is already on its way — wait for it rather than asking again.
    if (!want.length) return waitOn.length ? Promise.all(waitOn).then(function () {}) : Promise.resolve();
    var token = authToken();
    if (!token) return Promise.resolve();
    var chunks = [];
    for (var c = 0; c < want.length; c += 100) chunks.push(want.slice(c, c + 100));
    var run = chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        return fetch(AUDIO_API + '?files=' + encodeURIComponent(chunk.join(',')), {
          headers: { Authorization: 'Bearer ' + token }
        }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
          if (!j || !j.urls) return;
          Object.keys(j.urls).forEach(function (f2) { if (j.urls[f2]) mintPut(f2, j.urls[f2], j.expiresIn); });
        }).catch(function () {});
      });
    }, Promise.resolve());
    /* Claim these files for `run`, and release them however it ends. A failed batch must not
       leave its files claimed for ever, or one blip would stop them being minted for the life of
       the page — the same reasoning as buildUrl()'s mintInflight cleanup. */
    for (i = 0; i < want.length; i++) mintBatchInflight[want[i]] = run;
    var release = function () {
      for (var k = 0; k < want.length; k++) {
        if (mintBatchInflight[want[k]] === run) delete mintBatchInflight[want[k]];
      }
    };
    run.then(release, release);
    return waitOn.length ? Promise.all([run].concat(waitOn)).then(function () {}) : run;
  }

  function buildUrl(file, gated) {
    if (gated == null) gated = GATED;
    if (!gated) return Promise.resolve(AUDIO_BASE + '/' + file);
    // Owner test switch: pretend /api/audio refused. This is the ONE thing the entitlement
    // simulator can't fake on its own — the server sees the owner's real (valid) token — so it
    // is what exercises the "server disagrees with the client" fallback in dynBuildSessionFor.
    var cached = mintGet(file);
    if (cached) return Promise.resolve(cached);
    if (mintInflight[file]) return mintInflight[file];
    var token = authToken();
    if (!token) return Promise.reject({ code: 'noauth' });
    var p = fetch(AUDIO_API + '?file=' + encodeURIComponent(file), {
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (r) {
      if (!r.ok) return Promise.reject({ code: r.status });
      return r.json();
    }).then(function (j) {
      if (!j || !j.url) return Promise.reject({ code: 'nourl' });
      mintPut(file, j.url, j.expiresIn);
      return j.url;
    });
    mintInflight[file] = p;
    /* Clear the in-flight slot either way — a rejected mint must not be handed to the next
       caller, or one blip would stick to the file for as long as the page lives. */
    p.then(function () { delete mintInflight[file]; }, function () { delete mintInflight[file]; });
    return p;
  }
  // ── Access gating (the "navigable preview" model) ─────────────────────────────────────────────
  // Gated topics (member/premium) are reachable by ANYONE so they can read the description + preview
  // words, but the gated INTERACTIONS — revealing a sentence, flagging, and playing (sentence or the
  // main TE/ET) — are blocked for non-entitled visitors.
  //
  /* mayListen(): may THIS visitor PLAY AUDIO here? (2026-08-21)
     Listening now needs a free account on EVERY tier, premium and free alike — the one access
     change that came with the home-page redesign.

     ⚠ IT IS SEPARATE FROM entitledForPage() ON PURPOSE, and the two must not be merged.
     entitledForPage() guards revealing, flagging and downloading as well, and REVEALING MUST
     STAY OPEN to a signed-out visitor: the sentence text is server-rendered into every topic
     page for crawlers, so hiding it from people while serving it to Googlebot is the definition
     of cloaking. The deal is "the page is readable, the audio needs an account".

     ⚠ Auth resolves a few hundred ms after paint and can be briefly null offline, so an
     unresolved state must never gate — a paying, downloaded, offline listener has to be able to
     press play. Same rule entitledForPage() already follows. */
  function mayListen() {
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) return true;                 // still resolving → never wrongly refuse
    if (!(a.getUser && a.getUser())) return false;     // no account → no audio, any tier
    return entitledForPage();
  }

  // entitledForPage(): may THIS visitor use the gated interactions on this page?
  function entitledForPage() {
    if (TIER !== 'member' && TIER !== 'premium') return true;   // free topic → open
    /* PREMIUM entitlement is exactly canUseOffline(): it already encodes the whole rule —
       server confirmed active → yes; server said lapsed → no; couldn't ask → paid period, else
       50 days since the last confirmation.
       It used to ask isSubscribed() alone, which offline reads TRUE from the cached subscription.
       So a member 51 days unconfirmed still passed this check and played any already-built
       session, while regeneration failed — the half-state of "it plays but won't rebuild".
       Downloaded content needs no separate branch: canUseOffline covers it, and a download that
       is no longer licensed should not play either. */
    if (TIER === 'premium') return canUseOffline('premium');
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) return true;                          // auth still resolving → don't wrongly gate a paying user
    if (TIER === 'member') return !!(a.getUser && a.getUser()); // member = any signed-in user
    return !!(a.isSubscribed && a.isSubscribed());              // premium = active subscription
  }
  /* gateSignIn(): "this needs an ACCOUNT" — the free sign-in page, on web AND in the app (login is
     not payment steering, so Google Play is fine with it). Used by playlists, downloads, progress
     and flagging: features, not content.
     ⚠ This used to be spelled gate('member'), which since the 2026-08-10 tier retirement named a
     tier that no longer exists. Same behaviour, honest name — nothing here was ever about the
     member TIER, only about needing a login. */
  function gateSignIn() {
    window.location.href = 'join.html?feature=1&next=' + encodeURIComponent(PAGE_FILE);
  }
  // gate(): what a non-entitled tap does. Premium → the paywall on the WEBSITE, but in the APP an
  // informational sheet instead (Google Play forbids steering to outside payment). A tier that only
  // needs a login routes to gateSignIn() above.
  function gate(tier) {
    if (tier == null) tier = TIER;
    /* ⚠ A FREE TOPIC CAN NOW BE REFUSED, and when it is there is exactly one reason — no
       account — so the remedy is the free sign-in, never the paywall. Without this branch a
       signed-out visitor tapping play on a free topic would be sent to subscribe.html and asked
       to pay for something that is free. */
    if (tier !== 'member' && tier !== 'premium') { gateSignIn(); return; }
    if (tier === 'member') { gateSignIn(); return; }   // legacy value; no unit declares it any more
    /* Two very different reasons a premium tap can be refused, and they must not share a message:
         · the server told us the subscription is LAPSED  → the paywall is honest
         · we simply could not REACH the server for >50 days → they may well be paid up; telling
           them to subscribe would be wrong, and telling them to reconnect is the actual remedy.
       isSubscribed() still reporting true (from the last known state) with canUseOffline() false
       is exactly the second case. */
    if (tier === 'premium') {
      var a = window.ThaiEarAuth;
      var lastKnownSubbed = !!(a && a.isSubscribed && a.isSubscribed());
      if (lastKnownSubbed && !canUseOffline('premium')) { showLicenceOverlay(); return; }
    }
    if (NATIVE) { premiumInfoSheet(); return; }
    window.location.href = 'subscribe.html';
  }
  /* ══ PLAYLISTS: PER-SENTENCE ENTITLEMENT ═══════════════════════════════════════════════
     A playlist MIXES TOPICS, so entitlement is a property of each sentence, not of the page —
     playlists.html declares the page itself `tier:'free'`, which is why entitledForPage() lets
     everyone press play here. Before this, a lapsed subscriber's playlist died WHOLE: the first
     denied clip rejected a dynPool lane, that rejected the Promise.all, and the whole session
     build failed — so the free sentences they were still entitled to never played either, and
     they were thrown to the paywall with no idea which items caused it.
     Now: locked sentences are dropped from the session (stitch the rest), grouped under a
     "Premium content" heading at the BOTTOM of the list, and any interaction with one routes to
     the same gate() the topic pages use (app → neutral sheet, web → paywall).
     Topic pages are untouched — they keep their single whole-page gate. */
  function sentById(num) {
    for (var i = 0; i < sentences.length; i++) if (sentences[i].num === num) return sentences[i];
    return null;
  }
  /* ⚠ THE LIVE TIER FOR AN AUDIO PREFIX, NOT THE SNAPSHOT (2026-08-13). A playlist sentence carries
     the tier that was current when it was SAVED (playlist_items.tier), and a tier change is
     invisible to it forever. That matters because the tier is a ROUTING decision, not a label:
     member/premium mints a signed URL against the PRIVATE bucket, free hits the public CDN. The
     2026-08-10 demotion of the 9 former-member first-parts MOVED their MP3s to the public bucket,
     so a saved row still saying 'member' asked the gate to sign a URL for an object that was no
     longer there — a hard 404 on every clip fetch and session build, which no retry could clear
     (owner: ShoppingAndMoney_BEG_S323 in two playlists, both stuck). topics.js ships with the
     deploy, so it is the only current source. Null for an unknown prefix → caller keeps the
     snapshot rather than silently declaring an unrecognised clip free. */
  function liveTierFor(prefix) {
    var T = window.ThaiEarTopics;
    return (T && T.tierForPrefix) ? T.tierForPrefix(prefix) : null;
  }
  function sentTierOf(s) {
    if (!s || s.tier == null) return TIER;
    return liveTierFor(s.prefix) || s.tier;
  }
  /* Extra card classes a playlist row needs. On a topic page the whole page is one tier, so the
     gold skin is applied once to <body> (premium-topic); a playlist MIXES tiers, so the premium
     gold has to be per CARD — free/member rows stay brand purple, premium rows go gold, locked
     or not. Returned as a string because syncCard() rewrites className wholesale. */
  function sentCardClasses(s) {
    if (!PLMODE || !s) return '';
    var cls = '';
    /* ⚠ PRECEDENCE: locked BEATS not-downloaded (owner, 2026-08-08: "if any sentences happened to
       be premium and user didn't have access to them then that's fine, we don't need to grey out
       or say they aren't downloaded as user doesn't have access anyway"). else-if, not two ifs —
       a locked card must look exactly as it always has. */
    if (sentLocked(s)) cls += ' sent-locked';
    else if (sentNoDl(s)) cls += ' sent-nodl';
    if (sentTierOf(s) === 'premium') cls += ' sent-premium';
    return cls;
  }
  /* ── NOT DOWNLOADED (2026-08-09, OFFLINE_PLAYLISTS_PLAN.md Part B) ───────────────────────────
     A playlist mixes topics, so offline it is NORMAL for some of its sentences to be on the device
     and others not. Before this, one missing clip failed as a network error inside the build and
     killed the whole thing — the owner's "if some of the playlist is not downloaded, the entire
     playlist won't play".
     ⚠ ONLY THE FALSE CASE OF navigator.onLine IS TRUSTED. It reports *online* in airplane mode in
     this WebView (documented throughout this file), so this predicate is layer 1: it greys and
     skips only when the browser ADMITS to being offline. Layer 2 — the build-side skip in
     dynBuildSessionFor — catches the case where it lied. Two layers on purpose; do not collapse.
     ⚠ PLAYLISTS ONLY. A partly-downloaded TOPIC is possible (an interrupted download keeps what it
     got) but the owner ruled it a rare edge case, so topic pages keep their existing behaviour.
     Presence is the MANIFEST test (hasLocalFile), which is synchronous and therefore usable during
     render. The manifest can lie about a corrupt file (see the r123 self-heal note in
     dynFetchClip), which is exactly why the BUILD still trusts the actual fetch instead of this. */
  /* Clips layer 2 PROVED unavailable by actually trying to fetch them. Keyed like the build's own
     `denied` map. This is what lets the greying be right in the two cases the manifest cannot
     answer: navigator.onLine lied, or the file is present-but-corrupt (a corrupt clip offline is
     functionally identical to an absent one — unplayable and unfixable until reconnection).
     Cleared on `online`, so a reconnect re-tests rather than inheriting old verdicts. */
  var dynNoDlSeen = {};
  function dynNoDlKey(ref) { return ref.prefix + '|' + ref.file.replace(/_(TH|EN)\.mp3$/, ''); }
  function sentNoDl(s) {
    if (!PLMODE || !s) return false;
    if (sentLocked(s)) return false;           // premium lock wins; never both
    var ref = dynClipRef(s, 'TH');
    if (dynNoDlSeen[dynNoDlKey(ref)]) return true;   // measured, so it outranks what onLine claims
    if (navigator.onLine) return false;        // only FALSE is trustworthy — see above
    if (!(OFFLINE || WEB_DL || DYN_WEB_DL)) return false;   // no offline store on this platform
    return !(isDownloaded(ref.prefix) && hasLocalFile(ref.prefix, ref.file));
  }
  function sentNoDlCount() {
    if (!PLMODE) return 0;
    var n = 0;
    for (var i = 0; i < sentences.length; i++) if (sentNoDl(sentences[i])) n++;
    return n;
  }
  /* ⚠ THE RULE NOW LIVES IN auth.js (ThaiEarAuth.lockedFor) — shared with playlists.html's
     dlGroup(), which previously had no tier awareness and so tried to download locked clips.
     History kept because it is the reason the consolidation exists: PREMIUM here is exactly
     canUseOffline(), identical to entitledForPage(). It once asked isSubscribed() alone, which
     reads TRUE from the cached subscription while offline — so a member 51 days unconfirmed kept
     full access to premium sentences INSIDE PLAYLISTS while the same person was correctly gated on
     the topic page. That call site was fixed and this sibling missed. One predicate now. */
  function sentLocked(s) {
    if (!PLMODE) return false;                 // topic pages gate the whole page, not per sentence
    var a = window.ThaiEarAuth;
    var item = { tier: sentTierOf(s), prefix: (s && s.prefix) ? s.prefix : PREFIX };
    var canStore = !!(OFFLINE || WEB_DL || DYN_WEB_DL);
    if (a && typeof a.lockedFor === 'function') return a.lockedFor(item, { canStoreOffline: canStore });
    // Stale-cache fallback only — see canUseOfflineLegacy. Keep identical; edit auth.js instead.
    if (item.tier !== 'member' && item.tier !== 'premium') return false;
    if (item.tier === 'premium') return !canUseOffline('premium');
    if (canStore && item.prefix && isDownloaded(item.prefix)) return false;
    if (!a || !a.isReady) return false;        // auth still resolving → never lock a paying user
    return !(a.getUser && a.getUser());
  }
  // Locked items sink to the bottom, keeping their relative order; display numbers follow the
  // list the user actually sees. Called on mount and again whenever auth resolves/changes.
  function dynApplyLockOrder() {
    if (!PLMODE) return false;
    var open = [], shut = [], i;
    for (i = 0; i < sentences.length; i++) (sentLocked(sentences[i]) ? shut : open).push(sentences[i]);
    var next = open.concat(shut), changed = next.length !== sentences.length;
    for (i = 0; i < next.length && !changed; i++) if (next[i] !== sentences[i]) changed = true;
    sentences = next;
    for (i = 0; i < sentences.length; i++) sentences[i].display = i + 1;
    return changed;
  }
  function dynFirstLockedNum() {
    for (var i = 0; i < sentences.length; i++) if (sentLocked(sentences[i])) return sentences[i].num;
    return null;
  }
  // A locked card was tapped — same gate as a locked topic. Member → sign-in; premium → the
  // neutral in-app sheet (NATIVE) or the website paywall.
  function gateSent(num) {
    var s = null;
    for (var i = 0; i < sentences.length; i++) if (sentences[i].num === num) { s = sentences[i]; break; }
    if (!s || !sentLocked(s)) return false;
    gate(sentTierOf(s));
    return true;
  }
  /* Tap on a greyed, not-downloaded card. Returns true when it swallowed the interaction, so the
     call sites read exactly like gateSent() above. Deliberately a plain message and NOT a gate:
     nothing is being withheld and there is nothing to buy — the audio simply is not on the device,
     and offline the user cannot fix it right now. */
  function noDlSent(num) {
    var s = null;
    for (var i = 0; i < sentences.length; i++) if (sentences[i].num === num) { s = sentences[i]; break; }
    if (!s || !sentNoDl(s)) return false;
    dynMsg('Not downloaded',
      'This sentence’s audio isn’t on your device. Download this playlist, or reconnect to play it.');
    return true;
  }

  // premiumInfoSheet(): compliance-safe explainer shown IN THE APP when a non-entitled visitor taps a
  // gated interaction on a premium topic. Google Play's reader-app rule forbids steering users to any
  // outside payment method, so this NEVER shows a price, the website, or a subscribe/checkout path — it
  // only explains what Premium unlocks, plus a Sign in for an existing subscriber who isn't signed in
  // (login is not payment steering). Replaces the old auto-dismiss "preview only" toast, which read as a
  // dead tap with no information. Web keeps its normal paywall redirect (subscribe.html), above.
  function premiumInfoSheet() {
    try {
      if (document.getElementById('te-premium-sheet')) return;   // already open — don't stack
      var a = window.ThaiEarAuth;
      var signedIn = !!(a && a.getUser && a.getUser());
      var ov = document.createElement('div');
      ov.id = 'te-premium-sheet';
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
        'justify-content:center;padding:20px;background:rgba(20,16,48,.5);opacity:0;transition:opacity .18s;';
      // Two non-entitled states reach this sheet (a subscribed visitor is never gated):
      //   • signed OUT — might be an existing subscriber who just isn't logged in → offer Sign in.
      //   • signed IN on a free account — login won't help and we can't steer to payment in-app, so
      //     no button, just a neutral note stating their state. Both only ever explain, never sell.
      var signInBtn = signedIn ? '' :
        '<button id="te-ps-signin" style="flex:1;font:600 14px var(--font-ui,system-ui,sans-serif);' +
        'padding:11px 14px;border-radius:8px;border:0;background:#4B41AD;color:#fff;cursor:pointer;">Sign in</button>';
      /* The second sentence is a STATEMENT OF FACT, not a signpost (owner-approved, 2026-08-15):
         no destination, no price, no "subscribe", no "upgrade". It exists because a signed-in free
         user is the genuinely stuck one — they hunt for a control that is deliberately absent and
         conclude the app is broken. Passive ("can't be managed in the app") rather than
         second-person on purpose: it describes the app instead of instructing the user.
         ⚠ Signed-OUT keeps its original line and gains nothing — that person already has an
         actionable next step (Sign in), so the note would be noise. Do not add a destination. */
      var stateNote = signedIn
        ? 'You’re signed in on a free account. Membership can’t be managed in the app.'
        : 'Already a Premium member? Sign in to listen.';
      ov.innerHTML =
        '<div role="dialog" aria-modal="true" style="background:#fff;border-radius:14px;max-width:360px;width:100%;' +
          'padding:22px 20px 18px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:var(--font-ui,system-ui,sans-serif);">' +
          // Same sheet on a playlist, but the noun has to be right: the locked rows there are
          // sentences drawn from several topics, not "this topic".
          '<div style="font:600 17px var(--font-ui,system-ui,sans-serif);color:#B29234;margin-bottom:8px;">🔒 Premium ' +
            (PLMODE ? 'content' : 'topic') + '</div>' +
          '<p style="font-size:14px;color:#5A5A5A;line-height:1.55;margin:0 0 12px;">' +
            (PLMODE ? 'These sentences are for Premium members.' : 'You’re previewing this topic.') +
            ' A ThaiEar Premium membership unlocks:</p>' +
          '<ul style="list-style:none;margin:0 0 16px;padding:0;font-size:14px;color:#1A1A1A;line-height:1.9;">' +
            '<li>✓ Every topic and level</li>' +
            '<li>✓ All sentence and full-topic audio</li>' +
            '<li>✓ Offline downloads</li></ul>' +
          '<p style="font-size:13px;color:#9A9A9A;line-height:1.5;margin:0 0 14px;">' + stateNote + '</p>' +
          '<div style="display:flex;gap:8px;">' +
            signInBtn +
            '<button id="te-ps-close" style="flex:1;font:600 14px var(--font-ui,system-ui,sans-serif);' +
              'padding:11px 14px;border-radius:8px;border:.5px solid rgba(0,0,0,.18);background:#fff;color:#5A5A5A;cursor:pointer;">Got it</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.style.opacity = '1'; });
      function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      var c = ov.querySelector('#te-ps-close'); if (c) c.addEventListener('click', close);
      var s = ov.querySelector('#te-ps-signin');
      if (s) s.addEventListener('click', function () { window.location.href = 'account.html'; });
    } catch (_) {}
  }

  // Audio denied by the server (or licence lapse). Transient errors just log; the play button is
  // already reset by the caller. The actual gate/redirect is shared with the interaction gating.
  function handleDenied(err, tier) {
    if (tier == null) tier = TIER;
    var code = err && err.code;
    // Nothing this visitor may play at all (all-premium unit, no entitlement). The status line
    // already reads "Premium membership needed" — no overlay, no gate, and NOT a console warning,
    // because this is an expected answer rather than a failure.
    if (code === 'nothing-playable') return;
    // Offline premium download whose licence has lapsed → friendly in-page message (no navigation).
    if (code === 'licence') { showLicenceOverlay(); return; }
    var isGate = (code === 'noauth' || code === 401 || code === 402 || code === 403);
    if (!isGate) { console.warn('player.js: audio unavailable', err); return; }
    gate(tier);
  }

  var PLAY_TRI  = '<polygon points="5,2 14,8 5,14"/>';
  var PLAY_BARS = '<rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/>';
  function setMainIcon(playing) {
    // Dyn: the equalizer cue on the playing sentence card runs only while audio actually plays.
    if (DYN) { try { document.body.classList.toggle('dyn-playing', !!playing); } catch (_) {} }
    var i = $('play-icon'); if (i) i.innerHTML = playing ? PLAY_BARS : PLAY_TRI;
    var mi = $('te-mini-icon'); if (mi) mi.innerHTML = playing ? PLAY_BARS : PLAY_TRI;
    // Screen readers should hear the action the button will take, not a static label.
    var pb = $('play-btn'); if (pb) pb.setAttribute('aria-label', playing ? 'Pause audio' : 'Play audio');
    var mp = $('te-mini-play'); if (mp) mp.setAttribute('aria-label', playing ? 'Pause audio' : 'Play audio');
    // Starting the main TE/ET track latches the floating mini transport on for the rest of the visit
    // (it then shows whenever the real player scrolls out of view). Pausing keeps it latched.
    if (playing) miniActivated = true;
    updateMiniVisibility();
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (_) {} }
  }

  /* ---- floating mini transport ----
     Once the user starts the main TE/ET track, a slim play/pause + ±10 bar sticks under the nav
     whenever the real player is scrolled out of view, so transport stays reachable while reading the
     sentence cards. It mirrors the SAME mainAudio (no second engine): play/pause → togglePlay(), skip
     → skip(±10), glyph driven by setMainIcon(), progress by the timeupdate handler. Pausing keeps it
     up; only ✕ hides it, and only for this page visit (resets on reload). Fixed overlay → no layout
     shift (preserves the topic-page CLS). Web / PWA / app all load this file, so it lands on all three. */
  var miniActivated = false;   // has the main TE/ET been started this page-load? (latches on)
  var miniDismissed = false;   // did the user ✕ the bar this visit?
  var mainInView = true;       // is #player-root currently on screen? (IntersectionObserver)
  /* The ONE place the mini progress bar moves. Every caller goes through here so the painted
     fill and the slider's aria-valuenow can never disagree — the accessibility audit found the
     bar advancing visually while screen readers were told nothing. */
  /* Strip markup and quotes so a preview can be dropped into an aria-label attribute.
     Previews are plain Thai today, but they come from authored JSON and must not be able
     to break out of the attribute. */
  function ariaText(t) {
    return String(t == null ? '' : t).replace(/<[^>]*>/g, '').replace(/"/g, '&quot;').trim();
  }
  function setMiniFill(pct) {
    pct = Math.max(0, Math.min(100, pct || 0));
    // NB: write the fill element directly here — a bulk edit once rewrote this very line into a
    // call to setMiniFill itself, which recursed until "Maximum call stack size exceeded".
    var mf = $('te-mini-fill'); if (mf) mf.style.width = pct + '%';
    var sc = $('te-mini-scrub'); if (sc) sc.setAttribute('aria-valuenow', Math.round(pct));
  }
  function syncMini() {
    var mi = $('te-mini-icon'); if (mi) mi.innerHTML = mainAudio.paused ? PLAY_TRI : PLAY_BARS;
    setMiniFill(mainAudio.duration ? (mainAudio.currentTime / mainAudio.duration) * 100 : 0);
  }
  function updateMiniVisibility() {
    var bar = $('te-mini'); if (!bar) return;
    var show = miniActivated && !mainInView && !miniDismissed && !(DYN && dynSel);   // select mode: yield to the bottom bar
    if (show) syncMini();   // make sure glyph/progress are current the moment it slides in
    bar.classList.toggle('show', show);
  }
  // Drag/tap-to-seek on the mini progress bar. The hit zone (.te-mini-scrub) is much TALLER than the
  // 4px visible track so it's easy to grab on touch; the position maps to the visible bar's width.
  // Confined to the controls row, so it never overlaps the "now playing" link row beneath it.
  function initMiniScrub() {
    var scrub = $('te-mini-scrub'); if (!scrub) return;
    var track = scrub.querySelector('.te-mini-bar');
    var dragging = false;
    function seekTo(clientX) {
      if (!mainAudio.duration || !isFinite(mainAudio.duration)) return;
      var r = track.getBoundingClientRect();
      var pct = r.width ? (clientX - r.left) / r.width : 0;
      pct = Math.max(0, Math.min(1, pct));
      try { mainAudio.currentTime = pct * mainAudio.duration; } catch (_) {}
      setMiniFill(pct * 100);
    }
    scrub.addEventListener('pointerdown', function (e) {
      dragging = true;
      try { scrub.setPointerCapture(e.pointerId); } catch (_) {}
      seekTo(e.clientX); e.preventDefault();
    });
    scrub.addEventListener('pointermove', function (e) { if (dragging) seekTo(e.clientX); });
    function end(e) {
      dragging = false; try { scrub.releasePointerCapture(e.pointerId); } catch (_) {}
      // Dyn: snap the committed mini-scrub seek to the nearest sentence start (round-8 item 3).
      if (DYN && dynSession && mainAudio.duration && isFinite(mainAudio.duration)) {
        var t2 = dynSnapTime(mainAudio.currentTime);
        try { mainAudio.currentTime = t2; } catch (_) {}
        dynLastPos = t2;
        setMiniFill(t2 / mainAudio.duration * 100);
      }
    }
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);
  }
  function initMiniPlayer() {
    if (!$('player-root') || $('te-mini')) return;   // topic pages only; once
    var bar = document.createElement('div');
    bar.className = 'te-mini';
    bar.id = 'te-mini';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Mini audio player');
    bar.innerHTML =
      '<div class="te-mini-row">' +
        '<button class="te-mini-skip" id="te-mini-back" aria-label="Back 10 seconds" title="Back 10 seconds">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' +
          '<span class="skip-num">10</span>' +
        '</button>' +
        '<button class="te-mini-play" id="te-mini-play" aria-label="Play or pause audio">' +
          '<svg id="te-mini-icon" viewBox="0 0 16 16">' + PLAY_TRI + '</svg>' +
        '</button>' +
        '<button class="te-mini-skip" id="te-mini-fwd" aria-label="Forward 10 seconds" title="Forward 10 seconds">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
          '<span class="skip-num">10</span>' +
        '</button>' +
        // role="slider" MUST carry aria-valuenow (2026-08-11 audit): without it a screen reader
        // announces "Seek, slider" and no position at all. min/max are the percentage the fill
        // paints, and setMiniFill() keeps the two in step.
        '<div class="te-mini-scrub" id="te-mini-scrub" role="slider" aria-label="Seek"' +
          ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
          '<div class="te-mini-bar"><div class="te-mini-fill" id="te-mini-fill"></div></div>' +
        '</div>' +
        '<button class="te-mini-x" id="te-mini-x" aria-label="Hide mini player" title="Hide">&times;</button>' +
      '</div>' +
      // Shown only when the player has drifted onto ANOTHER topic (autoplay/next); links there.
      '<a class="te-mini-np" id="te-mini-np" href="#"></a>';
    document.body.appendChild(bar);
    $('te-mini-play').addEventListener('click', function () { togglePlay(); });
    $('te-mini-back').addEventListener('click', function () { skip(-10); });
    $('te-mini-fwd').addEventListener('click', function () { skip(10); });
    $('te-mini-x').addEventListener('click', function () { miniDismissed = true; updateMiniVisibility(); });
    initMiniScrub();
    // Show the mini exactly when the real player leaves the viewport. The negative top rootMargin trips
    // it as the player tucks under the sticky nav (~54px), not only once it's fully off-screen.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        // r22a: the mini is for when the player has scrolled AWAY ABOVE — so you can resume
        // without scrolling back past thirty sentences. isIntersecting alone is direction-
        // blind: it is equally false when the player sits BELOW the viewport, i.e. when you
        // are near the top of the page and the real player is about to come into view. That
        // made it appear exactly where it is useless. A positive top means "still below us".
        mainInView = e.isIntersecting || e.boundingClientRect.top > 0;
        updateMiniVisibility();
      }, { rootMargin: '-56px 0px 0px 0px', threshold: 0 });
      // Round-10 addendum D (dyn): #player-root grows a tail (status/slider/controls rows), so
      // observing all of it left a dead band — transport gone, mini not yet shown. Watch the
      // transport row itself so the mini appears the moment the play/scrub controls leave view.
      var ioTarget = $('player-root');
      if (DYN) { var ioRow = document.querySelector('#player-root .audio-row'); if (ioRow) ioTarget = ioRow; }
      io.observe(ioTarget);
    }
    syncMini();
  }

  /* ---- state ---- */
  var states = {};
  sentences.forEach(function (s) { states[s.num] = 0; });
  var sentPlaying = null;
  /* The sentence that owns the 300 ms tap debounce, or null. NOT a boolean — see the note in
     toggleSentPlay: a blunt global lock discards taps on OTHER sentences in complete silence. */
  var sentLock = null;
  var sentBlobUrl = null;   // object URL of the clip currently in the sentence <audio>; revoked on swap/stop
  function revokeSentBlob() { if (sentBlobUrl) { try { URL.revokeObjectURL(sentBlobUrl); } catch (_) {} sentBlobUrl = null; } }
  var slowMode = false;
  var resumeMainAfter = false;   // main-pause coordination: was the top player playing when a sentence took over?

  function toggleSlow(e) {
    e.stopPropagation();
    e.preventDefault();
    slowMode = !slowMode;
    document.querySelectorAll('.speed-toggle').forEach(function (btn) { btn.classList.toggle('active', slowMode); });
  }

  /* ---- dynamic player mode (DYN) ----
     Test-page feature (cfg.dyn === true): instead of playing the pre-rendered combined
     TE/ET MP3, the top player plays a session stitched CLIENT-SIDE from the per-sentence
     clips (_TH/_EN), with per-sentence repeat/recall pauses scaled by a user slider, and
     per-sentence exclusion. Everything here is inert unless DYN — non-dyn pages are
     behaviourally unchanged. */
  var DYN = cfg.dyn === true;

  // ?dbg=1 on-page debug overlay (round-8 item 5): the owner screenshots lock-screen /
  // media-session failures on iPhone — blind fixes have failed twice. dynLog() is a strict
  // no-op unless DYN && dbg=1, so sprinkling calls into shared handlers changes nothing
  // for normal pages.
  // dbg=1 sticks for the whole session (sessionStorage) so the overlay survives the
  // cross-page hops it exists to debug.
  var DYN_DBG = DYN && (function () {
    var on = /[?&]dbg=1(&|$)/.test(location.search);
    try {
      if (on) sessionStorage.setItem('te_dbg', '1');
      return on || sessionStorage.getItem('te_dbg') === '1';
    } catch (_) { return on; }
  })();
  /* &prebuild=1 renders both directions for a unit in a hidden frame, reusing this file's
     build path rather than duplicating the stitcher elsewhere.
     ⚠ r20: NOTHING CALLS THIS ANY MORE. Constructing in a hidden frame took MINUTES for a
     9-sentence playlist while the identical build on a foreground page takes seconds — the
     frame is throttled in a way that neither a MessageChannel yield nor moving it on-screen
     cured. Downloads now save the clips only (~1 s) and the mp3 is constructed on first play,
     which is what the on-screen explainer always said would happen. The hook is kept because
     it is harmless and correct; do not reintroduce a hidden-frame build without first
     measuring it against the same build in the foreground. */
  var DYN_PREBUILD = DYN && /[?&]prebuild=1(&|$)/.test(location.search);
  /* r28: opt-in cosmetic restyle, per page via `style2: true` in window.ThaiEarTopic. Everything
     it changes is DISCLOSURE and PLACEMENT — no control is removed, because the owner's
     constraint is that all current functionality must remain. Set on topic-test only, so
     topic-test2 stays as-is for side-by-side comparison. */
  var STYLE2 = DYN && cfg.style2 === true;
  /* r127 — the playlist-chooser / dynMsg / dynConfirm dialogs render through #dyn-pl-pop +
     .dyn-pl-card, whose styles live in player-dyn.css. The TEST pages linked it in their HTML;
     the 93 real topic pages never did (P2a added only the two config flags), so on live pages the
     Add-to-playlist popup appended UNSTYLED — invisible at the page bottom, "button does nothing"
     (owner-reported). Inject the stylesheet once on any dyn page that lacks it. The file is
     precached (sw.js) so this is offline-safe. ⚠ §E cleanup: player-dyn.css must now STAY. */
  if (DYN && !document.querySelector('link[href^="player-dyn.css"]')) {
    var _pdl = document.createElement('link');
    _pdl.rel = 'stylesheet'; _pdl.href = 'player-dyn.css';
    (document.head || document.documentElement).appendChild(_pdl);
  }
  /* r97 — DERIVED from sim.js's single BUILD constant (sim.js loads first on every test page:
     topic-test.html:549 vs :551). The literal is only a fallback for a page without sim.js.
     ▶ Do NOT bump this by hand — bump `BUILD` in sim.js and every tag on every test page moves. */
  var DYN_BUILD = 'r209';   // r209: the bulk prewarm starts when the HEAD pass finishes instead of on a fixed 2500ms timer -- measured on a free topic, head done at 242ms and bulk not until 2541ms, so a tap at 1828ms on the 11th sentence found 26 of 30 clips still cold. Head raised 4 -> 8 (a phone shows more than four), and thaiear:auth no longer queues a bulk timer per event (~25 of them per page). r208: a tap no longer aborts the download of the clip it is asking for. prewarmYield() spared nothing, so with a 4-clip head pass and a tap near the top of the list the cancelled download was very often the tapped one -- measured on the owner's phone: yield aborted 4, TAP s395, PLAYING 1170ms later. It now spares that file and ADOPTS the fetch already in flight instead of asking for the same bytes again, bounded by SENT_ADOPT_MS so a stalled one cannot hold the button (armSentStall only arms AFTER the src resolves). r207: a SHARE button on the probe panel, where navigator.share exists. The clipboard is not a reliable way off a phone -- execCommand needs user activation and the async clipboard API can be refused outright in a WebView -- and when both fail the owner is hand-selecting 1,600 characters on a handset. r206: the probe's copy button actually copies on a phone -- .select() on a READ-ONLY textarea is refused on iOS and leaves an empty selection in an Android WebView, so the field is made writable for the duration and selected with setSelectionRange, then execCommand('copy') runs synchronously inside the gesture (the async clipboard API can be a silent no-op in a WebView). The button now reports 'copied' vs 'select all + copy'. r205: the probe panel repaints on setTimeout, not requestAnimationFrame -- rAF does not fire in a backgrounded tab or app, and latQueued had already latched true, so the panel never appeared and never recovered. r204: the latency probe is usable ON A PHONE -- copy renders a selectable textarea as well as trying the clipboard (a WebView clipboard write can be refused or a silent no-op, and there is no console in the app), and the panel is 92vw on a handset instead of a 46vw ribbon. r203: a RESTORED signed-URL cache no longer waits for auth. The prewarm asked for a token whenever the topic was gated, not whenever it still had something to mint -- so a second visit, with every url already in the persisted cache, stopped at 789ms and did not start until 1245ms for an /api/audio call it was never going to make. r202: the signed-URL cache SURVIVES NAVIGATION. R2 signs for 6h and mintPut clamps to 5h, but mintCache was memory-only, so every topic open paid a fresh /api/audio round trip (495-1558ms measured -- it is the Worker verifying the JWT against Supabase) for urls it had minted and thrown away minutes earlier. Persisted in localStorage, KEYED ON THE USER via identity.js's synchronous guess and re-checked against the first real thaiear:auth: a signed url is a bearer token for its clip, so an unkeyed store would hand the next person to sign in on that browser the previous one's premium urls for five hours. r201: ONE batch mint per page, not two -- mintMany() now dedupes against batches that are IN FLIGHT (mintCache only fills when a batch RESOLVES, so the head pass and the bulk pass both minted the same files: live, batch(4) at 1252ms and batch(38) at 1420ms). Duplicate issuance is noise in the audio_quota extraction signal. Also: the head pass mints the whole topic in its one request, and thaiear:auth stops re-arming a prewarm that already started (it fires ~15x). r200: the FIRST individual-sentence tap. The idle prewarm re-arms on thaiear:auth instead of polling every 6s for a token (measured: attempt 1 at 2946ms, attempt 2 at 9262ms), and a HEAD pass warms the first 4 clips with no idle wait at all -- before this, the batch mint did not start until 3423ms (topic-08) / 7841ms (topic-06) and the first clip was not in memory until ~5.0s / ~9.4s, so the clip a visitor actually tapped was never the warm one. ?lat=1 arms the probe that measured it. r199: REPEAT loops a fraction before the end instead of waiting for the ended event — the screen-locked stop. r198: play counting credits ONE listen per repetition ACTUALLY HEARD — repeats=4 no longer awards four listens two seconds in. r197: the individual-sentence tap always starts the clip — `ended`/`pause`/`timeupdate` now say which attempt they belong to (a queued event from the clip you switched AWAY from was un-lighting the one you tapped, whenever the new src resolved asynchronously: any downloaded clip, any gated clip with no cached mint), #sent-audio-el gets the same in-gesture priming the top player got in r195, and the idle prewarm no longer latches dead when auth has not produced a token yet. r196: per-sentence play counts on every pill + the minimum on topic/playlist cards; flags and the progress bar retired; listens now counts sentences. r195: prime the top player inside the tap (a built dyn mp3 now starts on the FIRST press) + the play icon follows the promise. r193: playlist cards survive a reveal — dyn-live/dyn-off re-derived in cardHtml, decoration re-attached after the non-SSR rebuild. r192: sentence-clip latency — signed-URL cache, batch minting, idle prewarm. r191: repair the pill hint on stale/downloaded pre-2026-08-18 markup. r190: direction-aware pill hint (previewEn). P3: sim.js (the old single BUILD source) is gone — bump THIS literal per release
  // Round-14: the account copy of the dyn settings lands whenever auth (re)resolves.
  if (DYN) {
    window.addEventListener('thaiear:auth', function () { dynPrefsApply(); });
    /* r16a — THE STALE-CONTROL FIX. The settings are read fresh on every play (so the audio
       is always right) but the controls are painted ONCE at mount. Sync on the playlists
       page, walk to a topic the WebView still holds in its back/forward cache, and that page
       is RESTORED rather than re-executed: correct audio, stale English checkbox. So
       re-resolve and repaint whenever the page is shown again, and whenever another tab
       writes a setting. Cheap, idempotent, and only invalidates if a value actually moved. */
    window.addEventListener('pageshow', function () { dynRefreshSettingsUI(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') dynRefreshSettingsUI();
    });
    window.addEventListener('storage', function (e) {
      if (!e || !e.key) return;
      if (e.key.indexOf('te_dyn_set_') === 0 || e.key.indexOf('te_dyn_gdef_') === 0) dynRefreshSettingsUI();
    });
  }
  var dynLogEl = null;
  function dynLog(msg) {
    if (!DYN_DBG) return;
    try {
      if (!dynLogEl) {
        dynLogEl = document.createElement('div');
        dynLogEl.id = 'dyn-dbg';
        dynLogEl.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;max-width:82vw;' +
          'max-height:8.6em;overflow-y:auto;background:rgba(10,10,20,.82);color:#8f8;' +
          'font:10px/1.35 monospace;padding:5px 7px;border-radius:6px;pointer-events:none;' +
          'white-space:pre-wrap;word-break:break-all;';
        (document.body || document.documentElement).appendChild(dynLogEl);
      }
      var t = new Date();
      var line = document.createElement('div');
      line.textContent = ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + ' ' + msg;
      dynLogEl.appendChild(line);
      while (dynLogEl.childNodes.length > 40) dynLogEl.removeChild(dynLogEl.firstChild);
      dynLogEl.scrollTop = dynLogEl.scrollHeight;
    } catch (_) {}
  }
  if (DYN_DBG) {
    window.addEventListener('error', function (e) { dynLog('ERR ' + ((e && e.message) || e.type)); });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      dynLog('REJ ' + ((r && ((r.name || '') + ' ' + (r.message || r.code || ''))) || String(r)));
    });
  }

  var DYN_SR = 24000;
  /* ── ROUND-16: settings are PER UNIT and PER MODE ───────────────────────────────────
     Until r15 the four dyn settings (pause factor, Thai repeats, English on/off, English
     position) were ONE player-global set shared by every topic and playlist — so moving
     the English position on a topic silently moved it on every playlist too. They are now
     scoped to {unit, mode}: a topic holds separate TE and ET settings, and so does a
     playlist. A unit that has never been touched shows DYN_DEFAULTS — the classic setup
     that reproduces the prefab TE/ET file (2 Thai repeats, English on at the end, ×1
     pauses). "The first settings a user sees is always the default."

     Resolution order for {unit, mode}:
       the unit's own override  →  the user's global default for that MODE  →  DYN_DEFAULTS
     The global default is written ONLY by the "apply to all" sync (dynSyncAll), and the
     race between it and an older per-unit override is settled by TIMESTAMP rather than by
     rewriting every unit's row: a sync stamps a NEWER ts on the global default, which
     therefore supersedes every override made before it; a change made after the sync is
     newer again, so that unit keeps winning. One write, "applies to all", nothing to
     migrate, and a unit is never pinned to a value the user has since replaced globally.

     Because the sync writes a default for ONE mode, syncing in TE leaves every unit's ET
     settings untouched (and vice versa) — which is what the confirm modal promises.
     Storage: localStorage `te_dyn_set_{unitKey}_{mode}` / `te_dyn_gdef_{mode}`, mirrored
     for signed-in users into dyn_prefs (unit rows gain {te,et} alongside {excl}; the
     'global' row becomes {v:2, te, et}). The pre-r16 flat 'global' row and the old
     te_dyn_pf/rp/en/ep keys are deliberately NOT read — per owner, everyone restarts from
     the classic default rather than inheriting the old player-global values. */
  var DYN_DEFAULTS = { pf: 1, rp: 2, en: true, ep: 0 };   // ep 0 = "not chosen" → English at the end
  // The settings currently IN EFFECT (this page's unit, current mode). dynLoadSettings()
  // refills them on boot, on a TE/ET switch, and when the account copy lands.
  var dynFactor = DYN_DEFAULTS.pf;
  var dynRepeats = DYN_DEFAULTS.rp;   // Thai repeat count 1–4
  var dynEnglish = DYN_DEFAULTS.en;   // TE mode only: include the English clip (ET always has it)
  // WHERE the English lands in a TE block — after the Nth Thai repeat. 0 = never chosen →
  // effective default is dynRepeats (the end); a choice above the repeat count clamps there too.
  var dynEngPos = DYN_DEFAULTS.ep;
  function dynEngPosEff() { return (dynEngPos >= 1 && dynEngPos <= dynRepeats) ? dynEngPos : dynRepeats; }
  function dynSetKey(ns, mode) { return 'te_dyn_set_' + ns + '_' + mode; }
  function dynGdefKey(mode) { return 'te_dyn_gdef_' + mode; }
  function dynReadJson(k) {
    try { var o = JSON.parse(localStorage.getItem(k) || 'null'); return (o && typeof o === 'object') ? o : null; } catch (_) { return null; }
  }
  function dynWriteJson(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch (_) {} }
  // Sanitise an untrusted settings record (localStorage / another device) onto the defaults.
  function dynNormSet(o) {
    var d = { pf: DYN_DEFAULTS.pf, rp: DYN_DEFAULTS.rp, en: DYN_DEFAULTS.en, ep: DYN_DEFAULTS.ep };
    if (!o) return d;
    // r147: floor lowered 0.5 → 0.25 with the slider. Widening the ACCEPTED range is safe in this
    // direction only — a stored 0.25 from a device on the new build must survive being read by an
    // old one, and this is the guard that would otherwise silently reset it to 1.
    var pf = parseFloat(o.pf); if (isFinite(pf) && pf >= 0.25 && pf <= 2) d.pf = pf;
    var rp = parseInt(o.rp, 10); if (rp >= 1 && rp <= 4) d.rp = rp;
    if (typeof o.en === 'boolean') d.en = o.en;
    var ep = parseInt(o.ep, 10); if (!isNaN(ep) && ep >= 0 && ep <= 4) d.ep = ep;
    return d;
  }
  // The effective settings for any unit+mode — used for this page AND for a foreign unit
  // the chain builds in place (that unit must sound the way ITS settings say, not ours).
  function dynSettingsFor(ns, mode) {
    var u = dynReadJson(dynSetKey(ns, mode)), g = dynReadJson(dynGdefKey(mode));
    var uts = (u && +u.ts) || 0, gts = (g && +g.ts) || 0;
    return dynNormSet((u && uts >= gts) ? u : (g || u));
  }
  function dynCurrentSet() { return { pf: dynFactor, rp: dynRepeats, en: dynEnglish, ep: dynEngPos }; }
  function dynLoadSettings() {
    var s = dynSettingsFor(DYN_KEY_NS, currentMode);
    dynFactor = s.pf; dynRepeats = s.rp; dynEnglish = s.en; dynEngPos = s.ep;
  }
  // Re-resolve from storage and repaint. Safe to call at any time: the repaint no-ops before
  // the controls are mounted, and nothing is invalidated unless a value genuinely moved.
  function dynRefreshSettingsUI() {
    if (!DYN) return;
    var before = JSON.stringify(dynCurrentSet());
    dynLoadSettings();
    dynPrefsRepaintControls();
    var moved = JSON.stringify(dynCurrentSet()) !== before;
    // The exclusion marks are painted once at mount for the same reason, so they can go
    // stale the same way — re-read them from storage on the same trigger.
    if (!PLMODE) {
      var was = [], now = [];
      for (var k in dynExcluded) { if (dynExcluded[k]) was.push(+k); }
      try {
        var arr = JSON.parse(localStorage.getItem(DYN_EXCL_KEY) || '[]');
        if (Array.isArray(arr)) now = arr.map(Number);
      } catch (_) {}
      var srt = function (a) { return a.slice().sort(function (x, y) { return x - y; }).join(','); };
      if (srt(was) !== srt(now)) {
        dynExcluded = {};
        now.forEach(function (n) { dynExcluded[n] = true; });
        dynPrefsRepaintExcl();
        moved = true;
      }
    }
    if (moved) dynInvalidate();
  }
  // Every control handler ends here: persist for THIS unit + THIS mode only, then sync.
  function dynSaveSettings() {
    var o = dynCurrentSet();
    o.ts = Date.now();
    dynWriteJson(dynSetKey(DYN_KEY_NS, currentMode), o);
    dynPrefsQueue('set');
  }
  var DYN_EXCL_KEY = 'te_dyn_excl_' + (cfg.dynKey || PREFIX);
  var dynExcluded = {};
  try {
    var _dynEx = JSON.parse(localStorage.getItem(DYN_EXCL_KEY) || '[]');
    if (Array.isArray(_dynEx)) _dynEx.forEach(function (n) { dynExcluded[n] = true; });
  } catch (_) {}
  function dynSaveExcluded() {
    try {
      var arr = [];
      for (var k in dynExcluded) { if (dynExcluded[k]) arr.push(+k); }
      localStorage.setItem(DYN_EXCL_KEY, JSON.stringify(arr));
    } catch (_) {}
  }
  var dynSession = null;      // { url, fileUri?, blob, map:[{num,start,end}], key, duration }
  var dynBuilding = null;     // { key, p } while a build is in flight
  var dynClipCache = {};      // decoded AudioBuffer per clip filename (survives invalidation)
  var dynLastLive = null;     // sentence num currently highlighted by the timeupdate handler
  var dynLastPos = 0;         // last known playback position (round-10 item 4: resume must survive an engine idle)
  /* r23: ...but NOT across a reconstruct. dynInvalidate() zeroes dynLastPos, then pause()'s
     trailing timeupdate/pause events fire ASYNCHRONOUSLY on a real <audio> element and write the
     OLD position straight back — so iOS resumed the new mp3 mid-way while Android (whose native
     shim emits no trailing events) correctly started at 0. This flag makes the intent explicit
     rather than relying on event ordering: while set, nothing may record or restore a position. */
  var dynPosStale = false;
  /* ── r197 (2026-08-25): CARRY THE SENTENCE ACROSS A RECONSTRUCT ──────────────────────
     dynLastPos is a TIME, and a rebuilt session has a different timeline, so it is correctly
     thrown away by dynInvalidate(). But the thing the listener cares about survives the
     rebuild perfectly well: WHICH SENTENCE they were on. The block map is keyed by `num`, so
     the anchor is just that num, re-resolved to a time against the NEW map once it exists.
     Owner, 2026-08-25: "It shouldn't always send you right back to 0:00 so then you have to
     nav 12 sentences forward or whatever."
     Set on every invalidation that had a live position; consumed exactly once, by
     dynEnsureMainSrc(); cleared by anything that makes it meaningless (a mode switch is a
     different TRACK, a chain hop is a different UNIT, and the end of a session is a deliberate
     start-over). */
  var dynResumeNum = null;
  var dynAutoResume = false;    // an auto-rebuild is pending or in flight: keep the intent to play
  var dynAutoSeq = 0;           // only the NEWEST auto-rebuild may assign mainAudio.src
  /* r26a: AUTOPLAY has to hop BEFORE the track ends. The lock-screen hop works now because the
     element is still playing when we swap, which keeps the audio session active and lets
     WebKit load the next source in the background. Waiting for 'ended' throws that away: the
     element has already stopped, the session is inactive, and the load stalls until you unlock
     — the exact failure the pause used to cause. So pre-advance a fraction before the end.
     What is skipped is the tail of the session's final 3-second gap pause, i.e. silence. */
  var DYN_PREADVANCE_S = 0.45;
  var dynPreAdvanced = false;
  /* ⚠⚠ AND REPEAT NEEDS THE SAME TREATMENT, FOR THE SAME REASON (owner, 2026-08-23: on the
     Android app with the screen locked "the topic actually just came to a stop instead of
     repeating"). Read the r26a note above and the fault is already described there: waiting for
     `ended` means the element has ALREADY STOPPED, and a JS handler then has to seek and press
     play into a stopped audio session from a backgrounded WebView. Autoplay was given a hop that
     happens WHILE THE ELEMENT IS STILL PLAYING; repeat was left on `ended` and was explicitly
     excluded from the pre-advance (`!repeatOn`), so it kept the bug autoplay had been cured of.
     Looping is the easier half — the source does not change, so all that is needed is a seek to 0
     a fraction before the end, which never lets the session go inactive at all. */
  var dynPreLooped = false;
  /* What, if anything, should happen because we are in the last fraction of the track? Pure and
     named so it can be tested without a media element — the old form was four lines of condition
     inline in the timeupdate handler, which is why the repeat case could sit wrong in it unseen.
     ⚠ REPEAT WINS OVER AUTOPLAY, matching the `ended` handler and r136's mutual-exclusion rule.
     ⚠ THE GUARDS ARE TIGHT ON PURPOSE. While a new source loads, iOS can report a transient or
     tiny duration, so a loose "near the end" test fires straight after a MANUAL hop and skids on
     to the next unit — which reads as prev/next being broken. A real session runs minutes. */
  function mainTailAction(t, dur, paused, opts) {
    opts = opts || {};
    if (paused || !dur || !isFinite(dur) || dur <= 20) return null;
    if (!(t > dur * 0.9)) return null;
    if ((dur - t) > DYN_PREADVANCE_S) return null;
    if (opts.repeat) return 'loop';
    if (opts.dyn && opts.autoplay) return 'advance';
    return null;
  }
  var dynSessionIsLocal = true; // does dynSession belong to THIS page's sentences? (card highlight guard)
  var dynAdopted = null;      // the CHAIN entry the top player is currently on when it isn't home (null = home)
  // ── round-11: the CHAIN replaces the pairwise dynNav adopt/navigate model ──
  // cfg.dynChain = ordered units of the whole space ({page, prefix, tier, name, dynKey});
  // transport/lock-screen prev/next ONLY ever moves an index pointer and swaps audio in
  // place — never location.href. Footer links remain the way to change pages.
  var dynChain = null, dynHomeIdx = 0, dynChainIdx = 0, dynChainWrap = false, dynTitle = null;
  var dynChainWrapDerived = false;   // set true only by the topics.js-derived fallback below
  /* rollout P1 item D4 — LAZY resolution (round-13 follow-up to the original synchronous-only
     version). resolveDynChain() is now the ONE place dynChain/dynHomeIdx/dynChainIdx/
     dynChainWrap/dynTitle get computed, and it is idempotent/cheap to call repeatedly: an
     already-resolved chain (this page's own explicit array, the legacy dynNav synthesis, or a
     chain already derived on an earlier call) short-circuits on the first line and does no
     recomputation. Three sources, tried in order, exactly as before:
       1. explicit cfg.dynChain (every current test page) — resolves synchronously, first call.
       2. legacy cfg.dynNav synthesis (round-12 deploy-skew net) — also synchronous, first call.
       3. D4: derived from topics.js's own live sequence, for a page shipping DYN with neither of
          the above. Shape matches the test pages' own inline arrays exactly (topic-test.html's
          window.ThaiEarTopic.dynChain: {page, prefix, tier, name, dynKey}) — dynKey is the bare
          page id (no .html, mirroring topics.js's own bare()), tier is topics.js's accessFor(),
          prefix is the unit's audio handle. Playlists (!PLMODE required) and pages topics.js
          doesn't recognise never populate a chain via this source.
     Sources 1 and 2 need no retry — they come straight off cfg and always resolve on the very
     first call, so THAT path is byte-for-byte the same outcome and timing as before this round.
     Source 3 is the one that can miss on a cold load: player.js's <script> tag precedes
     topics.js's on every page that ships both (verified across the live topic-*.html pages), and
     defer scripts execute strictly in tag order, so window.ThaiEarTopics is typically NOT yet
     populated the first time resolveDynChain() runs (the same gap resolveMainTitle's own comment
     documents for a different symptom) — hence "if available", not forced.
     Callers: resolved once synchronously right below (preserves exact timing for sources 1/2).
     Re-attempted on DOMContentLoaded (guaranteed after topics.js — both scripts are deferred, so
     DOMContentLoaded fires only once every deferred script has run), which also re-runs
     dynPrefetchNeighbours() — the one EAGER side effect (iPhone lock-screen neighbour pre-resolve)
     that fires at mount time, before that retry can land. Also re-attempted, as a first-use safety
     net, at the top of every consumer that can run before DOMContentLoaded in principle
     (writeNowPlaying, syncToPlayingTrack's DYN branch, dynPrefetchNeighbours itself, advanceTopic's
     DYN branch) — everything else (dynChainStep, dynChainPlayable, dynReturnLocal,
     dynApplyAdoptState/dynAdvance's revert branch, setupMediaSession's dynTitle read) runs strictly
     downstream of one of those, after a chain is already known one way or the other, so needs no
     separate call. */
  function resolveDynChain() {
    if (dynChain) return true;                     // already resolved (any source) — nothing to do
    if (!DYN) return false;
    if (Array.isArray(cfg.dynChain) && cfg.dynChain.length) {
      dynChain = cfg.dynChain;
    } else if (cfg.dynNav && (cfg.dynNav.prev || cfg.dynNav.next)) {
      // Deploy-skew safety net (round-12): the r11 topic-page regression was HTML still shipping
      // the old pairwise dynNav while player.js only understood dynChain — prev/next went dead.
      // A stale page gets its chain SYNTHESIZED from dynNav so nav keeps working either way.
      var _ownName = (document.title || 'ThaiEar')
        .replace(/^Dynamic player test\s*[—–-]\s*/i, '')
        .replace(/\s*[|·—–-]\s*ThaiEar.*$/i, '').trim() || 'This topic';
      var _synth = [];
      if (cfg.dynNav.prev) _synth.push(cfg.dynNav.prev);
      _synth.push({ page: PAGE_FILE, prefix: PREFIX || '', tier: TIER || 'free', name: _ownName, dynKey: cfg.dynKey || '__self__' });
      if (cfg.dynNav.next) _synth.push(cfg.dynNav.next);
      dynChain = _synth;
    } else if (!PLMODE && window.ThaiEarTopics && window.ThaiEarTopics.liveSequence &&
               window.ThaiEarTopics.pageUnit && window.ThaiEarTopics.accessFor) {
      try {
        if (window.ThaiEarTopics.pageUnit(PAGE_FILE)) {   // this page IS a live, playable unit
          var _seq = window.ThaiEarTopics.liveSequence();
          var _derived = _seq.map(function (u) {
            return { page: u.page, prefix: u.audio, tier: window.ThaiEarTopics.accessFor(u), name: u.name,
              dynKey: String(u.page || '').replace(/\.html$/i, '') };
          });
          if (_derived.length > 1) { dynChain = _derived; dynChainWrapDerived = true; }
        }
      } catch (_) {}
    }
    if (!dynChain) return false;
    var _pageBareForHome = PAGE_FILE.replace(/\.html$/i, '');
    for (var _ci = 0; _ci < dynChain.length; _ci++) {
      var _dcE = dynChain[_ci];
      if (!_dcE) continue;
      var _dcIsHome = (_dcE.dynKey === cfg.dynKey || _dcE.dynKey === '__self__') ||
        // Derived-chain entries carry no cfg.dynKey to match against — fall back to comparing the
        // entry's own page to this page's filename, bare of any .html either side.
        (cfg.dynKey == null && String(_dcE.page || '').toLowerCase().replace(/\.html$/i, '') === _pageBareForHome);
      if (_dcIsHome) { dynHomeIdx = _ci; break; }
    }
    dynChainIdx = dynHomeIdx;        // pointer = the unit the top player is CURRENTLY on
    dynChainWrap = (cfg.dynChainWrap === true) || dynChainWrapDerived;   // playlists: circular; topic test pages: clamp; derived: circular
    dynTitle = dynChain[dynHomeIdx] ? dynChain[dynHomeIdx].name : null;   // lock-screen title = the unit actually playing
    return true;
  }
  resolveDynChain();   // synchronous attempt — resolves sources 1/2 immediately, exactly as this
                        // file always has; only source 3 (derived) may need the retry below.
  // D4 lazy fallback: only source 3 can still be pending here (sources 1/2 either resolved just
  // above or never apply on this page). document.readyState can only be 'loading' or 'interactive'
  // at this point — never 'complete' — because this line runs synchronously inside player.js's own
  // deferred execution, which (being itself deferred) always finishes before DOMContentLoaded
  // fires; registering the listener here is therefore always in time.
  if (!dynChain && DYN && !PLMODE) {
    document.addEventListener('DOMContentLoaded', function () {
      if (resolveDynChain()) dynPrefetchNeighbours();   // backfill the one eager side effect that ran too early
    });
  }
  var dynAttached = false;             // adopted a live native track via attach() — src must not be rebuilt under it
  var dynStdRemote = false;   // adopted target is playing its STATIC combined file (no session/map)
  var DYN_KEY_NS = cfg.dynKey || PREFIX;   // namespace for exclusions + persisted sessions

  /* -- session persistence (per topic, per mode) --
     A successfully built session is stored so a revisit (or the neighbour test page) doesn't
     reconstruct: audio in the durable 'thaiear-audio-dl' Cache Storage cache on web, or a
     per-topic WAV in the app CACHE dir on native; {key,map,duration} metadata in localStorage.
     Stale entries are never deleted eagerly — a key mismatch just misses and rebuilds. */
  function dynMetaLsKey(dk, mode) { return 'te_dyn_meta_' + dk + '_' + mode; }
  // r17: the extension travels with the session (sessions are no longer always WAV). Metas
  // written before r17 carry no ext and legitimately point at a .wav — hence the default,
  // which is what keeps every session already on a device playable after the upgrade.
  function dynCachePath(dk, mode, ext) { return '/dyn/' + dk + '/' + mode + '.' + (ext || 'wav'); }
  // Native WAV filenames are UNIQUE PER BUILD (persisted counter): the native shim resumes
  // instead of re-preparing when src is unchanged, so rebuilding under the SAME file:// path
  // made the app keep playing the OLD audio after an exclusion. The meta records the actual
  // filename; the superseded file is deleted after a successful persist.
  function dynNextSeq() {
    var n = 1;
    try { n = (parseInt(localStorage.getItem('te_dyn_seq'), 10) || 0) + 1; localStorage.setItem('te_dyn_seq', String(n)); } catch (_) {}
    return n;
  }
  function dynNativeFile(dk, mode, seq, ext) { return 'dyn-' + dk + '-' + mode + (seq ? '-' + seq : '') + '.' + (ext || 'wav'); }
  function dynReadMeta(dk, mode) {
    try {
      var m = JSON.parse(localStorage.getItem(dynMetaLsKey(dk, mode)) || 'null');
      if (m && m.key && m.map && m.map.length && m.duration) return m;
    } catch (_) {}
    return null;
  }
  function dynPersistSession(sess, mode) { dynPersistSessionFor(sess, mode, DYN_KEY_NS); }
  function dynPersistSessionFor(sess, mode, keyNs) {
    var oldMeta = dynReadMeta(keyNs, mode);   // read BEFORE overwriting: we sweep its file below
    try {
      localStorage.setItem(dynMetaLsKey(keyNs, mode),
        JSON.stringify({ key: sess.key, map: sess.map, duration: sess.duration, file: sess.file || null,
          ext: sess.ext || 'wav', mime: sess.mime || 'audio/wav', bytes: (sess.blob && sess.blob.size) || 0, at: Date.now() }));
    } catch (_) {}
    if (NATIVE) {
      // The WAV was already written (unique per-build name) during the build; delete the
      // superseded build's file so the cache dir doesn't accumulate. Errors ignored.
      var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (FS && oldMeta && oldMeta.file && oldMeta.file !== sess.file) {
        try { FS.deleteFile({ path: oldMeta.file, directory: 'DATA' }).catch(function () {}); } catch (_) {}
      }
      dynSweepSessions(keyNs, mode);
      return;
    }
    if (window.caches) {
      caches.open(AUDIO_DL_CACHE).then(function (c) {
        // A format change leaves the old extension's entry orphaned — drop it, or the cache
        // keeps a 20 MB WAV alongside its 1 MB replacement forever.
        if (oldMeta && (oldMeta.ext || 'wav') !== (sess.ext || 'wav')) {
          c.delete(dynCachePath(keyNs, mode, oldMeta.ext)).catch(function () {});
        }
        return c.put(dynCachePath(keyNs, mode, sess.ext),
          new Response(sess.blob, { headers: { 'Content-Type': sess.mime || 'audio/wav' } }));
      }).then(function () { dynSweepSessions(keyNs, mode); }).catch(function () {});
    }
  }
  /* r17: bounded session storage. Until now every session a device ever built was kept
     forever — one per {unit, mode}, superseded builds swept but nothing else — so playing
     through the catalogue accumulated ~20 MB a time with no ceiling. Encoded sessions make
     that a non-problem in practice (~1 MB each), but "in practice" is not a guarantee, so
     this is the backstop. It sweeps oldest-first and evicts pre-r17 WAVs BEFORE anything
     else: they are ~20× the size of their replacement, so the space reclaims itself as the
     app is used, with nothing lost that can't be rebuilt in a couple of seconds. */
  var DYN_CACHE_CAP = 400 * 1024 * 1024;
  function dynEvictSession(it) {
    try { localStorage.removeItem(it.lsKey); } catch (_) {}
    if (NATIVE) {
      var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (FS && it.file) { try { FS.deleteFile({ path: it.file, directory: 'DATA' }).catch(function () {}); } catch (_) {} }
      return;
    }
    if (window.caches) {
      caches.open(AUDIO_DL_CACHE)
        .then(function (c) { return c.delete(dynCachePath(it.ns, it.mode, it.ext)); })
        .catch(function () {});
    }
  }
  function dynSweepSessions(keepNs, keepMode) {
    var items = [], i, total = 0;
    try {
      for (i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('te_dyn_meta_') !== 0) continue;
        var m = null;
        try { m = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) {}
        if (!m) continue;
        var rest = k.slice(12), us = rest.lastIndexOf('_');
        if (us < 0) continue;
        var ext = m.ext || 'wav';
        // Pre-r17 metas carry no size — a WAV's is exactly duration × 48 KB/s.
        var bytes = m.bytes || Math.round((m.duration || 0) * DYN_SR * 2);
        items.push({ lsKey: k, ns: rest.slice(0, us), mode: rest.slice(us + 1),
          bytes: bytes, at: m.at || 0, ext: ext, file: m.file || null });
        total += bytes;
      }
    } catch (_) { return; }
    if (total <= DYN_CACHE_CAP) return;
    items.sort(function (a, b) {
      var aw = (a.ext === 'wav') ? 0 : 1, bw = (b.ext === 'wav') ? 0 : 1;
      return (aw - bw) || (a.at - b.at);        // legacy WAVs first, then oldest
    });
    for (i = 0; i < items.length && total > DYN_CACHE_CAP; i++) {
      var it = items[i];
      if (it.ns === keepNs && it.mode === keepMode) continue;          // never the one just written
      if (it.ns === DYN_KEY_NS && it.mode === currentMode) continue;   // nor the one in play
      dynEvictSession(it);
      total -= it.bytes;
      dynLog('sweep: evicted ' + it.ns + '/' + it.mode + ' (' + Math.round(it.bytes / 1048576) + ' MB)');
    }
  }
  /* r17a: ORPHAN SWEEP. A rebuild REPLACES rather than adds — the web cache key is stable
     (same path, cache.put overwrites) and the native path deletes the superseded file right
     after persisting. But the native write happens during the BUILD and the delete during the
     PERSIST, so an app kill between the two strands a file that nothing references and nothing
     would ever remove. Same for a web entry whose extension changed while the tab died. So:
     once per page, list what's actually stored, and delete anything no current meta claims.
     Cheap, and it can only ever remove a file that is already unreachable. */
  function dynReferencedFiles() {
    var refs = {}, i;
    try {
      for (i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('te_dyn_meta_') !== 0) continue;
        var m = null;
        try { m = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) {}
        if (!m) continue;
        if (m.file) refs[m.file] = true;                       // native filename
        var rest = k.slice(12), us = rest.lastIndexOf('_');
        if (us > 0) refs[dynCachePath(rest.slice(0, us), rest.slice(us + 1), m.ext)] = true;
      }
    } catch (_) {}
    return refs;
  }
  function dynSweepOrphans() {
    var refs = dynReferencedFiles();
    if (NATIVE) {
      var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!FS || !FS.readdir) return;
      FS.readdir({ path: '', directory: 'DATA' }).then(function (r) {
        var files = (r && r.files) || [];
        files.forEach(function (f) {
          var name = (typeof f === 'string') ? f : (f && f.name);
          if (!name || name.indexOf('dyn-') !== 0) return;     // only ever our own session files
          if (refs[name]) return;
          FS.deleteFile({ path: name, directory: 'DATA' }).catch(function () {});
          dynLog('sweep: orphan ' + name);
        });
      }).catch(function () {});
      return;
    }
    if (!window.caches) return;
    caches.open(AUDIO_DL_CACHE).then(function (c) {
      return c.keys().then(function (reqs) {
        reqs.forEach(function (req) {
          var p;
          try { p = new URL(req.url).pathname; } catch (_) { return; }
          // ONLY /dyn/ — this cache also holds downloaded topic audio, which is not ours to touch.
          if (p.indexOf('/dyn/') !== 0 || refs[p]) return;
          c.delete(req).catch(function () {});
          dynLog('sweep: orphan ' + p);
        });
      });
    }).catch(function () {});
  }
  // Rehydrate a persisted session's audio (meta comes from dynReadMeta). Resolves null on any
  // miss — evicted cache entry, missing native file — so callers fall back to building.
  function dynRestoreSession(dk, mode, meta) {
    if (NATIVE) {
      var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!FS) return Promise.resolve(null);
      // Round-7: session WAVs live in DATA (Android clears CACHE — owner lost every session).
      // Metas without a file field predate that and necessarily point at a purged CACHE file → miss.
      if (!meta.file) return Promise.resolve(null);
      var path = meta.file;
      return FS.stat({ path: path, directory: 'DATA' })
        .then(function () { return FS.getUri({ path: path, directory: 'DATA' }); })
        .then(function (r) {
          if (!r || !r.uri) return null;
          return { url: null, fileUri: r.uri, blob: null, map: meta.map, key: meta.key,
            duration: meta.duration, file: meta.file, ext: meta.ext || 'wav', mime: meta.mime || 'audio/wav' };
        }).catch(function () { return null; });
    }
    if (!window.caches) return Promise.resolve(null);
    return caches.open(AUDIO_DL_CACHE)
      .then(function (c) { return c.match(dynCachePath(dk, mode, meta.ext)); })
      .then(function (res) { return res ? res.blob() : null; })
      .then(function (blob) {
        if (!blob) return null;
        return { url: URL.createObjectURL(blob), blob: blob, map: meta.map, key: meta.key,
          duration: meta.duration, ext: meta.ext || 'wav', mime: meta.mime || 'audio/wav' };
      }).catch(function () { return null; });
  }

  // Pause lengths are derived from a crude syllable estimate of the Thai (len/3 after
  // stripping the pause markers, whitespace and the zero-ish chars ๆ ็ ์).
  function dynSyllables(thai) {
    var t = String(thai || '').replace(/\|/g, '').replace(/\s+/g, '').replace(/[ๆ็์]/g, '');
    return Math.max(1, Math.floor(t.length / 3));
  }
  function dynIncluded() {
    // Playlists have no exclusion UI (round-11) — play everything the visitor is ENTITLED to.
    // Filtering locked sentences out HERE is what makes "skip the denied ones and stitch the
    // rest" the normal path rather than an error path: their clips are never requested, so the
    // build never sees a 402 at all.
    /* …and, offline, the ones whose clips are not on the device (Part B, 2026-08-09). Filtering
       here is what makes "stitch the rest" the NORMAL path rather than an error path — their clips
       are never requested, so the build never sees a failure at all, exactly as with locked rows. */
    if (PLMODE) return sentences.filter(function (s) { return !sentLocked(s) && !sentNoDl(s); });
    return sentences.filter(function (s) { return !dynExcluded[s.num]; });
  }
  function dynKey() {
    // English is EFFECTIVE-value keyed: ET always includes English, so toggling the TE-only
    // checkbox must not churn ET sessions.
    // Topic pages key on the sentence nums (unchanged — existing persisted metas stay valid).
    // Playlist sentences key on prefix:clipNum — their s.num is a synthetic page index, and an
    // equal-length edit must still change the key (cross-device staleness test).
    return dynKeyFor(dynIncluded());
  }
  // st (r16) = the settings the session is/was built with; defaults to this page's own.
  function dynKeyFor(sents, st) {
    st = st || dynCurrentSet();
    var epEff = (st.ep >= 1 && st.ep <= st.rp) ? st.ep : st.rp;
    var en = (currentMode === 'et' || st.en) ? 1 : 0;
    // English-position token appears ONLY when it actually shapes the audio (TE + English on +
    // ≥2 repeats + not at the default end position) — so irrelevant toggles never churn keys
    // AND every pre-r15 persisted session stays valid (no migration wipe).
    var ep = (currentMode !== 'et' && st.en && st.rp > 1 && epEff !== st.rp) ? epEff : 0;
    return currentMode + '|' + st.pf + '|r' + st.rp + '|e' + en + (ep ? '|p' + ep : '') + '|' + sents.map(function (s) {
      return s.prefix ? (s.prefix + ':' + (s.clipNum != null ? s.clipNum : s.num)) : s.num;
    }).join(',');
  }
  // Clip reference for a sentence: playlists carry per-sentence prefix/tier (a playlist mixes
  // topics) and a clipNum (the real spreadsheet num — s.num is a synthetic page-unique id
  // there); topic pages keep the page-level PREFIX/GATED exactly as before.
  function dynClipRef(s, side) {
    var pfx = (s.prefix ? s.prefix : PREFIX);
    /* ⚠ A PLAYLIST SENTENCE'S TIER IS RESOLVED LIVE (2026-08-13) — see liveTierFor(). The saved
       snapshot routes to the wrong BUCKET after a tier change and 404s on every clip. */
    var sTier = (s.tier != null) ? (liveTierFor(s.prefix) || s.tier) : null;
    var tier = (sTier != null) ? sTier : TIER;
    var gated = (sTier != null) ? (sTier === 'member' || sTier === 'premium') : GATED;
    var n = (s.clipNum != null) ? s.clipNum : s.num;
    return { file: pfx + '_S' + String(n).padStart(2, '0') + '_' + side + '.mp3',
      gated: gated, prefix: pfx, tier: tier };
  }
  /* r18: resolve a clip from the OFFLINE STORE first, falling back to the network. Until now
     dynFetchClip went straight to buildUrl(), which only ever returns a remote URL — so a dyn
     session could not be built or rebuilt without a connection, even on a topic the user had
     explicitly downloaded. This is what makes a downloaded unit self-sufficient: change a
     setting on a plane and it re-stitches from the clips already on the device.
     Returns {url, temp} — temp blob: URLs are revoked by the caller once decoded. */
  /* ⚠ WHERE DID EACH CLIP ACTUALLY COME FROM? (2026-07-31.) The owner demonstrated FULL dynamic
     reconstruction — different lengths, pauses and repeat counts, i.e. genuinely re-stitched from
     clips — on a topic whose manifest and Filesystem both said 10 of 50 clips present. A stored
     session cannot do that. So the other 40 are reachable from somewhere neither the manifest nor
     `offline/<prefix>/` knows about, and guessing has failed repeatedly. Count the sources. */
  var dynSrcTally = null;
  function dynTallyReset() { dynSrcTally = { mem: 0, local: 0, cache: 0, net: 0 }; }
  function dynTally(kind) { if (dynSrcTally) dynSrcTally[kind] = (dynSrcTally[kind] || 0) + 1; }
  function dynClipUrl(ref) {
    var entitled = canUseOffline(ref.tier);
    if (OFFLINE && isDownloaded(ref.prefix) && entitled) {
      return localBlobUrl(ref.prefix, ref.file)
        .then(function (u) { if (u) { dynTally('local'); return { url: u, temp: true }; } dynTally('net'); return buildUrl(ref.file, ref.gated).then(function (r) { return { url: r, temp: false }; }); });
    }
    if (DYN_WEB_DL && isDownloaded(ref.prefix) && entitled) {
      return cachedBlobUrl(ref.prefix, ref.file)
        .then(function (u) { if (u) { dynTally('cache'); return { url: u, temp: true }; } dynTally('net'); return buildUrl(ref.file, ref.gated).then(function (r) { return { url: r, temp: false }; }); });
    }
    dynTally('net');
    return buildUrl(ref.file, ref.gated).then(function (r) { return { url: r, temp: false }; });
  }
  // Bounded-concurrency runner: Safari throttles huge parallel fetch bursts (the iOS
  // 2-minute-build culprit), so clip fetches — and the /api/audio URL mints inside them —
  // run at most DYN_POOL at a time instead of one unbounded Promise.all.
  var DYN_POOL = 6;
  function dynPool(items, worker) {
    var i = 0, results = new Array(items.length);
    function lane() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return worker(items[idx], idx).then(function (r) { results[idx] = r; return lane(); });
    }
    var lanes = [];
    for (var l = 0; l < Math.min(DYN_POOL, items.length); l++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return results; });
  }
  // Fetch + decode one clip to a mono 24 kHz AudioBuffer (decodeAudioData resamples to the
  // OfflineAudioContext's rate). Decoded buffers are cached for the life of the page.
  function dynFetchClip(ref) {
    var file = ref.file, temp = null;
    if (dynClipCache[file]) { dynTally('mem'); return Promise.resolve(dynClipCache[file]); }
    function fetchDecode(url, bustHttpCache) {
      return fetch(url, bustHttpCache ? { cache: 'reload' } : undefined).then(function (r) {
        if (!r.ok) return Promise.reject({ code: r.status });
        return r.arrayBuffer();
      }).then(function (ab) {
        /* Keep the raw bytes for the sentence player (2026-08-19). The build has just paid for
           this clip; without this the very next tap on that sentence fetched the same 10 KB again
           over two round trips. Only _TH clips - those are the ones a tap plays.
           TWO ordering rules, and they pull in opposite directions:
             1. the COPY must be taken BEFORE decodeAudioData, which DETACHES the ArrayBuffer;
             2. it may only be COMMITTED after the decode SUCCEEDS. r123/r124 exist because a
                truncated clip decodes to an error and is then re-fetched; caching the bytes up
                front would store the corrupt copy, and the `!sentBlobs[file]` guard would stop
                the good retry from ever replacing it — every later tap on that sentence would
                play the damaged clip, which is r123's bug wearing our own coat. */
        var keep = null;
        if (/_TH\.mp3$/.test(file) && !sentBlobs[file] && sentBlobBytes < PREWARM_MAX_BYTES) {
          try { keep = new Blob([ab]); } catch (_) { keep = null; }
        }
        if (temp) { try { URL.revokeObjectURL(temp); } catch (_) {} temp = null; }
        return new Promise(function (res, rej) {
          var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
          var ctx = new OAC(1, 1, DYN_SR);
          ctx.decodeAudioData(ab, res, rej);
        }).then(function (buf) {
          if (keep && !sentBlobs[file]) { sentBlobs[file] = keep; sentBlobBytes += keep.size; }
          return buf;
        });
      });
    }
    return dynClipUrl(ref).then(function (u) {
      if (u.temp) temp = u.url;
      var wasLocal = u.temp;
      return fetchDecode(u.url).catch(function (e) {
        /* r123 — SELF-HEAL A CORRUPT LOCAL CLIP. A truncated/damaged stored file (e.g. a partial
           write from an interrupted native downloadFile) fails decodeAudioData here, and before
           this catch the whole build died with "Couldn't load the audio — check your connection"
           — on a fine connection, forever, because the manifest kept claiming the file and the
           skip logic kept trusting the manifest (owner hit exactly this on Greetings, 2026-08-02).
           When the bad bytes came from LOCAL storage and we are online: drop the file from the
           manifest entry (ownership arithmetic then honestly reads PARTIAL → the bar offers
           "⟳ Download audio update?" and an Update re-fetches it), best-effort delete the bad
           file, and take the network copy for THIS build so playback just works. Offline, or if
           the network copy itself is bad, fail exactly as before. */
        if (!navigator.onLine) return Promise.reject(e);
        /* r124 — AND THE HTTP-CACHE TWIN (the case the owner actually hit on Greetings): a
           truncated 200 cached by the WebView's ordinary HTTP cache during a flaky network gets
           re-served on every streaming build — free-topic clip URLs are stable, so the poison
           sticks until the user clears the app cache (deleting the download can't reach it).
           Decode-fail on a NETWORK-sourced clip → one retry with cache:'reload', which bypasses
           and overwrites the poisoned entry. */
        if (!wasLocal) {
          dynTally('heal');
          return buildUrl(ref.file, ref.gated).then(function (u2) { return fetchDecode(u2, true); });
        }
        if (temp) { try { URL.revokeObjectURL(temp); } catch (_) {} temp = null; }
        try {
          var m = getManifest(), ent = m[ref.prefix];
          if (ent && ent.files) {
            var ix = ent.files.indexOf(file);
            if (ix >= 0) { ent.files.splice(ix, 1); delete ent.bytes; setManifest(m); }
          }
          if (OFFLINE) {
            Filesystem.deleteFile({ path: offlineDir(ref.prefix) + '/' + file, directory: 'DATA' }).catch(function () {});
          } else if (CACHES) {
            caches.open(AUDIO_DL_CACHE).then(function (c) { c.delete(webCacheKey(ref.prefix, file)).catch(function () {}); }).catch(function () {});
          }
        } catch (_) {}
        dynTally('heal');
        return buildUrl(ref.file, ref.gated).then(fetchDecode);
      });
    }).then(function (buf) { dynClipCache[file] = buf; return buf; })
      .catch(function (e) {
        if (temp) { try { URL.revokeObjectURL(temp); } catch (_) {} }
        return Promise.reject(e);
      });
  }
  /* ══ r17: SESSION ENCODING ═══════════════════════════════════════════════════════════
     A stitched session used to be stored as raw PCM: 48 KB/s, so 7:12 of audio came to
     19.79 MB — 19× the mp3 of the same audio, and more than half of it silence. Encoding it
     takes that to ~1 MB. Measured on real devices (see DYNAMIC_PLAYER_PLAN.md § SESSION
     ENCODING and `live/dyn-probe.html`, from which these muxers are lifted verbatim after
     being validated against ffmpeg output):

       Chromium / Android   Opus in Ogg   0.69 MB  −96.5%   exact duration   Media3 ✓
       WebKit / iOS         AAC in MP4    1.05 MB  −94.7%   exact duration

     NO single format works on both, and the traps are not guessable:
       · Chromium CANNOT ENCODE AAC in any configuration (it decodes it happily — encoder
         support is a different question, and `isConfigSupported` is the only honest answer).
       · WebKit rejects aac:{format:'adts'}, and raw ADTS reports its duration 37 s SHORT
         (the audio is intact — a raw stream simply carries no index).
       · WebKit CAN encode Opus and it is smaller — but its reported duration comes out
         +10.1 s, which would wreck snap scrubbing and ① skip. So "prefer the smallest" is
         the wrong rule, and decodeAudioData alone would have PASSED it: the round-trip was
         exact. Only the <audio> element's REPORTED duration catches it, which is why that
         is what dynVerifyFormat checks.
       · WebKit's decoderConfig.description is a 39-byte full ES_Descriptor (Apple's 3-byte
         extended lengths), not the 2–5 byte AudioSpecificConfig Chromium returns. Wrapping
         it in another descriptor yields an undecodable MP4 — hence dynExtractAsc.

     So: try in preference order, VERIFY each by reported duration, use the first that passes,
     and remember the winner per device. No platform sniffing — every device self-selects, and
     one that behaves unlike both of ours still lands somewhere correct. WAV remains the final
     tier, so the worst case is exactly the old behaviour. */
  var DYN_FMT_KEY = 'te_dyn_fmt';        // cached per-device winner: 'mp4' | 'ogg' | 'wav'
  function dynU32(n) { var a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; }
  function dynU16(n) { var a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n); return a; }
  function dynU32le(n) { var a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0, true); return a; }
  function dynStr4(s) { var a = new Uint8Array(4); for (var i = 0; i < 4; i++) a[i] = s.charCodeAt(i); return a; }
  function dynStrBytes(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function dynCat(list) {
    var len = 0, i;
    for (i = 0; i < list.length; i++) len += list[i].length;
    var out = new Uint8Array(len), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }
  function dynBox(type, parts) { var b = dynCat(parts); return dynCat([dynU32(b.length + 8), dynStr4(type), b]); }
  function dynZeros(n) { return new Uint8Array(n); }
  var DYN_MATRIX = dynCat([dynU32(0x00010000), dynU32(0), dynU32(0), dynU32(0), dynU32(0x00010000),
    dynU32(0), dynU32(0), dynU32(0), dynU32(0x40000000)]);

  // Normalise an encoder "description" to a bare AudioSpecificConfig (see trap 4 above).
  function dynExtractAsc(desc) {
    if (!desc || !desc.length) return null;
    if (desc[0] !== 0x03) return desc;                  // Chromium already gives a bare ASC
    var i = 1;
    function readLen() { var b, len = 0, n = 0; do { b = desc[i++]; len = (len << 7) | (b & 0x7F); n++; } while ((b & 0x80) && n < 4); return len; }
    readLen(); i += 2;
    var flags = desc[i++];
    if (flags & 0x80) i += 2;
    if (flags & 0x40) { i += 1 + desc[i]; }
    if (flags & 0x20) i += 2;
    if (desc[i] !== 0x04) return null;
    i++; readLen(); i += 13;
    if (desc[i] !== 0x05) return null;
    i++;
    var ascLen = readLen();
    return desc.subarray(i, i + ascLen);
  }
  function dynEsds(asc, avgBitrate) {
    var dsi = dynCat([new Uint8Array([0x05, asc.length]), asc]);
    var dcdBody = dynCat([new Uint8Array([0x40, 0x15]), new Uint8Array([0, 0, 0]),
      dynU32(avgBitrate), dynU32(avgBitrate), dsi]);
    var dcd = dynCat([new Uint8Array([0x04, dcdBody.length]), dcdBody]);
    var esBody = dynCat([dynU16(1), new Uint8Array([0x00]), dcd, new Uint8Array([0x06, 0x01, 0x02])]);
    return dynBox('esds', [dynU32(0), dynCat([new Uint8Array([0x03, esBody.length]), esBody])]);
  }
  // Non-fragmented MP4, laid out ftyp · mdat · moov so the single chunk offset is known
  // before moov is built. The stts/stsz/stco sample table is what gives exact seeking.
  function dynMuxMp4(frames, rawDesc, sampleRate, samplesPerFrame, avgBitrate) {
    var asc = dynExtractAsc(rawDesc);
    if (!asc || !asc.length) return null;
    var n = frames.length, duration = n * samplesPerFrame;
    var mdatData = dynCat(frames);
    var ftyp = dynBox('ftyp', [dynStr4('M4A '), dynU32(0x200), dynStr4('M4A '), dynStr4('mp42'), dynStr4('isom')]);
    var mdat = dynCat([dynU32(mdatData.length + 8), dynStr4('mdat'), mdatData]);
    var chunkOffset = ftyp.length + 8;
    var mvhd = dynBox('mvhd', [dynU32(0), dynU32(0), dynU32(0), dynU32(sampleRate), dynU32(duration),
      dynU32(0x00010000), dynU16(0x0100), dynZeros(2), dynZeros(8), DYN_MATRIX, dynZeros(24), dynU32(2)]);
    var tkhd = dynBox('tkhd', [new Uint8Array([0, 0, 0, 7]), dynU32(0), dynU32(0), dynU32(1), dynU32(0),
      dynU32(duration), dynZeros(8), dynU16(0), dynU16(0), dynU16(0x0100), dynZeros(2), DYN_MATRIX, dynU32(0), dynU32(0)]);
    var mdhd = dynBox('mdhd', [dynU32(0), dynU32(0), dynU32(0), dynU32(sampleRate), dynU32(duration), dynU16(0x55C4), dynU16(0)]);
    var hdlr = dynBox('hdlr', [dynU32(0), dynU32(0), dynStr4('soun'), dynZeros(12),
      new Uint8Array([0x53, 0x6F, 0x75, 0x6E, 0x64, 0x48, 0x61, 0x6E, 0x64, 0x6C, 0x65, 0x72, 0x00])]);
    var dinf = dynBox('dinf', [dynBox('dref', [dynU32(0), dynU32(1), dynBox('url ', [new Uint8Array([0, 0, 0, 1])])])]);
    var mp4a = dynBox('mp4a', [dynZeros(6), dynU16(1), dynZeros(8), dynU16(1), dynU16(16), dynU16(0), dynU16(0),
      dynU32(sampleRate << 16), dynEsds(asc, avgBitrate)]);
    var sizes = [dynU32(0), dynU32(0), dynU32(n)];
    for (var i = 0; i < n; i++) sizes.push(dynU32(frames[i].length));
    var stbl = dynBox('stbl', [
      dynBox('stsd', [dynU32(0), dynU32(1), mp4a]),
      dynBox('stts', [dynU32(0), dynU32(1), dynU32(n), dynU32(samplesPerFrame)]),
      dynBox('stsc', [dynU32(0), dynU32(1), dynU32(1), dynU32(n), dynU32(1)]),
      dynBox('stsz', sizes),
      dynBox('stco', [dynU32(0), dynU32(1), dynU32(chunkOffset)])
    ]);
    var minf = dynBox('minf', [dynBox('smhd', [dynU32(0), dynU16(0), dynU16(0)]), dinf, stbl]);
    var moov = dynBox('moov', [mvhd, dynBox('trak', [tkhd, dynBox('mdia', [mdhd, hdlr, minf])])]);
    return new Blob([ftyp, mdat, moov], { type: 'audio/mp4' });
  }
  // Ogg Opus. Granule positions are ALWAYS in 48 kHz units whatever rate we fed the encoder.
  var DYN_OGG_CRC = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var r = i << 24;
      for (var j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      t[i] = r >>> 0;
    }
    return t;
  })();
  function dynOggCrc(buf) {
    var crc = 0;
    for (var i = 0; i < buf.length; i++) crc = (((crc << 8) >>> 0) ^ DYN_OGG_CRC[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
    return crc >>> 0;
  }
  function dynOggPage(headerType, granule, serial, seq, packets) {
    var lacing = [], body = [], i;
    for (i = 0; i < packets.length; i++) {
      var L = packets[i].length;
      while (L >= 255) { lacing.push(255); L -= 255; }
      lacing.push(L);
      body.push(packets[i]);
    }
    var head = new Uint8Array(27 + lacing.length);
    head.set([0x4F, 0x67, 0x67, 0x53], 0);
    head[4] = 0; head[5] = headerType;
    var dv = new DataView(head.buffer);
    dv.setUint32(6, granule >>> 0, true);
    dv.setUint32(10, Math.floor(granule / 4294967296) >>> 0, true);
    dv.setUint32(14, serial >>> 0, true);
    dv.setUint32(18, seq >>> 0, true);
    dv.setUint32(22, 0, true);
    head[26] = lacing.length;
    head.set(lacing, 27);
    var page = dynCat([head].concat(body));
    new DataView(page.buffer).setUint32(22, dynOggCrc(page), true);
    return page;
  }
  function dynMuxOggOpus(frames, opusHead, granulePerPacket) {
    var serial = 0x54484149, pages = [], seq = 0, granule = 0, i = 0;
    pages.push(dynOggPage(0x02, 0, serial, seq++, [opusHead]));
    pages.push(dynOggPage(0x00, 0, serial, seq++,
      [dynCat([dynStrBytes('OpusTags'), dynU32le(7), dynStrBytes('ThaiEar'), dynU32le(0)])]));
    while (i < frames.length) {
      var count = Math.min(50, frames.length - i), batch = [];
      for (var k = 0; k < count; k++) batch.push(frames[i + k]);
      i += count;
      granule += count * granulePerPacket;
      pages.push(dynOggPage(i >= frames.length ? 0x04 : 0x00, granule, serial, seq++, batch));
    }
    return new Blob(pages, { type: 'audio/ogg' });
  }
  /* r18f: yield to the task queue WITHOUT setTimeout. The encoder feed has to hand control
     back so the encoder can drain, but setTimeout is clamped to ~1s in a frame the browser
     considers un-rendered — and the prebuild frame is exactly that. With ~1s per chunk a
     9-sentence playlist that should take two seconds took minutes and looked hung. A
     MessageChannel message is a real task and is NOT clamped, so it drains at full speed
     wherever it runs. (A microtask would starve the encoder's own callbacks instead.) */
  var dynYieldChan = null, dynYieldQueue = [];
  function dynYield() {
    return new Promise(function (resolve) {
      if (!dynYieldChan) {
        try {
          dynYieldChan = new MessageChannel();
          dynYieldChan.port1.onmessage = function () {
            var fn = dynYieldQueue.shift();
            if (fn) fn();
          };
        } catch (_) { dynYieldChan = false; }
      }
      if (!dynYieldChan) { setTimeout(resolve, 8); return; }   // no MessageChannel → old path
      dynYieldQueue.push(resolve);
      dynYieldChan.port2.postMessage(0);
    });
  }
  // Run AudioEncoder over the stitched samples, collecting frames + the decoder description.
  function dynEncodeFrames(cfg, samples) {
    return new Promise(function (resolve, reject) {
      var frames = [], desc = null, frameUs = 0, failed = false;
      var enc = new AudioEncoder({
        output: function (chunk, metadata) {
          if (!desc && metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
            var d = metadata.decoderConfig.description;
            desc = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
          }
          if (!frameUs && chunk.duration) frameUs = chunk.duration;
          var b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          frames.push(b);
        },
        error: function (e) { failed = true; reject(e); }
      });
      enc.configure(cfg);
      var i = 0, FRAME = cfg.sampleRate;
      (function feed() {
        if (failed) return;
        try {
          while (i < samples.length) {
            if (enc.encodeQueueSize > 8) { dynYield().then(feed); return; }
            var n = Math.min(FRAME, samples.length - i);
            var ad = new AudioData({
              format: 'f32-planar', sampleRate: cfg.sampleRate, numberOfFrames: n,
              numberOfChannels: 1, timestamp: Math.round(i / cfg.sampleRate * 1e6),
              data: samples.slice(i, i + n)
            });
            enc.encode(ad); ad.close();
            i += n;
          }
          enc.flush().then(function () {
            enc.close();
            if (!failed) resolve({ frames: frames, desc: desc, frameUs: frameUs });
          }).catch(reject);
        } catch (e) { reject(e); }
      })();
    });
  }
  // The gate every candidate must pass: does an <audio> element report the RIGHT duration?
  // That is the number the scrubber, ① skip and snap all derive from, and it is exactly what
  // caught Ogg-on-WebKit (+10.1 s) and ADTS (−37 s) when a decode round-trip did not.
  function dynVerifyFormat(blob, seconds) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob), a = new Audio(), done = false;
      function finish(ok) { if (done) return; done = true; clearTimeout(t); try { a.pause(); } catch (_) {} URL.revokeObjectURL(url); resolve(ok); }
      var t = setTimeout(function () { finish(false); }, 12000);
      a.addEventListener('error', function () { finish(false); });
      a.addEventListener('loadedmetadata', function () {
        finish(isFinite(a.duration) && Math.abs(a.duration - seconds) < 1);
      });
      a.preload = 'metadata';
      a.src = url;
      a.load();
    });
  }
  var DYN_ENC_TIERS = [
    { fmt: 'mp4', ext: 'm4a', mime: 'audio/mp4',
      cfg: function () { return { codec: 'mp4a.40.2', sampleRate: DYN_SR, numberOfChannels: 1, bitrate: 32000 }; } },
    { fmt: 'ogg', ext: 'opus', mime: 'audio/ogg',
      cfg: function () { return { codec: 'opus', sampleRate: DYN_SR, numberOfChannels: 1, bitrate: 24000 }; } }
  ];
  function dynPackage(tier, r) {
    if (tier.fmt === 'mp4') return dynMuxMp4(r.frames, r.desc, DYN_SR, 1024, 32000);
    if (!r.desc) return null;
    return dynMuxOggOpus(r.frames, r.desc, Math.round((r.frameUs || 20000) * 48000 / 1e6));
  }
  function dynWavResult(samples) {
    return { blob: dynEncodeWav(samples), ext: 'wav', mime: 'audio/wav', fmt: 'wav' };
  }
  /* The chosen format + the size it produced, shown in the test-space corner tag. This lives
     on screen rather than behind ?dbg=1 because the APP has no address bar — a debug flag you
     cannot type is a debug flag that does not exist. Test-space only; goes at rollout. */
  var dynLastEnc = null;
  var dynLastBuildMs = null;   // r19: {fetch, stitch, encode} of the most recent build
  function dynPaintFmtTag() {
    var el = $('dyn-fmt-tag');
    if (!el) return;
    var fmt = dynLastEnc && dynLastEnc.fmt;
    if (!fmt) { try { fmt = localStorage.getItem(DYN_FMT_KEY); } catch (_) {} }
    if (!fmt) { el.textContent = DYN_BUILD; return; }
    el.textContent = DYN_BUILD + ' · ' + fmt +
      (dynLastEnc && dynLastEnc.bytes ? ' · ' + (dynLastEnc.bytes / 1048576).toFixed(2) + ' MB' : '');
  }
  function dynNoteEnc(fmt, bytes) { dynLastEnc = { fmt: fmt, bytes: bytes }; dynPaintFmtTag(); }
  // Encode the session, choosing (and remembering) the best format this device can produce.
  function dynEncodeSession(samples, seconds) {
    var cached = null;
    try { cached = localStorage.getItem(DYN_FMT_KEY); } catch (_) {}
    if (cached === 'wav' || !window.AudioEncoder || !window.AudioData) {
      var w = dynWavResult(samples);
      dynNoteEnc('wav', w.blob.size);
      return Promise.resolve(w);
    }
    var tiers = DYN_ENC_TIERS.filter(function (t) { return !cached || t.fmt === cached; });
    var verified = !!cached;    // an already-chosen format was verified when it was chosen
    var idx = 0;
    function attempt() {
      if (idx >= tiers.length) {
        try { localStorage.setItem(DYN_FMT_KEY, 'wav'); } catch (_) {}
        dynLog('encode: falling back to WAV');
        var wf = dynWavResult(samples);
        dynNoteEnc('wav', wf.blob.size);
        return Promise.resolve(wf);
      }
      var tier = tiers[idx++], cfg = tier.cfg();
      return AudioEncoder.isConfigSupported(cfg)
        .then(function (s) {
          if (!s || !s.supported) return attempt();
          return dynEncodeFrames(cfg, samples).then(function (r) {
            var blob = dynPackage(tier, r);
            if (!blob) return attempt();
            if (verified) { dynNoteEnc(tier.fmt, blob.size); return { blob: blob, ext: tier.ext, mime: tier.mime, fmt: tier.fmt }; }
            return dynVerifyFormat(blob, seconds).then(function (ok) {
              if (!ok) { dynLog('encode: ' + tier.fmt + ' failed verification'); return attempt(); }
              try { localStorage.setItem(DYN_FMT_KEY, tier.fmt); } catch (_) {}
              dynLog('encode: using ' + tier.fmt + ' (' + Math.round(blob.size / 1024) + ' KB)');
              dynNoteEnc(tier.fmt, blob.size);
              return { blob: blob, ext: tier.ext, mime: tier.mime, fmt: tier.fmt };
            });
          }).catch(function () { return attempt(); });
        })
        .catch(function () { return attempt(); });
    }
    return attempt().catch(function () { return dynWavResult(samples); });
  }
  // If the NATIVE engine ever refuses a session the WebView was happy with, demote this device
  // to WAV and drop the built session so the next play re-encodes. The WebView's decoder and
  // Media3's are different codebases; only one of them is verifiable silently.
  function dynDemoteFormat(why) {
    var cur = null;
    try { cur = localStorage.getItem(DYN_FMT_KEY); } catch (_) {}
    if (cur === 'wav') return false;
    try { localStorage.setItem(DYN_FMT_KEY, 'wav'); } catch (_) {}
    dynLog('encode: DEMOTED to WAV (' + (why || 'native failure') + ')');
    try { localStorage.removeItem(dynMetaLsKey(DYN_KEY_NS, currentMode)); } catch (_) {}
    dynSession = null; mainSrcReady = false;
    return true;
  }
  // Encode mono Float32 samples as a 16-bit PCM WAV blob (standard 44-byte header).
  function dynEncodeWav(samples) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function wstr(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, DYN_SR, true); v.setUint32(28, DYN_SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wstr(36, 'data'); v.setUint32(40, n * 2, true);
    var off = 44;
    for (var i = 0; i < n; i++, off += 2) {
      var x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  // Build the stitched session for the CURRENT mode/factor/inclusion set.
  // TE per sentence: TH, repeat-pause, TH, repeat-pause, EN. ET: EN, recall-pause, TH,
  // repeat-pause, TH. Then a gap-pause. map records {num,start,end} per sentence block.
  function dynBuildSession(onProg) {
    return dynBuildSessionFor(dynIncluded(), DYN_KEY_NS, dynKey(), onProg);
  }
  // Parametrised stitcher (round-11): the chain can BUILD a FOREIGN playlist's session in
  // place (foreground only) from the local playlist cache — sents/keyNs/key come from the
  // caller instead of this page's own state.
  function dynBuildSessionFor(inc, keyNs, key, onProg, st, opts) {
    if (!inc.length) return Promise.reject({ code: 'empty' });
    var mode = currentMode;   // captured: the key/filename must match the mode this build is FOR
    st = st || dynCurrentSet();   // r16: settings are per unit — a foreign build passes ITS unit's
    var stEp = (st.ep >= 1 && st.ep <= st.rp) ? st.ep : st.rp;
    var needEn = (mode === 'et') || st.en;   // TE with English off never touches the _EN clips
    var files = [];
    inc.forEach(function (s) { files.push(dynClipRef(s, 'TH')); if (needEn) files.push(dynClipRef(s, 'EN')); });
    var done = 0;
    // r19: phase timings. "It feels slow" is not a diagnosis - these turn it into numbers,
    // and they cost nothing when the log is off.
    var tFetch0 = Date.now(), tFetch = 0, tStitch = 0, cached0 = 0;
    files.forEach(function (f) { if (dynClipCache[f.file]) cached0++; });
    /* Per-clip DENIAL must not kill the whole build. dynPool has no per-item catch, so one
       rejected lane used to reject the Promise.all and lose every other clip with it. A gate
       code (401/402/403/'licence') now drops just that sentence and the stitch carries on —
       defence in depth behind dynIncluded()'s filter, for when the SERVER disagrees with the
       client's view of entitlement (sub lapsed mid-session, tier list changed, clip missing).
       Real faults (network, decode) still reject, and an all-denied build rejects with the gate
       code so the visitor still gets the paywall/sheet rather than silence. */
    dynTallyReset();          // count where this build's clips come from (see dynSrcTally)
    var denied = {}, lastGate = null, missedOffline = 0;
    function isGateCode(c) { return c === 401 || c === 402 || c === 403 || c === 'noauth' || c === 'licence'; }
    /* LAYER 2 of the not-downloaded handling (Part B, 2026-08-09). dynIncluded() already drops the
       rows we KNOW are absent, but it can only act when navigator.onLine admits to being offline —
       and in this WebView it reports *online* in airplane mode. So a clip can still fail here as a
       plain network error, which used to re-throw and kill the entire build: the owner's "if some
       of the playlist is not downloaded, the entire playlist won't play".
       A network failure on a PLAYLIST clip is therefore skippable in the same way a gate denial is,
       and tracked separately so the caller can say "not downloaded" rather than "premium".
       ⚠ PLMODE ONLY. On a topic page a network error still re-throws — one missing clip there means
       a broken or half-finished download, which should surface, not be silently stitched around. */
    function isMissingOffline(e) {
      if (!PLMODE) return false;
      var c = e && e.code;
      if (isGateCode(c)) return false;             // a denial is a denial, not an absence
      return true;                                 // network/decode failure on a playlist clip
    }
    return dynPool(files, function (f) {
      return dynFetchClip(f).then(function (b) { done++; if (onProg) onProg(done, files.length); return b; })
        .catch(function (e) {
          var gated = isGateCode(e && e.code);
          if (!gated && !isMissingOffline(e)) throw e;
          denied[f.prefix + '|' + f.file.replace(/_(TH|EN)\.mp3$/, '')] = true;
          /* Remember the MEASURED absence so the cards can grey too. Without this the row looked
             perfectly playable (the manifest still claims the file) while being silently absent
             from the mix — the exact mismatch layer 2 exists to catch. Covers both the lying
             navigator.onLine and a present-but-corrupt clip that r123's self-heal cannot repair
             offline. */
          if (gated) lastGate = e; else { missedOffline++; dynNoDlSeen[dynNoDlKey(f)] = true; }
          done++; if (onProg) onProg(done, files.length);
          return null;
        });
    }).then(function () {
      /* E9 INSTRUMENTATION (2026-07-31) — the owner reports the server-denial case failing both
         online and offline, and dynLog does NOT reach the boot trace, so the failure was invisible.
         T() puts the three facts that distinguish the possible causes into the trace: did ANY clip
         come back with a gate code, how many sentences survived, and was the build re-thrown.
         Instrument before theorising — every bug on this build attempted by inference first was
         solved wrong. */
      if (lastGate || missedOffline) {
        var kept = inc.filter(function (s) {
          var r = dynClipRef(s, 'TH');
          return !denied[r.prefix + '|' + r.file.replace(/_(TH|EN)\.mp3$/, '')];
        });
        /* Nothing survived. A denial still reports the gate (the visitor needs the paywall/sheet);
           otherwise every clip was simply absent, which is its own message, not a network fault. */
        if (!kept.length) { return Promise.reject(lastGate || { code: 'nodl' }); }
        if (kept.length !== inc.length) {
          dynLog('build: ' + (inc.length - kept.length) + ' sentence(s) skipped (' +
            (missedOffline ? missedOffline + ' unavailable' : '') + (lastGate ? ' denied' : '') +
            ') — stitching ' + kept.length);
          inc = kept;
        }
      }
      tFetch = Date.now() - tFetch0;
      var parts = [];   // AudioBuffer, or a number = silence length in samples
      var map = [];
      var pos = 0;      // running length in samples
      function pushBuf(b) { parts.push(b); pos += b.length; }
      function pushSil(sec) { var n = Math.round(sec * DYN_SR); parts.push(n); pos += n; }
      inc.forEach(function (s) {
        var th = dynClipCache[dynClipRef(s, 'TH').file];
        var en = needEn ? dynClipCache[dynClipRef(s, 'EN').file] : null;
        /* r147 — THE FLOOR NO LONGER SCALES (owner, 2026-08-08). It used to sit OUTSIDE the
           multiplier — `Math.max(3.0, syl*0.5) * pf` — so `pf` shrank everything uniformly and the
           spread between the shortest and longest pause stayed pinned at 5:1 wherever you put the
           slider. That is why no value felt right: turn it down far enough for a 30-syllable
           sentence and a 7-syllable one dropped to 1.75s at 0.5x (0.88s at 0.25x — "almost
           ridiculous", and correctly predicted before it shipped).
           Inside the max, the floor holds while only the proportional part shrinks, so the slider
           becomes a PROPORTIONAL→FLAT continuum: 1x fully scaled, 0.25x effectively flat. That,
           not a second control, is what "flat pauses" means here — and it is why playlists and
           topics can keep ONE model despite a playlist having the widest length spread on the site.

           The floors are measured, not chosen by feel (2,743 local clips, sampled by syllable):
           • 2.0s base — at 1x it governs syllables 1-3 ONLY, whose longest clip is 1.85s, so it
             can never deny a repeat you could actually make, and never stalls after one you
             finished. A 3.0s floor would govern up to 5 syllables (longest clip 2.66s) and idle
             ~1.2s of dead air on each. Perceived gap also runs ~0.2-0.3s longer than inserted,
             since clip edges keep Chirp's own lead-in/trail-out.
           • gap gets the SAME floor as repeat (owner: not 3s within and 1.5s between).
           • recall keeps its 1.5x ratio (was 4.5/3.0, now 3.0/2.0): ET asks you to PRODUCE the
             Thai from the English, which is a harder task than echoing what you just heard.
           No cache invalidation: `pf` is part of the session key, so a new setting builds a new
           session. An existing cached session keeps its old timing until naturally rebuilt. */
        /* ⚠ THE FLOOR RISES WITH THE SLIDER BUT NEVER FALLS BELOW ITS BASE — that is what `up` is.
           A strictly flat floor fixes the shrink side and quietly breaks the other one: at 2x a
           1-syllable sentence would go from today's 6.0s to 2.0s, and dragging 1x → 2x would do
           NOTHING for short sentences (2.00 → 2.00), a dead zone in the top half of the control.
           Only the DOWN direction was ever the complaint. `up` is inert for `gap`, whose
           proportional term (3.0*pf) always outruns 2.0*pf above 1x; it is written the same way
           for all three so the rule reads as one rule. */
        var up = Math.max(1, st.pf);
        var syl = dynSyllables(s.thai);
        var repeat = Math.max(2.0 * up, syl * 0.5 * st.pf);
        var recall = Math.max(3.0 * up, syl * 0.7 * st.pf);
        var gap = Math.max(2.0 * up, 3.0 * st.pf);
        var start = pos / DYN_SR;
        var r;
        var th0;   // absolute seconds at which the THAI first begins in this block
        /* ⚠ WHERE EVERY REPETITION STARTS, not just the first. Play counting credits ONE listen per
           repetition ACTUALLY HEARD, so it needs to know when each one begins; the alternative —
           dividing the block by the repeat count — misplaces them as soon as the English is
           inserted between two repeats, which is exactly what TE mode does. Cheap: `rp` numbers
           per block, and the block map is already persisted with the session. */
        var ths = [];
        var thLen = th.length / DYN_SR;
        if (mode === 'et') {
          pushBuf(en); pushSil(recall);
          th0 = pos / DYN_SR;          // ⚠ captured HERE — after the English and the recall gap
          ths.push(th0); pushBuf(th);
          for (r = 1; r < st.rp; r++) { pushSil(repeat); ths.push(pos / DYN_SR); pushBuf(th); }
        } else {
          // TE: English lands after the ep-th Thai repeat (round-15 item 4); ep === repeats
          // reproduces the original TH…TH,EN order exactly.
          var ep = st.en ? stEp : 0;
          ths.push(pos / DYN_SR); pushBuf(th);
          if (ep === 1) { pushSil(repeat); pushBuf(en); }
          for (r = 1; r < st.rp; r++) {
            pushSil(repeat); ths.push(pos / DYN_SR); pushBuf(th);
            if (ep === r + 1) { pushSil(repeat); pushBuf(en); }
          }
        }
        pushSil(gap);
        /* ⚠ th0 EXISTS FOR PLAY COUNTING, and only ET needs it. In Thai-first the block opens on
           the Thai, so th0 === start. In English-first the block is [English, recall gap, Thai...],
           and without this the 2-second dwell elapsed while the ENGLISH was playing — so a
           sentence counted as heard before a word of Thai had been said (owner, 2026-08-20).
           ⚠ A session built BEFORE this change has no th0 in its stored map and falls back to
           `start`, i.e. the old behaviour, until it is rebuilt (any settings change does it).
           Degrades, does not break. */
        map.push({ num: s.num, start: start, end: pos / DYN_SR, th0: (mode === 'et' ? th0 : start),
                   ths: ths, thLen: thLen });
      });
      var out = new Float32Array(pos);   // silence = the zero-filled default
      var o = 0;
      parts.forEach(function (p) {
        if (typeof p === 'number') { o += p; }
        else { out.set(p.getChannelData(0), o); o += p.length; }
      });
      var duration = pos / DYN_SR;
      tStitch = Date.now() - tFetch0 - tFetch;
      /* PCM ESCAPE HATCH (2026-08-07) — the desktop MP3 export takes the stitch and stops here,
         BEFORE dynEncodeSession. It must not reuse the stored session: that is 32 kbps AAC (or
         24 kbps Opus), and re-encoding it to MP3 would stack a second lossy generation on top of
         clips that are already MP3 from R2. Same stitch, same settings, same map — one encode
         instead of two. Nothing is persisted on this path (no meta write, no native file, no
         session object), so an export can never disturb the built session the player is using.
         `map` rides along because its block ends are the only safe MP3 lane cuts — see the
         boundaries note in mp3-export.js. */
      if (opts && opts.pcm) {
        dynLog('build ' + mode + ' ' + Math.round(duration) + 's PCM for export: fetch ' + tFetch +
               'ms (' + (files.length - cached0) + ' new/' + files.length + ') · stitch ' + tStitch + 'ms');
        return { pcm: out, duration: duration, map: map, rate: DYN_SR, key: key, mode: mode, sentences: inc };
      }
      var tEnc0 = Date.now();
      // r17: encode rather than store raw PCM (~20× smaller). Falls back to WAV on any device
      // that can't produce a verified format, so this path can never be worse than before.
      return dynEncodeSession(out, duration).then(function (enc) {
        dynLog('build ' + mode + ' ' + Math.round(duration) + 's audio: fetch ' + tFetch + 'ms (' +
          (files.length - cached0) + ' new/' + files.length + ') · stitch ' + tStitch + 'ms · encode ' +
          (Date.now() - tEnc0) + 'ms');
        dynLastBuildMs = { fetch: tFetch, stitch: tStitch, encode: Date.now() - tEnc0 };
        var blob = enc.blob;
        var sess = { url: URL.createObjectURL(blob), blob: blob, map: map, key: key,
          duration: duration, ext: enc.ext, mime: enc.mime };
        if (!NATIVE) return sess;
        // Native engine can't play a blob: URL — persist the file to app storage and hand it a URI.
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
          fr.onerror = function () { rej({ code: 'fs' }); };
          fr.readAsDataURL(blob);
        }).then(function (b64) {
          var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
          if (!FS) return sess;
          // Unique per-build filename — a rebuild must present a NEW file:// src or the native
          // shim resumes the previously prepared (stale) audio. See dynNextSeq. The extension
          // is no longer always .wav (r17), and Media3 picks its demuxer from it.
          var sessPath = dynNativeFile(keyNs, mode, dynNextSeq(), enc.ext);
          // DATA, not CACHE: Android clears the cache dir, which wiped every persisted session (round-7).
          return FS.writeFile({ path: sessPath, data: b64, directory: 'DATA' })
            .then(function () { return FS.getUri({ path: sessPath, directory: 'DATA' }); })
            .then(function (r) { sess.fileUri = (r && r.uri) || null; sess.file = sessPath; return sess; });
        });
      });
    });
  }
  // lenient (round-10 item 3): lock-family paths (return-hop, adopt) accept the LATEST LOCAL
  // persisted session even when its key is stale — never rebuild from a lock path. Foreground
  // play presses stay strict (stale key → rebuild + resave).
  function dynEnsureSession(onProg, lenient) {
    var key = dynKey();
    // .display sessions (attach-adoption hydration) carry no url/blob — they can never be a
    // src source; fall through to a real restore/build instead.
    if (dynSession && dynSessionIsLocal && !dynSession.display && (lenient || dynSession.key === key)) return Promise.resolve(dynSession);
    if (dynBuilding && dynBuilding.key === key) return dynBuilding.p;
    var mode = currentMode;
    var meta = dynReadMeta(DYN_KEY_NS, mode);
    var p = ((meta && (lenient || meta.key === key)) ? dynRestoreSession(DYN_KEY_NS, mode, meta) : Promise.resolve(null))
      .then(function (restored) {
        if (restored) { if (lenient && restored.key !== key) dynLog('lenient restore (stale key)'); return restored; }   // persisted hit → no fetch, no decode, no status line
        dynStatus('Constructing dynamic mp3 file', true);   // only a REAL build shows the status
        return dynBuildSession(onProg).then(function (sess) { dynPersistSession(sess, mode); return sess; });
      })
      .then(function (sess) {
        // Only ever revoke a LOCAL session's blob URL — an adopted session's URL lives in
        // dynAdoptCache and must survive for future re-adoption.
        if (dynSession && dynSession.url && dynSessionIsLocal && dynSession.url !== sess.url) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
        dynSession = sess;
        dynSessionIsLocal = true;
        dynStdRemote = false;
        dynBuilding = null;
        dynSyncSentBtns();
        return sess;
      }).catch(function (e) { dynBuilding = null; return Promise.reject(e); });
    dynBuilding = { key: key, p: p };
    return p;
  }
  // The DYN branch of ensureMainSrc: build (restore, or reuse) the session and point mainAudio
  // at it. When the top player has ADOPTED a neighbour topic (dyn cross-topic nav), re-resolve
  // that adoption instead — e.g. after a TE/ET switch reset mainSrcReady.
  function dynEnsureMainSrc(lenient) {
    /* NOTHING THIS VISITOR MAY PLAY → say so, don't attempt a build (r39, owner-reported).
       An all-premium playlist opened without entitlement leaves dynIncluded() empty, so the build
       ran with zero clips, failed, and reported "Couldn't load the audio — check your connection".
       That blames the network for an entitlement decision — wrong, and it sends the user to fix
       something that isn't broken. Guarded here rather than inside the builder because there is
       nothing to build: the answer is known before any fetch.
       ⚠ Wording is deliberately NEUTRAL — no price, no link, no subscribe path — because this same
       string renders inside the Android app, where Google Play's no-steering rule applies. */
    /* Same shape as the entitlement case below, different cause: offline with none of this
       playlist's audio on the device. Distinguished FIRST because "Premium membership needed"
       would be a lie — the visitor may be fully entitled and simply not have downloaded it. */
    if (PLMODE && sentences.length && !dynIncluded().length && sentNoDlCount()) {
      dynStatus('Nothing in this playlist is downloaded yet', false);
      return Promise.reject({ code: 'nothing-playable' });
    }
    if (PLMODE && sentences.length && !dynIncluded().length) {
      dynStatus('Premium membership needed', false);
      /* ⚠ NOT code:'licence' — that is the RECONNECT overlay's code (handleDenied →
         showLicenceOverlay), so r39 produced "Reconnect to keep listening" for a user who was
         online and simply not entitled. Distinct code, handled as a no-op below: the status line
         above has already said the right thing and there is nothing to reconnect TO. */
      return Promise.reject({ code: 'nothing-playable' });
    }
    // Attached to a live native track (page-open adoption): the engine owns the src — play/
    // pause/seek control it directly and a rebuild would restart it (round-11 item 3).
    if (dynAttached && mainSrcReady) return Promise.resolve();
    if (dynAdopted) {
      if (mainSrcReady) return Promise.resolve();
      var adoptedT = dynAdopted;
      return dynResolveAdopt(adoptedT).then(function (r) {
        if (dynAdopted !== adoptedT) return;
        dynSession = r.sess;
        dynStdRemote = r.std;
        dynStripPaint(adoptedT, r.std);
        mainAudio.src = r.src;
        mainAudio.load();
        mainSrcReady = true;
        dynPreAdvanced = false;   // new track → re-arm autoplay's once-per-track guard
        dynSyncSentBtns();
      });
    }
    if (mainSrcReady && dynSession && dynSessionIsLocal && !dynSession.display && (lenient || dynSession.key === dynKey())) return Promise.resolve();
    var noDlBefore = Object.keys(dynNoDlSeen).length;
    return dynEnsureSession(function (done, total) {
      var c = $('dyn-status-count'); if (c) c.textContent = done + '/' + total;
    }, lenient).then(function (sess) {
      mainAudio.src = (NATIVE && sess.fileUri) ? sess.fileUri : sess.url;
      mainAudio.load();
      mainSrcReady = true;
      dynPreAdvanced = false;
      dynPosStale = false;      // new timeline in place; positions may be tracked again
      /* r197: re-resolve the sentence anchor against the NEW map. This is the ONE consumer, so
         it serves both routes into a rebuild — the automatic one (dynAutoRebuild) and the manual
         one (a change made while paused, picked up on the next play press, where togglePlay's
         existing resume logic reads dynLastPos and seeks for us). Consumed once, then cleared:
         a later play must start where the playhead actually is, not where it was two rebuilds
         ago. dynCue() applies the standard 150 ms lead, so the resume lands short of the block
         exactly like a ① skip does. */
      if (dynResumeNum != null) {
        var ri = dynResumeIndex(sess.map, dynResumeNum);
        dynResumeNum = null;
        if (ri >= 0) dynLastPos = dynCue(ri);
      }
      /* SAY THAT IT IS A SUBSET (owner, 2026-08-08 decision 7). Silently playing 12 of 15
         sentences reads as a bug — the session is shorter than the list and nothing explains why.
         Only when some are actually missing; a fully-downloaded playlist clears the line as before.
         Held for 7s like the other line worth reading, not the 2.5s throwaway. */
      /* Layer 2 found absences the manifest did not predict → repaint so those cards grey. Only
         when the set actually grew, so a normal build never triggers a spurious re-render. */
      if (Object.keys(dynNoDlSeen).length !== noDlBefore) render();
      var nodl = sentNoDlCount();
      if (nodl) {
        var playing = dynIncluded().length;
        dynStatus('Playing ' + playing + ' of ' + (playing + nodl) + ' · ' + nodl + ' not downloaded', false);
        var nseq = dynStatusSeq;
        setTimeout(function () { if (nseq === dynStatusSeq) dynStatus(null); }, 7000);
      } else dynStatus(null);
    }).catch(function (e) {
      var code = e && e.code;
      if (code === 'noauth' || code === 401 || code === 403) {
        dynStatus('Sign in to play this topic', false);
        return Promise.reject(e);
      }
      /* Every clip was unavailable and none of it was an entitlement problem — i.e. the
         not-downloaded case reached via layer 2, because navigator.onLine claimed to be online.
         "Check your connection" would be the wrong advice: the connection is the thing that is
         missing, but what the user actually needs to do is download the playlist. */
      if (code === 'nodl') {
        dynStatus('Nothing in this playlist is downloaded yet', false);
        return Promise.reject(e);
      }
      dynStatus('Couldn’t load the audio — check your connection', false);
      // r18e: the build failed, but there may be a playable session already on the device
      // built with DIFFERENT settings. Rather than leave the user with nothing, show the
      // error briefly, then put the settings back to that session and play it.
      if (!dynReadMeta(DYN_KEY_NS, currentMode)) return Promise.reject(e);
      return new Promise(function (res) { setTimeout(res, 1200); }).then(function () {
        if (!dynRevertToStored()) return Promise.reject(e);
        dynStatus('No connection — your settings have been put back to the version saved on this device.', false);
        var seq = dynStatusSeq;
        setTimeout(function () { if (seq === dynStatusSeq) dynStatus(null); }, 6000);
        return dynEnsureSession(null, true).then(function (sess) {
          mainAudio.src = (NATIVE && sess.fileUri) ? sess.fileUri : sess.url;
          mainAudio.load();
          mainSrcReady = true;
        });
      });
    });
  }
  /* r18e: DON'T STRAND THE USER. Sessions persist per unit+mode whether or not the unit was
     ever "downloaded", so a topic played once is playable offline. But changing a setting
     invalidates that session, and offline with no downloaded clips there is nothing to
     rebuild from — so a single tap could take away audio the user had a moment earlier and
     leave only "check your connection".
     The persisted session's KEY encodes the settings it was built with, so we can read them
     back and put the controls where the audio actually is. Parse is the exact inverse of
     dynKeyFor: mode|pf|rN|eN[|pN]|nums. */
  function dynParseKey(key) {
    var parts = String(key || '').split('|');
    if (parts.length < 5) return null;
    var rp = parseInt(String(parts[2]).replace(/^r/, ''), 10);
    var idx = 4, ep = 0;
    // The optional position token only exists when there are 6 parts — a playlist's num list
    // could otherwise be mistaken for one.
    if (parts.length >= 6 && /^p\d+$/.test(parts[4])) { ep = parseInt(parts[4].slice(1), 10); idx = 5; }
    return { mode: parts[0], pf: parseFloat(parts[1]), rp: rp, en: parts[3] === 'e1', ep: ep,
      nums: parts.slice(idx).join('|') };
  }
  // Put settings (and exclusions) back to whatever the stored session was built with.
  // Returns true only if the result actually matches that session.
  function dynRevertToStored() {
    var meta = dynReadMeta(DYN_KEY_NS, currentMode);
    if (!meta || !meta.key || meta.key === dynKey()) return false;
    var k = dynParseKey(meta.key);
    if (!k || k.mode !== currentMode) return false;
    if (isFinite(k.pf) && k.pf > 0) dynFactor = k.pf;
    if (k.rp >= 1 && k.rp <= 4) dynRepeats = k.rp;
    if (currentMode !== 'et') {            // en/ep are TE-only; in ET the key always says e1
      dynEnglish = k.en;
      dynEngPos = (k.ep >= 1 && k.ep <= 4) ? k.ep : 0;
    }
    // The key's num list IS the included set, so exclusions come back too.
    if (!PLMODE && k.nums) {
      var inc = {};
      k.nums.split(',').forEach(function (n) { inc[n] = true; });
      var next = {};
      sentences.forEach(function (s) { if (!inc[String(s.num)]) next[s.num] = true; });
      dynExcluded = next;
      dynSaveExcluded();
      dynPrefsRepaintExcl();
    }
    dynSaveSettings();
    dynPrefsRepaintControls();
    return dynKey() === meta.key;
  }
  // A setting changed (pause factor / exclusions): drop the session, keep the decoded clip
  // cache, and let the next play rebuild.
  /* `fromControl` (r197) — this invalidation came from a control the visitor just touched (a
     card's ± button, or one of the player's own settings), so if audio is running we rebuild
     and carry on IMMEDIATELY instead of stopping and waiting for a play press.
     ⚠ It is opt-IN, and the two callers that do not pass it are the reason why: the account-prefs
     sync (dynPrefsApply) and the cross-tab settings re-read (dynRefreshSettingsUI) both fire with
     no user gesture anywhere near them, and an autoplay off the back of a background sync is both
     startling and, on iOS, likely to be refused outright. Those keep the old wait-for-play. */
  function dynInvalidate(fromControl) {
    var key = dynKey();
    // Round-12 item 1: if the change lands back ON the built session's key (a revert, or a
    // no-effect toggle like English in ET), nothing is stale — keep playing, clear any nag.
    if (dynSession && dynSessionIsLocal && dynSession.key === key) {
      dynStatus(null);
      return;
    }
    var meta = dynReadMeta(DYN_KEY_NS, currentMode);
    var revertHit = !!(meta && meta.key === key);   // persisted copy matches → strict restore hits on next play
    /* ⚠ ORDER: capture the anchor BEFORE anything touches the element or the session. The map
       that can answer "which sentence is this?" is about to be thrown away, and currentTime is
       about to be zeroed. */
    dynCaptureResume();
    /* "Already playing" excludes the priming silence — that is a 20 ms data: URI standing in for
       a track, and treating it as playback would auto-resume a session the visitor had paused.
       ⚠ ...WHICH IS EXACTLY WHY `dynAutoResume` HAS TO BE PART OF THE TEST. Change a second
       sentence while the first rebuild is still running and the element IS on that silence, so
       the plain reading says "not playing" and the whole thing drops back to wait-for-play —
       mid-flight, with the visitor having done nothing but tick a second box. The intent to keep
       playing outlives the audio it was formed from, so it is tracked explicitly. */
    var wasPlaying = (!mainAudio.paused && !mainOnSilence()) || dynAutoResume;
    if (!mainAudio.paused) { mainAudio.pause(); setMainIcon(false); }
    dynLastPos = 0;   // the rebuilt session has a different timeline
    dynPosStale = true;   // and no late pause/timeupdate may resurrect the old one
    dynAttached = false;
    mainSrcReady = false;
    if (dynSession && dynSession.url && dynSessionIsLocal) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
    dynSession = null;
    /* The block we were on gets its play credit against the map that measured it. plysDwellTick
       holds a reference to the OLD map entry, and the rebuild changes every timing in it, so
       flushing after the swap would credit the listen against the wrong geometry. */
    try { plysDwellReset(); } catch (_) {}
    dynSyncSentBtns();   // no map until the rebuild → ① buttons grey out
    if (fromControl && wasPlaying) { dynAutoRebuild(); return; }
    if (revertHit) dynStatus(null);
    else dynStatus('Changes saved — your session will reconstruct on next play.', false);
  }
  /* ── r197: rebuild NOW and carry on from the same sentence ────────────────────────────
     Owner, 2026-08-25: "if a topic is playing, it KEEPs playing without user having to press
     play themselves. Obviously if a topic is NOT playing / is paused, then toggling settings
     should not prompt an autoplay."

     ⚠ TWO THINGS HERE ARE LOAD-BEARING AND NEITHER IS OBVIOUS.

     1. primeMainAudio() RUNS SYNCHRONOUSLY, INSIDE THE CLICK. The rebuild is seconds of fetch +
        stitch + encode, so the play() that follows it lands nowhere near the gesture that caused
        it. iOS deactivates the page's audio session on every pause, and a play() on a freshly
        load()ed element outside a gesture is refused — which would leave the visitor stopped
        dead with no way back but the play button, i.e. exactly the slog this feature removes.
        The 20 ms silence keeps the session alive across the wait. This is the same trick
        switchAudio() has used for the TE/ET swap since it shipped; it is not new machinery.
     2. The build starts SYNCHRONOUSLY, in the same turn as the prime — no timer in front of it.
        That keeps this path the same shape as togglePlay() and switchAudio(), which is the shape
        known to work on the owner's devices, and it keeps the gap the prime has to cover as short
        as it can be. Rapid ticks are coalesced by `seq` rather than by a debounce: each change
        starts its own build and only the newest may touch the element. It costs a redundant
        stitch, which dynClipCache makes cheap.

        ⚠ HISTORY, BECAUSE IT WILL LOOK LIKE THE OBVIOUS OPTIMISATION TO RE-ADD: a 600 ms debounce
        did sit here (v462-v465). It was removed while chasing the "every control needs two taps"
        report, on the theory that a deferred build fell outside the user gesture, failed, and
        triggered dynRevertToStored(). **That theory was WRONG and the debounce was not the
        cause** — the real one was the account-prefs sync clobbering the unpushed local change;
        see the guard at the top of dynPrefsApply(). Removing the debounce changed nothing for
        the owner. It is left out because the simpler shape is worth having, not because a timer
        here is known to be harmful. */
  /* A manual transport tap, or a direction switch, overrides a pending auto-resume — the same
     principle as togglePlay's `resumeMainAfter = false`. Nothing is lost: dynResumeNum is still
     set, so whichever path reaches the rebuild first lands on the same sentence. */
  function dynCancelRebuild() {
    dynAutoResume = false;
    dynAutoSeq++;            // any build still in flight is now nobody's business
    dynToast(null);
  }
  function dynAutoRebuild() {
    dynStatus('Re-constructing dynamic mp3', true);
    if (!dynStatusVisible()) dynToast('Re-constructing dynamic mp3...');
    primeMainAudio();   // ⚠ inside the gesture — see note 1 above
    dynAutoResume = true;
    /* ⚠ ONE MORE CHANGE MEANS THE BUILD BEFORE IT IS STALE. A change made while the previous
       build is still fetching and encoding leaves that build running with nothing to cancel it —
       and its `.then` would happily assign its now-wrong session to mainAudio.src, whichever
       order the two promises happen to settle in. The sequence number is the arbiter: only the
       newest request may touch the element. */
    var seq = ++dynAutoSeq;
    dynLog('auto-rebuild start seq=' + seq);
    (function () {
      ensureMainSrc().then(function () {
        if (seq !== dynAutoSeq) return;   // superseded mid-build — let the newer one land
        /* dynEnsureMainSrc has re-pointed the element and resolved the anchor into dynLastPos.
           Seek before play, and again after it resolves: a native prepare always restarts at 0,
           which is the same correction togglePlay makes. */
        var want = (dynLastPos > 0.5 &&
          (!mainAudio.duration || !isFinite(mainAudio.duration) || dynLastPos < mainAudio.duration - 0.5)) ? dynLastPos : null;
        if (want != null) { try { mainAudio.currentTime = want; } catch (_) {} }
        var pp = mainAudio.play();
        setMainIcon(true); setupMediaSession();
        dynAutoResume = false;
        dynToast(null);
        if (pp && pp.then) {
          pp.then(function () {
            if (want != null && (mainAudio.currentTime || 0) < 0.5) { try { mainAudio.currentTime = want; } catch (_) {} }
          }, function (e) {
            /* The rebuild worked, the resume did not — say so where the visitor is looking, and
               leave the transport telling the truth. One tap on play picks up where they were,
               because dynLastPos is already parked on the anchor. */
            dynLog('auto-rebuild play FAIL ' + ((e && e.name) || e));
            setMainIcon(!mainAudio.paused);
            if (mainAudio.paused) {
              dynStatus('Tap play to continue', false);
              if (!dynStatusVisible()) dynToast('Tap play to continue');
              var seq = dynStatusSeq;
              setTimeout(function () { if (seq === dynStatusSeq) { dynStatus(null); dynToast(null); } }, 4000);
            }
          });
        }
      }).catch(function (e) {
        // dynEnsureMainSrc has already put the reason on the status line (offline, denied,
        // nothing playable). The toast must not outlive the attempt either way.
        if (seq !== dynAutoSeq) return;
        dynAutoResume = false;
        setMainIcon(false);
        dynToast(null);
        handleDenied(e, mainTier);
      });
    })();
  }
  /* ── round-14: account-level settings sync (auth.js dynPrefs / public.dyn_prefs) ──
     Boot stays instant on the local mirror; once auth resolves the server copy is written
     over it and the settings are RE-RESOLVED (controls repaint + dynInvalidate — the r12
     revert logic keeps the rebuild notice away when the built session still matches). Every
     local change writes localStorage AND, signed-in, upserts the account copy (debounced
     ~1s). Signed-out stays local-only.
     r16: two rows, not two scopes-per-setting — the UNIT row ('<dynKey>') holds {excl, te,
     et} and the 'global' row holds only the apply-to-all per-mode defaults {v:2, te, et}.
     PLMODE has no exclusions (r11), but its unit row still carries its settings. */
  var dynPrefsTimer = null, dynPushGdef = false, dynPushUnit = false;
  // The UNIT row now carries the exclusions AND both modes' settings, so every push rebuilds
  // the whole row from local state — a settings write must never drop the exclusions, nor
  // the other mode's settings (r16).
  function dynUnitPayload() {
    var d = {};
    if (!PLMODE) {
      var excl = [];
      for (var k in dynExcluded) { if (dynExcluded[k]) excl.push(+k); }
      d.excl = excl;
    }
    var te = dynReadJson(dynSetKey(DYN_KEY_NS, 'te')), et = dynReadJson(dynSetKey(DYN_KEY_NS, 'et'));
    if (te) d.te = te;
    if (et) d.et = et;
    return d;
  }
  // v:2 marks the per-mode shape. A pre-r16 flat row has no v and is ignored on read, so the
  // first write from any device simply replaces it.
  function dynGdefPayload() {
    var d = { v: 2 };
    var te = dynReadJson(dynGdefKey('te')), et = dynReadJson(dynGdefKey('et'));
    if (te) d.te = te;
    if (et) d.et = et;
    return d;
  }
  function dynPrefsQueue(which) {
    if (which === 'gdef') dynPushGdef = true; else dynPushUnit = true;   // 'set' | 'excl' both live on the unit row
    var a = window.ThaiEarAuth;
    if (!a || !a.dynPrefs || !(a.getUser && a.getUser())) return;   // signed-out → local only
    if (dynPrefsTimer) clearTimeout(dynPrefsTimer);
    dynPrefsTimer = setTimeout(function () {
      dynPrefsTimer = null;
      var api = window.ThaiEarAuth && window.ThaiEarAuth.dynPrefs;
      if (!api) return;
      if (dynPushGdef) { dynPushGdef = false; api.set('global', dynGdefPayload()); }
      if (dynPushUnit) { dynPushUnit = false; api.set(DYN_KEY_NS, dynUnitPayload()); }
    }, 1000);
  }
  function dynPrefsRepaintControls() {
    var pf = $('dyn-pf'), pv = $('dyn-pf-val');
    if (pf) pf.value = String(dynFactor);
    if (pv) pv.textContent = dynFactor + '×';
    var reps = $('dyn-reps');
    if (reps) reps.querySelectorAll('.dyn-rep-btn').forEach(function (x) { x.classList.toggle('on', x.textContent === String(dynRepeats)); });
    var enCb = $('dyn-en');
    if (enCb) enCb.checked = dynEnglish;
    dynEpRender();   // English-position boxes follow repeats/english/ep
  }
  function dynPrefsRepaintExcl() {
    sentences.forEach(function (s) {
      var on = !!dynExcluded[s.num];
      var card = document.getElementById('sc-' + s.num);
      if (card) card.classList.toggle('dyn-off', on);
      var xb = document.querySelector('#sc-' + s.num + ' .dyn-x-btn');
      if (xb) {
        xb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="' + (on ? 'M12 5v14M5 12h14' : 'M5 12h14') + '"/></svg>';
        xb.setAttribute('aria-label', on ? 'Include in session' : 'Exclude from session');
        xb.title = on ? 'Include in session' : 'Exclude from session';
      }
    });
  }
  function dynPrefsApply() {
    var a = window.ThaiEarAuth;
    if (!a || !a.dynPrefs || !(a.getUser && a.getUser())) return;
    /* 🚨🚨 A LOCAL CHANGE THAT HAS NOT BEEN PUSHED YET ALWAYS WINS. THIS IS THE DOUBLE-TAP BUG
       (owner, 2026-08-25 — twice; the first fix was aimed at the wrong thing entirely).

       `dynPrefs.load()` answers from `dpCache`, a PAGE-LIFETIME cache in auth.js, and
       `dynPrefsQueue` debounces the push of a local change by 1000 ms. So for a full second after
       every change, the account copy this function applies is STALE BY CONSTRUCTION — it is the
       value the user just replaced. It then mirrors that over localStorage, re-resolves, and
       repaints: the slider snaps back to where it was and an excluded sentence un-excludes.

       That window used to be hard to hit. r197 made it the normal case: every control change now
       starts a rebuild immediately, the rebuild mints signed clip URLs, a mint can refresh the
       token, and a token refresh fires `thaiear:auth` — which is what calls this. Auth also
       notifies ~5 times during startup, so the first change of a session lands in it almost every
       time. The second tap works only because the first push has landed by then, so dpCache
       finally agrees.

       ⚠ Guarding on `dynPrefsTimer` specifically, NOT on the dynPush* flags: those are set even
       when signed out (dynPrefsQueue sets them before its early return), so they can be stuck
       true forever and would wedge the sign-in merge shut. The timer is only ever armed while
       signed in and always clears itself — and by the time it fires, `dynPrefs.set()` has already
       written the new value into dpCache synchronously, so there is no gap on the far side. */
    if (dynPrefsTimer) { dynLog('prefs: skipped — local change not pushed yet'); return; }
    a.dynPrefs.load().then(function (map) {
      if (!map) return;
      if (dynPrefsTimer) return;   // a change landed while the (cached) read was resolving
      var exclChanged = false;
      var before = JSON.stringify(dynCurrentSet());
      // r16: mirror the account copy into the local stores, then RE-RESOLVE — the winner
      // between a unit override and the global default is decided by ts, not by arrival order.
      // A pre-r16 'global' row is flat {pf,rp,en,ep} with no v: deliberately ignored, so every
      // unit starts from the classic default instead of inheriting the old player-global set.
      /* ⚠ AND NEVER LET AN OLDER ROW OVERWRITE A NEWER LOCAL ONE. The timer guard above closes
         the ordinary 1000 ms window; this closes the one it cannot see — a push that FAILED
         (offline: auth.js marks it dirty and retries on reconnect), where the timer has long
         since cleared while local is still ahead of the server. Every settings row carries the
         `ts` that dynSettingsFor already arbitrates on, so this is the same rule applied one
         level earlier. */
      var newer = function (incoming, key) {
        var cur = dynReadJson(key);
        return !(cur && (+cur.ts || 0) > (+incoming.ts || 0));
      };
      var g = map.global;
      if (g && g.v === 2) {
        ['te', 'et'].forEach(function (m) { if (g[m] && newer(g[m], dynGdefKey(m))) dynWriteJson(dynGdefKey(m), g[m]); });
      }
      var u = map[DYN_KEY_NS];
      if (u) {
        ['te', 'et'].forEach(function (m) { if (u[m] && newer(u[m], dynSetKey(DYN_KEY_NS, m))) dynWriteJson(dynSetKey(DYN_KEY_NS, m), u[m]); });
        if (!PLMODE && Array.isArray(u.excl)) {
          var byNum = function (x, y) { return x - y; };
          var cur = [];
          for (var k in dynExcluded) { if (dynExcluded[k]) cur.push(+k); }
          if (cur.sort(byNum).join(',') !== u.excl.slice().sort(byNum).join(',')) {
            dynExcluded = {};
            u.excl.forEach(function (n) { dynExcluded[n] = true; });
            dynSaveExcluded();
            exclChanged = true;
          }
        }
      }
      dynLoadSettings();
      var changed = JSON.stringify(dynCurrentSet()) !== before;
      dynPrefsRepaintControls();   // r16a: unconditional — a repaint is cheap, a stale control is a bug
      if (changed || exclChanged) {
        dynLog('prefs: applied account settings');
        if (exclChanged) dynPrefsRepaintExcl();
        dynInvalidate();   // r12: clears itself when the built session's key still matches
      }
    }).catch(function () {});
  }
  /* ── r16: "apply to all" ──────────────────────────────────────────────────────────
     Settings are per unit, so this is the escape hatch for "I want THIS everywhere".
     It writes the current settings as the user's global default FOR THE CURRENT MODE
     ONLY — syncing in Thai→English never touches anyone's English→Thai setups — with a
     ts that outranks every per-unit override made before now, which is what makes one
     write apply to all units without rewriting them. This unit keeps a matching override
     at the same stamp so it stays in step. */
  function dynModeLabel() { return currentMode === 'et' ? 'English→Thai' : 'Thai→English'; }
  function dynSyncAll() {
    var o = dynCurrentSet();
    o.ts = Date.now();
    dynWriteJson(dynGdefKey(currentMode), o);
    dynWriteJson(dynSetKey(DYN_KEY_NS, currentMode), o);
    dynPrefsQueue('gdef');
    dynPrefsQueue('set');
    dynStatus('Applied to all topics and playlists (' + dynModeLabel() + ').', false);
    var seq = dynStatusSeq;
    setTimeout(function () { if (seq === dynStatusSeq) dynStatus(null); }, 3500);
  }
  // Confirm sheet — same construction as the premium sheet above (inline styles, click-out
  // to dismiss) so it needs no stylesheet of its own.
  function dynSyncConfirm() {
    var unitWord = PLMODE ? 'playlist' : 'topic';
    var ov = document.createElement('div');
    ov.id = 'dyn-sync-sheet';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;padding:20px;background:rgba(20,16,48,.5);opacity:0;transition:opacity .18s;';
    ov.innerHTML =
      '<div role="dialog" aria-modal="true" style="background:#fff;border-radius:14px;max-width:380px;width:100%;' +
        'padding:22px 20px 18px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:var(--font-ui,system-ui,sans-serif);">' +
        '<div style="font:600 16px var(--font-ui,system-ui,sans-serif);color:#1A1A1A;margin-bottom:10px;">Sync player settings</div>' +
        '<p style="font-size:14px;color:#5A5A5A;line-height:1.6;margin:0 0 16px;">' +
          'Your changes are saved for this ' + unitWord + '. Syncing your dynamic player settings will now apply ' +
          'these settings to all topics/playlists when ' + escapeHtml(dynModeLabel()) + ' is selected — do you want to continue?</p>' +
        '<div style="display:flex;gap:8px;">' +
          '<button id="dyn-sync-go" style="flex:1;font:600 14px var(--font-ui,system-ui,sans-serif);' +
            'padding:11px 14px;border-radius:8px;border:0;background:#4B41AD;color:#fff;cursor:pointer;">Continue</button>' +
          '<button id="dyn-sync-back" style="flex:1;font:600 14px var(--font-ui,system-ui,sans-serif);' +
            'padding:11px 14px;border-radius:8px;border:.5px solid rgba(0,0,0,.18);background:#fff;color:#5A5A5A;cursor:pointer;">Go back</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.style.opacity = '1'; });
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var b = ov.querySelector('#dyn-sync-back'); if (b) b.addEventListener('click', close);
    var g = ov.querySelector('#dyn-sync-go');
    if (g) g.addEventListener('click', function () { close(); dynSyncAll(); });
  }
  /* ── r16a: the ⓘ explainers ────────────────────────────────────────────────────────
     Two settings needed explaining. The whole label is the hit target (the ⓘ alone is a
     tiny tap area on a phone); tapping again, or the ×, dismisses it. One box at a time,
     inserted directly under the row it belongs to. */
  var DYN_INFO = {
    // r18: shown above the player. The second sentence is the one that matters — it is the
    // expectation-setter for the lock screen skipping a unit that has never been constructed.
    player: 'ThaiEar’s Dynamic mp3 Player constructs mp3 audio to your specification. ' +
      'Press play to construct this one — it is then stored on your device and replaced each ' +
      'time you generate a new dynamic mp3. Learn more about the Dynamic Player in our ' +
      '<a href="guide.html">guide</a>.',
    reps: 'This decides how many times a Thai sentence is spoken.',
    // r151 (owner-authored, verbatim). The last sentence is the one that earns its place: after
    // r147 the floor no longer scales, so 0.25x really does bottom out at a couple of seconds
    // rather than shrinking away — that is a promise worth making explicit rather than surprising.
    pauses: 'This decides the length of pause between repeats of a sentence and between different ' +
      'sentences. Pauses are naturally longer for longer sentences and shorter for shorter ' +
      'sentences. There is always a minimum length pause of a couple of seconds, even if you ' +
      'select 0.25x.',
    engpos: 'This decides where the English sentence is spoken. In the last position, the English ' +
      'is heard after all the Thai repeats of a sentence. But English can also be positioned ' +
      'between Thai sentences, which can help with comprehension when first getting to know a ' +
      'topic. To hear English spoken first, before any Thai, switch to the English first mode at ' +
      'the top of the dynamic mp3 player.',
    // Desktop MP3 download. Says the two things a person cannot find out any other way: the file
    // is a snapshot of what they built, and the site has no further hold on it once it is saved.
    pcdl: 'The latest Dynamic mp3 you have constructed will be downloaded — the Thai first or ' +
      'English first version, whichever you are on. Play this topic first to enable downloads. ' +
      'Your pause, repeat and English settings are fixed into the file, so change a setting and ' +
      'play again to build a new one. The file is saved onto this computer and is yours to keep, ' +
      'move or delete — ThaiEar cannot see it or update it afterwards.'
  };
  var dynInfoOpen = null;
  function dynInfoClose() {
    var box = document.getElementById('dyn-info-box');
    if (box && box.parentNode) box.parentNode.removeChild(box);
    dynInfoOpen = null;
  }
  function dynInfoToggle(key, rowEl) {
    var was = dynInfoOpen;
    dynInfoClose();
    if (was === key || !rowEl || !DYN_INFO[key]) return;
    var box = document.createElement('div');
    box.id = 'dyn-info-box';
    box.className = 'dyn-info-box';
    box.setAttribute('role', 'note');
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'dyn-info-x';
    x.setAttribute('aria-label', 'Close'); x.title = 'Close';
    x.innerHTML = '&times;';
    x.addEventListener('click', dynInfoClose);
    var t = document.createElement('span');
    // Our own constants (may carry an <a> link, e.g. the guide link in 'player') — never user data.
    t.innerHTML = DYN_INFO[key];
    box.appendChild(x); box.appendChild(t);
    rowEl.parentNode.insertBefore(box, rowEl.nextSibling);
    dynInfoOpen = key;
  }
  // Label + ⓘ, as one button so the text is tappable too.
  function dynInfoLabel(text, key) {
    return '<button type="button" class="dyn-info-lbl" data-info="' + key + '" ' +
      'aria-label="' + escapeHtml(text) + ' — what is this?">' + escapeHtml(text) +
      ' <span class="dyn-info-i" aria-hidden="true">i</span></button>';
  }

  /* ══ DESKTOP MP3 DOWNLOAD (2026-08-07) ═══════════════════════════════════════════════════════
     Saves the constructed dynamic mp3 as a real FILE on the computer, for allow-listed accounts.
     Built for people who have no phone: the audio has to leave the browser and live on a PC (and
     often be copied onto whatever hardware they own), so it ships as MPEG-1 MP3 — see the format
     reasoning in mp3-export.js.

     HOW IT DIFFERS FROM THE OFFLINE DOWNLOAD (dl-core.js) — they share nothing, deliberately:
       · offline download  = per-sentence clips into Cache Storage / app storage, refcounted
                             between topics and playlists, removable, staleness-checked.
       · this              = one finished MP3 into the user's Downloads folder.
     There is therefore NO remove button and NO update button here, and none should be added: the
     file belongs to the operating system the moment it lands, the site cannot see it, cannot know
     if it is stale, and must not pretend otherwise.

     WHAT GETS DOWNLOADED. The session the visitor actually built on the side they are looking at
     — TE downloads the built TE session, ET the built ET one. The settings are read back out of
     the STORED SESSION KEY (dynKeyFor's `mode|pf|rN|eN[|pN]|nums`), never from the live controls,
     so a file can never disagree with the audio it was made from: move a slider without pressing
     play and the download still gives you what you heard. Those settings are then re-stitched to
     PCM (dynBuildSessionFor's `{pcm:true}` hatch) so the MP3 is encoded once from the original
     clips rather than transcoded from the 32 kbps session. ═══════════════════════════════════ */

  // Mirror of dynKeyFor's per-sentence token — the two MUST agree or a key cannot be resolved
  // back to its sentences. Kept adjacent in spirit; if you change one, change both.
  function dynSentToken(s) {
    return s.prefix ? (s.prefix + ':' + (s.clipNum != null ? s.clipNum : s.num)) : String(s.num);
  }
  /* Read a persisted session key back into the settings that produced it. The nums list is always
     the LAST field; the optional English-position token sits between `e…` and it. Returns null on
     anything unrecognised so a key written by a future format degrades to "can't export" rather
     than to a silently wrong file. */
  function dynParseSessionKey(key) {
    var p = String(key || '').split('|');
    if (p.length < 5) return null;
    var mode = p[0], pf = parseFloat(p[1]), rp = parseInt(String(p[2]).slice(1), 10);
    var en = parseInt(String(p[3]).slice(1), 10);
    if ((mode !== 'te' && mode !== 'et') || !isFinite(pf) || !isFinite(rp) || !isFinite(en)) return null;
    var ep = 0, i;
    for (i = 4; i < p.length - 1; i++) if (String(p[i]).charAt(0) === 'p') ep = parseInt(String(p[i]).slice(1), 10) || 0;
    var toks = String(p[p.length - 1]).split(',').filter(Boolean);
    if (!toks.length) return null;
    return { mode: mode, pf: pf, rp: rp, en: !!en, ep: ep, tokens: toks };
  }
  // The unit's human name. Playlists render theirs into #pl-player-title; topic pages carry an
  // <h1 class="topic-title">. Never the audio prefix — that is a filename handle, not a name.
  function dynUnitName() {
    var el = PLMODE ? document.getElementById('pl-player-title') : document.querySelector('h1.topic-title');
    var n = el && (el.textContent || '').trim();
    if (!n || n === 'Loading…') n = (document.title || '').split('—')[0].trim();
    return n || PREFIX || 'ThaiEar';
  }
  /* Filename carries everything that distinguishes one build from another — because there is no
     Update button and no manifest, the filename is the ONLY place a person can tell two downloads
     apart six months later. Mode and repeat count always; English only when it is a real choice
     (ET always has it); pauses only when moved off 1× ; "12of18" only when sentences were
     excluded, which is otherwise completely invisible in a file that is simply shorter. */
  function dynExportName(st) {
    var bits = [st.mode.toUpperCase(), st.rp + 'repeat' + (st.rp === 1 ? '' : 's')];
    if (st.mode === 'te' && st.en) bits.push('english');
    if (st.pf !== 1) bits.push('pauses' + String(st.pf).replace('.', 'p') + 'x');
    var total = sentences.length;
    if (st.tokens.length < total) bits.push(st.tokens.length + 'of' + total);
    // Strip only what Windows/macOS actually reject in a filename; keep the name otherwise verbatim.
    var name = dynUnitName().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
    return name + '_' + bits.join('_') + '.mp3';
  }

  /* IS THIS A COMPUTER? The feature saves a file into a Downloads FOLDER, for someone who will then
     open it, move it, or copy it onto other hardware. On a phone that is at best confusing and at
     worst useless — the file lands somewhere the person cannot easily reach, and every phone user
     already has the far better offline download. So the control is desktop-only, and hidden rather
     than disabled: an explained-away button still invites the tap.

     ⚠ NOT a `pointer: fine` / screen-width test. Touchscreen laptops report a coarse pointer and
     small desktop windows report a narrow screen; both are real computers. The question here is
     "does this device have a user-facing filesystem", which tracks the PLATFORM, not the input
     method or the viewport. So: known mobile platforms are excluded by name and everything else is
     treated as a computer.

     Order matters — the UA test runs BEFORE userAgentData.mobile, because Chrome reports
     `mobile: false` for Android TABLETS, which are not computers for this purpose. An Android or
     iOS user agent is never a desktop, whatever the hints say.

     `?pcdl=1` forces it on, so the owner can test the real flow on a phone browser. It grants
     nothing by itself — entitlement is still checked immediately below. */
  function dynIsDesktop() {
    try {
      if (new URLSearchParams(location.search).get('pcdl') === '1') return true;
    } catch (_) {}
    if (NATIVE) return false;                     // the app: a blob download has nowhere to land
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPod|iPad|IEMobile|Opera Mini|Mobile|Silk|Kindle|BlackBerry|webOS|Windows Phone/i.test(ua)) return false;
    // iPadOS 13+ deliberately reports itself as "Macintosh"; the touch points give it away.
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return false;
    var uad = navigator.userAgentData;
    if (uad && uad.mobile === true) return false;
    return true;
  }

  /* Entitlement. Deliberately a single ASK of auth.js rather than any local flag: the answer has
     to survive a monk losing access, and a localStorage boolean would not. A stale auth.js
     (cached older copy) simply has no such method → feature absent, which is the safe direction. */
  function dynPcDlAllowed() {
    var a = window.ThaiEarAuth;
    return !!(a && typeof a.canDesktopDownload === 'function' && a.canDesktopDownload());
  }

  /* LOADED ON DEMAND, NOT BY THE PAGES. mp3-export.js pulls in a 156 KB LGPL encoder that maybe a
     dozen accounts will ever run. Injecting it on first click keeps it off all 93 topic pages for
     everyone else — and, just as usefully, means adding this feature required no edit to a single
     topic page, so nothing has to be re-generated when it changes. Resolves once, then memoised. */
  var dynPcDlEnc = null;
  function dynPcDlLoadEncoder() {
    if (dynPcDlEnc) return dynPcDlEnc;
    dynPcDlEnc = new Promise(function (resolve, reject) {
      if (window.ThaiEarMp3) return resolve();
      var s = document.createElement('script');
      s.src = '/mp3-export.js';
      s.async = true;
      s.onload = function () { window.ThaiEarMp3 ? resolve() : reject({ code: 'noencoder' }); };
      s.onerror = function () { reject({ code: 'noencoder' }); };
      document.head.appendChild(s);
    }).then(function () {
      if (!window.ThaiEarMp3.supported()) throw { code: 'unsupported' };
    });
    // A failed load must not poison every later attempt — forget it so a retry re-fetches.
    dynPcDlEnc.catch(function () { dynPcDlEnc = null; });
    return dynPcDlEnc;
  }

  var dynPcDlBusy = false;
  function dynPcDlRun(btn, note) {
    if (dynPcDlBusy) return;
    function say(msg, cls) { note.textContent = msg; note.className = 'dyn-pcdl-note' + (cls ? ' ' + cls : ''); }

    var meta = dynReadMeta(DYN_KEY_NS, currentMode);
    /* THE "PLAY IT FIRST" GATE. Not a technical necessity — the settings could be taken from the
       live controls and built on demand — but a deliberate one: it guarantees the file is audio
       the person has actually heard, on the side they are looking at, rather than a silent
       construction from controls they may have nudged and never listened to. */
    if (!meta) {
      say('Please play this ' + (PLMODE ? 'playlist' : 'topic') + ' to construct a Dynamic mp3 first.', 'warn');
      return;
    }
    var st = dynParseSessionKey(meta.key);
    if (!st) { say('That saved session can’t be read. Press play to rebuild it, then try again.', 'warn'); return; }

    var byTok = {};
    sentences.forEach(function (s) { byTok[dynSentToken(s)] = s; });
    var inc = st.tokens.map(function (t) { return byTok[t]; }).filter(Boolean);
    // A sentence in the key that is no longer on the page (playlist edited since the build).
    if (inc.length !== st.tokens.length) {
      say('This ' + (PLMODE ? 'playlist' : 'topic') + ' has changed since that audio was built. Press play to rebuild it, then try again.', 'warn');
      return;
    }
    dynPcDlBusy = true;
    btn.disabled = true;
    var label = btn.textContent;
    say('Preparing audio…');
    btn.textContent = 'Preparing…';

    dynPcDlLoadEncoder()
      .then(function () {
        return dynBuildSessionFor(inc, DYN_KEY_NS, meta.key, function (d, tot) {
          say('Preparing audio… ' + Math.round(d / tot * 100) + '%');
        }, { pf: st.pf, rp: st.rp, en: st.en, ep: st.ep }, { pcm: true });
      })
      .then(function (r) {
        // Lane cuts may only fall at a sentence block's END — every one of those sits at the far
        // side of a ~3 s gap, so the join artefact lands in silence. See mp3-export.js.
        var bounds = (r.map || []).slice(0, -1).map(function (b) { return b.end; });
        var filename = dynExportName(st);
        return window.ThaiEarMp3.encode({
          pcm: r.pcm,
          sampleRate: r.rate,
          boundaries: bounds,
          tags: {
            title: dynUnitName() + ' (' + st.mode.toUpperCase() + ', ' + st.rp +
                   ' repeat' + (st.rp === 1 ? '' : 's') + ')',
            artist: 'ThaiEar',
            album: 'ThaiEar — ' + (PLMODE ? 'Playlists' : 'Topic Sentences'),
            genre: 'Speech'
          },
          onProgress: function (f, phase) {
            var pct = Math.round(f * 100);
            say(phase === 'encode' ? 'Creating MP3… ' + pct + '%' : 'Preparing audio…');
            btn.textContent = phase === 'encode' ? 'Creating… ' + pct + '%' : 'Preparing…';
          }
        }).then(function (blob) {
          window.ThaiEarMp3.saveAs(blob, filename);
          say('Saved ' + filename + ' (' + (blob.size / 1048576).toFixed(1) + ' MB) to your Downloads folder.', 'ok');
        });
      })
      .catch(function (e) {
        var code = e && e.code;
        if (code === 'noencoder') say('Couldn’t load the MP3 encoder. Check your connection and try again.', 'warn');
        else if (code === 'unsupported') say('This browser can’t create MP3 files. Try Chrome, Edge or Firefox on a computer.', 'warn');
        else if (code === 401 || code === 'noauth') say('Please sign in again, then try the download.', 'warn');
        else if (code === 402 || code === 403 || code === 'licence') say('Your subscription doesn’t cover this audio.', 'warn');
        else if (code === 'empty') say('There are no sentences to download.', 'warn');
        else say('Sorry — the download failed. Check your connection and try again.', 'warn');
        dynLog('pc-download failed: ' + (code || '') + ' ' + ((e && e.detail) || (e && e.message) || ''));
      })
      .then(function () {
        dynPcDlBusy = false;
        btn.disabled = false;
        btn.textContent = label;
      });
  }

  /* Build the row and put it after `afterEl`. Returns nothing — absence IS the not-allowed state,
     so no allow-listed-only markup is ever shipped to an ordinary visitor's DOM.
     Two independent gates, both of which must pass: dynIsDesktop() (this is a computer) and
     dynPcDlAllowed() (this account may download). Covers topic pages and playlists alike — a
     playlist runs through this same mount. */
  var dynPcDlAnchor = null, dynPcDlMounted = false;
  function dynPcDlMount(afterEl) {
    if (afterEl) {
      dynPcDlAnchor = afterEl;
      /* Entitlement is a Supabase round trip, so at mount time the answer is usually still
         unknown — and "unknown" must render as ABSENT, never as a button that might vanish.
         auth.js fires thaiear:auth when it settles (and on sign-in/out), which is the moment to
         look again. Listener attached once, on the first mount call only. */
      window.addEventListener('thaiear:auth', function () { dynPcDlMount(null); });
    }
    if (dynPcDlMounted || !dynIsDesktop() || !dynPcDlAnchor || !dynPcDlAnchor.parentNode) return;
    if (!dynPcDlAllowed()) return;
    var wrap = document.createElement('div');
    wrap.className = 'dyn-pcdl';
    wrap.innerHTML =
      '<div class="dyn-pcdl-row">' +
        '<button type="button" class="dyn-pcdl-btn" id="dyn-pcdl-btn">Download MP3 to this computer</button>' +
        dynInfoLabel('About this download', 'pcdl') +
      '</div>' +
      '<div class="dyn-pcdl-note" id="dyn-pcdl-note" role="status" aria-live="polite"></div>';
    /* ⚠ dynPcDlAnchor, NEVER `afterEl`. The whole point of this function is that it gets called a
       SECOND time with null once entitlement resolves — `afterEl` is only ever non-null on the
       first, too-early call. Using it here threw "Cannot read properties of null" on the very run
       that was supposed to build the button, and because the mounted flag had already been set the
       retry on the next auth event was skipped too. Hence also: set the flag only once the node is
       actually in the document, so a failure genuinely retries. */
    dynPcDlAnchor.parentNode.insertBefore(wrap, dynPcDlAnchor.nextSibling);
    dynPcDlMounted = true;
    var lbl = wrap.querySelector('.dyn-info-lbl');
    if (lbl) lbl.addEventListener('click', function () { dynInfoToggle('pcdl', wrap.querySelector('.dyn-pcdl-row')); });
    var btn = wrap.querySelector('#dyn-pcdl-btn'), note = wrap.querySelector('#dyn-pcdl-note');
    btn.addEventListener('click', function () { dynPcDlRun(btn, note); });
  }
  /* Collapse the SEO intro to two lines with a Read more. The paragraph is only WRAPPED and
     height-clamped — the text is never removed or display:none'd, so it stays fully indexable. */
  /* r139 — ADOPT A STATICALLY-SHIPPED WRAPPER INSTEAD OF BAILING OUT.
     The clamp lives on `body.te-v2 .te-intro-wrap:not(.open) .topic-intro`, so it can only bite
     once the wrapper EXISTS — and building it here, at mount, meant the intro painted at full
     height and then snapped to two lines. gen_dyncss.js now ships the wrapper and the button in
     the HTML so the clamp applies at first paint; this function's job on those pages is only to
     wire the button.
     ⚠ The old guard returned the moment it saw a wrapper, which was correct while the wrapper
     could only be self-built (nothing to wire) and is exactly wrong now — it would have left a
     dead "Read more" button on all 93 pages. Wire-then-mark, so a second call is still a no-op.
     Still builds the wrapper itself when absent, so a page that has not been through the
     generator behaves exactly as before. */
  function dynCollapseIntro() {
    var p = document.querySelector('.topic-intro');
    if (!p) return;
    var w = (p.parentNode && p.parentNode.classList && p.parentNode.classList.contains('te-intro-wrap'))
      ? p.parentNode : null;
    var b;
    if (w) {
      b = w.querySelector('.te-intro-more');
      if (!b) return;                     // wrapper without a button: nothing to wire
    } else {
      w = document.createElement('div');
      w.className = 'te-intro-wrap';
      p.parentNode.insertBefore(w, p);
      w.appendChild(p);
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'te-intro-more';
      b.textContent = 'Read more';
      w.appendChild(b);
    }
    if (b.__teIntroWired) return;
    b.__teIntroWired = true;
    b.addEventListener('click', function () {
      b.textContent = w.classList.toggle('open') ? 'Show less' : 'Read more';
    });
  }
  // Show/hide the TE-only English checkbox to match the current direction (ET always has English).
  function dynSyncEnToggle() {
    var w = $('dyn-en-wrap'), sp = $('dyn-en-sep');
    var hide = currentMode === 'et';
    if (w) w.style.display = hide ? 'none' : '';
    if (sp) sp.style.display = hide ? 'none' : '';
    dynEpRender();   // the English-position line shares the same mode-dependence
  }
  // Round-15 item 4: "English position" line — |thai ☐ thai ☐| per current repeat count,
  // radio-style (exactly one ticked = English follows that Thai repeat). Only meaningful in
  // TE, with English on, and ≥2 repeats; hidden otherwise. Rebuilt on every relevant change.
  function dynEpRender() {
    var row = $('dyn-ep-row'), box = $('dyn-ep-boxes');
    if (!row || !box) return;
    var show = currentMode !== 'et' && dynEnglish && dynRepeats >= 2;
    row.style.display = show ? '' : 'none';
    if (!show) { if (dynInfoOpen === 'engpos') dynInfoClose(); return; }   // row gone → its explainer goes too
    var eff = dynEngPosEff();
    var html = '';
    for (var i = 1; i <= dynRepeats; i++) {
      html += '<span class="dyn-ep-th">Thai</span>' +
        '<button type="button" class="dyn-ep-box' + (i === eff ? ' on' : '') + '" data-ep="' + i + '"' +
          ' role="radio" aria-checked="' + (i === eff ? 'true' : 'false') + '"' +
          ' aria-label="English after Thai repeat ' + i + '"></button>';
    }
    box.innerHTML = html;
    box.querySelectorAll('.dyn-ep-box').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-ep'), 10);
        if (!(v >= 1 && v <= dynRepeats) || v === dynEngPosEff()) return;
        dynEngPos = v;
        dynSaveSettings();
        dynEpRender();
        dynInvalidate(true);
      });
    });
  }
  // Status line under the transport. text=null hides it; dots=true appends the animated dots
  // (plus a live n/m counter span the build progress writes into).
  var dynStatusSeq = 0;   // bumped on every status change so auto-hide timers can't clobber a newer message
  function dynStatus(text, dots) {
    dynStatusSeq++;
    var el = $('dyn-status');
    if (!el) return;
    if (text == null) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = escapeHtml(text) + (dots ? '<span class="dyn-dots"></span> <span id="dyn-status-count"></span>' : '');
  }
  /* ── r197: the rebuild toast ─────────────────────────────────────────────────────────
     The auto-rebuild exists so you can exclude a sentence from the bottom of a long topic
     without walking back up to the player — which means the status line saying what is
     happening is, by construction, exactly the thing you cannot see. So mirror it, but ONLY
     when it is genuinely off-screen: a one-shot rect read at the moment of the change, not an
     observer, because the answer is only ever needed once per rebuild.
     It never carries a timer: it is cleared by whatever ends the rebuild (success OR failure),
     and by a tap. Owner: "no need for that to ever linger". */
  /* ⚠ MEASURE THE TRANSPORT, NOT THE STATUS LINE ITSELF. #dyn-status is `hidden` whenever it has
     nothing to say — which is precisely the moment this is asked — so a rect read on it returns
     0×0 and would report "off-screen" at the very top of the page, popping a toast over a status
     line the reader is looking straight at. The audio row is always laid out, sits immediately
     above the status line, and is the same element the mini player observes, so the toast appears
     exactly when the mini player does. */
  function dynStatusVisible() {
    var el = document.querySelector('#player-root .audio-row') || $('dyn-status') || $('player-root');
    if (!el || !el.getBoundingClientRect) return true;   // can't tell → don't nag
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return true;
    var top = 56;   // the sticky nav covers this much — under it is not "visible"
    return r.bottom > top && r.top < (window.innerHeight || document.documentElement.clientHeight);
  }
  function dynToast(text) {
    var el = $('dyn-toast');
    if (text == null) { if (el) el.classList.remove('show'); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'dyn-toast';
      el.className = 'dyn-toast';
      el.setAttribute('role', 'status');
      el.addEventListener('click', function () { dynToast(null); });
      document.body.appendChild(el);
    }
    el.textContent = text;
    /* ⚠ REFLOW, NOT requestAnimationFrame. The transition needs the element to have been laid out
       at opacity:0 before `show` flips it, and the obvious way to get that is a double rAF — but
       rAF DOES NOT FIRE IN A BACKGROUNDED TAB, so a rebuild kicked off just before the user
       switched away would leave a permanently invisible toast that then never cleared. Reading
       offsetWidth forces the same layout synchronously and cannot be throttled. */
    void el.offsetWidth;
    el.classList.add('show');
  }
  /* ⚠ LAND SHORT OF A BLOCK, NEVER ON IT (2026-08-20, r196).
     Every seek that targets a sentence — the ① skip buttons and the scrubber's snap — used to go
     to map[i].start EXACTLY, which in English-first mode is literally the first sample of the
     English clip. The only cushion was whatever digital silence the clip happened to carry, about
     100 ms, and any engine that rounds a seek forward eats into it.

     THE REPORT THAT FOUND IT (owner, 2026-08-20): "the English sounds like 'food is very spicy'
     rather than 'The food is very spicy'" — but only when scrubbing; listening straight through
     you hear it fine. Measured, the clip is intact and "The" peaks at −13 dB, LOUDER than "food"
     at −17 dB. What makes this one sentence show the fault is its prosody: the voice says
     "The", leaves a 110 ms gap, then "food is very spicy". Land a few tens of ms late and you get
     a fragment, silence, then "food is very spicy" — which the ear hears as the sentence starting
     at "food". Every other sentence runs its first word into the second, so a late landing merely
     shaves an attack and the word survives.

     150 ms is free: a block is always preceded by that sentence's `gap`, which is at least 2 s of
     silence (see the floors in the builder), so the cue can never bleed the previous sentence.
          Verified by test_dyn_seek.js, which runs these functions' real source.
     Full story: `SESSION_2026-08-20_PLAYER_FIXES.md` §5. */
  var DYN_SEEK_LEAD = 0.15;
  function dynCue(i) {
    var map = dynSession.map;
    return Math.max(0, map[i].start - DYN_SEEK_LEAD);
  }
  /* Which block governs time t? Shared so the SEEK and the HIGHLIGHT agree — a cued position sits
     150 ms before its block starts, and if the finder still called that the PREVIOUS block, the
     card highlight would flick to the wrong sentence for a tenth of a second and a following
     ①-back would restart the block you just left instead of stepping back one.
     The last block keeps its true end, so nothing clips the tail of a session. */
  function dynBlockAt(t) {
    var map = dynSession && dynSession.map;
    if (!map || !map.length) return -1;
    for (var i = 0; i < map.length; i++) {
      var edge = (i === map.length - 1) ? map[i].end : map[i].end - DYN_SEEK_LEAD;
      if (t < edge) return i;
    }
    return -1;
  }
  /* ── r197: the sentence anchor (see dynResumeNum) ────────────────────────────────────
     dynCaptureResume() — remember WHICH SENTENCE is governing playback right now, before the
     session that knows the timings is dropped. Only ever called while a LOCAL map is live: an
     adopted neighbour's map describes a different unit, and its nums would resolve against the
     wrong page. */
  function dynCaptureResume() {
    if (!(dynSession && dynSessionIsLocal && dynSession.map && dynSession.map.length)) return;
    var i = dynBlockAt(mainAudio.currentTime || 0);
    if (i >= 0) dynResumeNum = dynSession.map[i].num;
  }
  /* Where does that anchor land in the NEW map? Exact hit if the sentence survived the change.
     If it did NOT — you excluded the very sentence you were listening to — carry on from the
     next INCLUDED sentence in page order, falling back to the previous one, then to the start
     (owner, 2026-08-25). Page order comes from `sentences`, not from the map, because the map
     only holds the survivors and the answer depends on where the missing one sat among them. */
  function dynResumeIndex(map, num) {
    if (!map || !map.length || num == null) return -1;
    var i;
    for (i = 0; i < map.length; i++) { if (map[i].num === num) return i; }
    var at = -1;
    for (i = 0; i < sentences.length; i++) { if (sentences[i].num === num) { at = i; break; } }
    if (at < 0) return -1;
    var pos = {};
    for (i = 0; i < map.length; i++) pos[map[i].num] = i;
    for (i = at + 1; i < sentences.length; i++) { if (pos[sentences[i].num] != null) return pos[sentences[i].num]; }
    for (i = at - 1; i >= 0; i--) { if (pos[sentences[i].num] != null) return pos[sentences[i].num]; }
    return -1;
  }
  // Round-8: snap an in-page scrub commit to the nearest sentence-block start, so a seek
  // never lands mid-pause. (Lock-screen drag scrubbing is APK v4 native work.)
  function dynSnapTime(t) {
    var map = dynSession && dynSession.map;
    if (!map || !map.length) return t;
    var best = t, bd = Infinity;
    for (var i = 0; i < map.length; i++) {
      var d = Math.abs(map[i].start - t);
      if (d < bd) { bd = d; best = dynCue(i); }
    }
    return best;
  }
  // Round-8: a paused <audio> doesn't reliably emit timeupdate for a programmatic seek on
  // every engine, so ① seeks repaint the transport (and card highlight) directly.
  function dynPaintPos() {
    dynLastPos = mainAudio.currentTime || 0;
    var pct = (mainAudio.duration && isFinite(mainAudio.duration)) ? (mainAudio.currentTime / mainAudio.duration) * 100 : 0;
    var f = $('scrubber-fill'); if (f) f.style.width = pct + '%';
    var c = $('time-cur'); if (c) c.textContent = formatTime(mainAudio.currentTime);
    setMiniFill(pct);
    if (dynSession && dynSessionIsLocal) dynHighlight(mainAudio.currentTime);
  }
  // Round-15 item 2: the ① buttons (audio-row + mini) grey out whenever NO map governs the
  // current audio — placeholder/standard playback, or invalidated-and-not-yet-rebuilt — and
  // come back the moment a session (real or hydrated display) is live. One central toggle.
  function dynSyncSentBtns() {
    var off = !(dynSession && dynSession.map && dynSession.map.length);
    ['dyn-sent-prev', 'dyn-sent-next', 'te-mini-back', 'te-mini-fwd'].forEach(function (id) {
      var b = $(id); if (b) b.classList.toggle('dyn-sent-off', off);
    });
  }
  // Sentence-block skip (the ①-arrow buttons): next → start of the next block; prev → start
  // of the previous block if we're within 1.5 s of the current block's start, else restart it.
  // Seek-only — never calls play(), so it repositions while PAUSED too (round-8 item 4).
  function dynSentSkip(dir) {
    if (!dynSession || !dynSession.map.length) return;
    var t = mainAudio.currentTime || 0, map = dynSession.map;
    var i = dynBlockAt(t);
    if (i < 0) i = map.length - 1;
    var target = null;
    if (dir > 0) {
      if (i + 1 < map.length) target = dynCue(i + 1);
    } else if (t - map[i].start < 1.5 && i > 0) {
      target = dynCue(i - 1);
    } else {
      target = dynCue(i);
    }
    if (target == null) return;
    mainAudio.currentTime = target;
    dynPaintPos();
  }
  /* ══ PLAY COUNTING (PLAYS_COUNTER.md) ═════════════════════════════════════════
     One play = one sentence HEARD once, however it was heard. Two entry points feed it: the dyn
     session's highlighted block (below) and the individual clip button (see notePlayClip).

     THE DWELL RULE — 2 seconds of actual playback, OR the clip/block ending, whichever comes
     first. Both halves are load-bearing:
       · The 2s rejects the two ways a count could be fabricated — dragging the pause slider across
         twenty cards, and tapping play then immediately stopping.
       · "or the end" exists because 140 of the 2,271 clips are SHORTER THAN 2 SECONDS (measured,
         speed-audit/full_scan_syl.json; shortest 1.00s). A flat 2s would have made those 140
         sentences permanently uncountable from the ▶ button, and every topic containing one stuck
         at a minimum of 0 for ever.
     Implemented as `need = min(2000ms, 90% of this clip's length)`, which satisfies both without
     a special case.

     ⚠⚠ ONE PASS, BUT ONE LISTEN PER REPETITION ACTUALLY HEARD (owner, 2026-08-23). This used to
     award the whole repeat setting the instant the dwell elapsed: at repeats=4, three seconds of a
     block credited FOUR listens, so skipping after a moment recorded a sentence as heard four
     times. The repetitions are now credited one at a time, each when its own audio has played —
     which is what the setting means. The PASS is still one per trip through the block.
     ⚠ An earlier version of this comment said "repeats are one listen, not four — do not fix this
     by counting per repetition". That was the rule before the 2026-08-22 roll-up change made
     repetitions the number on the pill; it is retired, not merely reworded.

     ⚠ WALL-CLOCK DWELL, NOT `currentTime - block.start`. Seeking into the middle of a block makes
     the latter instantly large, so a scrub would count every block it crossed — the exact thing
     the dwell exists to prevent. Time is accumulated only from timeupdate ticks, which fire only
     while audio is running, so a paused player accrues nothing. */
  var plysDwell = null;   // { num, ms, last, need, ths, rp, heard, sent }

  /* Report ONE sentence heard. This is the single choke point for both counters, and that is
     deliberate (owner, 2026-08-20):
       · ThaiEarAuth.notePlay  -> sentence_plays, the per-sentence number on the pills and cards.
       · ThaiEarAttrib.noteListen -> user_activity.listens, the aggregate retention series.
     ⚠⚠ THEY MUST STAY WIRED TO THE SAME CALL. `listens` used to increment off the media `play`
     event, which on the dyn player counted a whole 32-sentence session as ONE and five
     pause/resumes as SIX. Driving both from here makes `listens` by construction the SUM of the
     values in sentence_plays.counts. Split them and they drift apart permanently, for a reason
     nobody could reconstruct later.
     ⚠ Same increment, not the same total: `listens` carries pre-v357 history recorded under the
     old audio-starts semantics, so the running totals differ on any row that predates it.
     auth.js no-ops when signed out, so no guard is needed here. */
  /* ⚠⚠ COUNT AGAINST THE GLOBAL SENTENCE NUMBER, NEVER THE PAGE'S `num`.
     On a PLAYLIST, `s.num` is a SYNTHETIC page-unique id (100001 + index, minted in
     playlists.html) and the real spreadsheet number lives in `clipNum`. Counting `s.num` there
     wrote every playlist play to keys 100001, 100002, ... — so a sentence played in a playlist
     and the same sentence played on its topic page were two different counters that could never
     agree, which is exactly what the owner reported. The whole cross-surface design depends on
     one key per sentence.
     This is the established convention in this file (see sentFileFor, dynClipKey, dynDlGroups):
     `clipNum` when present, `num` otherwise. Topic pages have no clipNum, so they are unchanged. */
  function globalNumOf(s, fallback) {
    return (s && s.clipNum != null) ? s.clipNum : fallback;
  }
  function notePlaySentence(num, reps) {   // reps = repetitions HEARD, not the repeat setting
    var g = globalNumOf(sentById(num), num);
    /* ⚠ ONE PASS, `reps` REPETITIONS. The dyn player repeats the Thai inside a single block, so
       one trip through a card at repeats=4 is ONE pass and FOUR listens. Both go in the same call
       for the same reason both counters go in the same batch: they must not drift. */
    reps = Math.max(1, parseInt(reps, 10) || 1);
    var a = window.ThaiEarAuth;
    if (a && a.notePlay) { try { a.notePlay(g, 1, reps); } catch (_) {} }
    var at = window.ThaiEarAttrib;
    /* user_activity.listens counts SENTENCES heard, so it takes the repetitions too — that is
       what makes it the sum of sentence_plays.reps by construction. */
    if (at && at.noteListen) { try { at.noteListen(reps); } catch (_) {} }
  }
  /* ⚠⚠ THE CREDIT IS EMITTED WHEN THE BLOCK IS LEFT, NOT WHEN THE FIRST REPETITION LANDS, AND
     THAT IS FORCED BY THE SERVER CONTRACT. `/api/plays` reads `reps[k]` only for keys that carry a
     POSITIVE `deltas[k]` (a pass) and silently drops the rest, so there is no way to say "one more
     repetition, no additional pass" in a second call. One trip through a block is one pass, so it
     gets exactly one call — carrying however many repetitions were actually heard.
     The visible consequence is that the pill ticks up as you LEAVE a sentence rather than two
     seconds into it. Every exit path must therefore reach this: a change of block, the end of the
     session, a teardown, and the page being hidden. */
  function plysDwellFlush() {
    if (plysDwell && plysDwell.heard > plysDwell.sent) {
      notePlaySentence(plysDwell.num, plysDwell.heard - plysDwell.sent);
      plysDwell.sent = plysDwell.heard;
    }
  }
  function plysDwellReset() { plysDwellFlush(); plysDwell = null; }
  /* Advance the dwell for whichever block is live. `t` is the playhead, `b` that block's map
     entry. */
  function plysDwellTick(num, b, t) {
    var now = Date.now();
    var th0 = (b && b.th0 != null) ? b.th0 : (b ? b.start : 0);
    if (!plysDwell || plysDwell.num !== num) {
      plysDwellFlush();                       // the block we are leaving gets its credit first
      /* The repeat count of the SESSION actually playing, not the live control: a session built at
         repeats=4 keeps playing four repeats even if the slider is moved afterwards, and what the
         listener heard is what counts. dynParseKey is the one place that decoding lives. */
      var pk = (dynSession && dynSession.key) ? dynParseKey(dynSession.key) : null;
      var rp = Math.max(1, (pk && pk.rp) || dynRepeats || 1);
      /* ⚠ PER REPETITION, NOT PER BLOCK. `need` is the old dwell rule — 2s, or 90% of the audio
         for the 140 clips shorter than that — applied to ONE repetition. Where the session
         predates `ths` the clip length is unknown, so the block is divided by the repeat count;
         that is an approximation, and it is why the exact starts are now stored. */
      var thLen = (b && b.thLen) || ((b ? (b.end - th0) : 0) / rp);
      plysDwell = { num: num, ms: 0, last: now, heard: 0, sent: 0, rp: rp,
                    ths: (b && b.ths && b.ths.length === rp) ? b.ths : null,
                    span: Math.max(0.001, (b ? (b.end - th0) : 0) / rp), th0: th0,
                    need: Math.min(2000, Math.max(250, thLen * 900)) };
      return;
    }
    /* ⚠ CLAMP THE INCREMENT. timeupdate fires roughly every 250ms while playing; a gap larger
       than that means playback was paused or the tab was backgrounded, and adding that wall-clock
       time would credit a listen that never happened. */
    var d = now - plysDwell.last;
    plysDwell.last = now;
    if (d > 0 && d <= 600) plysDwell.ms += d;

    /* How many repetitions has the PLAYHEAD carried us through? Exact when the session stores the
       repetition starts; proportional otherwise. */
    var needSec = plysDwell.need / 1000, byPos = 0, i;
    if (plysDwell.ths) {
      for (i = 0; i < plysDwell.ths.length; i++) { if (t >= plysDwell.ths[i] + needSec) byPos++; }
    } else {
      byPos = Math.floor((t - plysDwell.th0) / plysDwell.span + (1 - 0.9));
      byPos = Math.max(0, Math.min(plysDwell.rp, byPos));
    }
    /* ⚠ AND THE WALL CLOCK STILL GATES IT, which is what stops a scrub crediting anything. Seeking
       to the end of a block makes the position test pass instantly; `ms` only accumulates from
       timeupdate ticks, so a scrub arrives with nothing banked and credits nothing. */
    var byTime = Math.floor(plysDwell.ms / plysDwell.need);
    var heard = Math.max(0, Math.min(plysDwell.rp, Math.min(byPos, byTime)));
    if (heard > plysDwell.heard) plysDwell.heard = heard;
  }

  /* The individual ▶ button's half of the dwell rule. A single clip has no pause control — tapping
     it again stops it — so a timer is enough here and there is nothing to accumulate.
     `need = min(2000ms, 90% of the clip)` is what makes "or the clip ending" fall out for free:
     a 1.4s clip needs 1.26s, which elapses before it finishes; a 5s clip needs the full 2s.
     ⚠ Armed from loadedmetadata, because that is the first moment the duration is known. */
  var plysClipTimer = null;
  function plysClipArm(num, dur) {
    plysClipDisarm();
    var need = Math.min(2000, Math.max(250, (dur || 0) * 900));
    plysClipTimer = setTimeout(function () {
      plysClipTimer = null;
      notePlaySentence(num, 1);   // the ▶ button plays the clip once, by definition
    }, need);
  }
  // Stopped, switched away, or failed to load — nothing was heard, so nothing is counted.
  function plysClipDisarm() {
    if (plysClipTimer) { clearTimeout(plysClipTimer); plysClipTimer = null; }
  }

  /* The per-pill chip. ⚠ NOT part of the SSR cards: a play count is per-user, so it cannot be
     baked into static HTML — it is attached here and repainted whenever auth or a play changes.
     That is also why removing flags touches all 93 pages and this touches none of them.
     ⚠ HIDDEN AT ZERO (owner, 2026-08-20). 2,271 pills reading "0" is noise; a topic CARD shows
     its zero, because there it means "not started".
     ⚠⚠ IT COUNTS REPETITIONS, NOT PASSES (owner, 2026-08-22 — changed from getPlayCount()).
     One trip through this card with Thai repeats at 4 adds FOUR, because the listener heard the
     Thai four times and the chip claims "played N times". The PASSES counter is still recorded
     and still synced — it is simply no longer displayed anywhere, now that every roll-up above
     it is listening TIME (topics.js listenCaptionFor). Do not switch this back to getPlayCount()
     to make it agree with something: nothing on screen shows passes any more. */
  var PLAY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><polygon points="4,2 13,8 4,14"/></svg>';

  function plysChipFor(num) {
    var hdr = document.querySelector('#sc-' + num + ' .sentence-header');
    if (!hdr) return null;
    var el = hdr.querySelector('.te-plays');
    if (!el) {
      el = document.createElement('span');
      el.className = 'te-plays';
      el.innerHTML = PLAY_SVG + '<i class="te-plays-n"></i>';
      hdr.appendChild(el);   // order:8 under te-v2 puts it right of the exclude button
    }
    return el;
  }
  /* Repaint every chip. Cheap (a querySelector + two writes per card) and idempotent, so it can
     be called from the auth event, which fires several times during startup. */
  function plysRepaintChips() {
    var a = window.ThaiEarAuth;
    var on = !!(a && a.getUser && a.getUser() && a.getPlayRepCount);
    sentences.forEach(function (s) {
      if (sentLocked(s)) return;                 // locked rows are padlocks, not players
      var n = on ? a.getPlayRepCount(globalNumOf(s, s.num)) : 0;   // playlist: clipNum, not the synthetic id
      var el = plysChipFor(s.num);
      if (!el) return;
      el.classList.toggle('on', on && n > 0);
      var i = el.querySelector('.te-plays-n');
      if (i) i.textContent = n;
      el.setAttribute('aria-label', 'Played ' + n + ' time' + (n === 1 ? '' : 's'));
      el.setAttribute('title', 'You have played this sentence ' + n + ' time' + (n === 1 ? '' : 's'));
    });
  }

  // Highlight the card whose block is playing (called from the timeupdate handler when DYN).
  function dynHighlight(t) {
    var map = dynSession.map, num = null, counting = false;
    var i = dynBlockAt(t);
    if (i >= 0) {
      num = map[i].num;
      /* ⚠ THE DWELL MEASURES THE THAI, NOT THE BLOCK. In English-first the block opens with the
         English translation, so measuring from block start counted a sentence as heard before any
         Thai had played. th0 is where the Thai begins (=== start in Thai-first). A session built
         before 2026-08-20 has no th0 and falls back to start — the old behaviour — until rebuilt. */
      var th0 = (map[i].th0 != null) ? map[i].th0 : map[i].start;
      counting = t >= th0;
    }
    // Runs on EVERY timeupdate, not only on a change of card — the dwell has to accumulate.
    if (num != null && counting) plysDwellTick(num, map[i], t);
    else if (num == null) plysDwellReset();
    if (num === dynLastLive) return;
    if (dynLastLive != null) { var prev = document.getElementById('sc-' + dynLastLive); if (prev) prev.classList.remove('dyn-live'); }
    if (num != null) { var cur = document.getElementById('sc-' + num); if (cur) cur.classList.add('dyn-live'); }
    dynLastLive = num;
  }
  /* -- cross-topic nav with autoplay (dyn pages) --
     Mirrors classic advanceTopic: stay on the page and swap the top player onto the chain
     target. Source priority: (a) the TARGET topic's own persisted dyn session for the current
     mode — accepted as-is, its stored key is authoritative (this page's exclusions are
     irrelevant to it); (b) the pre-rendered static combined TE/ET file as a placeholder.
     A second next/prev from the adopted state falls back to real page navigation. */
  // iPhone fix: the lock-screen/media-session next-track handler can't afford network
  // round-trips, so both neighbours' placeholder URLs are pre-resolved at init (and on mode
  // switch) into this cache, and the persisted-session meta is pre-checked synchronously.
  var dynAdoptCache = {};   // t.page → { mode, src (placeholder URL), sess (restored persisted session) }
  function dynPrefetchNeighbours() {
    resolveDynChain();   // D4 first-use lazy retry — see resolveDynChain's own note
    if (!dynChain) return;
    // Pre-resolve the CURRENT pointer's two chain neighbours (re-run after every hop/mode switch).
    [dynChainStep(-1), dynChainStep(1)].forEach(function (stp) {
      var t = stp && stp.t;
      if (!t || (!t.prefix && !t.dynKey)) return;   // playlist neighbours have no prefix — session-only prefetch
      var mode = currentMode;
      var old = dynAdoptCache[t.page];
      if (old && old.sess && old.sess.url && old.sess !== dynSession) { try { URL.revokeObjectURL(old.sess.url); } catch (_) {} }
      var entry = { mode: mode, src: null, sess: null };
      dynAdoptCache[t.page] = entry;
      if (t.prefix) {
        var file = t.prefix + '_' + mode.toUpperCase() + '.mp3';
        buildUrl(file, t.tier === 'member' || t.tier === 'premium')
          .then(function (u) { entry.src = u; })
          .catch(function () {});   // signed-out on a gated neighbour etc. — adopt falls back to a live mint
      }
      // Round-7 (item 10): restore the neighbour's PERSISTED session eagerly too, so a
      // lock-screen hop resolves synchronously (same shape as classic advanceTopic).
      var meta = t.dynKey ? dynReadMeta(t.dynKey, mode) : null;
      if (meta) dynRestoreSession(t.dynKey, mode, meta).then(function (sess) { if (sess) entry.sess = sess; }).catch(function () {});
    });
  }
  function dynAdoptPlaceholder(t, mode) {
    var c = dynAdoptCache[t.page];
    if (c && c.mode === mode && c.src) return Promise.resolve({ src: c.src, std: true, sess: null });
    // Playlists have no pre-rendered combined file — nothing to fall back on without a session.
    if (!t.prefix) return Promise.reject({ code: 'nosess' });
    var file = t.prefix + '_' + mode.toUpperCase() + '.mp3';
    return buildUrl(file, t.tier === 'member' || t.tier === 'premium')
      .then(function (u) { return { src: u, std: true, sess: null }; });
  }
  // Chain-walk helpers (round-11).
  function dynChainStep(dir, fromIdx) {
    if (!dynChain || dynChain.length < 2) return null;
    var i = (fromIdx == null ? dynChainIdx : fromIdx) + dir;
    if (dynChainWrap) i = (i + dynChain.length) % dynChain.length;
    else if (i < 0 || i >= dynChain.length) return null;
    return { idx: i, t: dynChain[i] };
  }
  /* ⚠ IS THIS CHAIN UNIT LOCKED FOR THIS VISITOR? (r50 — owner found the gap on iPhone, §B7.)
     The entitlement gate used to live ONLY on the page-open path (entitledForPage / the licence
     overlay, which run on mount for THAT page's tier). Adopting a NEIGHBOUR never went through it,
     so with a lapsed licence you could open an adjacent topic, walk the in-player chain to a
     downloaded premium topic, and it constructed and played. Bounded — clips had to be on disk
     already, since otherwise /api/audio denies — but that IS the case C-R1/C-B2 exist to gate:
     downloaded while subscribed, lapsed since, still offline.
     Uses the ONE shared predicate (ThaiEarAuth.lockedFor, r38). Do NOT reimplement the tier rules
     here — that would be a fifth divergent copy, and divergent copies are what produced bug #7,
     §B4 and r40. */
  function dynUnitLocked(t) {
    var a = window.ThaiEarAuth;
    if (!a || typeof a.lockedFor !== 'function') return false;   // stale auth.js → never lock a payer out
    return a.lockedFor({ tier: (t && t.tier) || 'free', prefix: t && t.prefix },
                       { canStoreOffline: !!(OFFLINE || WEB_DL || DYN_WEB_DL) });
  }
  // Can this unit produce audio WITHOUT building? (persisted session — stale ok — or a static
  // placeholder). Locked-screen hops skip units that can't (mirrors classic's nextPlayable skip).
  function dynChainPlayable(t, idx) {
    if (idx === dynHomeIdx && dynSession && dynSessionIsLocal) return true;
    if (t.dynKey) {
      var c = dynAdoptCache[t.page];
      if (c && c.sess) return true;
      if (dynReadMeta(t.dynKey, currentMode)) return true;   // best sync guess (restore may still miss)
    }
    return !!t.prefix;
  }
  // Sentence source for building a FOREIGN playlist unit in place (foreground only): the
  // local playlist cache. Topic units never need this (they always have a placeholder).
  function dynChainSentences(t) {
    if (!t.dynKey || String(t.dynKey).indexOf('pl-') !== 0) return null;
    var id = String(t.dynKey).slice(3), lists = null;
    try { lists = JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) {}
    var p = (lists || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!p || !p.items || !p.items.length) return null;
    return p.items.map(function (it, idx) {
      return { num: 100001 + idx, clipNum: it.num, thai: it.thai, prefix: it.prefix, tier: it.tier || 'free' };
    });
  }
  function dynResolveAdopt(t) {
    /* BACKSTOP for the entitlement skip above (r50, §B7). The chain WALK now refuses to hop onto a
       locked unit, but that is not the only way to get here: the now-playing restore (line ~193)
       sets dynAdopted straight from persisted state, so reopening a page with a premium topic
       "now playing" would adopt it without any walk at all. Guard the adopt itself as well.
       'licence' routes through handleDenied → showLicenceOverlay, which since r41 shows the paywall
       instead when a clean server read has authoritatively said "not subscribed". */
    if (dynUnitLocked(t)) { dynLog('adopt: REFUSED (not entitled)'); return Promise.reject({ code: 'licence' }); }
    var mode = currentMode;
    var c = dynAdoptCache[t.page];
    if (c && c.mode === mode) {   // fully pre-resolved (session or placeholder) → synchronous resolve
      if (c.sess) { dynLog('adopt: cached session'); return Promise.resolve({ src: (NATIVE && c.sess.fileUri) ? c.sess.fileUri : c.sess.url, std: false, sess: c.sess }); }
      if (c.src) { dynLog('adopt: cached placeholder'); return Promise.resolve({ src: c.src, std: true, sess: null }); }
    }
    var meta = t.dynKey ? dynReadMeta(t.dynKey, mode) : null;   // synchronous pre-check (stale-lenient by design)
    /* WHICH BRANCH did the adopt take? To the BOOT TRACE, because this is the difference between
       "restored a real session from disk" (works offline) and "fell back to the prefab TE/ET file"
       (network-only — dyn downloads never fetch TE/ET, so offline it CANNOT work). That distinction
       is the likeliest explanation for the iPhone-airplane failure passing on Android, and it can
       only be told apart by looking. */
    if (!meta) {
      dynLog('adopt: placeholder (no meta)');
      return dynAdoptPlaceholder(t, mode).catch(function (e) {
        if (!(e && e.code === 'nosess')) return Promise.reject(e);
        return dynAdoptBuild(t);
      });
    }
    return dynRestoreSession(t.dynKey, mode, meta).then(function (sess) {
      if (sess) { dynLog('adopt: restored persisted'); return { src: (NATIVE && sess.fileUri) ? sess.fileUri : sess.url, std: false, sess: sess }; }
      dynLog('adopt: placeholder (restore miss)');
      return dynAdoptPlaceholder(t, mode);
    }).catch(function (e) {
      if (!(e && e.code === 'nosess')) return Promise.reject(e);
      return dynAdoptBuild(t);
    });
  }
  // Round-11: a playlist unit with no session and no placeholder can still be BUILT in place —
  // but only in the foreground (never from the lock screen; the chain walk skips it there).
  function dynAdoptBuild(t) {
    if (document.visibilityState !== 'visible') return Promise.reject({ code: 'nosess' });
    var sents = dynChainSentences(t);
    if (!sents) return Promise.reject({ code: 'nosess' });
    dynLog('adopt: building ' + t.dynKey);
    dynStatus('Constructing dynamic mp3 file', true);
    var mode = currentMode;
    // r16: build it with the TARGET unit's own settings, not this page's.
    var st = dynSettingsFor(t.dynKey, mode);
    return dynBuildSessionFor(sents, t.dynKey, dynKeyFor(sents, st), function (d, tot) {
      var cEl = $('dyn-status-count'); if (cEl) cEl.textContent = d + '/' + tot;
    }, st).then(function (sess) {
      dynPersistSessionFor(sess, mode, t.dynKey);
      dynStatus(null);
      var entry = dynAdoptCache[t.page];
      if (entry && entry.mode === mode) entry.sess = sess;   // future hops resolve synchronously
      return { src: (NATIVE && sess.fileUri) ? sess.fileUri : sess.url, std: false, sess: sess };
    }).catch(function (e) { dynStatus(null); return Promise.reject(e); });
  }
  // Now-playing strip, set directly — topics.js can't resolve test pages. The name is a LINK
  // to the playing topic's page (round-7 item 9); the strip's existing `a` styling (accent,
  // no underline) covers it.
  function dynStripPaint(t, std) {
    var box = $('now-playing'), txt = $('now-playing-text');
    if (box) box.classList.add('show');
    if (txt) {
      // Round-10 item 2: classic-strip parity — the name links to the playing page AND a
      // ↩ Return action un-adopts in place (same red np-return styling as classic).
      /* Colour the link by the PLAYED unit's tier — premium gold, member purple — mirroring the
         classic strip and nav.js's `.te-np-premium`. The `.np-premium` / `.np-member` rules already
         existed for the classic path; the dyn strip simply never applied them (owner, 2026-07-31).
         Pinning matters here: this link sits inside #player-root, where a premium PAGE remaps
         --accent to gold, so a free/member destination would otherwise inherit the wrong colour. */
      var npTier = (t.tier === 'premium') ? ' np-premium' : (t.tier === 'member' ? ' np-member' : '');
      txt.innerHTML = '<a class="dyn-np-link' + npTier + '" href="' + escapeHtml(pageLinkHref(t.page)) + '">Now playing: <strong>' + escapeHtml(t.name) + '</strong></a>' +
        (std ? ' — standard audio' : '') +
        ' <a href="#" class="np-return" id="dyn-np-return" title="Bring the player back to this page">↩ Return</a>';
      var rb = $('dyn-np-return');
      if (rb) rb.onclick = function (e) { e.preventDefault(); dynReturnLocal(); };
    }
  }
  // Un-adopt IN PLACE and resume this page's own session — shared by the strip's ↩ Return and
  // the lock-screen back-hop (a page navigation from the lock screen kills playback on iOS).
  function dynReturnLocal() {
    dynLog('return local');
    dynAdopted = null;
    dynChainIdx = dynHomeIdx;       // the pointer comes home with us
    dynTitle = dynChain && dynChain[dynHomeIdx] ? dynChain[dynHomeIdx].name : null;
    dynAttached = false;
    dynStdRemote = false;
    dynLastPos = 0;
    dynResumeNum = null;   // r197: different unit — its map's nums mean nothing here
    mainPage = PAGE_HREF; mainPrefix = PREFIX; mainGated = GATED; mainTier = TIER;
    currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
    mainSrcReady = false;
    var rf = $('scrubber-fill'); if (rf) rf.style.width = '0%';
    var rc = $('time-cur'); if (rc) rc.textContent = '0:00';
    var rnp = $('now-playing'); if (rnp) rnp.classList.remove('show');
    // Lenient (round-10 item 3): play the latest LOCAL persisted session even if its key is
    // stale — reconstruction only happens on a real foreground play press.
    ensureMainSrc(true).then(function () { if (!dynAdopted) return mainAudio.play(); })
      // setupMediaSession() also rewrites the lock-screen title from dynTitle (r59), which
      // dynReturnLocal has already reset to the home unit. Without it, coming home kept naming the
      // topic we just left while playing this one.
      .then(function () { dynLog('return-local play ok'); if (!dynAdopted) { setMainIcon(true); setupMediaSession(); dynPrefetchNeighbours(); } })
      .catch(function (e) { dynLog('return-local FAIL ' + ((e && (e.name || e.code)) || e)); handleDenied(e, mainTier); });
  }
  // SYNCHRONOUS half of adoption — mirrors classic advanceTopic's sync identity swap.
  function dynApplyAdoptState(t) {
    if (dynSession && dynSession.url && dynSessionIsLocal) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
    dynLastPos = 0;                 // new track — resume guard must not drag the old position over
    dynResumeNum = null;            // r197: ditto for the sentence anchor
    dynAttached = false;            // we're deliberately re-sourcing the player
    dynSession = null;              // the resolve step lands the target's session (if it has one)
    dynSessionIsLocal = false;
    dynStdRemote = true;
    dynAdopted = t;
    dynTitle = t.name;              // lock screen must show the unit ACTUALLY playing (round-11 item 2)
    mainPage = t.page;
    mainPrefix = t.prefix;
    mainTier = (t.tier === 'member' || t.tier === 'premium') ? t.tier : null;
    mainGated = !!mainTier;
    currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
    mainSrcReady = false;
    if (dynLastLive != null) { var pc = document.getElementById('sc-' + dynLastLive); if (pc) pc.classList.remove('dyn-live'); dynLastLive = null; }
    dynStripPaint(t, true);
    dynSyncSentBtns();   // session nulled until the resolve lands
  }
  function dynAdvance(t, revertIdx) {
    // Structurally IDENTICAL shape to classic advanceTopic (works from the iPhone lock
    // screen): synchronous state swap + transport reset, then ONE promise hop that sets
    // src → load → play. dynResolveAdopt resolves synchronously when pre-resolved; a
    // sessionless playlist unit builds in place — foreground only. NEVER navigates.
    /* r26: do NOT pause first. Classic advanceTopic never does — it keeps the element playing
       right up to the src assignment, which implicitly stops it. Pausing leaves a window where
       no audio is playing, and WebKit suspends media LOADING for a backgrounded page without an
       active audio session: the owner's lock-screen hop showed src set instantly and play()
       then hanging five seconds until he unlocked, rather than rejecting. Only pause in the
       foreground, where there is no session to lose and stopping the old audio promptly is the
       nicer behaviour. */
    if (!mainAudio.paused && document.visibilityState === 'visible') mainAudio.pause();
    setMainIcon(false);
    dynApplyAdoptState(t);
    var f = $('scrubber-fill'); if (f) f.style.width = '0%';
    var c = $('time-cur'); if (c) c.textContent = '0:00';
    var tt = $('time-total'); if (tt) tt.textContent = '0:00';
    dynResolveAdopt(t).then(function (r) {
      if (dynAdopted !== t) return;                 // superseded by a newer hop
      dynSession = r.sess;
      dynStdRemote = r.std;
      dynSyncSentBtns();                            // placeholder hop → ① grey; session hop → live
      if (!r.std) dynStripPaint(t, false);
      dynLog('src set (' + (r.std ? 'std' : 'dyn') + ', ' +
        (String(r.src || '').indexOf('blob:') === 0 ? 'blob' : 'url') + ')');
      mainAudio.src = r.src;
      mainAudio.load();
      mainSrcReady = true;
      dynPreAdvanced = false;
      // If play() hangs again, these say whether the element is stuck LOADING (readyState
      // stays 0 while backgrounded) or whether it loaded fine and play() itself was blocked.
      if (DYN_DBG) {
        var t0 = Date.now();
        try {
          mainAudio.addEventListener('canplay', function onc() {
            mainAudio.removeEventListener('canplay', onc);
            dynLog('canplay after ' + (Date.now() - t0) + 'ms rs=' + mainAudio.readyState);
          });
        } catch (_) {}
        setTimeout(function () { dynLog('t+1s rs=' + mainAudio.readyState + ' paused=' + mainAudio.paused); }, 1000);
      }
      return mainAudio.play();
    }).then(function () {
      dynLog('play ok');
      // r28a: RE-REGISTER the media-session handlers after a hop. iOS derives the lock-screen
      // control set from which handlers are present, and a new media source can drop them —
      // when that happened the owner saw ±15s skip + a scrubber (iOS's defaults) instead of our
      // prev/next topic buttons. Every other play path already re-registers; this one did not.
      // setupMediaSession() now writes the title itself (r59), so the explicit call r58 added here
      // is redundant — one writer, every path, rather than one per call site.
      if (dynAdopted === t) { setMainIcon(true); setupMediaSession(); dynPrefetchNeighbours(); }
    }).catch(function (e) {
      dynLog('adopt FAIL ' + ((e && (e.name || e.code)) || '') + ' ' + ((e && e.message) || ''));
      /* ⚠ ALSO to the BOOT TRACE. dynLog does not reach it, so this failure was invisible on a
         phone — and it is the one the owner hit on iPhone in airplane mode (strip flashes, then
         the page snaps back to 0:00 paused: that is this revert). The error NAME is the whole
         diagnosis — `NotAllowedError` means play() lost the user-gesture token across the adopt
         (WebKit is strict where Android is not), which is a different fix from a load failure. */
      // Round-11: never location.href from transport/lock — put the pointer back where it was.
      if (revertIdx != null && dynChain) {
        dynChainIdx = revertIdx;
        dynAdopted = (revertIdx === dynHomeIdx) ? null : dynChain[revertIdx];
        dynTitle = dynChain[revertIdx] ? dynChain[revertIdx].name : dynTitle;
        if (!dynAdopted) { var rnp = $('now-playing'); if (rnp) rnp.classList.remove('show'); }
      }
      if (!(e && e.code === 'nosess')) handleDenied(e, (t.tier === 'member' || t.tier === 'premium') ? t.tier : null);
    });
  }
  /* -- batch add-to-playlist (select mode) --
     dyn-addpl-btn → playlist chooser modal → SELECT MODE: card taps toggle a tick instead of
     the reveal-cycle (play/tortoise still work, so a sentence can be previewed while choosing),
     a fixed bottom bar shows the count, Done diffs against what the playlist already holds for
     this topic and saves adds/removes sequentially. */
  var dynSel = null;          // { id, name, pre:{num:true}, real:{num:true}, now:{num:true}, plsel, pend } while selecting
  var dynSelListener = null;  // the capture-phase click filter on #sentence-list
  var dynSelPrevStates = null; // reveal stages saved on select-mode entry (cards force st-3 while selecting)
  // PLSEL mode: the page was opened from playlists.html's "Add sentences" flow (?plsel=id&pln=name).
  // Select mode auto-starts for that playlist and diffs travel across topic pages via sessionStorage.
  var dynPlsel = null;
  if (DYN) {
    var _plm = /[?&]plsel=([^&]+)/.exec(location.search);
    if (_plm) {
      var _pln = /[?&]pln=([^&]*)/.exec(location.search);
      try { dynPlsel = { id: decodeURIComponent(_plm[1]), name: _pln ? decodeURIComponent(_pln[1]) : 'Playlist' }; } catch (_) { dynPlsel = null; }
    }
  }
  function dynTopicKey() { return cfg.dynKey || PREFIX; }
  function dynSentByNum(num) {
    for (var i = 0; i < sentences.length; i++) { if (sentences[i].num === num) return sentences[i]; }
    return null;
  }
  /* r145 — THE NUGGET NOW CARRIES THE NOTES (gloss chips + cultural note).
     A playlist item is a self-contained display nugget by design (playlists_schema.sql: "items
     carry a display nugget … so playlist pages render without loading topic pages"), but it only
     ever captured thai/translit/english. The playlist player therefore built every sentence with
     `gloss: []`, its stage-3 row rendered nothing, and cycle() shortened the cycle to 3 — which is
     exactly the owner-reported bug: "third tap, no gloss chips, just closes". Capture them at ADD
     time from the topic page, which is the authoritative source for both fields.
     ⚠ gloss rows are PAIRS ["word","gloss"] on most topics and TRIPLES ["word","gloss","translit"]
     on 01–03 — store the array as-is (jsonb), never normalise it; chipHtml() handles both shapes. */
  function dynItemPayload(num) {
    var s = dynSentByNum(num);
    if (!s) return null;
    return { topic_key: dynTopicKey(), num: num, prefix: PREFIX, tier: TIER || 'free',
      thai: s.thai, translit: s.translit || null, english: s.english,
      gloss: (s.gloss && s.gloss.length) ? s.gloss : null, cultural: s.cultural || null };
  }
  // Cross-page pending state for the plsel flow.
  function dynPendRead() {
    try {
      var p = JSON.parse(sessionStorage.getItem('te_plsel') || 'null');
      if (p && p.id && p.adds && p.removes) return p;
    } catch (_) {}
    return null;
  }
  function dynPendWrite(p) { try { sessionStorage.setItem('te_plsel', JSON.stringify(p)); } catch (_) {} }
  function dynPendClear() { try { sessionStorage.removeItem('te_plsel'); } catch (_) {} }
  function dynAddPlClick() {
    var a = window.ThaiEarAuth;
    /* TIER FIRST (owner, 2026-08-10): you may not put PREMIUM sentences in a playlist unless you
       are entitled to them. Previously this checked sign-in only, so a signed-in free account
       could select premium sentences and save them — they were padlocked at playback by
       sentLocked(), so no audio leaked, but the affordance implied an entitlement that wasn't
       there. On a premium topic the tier is the real blocker, so gate(TIER) gives the premium
       message (app → neutral sheet, web → paywall) rather than a sign-in prompt that would not
       unlock it. ⚠ No-op inside PLMODE: playlists.html declares itself tier:'free' and gates
       per-SENTENCE instead, which is the correct behaviour for a page that mixes topics. */
    if (!entitledForPage()) { gate(TIER); return; }
    // Then the account: playlists are a signed-in FEATURE (they live in the account dropdown
    // alongside My Progress and My Sentences). Signed out → the free sign-in page, not a raw alert.
    if (!a || !(a.getUser && a.getUser())) { gateSignIn(); return; }
    /* 2026-08-09 — THE OFFLINE BLOCK IS GONE. It used to bail here with "adding or removing
       sentences needs a connection", because auth.js's create/addItem/remove all POSTed and
       rejected with no connection, so the old flow let you pick sentences and THEN failed with a
       raw "TypeError: failed to fetch". Those methods now apply locally and queue to an outbox
       (see the OFFLINE WRITE OUTBOX header in auth.js), so the whole flow works on a plane and
       syncs on reconnect. Nothing here needs a network check any more — dynSelDone's own
       network-error branch stays as the backstop for the case navigator.onLine lies about. */
    var PL = a.playlists;
    if (!PL || !PL.load) { dynMsg('Playlists unavailable', 'Try again in a moment.'); return; }
    PL.load().then(function (lists) { dynShowChooser(lists || []); })
      .catch(function (e) {
        var m = (e && (e.message || e.code)) || 'unknown error';
        dynMsg('Couldn’t load your playlists', /failed to fetch|load failed|network/i.test(String(m))
          ? 'You appear to be offline. Reconnect and try again.' : String(m));
      });
  }
  // Playlist chooser (reuses the dyn-pl-* popup styling from player-dyn.css, linked on dyn pages).
  /* Styled message dialog. These were raw alert()s — the grey system box the owner has objected to
     repeatedly — for states that are NORMAL rather than exceptional (offline, a dropped save). It
     reuses the playlist chooser's own furniture (#dyn-pl-pop + .dyn-pl-card, player-dyn.css, linked
     on every dyn page), so it is the site's dialog, not a second one invented here. */
  function dynMsg(title, text, okLabel, onClose) {
    var old = document.getElementById('dyn-pl-pop'); if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'dyn-pl-pop';
    wrap.innerHTML = '<div class="dyn-pl-card">' +
      '<div class="dyn-pl-head">' + escapeHtml(title) + '</div>' +
      '<div class="dyn-pl-empty">' + escapeHtml(text) + '</div>' +
      '<div class="dyn-pl-foot"><button type="button" class="dyn-pl-done">' +
        escapeHtml(okLabel || 'OK') + '</button></div></div>';
    document.body.appendChild(wrap);
    /* onClose fires on EITHER dismissal route. Some callers navigate afterwards, and unlike alert()
       this dialog does not block — without it the redirect would fire before the message was read. */
    function shut() { wrap.remove(); if (onClose) onClose(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) shut(); });
    wrap.querySelector('.dyn-pl-done').addEventListener('click', shut);
  }
  /* Single text input in the same shell as dynMsg/dynConfirm. Added 2026-08-09 for "＋ New
     playlist" in the chooser; player.js had a message box and a confirm but no prompt, and a raw
     window.prompt() is the grey system dialog the owner has objected to repeatedly (it is also
     blocked outright in some WebViews). Calls back only with a non-empty, trimmed name. */
  function dynPrompt(title, placeholder, okLabel, onOk) {
    var old = document.getElementById('dyn-pl-pop'); if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'dyn-pl-pop';
    wrap.innerHTML = '<div class="dyn-pl-card">' +
      '<div class="dyn-pl-head">' + escapeHtml(title) + '</div>' +
      '<div class="dyn-pl-body"><input type="text" class="dyn-pl-input" maxlength="60" ' +
        'placeholder="' + escapeHtml(placeholder || '') + '" autocomplete="off"></div>' +
      /* ⚠ Button roles are the REVERSE of dynConfirm's on purpose. There, .dyn-pl-alt (the quiet
         outlined one) carries the destructive "leave anyway" and the accent pill is the safe
         "stay" — per the note on .dyn-pl-alt in player-dyn.css. Creating a playlist is not
         destructive, it is the primary action, so here the accent pill IS Create and the quiet
         button is Cancel. Same convention underneath: safe/primary on the right. */
      '<div class="dyn-pl-foot">' +
        '<button type="button" class="dyn-pl-done dyn-pl-alt">Cancel</button>' +
        '<button type="button" class="dyn-pl-done">' + escapeHtml(okLabel || 'OK') + '</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    var input = wrap.querySelector('.dyn-pl-input');
    function shut() { wrap.remove(); }
    /* Hand control back on a LATER task, not inside this gesture. Whatever onOk() puts on screen
       must not be able to receive the tail of the tap that dismissed this dialog — see the
       click-through note in dynSelBarBuild(). The bar's own dead time is the real guard; this
       simply keeps the two events in different tasks so they cannot interleave. */
    function go(e) {
      var v = (input.value || '').trim();
      if (!v) { input.focus(); return; }   // never create an unnamed playlist
      if (e) { e.preventDefault(); e.stopPropagation(); }
      shut();
      setTimeout(function () { onOk(v); }, 0);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) shut(); });
    wrap.querySelector('.dyn-pl-alt').addEventListener('click', shut);
    wrap.querySelector('.dyn-pl-done:not(.dyn-pl-alt)').addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    // Deferred: iOS ignores focus() called synchronously inside the tap that opened the dialog.
    setTimeout(function () { try { input.focus(); } catch (_) {} }, 60);
  }
  /* Two-button confirm in the same shell as dynMsg — used by the leave-guard below. */
  function dynConfirm(title, text, okLabel, cancelLabel, onOk) {
    var old = document.getElementById('dyn-pl-pop'); if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'dyn-pl-pop';
    wrap.innerHTML = '<div class="dyn-pl-card">' +
      '<div class="dyn-pl-head">' + escapeHtml(title) + '</div>' +
      '<div class="dyn-pl-empty">' + escapeHtml(text) + '</div>' +
      '<div class="dyn-pl-foot">' +
        '<button type="button" class="dyn-pl-done dyn-pl-alt">' + escapeHtml(okLabel) + '</button>' +
        '<button type="button" class="dyn-pl-done">' + escapeHtml(cancelLabel) + '</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    function shut() { wrap.remove(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) shut(); });
    wrap.querySelector('.dyn-pl-done:not(.dyn-pl-alt)').addEventListener('click', shut);
    wrap.querySelector('.dyn-pl-alt').addEventListener('click', function () { shut(); onOk(); });
  }
  /* ── LEAVE GUARD ─────────────────────────────────────────────────────────────────────────────
     Navigating away mid-download silently abandons it. `beforeunload` (line ~398) still fires, but
     ⚠ ITS DIALOG CANNOT BE STYLED OR REWORDED — every major browser has ignored author-supplied
     text since ~2016 and renders its own generic "Changes you made may not be saved" in browser
     chrome, by design, so a page cannot write a deceptive message into a native dialog.
     So we intercept the case we CAN own: a click on an internal link. That is the realistic route
     out on a phone (the nav, a topic card, prev/next), and it gets the site's own dialog with
     wording that actually says what is at stake. `beforeunload` stays as the un-stylable backstop
     for tab close, the URL bar and gestures we cannot see.
     Not covered, deliberately: `location.href = …` assignments in JS (no event to hook) and the
     Android hardware back button (a Capacitor `backButton` listener — needs on-device verification,
     so it is listed in §C rather than written blind). */
  function installLeaveGuard(isBusy, ask) {
    var bypass = false;
    document.addEventListener('click', function (e) {
      if (bypass || !isBusy()) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      // Leave in-page anchors, protocol links and new-tab links alone — none of them end the page.
      if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;
      if (a.target && a.target !== '_self') return;
      e.preventDefault(); e.stopPropagation();
      ask(function () { bypass = true; window.location.href = a.href; });
    }, true);   // capture: run before the page's own link handlers
  }
  installLeaveGuard(function () { return downloadingNow; }, function (proceed) {
    dynConfirm('Download in progress',
      'If you leave now, this download won’t finish. You can start it again any time.',
      'Leave anyway', 'Keep downloading', proceed);
  });
  function dynShowChooser(lists) {
    var old = document.getElementById('dyn-pl-pop'); if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'dyn-pl-pop';
    /* ＋ NEW PLAYLIST, INSIDE THE CHOOSER (2026-08-09). The empty state used to read "create one
       in My Playlists first", which sent you to another page to do the obvious next thing — and
       offline that made playlist creation feel half-built even though auth.js supports it.
       Deliberately a ROW here rather than a third button on the page: the topic page already
       carries "＋ Add to a playlist" and "🎵 My playlists" side by side, and a third would be
       clutter (a "Playlists" dropdown holding all three was considered and rejected as
       over-engineering for two controls). It is also the SHORTER flow — tap, name it, and you land
       straight in select mode on the new list, whereas a top-level button would create an empty
       playlist and leave you on a topic page having to tap Add anyway.
       Present online and offline alike; a mode-dependent entry point would be worse than either. */
    var newRow = '<button type="button" class="dyn-pl-row dyn-pl-new" data-new="1">' +
      '<span class="dyn-pl-name">＋ New playlist</span></button>';
    var rows = newRow + lists.map(function (p, i) {
      return '<button type="button" class="dyn-pl-row" data-i="' + i + '">' +
        '<span class="dyn-pl-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="dyn-pl-count">' + ((p.items && p.items.length) || 0) + '</span></button>';
    }).join('');
    wrap.innerHTML = '<div class="dyn-pl-card"><div class="dyn-pl-head">' +
        (lists.length ? 'Add sentences to…' : 'Playlists') + '</div>' +
      (lists.length ? '' : '<div class="dyn-pl-empty">No playlists yet — make your first one.</div>') +
      '<div class="dyn-pl-body">' + rows + '</div>' +
      '<div class="dyn-pl-foot"><button type="button" class="dyn-pl-done">Cancel</button></div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('.dyn-pl-done').addEventListener('click', function () { wrap.remove(); });
    wrap.querySelector('.dyn-pl-new').addEventListener('click', function () {
      wrap.remove();
      dynPrompt('New playlist', 'Playlist name', 'Create', function (name) {
        var a2 = window.ThaiEarAuth, PL2 = a2 && a2.playlists;
        if (!PL2) { dynMsg('Playlists unavailable', 'Try again in a moment.'); return; }
        /* create() resolves optimistically with a client-minted id since the offline outbox
           landed (auth.js), so this works with or without a connection. */
        PL2.create(name.slice(0, 60)).then(function (p) {
          if (p) dynEnterSelect(p);
        }).catch(function (e) {
          dynMsg('Couldn’t create the playlist', String((e && (e.message || e.code)) || 'unknown error'));
        });
      });
    });
    wrap.querySelectorAll('.dyn-pl-row').forEach(function (rowBtn) {
      rowBtn.addEventListener('click', function () {
        var p = lists[+rowBtn.getAttribute('data-i')];
        wrap.remove();
        if (p) dynEnterSelect(p);
      });
    });
  }
  // Bottom action bar — (re)built on every select-mode entry (plsel changes the count text
  // and the Cancel destination; topic movement happens via "Back to topic selection", not here).
  function dynSelBarBuild(plsel) {
    var bar = $('dyn-sel-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'dyn-sel-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<span id="dyn-sel-count"></span>' +
      '<span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">' +
        '<button type="button" class="dyn-sel-cancel">Cancel</button>' +
        '<button type="button" class="dyn-sel-done">Done</button>' +
      '</span>';
    /* r158 briefly added a 450ms dead time on these buttons, on the theory that a synthesised
       click was firing Done the instant the bar appeared. WRONG, and the owner caught it in one
       line: "if done is clicked - why am i still on the selection screen?" dynExitSelect() hides
       this bar and restores the cards, so a stray Done would have ejected him from select mode
       rather than leaving him in it. The real cause was a duplicated click listener — see the ⚠⚠
       note in dynEnterSelect(). Reverted, because it delayed a legitimate tap for no reason. */
    bar.querySelector('.dyn-sel-cancel').addEventListener('click', plsel ? dynPlselCancel : dynExitSelect);
    bar.querySelector('.dyn-sel-done').addEventListener('click', dynSelDone);
    return bar;
  }
  function dynSelCountPaint() {
    var c = $('dyn-sel-count'); if (!c || !dynSel) return;
    var k;
    if (dynSel.plsel && dynSel.pend) {
      // Live running total: playlist size at flow start + all pending diffs, with THIS
      // page's stored diff replaced by the current live one.
      var tk = dynTopicKey(), pend = dynSel.pend, addsN = 0, remsN = 0;
      for (k in pend.adds) { if (k !== tk) addsN += pend.adds[k].length; }
      for (k in pend.removes) { if (k !== tk) remsN += pend.removes[k].length; }
      for (k in dynSel.now) { if (!dynSel.real[k]) addsN++; }
      for (k in dynSel.real) { if (!dynSel.now[k]) remsN++; }
      c.textContent = '「' + dynSel.name + '」 · ' + (pend.base + addsN - remsN) + ' sentences';
      return;
    }
    var n = 0;
    for (k in dynSel.now) { if (dynSel.now[k]) n++; }
    c.textContent = n + ' selected';
  }
  function dynSelToggle(card, tickEl) {
    if (!dynSel) return;
    var num = +String(card.id).replace('sc-', '');
    if (dynSel.now[num]) delete dynSel.now[num]; else dynSel.now[num] = true;
    if (tickEl) tickEl.classList.toggle('on', !!dynSel.now[num]);
    dynSelCountPaint();
  }
  // pend (optional) = the cross-page plsel state; its presence switches on plsel behaviour.
  function dynEnterSelect(p, pend) {
    var tk = dynTopicKey();
    /* r146 — MATCH ON ANY OF THIS PAGE'S IDENTITIES, NOT JUST TODAY'S KEY (owner, 2026-08-08:
       "all already held sentences should pre-tick").
       playlist_items.topic_key is not one thing. dynTopicKey() is `cfg.dynKey || PREFIX` and no
       live topic page sets dynKey, so an item added from a topic page is keyed by its AUDIO
       PREFIX ('ColoursAndDescriptions2_BEG'); rows keyed by PAGE FILE ('topic-04b') also exist,
       written by the rollout's owner test pages, which did set dynKey. 51 of the 70 live rows are
       the page-file kind. Matching only `tk` therefore left them unticked — the sentence WAS in
       the playlist, the page said it wasn't, and re-selecting it wrote a SECOND row under the
       other key.
       Any of the three identities counts, and the item's own key is remembered (realKey) so a
       removal deletes the row that actually exists rather than one that never did. Prefix is not
       eternal either — the 2026-07 split program minted new handles — which is exactly why this
       is an OR across all of them and not a migration to one "true" key. */
    var real = {}, realKey = {}, k;
    function itemHere(it) {
      return it.topic_key === tk || it.topic_key === TOPIC_KEY || (!!PREFIX && it.prefix === PREFIX);
    }
    (p.items || []).forEach(function (it) {
      if (!itemHere(it)) return;
      real[it.num] = true;
      realKey[it.num] = it.topic_key;   // delete by the key the row was WRITTEN with
    });
    // pre-ticks = the playlist's real items for this topic, adjusted by any pending diffs
    var pre = {};
    for (k in real) pre[k] = true;
    if (pend) {
      (pend.adds[tk] || []).forEach(function (it) { pre[it.num] = true; });
      // entries are {num,tk} since r146, bare nums in a flow stashed by an older build
      (pend.removes[tk] || []).forEach(function (r) { delete pre[typeof r === 'object' ? r.num : r]; });
    }
    var now = {};
    for (k in pre) now[k] = true;
    dynSel = { id: p.id, name: p.name || (pend && pend.name) || '', pre: pre, real: real, realKey: realKey, now: now, plsel: !!pend, pend: pend || null };
    var list = $('sentence-list');
    if (list) {
      /* ⚠⚠ REMOVE THE PREVIOUS LISTENER FIRST — THE r158 BUG (owner, 2026-08-09).
         This used to overwrite dynSelListener and attach a new listener without detaching the old
         one, so ENTERING SELECT MODE TWICE left two live handlers on #sentence-list. Every tap
         then ran dynSelToggle twice — on, then straight back off — so nothing could be selected,
         while the bar and the ticks looked completely normal. Exactly the reported
         "i cannot select anything".
         The second entry also explains the rest of the report: it recomputes `now` from the chosen
         playlist, so a moment after the first entry every tick flicks OFF ("a few sentences flash
         up as selected … then the selection ticks are gone"), and dynSelBarBuild() re-renders the
         bar, so the user is still sitting in select mode — which is precisely why "if done is
         clicked why am i still on the selection screen" was the right question to ask. Done was
         never clicked; there were simply two listeners.
         HOW IT DOUBLE-ENTERS: an abandoned cross-page plsel flow leaves `te_plsel` in
         sessionStorage, and the restore path below re-enters select mode on the next page load;
         choosing a playlist by hand then enters a second time. sessionStorage is per-session, so
         fully closing and reopening the PWA clears it — the owner's "the only way to get it
         working again is to exit and re-enter". Detaching here makes re-entry idempotent whatever
         the route in. */
      if (dynSelListener) list.removeEventListener('click', dynSelListener, true);
      list.classList.add('dyn-selecting');
      dynSelListener = function (e) {
        var el = e.target;
        if (!el || !el.closest) return;
        /* Ticking happens on the tick (and its enlarged invisible pad — see .dyn-tick::before),
           plus the sentence NUMBER beside it: r146 widens the target and the number is the one
           thing inside it that can stick out, since .sent-num grows past its 20px min-width on a
           3-digit card. Nothing else in the header changes behaviour — play, tortoise and the
           reveal cycle are all still live mid-selection. */
        var tick = el.closest('.dyn-tick');
        var card0 = !tick && el.closest('.sent-num') ? el.closest('.sentence-card') : null;
        if (card0) tick = card0.querySelector('.dyn-tick');
        if (tick) {
          e.preventDefault(); e.stopPropagation();
          var card = card0 || tick.closest('.sentence-card');
          if (card) dynSelToggle(card, tick);
          return;
        }
        // flag + exclude are disabled during selection (also dimmed via CSS)
        if (el.closest('.dyn-card-btn')) { e.preventDefault(); e.stopPropagation(); return; }
        // everything else — reveal-cycle, sentence play, tortoise — behaves normally
      };
      list.addEventListener('click', dynSelListener, true);
    }
    /* Cards open revealed to stage 2 — Thai + English, NOT the gloss chips — while selecting;
       previous stages are restored on exit. Round-7 opened them at st-3 (everything), but the
       notes row makes each card tall enough that only two or three fit on a phone screen, and
       choosing sentences is a scanning task: you need to recognise a line, not study it. Owner,
       2026-07-31, refining the original "fully expanded" instruction.
       This is the INITIAL display only — the reveal cycle is untouched, so a tap still expands any
       card to its gloss chips mid-selection. */
    dynSelPrevStates = {};
    sentences.forEach(function (s) {
      dynSelPrevStates[s.num] = states[s.num] || 0;
      states[s.num] = 2;
      syncCard(s.num);
      var t = document.querySelector('#sc-' + s.num + ' .dyn-tick');
      if (t) t.classList.toggle('on', !!dynSel.now[s.num]);
    });
    dynSelBarBuild(!!pend).classList.add('show');
    if (pend) {
      // Lockdown: everything above the sentence list hides (body class, CSS below); the only
      // ways out are the bar's Done/Cancel and this back-to-topic-selection button.
      document.body.classList.add('dyn-plsel');
      if (list && !$('dyn-plsel-back')) {
        var backB = document.createElement('button');
        backB.id = 'dyn-plsel-back'; backB.type = 'button';
        backB.textContent = '← Back to topic selection';
        backB.addEventListener('click', dynPlselBack);
        list.parentNode.insertBefore(backB, list);
      }
    }
    dynSelCountPaint();
    updateMiniVisibility();   // the mini transport yields to the selection bar
  }
  function dynExitSelect() {
    var list = $('sentence-list');
    if (list) {
      list.classList.remove('dyn-selecting');
      if (dynSelListener) list.removeEventListener('click', dynSelListener, true);
    }
    dynSelListener = null;
    dynSel = null;
    // restore the reveal stages the cards had before select mode forced them open
    if (dynSelPrevStates) {
      sentences.forEach(function (s) {
        if (Object.prototype.hasOwnProperty.call(dynSelPrevStates, s.num)) { states[s.num] = dynSelPrevStates[s.num]; syncCard(s.num); }
      });
      dynSelPrevStates = null;
    }
    document.body.classList.remove('dyn-plsel');
    var backB = $('dyn-plsel-back'); if (backB) backB.parentNode.removeChild(backB);
    var bar = $('dyn-sel-bar');
    if (bar) {
      bar.classList.remove('show');
      bar.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    }
    updateMiniVisibility();
  }
  // Fold THIS page's live diff (now vs the playlist's REAL items) into the sessionStorage
  // pending state — item payloads must be captured here, while this page's sentences exist.
  function dynPlselStash() {
    if (!dynSel || !dynSel.plsel) return;
    var pend = dynSel.pend || dynPendRead();
    if (!pend) return;
    var tk = dynTopicKey(), adds = [], removes = [], k;
    for (k in dynSel.now) { if (!dynSel.real[k]) { var pl = dynItemPayload(+k); if (pl) adds.push(pl); } }
    // r146: carry the row's OWN topic_key — see dynEnterSelect for why it may not be this page's.
    for (k in dynSel.real) { if (!dynSel.now[k]) removes.push({ num: +k, tk: dynSel.realKey[k] || tk }); }
    if (adds.length) pend.adds[tk] = adds; else delete pend.adds[tk];
    if (removes.length) pend.removes[tk] = removes; else delete pend.removes[tk];
    dynPendWrite(pend);
    dynSel.pend = pend;
  }
  // "← Back to topic selection": stash this page's diffs, reopen playlists.html's
  // topic-selection view for the same playlist.
  function dynPlselBack() {
    if (!dynSel || !dynSel.plsel) return;
    dynPlselStash();
    location.href = 'playlists.html?plsel=' + encodeURIComponent(dynSel.id) +
      '&pln=' + encodeURIComponent(dynSel.name) + '&k=cu38961y';
  }
  function dynPlselCancel() {
    dynPendClear();
    location.href = 'playlists.html';
  }
  // Auto-entry for the plsel flow: wait for auth + playlists, then open select mode.
  function dynPlselBoot() {
    var tries = 0;
    (function wait() {
      var a = window.ThaiEarAuth;
      if (!a || !a.isReady) {
        if (++tries < 60) setTimeout(wait, 250);
        return;
      }
      if (!(a.getUser && a.getUser())) {
        dynPendClear();
        dynMsg('Sign in to use playlists', 'Playlists are saved to your account.', 'OK',
          function () { location.href = 'playlists.html'; });
        return;
      }
      var PL = a.playlists;
      if (!PL || !PL.load) { dynMsg('Playlists unavailable', 'Try again in a moment.'); return; }
      PL.load().then(function (lists) {
        var p = null;
        (lists || []).forEach(function (x) { if (String(x.id) === String(dynPlsel.id)) p = x; });
        if (!p) {
          dynPendClear();
          dynMsg('Playlist not found', 'It may have been deleted on another device.', 'OK',
            function () { location.href = 'playlists.html'; });
          return;
        }
        var pend = dynPendRead();
        if (!pend || String(pend.id) !== String(p.id)) {
          // First page of the flow: baseline the running total on the playlist's current size.
          pend = { id: p.id, name: p.name || dynPlsel.name, adds: {}, removes: {}, base: (p.items || []).length };
          dynPendWrite(pend);
        }
        dynEnterSelect(p, pend);
      }).catch(function () { dynMsg('Couldn’t load your playlists', 'You appear to be offline. Reconnect and try again.'); });
    })();
  }
  function dynSelDone() {
    if (!dynSel) return;
    var a = window.ThaiEarAuth, PL = a && a.playlists;
    if (!PL) { dynMsg('Playlists unavailable', 'Try again in a moment.'); return; }
    var plsel = dynSel.plsel;
    var id = dynSel.id, name = dynSel.name;
    var ops = [], k;
    if (plsel) {
      dynPlselStash();   // fold this page's diff in, then apply EVERYTHING pending
      var pend = dynSel.pend;
      for (k in pend.adds) {
        pend.adds[k].forEach(function (pl) { ops.push({ add: pl }); });
      }
      for (k in pend.removes) {
        (function (tk2) {
          // r146: {num,tk} since r146, a bare num from a flow stashed by an older build
          pend.removes[tk2].forEach(function (r) {
            ops.push(typeof r === 'object' ? { rmTk: r.tk || tk2, rmNum: r.num } : { rmTk: tk2, rmNum: r });
          });
        })(k);
      }
    } else {
      var tk = dynTopicKey();
      for (k in dynSel.now) { if (!dynSel.real[k]) { var pl = dynItemPayload(+k); if (pl) ops.push({ add: pl }); } }
      // r146: delete by the key the row was written with, not by this page's current key.
      for (k in dynSel.real) { if (!dynSel.now[k]) ops.push({ rmTk: dynSel.realKey[k] || tk, rmNum: +k }); }
    }
    var addsN = 0;
    ops.forEach(function (o) { if (o.add) addsN++; });
    var remsN = ops.length - addsN;
    var bar = $('dyn-sel-bar');
    var btns = bar ? bar.querySelectorAll('button') : [];
    btns.forEach(function (b) { b.disabled = true; });   // Done + Cancel (+ nav) locked while saving
    var cnt = $('dyn-sel-count');
    var chain = Promise.resolve();
    ops.forEach(function (op, i) {
      chain = chain.then(function () {
        if (cnt) cnt.textContent = 'Saving… ' + (i + 1) + ' of ' + ops.length;
        return op.add ? PL.addItem(id, op.add) : PL.removeItem(id, op.rmTk, op.rmNum);
      });
    });
    chain.then(function () {
      if (plsel) { dynPendClear(); location.href = 'playlists.html'; return; }
      dynExitSelect();
      /* ⚠ Only the FALSE case is trusted — navigator.onLine reports *online* in airplane mode in
         this WebView, so `true` proves nothing. That asymmetry is fine here: a genuinely offline
         device gets the reassurance, and a lying one gets the plain message while the outbox syncs
         it anyway. Never the reverse (promising a sync that already happened would be noise). */
      var savedLocally = !navigator.onLine;
      dynStatus('“' + name + '” updated — ' + addsN + ' selected, ' + remsN + ' removed' +
        (savedLocally ? ' · saved on this device, syncs when you’re back online' : ''), false);
      var seq = dynStatusSeq;
      /* The offline line is longer AND carries information the user needs to trust the save
         ("syncs when you're back online"). Owner, 2026-08-09: at 2.5s it "flashes up for too
         short - i can hardly have time to read it." The plain online confirmation keeps 2.5s;
         only the one worth reading gets the longer dwell. */
      setTimeout(function () { if (seq === dynStatusSeq) dynStatus(null); }, savedLocally ? 7000 : 2500);
      /* …and take them back to the top (owner, 2026-08-09). Choosing sentences means scrolling
         down the list, so Done used to leave you stranded at the bottom of a page you had just
         finished with. It also puts the confirmation in view: dynStatus() renders up by the
         player, so the line written just above was landing off-screen for exactly the people who
         had scrolled furthest.
         Done only — Cancel changed nothing, so moving the page under someone who backed out would
         be the more annoying behaviour. Object form guarded: older WebKit ignores it and throws. */
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (_) { window.scrollTo(0, 0); }
    }).catch(function (e) {
      btns.forEach(function (b) { b.disabled = false; });   // stay in select mode so nothing chosen is lost
      dynSelCountPaint();
      /* A dropped connection is the COMMON failure here, not an exceptional one, and
         "Couldn't save: TypeError: failed to fetch" is the worst possible way to say it. Name it
         plainly and keep the raw text only for genuinely unexpected errors. Select mode stays open
         either way, so nothing chosen is lost. */
      var msg = (e && (e.message || e.code)) || 'unknown error';
      if (/failed to fetch|load failed|network|networkerror/i.test(String(msg))) {
        dynMsg('You’re offline', 'Nothing has been lost — your selection is still here. Reconnect and press Done again.');
      } else {
        dynMsg('Couldn’t save', String(msg));
      }
    });
  }
  var DYN_STYLES =
    '.dyn-status{text-align:center;font-size:13px;font-weight:500;color:var(--accent);padding:4px 0;}' +
    '.dyn-dots{display:inline-block;width:1.1em;text-align:left}' +
    ".dyn-dots::after{content:'...';display:inline-block;width:0;overflow:hidden;vertical-align:bottom;animation:dyn-dots 1.2s steps(3,start) infinite}" +
    '@keyframes dyn-dots{from{width:0}to{width:1.05em}}' +
    '.dyn-sent-btn{width:34px;height:34px}' +
    '.dyn-sent-off{opacity:.35;pointer-events:none}' +
    /* r197 rebuild toast — the status line lives at the top of the player, and the whole point of
       the auto-rebuild is that you no longer have to be up there. `position:fixed` + `transform`
       centring so it is OUT of flow and cannot displace the mini player (owner: "it will push
       mini player down which will be unsightly"). Deliberately small. */
    '.dyn-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.96);z-index:9998;' +
      'max-width:calc(100vw - 48px);padding:8px 14px;border-radius:999px;font-size:13px;font-weight:600;' +
      'line-height:1.3;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'background:rgba(24,22,40,.92);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.28);cursor:pointer;' +
      'opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}' +
    '.dyn-toast.show{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto}' +
    'body.premium-topic .dyn-toast{background:#3D2E00;color:#F0CC5C}' +
    '@media (prefers-reduced-motion: reduce){.dyn-toast{transition:opacity .18s ease}' +
      '.dyn-toast,.dyn-toast.show{transform:translate(-50%,-50%)}}' +
    /* owner 2026-07-27: the ±10 buttons are clutter in dyn mode (sentence skip covers it) */
    '.audio-row button[onclick="skip(-10)"],.audio-row button[onclick="skip(10)"]{display:none}' +
    /* owner 2026-07-27: emphasis swap — the playback scrubber gets BIG, the pauses slider small */
    '.scrubber{height:8px;border-radius:4px}' +
    '.scrubber-fill{border-radius:4px}' +
    '.scrubber-fill::after{width:18px;height:18px;right:-9px}' +
    '.dyn-slider{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 8px;font-size:11.5px;color:var(--text-tertiary);margin-top:8px}' +
    /* ⚠ `white-space:nowrap` is GONE and flex-wrap added. The nowrap pinned each group's min-content
       to its full label, so at a large OS font size "English position" + its boxes could not give
       anywhere and the boxes were pushed out of the panel (owner-reported, 2026-08-09). Wrapping
       is a no-op at normal size — nothing here wraps until it genuinely cannot fit. */
    '.dyn-ctl-group{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:100%;min-width:0}' +
    /* r150 — THE VALUE LABEL MUST NOT CHANGE THE ROW'S WIDTH (owner: "the LENGTH of the pause
       selector bar CHANGES slightly as you select different pauses … hesitant … subtly vibrating").
       MEASURED: the label is 12.3px wide at "1×" and 31.7px at "0.25×". `.dyn-slider` is centred
       (justify-content:center), so that 19px swing RE-CENTRES the whole group and slides the track
       sideways — up to 9px of drift at a 300px row (x = 453 → 456 → 462 across the stops). Mid-drag
       that is a feedback loop, not a wobble: the track moves out from under a stationary finger →
       the browser maps that finger to a different point on it → the value flips to a neighbour →
       the label changes width → it re-centres again. Hence "doesn't know which option to snap
       towards", and hence worst on the guide, whose demo row is the narrowest and centred.
       A fixed min-width (34px covers the widest label, "0.25×"/"1.75×") makes the row's width
       constant, so nothing moves and the loop cannot start. flex-shrink:0 stops the track itself
       being squeezed when the row is tight — the other way the same wobble could get in.
       ⚠ Neither r148's wider track nor r149's touch-action could have fixed this: aim and gesture
       were never the problem, a moving target was. */
    '#dyn-pf-val{display:inline-block;min-width:34px;text-align:left;font-variant-numeric:tabular-nums}' +
    '.dyn-slider input[type=range]{flex-shrink:0}' +
    /* r148 — GRABBABLE, WITHOUT LOOKING ANY DIFFERENT (owner: "flickery … doesn't know quite what
       to lock on to"). Two separate causes, both measured:
       1. `height:3px` made the whole control a THREE-PIXEL-TALL hit target. `padding` with
          content-box leaves the UA to draw its track inside the 3px content box — so the line and
          thumb render exactly as before — while the element's box becomes 21px tall. Verified by
          screenshot: identical track, 7x the grab band.
       2. r147's 0.25 step added a stop (7 intervals, was 6) without lengthening the track, so
          per-step spacing shrank from 15px to 12.9px. 90 x 7/6 = 105 restores the ORIGINAL
          spacing exactly — the smallest change that undoes it, as asked.
       ⚠ Do not "tidy" the padding into `height` — a taller height makes the UA draw a thicker
       track, which is a visual change. And if the step or range moves again, rescale the width
       with it or the stops crowd up once more. */
    /* r149 — `touch-action:none` is what makes it track your finger on iOS. Found by the owner's
       own comparison: the demo player's SCRUBBER is "flawlessly smooth" on the same phone, and the
       scrubber is a custom div that declares `touch-action:none` (guide.html .scrubber-track, and
       .te-mini-scrub does the same). A native range left at `touch-action:auto` inside a
       vertically scrollable page hands the gesture to the SCROLLER the moment the drag has any
       vertical component — the thumb stops tracking, then snaps to catch up. That is the
       "flickery, doesn't know what to lock on to", and why it reads as a scrolling problem: it is
       one. Widening the track (r148) helped the aim but could not fix the gesture.
       The cost is that a swipe STARTING on this 105x21 strip no longer scrolls the page — the
       same trade the scrubber has always made, on a much bigger target. */
    '.dyn-slider input[type=range]{width:105px;accent-color:var(--accent);height:3px;padding:9px 0;box-sizing:content-box;touch-action:none}' +
    '.dyn-ctl-sep{color:var(--border-strong)}' +
    '.dyn-reps{display:inline-flex;gap:3px}' +
    /* ⚠ THE SQUARE IS SIZED IN `em`, ON PURPOSE — do not put it back to px. The digit is real text,
       so Android inflates it; a fixed 20px box therefore could not hold it and the "1" climbed out
       (owner-reported, 2026-08-09). em locks the box to its OWN glyph, so the two can never come
       apart at any zoom: 20/10.5 = 1.905em, 5/10.5 = .476em, which resolve to exactly 20px and 5px
       at --te-ui: 1. The font-size cap then stops the pair growing without limit. */
    '.dyn-rep-btn{width:1.905em;height:1.905em;border-radius:.476em;border:.5px solid var(--border-strong);background:var(--surface);color:var(--text-tertiary);font:600 10.5px var(--font-ui);font-size:calc(10.5px * var(--te-ui, 1));cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}' +
    '.dyn-rep-btn.on{background:var(--accent);border-color:var(--accent);color:#fff}' +
    '.dyn-en-lbl{display:inline-flex;align-items:center;gap:4px;cursor:pointer}' +
    '.dyn-en-lbl input{accent-color:var(--accent);margin:0;width:13px;height:13px}' +
    /* round-15 item 4: English-position line (|thai ☐ thai ☐| radio boxes) */
    '.dyn-ep-row{margin-top:2px}' +
    '.dyn-ep-boxes{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}' +
    '.dyn-ep-th{font-size:calc(10.5px * var(--te-ui, 1));color:var(--text-tertiary);font-style:italic}' +
    '.dyn-ep-box{width:16px;height:16px;border-radius:4px;border:.5px solid var(--border-strong);background:var(--surface);cursor:pointer;padding:0;position:relative}' +
    '.dyn-ep-box.on{background:var(--accent);border-color:var(--accent)}' +
    ".dyn-ep-box.on::after{content:'';position:absolute;left:5px;top:2px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}" +
    /* Desktop MP3 download (2026-08-07). Sits under the controls, quiet by default — it is a
       rare, deliberate action, not a primary transport control. The note line is a live region so
       progress and the "play it first" refusal are announced, not just painted. */
    '.dyn-pcdl{margin-top:10px;padding-top:10px;border-top:.5px solid var(--border);display:flex;flex-direction:column;align-items:center;gap:5px}' +
    '.dyn-pcdl-row{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 10px}' +
    '.dyn-pcdl-btn{font:600 12.5px var(--font-ui);color:#fff;background:var(--accent);border:0;border-radius:8px;padding:9px 14px;cursor:pointer}' +
    '.dyn-pcdl-btn:hover{filter:brightness(1.08)}' +
    '.dyn-pcdl-btn:disabled{opacity:.55;cursor:default;filter:none}' +
    '.dyn-pcdl-note{font-size:11.5px;line-height:1.5;color:var(--text-tertiary);text-align:center;max-width:34em}' +
    '.dyn-pcdl-note.warn{color:#A33A2A}' +
    '.dyn-pcdl-note.ok{color:#2E7D52}' +
    /* ══ r28 STYLE2 — opt-in restyle, everything scoped to body.te-v2 ══════════════
       1. The intro collapses to two lines. It is a HEIGHT CLAMP, never display:none — the
          full text stays in the DOM so search engines still read every word, which is the
          whole reason the paragraph exists.
       2. Playback settings fold into a disclosure. They are the busiest block on the page
          and are set once, not per listen.
       3. The two playlist actions become a proper 2-up button row instead of a button and a
          stray text link.
       4. Per-sentence tools move to the RIGHT of the preview, so every row reads
          number → play → Thai, with the tools out of the reading path.
       5. The three-segment reveal indicator goes. The tap-to-expand-in-stages mechanic it
          described is untouched — only the ornament is removed. */
    /* 0.3rem, was 1.1rem (owner, 2026-08-20). Measured on the live page: the band between the
       collapsed intro and the player card was 89.9px, of which 46px was pure whitespace in three
       gaps. Halving the band means cutting the gaps, not moving the sentence line — which is
       what a previous attempt did, and the owner rightly said was not the same thing. */
    'body.te-v2 .te-intro-wrap{position:relative;margin-bottom:0.3rem}' +
    'body.te-v2 .te-intro-wrap .topic-intro{overflow:hidden;margin-bottom:0}' +
    'body.te-v2 .te-intro-wrap:not(.open) .topic-intro{max-height:3.3em}' +
    "body.te-v2 .te-intro-wrap:not(.open)::after{content:'';position:absolute;left:0;right:0;bottom:1.85em;height:2.1em;background:linear-gradient(to bottom,rgba(250,250,248,0),var(--bg));pointer-events:none}" +
    'body.te-v2 .te-intro-more{margin-top:2px;font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--accent);background:none;border:0;padding:2px 0;cursor:pointer}' +
    'body.te-v2 .te-intro-more:hover{text-decoration:underline}' +
    /* settings disclosure */
    'body.te-v2 .dyn-set-wrap{margin-top:2px}' +
    'body.te-v2 .dyn-set-wrap summary{list-style:none;cursor:pointer;font-family:var(--font-ui);font-size:12.5px;font-weight:500;color:var(--text-secondary);padding:9px 0 0;display:flex;align-items:center;gap:6px}' +
    'body.te-v2 .dyn-set-wrap summary::-webkit-details-marker{display:none}' +
    /* ⚠ DELIBERATELY INVERTED — closed shows ^, open shows ⌄. This is the OPPOSITE of the usual
       web convention and it is an OWNER DECISION (2026-07-30), not a bug. Do not "correct" it back.
       Same glyph rotated: base 180° (reads as ^), [open] back to 0° (reads as ⌄). */
    "body.te-v2 .dyn-set-wrap summary::after{content:'⌄';font-size:14px;transition:transform .18s;transform:rotate(180deg)}" +
    'body.te-v2 .dyn-set-wrap[open] summary::after{transform:rotate(0deg)}' +
    'body.te-v2 .dyn-set-wrap .dyn-slider{margin-top:9px}' +
    /* playlist row */
    'body.te-v2 .te-pl-row{display:flex;gap:9px;margin:14px 0 16px}' +
    /* FILLED, not outlined (owner, 2026-08-15): as white cards beside a white player they read as
       secondary and were easy to miss. Same treatment as the signup CTA.
       ⚠ On a premium topic --accent is the BRIGHT gold, where white text washes out — the
       body.premium-topic rule near the palette block flips these to #3D2E00. */
    'body.te-v2 .te-pl-row .dyn-addpl,body.te-v2 .te-pl-row .dyn-pl-link{flex:1;margin:0;display:flex;align-items:center;justify-content:center;gap:7px;font-family:var(--font-ui);font-size:13px;font-weight:500;color:#fff;background:var(--accent);border:.5px solid var(--accent);border-radius:var(--radius-md);padding:7.35px 10px;text-decoration:none;text-align:center;cursor:pointer}' +
    'body.te-v2 .te-pl-row .dyn-addpl:hover,body.te-v2 .te-pl-row .dyn-pl-link:hover{background:var(--accent-mid);color:#fff}' +
    /* Premium topics: --accent is the bright gold, on which white washes out. Same #3D2E00 as
       the toggle beside them. Written HERE, not in STYLES, so it wins the cascade — see the
       note in the premium palette block. */
    'body.te-v2.premium-topic .te-pl-row .dyn-addpl,body.te-v2.premium-topic .te-pl-row .dyn-pl-link,body.te-v2.premium-topic .te-pl-row .dyn-addpl:hover,body.te-v2.premium-topic .te-pl-row .dyn-pl-link:hover{color:#3D2E00}' +
    /* per-sentence: tools to the right, reveal ornament gone */
    'body.te-v2 .sentence-header{display:flex;align-items:center;gap:8px}' +
    'body.te-v2 .prog-wrap{display:none}' +
    'body.te-v2 .dyn-tick{order:0}' +
    'body.te-v2 .sent-num{order:1}' +
    'body.te-v2 .dyn-eq{order:2}' +
    'body.te-v2 .sent-play-btn{order:3}' +
    'body.te-v2 .sent-preview{order:4;flex:1;min-width:0}' +
    /* r98: tortoise slow-play button removed from the template — clutter, and slowed Chirp3
       audio degrades (owner call, 2026-08-01; the speed audit polices pace at source instead).
       Hidden only under te-v2 so classic live pages keep it until rollout. */
    'body.te-v2 .speed-toggle{display:none}' +
    'body.dyn-plmode .speed-toggle{display:none}' +   // r132: playlist player matches the topic template - no tortoise (owner)
    /* ⚠ EXCLUDE IS THE LAST ITEM IN THE ROW AND MUST STAY THAT WAY (owner, 2026-08-20).
       With the plays chip after it, the chip appearing or going 1->2 digits pushed the
       exclude button LEFT, so a control the user aims at moved under their finger.
       Ordered last, it is pinned to the right edge: .sent-preview is the flex:1 item, so
       it absorbs the chip's width instead and nothing after it shifts. */
    'body.te-v2 .dyn-x-btn{order:8}' +
    /* Playlist locked rows + their "Premium content" divider. Gold TEXT tone #B29234 (the index
       "Premium" pill colour) — the brighter #F0CC5C is for fills/graphics only. Deliberately
       understated: it marks content, it does not advertise. */
    '.sent-lock-group{display:flex;align-items:center;gap:7px;margin:22px 0 9px;font-family:var(--font-ui,system-ui,sans-serif);' +
      'font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#B29234}' +
    '.sent-lock-group::after{content:"";flex:1;height:.5px;background:var(--border,rgba(0,0,0,.12))}' +
    /* Per-card premium gold. A topic page skins <body> once because the whole page is one tier;
       a playlist mixes tiers, so the same variable override is scoped to the CARD — free and
       member rows keep brand purple, premium rows go gold. Same tokens as body.premium-topic
       (bright #F0CC5C for fills, dark ink on them), so the two routes cannot drift apart. */
    '.sentence-card.sent-premium{--accent:#F0CC5C;--accent-mid:#E3BC48;--accent-light:#FBF5DC;--purple-mid:#D4A82C}' +
    '.sentence-card.sent-premium .sent-play-btn.playing svg,' +
    '.sentence-card.sent-premium .sent-play-btn:hover svg{fill:#3D2E00}' +
    '.sentence-card.sent-premium .sent-num{color:#B29234}' +
    '.sentence-card.sent-locked{opacity:.72;background:var(--surface)}' +
    '.sentence-card.sent-locked .sentence-header{cursor:pointer}' +
    '.sentence-card.sent-locked .sent-preview{color:var(--text-secondary)}' +
    '.sentence-card.sent-locked .sent-lock-ico{display:inline-flex;align-items:center;color:#B29234;flex-shrink:0}' +
    'body.te-v2 .sentence-card.sent-locked .sent-lock-ico{order:3}' +
    /* NOT DOWNLOADED (Part B, 2026-08-09) — greyed IN PLACE. Deliberately NOT the locked skin:
       nothing is being withheld, so no padlock, no gold, and no "Premium content" heading (it
       never enters dynApplyLockOrder, so the row keeps its position, exactly as the owner asked).
       Dimmer than .sent-locked's .72 because a locked row is an offer and this is just absence.
       The header stays tappable — that is how the "not downloaded" message is reached — but the
       inner controls are visually muted so the card does not look playable. */
    '.sentence-card.sent-nodl{opacity:.45;background:var(--surface)}' +
    '.sentence-card.sent-nodl .sentence-header{cursor:pointer}' +
    '.sentence-card.sent-nodl .sent-preview{color:var(--text-secondary)}' +
    '.sentence-card.sent-nodl .sent-play-btn,.sentence-card.sent-nodl .speed-toggle{opacity:.5}' +
    /* r16a: the ⓘ explainer labels + their dismissible box */
    '.dyn-info-lbl{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;text-align:left}' +
    '.dyn-info-lbl:hover{color:var(--accent)}' +
    /* Same em trick as .dyn-rep-btn — the italic "i" was climbing out of its circle. 13/9 = 1.444em. */
    '.dyn-info-i{width:1.444em;height:1.444em;border-radius:50%;border:1px solid currentColor;display:inline-flex;align-items:center;justify-content:center;font:italic 700 9px/1 Georgia,"Times New Roman",serif;font-size:calc(9px * var(--te-ui, 1));flex-shrink:0}' +
    '.dyn-info-box{position:relative;margin:7px 0 2px;padding:9px 30px 9px 11px;border:.5px solid var(--border-strong);border-radius:var(--radius-md);background:var(--surface);color:var(--text-secondary);font-size:12px;line-height:1.55;max-width:520px}' +
    '.dyn-info-box a{color:var(--accent);font-weight:500;text-decoration:none}' +
    '.dyn-info-box a:hover{text-decoration:underline}' +
    '.dyn-info-x{position:absolute;top:3px;right:4px;width:22px;height:22px;border:0;background:none;color:var(--text-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:0}' +
    '.dyn-info-x:hover{color:var(--accent)}' +
    /* r16: "apply to all" sync affordance — bottom-left, under the settings rows */
    '.dyn-head{font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 8px;letter-spacing:.01em}' +
    '.dyn-sync-row{display:flex;align-items:center;justify-content:flex-start;margin:8px 0 2px}' +
    '.dyn-fmt-tag{order:2;margin-left:auto;font-size:10.5px;color:var(--text-tertiary);font-variant-numeric:tabular-nums}' +
    '.dyn-sync-btn{width:28px;height:28px;border-radius:50%;border:.5px solid var(--border-strong);background:var(--surface);color:var(--text-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}' +
    '.dyn-sync-btn svg{width:15px;height:15px}' +
    '.dyn-sync-btn:hover{color:var(--accent);border-color:var(--accent)}' +
    'body.premium-topic .dyn-sync-btn:hover{color:#B29234;border-color:#B29234}' +
    'body.premium-topic .dyn-info-box a{color:#B29234}' +   // text-gold, not the pale graphic gold --accent maps to
    // Read more / Show less sits OUTSIDE #player-root, so --accent is still purple there — pin to text-gold.
    'body.premium-topic .te-intro-more{color:#B29234}' +
    '.sentence-card.dyn-off{opacity:.55;border-style:dashed}' +
    '.sentence-card.dyn-off .sent-preview{text-decoration:line-through}' +
    '.dyn-card-btn{width:26px;height:26px;border-radius:50%;border:.5px solid var(--border-strong);background:var(--surface);color:var(--text-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}' +
    '.dyn-card-btn svg{width:13px;height:13px}' +
    '.dyn-card-btn:hover{color:var(--accent);border-color:var(--accent)}' +
    /* r99: the live ring is drawn with a 1px box-shadow ON TOP of the recoloured 0.5px border.
       A half-pixel border rasterises per-edge, so on some cards the bottom edge rounded away
       entirely (owner-reported: always the same card per page, immune to refresh/scroll — the
       classic sub-pixel signature). A shadow ring can't be rounded away and follows the radius. */
    '.sentence-card.dyn-live{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}' +
    /* Play count on the collapsed pill. COMPACT on purpose (owner, 2026-08-20): the full
       "Played 12 times" is ~3x the width and the pill already carries a number, a play button, an
       exclude button and the hint — at 320px with OS text scaling it squeezes the hint out.
       Topic cards and playlist rows, which have the room, carry the listening-time caption
       instead ("Thai listening time: 2h 5min" — topics.js listenCaptionFor).
       ⚠ flex-shrink:0 + tabular-nums: the chip must not compress or jitter between 1 and 2
       digits, or every pill on the page reflows as counts tick over. */
    '.te-plays{display:none;align-items:center;gap:4px;flex-shrink:0;font-family:var(--font-ui);'
      + 'font-size:calc(11px * var(--te-ui, 1));font-variant-numeric:tabular-nums;color:var(--text-tertiary)}' +
    '.te-plays.on{display:inline-flex}' +
    '.te-plays svg{width:8px;height:8px;fill:currentColor;flex-shrink:0}' +
    'body.premium-topic .te-plays{color:#B29234}' +
    'body.te-v2 .te-plays{order:7}' +

    /* owner 2026-07-27: quiet card look (was a solid accent pill — garish next to its neighbours) */
    '.dyn-addpl{display:block;margin:10px auto 0;font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--accent);background:var(--surface);border:.5px solid var(--border-strong);border-radius:var(--radius-md);padding:7px 14px;cursor:pointer}' +
    '.dyn-addpl:hover{background:var(--accent-light)}' +
    '.dyn-pl-link{display:block;text-align:center;font-size:12px;margin:6px 0 14px;color:var(--text-tertiary);text-decoration:none}' +
    '.dyn-pl-link:hover{color:var(--accent)}' +
    '.dyn-tick{display:none;width:20px;height:20px;border-radius:50%;border:1.5px solid var(--border-strong);flex-shrink:0;margin-right:2px;position:relative;cursor:pointer}' +
    /* r146 — BIGGER TAP TARGET, IDENTICAL LOOK (owner, 2026-08-08: "easy to miss and I end up
       interacting with the pill instead"). An invisible pad, so the circle is unchanged: 20px
       drawn, ~60×48 tappable (was 34×34), which is the whole header row height and everything
       left of the number.
       The numbers are measured, not guessed, and each side is bounded by what it must not reach:
       • left -16px  = the header's own padding, i.e. exactly the card edge. Nothing lives there.
       • ±14px       = half the 48px header, so a vertically-off tap cannot fall through to the
                       pill. Cards sit 7px apart, so even where the header is shorter this cannot
                       reach the neighbouring card.
       • right -24px = covers the number and stops ≥12px short of the play button. Clearance is
                       8px gap + `.sent-num{min-width:20px}` + 8px gap ≥ 36px at every width.
       ⚠ The pad MUST NOT reach the play button. The tick is position:relative, so this pseudo is
       a positioned box and hit-tests ABOVE the (unpositioned) button that follows it — overlap
       would silently eat play taps rather than losing to them. Widen the right side only after
       re-measuring. Only live during select mode: .dyn-tick is display:none otherwise, which
       takes its ::before with it, so normal browsing is untouched. */
    ".dyn-tick::before{content:'';position:absolute;inset:-14px -24px -14px -16px}" +
    '#sentence-list.dyn-selecting .dyn-tick{display:inline-block}' +
    /* select mode: flag + exclude are out of play (the capture listener also swallows them) */
    '#sentence-list.dyn-selecting .dyn-card-btn{opacity:.35;pointer-events:none}' +
    '.dyn-tick.on{background:var(--accent);border-color:var(--accent)}' +
    '.dyn-tick.on.gold{background:#B29234;border-color:#B29234}' +
    ".dyn-tick.on::after{content:'';position:absolute;left:6px;top:2.5px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}" +
    '#dyn-sel-bar{position:fixed;left:0;right:0;bottom:0;background:var(--surface);border-top:.5px solid var(--border);padding:10px 16px;display:none;align-items:center;justify-content:space-between;gap:12px;z-index:250}' +
    '#dyn-sel-bar.show{display:flex}' +
    '#dyn-sel-bar button{font-family:var(--font-ui);font-size:13px;font-weight:600;border-radius:18px;padding:8px 20px;cursor:pointer}' +
    '#dyn-sel-bar .dyn-sel-done{color:#fff;background:var(--accent);border:none}' +
    '#dyn-sel-bar .dyn-sel-cancel{color:var(--text-secondary);background:var(--surface);border:.5px solid var(--border-strong)}' +
    /* plsel lockdown: ONLY the sentence list + back button + bottom bar — everything above
       the list (nav, eyebrow, title, intro, the whole player card) hides */
    'body.dyn-plsel #site-nav-root{display:none}' +
    'body.dyn-plsel .topic-nav{display:none}' +
    'body.dyn-plsel #player-root{display:none}' +
    'body.dyn-plsel .topic-eyebrow{display:none}' +
    'body.dyn-plsel .topic-title{display:none}' +
    'body.dyn-plsel .topic-subtitle{display:none}' +
    'body.dyn-plsel .topic-intro{display:none}' +
    'body.dyn-plsel #btn-prev-topic,body.dyn-plsel #btn-next-topic{opacity:.35;pointer-events:none}' +
    '#dyn-plsel-back{display:block;margin:10px 0 14px;font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--accent);background:var(--surface);border:.5px solid var(--border-strong);border-radius:var(--radius-md);padding:8px 14px;cursor:pointer}' +
    '#dyn-plsel-back:hover{background:var(--accent-light)}' +
    /* playlist mode (round-10): flags + per-topic progress don't apply to playlists */
    /* r140: the progress card is NO LONGER hidden in playlist mode — a playlist can be listened
       through and counted like a topic, keyed on its 'pl-<id>' namespace (see progressKey()).
       The .progress-controls reserve above therefore now applies on playlists.html too, which is
       why that page needed its own #player-root reserve at the same time. */
    /* round-10 addendum C: animated equalizer on the playing sentence card (index .te-eq design);
       visible only while actually playing; premium pages get the gold tone */
    '.dyn-eq{display:none;align-items:flex-end;gap:2px;height:12px;width:16px;flex-shrink:0}' +
    'body.dyn-playing .sentence-card.dyn-live .dyn-eq{display:inline-flex}' +
    '.dyn-eq i{width:3px;height:100%;border-radius:2px;background:var(--accent);transform-origin:bottom;animation:te-eq-bounce 0.9s ease-in-out infinite}' +
    '.dyn-eq i:nth-child(2){animation-delay:.3s}' +
    '.dyn-eq i:nth-child(3){animation-delay:.15s}' +
    '.dyn-eq i:nth-child(4){animation-delay:.45s}' +
    'body.premium-topic .dyn-eq i{background:#B29234}' +
    '@keyframes te-eq-bounce{0%,100%{transform:scaleY(0.35)}50%{transform:scaleY(1)}}';
  /* ══ r18: DOWNLOADS FOR DYN UNITS ════════════════════════════════════════════════════
     A dyn unit downloads its SOURCE CLIPS (_TH + _EN), not a rendered file. That is the
     whole design, and it falls out of the measurements:
       · clips are ~0.58 MB against ~1.4 MB for both rendered directions — but more
         importantly they are the only thing that lets a settings change re-stitch OFFLINE,
         which a rendered file can never do.
       · the prefab TE/ET pair (2.11 MB) is NOT downloaded for a dyn unit: anything it could
         play, the clips can rebuild — and rebuild it with the user's own settings rather
         than the factory ones.
       · a session evicted by the OS then self-heals instead of the download being simply
         gone, which matters most on iOS where Cache Storage is evicted aggressively.
     Both directions are pre-built at download time (~2 s, ~1.4 MB) so a downloaded unit is
     playable from the LOCK SCREEN immediately — building is foreground-only, so without
     this a locked chain hop would skip straight past it. */
  // Pre-render both directions, reusing the clips just downloaded. Failures are non-fatal:
  // the download is the clips, and a missing session rebuilds on first play.
  function dynPrebuildBoth(onStep) {
    var was = currentMode, modes = ['te', 'et'];
    var chain = Promise.resolve();
    modes.forEach(function (m, i) {
      chain = chain.then(function () {
        currentMode = m;                       // dynKey()/dynBuildSession() read this
        if (onStep) onStep(i + 1, modes.length, m);
        var st = dynSettingsFor(DYN_KEY_NS, m);
        var inc = dynIncluded();
        return dynBuildSessionFor(inc, DYN_KEY_NS, dynKeyFor(inc, st), null, st)
          .then(function (sess) { dynPersistSessionFor(sess, m, DYN_KEY_NS); })
          .catch(function (e) { dynLog('prebuild ' + m + ' failed: ' + ((e && (e.code || e.message)) || e)); });
      });
    });
    return chain.then(function () { currentMode = was; }, function () { currentMode = was; });
  }
  // The circular-① sentence-skip glyphs (shared by the audio-row buttons and the dyn mini player).
  var DYN_DIGIT1 = '<path d="M12.36 15.94v-4.27h-.09l-1.77.63v.69l1.01-.31v3.26h.85z"/>';
  var DYN_SVG_PREV = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>' + DYN_DIGIT1 + '</svg>';
  var DYN_SVG_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 13c0 4.4 3.6 8 8 8s8-3.6 8-8h-2c0 3.3-2.7 6-6 6s-6-2.7-6-6 2.7-6 6-6v4l5-5-5-5v4c-4.4 0-8 3.6-8 8z"/>' + DYN_DIGIT1 + '</svg>';
  /* PER-CARD DYN DECORATION (select tick, equaliser cue, per-session exclude −).
     ⚠ SPLIT OUT OF initDyn (2026-08-20) BECAUSE IT HAS TO BE RE-RUNNABLE. On a NON-SSR page
     — i.e. the playlist player, which builds window.ThaiEarTopic at runtime and so has no
     static cards — render() rebuilds #sentence-list with innerHTML, which destroys every node
     added here. Revealing a pill on a playlist therefore wiped the equaliser and the select
     tick off every card. (The .dyn-live highlight was lost the same way; that one is fixed at
     source, in cardHtml.) Idempotent: a card that still carries its tick is skipped, so the
          SSR path (where nothing is ever destroyed) costs one querySelector per card.
     Full story: `SESSION_2026-08-20_PLAYER_FIXES.md` §1. */
  function dynDecorateCards() {
    plysRepaintChips();          // play-count chips (re-attached after a non-SSR rebuild too)
    sentences.forEach(function (s) {
      // Locked playlist rows are padlocks, not players — no select tick, no equalizer, no ①
      // skip button. Their header carries the gate handler and nothing else.
      if (sentLocked(s)) return;
      var hdr = document.querySelector('#sc-' + s.num + ' .sentence-header');
      if (!hdr) return;
      if (hdr.querySelector('.dyn-tick')) return;   // already decorated (SSR pages: always)

      // Select-mode tick (batch add-to-playlist): hidden until #sentence-list gets .dyn-selecting.
      var tick = document.createElement('span');
      tick.className = 'dyn-tick' + (TIER === 'premium' ? ' gold' : '');
      tick.setAttribute('aria-hidden', 'true');
      // Re-decorating MID-SELECTION must not silently drop what is already ticked.
      if (dynSel && dynSel.now && dynSel.now[s.num]) tick.classList.add('on');
      hdr.insertBefore(tick, hdr.querySelector('.sent-num') || hdr.firstChild);
      // Equalizer cue next to the number — shows on the playing card while audio runs (addendum C).
      var eq = document.createElement('span');
      eq.className = 'dyn-eq';
      eq.setAttribute('aria-hidden', 'true');
      eq.innerHTML = '<i></i><i></i><i></i><i></i>';
      var snEl = hdr.querySelector('.sent-num');
      if (snEl) hdr.insertBefore(eq, snEl.nextSibling); else hdr.appendChild(eq);
      // Round-11 item 4: no exclude − on playlist cards — playlist curation happens in the
      // playlists menu (Remove sentences), not per-session exclusion.
      if (!PLMODE) {
        var xb = document.createElement('button');
        xb.className = 'dyn-card-btn dyn-x-btn';
        var xPaint = function () {
          var on = !!dynExcluded[s.num];
          xb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="' + (on ? 'M12 5v14M5 12h14' : 'M5 12h14') + '"/></svg>';
          xb.setAttribute('aria-label', on ? 'Include in session' : 'Exclude from session');
          xb.title = on ? 'Include in session' : 'Exclude from session';
        };
        xPaint();
        xb.addEventListener('click', function (e) {
          e.stopPropagation(); e.preventDefault();
          // Same gate as play/reveal/flag: on a locked topic this was the one control still
          // live, so a non-entitled visitor could sit there toggling sentences in and out of a
          // session they cannot hear.
          if (!entitledForPage()) { gate(TIER); return; }
          dynExcluded[s.num] = !dynExcluded[s.num];
          dynSaveExcluded();
          var card = document.getElementById('sc-' + s.num);
          if (card) card.classList.toggle('dyn-off', !!dynExcluded[s.num]);
          xPaint();
          dynInvalidate(true);
          dynPrefsQueue('excl');
        });
        /* Appended, not inserted before the flag button (which no longer exists). Position is
           decided by CSS order under te-v2 — .dyn-x-btn is order:7, the plays chip order:8 — so
           DOM order here is irrelevant and the exclude button still lands where it always did. */
        hdr.appendChild(xb);
        if (dynExcluded[s.num]) {
          var card0 = document.getElementById('sc-' + s.num);
          if (card0) card0.classList.add('dyn-off');
        }
      }
    });
  }

  // Mount-time DOM injection: status line + pause slider + sentence-skip transport buttons
  // + the per-card playlist/exclude buttons. Only ever called when DYN.
  function initDyn() {
    if (!document.getElementById('dyn-styles')) {
      var st = document.createElement('style');
      st.id = 'dyn-styles';
      st.textContent = DYN_STYLES;
      document.head.appendChild(st);
    }
    var root = $('player-root'); if (!root) return;
    if (STYLE2) { document.body.classList.add('te-v2'); dynCollapseIntro(); }
    dynLoadSettings();   // r16: this unit's settings for the current direction, before anything paints
    var row = root.querySelector('.audio-row');
    if (row) {
      // r18: "Dynamic mp3 Player ⓘ" heading — the feature needs naming before it needs
      // explaining, and the explainer is where the lock-screen skip is set up.
      var hd = document.createElement('div');
      hd.className = 'dyn-head';
      hd.innerHTML = dynInfoLabel('Dynamic mp3 Player', 'player');
      row.parentNode.insertBefore(hd, row);
      var hdLbl = hd.querySelector('.dyn-info-lbl');
      if (hdLbl) hdLbl.addEventListener('click', function () { dynInfoToggle('player', hd); });
      var stEl = document.createElement('div');
      stEl.id = 'dyn-status'; stEl.className = 'dyn-status'; stEl.hidden = true;
      row.parentNode.insertBefore(stEl, row.nextSibling);
      var sl = document.createElement('div');
      sl.className = 'dyn-slider';
      // Each control is a NON-WRAPPING group — the row wraps between groups, never inside one
      // (round-10 addendum B: "Thai sentence repeats" was wrapping away from its 1-4 boxes).
      // r147: min 0.25 (was 0.5) — long sentences kept long gaps even at 0.5x. Serves the topic
      // pages AND the playlist player; they share this control, which is why one model was kept.
      sl.innerHTML = '<span class="dyn-ctl-group">' + dynInfoLabel('Pauses', 'pauses') +
          ' <input id="dyn-pf" type="range" min="0.25" max="2" step="0.25"> <span id="dyn-pf-val">1×</span></span>' +
        '<span class="dyn-ctl-sep">·</span>' +
        '<span class="dyn-ctl-group">' + dynInfoLabel('Thai sentence repeats', 'reps') + ' <span class="dyn-reps" id="dyn-reps"></span></span>' +
        '<span class="dyn-ctl-sep" id="dyn-en-sep">·</span>' +
        '<label class="dyn-en-lbl dyn-ctl-group" id="dyn-en-wrap"><input type="checkbox" id="dyn-en"> English</label>';
      stEl.parentNode.insertBefore(sl, stEl.nextSibling);
      var pf = sl.querySelector('#dyn-pf'), pv = sl.querySelector('#dyn-pf-val');
      pf.value = String(dynFactor);
      pv.textContent = dynFactor + '×';
      pf.addEventListener('input', function () { pv.textContent = (parseFloat(pf.value) || 1) + '×'; });
      pf.addEventListener('change', function () {
        dynFactor = parseFloat(pf.value) || 1;
        dynSaveSettings();
        pv.textContent = dynFactor + '×';
        dynInvalidate(true);
      });
      // Thai repeat count: 1–4 segmented mini-buttons
      var reps = sl.querySelector('#dyn-reps');
      [1, 2, 3, 4].forEach(function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = String(n);
        b.className = 'dyn-rep-btn' + (n === dynRepeats ? ' on' : '');
        b.setAttribute('aria-label', n + ' Thai repeat' + (n === 1 ? '' : 's'));
        b.addEventListener('click', function () {
          if (dynRepeats === n) return;
          dynRepeats = n;
          dynSaveSettings();
          reps.querySelectorAll('.dyn-rep-btn').forEach(function (x) { x.classList.toggle('on', x.textContent === String(n)); });
          dynInvalidate(true);
          dynEpRender();   // box count follows the repeat count (and ep clamps to it)
        });
        reps.appendChild(b);
      });
      // English on/off — TE mode only (ET always includes English; toggle hidden there)
      var enCb = sl.querySelector('#dyn-en');
      enCb.checked = dynEnglish;
      enCb.addEventListener('change', function () {
        dynEnglish = enCb.checked;
        dynSaveSettings();
        dynInvalidate(true);
        dynEpRender();
      });
      // English-position line (round-15 item 4) — its own non-wrapping group under the row.
      var epRow = document.createElement('div');
      epRow.className = 'dyn-slider dyn-ep-row';
      epRow.id = 'dyn-ep-row';
      epRow.innerHTML = '<span class="dyn-ctl-group">' + dynInfoLabel('English position', 'engpos') +
        ' <span class="dyn-ep-boxes" id="dyn-ep-boxes"></span></span>';
      sl.parentNode.insertBefore(epRow, sl.nextSibling);
      /* Every ⓘ label shares one handler; the box lands under whichever row was tapped.
         ⚠ querySelectorAll, NOT querySelector. The slider row now holds TWO labels (Pauses and
         Thai sentence repeats, r151) and the old single-element lookup would have wired only the
         first — silently leaving the repeats ⓘ dead while looking entirely correct. */
      var infoRow = { pauses: sl, reps: sl, engpos: epRow };
      [sl, epRow].forEach(function (r) {
        r.querySelectorAll('.dyn-info-lbl').forEach(function (lbl) {
          lbl.addEventListener('click', function () {
            var k = lbl.getAttribute('data-info');
            dynInfoToggle(k, infoRow[k] || r);
          });
        });
      });
      // r16 item 3: the "apply to all" affordance — bottom-left of the player controls.
      var syncRow = document.createElement('div');
      syncRow.className = 'dyn-sync-row';
      syncRow.innerHTML = '<span class="dyn-fmt-tag" id="dyn-fmt-tag"></span>' +
        '<button type="button" class="dyn-sync-btn" id="dyn-sync-btn" ' +
        'aria-label="Apply these settings to all topics and playlists" ' +
        'title="Apply these settings to all topics and playlists">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>' +
        '<path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg></button>';
      epRow.parentNode.insertBefore(syncRow, epRow.nextSibling);
      var syncBtn = syncRow.querySelector('#dyn-sync-btn');
      if (syncBtn) syncBtn.addEventListener('click', dynSyncConfirm);
      dynPaintFmtTag();
      if (STYLE2) {
        // Move (not rebuild) the three settings rows inside a disclosure — moving nodes keeps
        // every listener already attached to them, so no control changes behaviour.
        var det = document.createElement('details');
        det.className = 'dyn-set-wrap';
        var sum = document.createElement('summary');
        sum.textContent = 'Playback settings';
        det.appendChild(sum);
        sl.parentNode.insertBefore(det, sl);
        det.appendChild(sl);
        det.appendChild(epRow);
        det.appendChild(syncRow);
      }
      /* Desktop MP3 download — OUTSIDE the STYLE2 "Playback settings" disclosure on purpose. It
         is an action, not a setting, and the people it exists for should not have to know to open
         a collapsed panel to find it. Mounts after whatever the last settings node turned out to
         be, so it sits below the controls in both layouts. */
      dynPcDlMount(STYLE2 ? det : syncRow);
      dynSyncEnToggle();
      var skips = row.querySelectorAll('.skip-btn');   // [back-10, fwd-10] (dyn buttons not yet inserted)
      var prevB = document.createElement('button');
      prevB.id = 'dyn-sent-prev'; prevB.className = 'skip-btn dyn-sent-btn';
      prevB.setAttribute('aria-label', 'Previous sentence'); prevB.title = 'Previous sentence';
      prevB.innerHTML = DYN_SVG_PREV;
      prevB.addEventListener('click', function () { dynSentSkip(-1); });
      var nextB = document.createElement('button');
      nextB.id = 'dyn-sent-next'; nextB.className = 'skip-btn dyn-sent-btn';
      nextB.setAttribute('aria-label', 'Next sentence'); nextB.title = 'Next sentence';
      nextB.innerHTML = DYN_SVG_NEXT;
      nextB.addEventListener('click', function () { dynSentSkip(1); });
      if (skips[0]) row.insertBefore(prevB, skips[0]);
      if (skips[1]) row.insertBefore(nextB, skips[1].nextSibling);
    }
    // Mini player (scroll follower): in dyn mode its ±10 buttons become sentence prev/next
    // with the same circular-① glyphs (round-7 item 11). cloneNode(false) drops the old
    // skip(±10) listener while keeping id/class, then the ① markup + handler go on fresh.
    [['te-mini-back', -1, DYN_SVG_PREV, 'Previous sentence'], ['te-mini-fwd', 1, DYN_SVG_NEXT, 'Next sentence']].forEach(function (m) {
      var b = $(m[0]); if (!b) return;
      var nb = b.cloneNode(false);
      nb.innerHTML = m[2];
      nb.setAttribute('aria-label', m[3]); nb.title = m[3];
      nb.addEventListener('click', function () { dynSentSkip(m[1]); });
      b.parentNode.replaceChild(nb, b);
    });
    // "Add sentences to a playlist" entry point. Dyn pages hide the shared How-to-use
    // orientation box AT RUNTIME (markup/CSS stay untouched for the live pages) and put the
    // playlist button + link in its place.
    if (PLMODE) document.body.classList.add('dyn-plmode');   // hides progress card + flag buttons (CSS)
    var orient = root.querySelector('.orientation-text');
    if (PLMODE && orient) orient.style.display = 'none';     // the topic how-to box doesn't apply to playlists
    var aplAnchor = orient || $('offline-bar');   // fall back to after the offline bar if the box ever moves
    if (aplAnchor && !PLMODE) {
      var apl = document.createElement('button');
      apl.id = 'dyn-addpl-btn'; apl.className = 'dyn-addpl'; apl.type = 'button';
      apl.textContent = '＋ Add sentences from this topic to a playlist';
      apl.addEventListener('click', dynAddPlClick);
      if (orient) { orient.parentNode.insertBefore(apl, orient); orient.style.display = 'none'; }
      else aplAnchor.parentNode.insertBefore(apl, aplAnchor.nextSibling);
      var pll = document.createElement('a');
      pll.className = 'dyn-pl-link'; pll.href = 'playlists';   // 2026-08-21: the bare page renders standalone again (the r127 redirect is gone), so link it directly
      // The build tag already shows in the corner of the settings block, so the link does not
      // need to carry it once these are proper side-by-side buttons.
      /* ⚠ AN SVG, NOT THE 🎵 EMOJI (owner, 2026-08-15). Once the button became accent-FILLED the
         emoji stayed its own fixed colours and disappeared into the dark ground — an emoji cannot be
         recoloured by CSS. This inherits currentColor, so it is white on the purple free-topic fill
         and #3D2E00 on the premium gold, with no extra rules. */
      var NOTE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
        'style="flex-shrink:0"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/>' +
        '<circle cx="18" cy="16" r="3"/></svg>';
      if (STYLE2) pll.innerHTML = NOTE_SVG + '<span>My playlists</span>';
      else pll.textContent = '🎵 My Playlists · build ' + DYN_BUILD;
      /* "Go to my playlists" is sign-in gated ONLY — deliberately NOT tier gated (owner,
         2026-08-10). It navigates to the visitor's own playlists page; nothing premium is being
         added or played, so a free account on a premium topic may still use it. */
      pll.addEventListener('click', function (e) {
        var au = window.ThaiEarAuth;
        if (!au || !(au.getUser && au.getUser())) { e.preventDefault(); gateSignIn(); }
      });
      apl.parentNode.insertBefore(pll, apl.nextSibling);
      if (STYLE2) {
        apl.textContent = '＋ Add to a playlist';
        var plRow = document.createElement('div');
        plRow.className = 'te-pl-row';
        apl.parentNode.insertBefore(plRow, apl);
        plRow.appendChild(apl);
        plRow.appendChild(pll);
      }
    }
    dynDecorateCards();
    if (DYN_PREBUILD) {
      dynStatus('Preparing both directions', true);
      var t0 = Date.now();
      dynPrebuildBoth(function (i, n, mode) {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ te: 'prebuilding', key: DYN_KEY_NS, i: i, n: n, mode: mode,
              ms: dynLastBuildMs }, location.origin);
          }
        } catch (_) {}
        // Tell the opener which direction is under way — the index shows "1 of 2" so a long
        // construction reads as progress rather than a hang.
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ te: 'prebuilding', key: DYN_KEY_NS, i: i, n: n, mode: mode }, location.origin);
          }
        } catch (_) {}
      }).then(function () {
        dynLog('prebuild both took ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
        dynStatus('Ready.', false);
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ te: 'prebuilt', key: DYN_KEY_NS,
              ms: Date.now() - t0, last: dynLastBuildMs }, location.origin);
          }
        } catch (_) {}
      });
      return;   // a prebuild frame does nothing else — no sweeps, no prefetch, no UI work
    }
    // Housekeeping, deferred so it never competes with a build or the first paint.
    setTimeout(dynSweepOrphans, 4000);
    dynPrefetchNeighbours();        // iPhone: neighbours' placeholder URLs ready before any lock-screen skip
    dynSyncSentBtns();              // ① buttons start greyed until a session (or hydrated map) is live
    dynPrefsApply();                // round-14: overlay the account-level settings once auth allows
    if (dynPlsel) dynPlselBoot();   // opened from playlists.html "Add sentences" → auto-enter select mode
  }

  /* ---- main player ----
     The TOP player carries its OWN identity (mainPrefix / mainGated / mainTier / mainPage),
     separate from the page's PREFIX/GATED/TIER. They start equal, but autoplay and the
     prev/next-topic controls swap the top player onto ANOTHER topic's combined audio without
     reloading the page — so playback continues with the screen locked. The sentence list
     below stays on the topic the page was opened with (it keeps using PREFIX/GATED/TIER). */
  // Direction: web always defaults to Thai-first; the native app remembers your last choice.
  /* DIRECTION IS REMEMBERED ON THE WEB TOO, and paid arrivals start English-first (2026-08-15).
     Two separate fixes share this line — keep both in mind before simplifying it.
     1. THE BUG. The web never persisted the choice (the write in switchAudio was NATIVE-only), so
        a visitor who deliberately switched to English-first was reset to Thai-first on EVERY
        topic, forever. The app has always remembered it; the web silently did not.
     2. THE AD PROMISE. The ads sell "hear the English, say the Thai, then check yourself" — that
        is English-first. A click that lands on Thai-first is a promise the page does not keep.
     ⚠ (1) is what makes (2) work at all: `utm_medium=paid` exists ONLY on the landing URL, so
     without persistence the mode would silently revert to Thai-first on the second page — the
     same bug wearing a different hat. Do not "simplify" this to a bare UTM test.
     ⚠ Organic visitors are deliberately untouched: no stored value and no paid UTM → 'te',
     exactly as before. Flipping that is a pedagogy decision about the course, not a tracking one
     (owner, 2026-08-15: scoped to ad clicks on purpose). */
  var currentMode = (function () {
    try {
      var v = localStorage.getItem('thaiear_dir');
      if (v === 'et' || v === 'te') return v;
      if (/[?&]utm_medium=paid(?:&|$)/.test(location.search)) {
        try { localStorage.setItem('thaiear_dir', 'et'); } catch (_) {}
        return 'et';
      }
    } catch (_) {}
    return 'te';
  })();
  var mainPrefix = PREFIX;          // audio prefix the top player is currently on
  var mainGated = GATED;            // is that topic gated? → signed URL vs public CDN
  var mainTier = TIER;              // its tier → denial route, if it ever denies
  var mainPage = PAGE_HREF;         // the live-unit page the top player is currently playing
  var currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
  var mainSrcReady = false;                 // has the current file's src been resolved onto mainAudio?

  // Continuous-playback prefs, remembered across pages. autoplay → advance on track end;
  // repeat (repeat-one) → loop the current topic and takes PRECEDENCE over autoplay.
  function prefOn(key) { try { return localStorage.getItem(key) === '1'; } catch (_) { return false; } }
  function prefSet(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (_) {} }
  var autoplayOn = prefOn('thaiear_autoplay');
  var repeatOn = prefOn('thaiear_repeat');
  // r136: the two are mutually exclusive now — a device with BOTH remembered on (stored before
  // this rule) keeps Autoplay and drops Repeat, matching the ambiguity the rule exists to remove.
  if (autoplayOn && repeatOn) { repeatOn = false; prefSet('thaiear_repeat', false); }

  var mainAudio = NA ? makeNativeAudio() : new Audio();
  mainAudio.preload = 'metadata';
  // Free: set the public src now so duration shows before play. Premium: defer until first
  // play (we need the session token, and we don't want to burn a signed URL on page load).
  // Free + web: set the public src now so duration shows. In the app, defer to ensureMainSrc so a
  // downloaded local copy can be used (offline-aware).
  if (!DYN && !mainGated && !OFFLINE && !(WEB_DL && isDownloaded(mainPrefix))) { mainAudio.src = AUDIO_BASE + '/' + currentMainFile; mainSrcReady = true; }

  /* ⚠ UNLOCK THE TOP PLAYER INSIDE THE TAP (2026-08-20, r194) — owner-reported on the PWA:
     "I construct a dynamic mp3, it shows as playing but it's sat at 0:00 with no sound; if I then
     hit pause it PLAYS."

     THE SHAPE OF IT. togglePlay() → ensureMainSrc() → dynEnsureSession(), and on a cold open that
     last step BUILDS the file: fetch every clip, decode, encode, mux. Seconds. Only when it
     resolves does mainAudio.play() run — by which time the user-gesture token is long gone, and
     WebKit refuses with NotAllowedError. The individual sentences played beforehand do not help:
     the gesture requirement is PER ELEMENT and those play through a different one (#sent-audio-el).
     The second tap works because the session is built by then, so ensureMainSrc() resolves in a
     microtask, which keeps the gesture.

     THE FIX. Give the element something to play WHILE we still hold the gesture — 20 ms of silence
     as a data URI — so WebKit marks it allowed-to-play before the build starts. The real source
     replaces it when the build finishes. (r27 fixed the sibling case on the lock-screen handler by
     calling play() synchronously; the on-page button cannot, because on a cold open there is no
     audio to play yet.) It also re-activates the iOS audio session, which a pause deactivates —
     the r27 note above set('play') describes what that failure sounds like.

     ⚠ NEVER while something is playing: assigning src would kill the audio it is asked to protect.
     ⚠ NATIVE is exempt — the Media3 shim has no gesture requirement and no src to clobber.
          A failed prime clears the flag so the next tap tries again.
     Full story: `SESSION_2026-08-20_PLAYER_FIXES.md` §2. */
  var MAIN_SILENCE = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
  // Self-clearing test: no real source is ever a data: URI, so nothing has to remember to reset a
  // flag when the session lands. The 20 ms clip fires 'ended' mid-build — that is what this is for.
  function mainOnSilence() {
    var u = mainAudio.currentSrc || mainAudio.src || '';
    return u.indexOf('data:audio') === 0;
  }
  /* ⚠ NOT one-shot. iOS deactivates the page's audio session on every pause (see the r27 note in
     setupMediaSession), so "we unlocked it once at mount" is not a state that stays true — each
     cold start has to re-assert it. Both bails below are about not making things worse:
     a playing element is already unlocked with a live session, and an element holding a loaded
     source must not have it clobbered by silence just to prove a point. */
  function primeMainAudio() {
    if (NATIVE) return;         // Media3 shim: no gesture requirement, and no src of ours to clobber
    if (!mainAudio.paused) return;
    if (mainSrcReady) return;   // real source loaded → play() is one microtask away, which iOS allows
    try {
      mainAudio.src = MAIN_SILENCE;
      mainAudio.load();
      var p = mainAudio.play();
      if (p && p.then) p.then(null, function (e) {
        /* An AbortError once the real source has landed is the NORMAL hand-off — setting src
           interrupts the silence, by design. Measured on the live site: every successful start
           produces one. Logging it would put "prime FAIL" in the debug overlay on every play and
           send the next person reading that trace after a fault that isn't there. Only a rejection
           while the element is STILL on the silence is a real refusal. */
        if (!mainOnSilence()) return;
        dynLog('prime FAIL ' + ((e && e.name) || e));
      });
    } catch (e) { dynLog('prime THREW ' + ((e && e.name) || e)); }
  }

  // Resolve + attach the current main file's src if not already done (premium- and offline-aware).
  // Web offline serves a blob: URL; revoke the previous one on each swap so it doesn't leak.
  var mainBlobUrl = null;
  function ensureMainSrc(lenient) {
    if (DYN) return dynEnsureMainSrc(lenient);   // dynamic mode: stitched client-side session, never the static file
    if (mainSrcReady) return Promise.resolve();
    return mainSrcFor(currentMainFile).then(function (u) {
      if (mainBlobUrl && mainBlobUrl !== u) { try { URL.revokeObjectURL(mainBlobUrl); } catch (_) {} mainBlobUrl = null; }
      if (u && u.indexOf('blob:') === 0) mainBlobUrl = u;
      mainAudio.src = u; mainAudio.load(); mainSrcReady = true;
    });
  }
  mainAudio.addEventListener('loadedmetadata', function () {
    if (mainOnSilence()) return;   // the priming clip is not a track — see primeMainAudio()
    var t = $('time-total'); if (t) t.textContent = formatTime(mainAudio.duration);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && mainAudio.duration && isFinite(mainAudio.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: mainAudio.duration, playbackRate: 1, position: 0 }); } catch (_) {}
    }
  });
  mainAudio.addEventListener('timeupdate', function () {
    if (mainOnSilence()) return;   // ditto — it must not paint the transport or move dynLastPos
    var pct = mainAudio.duration ? (mainAudio.currentTime / mainAudio.duration) * 100 : 0;
    var f = $('scrubber-fill'); if (f) f.style.width = pct + '%';
    var c = $('time-cur'); if (c) c.textContent = formatTime(mainAudio.currentTime);
    // Adopting an already-playing track (syncToPlayingTrack → attach) never fires
    // 'loadedmetadata' — duration arrives via the native time ticks instead — so the
    // total label painted there would stay "0:00" forever. Repaint it here when stale.
    var tt = $('time-total');
    if (tt && mainAudio.duration && isFinite(mainAudio.duration)) {
      var tot = formatTime(mainAudio.duration);
      if (tt.textContent !== tot) tt.textContent = tot;
    }
    setMiniFill(pct);   // mirror onto the floating mini bar
    if (DYN && !dynPosStale && (mainAudio.currentTime || 0) > 0) dynLastPos = mainAudio.currentTime;   // remember position (resume guard)
    var tailAct = mainTailAction(mainAudio.currentTime || 0, mainAudio.duration, mainAudio.paused,
                                 { repeat: repeatOn, autoplay: autoplayOn, dyn: DYN });
    if (tailAct === 'advance' && !dynPreAdvanced) {
      dynPreAdvanced = true;   // once per track; cleared whenever a new source is set
      dynLog('AUTO pre-advance at ' + mainAudio.currentTime.toFixed(1) + '/' + mainAudio.duration.toFixed(1));
      advanceTopic(1);
    } else if (tailAct === 'loop' && !dynPreLooped) {
      /* ⚠ SEEK, DO NOT STOP AND RESTART. The element keeps playing across a seek, so the audio
         session never goes inactive and nothing has to be re-prepared — which is the whole reason
         this works with the screen locked where the `ended` path did not. What is skipped is the
         tail of the final gap, i.e. silence. */
      dynPreLooped = true;
      dynLog('REPEAT pre-loop at ' + mainAudio.currentTime.toFixed(1) + '/' + mainAudio.duration.toFixed(1));
      if (DYN) { dynPreAdvanced = false; dynLastPos = 0; dynResumeNum = null; }
      mainAudio.currentTime = 0;
    } else if (dynPreLooped && mainAudio.duration && (mainAudio.currentTime || 0) < mainAudio.duration * 0.5) {
      dynPreLooped = false;    // back at the top — arm it for the next time round
    }
    if (DYN && dynSession && dynSessionIsLocal) dynHighlight(mainAudio.currentTime);   // dyn: highlight the playing card (this page's session only)
    writeWebResume();   // keep the cross-page resume position fresh while playing (web only, throttled)
  });
  mainAudio.addEventListener('ended', function () {
    /* ⚠ THE PRIMING CLIP ENDS AFTER 20 ms, MID-BUILD. Without this guard autoplay would read that
       as "the topic finished" and advanceTopic(1) would hop to the next unit before the audio the
       user asked for had even been stitched. */
    if (mainOnSilence()) return;
    if (DYN) { dynLastPos = 0; dynResumeNum = null; }   // track finished — a later play starts over, not at the end
    setMainIcon(false);
    /* ⚠ THIS IS NOW THE FALLBACK, NOT THE MECHANISM. Repeat loops from the timeupdate handler a
       fraction before the end (see mainTailAction) precisely so that it never has to restart a
       STOPPED element from a backgrounded WebView — which is what failed with the screen locked.
       This branch still matters for the cases the pre-loop guards exclude: a track of 20 s or
       less, and any engine whose timeupdate is too sparse to land inside the last 0.45 s. */
    if (repeatOn) {
      dynPreLooped = false;
      mainAudio.currentTime = 0;
      mainAudio.play().then(function () { setMainIcon(true); }).catch(function () {});
      return;
    }
    if (autoplayOn) advanceTopic(1);
  });
  // Dyn + web: after a lock/unlock the OS may have paused the <audio> without our icon ever
  // hearing about it — re-sync the play glyph from the element's real state on return.
  if (DYN && !NATIVE) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') setMainIcon(!mainAudio.paused);
    });
  }

  function formatTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    var m = Math.floor(secs / 60);
    var s = String(Math.floor(secs % 60)).padStart(2, '0');
    return m + ':' + s;
  }

  function togglePlay() {
    if (DYN) dynCancelRebuild();   // r197: a manual tap overrides a pending auto-resume
    if (mainAudio.paused) {
      if (!mayListen()) { gate(mainTier); return; }   // no account, or not entitled → no playback
      userStartedHere = true;   // this page's player is now user-driven → sync must not adopt a stale label
      primeMainAudio();         // ⚠ SYNCHRONOUS, inside the gesture — the build below can take seconds
      ensureMainSrc().then(function () {
        // Round-10 item 4: a long pause can idle the engine and drop the position to 0 —
        // restore the last known position before resuming (and again after a native
        // prepare-resume, which always starts a fresh prepare at 0).
        var want = (DYN && !dynPosStale && dynLastPos > 0.5 && (mainAudio.currentTime || 0) < 0.5 &&
          (!mainAudio.duration || !isFinite(mainAudio.duration) || dynLastPos < mainAudio.duration - 0.5)) ? dynLastPos : null;
        if (want != null) { try { mainAudio.currentTime = want; } catch (_) {} }
        var pp = mainAudio.play();
        setMainIcon(true); setupMediaSession();   // optimistic: the tap gets its feedback instantly
        /* …but the icon is CORRECTED from the promise. It used to be set unconditionally while the
           rejection went uncaught, so a refused start left the button showing "playing" over a
           silent element parked at 0:00 — the owner's report. A lying transport is worse than a
           failed one: the next tap then reads as "pause made it play". */
        if (pp && pp.then) {
          pp.then(function () {
            if (want != null && (mainAudio.currentTime || 0) < 0.5) { try { mainAudio.currentTime = want; } catch (_) {} }
          }, function (e) {
            dynLog('play FAIL ' + ((e && e.name) || e));
            setMainIcon(!mainAudio.paused);
            if (mainAudio.paused) {
              dynStatus('Tap play to start', false);
              var seq = dynStatusSeq;
              setTimeout(function () { if (seq === dynStatusSeq) dynStatus(null); }, 4000);
            }
          });
        }
      }).catch(function (e) { setMainIcon(false); handleDenied(e, mainTier); });
    } else {
      if (DYN && !dynPosStale) dynLastPos = mainAudio.currentTime || dynLastPos;   // remember where we paused
      mainAudio.pause(); setMainIcon(false); writeWebResume(true);
    }
    resumeMainAfter = false;   // a manual tap on the top player overrides auto-resume
  }

  function skip(sec) {
    if (!mainAudio.duration) return;
    mainAudio.currentTime = Math.max(0, Math.min(mainAudio.duration, mainAudio.currentTime + sec));
  }

  // Variable-precision scrubbing: tap/drag to seek. The further your finger moves
  // vertically away from the bar, the finer (slower) the seek.
  function initScrubber() {
    var track = $('scrubber');
    var fill = $('scrubber-fill');
    if (!track) return;
    var dragging = false, lastX = 0, scrubTime = 0;
    function paint(t) {
      if (!mainAudio.duration) return;
      fill.style.width = (t / mainAudio.duration) * 100 + '%';
      $('time-cur').textContent = formatTime(t);
    }
    function precision(clientY, rect) {
      var dist = Math.abs(clientY - (rect.top + rect.height / 2));
      if (dist < 40)  return 1;
      if (dist < 100) return 0.5;
      if (dist < 180) return 0.25;
      return 0.1;
    }
    track.addEventListener('pointerdown', function (e) {
      if (!mainAudio.duration) return;
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      fill.style.transition = 'none';
      var rect = track.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      scrubTime = pct * mainAudio.duration;
      lastX = e.clientX;
      mainAudio.currentTime = scrubTime;
      paint(scrubTime);
      e.preventDefault();
    });
    track.addEventListener('pointermove', function (e) {
      if (!dragging || !mainAudio.duration) return;
      var rect = track.getBoundingClientRect();
      var dx = e.clientX - lastX;
      lastX = e.clientX;
      scrubTime += dx * (mainAudio.duration / rect.width) * precision(e.clientY, rect);
      scrubTime = Math.max(0, Math.min(mainAudio.duration, scrubTime));
      mainAudio.currentTime = scrubTime;
      paint(scrubTime);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false; fill.style.transition = '';
      // Dyn: the committed seek snaps to the nearest sentence start (round-8 item 3).
      if (DYN && dynSession) {
        scrubTime = dynSnapTime(scrubTime);
        mainAudio.currentTime = scrubTime;
        dynLastPos = scrubTime;
        paint(scrubTime);
      }
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
  }

  // Reveal order follows the chosen audio direction. Thai-first (te): the accordion opens Thai →
  // English → notes (the default). English-first (et): it opens English → Thai → notes, and English
  // is reordered above Thai. Driven by a class on #sentence-list that the injected reveal CSS keys off
  // — the static cards and st-0..3 stages are unchanged, so it stays SSR/crawlable.
  function applyDirClass() {
    /* The <html> class is the pre-paint twin of dir-et (it is stamped by an inline head script
       before player.js loads, so the pill hint paints in the right language first time). Sync it
       here too — leaving it set after a switch back to Thai-first would keep the pre-paint rules
       hiding the Thai hint. Set outside the #sentence-list guard so it holds on every page. */
    try { document.documentElement.classList.toggle('te-dir-et', currentMode === 'et'); } catch (_) {}
    var list = $('sentence-list');
    if (!list) return;
    list.classList.toggle('dir-et', currentMode === 'et');
    list.classList.toggle('dir-te', currentMode !== 'et');
  }

  // ---- transliteration toggle (topics with per-sentence `translit`) ----
  // Default ON so new visitors discover it; the choice is remembered per device in
  // localStorage (works signed-out and offline/in the app — same key on every topic).
  function translitOn() { try { return localStorage.getItem('thaiear_translit') !== '0'; } catch (_) { return true; } }
  function applyTranslitClass() {
    if (!HAS_TRANSLIT) return;
    var list = $('sentence-list');
    if (list) list.classList.toggle('translit-off', !translitOn());
    var b = $('translit-btn');
    if (b) b.classList.toggle('on', translitOn());
  }
  function toggleTranslit() {
    try { localStorage.setItem('thaiear_translit', translitOn() ? '0' : '1'); } catch (_) {}
    applyTranslitClass();
  }

  function switchAudio(mode) {
    if (currentMode === mode) return;
    currentMode = mode;
    /* Persist on WEB as well as native (2026-08-15). The NATIVE gate that used to be here is why a
       web visitor's English-first choice died on every navigation — see the currentMode block. */
    try { localStorage.setItem('thaiear_dir', mode); } catch (_) {}
    var wasPlaying = !mainAudio.paused;
    mainAudio.pause();
    setMainIcon(false);
    currentMainFile = mainPrefix + '_' + mode.toUpperCase() + '.mp3';
    mainSrcReady = false;                 // new file → re-resolve (premium needs a fresh signed URL; dyn rebuilds its session)
    if (!DYN && !mainGated && !OFFLINE && !(WEB_DL && isDownloaded(mainPrefix))) { mainAudio.src = AUDIO_BASE + '/' + currentMainFile; mainAudio.load(); mainSrcReady = true; }
    var f = $('scrubber-fill'); if (f) f.style.width = '0%';
    var c = $('time-cur'); if (c) c.textContent = '0:00';
    $('btn-te').classList.toggle('active', mode === 'te');
    $('btn-et').classList.toggle('active', mode === 'et');
    // dyn: new direction = new track; settings are PER MODE so they reload here (r16); the
    // English checkbox is TE-only; re-resolve neighbour placeholders.
    /* r197: a TE/ET switch is a different TRACK, so the sentence anchor is deliberately NOT
       carried across — owner: "that is different and playback progress need not be preserved as
       they are separate tracks." */
    if (DYN) { dynCancelRebuild(); dynLastPos = 0; dynResumeNum = null; dynAttached = false; dynLoadSettings(); dynPrefsRepaintControls(); dynSyncEnToggle(); dynPrefetchNeighbours(); }
    applyDirClass();                      // flip the accordion reveal order to match the new direction
    /* Same gesture problem as togglePlay: in dyn mode this rebuilds the session for the new
       direction, which takes seconds, and the pause two lines up has already deactivated the iOS
       audio session. Prime inside the tap, and let the promise — not optimism — own the icon. */
    if (wasPlaying) {
      primeMainAudio();
      ensureMainSrc().then(function () {
        var pp = mainAudio.play();
        setMainIcon(true);
        if (pp && pp.then) pp.then(null, function (e) {
          dynLog('switch play FAIL ' + ((e && e.name) || e));
          setMainIcon(!mainAudio.paused);
        });
      }).catch(function (e) { setMainIcon(false); handleDenied(e, mainTier); });
    }
  }

  /* ---- continuous playback: advance to another topic in the SAME audio element ----
     The whole point of the persistent-audio model: we never reload the page, we swap the
     top player onto the next/prev accessible topic's combined file and keep going (works
     with the screen locked, and drives the lock-screen ⏮/⏭ via the Media Session API). */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Is a topic genuinely playable RIGHT NOW? Online + entitled → stream; otherwise downloaded + licence.
  function playable(unit) {
    if (!unit || !unit.audio) return false;
    var T = window.ThaiEarTopics;
    if (navigator.onLine && T && T.canAccess && T.canAccess(unit.access)) return true;
    return isDownloaded(unit.audio) && canUseOffline(unit.access);
  }
  // Walk in `dir` PAST any non-playable topics (offline-not-downloaded, expired premium, …) to the
  // next genuinely playable one — so next/prev never lands you on a topic that won't play. null if none.
  function nextPlayable(fromPage, dir) {
    var T = window.ThaiEarTopics;
    if (!T || !T.nextAccessible) return null;
    var page = fromPage, max = (T.liveSequence ? T.liveSequence().length : 60) + 1;
    for (var i = 0; i < max; i++) {
      var unit = T.nextAccessible(page, dir);
      if (!unit || !unit.audio) return null;
      if (playable(unit)) return unit;
      if (bareKey(unit.page) === bareKey(fromPage)) return null;   // wrapped the whole list → none playable
      page = unit.page;
    }
    return null;
  }

  function advanceTopic(dir) {
    // Dyn pages (round-11): walk the CHAIN in place — audio swaps, the page never navigates.
    if (DYN) {
      resolveDynChain();   // D4 first-use lazy retry — see resolveDynChain's own note
      // Round-11: prev/next ALWAYS moves the chain pointer and swaps audio IN PLACE —
      // never a navigation. When locked, units with nothing playable (no persisted
      // session, no placeholder) are skipped, mirroring classic's nextPlayable walk;
      // in the foreground anything can be built, so nothing is skipped.
      if (!dynChain || dynChain.length < 2) { dynLog('advanceTopic: no chain'); return; }
      var fg = document.visibilityState === 'visible';
      var fromIdx = dynChainIdx;
      var hop = null, probe = dynChainIdx, guardN = dynChain.length;
      while (guardN-- > 0) {
        var stp = dynChainStep(dir, probe);
        if (!stp) break;                           // clamped end (topic test pages)
        if (stp.idx === fromIdx) break;            // wrapped the whole chain — nothing playable
        probe = stp.idx;
        /* ⚠ ENTITLEMENT SKIP RUNS IN THE FOREGROUND TOO — this is the r50 fix (§B7). The line
           below reads `fg || dynChainPlayable(...)`, i.e. in the foreground NOTHING was skipped,
           because anything can be built there. That is right for "can it produce audio" and wrong
           for "may they hear it": it walked a lapsed visitor straight into a downloaded premium
           topic. Entitlement is not a can-we question, so it is checked before that shortcut. */
        if (dynUnitLocked(stp.t)) {
          dynLog('chain skip ' + (stp.t.dynKey || stp.t.prefix) + ' (not entitled)');
          continue;
        }
        if (fg || dynChainPlayable(stp.t, stp.idx)) { hop = stp; break; }
        dynLog('chain skip ' + (stp.t.dynKey || stp.t.prefix) + ' (locked, nothing playable)');
      }
      dynLog('advanceTopic dir=' + dir + (hop ? ' → ' + (hop.t.dynKey || hop.t.prefix) : ' (nothing playable)'));
      /* ⚠ The OUTCOME of the walk, to the boot trace. The r52 capture showed no adopt lines at all,
         which means nothing was adopted — so either the walk skipped everything (r50 working) or it
         never ran. Those are opposite conclusions and dynLog could not tell them apart, because it
         does not reach the trace. This line does. */
      if (!hop) return;
      dynChainIdx = hop.idx;
      if (hop.idx === dynHomeIdx) { dynReturnLocal(); return; }
      dynAdvance(hop.t, fromIdx);
      return;
    }
    /* ⚠ RENAMED FROM `T` (r56). `var` is FUNCTION-scoped and hoisted, so this declaration shadowed
       the module-level T() trace helper for the WHOLE function — including the DYN branch above it,
       where T was therefore `undefined`, not a function. Every trace call added there in r53 threw
       a TypeError and aborted advanceTopic, which is why prev/next died on BOTH platforms. Do not
       reintroduce a local named T in a function that also traces. */
    var TOPICS = window.ThaiEarTopics;
    if (!TOPICS || !TOPICS.nextAccessible) return;   // topics.js not present → feature inert
    var unit = nextPlayable(mainPage, dir);         // skip anything that can't actually play now
    if (!unit || !unit.audio) return;
    // Adopt the target topic's identity for the TOP player only (sentence list unchanged).
    mainPage = String(unit.page || '').toLowerCase();
    if (!/\.html$/.test(mainPage)) mainPage += '.html';
    mainPrefix = unit.audio;
    mainTier = (unit.access && unit.access !== 'free') ? unit.access : null;
    mainGated = !!mainTier;
    currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';  // stay on the same TE/ET side
    mainSrcReady = false;
    // reset the transport UI
    var f = $('scrubber-fill'); if (f) f.style.width = '0%';
    var c = $('time-cur'); if (c) c.textContent = '0:00';
    var tt = $('time-total'); if (tt) tt.textContent = '0:00';
    updateNowPlaying(unit);
    // Local copy if downloaded, else a fresh URL each hop (a premium signed URL never goes stale).
    mainSrcFor(currentMainFile).then(function (u) {
      if (mainPrefix !== unit.audio) return;        // a newer hop superseded this one
      mainAudio.src = u; mainAudio.load(); mainSrcReady = true;
      return mainAudio.play();
    }).then(function () { setMainIcon(true); setupMediaSession(); })
      .catch(function (e) { setMainIcon(false); handleDenied(e, mainTier); });
  }

  // "Return": re-align the TOP player with the page you're reading — the inverse of
  // advanceTopic. Playback drifted to another topic (autoplay/next); this snaps it back to
  // THIS page's own topic and plays it, so the now-playing strip realigns (and then hides,
  // because the playing topic == the page topic). Going TO the playing topic already exists
  // as the strip's hyperlink, so we only add this opposite direction.
  function returnToThisTopic() {
    var T = window.ThaiEarTopics;
    var unit = (T && T.pageUnit) ? T.pageUnit(PAGE_FILE) : null;
    mainPage = PAGE_FILE;
    mainPrefix = PREFIX;
    mainGated = GATED;
    mainTier = TIER;
    currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
    mainSrcReady = false;
    var f = $('scrubber-fill'); if (f) f.style.width = '0%';
    var c = $('time-cur'); if (c) c.textContent = '0:00';
    var tt = $('time-total'); if (tt) tt.textContent = '0:00';
    if (unit) updateNowPlaying(unit);                 // unit.page === this page → strip hides
    else { var box = $('now-playing'); if (box) box.classList.remove('show'); }
    mainSrcFor(currentMainFile).then(function (u) {
      if (mainPrefix !== PREFIX) return;              // a newer hop superseded this one
      mainAudio.src = u; mainAudio.load(); mainSrcReady = true;
      return mainAudio.play();
    }).then(function () { setMainIcon(true); setupMediaSession(); })
      .catch(function (e) { setMainIcon(false); handleDenied(e, mainTier); });
  }

  // Lightweight "now playing" refresh: a strip in the player + the tab title + lock screen.
  // The sentence cards below stay on the opened topic, so the strip only shows once we've
  // actually moved off it.
  function updateNowPlaying(unit) {
    var T = window.ThaiEarTopics;
    var lvl = (T && T.levelText && unit.levels) ? T.levelText(unit.levels) : '';
    var box = $('now-playing'), txt = $('now-playing-text');
    var moved = bareKey(unit.page) !== TOPIC_KEY;
    if (box) box.classList.toggle('show', !!moved);
    if (txt) {
      var href = escapeHtml(pageLinkHref(unit.page));
      var npCls = ' class="' + (unit.access === 'premium' ? 'np-premium' : 'np-member') + '"';
      txt.innerHTML = 'Now playing <a href="' + href + '"' + npCls + '><strong>' + escapeHtml(unit.name) + '</strong></a>' + (lvl ? ' · ' + escapeHtml(lvl) : '')
        + (moved ? ' <a href="#" class="np-return" id="np-return" title="Bring the player back to this topic">↩ Return</a>' : '');
      var rb = $('np-return'); if (rb) rb.onclick = function (e) { e.preventDefault(); returnToThisTopic(); };
    }
    // Mirror onto the floating mini: a "Now playing <other topic>" link, shown only when the top
    // player has drifted off THIS page's topic. Its own row/click target (never the seek zone's).
    var mnp = $('te-mini-np');
    if (mnp) {
      if (moved) {
        mnp.setAttribute('href', pageLinkHref(unit.page) || '#');
        mnp.innerHTML = 'Now playing <strong>' + escapeHtml(unit.name) + '</strong>';
        mnp.classList.add('show');
      } else {
        mnp.classList.remove('show');
      }
    }
    if (unit.name) document.title = unit.name + ' · ThaiEar';
    updateMediaSession(unit, lvl);
  }
  function bareKey(page) { return String(page || '').toLowerCase().replace(/\.html$/, ''); }

  /* ---- Media Session: lock-screen metadata + ⏯/⏮/⏭ wired to our controls ---- */
  function updateMediaSession(unit, lvl) {
    // Feed the native lock-screen player its title/subtitle (artwork is constant).
    nativeMeta.title = (unit && unit.name) || 'ThaiEar';
    nativeMeta.subtitle = lvl ? ('ThaiEar · ' + lvl) : 'ThaiEar';
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new (window.MediaMetadata)({
        title: unit.name || 'ThaiEar',
        artist: lvl ? ('ThaiEar · ' + lvl) : 'ThaiEar',
        album: 'ThaiEar — Thai listening'
      });
    } catch (_) {}
  }
  /* Lock-screen TITLE for a dyn chain hop (r58). setupMediaSession() only registers ACTION
     HANDLERS — it never touches navigator.mediaSession.metadata — and the dyn hop called only that,
     so the audio changed and the title did not. The classic path calls updateMediaSession(), which
     DOES set metadata; that is why the live site was right and this was not.
     ⚠ iPhone-ONLY, and it never worked there. The Android app takes its lock-screen title from
     nativeMeta.title, which already reads dynTitle through the Capacitor bridge (~line 110), so it
     was always correct. iOS is the PWA, where the lock screen reads mediaSession.metadata — which
     nothing was writing on a hop.
     ⚠ Deliberately does NOT touch nativeMeta: the native path is verified working on Android and
     there is no reason to put a second writer on it.
     Subtitle is a plain 'ThaiEar' (owner's call) — chain entries carry `name` but no `levels`, so
     showing a level would need a topics.js lookup we do not need. */
  function dynSetMediaMeta() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: dynTitle || 'ThaiEar',
        artist: 'ThaiEar',
        album: 'ThaiEar — Thai listening'
      });
    } catch (_) {}
  }
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    /* r59: set the dyn TITLE here rather than at each call site. Doing it per-site meant only the
       forward hop got it (r58) — returning home via dynReturnLocal, and the very first play, both
       call setupMediaSession() but never wrote metadata, so the lock screen kept the previous
       topic's name, or the raw document title before any hop. dynTitle is initialised to the home
       unit's name at load, so this is correct from the first play onwards.
       Guarded on DYN: classic pages get their title from updateMediaSession() and must not change. */
    if (DYN && dynTitle) dynSetMediaMeta();
    var ms = navigator.mediaSession;
    function set(action, fn) { try { ms.setActionHandler(action, fn); } catch (_) {} }
    // rs= is the diagnostic for the one remaining iPhone case: pause → lock → play gives a
    // moving lock-screen scrubber but no sound. If readyState is 0 here, WebKit unloaded the
    // media while the page was backgrounded and paused, and play() is waiting on a re-load it
    // will not perform until the page is visible — iOS then advances its own scrubber
    // optimistically. If readyState is 4, the element is ready and the fault is elsewhere.
    set('play', function () {
      dynLog('ms:play rs=' + mainAudio.readyState + ' t=' + (mainAudio.currentTime || 0).toFixed(1));
      if (!mainAudio.paused) return;
      /* r27: iOS deactivates the page's AUDIO SESSION when you pause. Re-activating it requires
         play() to be called SYNCHRONOUSLY inside this action handler — togglePlay() routes
         through ensureMainSrc().then(), a microtask later, which is too late: the element then
         plays SILENTLY (owner's overlay: rs=4, currentTime advancing, no sound, and unlocking
         did not help — only pause-then-play in the foreground restored it).
         When the element is already loaded there is nothing to resolve, so call play() straight
         away and only fall back to the full path if it rejects. */
      if (DYN && mainSrcReady && mainAudio.readyState >= 2) {
        var p;
        try { p = mainAudio.play(); } catch (_) { togglePlay(); return; }
        setMainIcon(true);
        setupMediaSession();   // r28a: this path bypasses togglePlay(), which normally does it
        if (p && p.then) {
          p.then(function () { dynLog('ms:play sync ok'); },
                 function (e) { dynLog('ms:play sync FAIL ' + ((e && e.name) || e)); togglePlay(); });
        }
        return;
      }
      togglePlay();
    });
    set('pause', function () { dynLog('ms:pause'); if (!mainAudio.paused) togglePlay(); });
    set('previoustrack', function () { dynLog('ms:prevtrack'); advanceTopic(-1); });
    set('nexttrack', function () { dynLog('ms:nexttrack'); advanceTopic(1); });
    /* iOS Control Center shows the prev/next-TRACK buttons only when the seek handlers are
       absent — otherwise it falls back to the ±15s skip buttons. Clear them explicitly so our
       topic prev/next show on the lock screen. (Our on-page ±10s buttons are unaffected.)
       ⚠ THIS IS A CHOICE, NOT A LIMITATION. Registering 'seekto' instead gives iOS a working
       lock-screen SCRUBBER — the owner saw exactly that on 2026-07-28 when a hop dropped the
       handlers and iOS fell back to its defaults. You can have prev/next topic OR a scrubber,
       not both. Prev/next is the current choice because chain navigation is the feature; note
       that iOS's own ±15s skip does NOT snap to sentences, whereas our ① buttons do. */
    set('seekbackward', null);
    set('seekforward', null);
    set('seekto', null);
  }

  /* ---- autoplay / repeat toggles ---- */
  /* r136 (owner): Autoplay and Repeat are MUTUALLY EXCLUSIVE — both on at once leaves the
     end-of-track outcome ambiguous, so the most recently pressed one wins and switches the other
     off. Turning one OFF never touches the other. */
  function toggleAutoplay() {
    autoplayOn = !autoplayOn; prefSet('thaiear_autoplay', autoplayOn);
    if (autoplayOn && repeatOn) {
      repeatOn = false; prefSet('thaiear_repeat', false);
      var rb = $('btn-repeat');
      if (rb) { rb.classList.remove('active'); rb.setAttribute('aria-pressed', 'false'); }
    }
    var b = $('btn-autoplay');
    if (b) { b.classList.toggle('active', autoplayOn); b.setAttribute('aria-pressed', autoplayOn ? 'true' : 'false'); }
  }
  function toggleRepeat() {
    repeatOn = !repeatOn; prefSet('thaiear_repeat', repeatOn);
    if (repeatOn && autoplayOn) {
      autoplayOn = false; prefSet('thaiear_autoplay', false);
      var ab = $('btn-autoplay');
      if (ab) { ab.classList.remove('active'); ab.setAttribute('aria-pressed', 'false'); }
    }
    var b = $('btn-repeat');
    if (b) { b.classList.toggle('active', repeatOn); b.setAttribute('aria-pressed', repeatOn ? 'true' : 'false'); }
  }
  // Reflect remembered prefs onto the buttons + seed the lock screen with this page's topic.
  function initXtraControls() {
    // Reflect the active direction on the toggle (matters when native restored 'et').
    var bte = $('btn-te'), bet = $('btn-et');
    if (bte) bte.classList.toggle('active', currentMode === 'te');
    if (bet) bet.classList.toggle('active', currentMode === 'et');
    var a = $('btn-autoplay');
    if (a) { a.classList.toggle('active', autoplayOn); a.setAttribute('aria-pressed', autoplayOn ? 'true' : 'false'); }
    var r = $('btn-repeat');
    if (r) { r.classList.toggle('active', repeatOn); r.setAttribute('aria-pressed', repeatOn ? 'true' : 'false'); }
    setupMediaSession();
    var T = window.ThaiEarTopics;
    var unit = (T && T.pageUnit) ? T.pageUnit(PAGE_FILE) : null;
    if (unit) updateMediaSession(unit, (T.levelText && unit.levels) ? T.levelText(unit.levels) : '');
  }

  /* ---- per-sentence audio ---- */
  function getSentAudio() { return $('sent-audio-el'); }

  // main-pause coordination: resume the top player once nothing is playing below it.
  function maybeResumeMain() {
    if (resumeMainAfter && sentPlaying === null) {
      resumeMainAfter = false;
      mainAudio.play().then(function () { setMainIcon(true); }).catch(function () {});
    }
  }

  function resetSentBtn() {
    clearSentStall();
    sentBusyUntil = 0;   // release the network back to the prewarm
    if (sentPlaying !== null) { updateSentBtn(sentPlaying, false); sentPlaying = null; }
    maybeResumeMain();
  }

  var sentResetTimer = null;
  var sentCurFile = null;    // the clip the sentence element is currently on (for the retry above)
  var sentRetried = {};      // file -> already re-minted once this page
  /* ⚠ ONE <audio> ELEMENT SERVES EVERY SENTENCE, SO EVERY CALLBACK MUST SAY WHICH ATTEMPT IT IS
     FROM (2026-08-20, r197). Owner: "sometimes I click an individual sentence and it doesn't play,
     but lights up blue and the icon stays as the play icon; if I hit again it plays fine —
     it happens almost 1/3 of the time."

     THE LOOP THAT CAUSED IT. An `error` on a clip runs failSentLoad, which retries once: it drops
     the cached mint and bytes, DETACHES the dead source (removeAttribute('src') + load()), and
     re-enters toggleSentPlay. But detaching is itself a load — of the empty string, which resolves
     against the document URL — so the browser fires a SECOND `error` a moment later. That one
     lands on the retry that was just started, finds `sentRetried[file]` already set, and takes the
     give-up branch: resetSentBtn(). The button un-lights, sentPlaying goes null, and the retry's
     own src promise then sees `sentPlaying !== num` and quietly bails. Nothing plays, nothing is
     lit, and the next tap works because it starts clean. The blue is the button's :hover, which
     sticks after a tap on touch — which is why the icon stayed a play triangle.

     `sentGen` numbers the attempts: anything asynchronous captures the generation it belongs to
     and does nothing if a newer tap has superseded it. `sentCurSrc` is the source the CURRENT
     attempt put on the element, so an error can be attributed to a load rather than assumed to be
     about whatever is playing now — teardown loads set it to null and are therefore ignored.
          Covered by test_sent_race.js. Full story: `SESSION_2026-08-20_PLAYER_FIXES.md` §6a. */
  var sentGen = 0;
  var sentCurSrc = null;
  /* ⚠ THE OTHER THREE LISTENERS NEEDED THE SAME TREATMENT, AND ONLY `error` GOT IT (2026-08-20,
     r197). Owner, still: "tap, it goes dark blue, the play button doesn't change and no
     audio — the second tap usually works."

     `ended` / `pause` / `timeupdate` all end in resetSentBtn(), which un-lights whatever
     `sentPlaying` is AT THAT MOMENT. pause() does not act immediately: per spec it QUEUES
     `timeupdate` then `pause`. So the switch path — sa.pause(), then synchronously light the new
     sentence — lets the OUTGOING clip's events land on the INCOMING one. They still see the old
     clip's duration/currentTime, so `currentTime >= duration - 0.3` passes, resetSentBtn() fires,
     `sentPlaying` goes null, and the new attempt's src promise then finds `sentPlaying !== num`
     and bails without a sound.

     ⚠ IT ONLY BITES WHEN THE NEW SRC RESOLVES ASYNCHRONOUSLY, which is why it survived §6a and
     its test. A free, prewarmed clip resolves in a MICROTASK, so `sa.src = u` runs BEFORE the
     queued events and resets duration to NaN — the guards then fail and the race is closed by
     accident. The src is genuinely async for: a DOWNLOADED clip (localBlobUrl / cachedBlobUrl,
     always — and the prewarm deliberately skips downloaded prefixes, so there is never a warm
     blob to shortcut it), a gated clip whose mint is not cached, and any clip past MINT_TTL_MS.
     A downloaded topic or playlist therefore takes the async path on EVERY tap.

     `sentSrcGen` is the attempt that put the CURRENT source on the element — the generation twin
     of `sentCurSrc`. Set when the src is assigned, nulled by every teardown (stop, switch,
     failSentLoad's detach), so an event queued by the clip we just abandoned is inert while an
     event from the clip actually playing still works exactly as before.
     Covered by test_sent_race.js. */
  var sentSrcGen = null;
  function sentEvtMine() { return sentSrcGen != null && sentSrcGen === sentGen; }

  /* ---- the stall watchdog (2026-08-19) ----
     ⚠ THE BUTTON HAD NO WAY BACK FROM A LOAD THAT NEITHER LOADS NOR FAILS. toggleSentPlay lights
     the play button the instant it is tapped, and the only things that ever un-light it are
     `ended`, `error`, a rejected play() and sentResetTimer — and that timer is armed INSIDE the
     `loadedmetadata` handler. So a media load that simply hangs (the ordinary failure of a
     mobile connection: no error, no metadata, no rejection) left the button lit for ever, silent,
     with no recovery but another tap. The owner hit this ~3 times in 20 taps on a freshly opened
     topic — see the network-priority note on prewarmSentences for WHY it clustered there.
     This is the deadline the media element does not have. It shares one recovery path with the
     `error` listener rather than adding a second: drop what we cached for the clip, retry once,
     and if that fails too, tell the truth in the UI. */
  var SENT_STALL_MS = 5000;   // a sentence clip is 7-10 KB; 5 s is already a very sick connection
  var sentStallTimer = null;
  function clearSentStall() {
    if (sentStallTimer) { clearTimeout(sentStallTimer); sentStallTimer = null; }
  }
  function armSentStall(num, file, gen) {
    clearSentStall();
    sentStallTimer = setTimeout(function () {
      sentStallTimer = null;
      failSentLoad(num, file, 'stalled', gen);
    }, SENT_STALL_MS);
  }
  /* Shared by the `error` event and the watchdog above. Both mean the same thing to a user (I
     pressed play and nothing happened) and both want the same cure, so they must not drift. */
  function failSentLoad(num, file, why, gen) {
    if (gen != null && gen !== sentGen) return;       // this attempt was superseded - it owns nothing
    latMark('FAIL', why + '  ' + latSinceTap() + 'ms after tap');
    clearSentStall();
    if (num == null || sentPlaying !== num) return;   // superseded by a later tap - leave it alone
    if (file && !sentRetried[file]) {
      sentRetried[file] = true;
      mintDrop(file);
      if (sentBlobs[file]) { sentBlobBytes -= (sentBlobs[file].size || 0); delete sentBlobs[file]; }
      /* Detach the dead source before retrying. A hung element left with its old src can fire a
         late error over the top of the retry and cancel it. */
      /* Disown the source FIRST. Detaching fires an `error` of its own (an empty src is a load
         of the document URL), and without this the retry below is killed by its own cleanup. */
      sentCurSrc = null; sentSrcGen = null;
      try { var sa = getSentAudio(); sa.pause(); sa.removeAttribute('src'); sa.load(); } catch (_) {}
      sentPlaying = null; sentLock = null; sentBusyUntil = 0;
      toggleSentPlay({ stopPropagation: function () {}, preventDefault: function () {} }, num);
      return;
    }
    try { var el2 = getSentAudio(); el2.pause(); } catch (_) {}
    resetSentBtn();   // second failure: un-light the button, so the UI stops claiming it is playing
  }

  function initSentAudio() {
    var el = $('sent-audio-el');
    if (!el) return;
    // All three of these un-light the button, so all three must belong to the attempt that owns
    // the element — see the note above sentSrcGen.
    el.addEventListener('ended', function () { if (sentEvtMine()) resetSentBtn(); });
    if (LAT) el.addEventListener('playing', function () { if (!sentOnSilence()) latMark('PLAYING', latSinceTap() + 'ms after tap'); });
    /* ⚠ A REUSED SIGNED URL FAILS HERE, NOT IN A REJECTED PROMISE. buildUrl() has already
       resolved by the time the media element goes to R2, so an R2 token rotation — or a clock
       skew wider than mintPut()'s 10-minute margin — arrives as a plain media error. Drop what
       we cached for that clip and try ONCE with a freshly minted URL; a second failure resets
       the button exactly as before. Without this, one stale mint would look like broken audio
       for the rest of the page's life. */
    el.addEventListener('error', function () {
      /* Only errors about the source THIS attempt put on the element count. Our own teardown loads
         (the stop path's src='', failSentLoad's detach) null sentCurSrc first, so they are ignored
         instead of cancelling the clip that is starting. */
      if (!sentCurSrc || el.getAttribute('src') !== sentCurSrc) return;
      failSentLoad(sentPlaying, sentCurFile, 'error', sentGen);
    });
    el.addEventListener('loadedmetadata', function () {
      /* Proof the source was good: stand the watchdog down, release the network back to the
         prewarm, and let this clip be retried again later if it ever goes bad. */
      if (sentOnSilence()) return;   // the priming clip proves nothing about the real one
      clearSentStall();
      sentBusyUntil = 0;
      if (sentCurFile) delete sentRetried[sentCurFile];
    });
    el.addEventListener('pause', function () { if (sentEvtMine() && el.duration && el.currentTime >= el.duration - 0.3) resetSentBtn(); });
    el.addEventListener('timeupdate', function () { if (sentEvtMine() && el.duration && el.currentTime > 0 && el.currentTime >= el.duration - 0.15) resetSentBtn(); });
  }

  /* ⚠ §2's PRIMING, FOR THE OTHER ELEMENT. The gesture requirement is PER ELEMENT, so unlocking
     mainAudio in primeMainAudio() does nothing for #sent-audio-el — and this element's src is
     resolved ASYNCHRONOUSLY on exactly the paths listed above sentSrcGen (a downloaded clip
     always; a gated clip with no cached mint; anything past MINT_TTL_MS). By the time sa.play()
     runs, the tap's gesture token is gone, WebKit refuses with NotAllowedError, the catch
     un-lights the button and nothing is heard — the reported symptom, from a second direction.

     Playing 20 ms of silence synchronously INSIDE the tap marks the element allowed-to-play
     before the wait starts, and re-activates the iOS audio session, which a pause deactivates.
     Not one-shot, for the same reason primeMainAudio() is not.

     The silence belongs to NO attempt: sentCurSrc / sentSrcGen stay null across it, so every
     listener on the element already ignores its `ended`, `pause` and `error` — including the
     `error` a CSP that blocks data: media would produce, which is why this degrades instead of
     breaking. Its `loadedmetadata` is filtered by sentOnSilence() so it cannot stand the real
     clip's stall watchdog down. */
  function sentOnSilence() {
    var el = getSentAudio();
    if (!el) return false;
    var u = el.currentSrc || el.src || '';
    return u.indexOf('data:audio') === 0;
  }
  function primeSentAudio(sa) {
    if (!sa || !sa.paused) return;   // never clobber audio this is meant to protect
    try {
      sentCurSrc = null; sentSrcGen = null;   // the priming clip is not an attempt
      sa.src = MAIN_SILENCE;
      sa.load();
      var p = sa.play();
      // An AbortError once the real clip lands is the normal hand-off — see primeMainAudio().
      if (p && p.then) p.then(null, function () {});
    } catch (_) {}
  }

  function toggleSentPlay(e, num) {
    e.stopPropagation();
    e.preventDefault();
    if (!mayListen()) { gate(); return; }   // no account, or not entitled → no sentence audio
    if (gateSent(num)) return;                    // playlist: locked sentence → its own tier's gate
    if (noDlSent(num)) return;                    // playlist: offline + clip not on the device
    /* ⚠ DEBOUNCE THE SAME SENTENCE, NEVER A DIFFERENT ONE (2026-08-20).
       This was a blunt global: ANY tap within 300 ms of ANY other was discarded in complete
       silence — no audio, no icon, no message. It is the only path in this function that drops a
       tap without telling the user anything, and 300 ms is a long time on a phone: tap a sentence,
       feel nothing happen while the clip loads, reach for the next one, and that tap is eaten.
       failSentLoad's retry re-enters here too, so an auto-retry could swallow the user's next tap
       as well.
       The double-fire it actually guards against is a repeat on the SAME button, so that is all it
       guards now. Two different sentences overlapping is safe since sentGen: the newer attempt
              supersedes the older one, and every stale callback checks its generation.
       Full story: `SESSION_2026-08-20_PLAYER_FIXES.md` §6b. */
    if (sentLock === num) return;
    sentLock = num;
    setTimeout(function () { if (sentLock === num) sentLock = null; }, 300);
    var gen = ++sentGen;   // this tap's attempt number — see the note above sentGen
    var sa = getSentAudio();
    clearSentStall();
    /* Hand the network to the tap. The idle prewarm runs three fetches at a time and WebKit
       throttles parallel bursts hard (the same behaviour that made iOS dyn builds take two
       minutes before DYN_POOL existed), so a tap arriving mid-prewarm could queue behind them
       and look like a dead button. This is why the owner's stalls clustered on a just-opened
       topic: that is exactly when the prewarm is running. */
    /* Resolve the filename BEFORE yielding — prewarmYield() needs to know which clip to spare,
       and the sObj lookup below is pure, so hoisting it changes nothing else. */
    var sObj = null;
    for (var si = 0; si < sentences.length; si++) { if (sentences[si].num === num) { sObj = sentences[si]; break; } }
    var file = sentFileFor(sObj, num);   // shared with prewarmSentences
    prewarmYield(file);

    // tapping the playing sentence again stops it
    if (sentPlaying === num) {
      plysClipDisarm();          // stopped before the dwell elapsed → not a listen
      sentCurSrc = null; sentSrcGen = null;   // an empty src fires `error`; disowning it first keeps that quiet
      sa.pause(); sa.src = ''; revokeSentBlob(); sentPlaying = null; updateSentBtn(num, false);
      sentBusyUntil = 0;
      maybeResumeMain();
      return;
    }
    // stop any other sentence (top player stays paused — don't resume between clips)
    /* ⚠ DISOWN THE OUTGOING CLIP BEFORE PAUSING IT. sa.pause() only QUEUES its `timeupdate` and
       `pause`; they land after this function has already lit the new sentence, and until r197
       they reset it — see the note above sentSrcGen. */
    if (sentPlaying !== null) {
      plysClipDisarm();
      sentCurSrc = null; sentSrcGen = null;
      sa.pause(); updateSentBtn(sentPlaying, false); sentPlaying = null;
    }
    primeSentAudio(sa);   // ⚠ SYNCHRONOUS, inside the gesture — the src below may take a round trip

    // If the top player is going, pause it — but DON'T auto-resume when the clip ends. The user
    // restarts the main track themselves in their own time. (Was: resumeMainAfter = true, which
    // resumed the top player once the sentence finished.)
    if (!mainAudio.paused) { mainAudio.pause(); setMainIcon(false); }

    // Playlist sentences carry their own prefix/tier/clipNum (a playlist mixes topics);
    // topic pages resolve exactly as before (sObj fields absent → PREFIX/GATED defaults).
    // sObj / file were resolved above, before prewarmYield().
    sentCurFile = file;
    if (LAT) {
      latTapT = performance.now();
      var latPath = sentBlobs[file] ? 'WARM-BLOB' : (hasLocalFile((sObj && sObj.prefix) || PREFIX, file) ? 'downloaded'
        : (mintGet(file) ? 'mint-cached + net' : (GATED || (sObj && (sObj.tier === 'member' || sObj.tier === 'premium')) ? 'COLD: mint + net' : 'COLD: net')));
      latMark('TAP', 's' + num + '  ' + file + '  warm ' + latWarm + '/' + latWant + '  → ' + latPath);
    }
    var sentGated = (sObj && sObj.tier != null) ? (sObj.tier === 'member' || sObj.tier === 'premium') : undefined;
    sentPlaying = num;
    updateSentBtn(num, true);
    if (sentResetTimer) { clearTimeout(sentResetTimer); sentResetTimer = null; }
    // Resolve the src: local copy if downloaded, else free CDN / signed-URL fetch. Then play.
    // Pass the sentence's OWN prefix/tier — on a playlist the page-level ones are ''/'free'.
    sentSrcFor(file, sentGated, (sObj && sObj.prefix) || null, (sObj && sObj.tier) || null).then(function (u) {
      // user stopped/switched while the URL was resolving → drop the freshly-made blob to avoid a leak
      if (gen !== sentGen || sentPlaying !== num) { if (u && u.indexOf('blob:') === 0) { try { URL.revokeObjectURL(u); } catch (_) {} } return; }
      revokeSentBlob();                                    // free the previous clip's object URL
      sa.src = u;
      sentCurSrc = u;                                      // the source THIS attempt owns
      sentSrcGen = gen;                                    // …and the attempt that owns it
      if (u && u.indexOf('blob:') === 0) sentBlobUrl = u;  // track for revocation on next swap/stop
      sa.load();
      latMark('src', latSinceTap() + 'ms after tap  ' + (String(u).indexOf('blob:') === 0 ? 'blob:' : 'remote'));
      armSentStall(num, file, gen);   // nothing else un-lights the button if this load simply hangs
      sa.addEventListener('loadedmetadata', function onMeta() {
        sa.removeEventListener('loadedmetadata', onMeta);
        if (gen !== sentGen) return;   // a later tap owns the element now
        latMark('meta', latSinceTap() + 'ms after tap');
        var duration = sa.duration || 5;
        if (sentResetTimer) clearTimeout(sentResetTimer);
        sentResetTimer = setTimeout(function () { resetSentBtn(); sentResetTimer = null; }, (duration + 0.5) * 1000);
        plysClipArm(num, duration);   // play counting — the dwell rule, see plysClipArm
      });
      sa.playbackRate = slowMode ? 0.75 : 1.0;
      return sa.play();
    }).catch(function (err) {
      if (gen !== sentGen) return;   // superseded — the newer tap owns the button now
      plysClipDisarm();          // never played → never counted
      updateSentBtn(num, false);
      if (sentPlaying === num) sentPlaying = null;
      maybeResumeMain();
      handleDenied(err);
    });
  }

  function updateSentBtn(num, playing) {
    var btn = document.querySelector('#sc-' + num + ' .sent-play-btn');
    if (!btn) return;
    btn.classList.toggle('playing', playing);
    btn.querySelector('svg').innerHTML = playing
      ? '<rect x="3" y="2" width="3.5" height="12"/><rect x="9.5" y="2" width="3.5" height="12"/>'
      : '<polygon points="4,2 13,8 4,14"/>';
  }

  /* ---- render ---- */
  function seg(on) { return '<div class="prog-seg' + (on ? ' on' : '') + '"></div>'; }

  function chipHtml(gloss) {
    return gloss.map(function (pair) {
      var tl = pair[2] ? '<span class="g-tl">/ ' + pair[2] + '</span>' : '';
      return '<span class="gloss-chip"><span class="g-thai">' + pair[0] + '</span>' + tl + '<span class="g-eq">=</span><span class="g-eng">' + pair[1] + '</span></span>';
    }).join('');
  }

  // Feather-style flag. Faint purple outline (unflagged) → solid purple (flagged), via CSS.
    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>' +
    '<line x1="4" y1="22" x2="4" y2="15"/></svg>';

  // A locked playlist row: preview + padlock only, never the Thai/English body. Any tap goes to
  // the gate. The number is kept so the group still reads as part of the list.
  var LOCK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  /* The collapsed pill's hint, in both languages (2026-08-18). CSS on #sentence-list.dir-et
     decides which one shows; see the .pv-th/.pv-en rules in STYLES. Kept as one helper because
     ssrify_topic.js generates the identical markup statically — two copies of this that can drift
     is exactly how the SSR and JS paths diverge. */
  function previewHtml(s) {
    var en = s.previewEn ? String(s.previewEn) : '';
    return '<span class="sent-preview">' +
      '<span class="pv-th' + (en ? '' : ' pv-only') + '">' + s.preview + '</span>' +
      (en ? '<span class="pv-en">' + en + '</span>' : '') +
      '<span class="ell">…</span></span>';
  }
  /* Accessible name carries BOTH hints, so it still contains the visible text whichever direction
     is on. A name that switches with the direction would need re-writing on every mode change;
     this way the static SSR label stays correct and label-content-name-mismatch stays fixed. */
  function previewAria(s) {
    return ariaText(s.preview) + (s.previewEn ? ' / ' + ariaText(s.previewEn) : '');
  }

  /* ⚠ STALE-PAGE HINT REPAIR (2026-08-19) — do not remove, and read why before "simplifying" it.
     The direction-aware pill needs the TWO hint spans in the card markup. A page whose HTML
     predates 2026-08-18 has neither the spans nor `previewEn` in its data block, so switching to
     English first flips the accordion order and the reveal CSS while the pill keeps showing Thai
     — the toggle looks half-broken. That page is not hypothetical and it is not only the one bad
     load after a deploy:
       · `thaiear-dl` holds a DOWNLOADED topic's HTML forever (it survives every VERSION bump by
         design), and sw.js's 2 s network timeout serves it while ONLINE — positiveCacheMatch()
         searches every cache — so a slow cold start on the phone lands on pre-pill markup;
       · offline, a downloaded topic ALWAYS renders from that copy until it is re-downloaded.
     The deploy-transition case is deliberately NOT covered: that load runs the old `player.js`
     too, and it is fresh on the next navigation regardless. In the two DOWNLOAD cases, though,
     `player.js` is precached and therefore CURRENT while the HTML is not — and that asymmetry is
     the whole point: the half of the pair that is guaranteed fresh repairs the half that isn't.
     Nothing else will: contentHash() hashes num+thai+english only (on purpose — the hint pass must
     not stale every download), so a saved page is never flagged for re-download over this.
     Source is /sentence-hints.json — the same generated {globalNum: [thai, english]} lookup the
     playlist rows read (gen_sentence_hints.js), precached so it resolves offline too.
     One-shot and feature-detected: a current page carries .pv-th and this returns before it
     fetches anything. Nothing awaits it — the pill is cosmetic and must never gate a mount. */
  function repairStaleHints() {
    if (!SSR) return;                                     // the JS-built list already renders previewHtml()
    var list = $('sentence-list');
    if (!list || list.querySelector('.pv-th')) return;    // markup is already direction-aware
    fetch('sentence-hints.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) {
        if (!h) return;
        sentences.forEach(function (s) {
          if (!s.previewEn) {
            var row = h[s.num];                           // topic pages key cards by the GLOBAL num
            if (row && row[1]) s.previewEn = row[1];
          }
          if (!s.previewEn) return;
          var card = document.getElementById('sc-' + s.num);
          if (!card) return;
          var pv = card.querySelector('.sent-preview');
          if (pv) pv.outerHTML = previewHtml(s);          // the same helper ssrify_topic.js mirrors
          var head = card.querySelector('.sentence-header');
          if (head) {                                     // keep the accessible name carrying both hints
            var lbl = head.getAttribute('aria-label') || '';
            var suffix = / — Premium content$/.test(lbl) ? ' — Premium content' : '';
            head.setAttribute('aria-label', 'Sentence ' + dispNum(s) + ': ' + previewAria(s) + suffix);
          }
        });
      })
      .catch(function () {});
  }

  /* RUNTIME dyn state classes (2026-08-20).
     syncCard() re-applies these after every SSR reveal; the non-SSR path (the playlist player)
     rebuilds #sentence-list wholesale from these two helpers instead, so without this the
     .dyn-live highlight on the currently-playing card was DESTROYED the moment you touched any
     pill — the exact "it highlights while playing, then vanishes if I interact with it" report.
     Keep this in step with syncCard(): the two must produce the same class list. */
  function dynStateClasses(s) {
    if (!DYN || !s) return '';
    var cls = '';
    if (dynExcluded[s.num]) cls += ' dyn-off';
    if (dynLastLive === s.num) cls += ' dyn-live';
    return cls;
  }

  function lockedCardHtml(s) {
    var d = dispNum(s);
    return '<div class="sentence-card' + sentCardClasses(s) + dynStateClasses(s) + '" id="sc-' + s.num + '">' +
      '<div class="sentence-header" onclick="gateSentence(' + s.num + ')" role="button" tabindex="0" ' +
        'aria-label="Sentence ' + d + ': ' + previewAria(s) + ' — Premium content">' +
        '<span class="sent-num">' + d + '</span>' +
        '<span class="sent-lock-ico">' + LOCK_SVG + '</span>' +
        previewHtml(s) +
      '</div>' +
    '</div>';
  }

  function cardHtml(s) {
    if (sentLocked(s)) return lockedCardHtml(s);
    var st = states[s.num];
    var playing = sentPlaying === s.num;
    var displayThai = cleanThai(s.thai);
    var d = dispNum(s);
    return '<div class="sentence-card' + sentCardClasses(s) + dynStateClasses(s) + '" id="sc-' + s.num + '">' +
      '<div class="sentence-header" onclick="cycle(' + s.num + ')" role="button" tabindex="0" aria-label="Sentence ' + d + ': ' + previewAria(s) + '">' +
        '<span class="sent-num">' + d + '</span>' +
        '<button class="sent-play-btn' + (playing ? ' playing' : '') + '" onclick="toggleSentPlay(event,' + s.num + ')" aria-label="Play sentence ' + d + '">' +
          '<svg viewBox="0 0 16 16">' + (playing
            ? '<rect x="3" y="2" width="3.5" height="12"/><rect x="9.5" y="2" width="3.5" height="12"/>'
            : '<polygon points="4,2 13,8 4,14"/>') + '</svg>' +
        '</button>' +
        '<button class="speed-toggle' + (slowMode ? ' active' : '') + '" onclick="toggleSlow(event)" aria-label="Slow playback" title="Slow speed">🐢</button>' +
        previewHtml(s) +
        /* r145 — NO reveal-stage segment bar on a PLAYLIST card (owner, 2026-08-08: "the old pill
           expander thing … is defunct"). All 93 topic pages ship style2, and body.te-v2 hides
           .prog-wrap outright; the playlist player is deliberately NOT a te-v2 page (it takes
           targeted `body.dyn-plmode` rules instead — see DYN_STYLES), so it was the one surface
           left still drawing it. And it was wrong there in a way it never was on a topic page:
           three segments on a card whose notes stage was empty, so the third could never fill.
           Not emitted rather than display:none'd — the element is dead markup here, and the SSR
           topic pages still ship it statically, so the CSS itself has to stay. Tap-to-expand
           mechanics are untouched. */
        (PLMODE ? '' : '<div class="prog-wrap" aria-hidden="true">' + seg(st >= 1) + seg(st >= 2) + seg(st >= 3) + '</div>') +
      '</div>' +
      (st > 0 ? '<div class="sentence-body">' +
        '<div class="reveal-row row-thai">' + displayThai + (s.translit ? '<div class="thai-translit">' + cleanThai(s.translit) + '</div>' : '') + '</div>' +
        (st >= 2 ? '<div class="reveal-row row-english">' + s.english + '</div>' : '') +
        (st >= 3 && (!PLMODE || (s.gloss && s.gloss.length) || s.cultural) ? '<div class="reveal-row row-notes">' +
          '<div class="gloss-row">' + chipHtml(s.gloss) + '</div>' +
          (s.cultural ? '<div class="cultural-note">' + s.cultural + '</div>' : '') +
        '</div>' : '') +
      '</div>' : '') +
    '</div>';
  }

  // SSR: reflect each card's reveal stage onto its class (st-0..st-3); CSS in the page
  // <head> shows/hides the matching rows. No innerHTML rebuild → the static text survives.
  function syncCard(num) {
    var c = $('sc-' + num);
    if (!c) return;
    var cls = 'sentence-card st-' + (states[num] || 0);
    // DYN: this wholesale className rewrite must not wipe the dyn state classes
    if (DYN && dynExcluded[num]) cls += ' dyn-off';
    if (DYN && dynLastLive === num) cls += ' dyn-live';
    cls += sentCardClasses(sentById(num));   // nor the playlist lock / premium-gold classes
    c.className = cls;
  }

  // Playlist list HTML, with the "Premium content" divider inserted before the first locked
  // card. dynApplyLockOrder() has already sunk them to the bottom, so one divider covers the lot.
  function listHtml() {
    var firstLocked = PLMODE ? dynFirstLockedNum() : null;
    return sentences.map(function (s) {
      var head = (firstLocked !== null && s.num === firstLocked)
        ? '<div class="sent-lock-group">' + LOCK_SVG + '<span>Premium content</span></div>' : '';
      return head + cardHtml(s);
    }).join('');
  }

  function render() {
    if (SSR) sentences.forEach(function (s) { syncCard(s.num); });
    else {
      // innerHTML replaces every card node, so anything the dyn layer ATTACHED to a card (the
      // equaliser cue, the select tick, the exclude −) is destroyed with it and has to be
      // re-attached. State that lives in a class is carried by dynStateClasses() above.
      $('sentence-list').innerHTML = listHtml();
      if (DYN) dynDecorateCards();
    }
    applyDirClass();   // keep the reveal order in sync with the current TE/ET direction
    applyTranslitClass();   // reflect the stored transliteration preference (default on)

    var allOpen = sentences.filter(function (s) { return !sentLocked(s); })
      .every(function (s) { return states[s.num] === 3; });
    var btn = $('reveal-all-btn');
    if (!btn) return;
    btn.innerHTML = allOpen
      ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l12 12M6.5 6.6A2.5 2.5 0 0 0 10 10.5M1 8s2.5-5 7-5c1 0 2 .2 2.8.6M15 8s-.8 1.6-2.5 3M8 13c-4.5 0-7-5-7-5"/></svg> Collapse all'
      : '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/></svg> Reveal all';
  }

  function cycle(num) {
    if (!entitledForPage()) { gate(); return; }   // gated topic + not entitled → no reveal
    if (gateSent(num)) return;                    // playlist: locked sentence → its own tier's gate
    if (noDlSent(num)) return;                    // not downloaded → say so, don't expand
    var mod = 4;
    if (PLMODE) {
      // Playlist items ship no gloss/cultural notes — skip the empty notes stage entirely.
      var s = null;
      for (var i = 0; i < sentences.length; i++) { if (sentences[i].num === num) { s = sentences[i]; break; } }
      if (s && !(s.gloss && s.gloss.length) && !s.cultural) mod = 3;
    }
    states[num] = (states[num] + 1) % mod; render();
  }

  function toggleAll() {
    if (!entitledForPage()) { gate(); return; }
    // Reveal-all must not reveal LOCKED rows — they render as padlocks either way, but leaving
    // their state at 0 keeps "all open" honest and stops a later unlock showing them pre-opened.
    // …and not the greyed, not-downloaded rows either — same reasoning: they render as a state,
    // not as content, so leaving them at 0 keeps "all open" honest.
    var open = sentences.filter(function (s) { return !sentLocked(s) && !sentNoDl(s); });
    var allOpen = open.every(function (s) { return states[s.num] === 3; });
    open.forEach(function (s) { states[s.num] = allOpen ? 0 : 3; });
    render();
  }

  /* ---- progress controls (add / remove / my progress) ----
     Single-source like the rest of the player: every topic page gets this row
     above the transport bar. Logged out → a prompt that routes to join.html.
     Logged in → a live tally with +/- buttons that write to the user's row. */

  /* END-OF-TOPIC ASK (2026-08-15) — signed out, FREE topic only.
     Someone who has scrolled past every sentence is the warmest visitor this site gets, and until
     now the only thing offered at that point was a link to the next topic.

     ⚠ THE GATE IS DELIBERATELY NARROWER THAN THE SIGNUP CARD'S. On a premium topic a signed-out
     visitor could not play anything, so "that's all N sentences" would be a claim about work they
     never did — and the ask would sit beside a padlock, reading as "sign up to unlock", which a
     free account does not do. Free topics only. (Owner, 2026-08-15.)

     ⚠ Injected rather than baked into the SSR HTML on purpose: it is a call to action, not
     content a crawler needs, so it keeps all 93 topic pages out of the diff and needs no
     ssrify_topic.js run.

     Re-entrant: called on mount AND on thaiear:auth, so it must remove its own node when the
     visitor turns out to be signed in, and must not stack duplicates when called twice. */
  function mountEndCta() {
    /* ⛔ RETIRED 2026-08-21. It said "That's all N sentences. Save what you've done — a free
       account keeps your progress…" to a signed-out visitor on a free topic. Since audio needs
       an account, that visitor has now listened to NOTHING, so both halves are false: they have
       not reached the end of anything, and there is no work to save. The ask that belongs in
       that moment is the play gate itself, which they will already have met.
       Left as an early return rather than deleted: the markup, the styles and the placement were
       all tuned, and if the ask comes back in another form this is where it goes. */
    return;
    /* eslint-disable no-unreachable */
    if (PLMODE) return;
    var nav = document.querySelector('.topic-nav');
    if (!nav || !nav.parentNode) return;
    var old = document.getElementById('te-end-cta');
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) return;                        // hold until auth resolves
    var show = !(a.getUser && a.getUser()) && !TIER;     // signed out + free topic (TIER is null when free)
    if (!show) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    if (old) return;                                     // already mounted — do not stack
    var d = document.createElement('div');
    d.id = 'te-end-cta';
    d.className = 'te-endcta';
    d.innerHTML =
      '<span class="te-endcta-title">That’s all ' + sentences.length + ' sentences.</span>' +
      '<span class="te-endcta-desc">Save what you’ve done — a free account keeps your progress ' +
        'and lets you build playlists with any sentences on the site.</span>' +
      '<a class="te-endcta-cta" href="join.html?feature=1&next=' +
        encodeURIComponent(PAGE_FILE) + '">Create a free account →</a>';
    nav.parentNode.insertBefore(d, nav);
  }

  /* ⚠ THE SLOT SURVIVES; ONLY THE PROGRESS BAR IS GONE (2026-08-20, PLAYS_COUNTER.md).
     The "+ Add progress" counter was a manual tap asking the user to self-report what the site
     now measures for itself — the per-sentence play counts on the cards below.

     ⚠⚠ DO NOT DELETE #progress-controls ALONG WITH IT. This slot is ALSO where the signed-out
     signup card renders inside the app and the installed PWA (in a plain browser that card lives
     in the offline-bar slot instead). Removing the element would leave a signed-out app user with
     no signup CTA at all — the exact bug reported and fixed on 2026-08-15.

     So this now has exactly two outcomes:
       signed out, in app/PWA -> the signup card   (reserve: .te-rsv-card, 133/153/114px)
       everything else        -> empty, collapsed  (reserve: 0)
     which is why the four measured breakpoint bands the old bar needed (54/74/81/94px) are gone
     from STYLES: they existed only because the BAR was a variable-height element that wrapped at
     375 and 439px. Nothing in this slot varies with width any more except the card, which carries
     its own reserve. */
  function renderProgress() {
    var box = $('progress-controls');
    if (!box) return;
    var G = window.ThaiEarAppCTA;
    var inApp = !!(G && G.noDownloadUi && !G.noDownloadUi());
    var a = window.ThaiEarAuth;
    /* ⚠ Decide from authGuess(), not isReady, for the same reason as before: getUser() is null
       for the first few hundred ms even on a device that is definitely signed in, so waiting
       painted the signup card and then took it away again — a visible flash AND a shove, because
       the two states are different heights. authGuess() reads the signed-out marker
       synchronously, so the FIRST paint is the right one. */
    var guess = (G && G.authGuess) ? G.authGuess() : null;
    var user = a && a.getUser && a.getUser();
    var signedOut = !user && guess !== 'in';

    // Only one thing can ever render here now, so the reserve is a straight two-way choice.
    box.classList.toggle('te-rsv-card', signedOut && inApp);
    box.classList.toggle('te-anon', !(signedOut && inApp));
    box.classList.toggle('te-empty', !(signedOut && inApp));   // collapses the slot's own margin

    var sig = signedOut && inApp ? 'card|' + (PLMODE ? 'pl' : 'topic') : 'empty';
    if (box.getAttribute('data-sig') === sig) return;   // idempotence: auth notifies ~5x on startup
    box.setAttribute('data-sig', sig);

    if (signedOut && inApp && G && G.signupHtml) {
      box.innerHTML = G.signupHtml(PLMODE ? 'playlist' : 'topic', PAGE_FILE, { app: false });
    } else {
      box.innerHTML = '';   // browser signed-out: the card lives in the offline bar, as before
    }
  }


  // Load the user's progress once, then render; re-run whenever auth resolves/changes.
  function initProgress() {
    /* r140: the PLMODE short-circuit is gone. It skipped loadProgress() entirely — correct while a
       playlist had no card, and now the difference between a real tally and a permanent 0.
       DYN_KEY_NS is assigned once from cfg.dynKey and never reassigned, so a chain hop (which swaps
       the AUDIO in place without navigating) cannot drift this key: the card keeps counting THE
       PAGE'S playlist, which is the one the user is looking at and the one the +/- buttons name. */
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) { renderProgress(); return; }
    if (a.getUser && a.getUser() && a.loadProgress) {
      a.loadProgress().then(renderProgress).catch(renderProgress);
    } else {
      renderProgress();
    }
    /* Play counts: pull the account copy once so the numbers on this page reflect what was heard
       on other devices, and so anything queued from a previous offline session is delivered.
       Deliberately NOT awaited and NOT gated on the render — it never blocks or delays anything,
       and offline it resolves the local copy rather than hanging. */
    if (a.getUser && a.getUser() && a.loadPlays) a.loadPlays().catch(function () {});
  }
  window.addEventListener('thaiear:auth', initProgress);
  /* auth.js notify()s on every play too (plysNote -> notify), so this is what makes a chip
     tick over the moment the dwell rule fires, without the player knowing anything about it. */
  window.addEventListener('thaiear:auth', plysRepaintChips);
  /* The offline bar's app-card branch is now auth-dependent (suppressed while signed out, since
     the signup card carries the app line), and auth settles AFTER first paint — so it has to
     repaint here or a signed-in visitor keeps the signed-out state for the whole session. */
  window.addEventListener('thaiear:auth', renderOfflineBar);
  mountEndCta();
  window.addEventListener('thaiear:auth', mountEndCta);

  /* Playlists: entitlement is only knowable once auth resolves, and sentLocked() deliberately
     returns false until then (never lock a paying user mid-resolve). So the lock grouping has to
     be re-applied on every auth change — sign-in, sign-out, and the subscription arriving a beat
     after the user does.
     No session invalidation needed: dynKey() is derived from dynIncluded(), so removing (or
     restoring) a sentence changes the key and dynEnsureSession rebuilds on the next play. */
  window.addEventListener('thaiear:auth', function () {
    if (!PLMODE) return;
    dynApplyLockOrder();
    render();
  });
  /* ⚠ ENTITLEMENT ALSO FLIPS ON A NETWORK CHANGE — re-apply on those too (r39, owner-reported).
     canUseOffline answers a different question online and offline: online a fresh server read
     decides, offline the grace window does. So going airplane can UNLOCK premium (verified
     recently → we still vouch for them) and reconnecting can re-lock it. Without this listener the
     cards kept the grouping they were rendered with while dynIncluded() — recomputed at build time
     — used the new answer, so the page showed premium padlocked under "Premium content" while the
     constructed mp3 happily played it. Same rule, two moments, no re-render in between.
     `offline` also clears auth.js's subFresh, which is what makes the flip immediate.
     ⚠ THIS ALSO DRIVES THE NOT-DOWNLOADED GREYING (Part B, 2026-08-09). sentNoDl() reads
     navigator.onLine at RENDER time, so this listener is what makes cards grey on going offline
     and un-grey on reconnect. Removing it would strand them in whichever state they were built in.
     No extra work needed: sentNoDl() must stay out of dynApplyLockOrder(), which is already true —
     it only sinks sentLocked() rows, so a not-downloaded card keeps its position. */
  ['online', 'offline'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      if (!PLMODE) return;
      // Reconnecting retires every MEASURED absence — the clips are fetchable again (and r123's
      // self-heal can now repair a corrupt one), so re-test rather than inherit old verdicts.
      if (ev === 'online') dynNoDlSeen = {};
      dynApplyLockOrder();
      render();
    });
  });

  /* Idle, and never in front of anything the user is waiting for. requestIdleCallback is absent
     on WebKit, so the timeout fallback is the iPhone path — which is the one that needed this
     most. */
  /* `now` skips the idle wait — used when the head pass has just finished, which already
     proves paint is over. ⚠ ONE PENDING TIMER AT A TIME: `thaiear:auth` fires ~25 times on a
     real device and each event used to queue another callback, so a single page racked up two
     dozen identical timers that all fired within a few hundred ms of each other. They latched
     harmlessly on prewarmStarted, but they buried every trace they appeared in. */
  var bulkQueued = false;
  function schedulePrewarmBulk(now) {
    if (prewarmStarted) return;
    var go = function () { bulkQueued = false; latMark('prewarm:fire'); try { prewarmSentences(0); } catch (_) {} };
    if (now) { go(); return; }
    if (bulkQueued) return;
    bulkQueued = true;
    if (window.requestIdleCallback) { latMark('prewarm:sched', 'requestIdleCallback timeout 4000'); window.requestIdleCallback(go, { timeout: 4000 }); }
    else { latMark('prewarm:sched', 'setTimeout 2500 (no rIC)'); setTimeout(go, 2500); }
  }
  /* ⚠⚠ THE PREWARM'S REAL TRIGGER IS `thaiear:auth`, NOT IDLE — AND THAT IS WHY THE FIRST TAP
     WAS SLOW ON A GATED TOPIC (2026-08-26, and 90 of 93 units are gated).
     A gated clip needs a token before it can be minted, and auth resolves LAST in the boot
     chain: nav.js appends auth.js, which dynamic-imports Supabase from esm.sh, which then
     resolves the session. The idle callback nearly always wins that race, so the prewarm found
     no token and rescheduled itself SIX SECONDS later — measured, on a real load: first attempt
     2946ms, next attempt 9262ms. Every tap in that window paid the full cold path (a ~865ms
     mint, then a ~700ms fetch from the S3 endpoint), which is the reported 3-4 seconds.
     auth.js broadcasts the event we were polling for, so listen for it. The 6s timer stays as a
     backstop for the case where the event fired before this listener existed.
     ⚠ `thaiear:auth` legitimately fires ~5 times during startup — every path here must be
     idempotent. prewarmStarted / prewarmHeadDone are what make repeats free; do not remove
     them, and do not add work here that is not latched. */
  function schedulePrewarm() {
    var head = function () { try { prewarmSentences(0, true); } catch (_) {} };
    setTimeout(head, 0);          // after mount's own render, before anything waits for idle
    schedulePrewarmBulk();
    /* ⚠ `thaiear:auth` fires ~15 times during startup (measured), so this must not queue an
       idle callback each time — the latches make repeats harmless but not free. */
    window.addEventListener('thaiear:auth', function () {
      if (prewarmStarted) return;
      head(); schedulePrewarmBulk();
    });
  }

  /* ---- mount ---- */
  function mount() {
    if (!document.getElementById('player-styles')) {
      var style = document.createElement('style');
      style.id = 'player-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }
    if (TIER === 'premium') document.body.classList.add('premium-topic'); // gold-skin the controls
    dynApplyLockOrder();    // playlists: sink any locked sentence before the first render
    var root = $('player-root');
    if (root) root.innerHTML = PLAYER_HTML;
    /* ⚠⚠ DROP THE CLS RESERVE THE MOMENT THE REAL PLAYER EXISTS (2026-08-20).
       #player-root carries a min-height so the static SSR cards below it do not jump when this
       innerHTML lands. That reserve is a FLOOR, and a floor is only ever right in one direction:
       too small and the cards shift, too LARGE and it leaves a permanent visible gap between the
       player and the first sentence — which is exactly what an iPhone PWA showed, because the
       figures were measured in desktop-Chrome iframes at narrow widths and an iPhone is not a
       narrow desktop (owner-reported within minutes of the deploy).
       Once the player is really here its own height is authoritative and the guess is worthless,
       so the floor is removed rather than tuned. This makes the reserve unable to over-reserve on
       ANY device, which no amount of re-measuring could guarantee.
       ⚠ The rule lives in each page's own <style> as well as player-dyn-mount.css — a returning
       visitor's first load after a deploy pairs new markup with the OLD cached stylesheet, and
       without the inline copy that load would keep the gap. */
    document.body.classList.add('te-player-mounted');
    latMark('mount', sentences.length + ' sentences, tier ' + (TIER || 'free'));
    // sync the transport bar if metadata already arrived before mount
    if (mainAudio.duration) { var t = $('time-total'); if (t) t.textContent = formatTime(mainAudio.duration); }
    render();
    repairStaleHints();     // pre-2026-08-18 markup (a downloaded/stale page): fill in the English pill hint
    initSentAudio();
    schedulePrewarm();      // have the sentence clips in memory before the first tap asks for them
    initScrubber();
    initProgress();
    initXtraControls();
    initMiniPlayer();       // floating mini transport (shows when the main player scrolls out of view)
    renderOfflineBar();
    if (DYN) initDyn();     // dynamic-mode extras: status line, pause slider, sentence-skip + card buttons
    syncToPlayingTrack();   // if the engine is already playing another topic, reflect/adopt it
    maybeWebResume();       // web: if we navigated here from the now-playing link, continue from where it was
  }

  // inline onclick in the injected markup call these by name
  Object.assign(window, { switchAudio: switchAudio, togglePlay: togglePlay, skip: skip,
    toggleAll: toggleAll, cycle: cycle, toggleSentPlay: toggleSentPlay, toggleSlow: toggleSlow, toggleTranslit: toggleTranslit,

    advanceTopic: advanceTopic, toggleAutoplay: toggleAutoplay, toggleRepeat: toggleRepeat,
    downloadTopic: downloadTopic, deleteTopic: deleteTopic, confirmDelete: confirmDelete, cancelDelete: cancelDelete, refreshTopic: refreshTopic,
    dynUpdateAudio: dynUpdateAudio, gateSentence: gateSent });


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
