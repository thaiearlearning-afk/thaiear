/* player-dyn.js — DYNAMIC PLAYER ENGINE v3 (factory), TEST SPACE ONLY.
   See DYNAMIC_PLAYER_PLAN.md. v2 proved the stitched-session approach (fetch all clips
   ~2 MB → decode 24 kHz → stitch exact gaps → ONE WAV → play as a single track: offline-
   robust, scrubbable, lock-screen sane). v3 generalises it into window.ThaiEarDyn so the
   same engine drives topic test pages AND user playlists:

     ThaiEarDyn.create(rootEl, {
       name, topicKey, prefix, tier,            // topic-level defaults ('free'|'member'|'premium')
       sentences: [{num, thai, translit?, english, prefix?, tier?}],   // per-item override for playlists
       nav: {prevLabel, prevHref, nextLabel, nextHref} | {onPrev, onNext},  // topic/playlist skip
       features: {exclude?, playlist?, removeItem?},   // per-card controls
       storageNs,                               // exclusions namespace (per topic)
       onRemoveItem(item)                       // playlists page: remove-from-playlist handler
     }) → instance {mount, play, pause, stop, isPlaying}

   Gated audio (member/premium): each clip fetch goes through /api/audio with the Supabase
   token (same gate as the classic player) — a playlist can never leak audio the server
   wouldn't serve. Only ONE instance plays at a time (module-level `active`); the native
   Media3 path is shared and routed to the active instance. Native lock-screen buttons:
   standard ⏮/⏭ → nav (topic/playlist), custom sentence buttons (v2 APK) → sentence seek. */
