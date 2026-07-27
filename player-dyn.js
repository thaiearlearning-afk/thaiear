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
  // Last known NATIVE engine state — the WebView's JS is suspended while the screen is
  // locked, so on wake the active instance re-syncs its UI from this (round-8 item 2).
  var naLast = { t: 0, playing: false };

  // ?dbg=1 debug logging: use player.js's overlay when it's on the page (topic test pages),
  // else build our own identical one (playlists.html has no player.js).
  var DBG_ON = /[?&]dbg=1(&|$)/.test(location.search);
  var dbgEl = null;
  function dbgLog(msg) {
    if (!DBG_ON) return;
    if (window.ThaiEarDynLog) { window.ThaiEarDynLog(msg); return; }
    try {
      if (!dbgEl) {
        dbgEl = document.getElementById('dyn-dbg');
        if (!dbgEl) {
          dbgEl = document.createElement('div');
          dbgEl.id = 'dyn-dbg';
          dbgEl.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;max-width:82vw;' +
            'max-height:8.6em;overflow-y:auto;background:rgba(10,10,20,.82);color:#8f8;' +
            'font:10px/1.35 monospace;padding:5px 7px;border-radius:6px;pointer-events:none;' +
            'white-space:pre-wrap;word-break:break-all;';
          (document.body || document.documentElement).appendChild(dbgEl);
        }
      }
      var t = new Date();
      var line = document.createElement('div');
      line.textContent = ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + ' ' + msg;
      dbgEl.appendChild(line);
      while (dbgEl.childNodes.length > 40) dbgEl.removeChild(dbgEl.firstChild);
      dbgEl.scrollTop = dbgEl.scrollHeight;
    } catch (_) {}
  }
  if (DBG_ON) {
    window.addEventListener('error', function (e) { dbgLog('ERR ' + ((e && e.message) || e.type)); });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      dbgLog('REJ ' + ((r && ((r.name || '') + ' ' + (r.message || r.code || ''))) || String(r)));
    });
  }

  if (NA) {
    NA.addListener('time', function (d) { if (d) naLast.t = d.position || 0; if (active && d) active._onTime(d.position || 0); });
    NA.addListener('ended', function () { naLast.playing = false; if (active) active._onEnded(); });
    NA.addListener('playing', function (d) { naLast.playing = !!(d && d.playing); if (active) active._onPlaying(!!(d && d.playing)); });
    NA.addListener('command', function (d) {
      if (!active) return;
      var a = d && d.action;
      dbgLog('na:cmd ' + a);
      if (a === 'thaiear.SENT_NEXT') active.nextSentence();
      else if (a === 'thaiear.SENT_PREV') active.prevSentence();
      else if (a === 'thaiear.NEXT') active._navGo(1);
      else if (a === 'thaiear.PREV') active._navGo(-1);
    });
  }

  // iPhone/web: after lock/unlock the OS can pause (or keep playing) the <audio> while the
  // page was hidden — the UI's `playing` flag goes stale ("Ready…" while audio still plays).
  // Re-sync the active instance from the element's real state whenever we become visible.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && active && active._resync) active._resync();
  });

  // Bounded-concurrency runner — Safari throttles big parallel fetch bursts (the iOS
  // slow-build culprit), so clip fetches (and the /api/audio mints inside them) run at most
  // POOL_N at a time instead of one unbounded Promise.all.
  var POOL_N = 6;
  function pool(items, worker) {
    var i = 0, results = new Array(items.length);
    function lane() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return worker(items[idx], idx).then(function (r) { results[idx] = r; return lane(); });
    }
    var lanes = [];
    for (var l = 0; l < Math.min(POOL_N, items.length); l++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return results; });
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

  // Circular-① sentence-skip glyphs — identical to the player.js dyn topic player's (item 6:
  // the two players must be visually indistinguishable).
  var SVG_D1 = '<path d="M12.36 15.94v-4.27h-.09l-1.77.63v.69l1.01-.31v3.26h.85z"/>';
  var SVG_SENT_PREV = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>' + SVG_D1 + '</svg>';
  var SVG_SENT_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 13c0 4.4 3.6 8 8 8s8-3.6 8-8h-2c0 3.3-2.7 6-6 6s-6-2.7-6-6 2.7-6 6-6v4l5-5-5-5v4c-4.4 0-8 3.6-8 8z"/>' + SVG_D1 + '</svg>';

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
    // Same keys as the topic dyn player (player.js) — the two UIs share these settings.
    var repeats = parseInt(lsGet('te_dyn_rp', '2'), 10);
    if (!(repeats >= 1 && repeats <= 4)) repeats = 2;
    var english = lsGet('te_dyn_en', '1') !== '0';   // TE only; ET always includes English
    var excluded = {};
    if (FEAT.exclude) {
      try { (JSON.parse(lsGet('te_dyn_excl_' + NS, '[]')) || []).forEach(function (n) { excluded[n] = 1; }); } catch (_) {}
    }
    function saveExcl() { lsSet('te_dyn_excl_' + NS, JSON.stringify(Object.keys(excluded).map(Number))); }
    var filter = 'all';
    var session = null, building = false, buildFailed = null;
    var playing = false, curTime = 0;
    var removing = null;   // { marked: {tk|num: item} } while batch-remove tick mode is active
    var inst = {};
    // ── session persistence (round-8 item 1; mirrors player.js's dyn persistence) ──
    // Only when the host passes a persistId (playlists.html → the playlist id). Meta in
    // localStorage; audio in the durable 'thaiear-audio-dl' cache (web) or the DATA dir
    // (native) under UNIQUE per-build names + old-file cleanup (the stale-URI lesson).
    var PID = opts.persistId != null ? String(opts.persistId) : null;
    function plMetaKey(m) { return 'te_dyn_meta_pl_' + PID + '_' + m; }
    function plCachePath(m) { return '/dyn/pl-' + PID + '/' + m + '.wav'; }
    function plReadMeta(m) {
      try {
        var x = JSON.parse(lsGet(plMetaKey(m), 'null') || 'null');
        if (x && x.key && x.map && x.map.length && x.duration) return x;
      } catch (_) {}
      return null;
    }
    function plNextSeq() {
      var n = 1;
      try { n = (parseInt(localStorage.getItem('te_dyn_seq'), 10) || 0) + 1; localStorage.setItem('te_dyn_seq', String(n)); } catch (_) {}
      return n;
    }
    function plPersist(sess, m) {
      if (!PID) return Promise.resolve(sess);
      var oldMeta = plReadMeta(m);
      if (NA && FS) {
        var name = 'dyn-pl-' + PID + '-' + m + '-' + plNextSeq() + '.wav';
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
          fr.onerror = function () { rej(new Error('fr')); };
          fr.readAsDataURL(sess.blob);
        }).then(function (b64) {
          return FS.writeFile({ path: name, data: b64, directory: 'DATA' });
        }).then(function () {
          return FS.getUri({ path: name, directory: 'DATA' });
        }).then(function (u) {
          sess.fileUri = (u && u.uri) || null;
          sess.file = name;
          lsSet(plMetaKey(m), JSON.stringify({ key: sess.key, map: sess.map, duration: sess.duration, file: name }));
          if (oldMeta && oldMeta.file && oldMeta.file !== name) {
            try { FS.deleteFile({ path: oldMeta.file, directory: 'DATA' }).catch(function () {}); } catch (_) {}
          }
          return sess;
        }).catch(function () { return sess; });   // persistence failure is non-fatal — the session still plays
      }
      lsSet(plMetaKey(m), JSON.stringify({ key: sess.key, map: sess.map, duration: sess.duration }));
      if (window.caches) {
        caches.open('thaiear-audio-dl').then(function (c) {
          return c.put(plCachePath(m), new Response(sess.blob, { headers: { 'Content-Type': 'audio/wav' } }));
        }).catch(function () {});
      }
      return Promise.resolve(sess);
    }
    // Resolves the restored session, or null on any miss (stale key, evicted cache, purged file).
    function plRestore(m) {
      if (!PID) return Promise.resolve(null);
      var meta = plReadMeta(m);
      if (!meta || meta.key !== sessionKey()) return Promise.resolve(null);
      if (NA) {
        if (!FS || !meta.file) return Promise.resolve(null);
        return FS.stat({ path: meta.file, directory: 'DATA' })
          .then(function () { return FS.getUri({ path: meta.file, directory: 'DATA' }); })
          .then(function (u) {
            if (!u || !u.uri) return null;
            return { url: null, fileUri: u.uri, blob: null, map: meta.map, key: meta.key, duration: meta.duration, file: meta.file };
          }).catch(function () { return null; });
      }
      if (!window.caches) return Promise.resolve(null);
      return caches.open('thaiear-audio-dl')
        .then(function (c) { return c.match(plCachePath(m)); })
        .then(function (r) { return r ? r.blob() : null; })
        .then(function (b) {
          if (!b) return null;
          return { url: URL.createObjectURL(b), blob: b, map: meta.map, key: meta.key, duration: meta.duration };
        }).catch(function () { return null; });
    }

    function included() { return SENTS.filter(function (s) { return !excluded[s.num]; }); }
    function repeatPause(s) { return Math.max(3.0, syllables(s.thai) * 0.5) * factor; }
    function recallPause(s) { return Math.max(4.5, syllables(s.thai) * 0.7) * factor; }
    function needEnglish() { return mode === 'ET' || english; }
    // English is EFFECTIVE-value keyed (ET always has it) so the TE-only toggle doesn't churn ET sessions.
    function sessionKey() { return mode + '|' + factor + '|r' + repeats + '|e' + (needEnglish() ? 1 : 0) + '|' + included().map(function (s) { return s.num; }).join(','); }

    function buildSession(onProg) {
      var inc = included();
      var octx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, SR);
      var needEn = needEnglish();
      var files = [];
      inc.forEach(function (s) { files.push([s, 'TH']); if (needEn) files.push([s, 'EN']); });
      var got = 0, total = files.length;
      return pool(files, function (f) {
        return fetchDecode(f[0], f[1], TIER, octx).then(function (b) { got++; if (onProg) onProg(got, total); return b; });
      }).then(function () {
        var chunks = [], map = [], t = 0;
        function addBuf(b) { chunks.push(b.getChannelData(0)); t += b.getChannelData(0).length / SR; }
        function addSil(sec) { var n = Math.round(sec * SR); chunks.push(new Float32Array(n)); t += n / SR; }
        inc.forEach(function (s) {
          var th = pcmCache[s.prefix + '_S' + s.num + '_TH'], en = needEn ? pcmCache[s.prefix + '_S' + s.num + '_EN'] : null;
          var start = t, r;
          if (mode === 'TE') {
            addBuf(th);
            for (r = 1; r < repeats; r++) { addSil(repeatPause(s)); addBuf(th); }
            if (english) { addSil(repeatPause(s)); addBuf(en); }
          } else {
            addBuf(en); addSil(recallPause(s)); addBuf(th);
            for (r = 1; r < repeats; r++) { addSil(repeatPause(s)); addBuf(th); }
          }
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
    // Called by the module visibilitychange listener when we return to the foreground:
    // adopt the REAL engine state. Web reads the <audio> element; native reads the cached
    // last NA 'time'/'playing' data (the WebView's JS was suspended while locked, so the
    // instance's own flags — and a box auto-played via lock-screen nav — are stale).
    inst._resync = function () {
      if (NA) {
        if (active !== inst) return;
        playing = naLast.playing;
        curTime = naLast.t || curTime;
        updateUI();   // full repaint: play icon, seek bar visibility/fill, card highlight
        return;
      }
      if (!audio) return;
      playing = !audio.paused && !audio.ended;
      curTime = audio.currentTime || curTime;
      updateUI();
    };
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
          navigator.mediaSession.setActionHandler('play', function () { dbgLog('ms:play'); if (audio) audio.play(); });
          navigator.mediaSession.setActionHandler('pause', function () { dbgLog('ms:pause'); if (audio) audio.pause(); });
          navigator.mediaSession.setActionHandler('nexttrack', function () { dbgLog('ms:nexttrack'); inst.nextSentence(); });
          navigator.mediaSession.setActionHandler('previoustrack', function () { dbgLog('ms:prevtrack'); inst.prevSentence(); });
        } catch (_) {}
      }
    }
    function startPlayback() {
      claim();
      if (NA) {
        var doPrep = function (uri) {
          return NA.prepare({
            url: uri, title: opts.name || 'ThaiEar', subtitle: 'ThaiEar',
            artwork: 'https://thaiear.com/apple-touch-icon.png', mode: 'dyn',
            // sentence start-times → native lock-screen sentence skip (JS is suspended when locked)
            marks: session.map.map(function (m) { return m.start; })
          }).then(function () { playing = true; return NA.play(); });
        };
        // Persisted sessions (built or restored) already sit in the DATA dir under a unique
        // name — prepare that URI directly. The throwaway CACHE write remains only for
        // callers without a persistId.
        if (session.fileUri) return doPrep(session.fileUri);
        var fr = new FileReader();
        return new Promise(function (resolve, reject) {
          fr.onerror = reject;
          fr.onload = function () {
            var b64 = String(fr.result).split(',')[1];
            FS.writeFile({ path: 'dyn-session.wav', data: b64, directory: 'CACHE' })
              .then(function () { return FS.getUri({ path: 'dyn-session.wav', directory: 'CACHE' }); })
              .then(function (u) { return doPrep(u.uri); })
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
      buildFailed = null;
      // Restore-before-build (round-8 item 1): a persisted-session hit skips the fetch/decode
      // AND the "Constructing…" status entirely, like the topic dyn player.
      return plRestore(mode).then(function (restored) {
        if (restored) {
          if (session && session.url) { try { URL.revokeObjectURL(session.url); } catch (_) {} }
          session = restored;
          updateUI();
          return session;
        }
        building = true; updateUI();
        return buildSession(function (d, t) { var n = el('#dyn-build-n'); if (n) n.textContent = ' ' + d + '/' + t; })
          .then(function (s) { return plPersist(s, mode); })
          .then(function (s) { building = false; updateUI(); return s; });
      }).catch(function (e) {
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

    /* ── batch-remove tick mode (features.batchRemove) ──
       Entered via inst.enterRemoveMode() (playlists.html's "Remove sentences" button). Every
       item card gets a tick circle; all start UNTICKED and ticking marks FOR REMOVAL. A fixed
       bottom bar shows 'N to remove · Cancel / Done'; Done runs opts.onBatchRemoveItem(item)
       sequentially with 'Removing… i of N' progress, then exits and calls opts.onBatchRemoveDone(). */
    function rmKey(tk, num) { return tk + '|' + num; }
    function rmBar() { return document.getElementById('dyn-rm-bar'); }
    function rmCount() {
      var c = document.getElementById('dyn-rm-count');
      if (!c || !removing) return;
      var n = 0; for (var k in removing.marked) n++;
      c.textContent = n + ' to remove';
    }
    function exitRemoveMode() {
      removing = null;
      var bar = rmBar();
      if (bar) bar.parentNode.removeChild(bar);
      renderList();
    }
    function rmDone() {
      if (!removing) return;
      var items = [];
      for (var k in removing.marked) items.push(removing.marked[k]);
      if (!items.length) { exitRemoveMode(); return; }
      var bar = rmBar();
      var btns = bar ? bar.querySelectorAll('button') : [];
      btns.forEach(function (b) { b.disabled = true; });
      var cnt = document.getElementById('dyn-rm-count');
      var chain = Promise.resolve();
      items.forEach(function (it, i) {
        chain = chain.then(function () {
          if (cnt) cnt.textContent = 'Removing… ' + (i + 1) + ' of ' + items.length;
          return opts.onBatchRemoveItem ? opts.onBatchRemoveItem(it) : Promise.resolve();
        });
      });
      chain.then(function () {
        exitRemoveMode();
        if (opts.onBatchRemoveDone) opts.onBatchRemoveDone();   // host re-renders (fresh instance)
      }).catch(function () {
        btns.forEach(function (b) { b.disabled = false; });
        rmCount();
        alert('Couldn’t remove — check your connection.');
      });
    }
    inst.enterRemoveMode = function () {
      if (!FEAT.batchRemove || removing || !SENTS.length) return;
      if (playing) inst.pause();
      removing = { marked: {} };
      var bar = rmBar();
      if (!bar) { bar = document.createElement('div'); bar.id = 'dyn-rm-bar'; document.body.appendChild(bar); }
      bar.innerHTML = '<span id="dyn-rm-count"></span>' +
        '<span style="display:flex;gap:8px">' +
          '<button type="button" class="dyn-rm-cancel">Cancel</button>' +
          '<button type="button" class="dyn-rm-done">Done</button></span>';
      bar.querySelector('.dyn-rm-cancel').addEventListener('click', exitRemoveMode);
      bar.querySelector('.dyn-rm-done').addEventListener('click', rmDone);
      bar.classList.add('show');
      renderList();
      rmCount();
    };

    /* UI */
    function el(sel) { return root.querySelector(sel); }
    function render() {
      var nav = opts.nav || {};
      root.innerHTML =
        '<div class="dyn-player' + (TIER === 'premium' ? ' tier-premium' : '') + '">' +
          '<div class="dyn-mode" role="group"><button type="button" data-mode="TE">Thai first</button><button type="button" data-mode="ET">English first</button></div>' +
          '<div class="dyn-main">' +
            ((nav.prevHref || nav.onPrev) ? '<button class="dyn-skip dyn-topic-btn" id="dyn-tprev" type="button" aria-label="Previous topic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h2v14H4z"/><path d="M13 5v14l-7-7zM21 5v14l-7-7z"/></svg></button>' : '') +
            '<button class="dyn-skip dyn-sent" id="dyn-prev" type="button" aria-label="Previous sentence" title="Previous sentence">' + SVG_SENT_PREV + '</button>' +
            '<button class="dyn-play" id="dyn-play" type="button" aria-label="Play"><svg id="dyn-play-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
            '<button class="dyn-skip dyn-sent" id="dyn-next" type="button" aria-label="Next sentence" title="Next sentence">' + SVG_SENT_NEXT + '</button>' +
            ((nav.nextHref || nav.onNext) ? '<button class="dyn-skip dyn-topic-btn" id="dyn-tnext" type="button" aria-label="Next topic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 5h2v14h-2z"/><path d="M3 5v14l7-7zM11 5v14l7-7z"/></svg></button>' : '') +
            '<div class="dyn-scrubwrap">' +
              '<div class="dyn-seek" id="dyn-seek">' +
                '<div class="dyn-seek-bar" id="dyn-seek-bar"><i id="dyn-seek-fill"></i></div>' +
                '<div class="dyn-seek-t"><span id="dyn-t-cur">0:00</span><span id="dyn-t-tot">–:––</span></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="dyn-build" id="dyn-build" hidden>Constructing dynamic mp3 file<span class="dyn-dots" aria-hidden="true"></span><span id="dyn-build-n"></span></div>' +
          '<button class="dyn-now" id="dyn-now" type="button">Ready</button>' +
          '<div class="dyn-slider"><span>Pauses</span><input id="dyn-pf" type="range" min="0.5" max="2" step="0.25" value="' + factor + '"><span id="dyn-pf-val">' + factor + '×</span>' +
            '<span class="dyn-ctl-sep">·</span><span>Thai sentence repeats</span><span class="dyn-reps" id="dyn-reps"></span>' +
            '<span class="dyn-ctl-sep" id="dyn-en-sep">·</span><label class="dyn-en-lbl" id="dyn-en-wrap"><input type="checkbox" id="dyn-en"' + (english ? ' checked' : '') + '> English</label>' +
          '</div>' +
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
      // Thai repeat count 1–4 (shared localStorage key with the topic dyn player)
      var repsEl = el('#dyn-reps');
      [1, 2, 3, 4].forEach(function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = String(n);
        b.className = 'dyn-rep-btn' + (n === repeats ? ' on' : '');
        b.setAttribute('aria-label', n + ' Thai repeat' + (n === 1 ? '' : 's'));
        b.addEventListener('click', function () {
          if (repeats === n) return;
          repeats = n; lsSet('te_dyn_rp', String(n));
          repsEl.querySelectorAll('.dyn-rep-btn').forEach(function (x) { x.classList.toggle('on', x.textContent === String(n)); });
          invalidate();
        });
        repsEl.appendChild(b);
      });
      // English on/off — TE only (hidden in ET via updateUI)
      var enCb = el('#dyn-en');
      enCb.addEventListener('change', function () {
        english = enCb.checked; lsSet('te_dyn_en', english ? '1' : '0');
        invalidate();
      });
      el('#dyn-seek-bar').addEventListener('click', function (ev) {
        if (!session) return;
        var r = ev.currentTarget.getBoundingClientRect();
        var target = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * session.duration;
        // Round-8 item 3: snap to the nearest sentence-block start — never land mid-pause.
        var best = target, bd = Infinity;
        session.map.forEach(function (m) { var d = Math.abs(m.start - target); if (d < bd) { bd = d; best = m.start; } });
        seekTo(best);
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
          (removing ? '<span class="dyn-tick' + (removing.marked[rmKey(s.topic_key, s.num)] ? ' on' : '') + '" aria-hidden="true"></span>' : '') +
          '<div class="dyn-txt">' +
            '<div class="dyn-th">' + esc(String(s.thai).replace(/\s*\|\s*/g, ' ')) + '</div>' +
            (s.translit ? '<div class="dyn-tr">' + esc(s.translit) + '</div>' : '') +
            '<div class="dyn-en">' + esc(s.english) + '</div>' +
            (off ? '<span class="dyn-off-tag">Excluded — tap + to restore</span>' : '') +
          '</div><div class="dyn-btns">' + btns + '</div></div>';
      }).join('') || '<div class="dyn-empty">Nothing here yet.</div>';
      l.classList.toggle('removing', !!removing);
      l.querySelectorAll('.dyn-card').forEach(function (card) {
        var num = parseInt(card.getAttribute('data-num'), 10);
        var s = SENTS.filter(function (x) { return x.num === num && x.topic_key === card.getAttribute('data-tk'); })[0];
        if (removing) {
          // remove-tick mode: the whole card toggles its mark; play/exclude/bin are suspended
          card.addEventListener('click', function () {
            var key = rmKey(card.getAttribute('data-tk'), num);
            if (removing.marked[key]) delete removing.marked[key];
            else removing.marked[key] = { topic_key: card.getAttribute('data-tk'), num: num };
            var t = card.querySelector('.dyn-tick');
            if (t) t.classList.toggle('on', !!removing.marked[key]);
            rmCount();
          });
          return;
        }
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
      // English toggle is TE-only (ET always includes English)
      var enW = el('#dyn-en-wrap'), enS = el('#dyn-en-sep');
      if (enW) enW.style.display = (mode === 'ET') ? 'none' : '';
      if (enS) enS.style.display = (mode === 'ET') ? 'none' : '';
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

  window.ThaiEarDyn = { create: create, openPopup: openPlaylistPopup };
})();
