/* player-dyn.js — DYNAMIC PLAYER (TEST BUILD v2 "stitched session", 2026-07-27;
   see DYNAMIC_PLAYER_PLAN.md)

   v2 redesign (owner-approved): instead of chaining many small clips (which stalled on bad
   networks and made the iOS lock screen race through tiny scrubbers), the engine now
   CONSTRUCTS THE SESSION FILE ON-DEVICE:
     press play → fetch every needed clip (~2 MB for a whole topic, LESS than the prefab
     TE/ET file) → decode → stitch with exactly-computed silence gaps → one WAV blob →
     the phone plays ONE ordinary continuous track.
   Results: playback is 100% local once built (driving-through-dead-zones robust), the
   lock screen shows a normal progress bar + real scrubbing, and sentence nav is a SEEK
   into a known timeline (sample-accurate now-playing highlight).
     TE pair: Thai → repeat pause → Thai → repeat pause → English → 3s gap
     ET pair: English → recall pause → Thai → repeat pause → Thai → 3s gap
   Gaps use the generator's formulas × the pause slider — exact, no rounding (the pre-cut
   sil_*.mp3 files of v1 are no longer needed).
   Output: web <audio> element playing the blob URL; in the Capacitor app the WAV is
   written to the cache dir and handed to the native Media3 engine as file:// (same
   lock-screen/background behaviour as any topic — progress bar and scrubbing kept).
   Used ONLY by topic-test.html. */