(function () {
  var AUDIO_BASE = 'https://audio.thaiear.com/';
  var AUDIO_API = '/api/audio';
  var SR = 24000;
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var NA = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.NativeAudio : null;
  var FS = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.Filesystem : null;
  var active = null;      // the instance that owns playback
  var pcmCache = {};      // fileName → AudioBuffer, shared across instances

  if (NA) {
    NA.addListener('time', function (d) { if (active && d) active._onTime(d.position || 0); });
    NA.addListener('ended', function () { if (active) active._onEnded(); });
    NA.addListener('playing', function (d) { if (active) active._onPlaying(!!(d && d.playing)); });
    NA.addListener('command', function (d) {
      if (!active) return;
      var a = d && d.action;
      if (a === 'thaiear.SENT_NEXT') active.nextSentence();
      else if (a === 'thaiear.SENT_PREV') active.prevSentence();
      else if (a === 'thaiear.NEXT') active._navGo(1);
      else if (a === 'thaiear.PREV') active._navGo(-1);
    });
  }

  /* pause model — generate_topic_audio.py, ported verbatim (× slider, exact) */
  function syllables(thai) {
    var c = String(thai).replace(/\|/g, '').replace(/\s/g, '').replace(/[ๆ็์]/g, '');
    return Math.max(1, Math.floor(c.length / 3));
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function fmt(t) { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2); }
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  function clipUrl(item, kind, topTier) {
    var file = item.prefix + '_S' + item.num + '_' + kind + '.mp3';
    var tier = item.tier || topTier || 'free';
    if (tier === 'free') return Promise.resolve(AUDIO_BASE + file);
    var token = (window.ThaiEarAuth && window.ThaiEarAuth.getAccessToken) ? window.ThaiEarAuth.getAccessToken() : null;
    if (!token) return Promise.reject({ code: 'noauth' });
    return fetch(AUDIO_API + '?file=' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { if (!r.ok) throw { code: r.status }; return r.json(); })
      .then(function (j) { if (!j || !j.url) throw { code: 'nourl' }; return j.url; });
  }
  function fetchDecode(item, kind, topTier, octx) {
    var key = item.prefix + '_S' + item.num + '_' + kind;
    if (pcmCache[key]) return Promise.resolve(pcmCache[key]);
    return clipUrl(item, kind, topTier)
      .then(function (u) { return fetch(u); })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then(function (ab) { return new Promise(function (res, rej) { octx.decodeAudioData(ab, res, rej); }); })
      .then(function (buf) { pcmCache[key] = buf; return buf; });
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
  var SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=';

  /* ── playlist popup (shared, one at a time) ─────────────── */
  function openPlaylistPopup(anchorTier, item) {
    var old = document.getElementById('dyn-pl-pop');
    if (old) old.remove();
    var PL = window.ThaiEarAuth && window.ThaiEarAuth.playlists;
    var user = window.ThaiEarAuth && window.ThaiEarAuth.getUser && window.ThaiEarAuth.getUser();
    var wrap = document.createElement('div');
    wrap.id = 'dyn-pl-pop';
    wrap.innerHTML = '<div class="dyn-pl-card"><div class="dyn-pl-head">Add to playlist</div><div class="dyn-pl-body">Loading…</div><div class="dyn-pl-foot"><button type="button" class="dyn-pl-done">Done</button></div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('.dyn-pl-done').addEventListener('click', function () { wrap.remove(); });
    var body = wrap.querySelector('.dyn-pl-body');
    if (!user) { body.innerHTML = '<div class="dyn-pl-empty">Sign in to use playlists.</div>'; return; }
    if (!PL) { body.innerHTML = '<div class="dyn-pl-empty">Playlists unavailable.</div>'; return; }
    PL.load().then(function (lists) {
      if (!lists.length) {
        body.innerHTML = '<div class="dyn-pl-empty">No playlists — create a playlist in <strong>My Playlists</strong> from the Menu.</div>';
        return;
      }
      body.innerHTML = lists.map(function (p) {
        var inIt = p.items.some(function (i) { return i.topic_key === item.topic_key && i.num === item.num; });
        return '<button type="button" class="dyn-pl-row' + (inIt ? ' on' : '') + (anchorTier === 'premium' ? ' gold' : '') + '" data-id="' + p.id + '">' +
          '<span class="dyn-pl-tick" aria-hidden="true"></span><span class="dyn-pl-name">' + esc(p.name) + '</span>' +
          '<span class="dyn-pl-count">' + p.items.length + '</span></button>';
      }).join('');
      body.querySelectorAll('.dyn-pl-row').forEach(function (row) {
        row.addEventListener('click', function () {
          var id = row.getAttribute('data-id');
          var turningOn = !row.classList.contains('on');
          row.classList.add('busy');
          (turningOn ? PL.addItem(id, item) : PL.removeItem(id, item.topic_key, item.num))
            .then(function () { row.classList.toggle('on', turningOn); })
            .catch(function () {})
            .then(function () { row.classList.remove('busy'); });
        });
      });
    });
  }

  /* ── instance factory ───────────────────────────────────── */
  function create(root, opts) {
    var SENTS = opts.sentences || [];
    var TIER = opts.tier || 'free';
    var TOPIC_KEY = opts.topicKey || '';
    var PREFIX = opts.prefix || '';
    SENTS.forEach(function (s) { s.prefix = s.prefix || PREFIX; s.tier = s.tier || TIER; s.topic_key = s.topic_key || TOPIC_KEY; });
    var FEAT = opts.features || {};
    var NS = opts.storageNs || TOPIC_KEY || 'dyn';
    var mode = lsGet('te_dyn_mode', 'TE');
    var factor = parseFloat(lsGet('te_dyn_pf', '1')) || 1;
    var excluded = {};
    if (FEAT.exclude) {
      try { (JSON.parse(lsGet('te_dyn_excl_' + NS, '[]')) || []).forEach(function (n) { excluded[n] = 1; }); } catch (_) {}
    }
    function saveExcl() { lsSet('te_dyn_excl_' + NS, JSON.stringify(Object.keys(excluded).map(Number))); }
    var filter = 'all';
    var session = null, building = false, buildFailed = null;
    var playing = false, curTime = 0;
    var inst = {};

    function included() { return SENTS.filter(function (s) { return !excluded[s.num]; }); }
    function repeatPause(s) { return Math.max(3.0, syllables(s.thai) * 0.5) * factor; }
    function recallPause(s) { return Math.max(4.5, syllables(s.thai) * 0.7) * factor; }
    function sessionKey() { return mode + '|' + factor + '|' + included().map(function (s) { return s.num; }).join(','); }

    function buildSession(onProg) {
      var inc = included();
      var octx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, SR);
      var jobs = [], got = 0, total = inc.length * 2;
      inc.forEach(function (s) {
        ['TH', 'EN'].forEach(function (k) {
          jobs.push(fetchDecode(s, k, TIER, octx).then(function (b) { got++; if (onProg) onProg(got, total); return b; }));
        });
      });
      return Promise.all(jobs).then(function () {
        var chunks = [], map = [], t = 0;
        function addBuf(b) { chunks.push(b.getChannelData(0)); t += b.getChannelData(0).length / SR; }
        function addSil(sec) { var n = Math.round(sec * SR); chunks.push(new Float32Array(n)); t += n / SR; }
        inc.forEach(function (s) {
          var th = pcmCache[s.prefix + '_S' + s.num + '_TH'], en = pcmCache[s.prefix + '_S' + s.num + '_EN'];
          var start = t;
          if (mode === 'TE') { addBuf(th); addSil(repeatPause(s)); addBuf(th); addSil(repeatPause(s)); addBuf(en); }
          else { addBuf(en); addSil(recallPause(s)); addBuf(th); addSil(repeatPause(s)); addBuf(th); }
          addSil(3.0 * factor);
          map.push({ num: s.num, topic_key: s.topic_key, start: start, end: t });
        });
        var total2 = 0;
        chunks.forEach(function (c) { total2 += c.length; });
        var wav = encodeWav(chunks, total2, SR);
        if (session && session.url) { try { URL.revokeObjectURL(session.url); } catch (_) {} }
        session = { url: URL.createObjectURL(wav), blob: wav, map: map, key: sessionKey(), duration: t };
        return session;
      });
    }

    /* output */
    var audio = null;
    if (!NA) {
      audio = new Audio();
      audio.preload = 'auto';
      audio.addEventListener('timeupdate', function () { if (active === inst) { curTime = audio.currentTime; tickUI(); } });
      audio.addEventListener('ended', function () { playing = false; curTime = 0; updateUI(); });
      audio.addEventListener('play', function () { playing = true; updateUI(); });
      audio.addEventListener('pause', function () { if (!audio.ended) { playing = false; updateUI(); } });
    }
    inst._onTime = function (t) { curTime = t; tickUI(); };
    inst._onEnded = function () { playing = false; curTime = 0; updateUI(); };
    inst._onPlaying = function (p) { playing = p; updateUI(); };
    inst._navGo = function (dir) {
      var nav = opts.nav || {};
      if (dir > 0 && nav.onNext) nav.onNext();
      else if (dir < 0 && nav.onPrev) nav.onPrev();
      else if (dir > 0 && nav.nextHref) location.href = nav.nextHref;
      else if (dir < 0 && nav.prevHref) location.href = nav.prevHref;
    };
    function claim() {
      if (active && active !== inst && active.pause) active.pause();
      active = inst;
      if (!NA && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({ title: opts.name || 'ThaiEar', artist: 'ThaiEar' });
          navigator.mediaSession.setActionHandler('play', function () { if (audio) audio.play(); });
          navigator.mediaSession.setActionHandler('pause', function () { if (audio) audio.pause(); });
          navigator.mediaSession.setActionHandler('nexttrack', function () { inst.nextSentence(); });
          navigator.mediaSession.setActionHandler('previoustrack', function () { inst.prevSentence(); });
        } catch (_) {}
      }
    }
    function startPlayback() {
      claim();
      if (NA) {
        var fr = new FileReader();
        return new Promise(function (resolve, reject) {
          fr.onerror = reject;
          fr.onload = function () {
            var b64 = String(fr.result).split(',')[1];
            FS.writeFile({ path: 'dyn-session.wav', data: b64, directory: 'CACHE' })
              .then(function () { return FS.getUri({ path: 'dyn-session.wav', directory: 'CACHE' }); })
              .then(function (u) {
                return NA.prepare({
                  url: u.uri, title: opts.name || 'ThaiEar', subtitle: 'ThaiEar',
                  artwork: 'https://thaiear.com/apple-touch-icon.png', mode: 'dyn',
                  // sentence start-times → native lock-screen sentence skip (JS is suspended when locked)
                  marks: session.map.map(function (m) { return m.start; })
                });
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
      if (NA) { if (active === inst) NA.seekTo({ seconds: sec }); }
      else if (audio) audio.currentTime = sec;
      tickUI();
    }
    function unlockWebAudio() { if (audio) { try { audio.src = SILENT_WAV; audio.play().catch(function () {}); } catch (_) {} } }
    function ensureSession() {
      if (session && session.key === sessionKey()) return Promise.resolve(session);
      building = true; buildFailed = null; updateUI();
      return buildSession(function (d, t) { var n = el('#dyn-build-n'); if (n) n.textContent = ' ' + d + '/' + t; })
        .then(function (s) { building = false; updateUI(); return s; })
        .catch(function (e) {
          building = false; session = null;
          buildFailed = (e && e.code === 'noauth') ? 'auth' : 'net';
          updateUI(); throw e;
        });
    }
    inst.isPlaying = function () { return playing; };
    inst.pause = function () {
      if (!playing) return;
      playing = false;
      if (NA) { if (active === inst) NA.pause(); } else audio.pause();
      updateUI();
    };
    function togglePlay() {
      if (building) return;
      if (playing) { inst.pause(); return; }
      if (!included().length) return;
      if (session && session.key === sessionKey() && (NA ? active === inst : audio.src === session.url)) {
        claim(); playing = true; (NA ? NA.play() : audio.play()); updateUI(); return;
      }
      unlockWebAudio();
      ensureSession().then(startPlayback).catch(function () {});
    }
    function curBlock() {
      if (!session) return -1;
      for (var i = 0; i < session.map.length; i++) if (curTime < session.map[i].end) return i;
      return session.map.length - 1;
    }
    inst.nextSentence = function () { if (session) seekTo(session.map[Math.min(curBlock() + 1, session.map.length - 1)].start); };
    inst.prevSentence = function () {
      if (!session) return;
      var b = curBlock();
      if (b > 0 && curTime - session.map[b].start < 1.2) b--;
      seekTo(session.map[b].start);
    };
    function playFrom(num) {
      if (excluded[num]) return;
      unlockWebAudio();
      ensureSession().then(function (s) {
        var target = 0;
        s.map.forEach(function (m) { if (m.num === num) target = m.start; });
        if (NA ? active === inst && playing : audio.src === s.url) {
          seekTo(target);
          if (!playing) { claim(); playing = true; (NA ? NA.play() : audio.play()); updateUI(); }
        } else {
          return startPlayback().then(function () { seekTo(target); });
        }
      }).catch(function () {});
    }
    function invalidate() {
      if (playing) inst.pause();
      curTime = 0; session = null;
      updateUI();
    }

    /* UI */
    function el(sel) { return root.querySelector(sel); }
    function render() {
      var nav = opts.nav || {};
      root.innerHTML =
        '<div class="dyn-player' + (TIER === 'premium' ? ' tier-premium' : '') + '">' +
          '<div class="dyn-mode" role="group"><button type="button" data-mode="TE">Thai first</button><button type="button" data-mode="ET">English first</button></div>' +
          '<div class="dyn-main">' +
            ((nav.prevHref || nav.onPrev) ? '<button class="dyn-skip dyn-topic-btn" id="dyn-tprev" type="button" aria-label="Previous topic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h2v14H4z"/><path d="M13 5v14l-7-7zM21 5v14l-7-7z"/></svg></button>' : '') +
            '<button class="dyn-skip" id="dyn-prev" type="button" aria-label="Previous sentence"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14l-10-7z"/></svg></button>' +
            '<button class="dyn-play" id="dyn-play" type="button" aria-label="Play"><svg id="dyn-play-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
            '<button class="dyn-skip" id="dyn-next" type="button" aria-label="Next sentence"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l10-7z"/></svg></button>' +
            ((nav.nextHref || nav.onNext) ? '<button class="dyn-skip dyn-topic-btn" id="dyn-tnext" type="button" aria-label="Next topic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 5h2v14h-2z"/><path d="M3 5v14l7-7zM11 5v14l7-7z"/></svg></button>' : '') +
          '</div>' +
          '<div class="dyn-build" id="dyn-build" hidden>Constructing dynamic mp3 file<span class="dyn-dots" aria-hidden="true"></span><span id="dyn-build-n"></span></div>' +
          '<div class="dyn-seek" id="dyn-seek"><div class="dyn-seek-bar" id="dyn-seek-bar"><i id="dyn-seek-fill"></i></div><div class="dyn-seek-t"><span id="dyn-t-cur">0:00</span><span id="dyn-t-tot">–:––</span></div></div>' +
          '<button class="dyn-now" id="dyn-now" type="button">Ready</button>' +
          '<div class="dyn-slider"><span>Pauses</span><input id="dyn-pf" type="range" min="0.5" max="2" step="0.25" value="' + factor + '"><span id="dyn-pf-val">' + factor + '×</span></div>' +
        '</div>' +
        (FEAT.exclude ? '<div class="dyn-pills" id="dyn-pills"></div>' : '') +
        '<div class="dyn-list" id="dyn-list"></div>' +
        ((nav.prevHref || nav.nextHref) ?
          '<div class="dyn-topicnav">' +
            (nav.prevHref ? '<a class="dyn-tn" href="' + nav.prevHref + '"><span class="dyn-tn-l">← Previous</span><span class="dyn-tn-n">' + esc(nav.prevLabel || '') + '</span></a>' : '<span></span>') +
            (nav.nextHref ? '<a class="dyn-tn dyn-tn-r" href="' + nav.nextHref + '"><span class="dyn-tn-l">Next →</span><span class="dyn-tn-n">' + esc(nav.nextLabel || '') + '</span></a>' : '<span></span>') +
          '</div>' : '');
      root.querySelectorAll('.dyn-mode button').forEach(function (b) {
        b.addEventListener('click', function () {
          if (mode === b.getAttribute('data-mode')) return;
          mode = b.getAttribute('data-mode'); lsSet('te_dyn_mode', mode); invalidate();
        });
      });
      el('#dyn-play').addEventListener('click', togglePlay);
      el('#dyn-prev').addEventListener('click', function () { inst.prevSentence(); });
      el('#dyn-next').addEventListener('click', function () { inst.nextSentence(); });
      var tp = el('#dyn-tprev'), tn = el('#dyn-tnext');
      if (tp) tp.addEventListener('click', function () { inst._navGo(-1); });
      if (tn) tn.addEventListener('click', function () { inst._navGo(1); });
      el('#dyn-now').addEventListener('click', function () {
        var b = curBlock();
        if (b < 0 || !session) return;
        var card = root.querySelector('.dyn-card[data-num="' + session.map[b].num + '"]');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      var pf = el('#dyn-pf');
      pf.addEventListener('input', function () { el('#dyn-pf-val').textContent = pf.value + '×'; });
      pf.addEventListener('change', function () { factor = parseFloat(pf.value) || 1; lsSet('te_dyn_pf', String(factor)); invalidate(); });
      el('#dyn-seek-bar').addEventListener('click', function (ev) {
        if (!session) return;
        var r = ev.currentTarget.getBoundingClientRect();
        seekTo(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * session.duration);
      });
      if (FEAT.exclude) renderPills();
      renderList();
      updateUI();
    }
    function renderPills() {
      var nIn = included().length, nOut = SENTS.length - nIn;
      var elp = el('#dyn-pills');
      elp.innerHTML = [['all', 'All · ' + SENTS.length], ['in', 'Included · ' + nIn], ['out', 'Excluded · ' + nOut]]
        .map(function (p) { return '<button type="button" data-f="' + p[0] + '" class="' + (filter === p[0] ? 'on' : '') + '">' + p[1] + '</button>'; }).join('');
      elp.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { filter = b.getAttribute('data-f'); renderPills(); renderList(); });
      });
    }
    function renderList() {
      var l = el('#dyn-list');
      l.innerHTML = SENTS.filter(function (s) {
        if (filter === 'in') return !excluded[s.num];
        if (filter === 'out') return !!excluded[s.num];
        return true;
      }).map(function (s) {
        var off = !!excluded[s.num];
        var btns = '';
        if (FEAT.playlist) btns += '<button class="dyn-note" type="button" aria-label="Add to playlist"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg></button>';
        if (FEAT.exclude) btns += '<button class="dyn-x" type="button" aria-label="' + (off ? 'Include' : 'Exclude') + '">' +
          (off ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
               : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>') + '</button>';
        if (FEAT.removeItem) btns += '<button class="dyn-x" type="button" aria-label="Remove from playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/></svg></button>';
        return '<div class="dyn-card' + (off ? ' off' : '') + '" data-num="' + s.num + '" data-tk="' + esc(s.topic_key) + '">' +
          '<div class="dyn-txt">' +
            '<div class="dyn-th">' + esc(String(s.thai).replace(/\s*\|\s*/g, ' ')) + '</div>' +
            (s.translit ? '<div class="dyn-tr">' + esc(s.translit) + '</div>' : '') +
            '<div class="dyn-en">' + esc(s.english) + '</div>' +
            (off ? '<span class="dyn-off-tag">Excluded — tap + to restore</span>' : '') +
          '</div><div class="dyn-btns">' + btns + '</div></div>';
      }).join('') || '<div class="dyn-empty">Nothing here yet.</div>';
      l.querySelectorAll('.dyn-card').forEach(function (card) {
        var num = parseInt(card.getAttribute('data-num'), 10);
        var s = SENTS.filter(function (x) { return x.num === num && x.topic_key === card.getAttribute('data-tk'); })[0];
        card.querySelector('.dyn-txt').addEventListener('click', function () { playFrom(num); });
        var xb = card.querySelector('.dyn-x');
        if (xb && FEAT.exclude) xb.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (excluded[num]) delete excluded[num]; else excluded[num] = 1;
          saveExcl(); renderPills(); renderList(); invalidate();
        });
        if (xb && FEAT.removeItem) xb.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (opts.onRemoveItem) opts.onRemoveItem(s);
        });
        var nb = card.querySelector('.dyn-note');
        if (nb) nb.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openPlaylistPopup(TIER, { topic_key: s.topic_key, num: s.num, prefix: s.prefix, tier: s.tier, thai: s.thai, translit: s.translit || null, english: s.english });
        });
      });
      tickUI();
    }
    var lastMarked = null;
    function tickUI() {
      if (session && el('#dyn-t-cur')) {
        el('#dyn-t-cur').textContent = fmt(curTime);
        el('#dyn-t-tot').textContent = fmt(session.duration);
        el('#dyn-seek-fill').style.width = Math.min(100, curTime / session.duration * 100) + '%';
      }
      var b = curBlock();
      var num = (b >= 0 && session) ? session.map[b].num : null;
      if (num !== lastMarked) {
        lastMarked = num;
        root.querySelectorAll('.dyn-card.playing').forEach(function (c) { c.classList.remove('playing'); });
        if (num != null && (playing || curTime > 0)) {
          var card = root.querySelector('.dyn-card[data-num="' + num + '"]');
          if (card) card.classList.add('playing');
        }
      }
      var now = el('#dyn-now');
      if (!now) return;
      if (session && b >= 0 && (playing || curTime > 0)) {
        var s = SENTS.filter(function (x) { return x.num === session.map[b].num; })[0];
        now.textContent = '▸ Sentence ' + (b + 1) + ' of ' + session.map.length + (s ? ' — ' + String(s.thai).replace(/\s*\|\s*/g, ' ') : '');
      } else if (!building) {
        now.textContent = buildFailed === 'auth' ? 'Sign in to play this content'
          : buildFailed === 'net' ? 'Couldn’t load the audio — check your connection and press play to retry'
          : (included().length ? 'Ready — ' + included().length + ' sentence' + (included().length === 1 ? '' : 's') + ' in the ' + (mode === 'TE' ? 'Thai-first' : 'English-first') + ' session'
                               : 'Every sentence is excluded — include some to play');
      }
    }
    function updateUI() {
      if (!el('#dyn-play-ico')) return;
      root.querySelectorAll('.dyn-mode button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
      el('#dyn-play-ico').innerHTML = playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
      el('#dyn-build').hidden = !building;
      if (building) el('#dyn-now').textContent = '';
      el('#dyn-seek').style.visibility = session ? 'visible' : 'hidden';
      tickUI();
    }

    render();
    inst.play = togglePlay;
    inst.stop = function () { inst.pause(); curTime = 0; };
    inst.refresh = render;
    return inst;
  }

  window.ThaiEarDyn = { create: create };
})();
