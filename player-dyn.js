/* player-dyn.js — DYNAMIC PLAYER (TEST BUILD, 2026-07-27; see DYNAMIC_PLAYER_PLAN.md)
   Sequences per-sentence clips client-side instead of playing the prefab _TE/_ET files:
     TE pair: Thai → repeat pause → Thai → repeat pause → English → 3s gap
     ET pair: English → recall pause → Thai → repeat pause → Thai → 3s gap
   Pauses are the generator's formulas (ported verbatim) scaled by the user's pause slider,
   rounded to the nearest pre-cut silence MP3 (sil_{ms}.mp3, 1.0–10.0s in 0.5s steps) so the
   whole session is EVENT-DRIVEN AUDIO (ended → next src) — no timers, which is what lets
   playback survive a locked screen.
   Dual output: web <audio> chain (browser / installed PWA, with blob prefetch-ahead for
   offline resilience) or the existing NativeAudio Media3 engine in the Capacitor app
   (lock-screen + background inherited; its NEXT/PREV lock-screen buttons drive sentence nav).
   Used ONLY by topic-test.html. Not precached; not part of the normal player. */
(function () {
  var T = window.ThaiEarTest;
  if (!T) return;
  var SENTS = T.sentences, BASE = T.audioBase, PREFIX = T.prefix;

  /* ── pause model (generate_topic_audio.py, ported verbatim) ── */
  function syllables(thai) {
    var c = thai.replace(/\|/g, '').replace(/\s/g, '').replace(/[ๆ็์]/g, '');
    return Math.max(1, Math.floor(c.length / 3));
  }
  function repeatPause(s) { return Math.max(3.0, syllables(s.thai) * 0.5); }
  function recallPause(s) { return Math.max(4.5, syllables(s.thai) * 0.7); }
  var GAP_BETWEEN_PAIRS = 3.0;
  function silUrl(sec) {
    var ms = Math.round((sec * factor) / 0.5) * 500;
    ms = Math.min(10000, Math.max(1000, ms));
    return BASE + 'sil_' + ms + '.mp3';
  }
  function thUrl(s) { return BASE + PREFIX + '_S' + s.num + '_TH.mp3'; }
  function enUrl(s) { return BASE + PREFIX + '_S' + s.num + '_EN.mp3'; }
  function dispThai(s) { return s.thai.replace(/\s*\|\s*/g, ' '); }

  /* ── persisted state ── */
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  var mode = lsGet('te_dyn_mode', 'TE');                       // 'TE' | 'ET'
  var factor = parseFloat(lsGet('te_dyn_pf', '1')) || 1;       // pause slider 0.5–2
  var excluded = {};
  try { (JSON.parse(lsGet('te_dyn_excl', '[]')) || []).forEach(function (n) { excluded[n] = 1; }); } catch (_) {}
  function saveExcl() { lsSet('te_dyn_excl', JSON.stringify(Object.keys(excluded).map(Number))); }
  var filter = 'all';                                          // pill: all | in | out

  /* ── playlist ── */
  var steps = [], playing = false, idx = 0;
  function included() { return SENTS.filter(function (s) { return !excluded[s.num]; }); }
  function buildSteps() {
    steps = [];
    included().forEach(function (s, k) {
      var th = thUrl(s), en = enUrl(s), rp = silUrl(repeatPause(s)), gp = silUrl(GAP_BETWEEN_PAIRS);
      var seq = mode === 'TE'
        ? [th, rp, th, rp, en, gp]
        : [enUrl(s), silUrl(recallPause(s)), th, rp, th, gp];
      seq.forEach(function (u) { steps.push({ url: u, s: s, block: k }); });
    });
  }

  /* ── output: native Media3 in the app, <audio> elsewhere ── */
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var NA = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.NativeAudio : null;
  var out, blobCache = {};
  function stepEnded() {
    if (!playing) return;
    if (idx + 1 < steps.length) playStep(idx + 1);
    else { playing = false; idx = 0; updateUI(); }
  }
  if (NA) {
    NA.addListener('ended', stepEnded);
    NA.addListener('command', function (d) {
      var a = d && d.action;
      if (a === 'thaiear.NEXT') nextSentence();
      else if (a === 'thaiear.PREV') prevSentence();
    });
    out = {
      play: function (url) {
        return NA.prepare({ url: url, title: T.name, subtitle: 'ThaiEar — dynamic test', artwork: 'https://thaiear.com/apple-touch-icon.png' })
          .then(function () { return NA.play(); });
      },
      pause: function () { NA.pause(); },
      resume: function () { NA.play(); }
    };
  } else {
    var audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('ended', function () { errRun = 0; stepEnded(); });
    // A clip that fails to load must SKIP, not stall the whole chain (first-load network
    // hiccups otherwise freeze the session and invite replay-mashing). A run of failures
    // means we're truly offline past the prefetch buffer — stop cleanly instead of
    // sprinting silently through the rest of the playlist.
    var errRun = 0;
    audio.addEventListener('error', function () {
      if (!playing) return;
      if (++errRun >= 5) { playing = false; errRun = 0; updateUI(); return; }
      stepEnded();
    });
    out = {
      play: function (url) { audio.src = blobCache[url] || url; return audio.play(); },
      pause: function () { audio.pause(); },
      resume: function () { return audio.play(); }
    };
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: T.name, artist: 'ThaiEar (test)' });
        navigator.mediaSession.setActionHandler('play', function () { togglePlay(); });
        navigator.mediaSession.setActionHandler('pause', function () { togglePlay(); });
        navigator.mediaSession.setActionHandler('nexttrack', function () { nextSentence(); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { prevSentence(); });
      } catch (_) {}
      // The session is a chain of tiny clips; a per-clip scrubber on the lock screen races
      // and resets constantly, which reads as broken. Clearing position state asks the OS
      // to show stable metadata with no progress bar. (Best-effort — iOS may ignore it.)
      audio.addEventListener('loadedmetadata', function () {
        try { navigator.mediaSession.setPositionState(); } catch (_) {}
      });
    }
  }
  // Prefetch-ahead (web only): the next few steps ride as blobs, so a brief connection
  // drop mid-session doesn't kill playback. Silence files are shared and cache once.
  function prefetchAhead(from) {
    if (NA) return;
    for (var i = from + 1; i < Math.min(from + 9, steps.length); i++) {
      (function (url) {
        if (blobCache[url]) return;
        blobCache[url] = 'pending';
        fetch(url).then(function (r) { return r.ok ? r.blob() : null; })
          .then(function (b) { blobCache[url] = b ? URL.createObjectURL(b) : undefined; })
          .catch(function () { blobCache[url] = undefined; });
      })(steps[i].url);
    }
  }

  /* ── transport ── */
  function playStep(i) {
    idx = i;
    var st = steps[i];
    if (blobCache[st.url] === 'pending') blobCache[st.url] = undefined;
    out.play(st.url).catch(function () {});
    prefetchAhead(i);
    updateUI();
  }
  function togglePlay() {
    if (!steps.length) { buildSteps(); }
    if (!steps.length) return;
    if (playing) { playing = false; out.pause(); }
    else {
      playing = true;
      if (idx === 0 || !steps[idx]) playStep(idx < steps.length ? idx : 0);
      else out.resume();
    }
    updateUI();
  }
  function blockStart(block) {
    for (var i = 0; i < steps.length; i++) if (steps[i].block === block) return i;
    return 0;
  }
  function maxBlock() { return steps.length ? steps[steps.length - 1].block : 0; }
  function nextSentence() { jumpBlock(Math.min((steps[idx] ? steps[idx].block : 0) + 1, maxBlock())); }
  function prevSentence() { jumpBlock(Math.max((steps[idx] ? steps[idx].block : 0) - 1, 0)); }
  function jumpBlock(b) {
    if (!steps.length) return;
    idx = blockStart(b);
    if (playing) playStep(idx); else updateUI();
  }
  function playFrom(num) {
    if (excluded[num]) return;
    buildSteps();
    var b = -1;
    for (var i = 0; i < steps.length; i++) if (steps[i].s.num === num) { b = steps[i].block; break; }
    if (b < 0) return;
    playing = true;
    playStep(blockStart(b));
  }
  // Rebuild (mode / slider / exclusion changed) keeping our place by sentence.
  function rebuild() {
    var cur = steps[idx] ? steps[idx].s.num : null;
    buildSteps();
    idx = 0;
    if (cur != null) {
      for (var i = 0; i < steps.length; i++) if (steps[i].s.num === cur) { idx = blockStart(steps[i].block); break; }
    }
    if (playing) { steps.length ? playStep(idx) : (playing = false); }
    updateUI();
  }

  /* ── UI ── */
  var root = document.getElementById('dyn-root');
  if (!root) return;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  root.innerHTML =
    '<div class="dyn-player">' +
      '<div class="dyn-mode" role="group" aria-label="Direction">' +
        '<button type="button" data-mode="TE">Thai first</button>' +
        '<button type="button" data-mode="ET">English first</button>' +
      '</div>' +
      '<div class="dyn-main">' +
        '<button class="dyn-skip" id="dyn-prev" type="button" aria-label="Previous sentence"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14l-10-7z"/></svg></button>' +
        '<button class="dyn-play" id="dyn-play" type="button" aria-label="Play"><svg id="dyn-play-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
        '<button class="dyn-skip" id="dyn-next" type="button" aria-label="Next sentence"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l10-7z"/></svg></button>' +
      '</div>' +
      '<button class="dyn-now" id="dyn-now" type="button">Ready</button>' +
      '<div class="dyn-slider"><span>Pauses</span>' +
        '<input id="dyn-pf" type="range" min="0.5" max="2" step="0.25" value="' + factor + '">' +
        '<span id="dyn-pf-val">' + factor + '×</span></div>' +
    '</div>' +
    '<div class="dyn-pills" id="dyn-pills"></div>' +
    '<div class="dyn-list" id="dyn-list"></div>';

  var modeBtns = root.querySelectorAll('.dyn-mode button');
  modeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (mode === b.getAttribute('data-mode')) return;
      mode = b.getAttribute('data-mode'); lsSet('te_dyn_mode', mode); rebuild();
    });
  });
  document.getElementById('dyn-play').addEventListener('click', togglePlay);
  document.getElementById('dyn-prev').addEventListener('click', prevSentence);
  document.getElementById('dyn-next').addEventListener('click', nextSentence);
  document.getElementById('dyn-now').addEventListener('click', function () {
    var st = steps[idx];
    if (!st) return;
    var card = document.querySelector('.dyn-card[data-num="' + st.s.num + '"]');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  var pf = document.getElementById('dyn-pf');
  pf.addEventListener('input', function () {
    document.getElementById('dyn-pf-val').textContent = pf.value + '×';
  });
  pf.addEventListener('change', function () {
    factor = parseFloat(pf.value) || 1; lsSet('te_dyn_pf', String(factor)); rebuild();
  });

  function renderPills() {
    var nIn = included().length, nOut = SENTS.length - nIn;
    var el = document.getElementById('dyn-pills');
    el.innerHTML = [
      ['all', 'All · ' + SENTS.length], ['in', 'Included · ' + nIn], ['out', 'Excluded · ' + nOut]
    ].map(function (p) {
      return '<button type="button" data-f="' + p[0] + '" class="' + (filter === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
    }).join('');
    el.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { filter = b.getAttribute('data-f'); renderPills(); renderList(); });
    });
  }
  function renderList() {
    var el = document.getElementById('dyn-list');
    el.innerHTML = SENTS.filter(function (s) {
      if (filter === 'in') return !excluded[s.num];
      if (filter === 'out') return !!excluded[s.num];
      return true;
    }).map(function (s) {
      var off = !!excluded[s.num];
      return '<div class="dyn-card' + (off ? ' off' : '') + '" data-num="' + s.num + '">' +
        '<div class="dyn-txt">' +
          '<div class="dyn-th">' + esc(dispThai(s)) + '</div>' +
          (s.translit ? '<div class="dyn-tr">' + esc(s.translit) + '</div>' : '') +
          '<div class="dyn-en">' + esc(s.english) + '</div>' +
        '</div>' +
        '<button class="dyn-x" type="button" aria-label="' + (off ? 'Include sentence' : 'Exclude sentence') + '">' +
          (off ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
               : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>') +
        '</button></div>';
    }).join('') || '<div class="dyn-empty">Nothing here.</div>';
    el.querySelectorAll('.dyn-card').forEach(function (card) {
      var num = parseInt(card.getAttribute('data-num'), 10);
      card.querySelector('.dyn-x').addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (excluded[num]) delete excluded[num]; else excluded[num] = 1;
        saveExcl(); renderPills(); renderList(); rebuild();
      });
      card.querySelector('.dyn-txt').addEventListener('click', function () { playFrom(num); });
    });
    markPlayingCard();
  }
  function markPlayingCard() {
    document.querySelectorAll('.dyn-card.playing').forEach(function (c) { c.classList.remove('playing'); });
    var st = steps[idx];
    if (st && playing) {
      var card = document.querySelector('.dyn-card[data-num="' + st.s.num + '"]');
      if (card) card.classList.add('playing');
    }
  }
  function updateUI() {
    modeBtns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
    document.getElementById('dyn-play-ico').innerHTML = playing
      ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    var now = document.getElementById('dyn-now');
    var st = steps[idx];
    if (st && (playing || idx > 0)) {
      now.textContent = '▸ Sentence ' + (st.block + 1) + ' of ' + (maxBlock() + 1) + ' — ' + dispThai(st.s);
    } else {
      now.textContent = included().length
        ? 'Ready — ' + included().length + ' sentence' + (included().length === 1 ? '' : 's') + ' in the ' + (mode === 'TE' ? 'Thai-first' : 'English-first') + ' session'
        : 'Every sentence is excluded — include some to play';
    }
    markPlayingCard();
  }

  buildSteps();
  renderPills();
  renderList();
  updateUI();
  prefetchAhead(-1);   // web only (no-op native): warm the opening steps so first play starts clean
})();
