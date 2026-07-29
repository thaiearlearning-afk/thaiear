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
  window.addEventListener('pagehide', function () { writeWebResume(true); });

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
     enabled on both R2 buckets. Gated behind a flag (off by default) so it can ship dark and be
     proven on a real iPhone before going live: enable with ?webdl=1 (sticky, survives navigation)
     or localStorage thaiear_webdl='1'. Never active in the native app (which uses Filesystem). */
  var WEB_DL_FLAG = (function () {
    try {
      var m = location.search.match(/[?&]webdl=([01])/);
      if (m) localStorage.setItem('thaiear_webdl', m[1]);   // sticky toggle for on-device testing
      return localStorage.getItem('thaiear_webdl') === '1';
    } catch (_) { return false; }
  })();
  var CACHES = (window.caches && window.isSecureContext) ? window.caches : null;
  var WEB_DL = !NATIVE && !!CACHES && WEB_DL_FLAG;
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

  // Persist a downloaded topic's PAGE (+ shared scripts) in a cache the service worker never
  // version-wipes, so the page still opens offline after an SW update. Self-heals whenever we're
  // online on a downloaded topic's page. (The SW's activate step preserves the 'thaiear-dl' cache.)
  var DL_PAGE_CACHE = 'thaiear-dl';
  function cachePage() {
    if (!window.caches || !navigator.onLine) return;
    try {
      caches.open(DL_PAGE_CACHE).then(function (c) {
        [location.href, '/player.js', '/topics.js', '/nav.js', '/auth.js', '/footer.js', '/audio-versions.json'].forEach(function (u) {
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
  function stampVerified() {
    try {
      // Owner simulator: hold the licence markers still while an account state is armed. Without
      // this, setting "51 days" online and THEN going offline lost the backdating on the way out
      // (this fires from canUseOffline's online-and-subscribed branch), so the offline half of the
      // test could never be set up. The simulator owns these inputs while armed.
      if (window.ThaiEarSim && window.ThaiEarSim.tier()) return;
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
  function simDenies() { var S = window.ThaiEarSim; return !!(S && S.denies()); }
  // The auth view every entitlement check reads: the real ThaiEarAuth unless sim.js is present
  // AND armed, in which case a same-shape shim reporting the simulated account. Absent sim.js
  // (i.e. every real page) this is a plain pass-through.
  function AUTHV() {
    var S = window.ThaiEarSim;
    return S ? S.authView(window.ThaiEarAuth) : window.ThaiEarAuth;
  }

  // May an offline download of this tier be played right now? free/member: always.
  // premium: live subscription when online; else within the verified-online window.
  function canUseOffline(tier) {
    if (tier !== 'premium') return true;
    // Lifetime members (£0-forever) never time out offline — they may be off-grid for months.
    // The flag is maintained by auth.js ONLY when the server confirms lifetime+active while online,
    // so a regular paying user can never reach this early-return.
    try { if (localStorage.getItem('thaiear_lifetime') === '1') return true; } catch (_) {}
    var a = AUTHV();
    var subbed = a && a.isSubscribed && a.isSubscribed();
    // Only GRANT on the online fast-path — never DENY from it. navigator.onLine is unreliable in the
    // WebView (reports online in airplane mode, esp. at COLD START before the sub-cache seeds), so a
    // deny here wrongly blocked a just-verified member who reopened the app offline. Denial is driven
    // purely by the grace window + real end-date below, so a genuinely lapsed member still expires.
    if (navigator.onLine && subbed) { stampVerified(); return true; }
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
    if (OFFLINE && isDownloaded(mainPrefix)) {
      if (canUseOffline(mainTier)) return localUri(mainPrefix, file).then(function (uri) { return uri || buildUrl(file, mainGated); });
      if (!navigator.onLine) return Promise.reject({ code: 'licence' }); // downloaded premium, offline licence lapsed
    }
    if (WEB_DL && isDownloaded(mainPrefix)) {
      if (canUseOffline(mainTier)) return cachedBlobUrl(mainPrefix, file).then(function (url) { return url || buildUrl(file, mainGated); });
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    return buildUrl(file, mainGated);
  }
  // Sentence (web <audio>) player: a same-origin blob: URL of the downloaded clip if available
  // (plays reliably across WebViews — see localBlobUrl), else the free CDN / signed remote URL.
  function sentSrcFor(file, gated) {
    if (OFFLINE && isDownloaded(PREFIX)) {
      if (canUseOffline(TIER)) {
        return localBlobUrl(PREFIX, file).then(function (url) { return url || buildUrl(file, gated); });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    if (WEB_DL && isDownloaded(PREFIX)) {
      if (canUseOffline(TIER)) {
        return cachedBlobUrl(PREFIX, file).then(function (url) { return url || buildUrl(file, gated); });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    return buildUrl(file, gated);
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
        var msg = (err && (err.message || err.errorMessage)) || String(err);
        console.warn('player.js: web offline download failed', err);
        downloadingNow = false;
        setOfflineState('error', msg);
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
  function dynCheckAudioUpdate() {
    // &avtest=1 forces the prompt so the flow can be SEEN without editing audio-versions.json.
    // That file is shared with the LIVE site — the test pages use live topics' audio prefixes —
    // so bumping a real entry would nag every user who downloaded topic 3 into re-fetching
    // identical files. A URL flag costs nothing and touches no live data.
    var force = /[?&]avtest=1(&|$)/.test(location.search);
    if (!navigator.onLine && !force) return;   // can't check it, and couldn't act on it either
    loadAudioVers().then(function (map) {
      if (!map && !force) return;
      map = map || {};
      var by = dynDlGroups(), m = getManifest(), adopted = false, stale = false;
      Object.keys(by).forEach(function (pfx) {
        var e = m[pfx]; if (!e) return;
        var cur = map[pfx];
        if (cur == null) return;                                  // nothing published for it
        if (e.av == null) { e.av = cur; adopted = true; return; }  // baseline, don't nag
        if (e.av !== cur) stale = true;
      });
      if (adopted) setManifest(m);
      if (force) stale = true;
      if (!stale) return;
      var bar = $('offline-bar'); if (!bar) return;
      bar.innerHTML = '<span class="offline-status">⟳ Download audio update?</span>' +
        '<button class="offline-btn" onclick="dynUpdateAudio()">Update</button>' +
        '<button class="offline-btn offline-del" onclick="confirmDelete()">Delete</button>';
    }).catch(function () {});
  }
  function dynUpdateAudio() {
    if (!navigator.onLine) { setOfflineState('error', 'you’re offline — reconnect to update'); return; }
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
  function dynDlSizeCached() {
    var by = dynDlGroups(), m = getManifest(), total = 0, known = true;
    Object.keys(by).forEach(function (pfx) {
      var e = m[pfx];
      if (!e || typeof e.bytes !== 'number') { known = false; return; }
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
    var prefixes = Object.keys(dynDlGroups()).filter(function (p) {
      var e = m[p]; return e && typeof e.bytes !== 'number';
    });
    if (!prefixes.length) return Promise.resolve(dynDlSizeCached());
    var chain = Promise.resolve();
    prefixes.forEach(function (pfx) {
      chain = chain.then(function () {
        var files = (getManifest()[pfx] || {}).files || [], sum = 0;
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
          var mm = getManifest();
          if (mm[pfx]) { mm[pfx].bytes = sum; setManifest(mm); }
        });
      });
    });
    return chain.then(function () { return dynDlSizeCached(); });
  }
  function dynFmtMb(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function dynPaintOfflineSize() {
    var el = document.querySelector('#offline-bar .offline-ok');
    if (!el) return;
    var cached = dynDlSizeCached();
    if (cached != null) { el.textContent = '✓ Available offline (' + dynFmtMb(cached) + ')'; return; }
    dynDlMeasure().then(function (t) {
      var e2 = document.querySelector('#offline-bar .offline-ok');   // may have re-rendered meanwhile
      if (e2 && t != null) e2.textContent = '✓ Available offline (' + dynFmtMb(t) + ')';
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
    if (!navigator.onLine) { setOfflineState('offline'); return; }   // don't grind through retries
    var by = dynDlGroups(), prefixes = Object.keys(by), total = 0, done = 0;
    prefixes.forEach(function (k) { total += by[k].files.length; });
    if (!total) return;
    function step() { done++; setOfflineState('downloading', done, total); }
    downloadingNow = true;
    setOfflineState('downloading', 0, total);
    if (DYN_WEB_DL) { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {} }
    var chain = DYN_WEB_DL ? caches.open(AUDIO_DL_CACHE) : Promise.resolve(null);
    chain = chain.then(function (cache) {
      var c = Promise.resolve();
      prefixes.forEach(function (pfx) {
        c = c.then(function () {
          return OFFLINE ? Filesystem.mkdir({ directory: 'DATA', path: offlineDir(pfx), recursive: true })
            .catch(function () {}) : null;      // downloadFile does NOT create parents on Android
        }).then(function () {
          return dynPool(by[pfx].files, function (f) { return dynDlFile(cache, pfx, by[pfx].tier, f).then(step); });
        });
      });
      return c;
    });
    chain.then(function () { return loadAudioVers(); }).then(function (avMap) {
      // Merge into whatever is already recorded — a playlist and a topic can legitimately both
      // claim the same prefix, and neither may erase the other's files or ref.
      var m = getManifest(), ref = dynDlRef();
      prefixes.forEach(function (pfx) {
        var e = m[pfx] || { tier: by[pfx].tier, files: [], ver: '', av: null };
        var seen = {};
        (e.files || []).concat(by[pfx].files).forEach(function (f) { seen[f] = true; });
        e.files = Object.keys(seen);
        e.refs = (e.refs || []).filter(function (r) { return r !== ref; });
        e.refs.push(ref);
        e.tier = by[pfx].tier; e.at = Date.now(); e.dyn = true;
        delete e.bytes;                       // file set changed → re-measure rather than lie
        if (avMap && avMap[pfx] != null) e.av = avMap[pfx];   // baseline for "audio update?"
        m[pfx] = e;
      });
      setManifest(m);
      if (PLMODE) {   // so the playlists page's own Clear knows which prefixes to release
        try {
          var pm = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}');
          pm[String(DYN_KEY_NS).replace(/^pl-/, '')] = { prefixes: prefixes, at: Date.now() };
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
      var msg = (err && (err.message || err.errorMessage)) || String(err);
      if (!navigator.onLine || /failed to fetch|load failed|network|timed out|networkerror/i.test(msg)) {
        setOfflineState('offline');
      } else {
        setOfflineState('error', msg);
      }
    });
  }
  function dynDeleteHere() {
    var by = dynDlGroups(), m = getManifest(), ref = dynDlRef();
    var chain = Promise.resolve();
    Object.keys(by).forEach(function (pfx) {
      var e = m[pfx]; if (!e) return;
      // Release only OUR claim. If a downloaded playlist (or the topic) still needs these
      // clips they stay put; over-retaining is invisible, under-deleting breaks playback.
      e.refs = (e.refs || ['topic']).filter(function (r) { return r !== ref; });
      if (e.refs.length) { m[pfx] = e; return; }
      var files = e.files || [];
      delete m[pfx];
      chain = chain.then(function () {
        if (OFFLINE) return Filesystem.rmdir({ directory: 'DATA', path: offlineDir(pfx), recursive: true }).catch(function () {});
        if (!CACHES) return null;
        return caches.open(AUDIO_DL_CACHE).then(function (c) {
          return Promise.all(files.map(function (f) { return c.delete(webCacheKey(pfx, f)).catch(function () {}); }));
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
    return chain.then(function () { setOfflineState('idle'); });
  }

  function downloadTopic() {
    if (!OFFLINE && !WEB_DL && !(DYN && DYN_WEB_DL)) return;
    // Gated topic + not entitled → same preview-only gate as play/reveal/flag (premium → "preview
    // only" toast in-app; member → sign-in), instead of attempting the download and erroring on /api/audio.
    if (!entitledForPage()) { gate(TIER); return; }
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
        var msg = (err && (err.message || err.errorMessage)) || String(err);
        console.warn('player.js: offline download failed', err);
        downloadingNow = false;
        setOfflineState('error', msg);
      });
  }
  // Confirm before deleting a download (parity with the grid's Clear-downloads warning).
  function confirmDelete() {
    var bar = $('offline-bar'); if (!bar) return;
    bar.innerHTML = '<span class="offline-status">Delete this download?</span>' +
      '<button class="offline-btn offline-del" onclick="deleteTopic()">Delete</button>' +
      '<button class="offline-btn" onclick="cancelDelete()">Keep</button>';
  }
  function cancelDelete() { setOfflineState('downloaded'); }
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
    if (WEB_DL) { webDeleteTopic().then(function () { removeDownloaded(PREFIX); setOfflineState('idle'); }); return; }
    Filesystem.rmdir({ directory: 'DATA', path: offlineDir(PREFIX), recursive: true })
      .catch(function () {})
      .then(function () { removeDownloaded(PREFIX); setOfflineState('idle'); });
  }
  function setOfflineState(state, done, total) {
    var bar = $('offline-bar'); if (!bar) return;
    if (state === 'downloading') {
      bar.innerHTML = '<span class="offline-status"><span class="prog-spin"></span> Downloading ' + (done || 0) + '/' + (total || '?') + ' — keep this page open</span>';
    } else if (state === 'downloaded') {
      bar.innerHTML = '<span class="offline-status offline-ok">✓ Available offline</span>' +
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
      var msg = done ? (': ' + escapeHtml(String(done).slice(0, 160))) : '.';
      bar.innerHTML = '<span class="offline-status">Download failed' + msg + '</span>' +
        '<button class="offline-btn" onclick="downloadTopic()">Retry</button>';
    } else { // idle
      bar.innerHTML = '<button class="offline-btn" onclick="downloadTopic()">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        ' Download for offline</button>';
    }
  }
  function renderOfflineBar() {
    var bar = $('offline-bar'); if (!bar) return;
    if (!OFFLINE && !WEB_DL && !(DYN && DYN_WEB_DL)) { bar.style.display = 'none'; return; }  // plain website (no app, flag off): never shown
    bar.style.display = 'flex';
    if (DYN) {
      // No stale/refresh states here: a dyn session is keyed on its own content and settings,
      // so changed text or a changed setting rebuilds by itself. Downloaded means "the clips
      // are all here", which is the only claim worth making.
      if (!dynDlHasAll()) { setOfflineState('idle'); return; }
      cachePage();
      setOfflineState('downloaded');
      dynPaintOfflineSize();
      dynCheckAudioUpdate();   // async; upgrades the bar only if the CLIPS on R2 have changed
      return;
    }
    var ent = getManifest()[PREFIX];
    if (!ent) { setOfflineState('idle'); return; }
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

  // Refresh the offline licence whenever auth resolves online with an active subscription.
  window.addEventListener('thaiear:auth', function () {
    var a = window.ThaiEarAuth;
    if (navigator.onLine && a && a.isSubscribed && a.isSubscribed()) stampVerified();
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
    /* Reserve the late-loading (auth-gated) progress card's slot on desktop/tablet too, so it
       doesn't shove the player's controls down when it appears (CLS). 54px = its measured desktop
       height (logged-in card; the logged-out card is 45px and sits in the same slot). Mobile
       overrides to 73px below. */
    .progress-controls { margin-bottom: 0.9rem; min-height: 54px; }
    .prog-ctl-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
      background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: 0.7rem 0.9rem; }
    .prog-ctl-left { display: flex; align-items: baseline; gap: 7px; }
    .prog-ctl-count { font-size: 20px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; line-height: 1; transition: transform 0.18s; }
    .prog-ctl-count.bump { animation: prog-bump 0.4s cubic-bezier(0.2,0.8,0.3,1.3); }
    @keyframes prog-bump { 0% { transform: scale(1); } 45% { transform: scale(1.35); } 100% { transform: scale(1); } }
    .prog-ctl-label { font-size: 12.5px; color: var(--text-secondary); }
    .prog-ctl-btns { display: flex; align-items: center; gap: 7px; }
    .prog-ctl-btn { font-family: var(--font-ui); font-size: 13px; font-weight: 500; border-radius: var(--radius-sm);
      border: 0.5px solid var(--border-strong); background: var(--surface); color: var(--text-secondary);
      padding: 6px 12px; cursor: pointer; min-width: 36px; display: inline-flex; align-items: center; justify-content: center;
      gap: 5px; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .prog-ctl-btn:hover:not([disabled]) { border-color: var(--accent); color: var(--accent); }
    .prog-ctl-btn[disabled] { opacity: 0.55; cursor: default; }
    .prog-ctl-btn.prog-ctl-add { background: var(--accent); color: #fff; border-color: var(--accent); }
    .prog-ctl-btn.prog-ctl-add:hover:not([disabled]) { background: var(--accent-mid); color: #fff; }
    .prog-ctl-minus { font-size: 17px; line-height: 1; font-weight: 400; padding: 5px 13px; }
    .prog-ctl-my { font-size: 12.5px; font-weight: 500; color: var(--accent); text-decoration: none; margin-left: 3px; white-space: nowrap; }
    .prog-ctl-my:hover { color: var(--accent-mid); }
    .prog-ctl-join { font-size: 13px; font-weight: 500; color: var(--accent); text-decoration: none; }
    .prog-ctl-join:hover { color: var(--accent-mid); }
    .prog-spin { display: inline-block; width: 13px; height: 13px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: prog-spin 0.6s linear infinite; }
    @keyframes prog-spin { to { transform: rotate(360deg); } }
    .prog-tick { display: inline-block; font-weight: 700; animation: prog-tick-pop 0.4s cubic-bezier(0.2,0.8,0.3,1.3) both; }
    @keyframes prog-tick-pop { 0% { transform: scale(0); opacity: 0; } 60% { transform: scale(1.3); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    @media (max-width: 600px) {
      /* Reserve the late-loading (auth-gated) progress card's slot so it doesn't shove the
         player's controls down when it appears (CLS). 73px = its measured mobile height. */
      .progress-controls { min-height: 73px; }
      .prog-ctl-card { padding: 0.6rem 0.7rem; }
      .prog-ctl-count { font-size: 18px; }
      .prog-ctl-btn { font-size: 12px; padding: 5px 10px; }
    }
    .player-card { background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: 1.1rem 1.25rem 1rem; margin-bottom: 1.75rem; }
    .player-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.9rem; }
    .audio-toggle { display: flex; gap: 2px; background: var(--bg); border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 2px; }
    .toggle-btn { font-size: 12px; font-family: var(--font-ui); font-weight: 400; color: var(--text-secondary); background: none; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap; }
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
    .controls-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
    .reveal-all-btn { font-size: 12px; font-family: var(--font-ui); color: var(--text-secondary); background: none; border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: background 0.15s; }
    .reveal-all-btn:hover { background: var(--surface); }
    /* ---- transliteration toggle (topics shipping per-sentence translit, currently 01–03) ----
       Default ON (new visitors should see it exists); .translit-off on #sentence-list hides both
       the under-Thai line and the chips' translit. Choice remembered per device via localStorage. */
    .controls-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .translit-btn { font-size: 12px; font-family: var(--font-ui); color: var(--text-secondary); background: none; border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .translit-btn:hover { background: var(--surface); }
    .translit-btn.on { background: var(--accent-light); border-color: var(--accent); color: var(--accent); font-weight: 500; }
    .translit-btn .tl-ico { font-size: 11px; }
    .translit-btn .tl-ico .th { font-family: var(--font-thai); }
    .thai-translit { font-family: var(--font-ui); font-size: 13px; color: var(--text-tertiary); line-height: 1.55; margin-top: 1px; }
    .g-tl { color: var(--text-secondary); margin-left: 4px; }
    #sentence-list.translit-off .thai-translit, #sentence-list.translit-off .g-tl { display: none; }
    .sent-count-label { font-size: 12px; color: var(--text-tertiary); }
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
    .sent-flag-btn { width: 26px; height: 26px; border-radius: 50%; background: none; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0; transition: background 0.15s, transform 0.15s; }
    .sent-flag-btn:hover { background: var(--accent-light); }
    .sent-flag-btn svg { width: 15px; height: 15px; fill: none; stroke: var(--purple-mid); stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; opacity: 0.5; transition: fill 0.15s, stroke 0.15s, opacity 0.15s; }
    .sent-flag-btn:hover svg { opacity: 1; }
    .sent-flag-btn.flagged svg { fill: var(--accent); stroke: var(--accent); opacity: 1; }
    .sent-flag-btn.pending { opacity: 0.5; pointer-events: none; }
    .sent-flag-btn.pop { animation: sent-flag-pop 0.4s cubic-bezier(0.2,0.8,0.3,1.3); }
    @keyframes sent-flag-pop { 0% { transform: scale(1); } 45% { transform: scale(1.4); } 100% { transform: scale(1); } }
    .sent-preview { font-family: var(--font-thai); font-size: 16px; color: var(--text-primary); flex: 1; line-height: 1.4; }
    .sent-preview .ell { color: var(--text-tertiary); }
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
    .gloss-chip { background: var(--surface); border: 0.5px solid var(--border); border-radius: 20px; padding: 2px 9px; font-size: 12px; line-height: 1.5; }
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
      .reveal-all-btn { font-size: 11px; padding: 4px 10px; }
      .translit-btn { font-size: 11px; padding: 4px 10px; }
      .sentence-header { padding: 0.6rem 0.85rem; }
      .sent-preview { font-size: 15px; }
      .row-thai { font-size: 17px; }
      .reveal-row { padding: 0.5rem 0.85rem; }
      .gloss-chip { font-size: 11px; padding: 2px 7px; }
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
      .audio-toggle .toggle-btn { font-size: 11px; padding: 4px 7px; }
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
    body.premium-topic .prog-ctl-add,
    body.premium-topic .prog-ctl-add:hover:not([disabled]),
    body.premium-topic .repeat-badge { color: #3D2E00; }
    /* The eyebrow, subheading and the small player TEXT (progress count + links) use the canonical
       gold-TEXT tone #B29234 (the "Premium" index-pill colour) — readable on the pale page, distinct
       from the brighter #F0CC5C used for FILLS/graphics. The eyebrow/subtitle sit OUTSIDE the player,
       so they need explicit rules anyway. See the premium-gold-palette memory for the full standard. */
    body.premium-topic .topic-eyebrow,
    body.premium-topic .topic-subtitle,
    body.premium-topic .prog-ctl-count,
    body.premium-topic .prog-ctl-my,
    body.premium-topic .prog-ctl-join,
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
  function buildUrl(file, gated) {
    if (gated == null) gated = GATED;
    if (!gated) return Promise.resolve(AUDIO_BASE + '/' + file);
    // Owner test switch: pretend /api/audio refused. This is the ONE thing the entitlement
    // simulator can't fake on its own — the server sees the owner's real (valid) token — so it
    // is what exercises the "server disagrees with the client" fallback in dynBuildSessionFor.
    if (simDenies()) return Promise.reject({ code: 402 });
    var token = (window.ThaiEarAuth && window.ThaiEarAuth.getAccessToken)
      ? window.ThaiEarAuth.getAccessToken() : null;
    if (!token) return Promise.reject({ code: 'noauth' });
    return fetch(AUDIO_API + '?file=' + encodeURIComponent(file), {
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (r) {
      if (!r.ok) return Promise.reject({ code: r.status });
      return r.json();
    }).then(function (j) {
      if (!j || !j.url) return Promise.reject({ code: 'nourl' });
      return j.url;
    });
  }
  // ── Access gating (the "navigable preview" model) ─────────────────────────────────────────────
  // Gated topics (member/premium) are reachable by ANYONE so they can read the description + preview
  // words, but the gated INTERACTIONS — revealing a sentence, flagging, and playing (sentence or the
  // main TE/ET) — are blocked for non-entitled visitors.
  //
  // entitledForPage(): may THIS visitor use the gated interactions on this page?
  function entitledForPage() {
    if (TIER !== 'member' && TIER !== 'premium') return true;   // free topic → open
    if ((OFFLINE || WEB_DL) && isDownloaded(PREFIX)) return true; // they downloaded it → were entitled (licence flow handles lapse)
    var a = AUTHV();
    if (!a || !a.isReady) return true;                          // auth still resolving → don't wrongly gate a paying user
    if (TIER === 'member') return !!(a.getUser && a.getUser()); // member = any signed-in user
    return !!(a.isSubscribed && a.isSubscribed());              // premium = active subscription
  }
  // gate(): what a non-entitled tap does. Member → the free sign-in page (web AND app — login is not
  // payment steering). Premium → the paywall on the WEBSITE, but in the APP an informational sheet
  // instead (Google Play forbids steering to outside payment).
  function gate(tier) {
    if (tier == null) tier = TIER;
    if (tier === 'member') { window.location.href = 'join.html?feature=1&next=' + encodeURIComponent(PAGE_FILE); return; }
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
  function sentTierOf(s) { return (s && s.tier != null) ? s.tier : TIER; }
  /* Extra card classes a playlist row needs. On a topic page the whole page is one tier, so the
     gold skin is applied once to <body> (premium-topic); a playlist MIXES tiers, so the premium
     gold has to be per CARD — free/member rows stay brand purple, premium rows go gold, locked
     or not. Returned as a string because syncCard() rewrites className wholesale. */
  function sentCardClasses(s) {
    if (!PLMODE || !s) return '';
    var cls = '';
    if (sentLocked(s)) cls += ' sent-locked';
    if (sentTierOf(s) === 'premium') cls += ' sent-premium';
    return cls;
  }
  function sentLocked(s) {
    if (!PLMODE) return false;                 // topic pages gate the whole page, not per sentence
    var tier = sentTierOf(s);
    if (tier !== 'member' && tier !== 'premium') return false;
    var pfx = (s && s.prefix) ? s.prefix : PREFIX;
    // Downloaded clips stay playable while the offline licence holds — same rule as
    // entitledForPage(), so a member who downloaded then lapsed keeps their paid period.
    if ((OFFLINE || WEB_DL || DYN_WEB_DL) && pfx && isDownloaded(pfx) && canUseOffline(tier)) return false;
    var a = AUTHV();
    if (!a || !a.isReady) return false;        // auth still resolving → never lock a paying user
    if (tier === 'member') return !(a.getUser && a.getUser());
    return !(a.isSubscribed && a.isSubscribed());
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
      var stateNote = signedIn
        ? 'You’re signed in on a free account.'
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
  function syncMini() {
    var mi = $('te-mini-icon'); if (mi) mi.innerHTML = mainAudio.paused ? PLAY_TRI : PLAY_BARS;
    var mf = $('te-mini-fill');
    if (mf) mf.style.width = (mainAudio.duration ? (mainAudio.currentTime / mainAudio.duration) * 100 : 0) + '%';
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
      var mf = $('te-mini-fill'); if (mf) mf.style.width = (pct * 100) + '%';
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
        var mf2 = $('te-mini-fill'); if (mf2) mf2.style.width = (t2 / mainAudio.duration * 100) + '%';
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
        '<div class="te-mini-scrub" id="te-mini-scrub" role="slider" aria-label="Seek">' +
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
  var sentLock = false;
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
  var DYN_BUILD = 'r29i';  // visible build tag on the test pages — bump every test-space deploy
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
    window.ThaiEarDynLog = dynLog;   // the factory (player-dyn.js) logs through this when present
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
    var pf = parseFloat(o.pf); if (isFinite(pf) && pf >= 0.5 && pf <= 2) d.pf = pf;
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
  /* r26a: AUTOPLAY has to hop BEFORE the track ends. The lock-screen hop works now because the
     element is still playing when we swap, which keeps the audio session active and lets
     WebKit load the next source in the background. Waiting for 'ended' throws that away: the
     element has already stopped, the session is inactive, and the load stalls until you unlock
     — the exact failure the pause used to cause. So pre-advance a fraction before the end.
     What is skipped is the tail of the session's final 3-second gap pause, i.e. silence. */
  var DYN_PREADVANCE_S = 0.45;
  var dynPreAdvanced = false;
  var dynSessionIsLocal = true; // does dynSession belong to THIS page's sentences? (card highlight guard)
  var dynAdopted = null;      // the CHAIN entry the top player is currently on when it isn't home (null = home)
  // ── round-11: the CHAIN replaces the pairwise dynNav adopt/navigate model ──
  // cfg.dynChain = ordered units of the whole space ({page, prefix, tier, name, dynKey});
  // transport/lock-screen prev/next ONLY ever moves an index pointer and swaps audio in
  // place — never location.href. Footer links remain the way to change pages.
  var dynChain = (DYN && Array.isArray(cfg.dynChain) && cfg.dynChain.length) ? cfg.dynChain : null;
  // Deploy-skew safety net (round-12): the r11 topic-page regression was HTML still shipping
  // the old pairwise dynNav while player.js only understood dynChain — prev/next went dead.
  // A stale page now gets its chain SYNTHESIZED from dynNav so nav keeps working either way.
  if (!dynChain && DYN && cfg.dynNav && (cfg.dynNav.prev || cfg.dynNav.next)) {
    var _ownName = (document.title || 'ThaiEar')
      .replace(/^Dynamic player test\s*[—–-]\s*/i, '')
      .replace(/\s*[|·—–-]\s*ThaiEar.*$/i, '').trim() || 'This topic';
    dynChain = [];
    if (cfg.dynNav.prev) dynChain.push(cfg.dynNav.prev);
    dynChain.push({ page: PAGE_FILE, prefix: PREFIX || '', tier: TIER || 'free', name: _ownName, dynKey: cfg.dynKey || '__self__' });
    if (cfg.dynNav.next) dynChain.push(cfg.dynNav.next);
  }
  var dynHomeIdx = 0;
  if (dynChain) {
    for (var _ci = 0; _ci < dynChain.length; _ci++) {
      if (dynChain[_ci] && (dynChain[_ci].dynKey === cfg.dynKey || dynChain[_ci].dynKey === '__self__')) { dynHomeIdx = _ci; break; }
    }
  }
  var dynChainIdx = dynHomeIdx;        // pointer = the unit the top player is CURRENTLY on
  var dynChainWrap = cfg.dynChainWrap === true;   // playlists: circular; topic test pages: clamp
  var dynTitle = (dynChain && dynChain[dynHomeIdx]) ? dynChain[dynHomeIdx].name : null;   // lock-screen title = the unit actually playing
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
    if (PLMODE) return sentences.filter(function (s) { return !sentLocked(s); });
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
    var tier = (s.tier != null) ? s.tier : TIER;
    var gated = (s.tier != null) ? (s.tier === 'member' || s.tier === 'premium') : GATED;
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
  function dynClipUrl(ref) {
    var entitled = canUseOffline(ref.tier);
    if (OFFLINE && isDownloaded(ref.prefix) && entitled) {
      return localBlobUrl(ref.prefix, ref.file)
        .then(function (u) { return u ? { url: u, temp: true } : buildUrl(ref.file, ref.gated).then(function (r) { return { url: r, temp: false }; }); });
    }
    if (DYN_WEB_DL && isDownloaded(ref.prefix) && entitled) {
      return cachedBlobUrl(ref.prefix, ref.file)
        .then(function (u) { return u ? { url: u, temp: true } : buildUrl(ref.file, ref.gated).then(function (r) { return { url: r, temp: false }; }); });
    }
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
    if (dynClipCache[file]) return Promise.resolve(dynClipCache[file]);
    return dynClipUrl(ref).then(function (u) {
      if (u.temp) temp = u.url;
      return fetch(u.url);
    }).then(function (r) {
      if (!r.ok) return Promise.reject({ code: r.status });
      return r.arrayBuffer();
    }).then(function (ab) {
      if (temp) { try { URL.revokeObjectURL(temp); } catch (_) {} temp = null; }
      return new Promise(function (res, rej) {
        var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        var ctx = new OAC(1, 1, DYN_SR);
        ctx.decodeAudioData(ab, res, rej);
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
  function dynBuildSessionFor(inc, keyNs, key, onProg, st) {
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
    var denied = {}, lastGate = null;
    function isGateCode(c) { return c === 401 || c === 402 || c === 403 || c === 'noauth' || c === 'licence'; }
    return dynPool(files, function (f) {
      return dynFetchClip(f).then(function (b) { done++; if (onProg) onProg(done, files.length); return b; })
        .catch(function (e) {
          if (!isGateCode(e && e.code)) throw e;
          denied[f.prefix + '|' + f.file.replace(/_(TH|EN)\.mp3$/, '')] = true;
          lastGate = e;
          done++; if (onProg) onProg(done, files.length);
          return null;
        });
    }).then(function () {
      if (lastGate) {
        var kept = inc.filter(function (s) {
          var r = dynClipRef(s, 'TH');
          return !denied[r.prefix + '|' + r.file.replace(/_(TH|EN)\.mp3$/, '')];
        });
        if (!kept.length) return Promise.reject(lastGate);   // nothing playable → gate as before
        if (kept.length !== inc.length) {
          dynLog('build: ' + (inc.length - kept.length) + ' sentence(s) denied — stitching ' + kept.length);
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
        var syl = dynSyllables(s.thai);
        var repeat = Math.max(3.0, syl * 0.5) * st.pf;
        var recall = Math.max(4.5, syl * 0.7) * st.pf;
        var gap = 3.0 * st.pf;
        var start = pos / DYN_SR;
        var r;
        if (mode === 'et') {
          pushBuf(en); pushSil(recall); pushBuf(th);
          for (r = 1; r < st.rp; r++) { pushSil(repeat); pushBuf(th); }
        } else {
          // TE: English lands after the ep-th Thai repeat (round-15 item 4); ep === repeats
          // reproduces the original TH…TH,EN order exactly.
          var ep = st.en ? stEp : 0;
          pushBuf(th);
          if (ep === 1) { pushSil(repeat); pushBuf(en); }
          for (r = 1; r < st.rp; r++) {
            pushSil(repeat); pushBuf(th);
            if (ep === r + 1) { pushSil(repeat); pushBuf(en); }
          }
        }
        pushSil(gap);
        map.push({ num: s.num, start: start, end: pos / DYN_SR });
      });
      var out = new Float32Array(pos);   // silence = the zero-filled default
      var o = 0;
      parts.forEach(function (p) {
        if (typeof p === 'number') { o += p; }
        else { out.set(p.getChannelData(0), o); o += p.length; }
      });
      var duration = pos / DYN_SR;
      tStitch = Date.now() - tFetch0 - tFetch;
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
    return dynEnsureSession(function (done, total) {
      var c = $('dyn-status-count'); if (c) c.textContent = done + '/' + total;
    }, lenient).then(function (sess) {
      mainAudio.src = (NATIVE && sess.fileUri) ? sess.fileUri : sess.url;
      mainAudio.load();
      mainSrcReady = true;
      dynPreAdvanced = false;
      dynPosStale = false;      // new timeline in place; positions may be tracked again
      dynStatus(null);
    }).catch(function (e) {
      var code = e && e.code;
      if (code === 'noauth' || code === 401 || code === 403) {
        dynStatus('Sign in to play this topic', false);
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
  function dynInvalidate() {
    var key = dynKey();
    // Round-12 item 1: if the change lands back ON the built session's key (a revert, or a
    // no-effect toggle like English in ET), nothing is stale — keep playing, clear any nag.
    if (dynSession && dynSessionIsLocal && dynSession.key === key) {
      dynStatus(null);
      return;
    }
    var meta = dynReadMeta(DYN_KEY_NS, currentMode);
    var revertHit = !!(meta && meta.key === key);   // persisted copy matches → strict restore hits on next play
    if (!mainAudio.paused) { mainAudio.pause(); setMainIcon(false); }
    dynLastPos = 0;   // the rebuilt session has a different timeline
    dynPosStale = true;   // and no late pause/timeupdate may resurrect the old one
    dynAttached = false;
    mainSrcReady = false;
    if (dynSession && dynSession.url && dynSessionIsLocal) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
    dynSession = null;
    dynSyncSentBtns();   // no map until the rebuild → ① buttons grey out
    if (revertHit) dynStatus(null);
    else dynStatus('Changes saved — your session will reconstruct on next play.', false);
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
    a.dynPrefs.load().then(function (map) {
      if (!map) return;
      var exclChanged = false;
      var before = JSON.stringify(dynCurrentSet());
      // r16: mirror the account copy into the local stores, then RE-RESOLVE — the winner
      // between a unit override and the global default is decided by ts, not by arrival order.
      // A pre-r16 'global' row is flat {pf,rp,en,ep} with no v: deliberately ignored, so every
      // unit starts from the classic default instead of inheriting the old player-global set.
      var g = map.global;
      if (g && g.v === 2) {
        ['te', 'et'].forEach(function (m) { if (g[m]) dynWriteJson(dynGdefKey(m), g[m]); });
      }
      var u = map[DYN_KEY_NS];
      if (u) {
        ['te', 'et'].forEach(function (m) { if (u[m]) dynWriteJson(dynSetKey(DYN_KEY_NS, m), u[m]); });
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
      'time you generate a new dynamic mp3.',
    reps: 'This decides how many times a Thai sentence is spoken.',
    engpos: 'This decides where the English sentence is spoken. In the last position, the English ' +
      'is heard after all the Thai repeats of a sentence. But English can also be positioned ' +
      'between Thai sentences, which can help with comprehension when first getting to know a ' +
      'topic. To hear English spoken first, before any Thai, switch to the English first mode at ' +
      'the top of the dynamic mp3 player.'
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
    t.textContent = DYN_INFO[key];
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
  /* Collapse the SEO intro to two lines with a Read more. The paragraph is only WRAPPED and
     height-clamped — the text is never removed or display:none'd, so it stays fully indexable. */
  function dynCollapseIntro() {
    var p = document.querySelector('.topic-intro');
    if (!p || (p.parentNode && p.parentNode.className === 'te-intro-wrap')) return;
    var w = document.createElement('div');
    w.className = 'te-intro-wrap';
    p.parentNode.insertBefore(w, p);
    w.appendChild(p);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'te-intro-more';
    b.textContent = 'Read more';
    w.appendChild(b);
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
        dynInvalidate();
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
  // Round-8: snap an in-page scrub commit to the nearest sentence-block start, so a seek
  // never lands mid-pause. (Lock-screen drag scrubbing is APK v4 native work.)
  function dynSnapTime(t) {
    var map = dynSession && dynSession.map;
    if (!map || !map.length) return t;
    var best = t, bd = Infinity;
    for (var i = 0; i < map.length; i++) {
      var d = Math.abs(map[i].start - t);
      if (d < bd) { bd = d; best = map[i].start; }
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
    var mf = $('te-mini-fill'); if (mf) mf.style.width = pct + '%';
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
    var t = mainAudio.currentTime || 0, map = dynSession.map, i;
    for (i = 0; i < map.length; i++) { if (t < map[i].end) break; }
    if (i >= map.length) i = map.length - 1;
    var target = null;
    if (dir > 0) {
      if (i + 1 < map.length) target = map[i + 1].start;
    } else if (t - map[i].start < 1.5 && i > 0) {
      target = map[i - 1].start;
    } else {
      target = map[i].start;
    }
    if (target == null) return;
    mainAudio.currentTime = target;
    dynPaintPos();
  }
  // Highlight the card whose block is playing (called from the timeupdate handler when DYN).
  function dynHighlight(t) {
    var map = dynSession.map, num = null;
    for (var i = 0; i < map.length; i++) { if (t < map[i].end) { num = map[i].num; break; } }
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
    var mode = currentMode;
    var c = dynAdoptCache[t.page];
    if (c && c.mode === mode) {   // fully pre-resolved (session or placeholder) → synchronous resolve
      if (c.sess) { dynLog('adopt: cached session'); return Promise.resolve({ src: (NATIVE && c.sess.fileUri) ? c.sess.fileUri : c.sess.url, std: false, sess: c.sess }); }
      if (c.src) { dynLog('adopt: cached placeholder'); return Promise.resolve({ src: c.src, std: true, sess: null }); }
    }
    var meta = t.dynKey ? dynReadMeta(t.dynKey, mode) : null;   // synchronous pre-check (stale-lenient by design)
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
      txt.innerHTML = '<a class="dyn-np-link" href="' + escapeHtml(t.page) + '">Now playing: <strong>' + escapeHtml(t.name) + '</strong></a>' +
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
    mainPage = PAGE_HREF; mainPrefix = PREFIX; mainGated = GATED; mainTier = TIER;
    currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
    mainSrcReady = false;
    var rf = $('scrubber-fill'); if (rf) rf.style.width = '0%';
    var rc = $('time-cur'); if (rc) rc.textContent = '0:00';
    var rnp = $('now-playing'); if (rnp) rnp.classList.remove('show');
    // Lenient (round-10 item 3): play the latest LOCAL persisted session even if its key is
    // stale — reconstruction only happens on a real foreground play press.
    ensureMainSrc(true).then(function () { if (!dynAdopted) return mainAudio.play(); })
      .then(function () { dynLog('return-local play ok'); if (!dynAdopted) { setMainIcon(true); dynPrefetchNeighbours(); } })
      .catch(function (e) { dynLog('return-local FAIL ' + ((e && (e.name || e.code)) || e)); handleDenied(e, mainTier); });
  }
  // SYNCHRONOUS half of adoption — mirrors classic advanceTopic's sync identity swap.
  function dynApplyAdoptState(t) {
    if (dynSession && dynSession.url && dynSessionIsLocal) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
    dynLastPos = 0;                 // new track — resume guard must not drag the old position over
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
      if (dynAdopted === t) { setMainIcon(true); setupMediaSession(); dynPrefetchNeighbours(); }
    }).catch(function (e) {
      dynLog('adopt FAIL ' + ((e && (e.name || e.code)) || '') + ' ' + ((e && e.message) || ''));
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
  function dynItemPayload(num) {
    var s = dynSentByNum(num);
    if (!s) return null;
    return { topic_key: dynTopicKey(), num: num, prefix: PREFIX, tier: TIER || 'free',
      thai: s.thai, translit: s.translit || null, english: s.english };
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
    var a = AUTHV();
    // Playlists are a signed-in feature (they live in the account dropdown alongside My Progress
    // and My Sentences). Signed out → the standard member sign-in route, not a raw alert().
    // gate('member') goes to join.html on web AND in the app — login is not payment steering.
    if (!a || !(a.getUser && a.getUser())) { gate('member'); return; }
    var PL = a.playlists;
    if (!PL || !PL.load) { alert('Playlists unavailable'); return; }
    PL.load().then(function (lists) { dynShowChooser(lists || []); })
      .catch(function (e) { alert('Couldn’t load playlists: ' + ((e && (e.message || e.code)) || 'unknown error')); });
  }
  // Playlist chooser (reuses the dyn-pl-* popup styling from player-dyn.css, linked on dyn pages).
  function dynShowChooser(lists) {
    var old = document.getElementById('dyn-pl-pop'); if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'dyn-pl-pop';
    var rows = lists.length
      ? lists.map(function (p, i) {
          return '<button type="button" class="dyn-pl-row" data-i="' + i + '">' +
            '<span class="dyn-pl-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="dyn-pl-count">' + ((p.items && p.items.length) || 0) + '</span></button>';
        }).join('')
      : '<div class="dyn-pl-empty">No playlists yet — create one in <a href="playlists.html">My Playlists</a> first.</div>';
    wrap.innerHTML = '<div class="dyn-pl-card"><div class="dyn-pl-head">' +
        (lists.length ? 'Add sentences to…' : 'Playlists') + '</div>' +
      '<div class="dyn-pl-body">' + rows + '</div>' +
      '<div class="dyn-pl-foot"><button type="button" class="dyn-pl-done">' + (lists.length ? 'Cancel' : 'OK') + '</button></div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('.dyn-pl-done').addEventListener('click', function () { wrap.remove(); });
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
    var real = {}, k;
    (p.items || []).forEach(function (it) { if (it.topic_key === tk) real[it.num] = true; });
    // pre-ticks = the playlist's real items for this topic, adjusted by any pending diffs
    var pre = {};
    for (k in real) pre[k] = true;
    if (pend) {
      (pend.adds[tk] || []).forEach(function (it) { pre[it.num] = true; });
      (pend.removes[tk] || []).forEach(function (num) { delete pre[num]; });
    }
    var now = {};
    for (k in pre) now[k] = true;
    dynSel = { id: p.id, name: p.name || (pend && pend.name) || '', pre: pre, real: real, now: now, plsel: !!pend, pend: pend || null };
    var list = $('sentence-list');
    if (list) {
      list.classList.add('dyn-selecting');
      dynSelListener = function (e) {
        var el = e.target;
        if (!el || !el.closest) return;
        // ticking happens ONLY on the tick circle itself
        var tick = el.closest('.dyn-tick');
        if (tick) {
          e.preventDefault(); e.stopPropagation();
          var card = tick.closest('.sentence-card');
          if (card) dynSelToggle(card, tick);
          return;
        }
        // flag + exclude are disabled during selection (also dimmed via CSS)
        if (el.closest('.sent-flag-btn') || el.closest('.dyn-card-btn')) { e.preventDefault(); e.stopPropagation(); return; }
        // everything else — reveal-cycle, sentence play, tortoise — behaves normally
      };
      list.addEventListener('click', dynSelListener, true);
    }
    // Round-7: cards open FULLY REVEALED (st-3) while selecting; previous stages restored on exit.
    dynSelPrevStates = {};
    sentences.forEach(function (s) {
      dynSelPrevStates[s.num] = states[s.num] || 0;
      states[s.num] = 3;
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
    for (k in dynSel.real) { if (!dynSel.now[k]) removes.push(+k); }
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
      if (!(a.getUser && a.getUser())) { alert('Sign in to use playlists.'); dynPendClear(); location.href = 'playlists.html'; return; }
      var PL = a.playlists;
      if (!PL || !PL.load) { alert('Playlists unavailable'); return; }
      PL.load().then(function (lists) {
        var p = null;
        (lists || []).forEach(function (x) { if (String(x.id) === String(dynPlsel.id)) p = x; });
        if (!p) { alert('Playlist not found.'); dynPendClear(); location.href = 'playlists.html'; return; }
        var pend = dynPendRead();
        if (!pend || String(pend.id) !== String(p.id)) {
          // First page of the flow: baseline the running total on the playlist's current size.
          pend = { id: p.id, name: p.name || dynPlsel.name, adds: {}, removes: {}, base: (p.items || []).length };
          dynPendWrite(pend);
        }
        dynEnterSelect(p, pend);
      }).catch(function () { alert('Couldn’t load playlists — check your connection.'); });
    })();
  }
  function dynSelDone() {
    if (!dynSel) return;
    var a = window.ThaiEarAuth, PL = a && a.playlists;
    if (!PL) { alert('Playlists unavailable'); return; }
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
          pend.removes[tk2].forEach(function (num) { ops.push({ rmTk: tk2, rmNum: num }); });
        })(k);
      }
    } else {
      var tk = dynTopicKey();
      for (k in dynSel.now) { if (!dynSel.real[k]) { var pl = dynItemPayload(+k); if (pl) ops.push({ add: pl }); } }
      for (k in dynSel.real) { if (!dynSel.now[k]) ops.push({ rmTk: tk, rmNum: +k }); }
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
      dynStatus('“' + name + '” updated — ' + addsN + ' selected, ' + remsN + ' removed', false);
      var seq = dynStatusSeq;
      setTimeout(function () { if (seq === dynStatusSeq) dynStatus(null); }, 2500);
    }).catch(function (e) {
      btns.forEach(function (b) { b.disabled = false; });   // stay in select mode so nothing chosen is lost
      dynSelCountPaint();
      alert('Couldn’t save: ' + ((e && (e.message || e.code)) || 'unknown error'));
    });
  }
  var DYN_STYLES =
    '.dyn-status{text-align:center;font-size:13px;font-weight:500;color:var(--accent);padding:4px 0;}' +
    '.dyn-dots{display:inline-block;width:1.1em;text-align:left}' +
    ".dyn-dots::after{content:'...';display:inline-block;width:0;overflow:hidden;vertical-align:bottom;animation:dyn-dots 1.2s steps(3,start) infinite}" +
    '@keyframes dyn-dots{from{width:0}to{width:1.05em}}' +
    '.dyn-sent-btn{width:34px;height:34px}' +
    '.dyn-sent-off{opacity:.35;pointer-events:none}' +
    /* owner 2026-07-27: the ±10 buttons are clutter in dyn mode (sentence skip covers it) */
    '.audio-row button[onclick="skip(-10)"],.audio-row button[onclick="skip(10)"]{display:none}' +
    /* owner 2026-07-27: emphasis swap — the playback scrubber gets BIG, the pauses slider small */
    '.scrubber{height:8px;border-radius:4px}' +
    '.scrubber-fill{border-radius:4px}' +
    '.scrubber-fill::after{width:18px;height:18px;right:-9px}' +
    '.dyn-slider{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 8px;font-size:11.5px;color:var(--text-tertiary);margin-top:8px}' +
    '.dyn-ctl-group{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}' +
    '.dyn-slider input[type=range]{width:90px;accent-color:var(--accent);height:3px}' +
    '.dyn-ctl-sep{color:var(--border-strong)}' +
    '.dyn-reps{display:inline-flex;gap:3px}' +
    '.dyn-rep-btn{width:20px;height:20px;border-radius:5px;border:.5px solid var(--border-strong);background:var(--surface);color:var(--text-tertiary);font:600 10.5px var(--font-ui);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}' +
    '.dyn-rep-btn.on{background:var(--accent);border-color:var(--accent);color:#fff}' +
    '.dyn-en-lbl{display:inline-flex;align-items:center;gap:4px;cursor:pointer}' +
    '.dyn-en-lbl input{accent-color:var(--accent);margin:0;width:13px;height:13px}' +
    /* round-15 item 4: English-position line (|thai ☐ thai ☐| radio boxes) */
    '.dyn-ep-row{margin-top:2px}' +
    '.dyn-ep-boxes{display:inline-flex;align-items:center;gap:4px}' +
    '.dyn-ep-th{font-size:10.5px;color:var(--text-tertiary);font-style:italic}' +
    '.dyn-ep-box{width:16px;height:16px;border-radius:4px;border:.5px solid var(--border-strong);background:var(--surface);cursor:pointer;padding:0;position:relative}' +
    '.dyn-ep-box.on{background:var(--accent);border-color:var(--accent)}' +
    ".dyn-ep-box.on::after{content:'';position:absolute;left:5px;top:2px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}" +
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
    'body.te-v2 .te-intro-wrap{position:relative;margin-bottom:1.1rem}' +
    'body.te-v2 .te-intro-wrap .topic-intro{overflow:hidden;margin-bottom:0}' +
    'body.te-v2 .te-intro-wrap:not(.open) .topic-intro{max-height:3.3em}' +
    "body.te-v2 .te-intro-wrap:not(.open)::after{content:'';position:absolute;left:0;right:0;bottom:1.85em;height:2.1em;background:linear-gradient(to bottom,rgba(250,250,248,0),var(--bg));pointer-events:none}" +
    'body.te-v2 .te-intro-more{margin-top:3px;font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--accent);background:none;border:0;padding:2px 0;cursor:pointer}' +
    'body.te-v2 .te-intro-more:hover{text-decoration:underline}' +
    /* settings disclosure */
    'body.te-v2 .dyn-set-wrap{margin-top:2px}' +
    'body.te-v2 .dyn-set-wrap summary{list-style:none;cursor:pointer;font-family:var(--font-ui);font-size:12.5px;font-weight:500;color:var(--text-secondary);padding:9px 0 0;display:flex;align-items:center;gap:6px}' +
    'body.te-v2 .dyn-set-wrap summary::-webkit-details-marker{display:none}' +
    "body.te-v2 .dyn-set-wrap summary::after{content:'⌄';font-size:14px;transition:transform .18s}" +
    'body.te-v2 .dyn-set-wrap[open] summary::after{transform:rotate(180deg)}' +
    'body.te-v2 .dyn-set-wrap .dyn-slider{margin-top:9px}' +
    /* playlist row */
    'body.te-v2 .te-pl-row{display:flex;gap:9px;margin:14px 0 16px}' +
    'body.te-v2 .te-pl-row .dyn-addpl,body.te-v2 .te-pl-row .dyn-pl-link{flex:1;margin:0;display:flex;align-items:center;justify-content:center;gap:7px;font-family:var(--font-ui);font-size:13.5px;font-weight:500;color:var(--accent);background:var(--surface);border:.5px solid var(--border-strong);border-radius:var(--radius-md);padding:11px 10px;text-decoration:none;text-align:center;cursor:pointer}' +
    'body.te-v2 .te-pl-row .dyn-addpl:hover,body.te-v2 .te-pl-row .dyn-pl-link:hover{background:var(--accent-light);color:var(--accent)}' +
    /* per-sentence: tools to the right, reveal ornament gone */
    'body.te-v2 .sentence-header{display:flex;align-items:center;gap:8px}' +
    'body.te-v2 .prog-wrap{display:none}' +
    'body.te-v2 .dyn-tick{order:0}' +
    'body.te-v2 .sent-num{order:1}' +
    'body.te-v2 .dyn-eq{order:2}' +
    'body.te-v2 .sent-play-btn{order:3}' +
    'body.te-v2 .sent-preview{order:4;flex:1;min-width:0}' +
    'body.te-v2 .speed-toggle{order:5}' +
    'body.te-v2 .sent-flag-btn{order:6}' +
    'body.te-v2 .dyn-x-btn{order:7}' +
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
    /* r16a: the ⓘ explainer labels + their dismissible box */
    '.dyn-info-lbl{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;text-align:left}' +
    '.dyn-info-lbl:hover{color:var(--accent)}' +
    '.dyn-info-i{width:13px;height:13px;border-radius:50%;border:1px solid currentColor;display:inline-flex;align-items:center;justify-content:center;font:italic 700 9px/1 Georgia,"Times New Roman",serif;flex-shrink:0}' +
    '.dyn-info-box{position:relative;margin:7px 0 2px;padding:9px 30px 9px 11px;border:.5px solid var(--border-strong);border-radius:var(--radius-md);background:var(--surface);color:var(--text-secondary);font-size:12px;line-height:1.55;max-width:520px}' +
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
    '.sentence-card.dyn-off{opacity:.55;border-style:dashed}' +
    '.sentence-card.dyn-off .sent-preview{text-decoration:line-through}' +
    '.dyn-card-btn{width:26px;height:26px;border-radius:50%;border:.5px solid var(--border-strong);background:var(--surface);color:var(--text-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}' +
    '.dyn-card-btn svg{width:13px;height:13px}' +
    '.dyn-card-btn:hover{color:var(--accent);border-color:var(--accent)}' +
    '.sentence-card.dyn-live{border-color:var(--accent);}' +
    /* owner 2026-07-27: quiet card look (was a solid accent pill — garish next to its neighbours) */
    '.dyn-addpl{display:block;margin:10px auto 0;font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--accent);background:var(--surface);border:.5px solid var(--border-strong);border-radius:var(--radius-md);padding:7px 14px;cursor:pointer}' +
    '.dyn-addpl:hover{background:var(--accent-light)}' +
    '.dyn-pl-link{display:block;text-align:center;font-size:12px;margin:6px 0 14px;color:var(--text-tertiary);text-decoration:none}' +
    '.dyn-pl-link:hover{color:var(--accent)}' +
    '.dyn-tick{display:none;width:20px;height:20px;border-radius:50%;border:1.5px solid var(--border-strong);flex-shrink:0;margin-right:2px;position:relative;cursor:pointer}' +
    ".dyn-tick::before{content:'';position:absolute;inset:-7px}" +   /* ~34px tap target */
    '#sentence-list.dyn-selecting .dyn-tick{display:inline-block}' +
    /* select mode: flag + exclude are out of play (the capture listener also swallows them) */
    '#sentence-list.dyn-selecting .sent-flag-btn,#sentence-list.dyn-selecting .dyn-card-btn{opacity:.35;pointer-events:none}' +
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
    'body.dyn-plmode .progress-controls{display:none}' +
    'body.dyn-plmode .sent-flag-btn{display:none}' +
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
      sl.innerHTML = '<span class="dyn-ctl-group">Pauses <input id="dyn-pf" type="range" min="0.5" max="2" step="0.25"> <span id="dyn-pf-val">1×</span></span>' +
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
        dynInvalidate();
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
          dynInvalidate();
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
        dynInvalidate();
        dynEpRender();
      });
      // English-position line (round-15 item 4) — its own non-wrapping group under the row.
      var epRow = document.createElement('div');
      epRow.className = 'dyn-slider dyn-ep-row';
      epRow.id = 'dyn-ep-row';
      epRow.innerHTML = '<span class="dyn-ctl-group">' + dynInfoLabel('English position', 'engpos') +
        ' <span class="dyn-ep-boxes" id="dyn-ep-boxes"></span></span>';
      sl.parentNode.insertBefore(epRow, sl.nextSibling);
      // Both ⓘ labels share one handler; the box lands under whichever row was tapped.
      var infoRow = { reps: sl, engpos: epRow };
      [sl, epRow].forEach(function (r) {
        var lbl = r.querySelector('.dyn-info-lbl');
        if (!lbl) return;
        lbl.addEventListener('click', function () {
          var k = lbl.getAttribute('data-info');
          dynInfoToggle(k, infoRow[k]);
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
      pll.className = 'dyn-pl-link'; pll.href = 'playlists.html';
      // The build tag already shows in the corner of the settings block, so the link does not
      // need to carry it once these are proper side-by-side buttons.
      pll.textContent = STYLE2 ? '🎵 My playlists' : ('🎵 My Playlists · build ' + DYN_BUILD);
      // Same gate as Add-to-playlist: a signed-out visitor gets the sign-in page, not a
      // playlists page that can only tell them it's empty.
      pll.addEventListener('click', function (e) {
        var au = AUTHV();
        if (!au || !(au.getUser && au.getUser())) { e.preventDefault(); gate('member'); }
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
    sentences.forEach(function (s) {
      // Locked playlist rows are padlocks, not players — no select tick, no equalizer, no ①
      // skip button. Their header carries the gate handler and nothing else.
      if (sentLocked(s)) return;
      var hdr = document.querySelector('#sc-' + s.num + ' .sentence-header');
      if (!hdr) return;
      var flag = hdr.querySelector('.sent-flag-btn');
      // Select-mode tick (batch add-to-playlist): hidden until #sentence-list gets .dyn-selecting.
      var tick = document.createElement('span');
      tick.className = 'dyn-tick' + (TIER === 'premium' ? ' gold' : '');
      tick.setAttribute('aria-hidden', 'true');
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
          dynExcluded[s.num] = !dynExcluded[s.num];
          dynSaveExcluded();
          var card = document.getElementById('sc-' + s.num);
          if (card) card.classList.toggle('dyn-off', !!dynExcluded[s.num]);
          xPaint();
          dynInvalidate();
          dynPrefsQueue('excl');
        });
        hdr.insertBefore(xb, flag ? flag.nextSibling : null);
        if (dynExcluded[s.num]) {
          var card0 = document.getElementById('sc-' + s.num);
          if (card0) card0.classList.add('dyn-off');
        }
      }
    });
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
  var currentMode = (NATIVE ? (function () { try { return localStorage.getItem('thaiear_dir') === 'et' ? 'et' : 'te'; } catch (_) { return 'te'; } })() : 'te');
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

  var mainAudio = NA ? makeNativeAudio() : new Audio();
  mainAudio.preload = 'metadata';
  // Free: set the public src now so duration shows before play. Premium: defer until first
  // play (we need the session token, and we don't want to burn a signed URL on page load).
  // Free + web: set the public src now so duration shows. In the app, defer to ensureMainSrc so a
  // downloaded local copy can be used (offline-aware).
  if (!DYN && !mainGated && !OFFLINE && !(WEB_DL && isDownloaded(mainPrefix))) { mainAudio.src = AUDIO_BASE + '/' + currentMainFile; mainSrcReady = true; }

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
    var t = $('time-total'); if (t) t.textContent = formatTime(mainAudio.duration);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && mainAudio.duration && isFinite(mainAudio.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: mainAudio.duration, playbackRate: 1, position: 0 }); } catch (_) {}
    }
  });
  mainAudio.addEventListener('timeupdate', function () {
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
    var mf = $('te-mini-fill'); if (mf) mf.style.width = pct + '%';   // mirror onto the floating mini bar
    if (DYN && !dynPosStale && (mainAudio.currentTime || 0) > 0) dynLastPos = mainAudio.currentTime;   // remember position (resume guard)
    /* The guard has to be tight. While a new source loads, iOS can report a transient or tiny
       duration — so a loose "near the end" test fires the instant after a MANUAL hop and skids
       straight on to the next unit, which reads as prev/next being broken. A real session runs
       minutes, so require a substantial duration AND genuinely being in its last stretch. */
    if (DYN && autoplayOn && !repeatOn && !dynPreAdvanced && !mainAudio.paused &&
        mainAudio.duration && isFinite(mainAudio.duration) && mainAudio.duration > 20 &&
        (mainAudio.currentTime || 0) > mainAudio.duration * 0.9 &&
        (mainAudio.duration - mainAudio.currentTime) <= DYN_PREADVANCE_S) {
      dynPreAdvanced = true;   // once per track; cleared whenever a new source is set
      dynLog('AUTO pre-advance at ' + mainAudio.currentTime.toFixed(1) + '/' + mainAudio.duration.toFixed(1));
      advanceTopic(1);
    }
    if (DYN && dynSession && dynSessionIsLocal) dynHighlight(mainAudio.currentTime);   // dyn: highlight the playing card (this page's session only)
    writeWebResume();   // keep the cross-page resume position fresh while playing (web only, throttled)
  });
  mainAudio.addEventListener('ended', function () {
    if (DYN) dynLastPos = 0;   // track finished — a later play starts over, not at the end
    setMainIcon(false);
    // repeat-one wins over autoplay: loop the current topic.
    if (repeatOn) {
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
    if (mainAudio.paused) {
      if (!entitledForPage()) { gate(mainTier); return; }   // gated topic + not entitled → no playback
      userStartedHere = true;   // this page's player is now user-driven → sync must not adopt a stale label
      ensureMainSrc().then(function () {
        // Round-10 item 4: a long pause can idle the engine and drop the position to 0 —
        // restore the last known position before resuming (and again after a native
        // prepare-resume, which always starts a fresh prepare at 0).
        var want = (DYN && !dynPosStale && dynLastPos > 0.5 && (mainAudio.currentTime || 0) < 0.5 &&
          (!mainAudio.duration || !isFinite(mainAudio.duration) || dynLastPos < mainAudio.duration - 0.5)) ? dynLastPos : null;
        if (want != null) { try { mainAudio.currentTime = want; } catch (_) {} }
        var pp = mainAudio.play();
        if (want != null && pp && pp.then) {
          pp.then(function () {
            if ((mainAudio.currentTime || 0) < 0.5) { try { mainAudio.currentTime = want; } catch (_) {} }
          }).catch(function () {});
        }
        setMainIcon(true); setupMediaSession();
      }).catch(function (e) { handleDenied(e, mainTier); });
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
    if (NATIVE) { try { localStorage.setItem('thaiear_dir', mode); } catch (_) {} }
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
    if (DYN) { dynLastPos = 0; dynAttached = false; dynLoadSettings(); dynPrefsRepaintControls(); dynSyncEnToggle(); dynPrefetchNeighbours(); }
    applyDirClass();                      // flip the accordion reveal order to match the new direction
    if (wasPlaying) ensureMainSrc().then(function () { mainAudio.play(); setMainIcon(true); }).catch(function (e) { handleDenied(e, mainTier); });
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
        if (fg || dynChainPlayable(stp.t, stp.idx)) { hop = stp; break; }
        dynLog('chain skip ' + (stp.t.dynKey || stp.t.prefix) + ' (locked, nothing playable)');
      }
      dynLog('advanceTopic dir=' + dir + (hop ? ' → ' + (hop.t.dynKey || hop.t.prefix) : ' (nothing playable)'));
      if (!hop) return;
      dynChainIdx = hop.idx;
      if (hop.idx === dynHomeIdx) { dynReturnLocal(); return; }
      dynAdvance(hop.t, fromIdx);
      return;
    }
    var T = window.ThaiEarTopics;
    if (!T || !T.nextAccessible) return;            // topics.js not present → feature inert
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
      var href = escapeHtml(unit.page || '');
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
        mnp.setAttribute('href', unit.page || '#');
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
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
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
  function toggleAutoplay() {
    autoplayOn = !autoplayOn; prefSet('thaiear_autoplay', autoplayOn);
    var b = $('btn-autoplay');
    if (b) { b.classList.toggle('active', autoplayOn); b.setAttribute('aria-pressed', autoplayOn ? 'true' : 'false'); }
  }
  function toggleRepeat() {
    repeatOn = !repeatOn; prefSet('thaiear_repeat', repeatOn);
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
    if (sentPlaying !== null) { updateSentBtn(sentPlaying, false); sentPlaying = null; }
    maybeResumeMain();
  }

  var sentResetTimer = null;

  function initSentAudio() {
    var el = $('sent-audio-el');
    if (!el) return;
    el.addEventListener('ended', resetSentBtn);
    el.addEventListener('error', resetSentBtn);
    el.addEventListener('pause', function () { if (el.duration && el.currentTime >= el.duration - 0.3) resetSentBtn(); });
    el.addEventListener('timeupdate', function () { if (el.duration && el.currentTime > 0 && el.currentTime >= el.duration - 0.15) resetSentBtn(); });
  }

  function toggleSentPlay(e, num) {
    e.stopPropagation();
    e.preventDefault();
    if (!entitledForPage()) { gate(); return; }   // gated topic + not entitled → no sentence audio
    if (gateSent(num)) return;                    // playlist: locked sentence → its own tier's gate
    if (sentLock) return;
    sentLock = true;
    setTimeout(function () { sentLock = false; }, 300);
    var sa = getSentAudio();

    // tapping the playing sentence again stops it
    if (sentPlaying === num) {
      sa.pause(); sa.src = ''; revokeSentBlob(); sentPlaying = null; updateSentBtn(num, false);
      maybeResumeMain();
      return;
    }
    // stop any other sentence (top player stays paused — don't resume between clips)
    if (sentPlaying !== null) { sa.pause(); updateSentBtn(sentPlaying, false); sentPlaying = null; }

    // If the top player is going, pause it — but DON'T auto-resume when the clip ends. The user
    // restarts the main track themselves in their own time. (Was: resumeMainAfter = true, which
    // resumed the top player once the sentence finished.)
    if (!mainAudio.paused) { mainAudio.pause(); setMainIcon(false); }

    // Playlist sentences carry their own prefix/tier/clipNum (a playlist mixes topics);
    // topic pages resolve exactly as before (sObj fields absent → PREFIX/GATED defaults).
    var sObj = null;
    for (var si = 0; si < sentences.length; si++) { if (sentences[si].num === num) { sObj = sentences[si]; break; } }
    var clipN = (sObj && sObj.clipNum != null) ? sObj.clipNum : num;
    var sid = String(clipN).padStart(2, '0');
    var file = ((sObj && sObj.prefix) ? sObj.prefix : PREFIX) + '_S' + sid + '_TH.mp3';
    var sentGated = (sObj && sObj.tier != null) ? (sObj.tier === 'member' || sObj.tier === 'premium') : undefined;
    sentPlaying = num;
    updateSentBtn(num, true);
    if (sentResetTimer) { clearTimeout(sentResetTimer); sentResetTimer = null; }
    // Resolve the src: local copy if downloaded, else free CDN / signed-URL fetch. Then play.
    sentSrcFor(file, sentGated).then(function (u) {
      // user stopped/switched while the URL was resolving → drop the freshly-made blob to avoid a leak
      if (sentPlaying !== num) { if (u && u.indexOf('blob:') === 0) { try { URL.revokeObjectURL(u); } catch (_) {} } return; }
      revokeSentBlob();                                    // free the previous clip's object URL
      sa.src = u;
      if (u && u.indexOf('blob:') === 0) sentBlobUrl = u;  // track for revocation on next swap/stop
      sa.load();
      sa.addEventListener('loadedmetadata', function onMeta() {
        sa.removeEventListener('loadedmetadata', onMeta);
        var duration = sa.duration || 5;
        if (sentResetTimer) clearTimeout(sentResetTimer);
        sentResetTimer = setTimeout(function () { resetSentBtn(); sentResetTimer = null; }, (duration + 0.5) * 1000);
      });
      sa.playbackRate = slowMode ? 0.75 : 1.0;
      return sa.play();
    }).catch(function (err) {
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
  var FLAG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>' +
    '<line x1="4" y1="22" x2="4" y2="15"/></svg>';

  // A locked playlist row: preview + padlock only, never the Thai/English body. Any tap goes to
  // the gate. The number is kept so the group still reads as part of the list.
  var LOCK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  function lockedCardHtml(s) {
    var d = dispNum(s);
    return '<div class="sentence-card' + sentCardClasses(s) + '" id="sc-' + s.num + '">' +
      '<div class="sentence-header" onclick="gateSentence(' + s.num + ')" role="button" tabindex="0" ' +
        'aria-label="Sentence ' + d + ' — Premium content">' +
        '<span class="sent-num">' + d + '</span>' +
        '<span class="sent-lock-ico">' + LOCK_SVG + '</span>' +
        '<span class="sent-preview">' + s.preview + '<span class="ell">…</span></span>' +
      '</div>' +
    '</div>';
  }

  function cardHtml(s) {
    if (sentLocked(s)) return lockedCardHtml(s);
    var st = states[s.num];
    var playing = sentPlaying === s.num;
    var displayThai = cleanThai(s.thai);
    var d = dispNum(s);
    // Flag control shows for everyone. Signed in → toggles a saved flag. Signed out → same
    // look (not greyed), but a click routes to the feature sign-in page (it doesn't flag).
    var A = window.ThaiEarAuth;
    var loggedIn = !!(A && A.getUser && A.getUser());
    var flagged = loggedIn && A.isFlagged && A.isFlagged(TOPIC_KEY, s.num);
    var flagBtn = PLMODE ? '' : (loggedIn
      ? '<button class="sent-flag-btn' + (flagged ? ' flagged' : '') + '" onclick="flagSent(event,' + s.num + ')" ' +
          'aria-label="' + (flagged ? 'Remove flag from sentence ' : 'Flag sentence ') + d + '" ' +
          'title="' + (flagged ? 'Flagged — click to remove' : 'Flag this sentence') + '">' + FLAG_SVG + '</button>'
      : '<button class="sent-flag-btn" onclick="flagSignIn(event)" ' +
          'aria-label="Sign in to flag sentence ' + d + '" title="Sign in to flag sentences">' + FLAG_SVG + '</button>');
    return '<div class="sentence-card' + sentCardClasses(s) + '" id="sc-' + s.num + '">' +
      '<div class="sentence-header" onclick="cycle(' + s.num + ')" role="button" tabindex="0" aria-label="Sentence ' + d + '">' +
        '<span class="sent-num">' + d + '</span>' +
        '<button class="sent-play-btn' + (playing ? ' playing' : '') + '" onclick="toggleSentPlay(event,' + s.num + ')" aria-label="Play sentence ' + d + '">' +
          '<svg viewBox="0 0 16 16">' + (playing
            ? '<rect x="3" y="2" width="3.5" height="12"/><rect x="9.5" y="2" width="3.5" height="12"/>'
            : '<polygon points="4,2 13,8 4,14"/>') + '</svg>' +
        '</button>' +
        '<button class="speed-toggle' + (slowMode ? ' active' : '') + '" onclick="toggleSlow(event)" aria-label="Slow playback" title="Slow speed">🐢</button>' +
        flagBtn +
        '<span class="sent-preview">' + s.preview + '<span class="ell">…</span></span>' +
        '<div class="prog-wrap" aria-hidden="true">' + seg(st >= 1) + seg(st >= 2) + seg(st >= 3) + '</div>' +
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
  // SSR: toggle flag visuals on the existing static buttons (no list rebuild).
  function syncFlags() {
    var a = window.ThaiEarAuth;
    var loggedIn = !!(a && a.getUser && a.getUser());
    sentences.forEach(function (s) {
      var b = document.querySelector('#sc-' + s.num + ' .sent-flag-btn');
      if (!b) return;
      var flagged = loggedIn && a.isFlagged && a.isFlagged(TOPIC_KEY, s.num);
      b.classList.toggle('flagged', !!flagged);
      b.setAttribute('title', flagged ? 'Flagged — click to remove' : (loggedIn ? 'Flag this sentence' : 'Sign in to flag sentences'));
    });
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
    else $('sentence-list').innerHTML = listHtml();
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
    var open = sentences.filter(function (s) { return !sentLocked(s); });
    var allOpen = open.every(function (s) { return states[s.num] === 3; });
    open.forEach(function (s) { states[s.num] = allOpen ? 0 : 3; });
    render();
  }

  /* ---- progress controls (add / remove / my progress) ----
     Single-source like the rest of the player: every topic page gets this row
     above the transport bar. Logged out → a prompt that routes to join.html.
     Logged in → a live tally with +/- buttons that write to the user's row. */
  var progLock = false;

  function renderProgress() {
    var box = $('progress-controls');
    if (!box) return;
    if (PLMODE) { box.innerHTML = ''; return; }   // playlists: no per-topic progress tracking
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) { box.innerHTML = ''; return; } // hold until auth resolves
    var user = a.getUser && a.getUser();
    if (!user) {
      box.innerHTML =
        '<div class="prog-ctl-card">' +
          '<span class="prog-ctl-label">Track how many times you’ve listened to this topic.</span>' +
          '<a class="prog-ctl-join" href="join.html?feature=1&next=' + encodeURIComponent(PAGE_FILE) + '">Sign in to track progress →</a>' +
        '</div>';
      return;
    }
    var count = a.getTopicProgress ? a.getTopicProgress(TOPIC_KEY) : 0;
    box.innerHTML =
      '<div class="prog-ctl-card">' +
        '<div class="prog-ctl-left">' +
          '<span class="prog-ctl-count" id="prog-count">' + count + '</span>' +
          '<span class="prog-ctl-label">complete listen' + (count === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="prog-ctl-btns">' +
          '<button class="prog-ctl-btn prog-ctl-minus" id="prog-remove" onclick="progRemove()" aria-label="Remove one listen" title="Remove one listen">−</button>' +
          '<button class="prog-ctl-btn prog-ctl-add" id="prog-add" onclick="progAdd()" aria-label="Add one listen">+ Add progress</button>' +
          '<a class="prog-ctl-my" href="progress.html">My progress</a>' +
        '</div>' +
      '</div>';
  }

  // Shared by + and −. Disables both buttons, shows a spinner then a tick, and holds
  // the lock for a beat after the write so an accidental double-click can't land —
  // mirrors the subscribe button's deliberate, lag-then-confirm feel.
  function progStep(kind) {
    var a = window.ThaiEarAuth;
    if (!a || !(a.getUser && a.getUser())) return;
    // No audio access to this topic (e.g. a free member on a premium topic) → same preview-only gate
    // as play/reveal/flag (premium → "preview only" toast in-app; member → sign-in). Don't touch progress.
    if (!entitledForPage()) { gate(); return; }
    if (progLock) return;
    progLock = true;
    var addBtn = $('prog-add'), remBtn = $('prog-remove'), countEl = $('prog-count');
    var actBtn = kind === 'add' ? addBtn : remBtn;
    var orig = actBtn ? actBtn.innerHTML : '';
    if (addBtn) addBtn.disabled = true;
    if (remBtn) remBtn.disabled = true;
    if (actBtn) actBtn.innerHTML = '<span class="prog-spin"></span>';
    var op = kind === 'add' ? a.addProgress(TOPIC_KEY) : a.removeProgress(TOPIC_KEY);
    op.then(function () {
      if (countEl) {
        countEl.textContent = a.getTopicProgress(TOPIC_KEY);
        countEl.classList.remove('bump'); void countEl.offsetWidth; countEl.classList.add('bump');
      }
      if (actBtn) actBtn.innerHTML = '<span class="prog-tick">✓</span>';
    }).catch(function (e) {
      console.warn('player.js: progress save failed', e);
      if (actBtn) actBtn.innerHTML = orig;
    }).then(function () {
      setTimeout(function () {
        progLock = false;
        // re-render to refresh the label (listen/listens) and restore button text
        renderProgress();
      }, 600);
    });
  }
  function progAdd() { progStep('add'); }
  function progRemove() { progStep('remove'); }

  // Load the user's progress once, then render; re-run whenever auth resolves/changes.
  function initProgress() {
    if (PLMODE) { renderProgress(); return; }   // playlists: renderProgress just clears the slot
    var a = window.ThaiEarAuth;
    if (!a || !a.isReady) { renderProgress(); return; }
    if (a.getUser && a.getUser() && a.loadProgress) {
      a.loadProgress().then(renderProgress).catch(renderProgress);
    } else {
      renderProgress();
    }
  }
  window.addEventListener('thaiear:auth', initProgress);

  /* ---- sentence flagging ----
     Toggle this sentence's flag (saved to the user's account). Debounced + a pop so a
     double-tap can't land — same discipline as the progress buttons. Updates just the
     button (no full re-render, to stay snappy). */
  var flagLock = false;
  // Logged-out flag click → the feature sign-in page, with ?next back to this topic.
  function flagSignIn(e) {
    e.stopPropagation(); e.preventDefault();
    // On a gated topic an un-entitled flag tap follows the same gate (premium → paywall/locked,
    // member → sign-in). On a FREE topic it's just "sign in to flag".
    if (!entitledForPage()) { gate(); return; }
    window.location.href = 'join.html?feature=1&next=' + encodeURIComponent(PAGE_FILE);
  }
  function flagSent(e, num) {
    e.stopPropagation(); e.preventDefault();
    if (!entitledForPage()) { gate(); return; }   // gated topic + not entitled → no flagging
    var a = window.ThaiEarAuth;
    // SSR pages use one flag button that always calls flagSent; route a signed-out click to
    // sign-in. Legacy pages render a separate flagSignIn button when signed out, so this branch
    // only changes SSR behaviour (guarded) and leaves legacy byte-for-byte.
    if (!a || !(a.getUser && a.getUser())) { return SSR ? flagSignIn(e) : undefined; }
    if (!a.toggleFlag) return;
    if (flagLock) return;
    flagLock = true;
    var btn = document.querySelector('#sc-' + num + ' .sent-flag-btn');
    if (btn) btn.classList.add('pending');
    var s = null;
    for (var i = 0; i < sentences.length; i++) { if (sentences[i].num === num) { s = sentences[i]; break; } }
    var nugget = s
      ? { num: s.num, preview: s.preview, thai: s.thai, english: s.english, gloss: s.gloss, cultural: s.cultural || '', audioPrefix: PREFIX }
      : { num: num, audioPrefix: PREFIX };
    a.toggleFlag(TOPIC_KEY, nugget).then(function (isOn) {
      if (btn) {
        btn.classList.remove('pending');
        btn.classList.toggle('flagged', isOn);
        btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
        btn.setAttribute('title', isOn ? 'Flagged — click to remove' : 'Flag this sentence');
      }
    }).catch(function (err) {
      console.warn('player.js: flag save failed', err);
      if (btn) btn.classList.remove('pending');
    }).then(function () {
      setTimeout(function () { flagLock = false; }, 300);
    });
  }

  // Load the user's flags once, then show flag state; re-run on auth. SSR pages sync flag
  // classes onto the static buttons; legacy pages re-render the list (cardHtml reads isFlagged).
  function refreshFlags() { if (SSR) syncFlags(); else render(); }
  function initFlags() {
    if (PLMODE) return;   // playlists: flagging is a topic-page feature
    var a = window.ThaiEarAuth;
    if (a && a.isReady && a.getUser && a.getUser() && a.loadFlags) {
      a.loadFlags().then(refreshFlags).catch(function () {});
    } else {
      refreshFlags(); // logged out (or auth gone) → show flags (SSR routes to sign-in on click)
    }
  }
  window.addEventListener('thaiear:auth', initFlags);
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
    // sync the transport bar if metadata already arrived before mount
    if (mainAudio.duration) { var t = $('time-total'); if (t) t.textContent = formatTime(mainAudio.duration); }
    render();
    initSentAudio();
    initScrubber();
    initProgress();
    initFlags();
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
    progAdd: progAdd, progRemove: progRemove, flagSent: flagSent, flagSignIn: flagSignIn,
    advanceTopic: advanceTopic, toggleAutoplay: toggleAutoplay, toggleRepeat: toggleRepeat,
    downloadTopic: downloadTopic, deleteTopic: deleteTopic, confirmDelete: confirmDelete, cancelDelete: cancelDelete, refreshTopic: refreshTopic,
    dynUpdateAudio: dynUpdateAudio, gateSentence: gateSent });

  // Let the owner simulator panel show the REAL verdict rather than restating its own inputs.
  if (window.ThaiEarSim) window.ThaiEarSim.canUseOffline = canUseOffline;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