(function () {
  var T = window.ThaiEarTest;
  if (!T) return;
  var SENTS = T.sentences, BASE = T.audioBase, PREFIX = T.prefix;
  var SR = 24000;   // clip native rate (Chirp3 + Standard-D); decode + stitch at this rate

  /* ── pause model (generate_topic_audio.py, ported verbatim; × slider, exact) ── */
  function syllables(thai) {
    var c = thai.replace(/\|/g, '').replace(/\s/g, '').replace(/[ๆ็์]/g, '');
    return Math.max(1, Math.floor(c.length / 3));
  }
  function repeatPause(s) { return Math.max(3.0, syllables(s.thai) * 0.5) * factor; }
  function recallPause(s) { return Math.max(4.5, syllables(s.thai) * 0.7) * factor; }
  function gapPause() { return 3.0 * factor; }
  function thUrl(s) { return BASE + PREFIX + '_S' + s.num + '_TH.mp3'; }
  function enUrl(s) { return BASE + PREFIX + '_S' + s.num + '_EN.mp3'; }
  function dispThai(s) { return s.thai.replace(/\s*\|\s*/g, ' '); }

  /* ── persisted state ── */
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  var mode = lsGet('te_dyn_mode', 'TE');
  var factor = parseFloat(lsGet('te_dyn_pf', '1')) || 1;
  var excluded = {};
  try { (JSON.parse(lsGet('te_dyn_excl', '[]')) || []).forEach(function (n) { excluded[n] = 1; }); } catch (_) {}
  function saveExcl() { lsSet('te_dyn_excl', JSON.stringify(Object.keys(excluded).map(Number))); }
  var filter = 'all';
  function included() { return SENTS.filter(function (s) { return !excluded[s.num]; }); }

  /* ── session builder: fetch → decode → stitch → WAV ─────── */
  var session = null;      // { url, map:[{num,start,end}], key, fileUri? }
  var building = false;
  var pcmCache = {};       // url → AudioBuffer (decoded clips survive rebuilds/mode flips)
  function sessionKey() {
    return mode + '|' + factor + '|' + included().map(function (s) { return s.num; }).join(',');
  }
  function fetchDecode(url, octx) {
    if (pcmCache[url]) return Promise.resolve(pcmCache[url]);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.arrayBuffer();
    }).then(function (ab) {
      return new Promise(function (res, rej) { octx.decodeAudioData(ab, res, rej); });
    }).then(function (buf) { pcmCache[url] = buf; return buf; });
  }
  function buildSession(onProg) {
    var inc = included();
    var urls = [];
    inc.forEach(function (s) { urls.push(thUrl(s), enUrl(s)); });
    urls = urls.filter(function (u, i) { return urls.indexOf(u) === i; });
    var octx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, SR);
    var got = 0;
    return Promise.all(urls.map(function (u) {
      return fetchDecode(u, octx).then(function (b) { got++; if (onProg) onProg(got, urls.length); return b; });
    })).then(function () {
      // assemble mono Float32 timeline + per-sentence map
      var chunks = [], map = [], t = 0;
      function addBuf(buf) { chunks.push(buf.getChannelData(0)); t += buf.getChannelData(0).length / SR; }
      function addSil(sec) { chunks.push(new Float32Array(Math.round(sec * SR))); t += Math.round(sec * SR) / SR; }
      inc.forEach(function (s) {
        var th = pcmCache[thUrl(s)], en = pcmCache[enUrl(s)];
        var start = t;
        if (mode === 'TE') { addBuf(th); addSil(repeatPause(s)); addBuf(th); addSil(repeatPause(s)); addBuf(en); }
        else { addBuf(en); addSil(recallPause(s)); addBuf(th); addSil(repeatPause(s)); addBuf(th); }
        addSil(gapPause());
        map.push({ num: s.num, start: start, end: t });
      });
      var total = 0;
      chunks.forEach(function (c) { total += c.length; });
      var wav = encodeWav(chunks, total, SR);
      if (session && session.url) { try { URL.revokeObjectURL(session.url); } catch (_) {} }
      session = { url: URL.createObjectURL(wav), blob: wav, map: map, key: sessionKey(), duration: t };
      return session;
    });
  }
  function encodeWav(chunks, totalSamples, sr) {
    var buf = new ArrayBuffer(44 + totalSamples * 2);
    var v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + totalSamples * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, totalSamples * 2, true);
    var o = 44;
    chunks.forEach(function (c) {
      for (var i = 0; i < c.length; i++) {
        var x = Math.max(-1, Math.min(1, c[i]));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
        o += 2;
      }
    });
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ── output: native Media3 (app) or <audio> (web/PWA) ───── */
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var NA = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.NativeAudio : null;
  var FS = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.Filesystem : null;
  var playing = false, curTime = 0;
  var audio = null;
  if (!NA) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('timeupdate', function () { curTime = audio.currentTime; tickUI(); });
    audio.addEventListener('ended', function () { playing = false; curTime = 0; updateUI(); });
    audio.addEventListener('play', function () { playing = true; updateUI(); });
    audio.addEventListener('pause', function () { if (!audio.ended) { playing = false; updateUI(); } });
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: T.name, artist: 'ThaiEar (test)' });
        navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
        navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
        navigator.mediaSession.setActionHandler('nexttrack', function () { nextSentence(); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { prevSentence(); });
      } catch (_) {}
    }
  } else {
    NA.addListener('time', function (d) { if (d) { curTime = d.position || 0; tickUI(); } });
    NA.addListener('ended', function () { playing = false; curTime = 0; updateUI(); });
    NA.addListener('playing', function (d) { playing = !!(d && d.playing); updateUI(); });
    NA.addListener('command', function (d) {
      var a = d && d.action;
      // v2 APK dynamic layout: custom slots = sentence, standard ⏮⏭ = topic (inert on the
      // single-topic test page). A v1 APK sends none of the sentence commands — page buttons cover it.
      if (a === 'thaiear.SENT_NEXT') nextSentence();
      else if (a === 'thaiear.SENT_PREV') prevSentence();
    });
  }
  // iOS unlock: play() must originate from the tap. During the async build we keep the
  // element "warm" with a moment of silence so the post-build play() is allowed.
  var SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=';
  function unlockWebAudio() {
    if (!audio) return;
    try { audio.src = SILENT_WAV; audio.play().catch(function () {}); } catch (_) {}
  }
  function startPlayback() {
    if (NA) {
      // write the WAV into the app cache and hand the native engine a file:// URL —
      // one continuous track, so the notification keeps its progress bar + scrubbing.
      var fr = new FileReader();
      return new Promise(function (resolve, reject) {
        fr.onerror = reject;
        fr.onload = function () {
          var b64 = String(fr.result).split(',')[1];
          FS.writeFile({ path: 'dyn-session.wav', data: b64, directory: 'CACHE' })
            .then(function () { return FS.getUri({ path: 'dyn-session.wav', directory: 'CACHE' }); })
            .then(function (u) {
              session.fileUri = u.uri;
              return NA.prepare({ url: u.uri, title: T.name, subtitle: 'ThaiEar — dynamic test', artwork: 'https://thaiear.com/apple-touch-icon.png', mode: 'dyn' });
            })
            .then(function () { playing = true; return NA.play(); })
            .then(resolve, reject);
        };
        fr.readAsDataURL(session.blob);
      });
    }
    audio.src = session.url;
    return audio.play();
  }
  function seekTo(sec) {
    curTime = sec;
    if (NA) NA.seekTo({ seconds: sec });
    else if (audio) audio.currentTime = sec;
    tickUI();
  }

  /* ── transport ── */
  var buildFailed = false;
  function ensureSession() {
    if (session && session.key === sessionKey()) return Promise.resolve(session);
    building = true; buildFailed = false;
    updateUI();
    return buildSession(function (done, total) { buildProg(done, total); })
      .then(function (s) { building = false; updateUI(); return s; })
      .catch(function (e) { building = false; buildFailed = true; session = null; updateUI(); throw e; });
  }
  function togglePlay() {
    if (building) return;
    if (playing) {
      playing = false;
      if (NA) NA.pause(); else audio.pause();
      updateUI();
      return;
    }
    if (!included().length) return;
    if (session && session.key === sessionKey()) {
      playing = true;
      (NA ? NA.play() : audio.play());
      updateUI();
      return;
    }
    unlockWebAudio();
    ensureSession().then(function () { return startPlayback(); }).catch(function () {});
  }
  function curBlock() {
    if (!session) return -1;
    for (var i = 0; i < session.map.length; i++) {
      if (curTime < session.map[i].end) return i;
    }
    return session.map.length - 1;
  }
  function nextSentence() {
    if (!session) return;
    var b = Math.min(curBlock() + 1, session.map.length - 1);
    seekTo(session.map[b].start);
  }
  function prevSentence() {
    if (!session) return;
    var b = curBlock();
    // within the first second of a block, prev = previous block; deeper in, prev = block start
    if (b > 0 && curTime - session.map[b].start < 1.2) b--;
    seekTo(session.map[b].start);
  }
  function playFrom(num) {
    if (excluded[num]) return;
    unlockWebAudio();
    ensureSession().then(function (s) {
      var target = 0;
      s.map.forEach(function (m) { if (m.num === num) target = m.start; });
      if (playing || (NA ? true : audio.src === s.url)) {
        seekTo(target);
        if (!playing) { playing = true; (NA ? NA.play() : audio.play()); updateUI(); }
      } else {
        return startPlayback().then(function () { seekTo(target); });
      }
    }).catch(function () {});
  }
  function invalidate() {   // mode / slider / exclusions changed → rebuild on next play
    if (playing) { if (NA) NA.pause(); else audio.pause(); }
    playing = false; curTime = 0;
    session = null;
    updateUI();
  }

  /* ── UI ── */
  var root = document.getElementById('dyn-root');
  if (!root) return;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function fmt(t) {
    t = Math.max(0, Math.round(t));
    return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
  }
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
      '<div class="dyn-build" id="dyn-build" hidden>Constructing dynamic mp3 file<span class="dyn-dots" aria-hidden="true"></span><span id="dyn-build-n"></span></div>' +
      '<div class="dyn-seek" id="dyn-seek"><div class="dyn-seek-bar" id="dyn-seek-bar"><i id="dyn-seek-fill"></i></div><div class="dyn-seek-t"><span id="dyn-t-cur">0:00</span><span id="dyn-t-tot">–:––</span></div></div>' +
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
      mode = b.getAttribute('data-mode'); lsSet('te_dyn_mode', mode); invalidate();
    });
  });
  document.getElementById('dyn-play').addEventListener('click', togglePlay);
  document.getElementById('dyn-prev').addEventListener('click', prevSentence);
  document.getElementById('dyn-next').addEventListener('click', nextSentence);
  document.getElementById('dyn-now').addEventListener('click', function () {
    var b = curBlock();
    if (b < 0 || !session) return;
    var card = document.querySelector('.dyn-card[data-num="' + session.map[b].num + '"]');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  var pf = document.getElementById('dyn-pf');
  pf.addEventListener('input', function () { document.getElementById('dyn-pf-val').textContent = pf.value + '×'; });
  pf.addEventListener('change', function () { factor = parseFloat(pf.value) || 1; lsSet('te_dyn_pf', String(factor)); invalidate(); });
  document.getElementById('dyn-seek-bar').addEventListener('click', function (ev) {
    if (!session) return;
    var r = ev.currentTarget.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * session.duration);
  });

  function buildProg(done, total) {
    var n = document.getElementById('dyn-build-n');
    if (n) n.textContent = ' ' + done + '/' + total;
  }
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
        saveExcl(); renderPills(); renderList(); invalidate();
      });
      card.querySelector('.dyn-txt').addEventListener('click', function () { playFrom(num); });
    });
    tickUI();
  }
  var lastMarkedNum = null;
  function tickUI() {
    // seek bar + times
    if (session) {
      document.getElementById('dyn-t-cur').textContent = fmt(curTime);
      document.getElementById('dyn-t-tot').textContent = fmt(session.duration);
      document.getElementById('dyn-seek-fill').style.width = Math.min(100, curTime / session.duration * 100) + '%';
    }
    // playing-card highlight + now line
    var b = curBlock();
    var num = (b >= 0 && session) ? session.map[b].num : null;
    if (num !== lastMarkedNum) {
      lastMarkedNum = num;
      document.querySelectorAll('.dyn-card.playing').forEach(function (c) { c.classList.remove('playing'); });
      if (num != null && (playing || curTime > 0)) {
        var card = document.querySelector('.dyn-card[data-num="' + num + '"]');
        if (card) card.classList.add('playing');
      }
    }
    var now = document.getElementById('dyn-now');
    if (session && b >= 0 && (playing || curTime > 0)) {
      var s = SENTS.filter(function (x) { return x.num === session.map[b].num; })[0];
      now.textContent = '▸ Sentence ' + (b + 1) + ' of ' + session.map.length + (s ? ' — ' + dispThai(s) : '');
    } else if (!building) {
      now.textContent = buildFailed
        ? 'Couldn’t load the audio — check your connection and press play to retry'
        : (included().length
          ? 'Ready — ' + included().length + ' sentence' + (included().length === 1 ? '' : 's') + ' in the ' + (mode === 'TE' ? 'Thai-first' : 'English-first') + ' session'
          : 'Every sentence is excluded — include some to play');
    }
  }
  function updateUI() {
    modeBtns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
    document.getElementById('dyn-play-ico').innerHTML = playing
      ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    var bld = document.getElementById('dyn-build');
    bld.hidden = !building;
    if (building) document.getElementById('dyn-now').textContent = '';
    document.getElementById('dyn-seek').style.visibility = session ? 'visible' : 'hidden';
    tickUI();
  }

  renderPills();
  renderList();
  updateUI();
})();
