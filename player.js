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
        nativeMeta.title = resolveMainTitle();   // ensure the lock screen shows the topic, even on first play
        writeNowPlaying();                       // share what's now playing across pages (now-playing bar + sync)
        var prep = { url: st.src, title: nativeMeta.title, subtitle: nativeMeta.subtitle, artwork: nativeMeta.artwork };
        if (DYN) {
          // dyn session (this page's, or an adopted neighbour's persisted one) → 'dyn' + marks;
          // adopted static placeholder (no session) → plain 'std'.
          if (dynSession && !dynStdRemote) { prep.mode = 'dyn'; prep.marks = dynSession.map.map(function (m) { return m.start; }); }
          else prep.mode = 'std';
        }
        return NA.prepare(prep)
          .then(function () { st.preparedSrc = st.src; st.paused = false; return NA.play(); });
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
    try { localStorage.setItem('thaiear_np', JSON.stringify({ page: mainPage, name: nativeMeta.title, prefix: mainPrefix, mode: currentMode, access: mainTier || 'free' })); } catch (_) {}
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
    var np; try { np = JSON.parse(localStorage.getItem('thaiear_np') || 'null'); } catch (_) { np = null; }
    if (!np || !np.prefix) return;
    var done = false;
    NA.addListener('time', function () {
      if (done) return;
      if (userStartedHere) { done = true; return; } // user is driving THIS page → never hijack its label
      done = true;
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
    if (!r || r.prefix !== PREFIX) return;          // only continue THIS page's own topic
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
  var OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
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
      localStorage.setItem('thaiear_lastVerified', String(Date.now()));
      var a = window.ThaiEarAuth, sub = a && a.getSubscription && a.getSubscription();
      var end = sub && sub.current_period_end;
      if (end) localStorage.setItem('thaiear_sub_until', String(parseExpiry(end)));
    } catch (_) {}
  }
  // May an offline download of this tier be played right now? free/member: always.
  // premium: live subscription when online; else within the verified-online window.
  function canUseOffline(tier) {
    if (tier !== 'premium') return true;
    // Lifetime members (£0-forever) never time out offline — they may be off-grid for months.
    // The flag is maintained by auth.js ONLY when the server confirms lifetime+active while online,
    // so a regular paying user can never reach this early-return.
    try { if (localStorage.getItem('thaiear_lifetime') === '1') return true; } catch (_) {}
    var a = window.ThaiEarAuth;
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
  function sentSrcFor(file) {
    if (OFFLINE && isDownloaded(PREFIX)) {
      if (canUseOffline(TIER)) {
        return localBlobUrl(PREFIX, file).then(function (url) { return url || buildUrl(file); });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    if (WEB_DL && isDownloaded(PREFIX)) {
      if (canUseOffline(TIER)) {
        return cachedBlobUrl(PREFIX, file).then(function (url) { return url || buildUrl(file); });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    return buildUrl(file);
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

  function downloadTopic() {
    if (!OFFLINE && !WEB_DL) return;
    // Gated topic + not entitled → same preview-only gate as play/reveal/flag (premium → "preview
    // only" toast in-app; member → sign-in), instead of attempting the download and erroring on /api/audio.
    if (!entitledForPage()) { gate(TIER); return; }
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
    if (!OFFLINE && !WEB_DL) return;
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
    if (DYN) return;   // dyn test pages: a static-file offline download would only confuse the test
    var bar = $('offline-bar'); if (!bar) return;
    if (!OFFLINE && !WEB_DL) { bar.style.display = 'none'; return; }  // plain website (no app, flag off): never shown
    bar.style.display = 'flex';
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
  if (!/\.html$/.test(PAGE_FILE)) PAGE_FILE += '.html'; // clean URLs (/topic-02) → topic-02.html
  var TOPIC_KEY = PAGE_FILE.replace(/\.html$/, '');

  if (!PREFIX || !sentences.length) {
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
    var a = window.ThaiEarAuth;
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
          '<div style="font:600 17px var(--font-ui,system-ui,sans-serif);color:#B29234;margin-bottom:8px;">🔒 Premium topic</div>' +
          '<p style="font-size:14px;color:#5A5A5A;line-height:1.55;margin:0 0 12px;">' +
            'You’re previewing this topic. A ThaiEar Premium membership unlocks:</p>' +
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
    var show = miniActivated && !mainInView && !miniDismissed;
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
    function end(e) { dragging = false; try { scrub.releasePointerCapture(e.pointerId); } catch (_) {} }
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
        mainInView = entries[entries.length - 1].isIntersecting;
        updateMiniVisibility();
      }, { rootMargin: '-56px 0px 0px 0px', threshold: 0 });
      io.observe($('player-root'));
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

  var DYN_SR = 24000;
  var dynFactor = 1;
  try { var _dynPf = parseFloat(localStorage.getItem('te_dyn_pf')); if (isFinite(_dynPf) && _dynPf > 0) dynFactor = _dynPf; } catch (_) {}
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
  var dynSessionIsLocal = true; // does dynSession belong to THIS page's sentences? (card highlight guard)
  var dynAdopted = null;      // cross-topic nav: the dynNav target descriptor the top player adopted
  var dynStdRemote = false;   // adopted target is playing its STATIC combined file (no session/map)
  var DYN_KEY_NS = cfg.dynKey || PREFIX;   // namespace for exclusions + persisted sessions

  /* -- session persistence (per topic, per mode) --
     A successfully built session is stored so a revisit (or the neighbour test page) doesn't
     reconstruct: audio in the durable 'thaiear-audio-dl' Cache Storage cache on web, or a
     per-topic WAV in the app CACHE dir on native; {key,map,duration} metadata in localStorage.
     Stale entries are never deleted eagerly — a key mismatch just misses and rebuilds. */
  function dynMetaLsKey(dk, mode) { return 'te_dyn_meta_' + dk + '_' + mode; }
  function dynCachePath(dk, mode) { return '/dyn/' + dk + '/' + mode + '.wav'; }
  function dynNativeFile(dk, mode) { return 'dyn-' + dk + '-' + mode + '.wav'; }
  function dynReadMeta(dk, mode) {
    try {
      var m = JSON.parse(localStorage.getItem(dynMetaLsKey(dk, mode)) || 'null');
      if (m && m.key && m.map && m.map.length && m.duration) return m;
    } catch (_) {}
    return null;
  }
  function dynPersistSession(sess, mode) {
    try {
      localStorage.setItem(dynMetaLsKey(DYN_KEY_NS, mode),
        JSON.stringify({ key: sess.key, map: sess.map, duration: sess.duration }));
    } catch (_) {}
    // Native: the WAV was already written under the per-topic filename during the build.
    if (!NATIVE && window.caches) {
      caches.open(AUDIO_DL_CACHE).then(function (c) {
        return c.put(dynCachePath(DYN_KEY_NS, mode),
          new Response(sess.blob, { headers: { 'Content-Type': 'audio/wav' } }));
      }).catch(function () {});
    }
  }
  // Rehydrate a persisted session's audio (meta comes from dynReadMeta). Resolves null on any
  // miss — evicted cache entry, missing native file — so callers fall back to building.
  function dynRestoreSession(dk, mode, meta) {
    if (NATIVE) {
      var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!FS) return Promise.resolve(null);
      var path = dynNativeFile(dk, mode);
      return FS.stat({ path: path, directory: 'CACHE' })
        .then(function () { return FS.getUri({ path: path, directory: 'CACHE' }); })
        .then(function (r) {
          if (!r || !r.uri) return null;
          return { url: null, fileUri: r.uri, blob: null, map: meta.map, key: meta.key, duration: meta.duration };
        }).catch(function () { return null; });
    }
    if (!window.caches) return Promise.resolve(null);
    return caches.open(AUDIO_DL_CACHE)
      .then(function (c) { return c.match(dynCachePath(dk, mode)); })
      .then(function (res) { return res ? res.blob() : null; })
      .then(function (blob) {
        if (!blob) return null;
        return { url: URL.createObjectURL(blob), blob: blob, map: meta.map, key: meta.key, duration: meta.duration };
      }).catch(function () { return null; });
  }

  // Pause lengths are derived from a crude syllable estimate of the Thai (len/3 after
  // stripping the pause markers, whitespace and the zero-ish chars ๆ ็ ์).
  function dynSyllables(thai) {
    var t = String(thai || '').replace(/\|/g, '').replace(/\s+/g, '').replace(/[ๆ็์]/g, '');
    return Math.max(1, Math.floor(t.length / 3));
  }
  function dynIncluded() {
    return sentences.filter(function (s) { return !dynExcluded[s.num]; });
  }
  function dynKey() {
    return currentMode + '|' + dynFactor + '|' + dynIncluded().map(function (s) { return s.num; }).join(',');
  }
  function dynClipFile(num, side) {
    return PREFIX + '_S' + String(num).padStart(2, '0') + '_' + side + '.mp3';
  }
  // Fetch + decode one clip to a mono 24 kHz AudioBuffer (decodeAudioData resamples to the
  // OfflineAudioContext's rate). Decoded buffers are cached for the life of the page.
  function dynFetchClip(file) {
    if (dynClipCache[file]) return Promise.resolve(dynClipCache[file]);
    return buildUrl(file, GATED).then(function (u) {
      return fetch(u);
    }).then(function (r) {
      if (!r.ok) return Promise.reject({ code: r.status });
      return r.arrayBuffer();
    }).then(function (ab) {
      return new Promise(function (res, rej) {
        var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        var ctx = new OAC(1, 1, DYN_SR);
        ctx.decodeAudioData(ab, res, rej);
      });
    }).then(function (buf) { dynClipCache[file] = buf; return buf; });
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
    var inc = dynIncluded();
    if (!inc.length) return Promise.reject({ code: 'empty' });
    var key = dynKey();
    var mode = currentMode;   // captured: the key/filename must match the mode this build is FOR
    var files = [];
    inc.forEach(function (s) { files.push(dynClipFile(s.num, 'TH')); files.push(dynClipFile(s.num, 'EN')); });
    var done = 0;
    return Promise.all(files.map(function (f) {
      return dynFetchClip(f).then(function (b) { done++; if (onProg) onProg(done, files.length); return b; });
    })).then(function () {
      var parts = [];   // AudioBuffer, or a number = silence length in samples
      var map = [];
      var pos = 0;      // running length in samples
      function pushBuf(b) { parts.push(b); pos += b.length; }
      function pushSil(sec) { var n = Math.round(sec * DYN_SR); parts.push(n); pos += n; }
      inc.forEach(function (s) {
        var th = dynClipCache[dynClipFile(s.num, 'TH')];
        var en = dynClipCache[dynClipFile(s.num, 'EN')];
        var syl = dynSyllables(s.thai);
        var repeat = Math.max(3.0, syl * 0.5) * dynFactor;
        var recall = Math.max(4.5, syl * 0.7) * dynFactor;
        var gap = 3.0 * dynFactor;
        var start = pos / DYN_SR;
        if (currentMode === 'et') { pushBuf(en); pushSil(recall); pushBuf(th); pushSil(repeat); pushBuf(th); }
        else { pushBuf(th); pushSil(repeat); pushBuf(th); pushSil(repeat); pushBuf(en); }
        pushSil(gap);
        map.push({ num: s.num, start: start, end: pos / DYN_SR });
      });
      var out = new Float32Array(pos);   // silence = the zero-filled default
      var o = 0;
      parts.forEach(function (p) {
        if (typeof p === 'number') { o += p; }
        else { out.set(p.getChannelData(0), o); o += p.length; }
      });
      var blob = dynEncodeWav(out);
      var sess = { url: URL.createObjectURL(blob), blob: blob, map: map, key: key, duration: pos / DYN_SR };
      if (!NATIVE) return sess;
      // Native engine can't play a blob: URL — persist the WAV to the app cache and hand it a file URI.
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
        fr.onerror = function () { rej({ code: 'fs' }); };
        fr.readAsDataURL(blob);
      }).then(function (b64) {
        var FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
        if (!FS) return sess;
        var wavPath = dynNativeFile(DYN_KEY_NS, mode);   // per-topic+mode so sessions don't overwrite each other
        return FS.writeFile({ path: wavPath, data: b64, directory: 'CACHE' })
          .then(function () { return FS.getUri({ path: wavPath, directory: 'CACHE' }); })
          .then(function (r) { sess.fileUri = (r && r.uri) || null; return sess; });
      });
    });
  }
  function dynEnsureSession(onProg) {
    var key = dynKey();
    if (dynSession && dynSessionIsLocal && dynSession.key === key) return Promise.resolve(dynSession);
    if (dynBuilding && dynBuilding.key === key) return dynBuilding.p;
    var mode = currentMode;
    var meta = dynReadMeta(DYN_KEY_NS, mode);
    var p = ((meta && meta.key === key) ? dynRestoreSession(DYN_KEY_NS, mode, meta) : Promise.resolve(null))
      .then(function (restored) {
        if (restored) return restored;   // persisted hit → no fetch, no decode, no status line
        dynStatus('Constructing dynamic mp3 file', true);   // only a REAL build shows the status
        return dynBuildSession(onProg).then(function (sess) { dynPersistSession(sess, mode); return sess; });
      })
      .then(function (sess) {
        if (dynSession && dynSession.url && dynSession.url !== sess.url) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
        dynSession = sess;
        dynSessionIsLocal = true;
        dynStdRemote = false;
        dynBuilding = null;
        return sess;
      }).catch(function (e) { dynBuilding = null; return Promise.reject(e); });
    dynBuilding = { key: key, p: p };
    return p;
  }
  // The DYN branch of ensureMainSrc: build (restore, or reuse) the session and point mainAudio
  // at it. When the top player has ADOPTED a neighbour topic (dyn cross-topic nav), re-resolve
  // that adoption instead — e.g. after a TE/ET switch reset mainSrcReady.
  function dynEnsureMainSrc() {
    if (dynAdopted) {
      if (mainSrcReady) return Promise.resolve();
      var adoptedT = dynAdopted;
      return dynResolveAdopt(adoptedT).then(function (r) { dynApplyAdopt(adoptedT, r); });
    }
    if (mainSrcReady && dynSession && dynSessionIsLocal && dynSession.key === dynKey()) return Promise.resolve();
    return dynEnsureSession(function (done, total) {
      var c = $('dyn-status-count'); if (c) c.textContent = done + '/' + total;
    }).then(function (sess) {
      mainAudio.src = (NATIVE && sess.fileUri) ? sess.fileUri : sess.url;
      mainAudio.load();
      mainSrcReady = true;
      dynStatus(null);
    }).catch(function (e) {
      var code = e && e.code;
      dynStatus((code === 'noauth' || code === 401 || code === 403)
        ? 'Sign in to play this topic'
        : 'Couldn’t load the audio — check your connection', false);
      return Promise.reject(e);
    });
  }
  // A setting changed (pause factor / exclusions): drop the session, keep the decoded clip
  // cache, and let the next play rebuild.
  function dynInvalidate() {
    if (!mainAudio.paused) { mainAudio.pause(); setMainIcon(false); }
    mainSrcReady = false;
    if (dynSession && dynSession.url) { try { URL.revokeObjectURL(dynSession.url); } catch (_) {} }
    dynSession = null;
    dynStatus('Changes saved — your session will reconstruct on next play.', false);
  }
  // Status line under the transport. text=null hides it; dots=true appends the animated dots
  // (plus a live n/m counter span the build progress writes into).
  function dynStatus(text, dots) {
    var el = $('dyn-status');
    if (!el) return;
    if (text == null) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = escapeHtml(text) + (dots ? '<span class="dyn-dots"></span> <span id="dyn-status-count"></span>' : '');
  }
  // Sentence-block skip (the ①-arrow buttons): next → start of the next block; prev → start
  // of the previous block if we're within 1.5 s of the current block's start, else restart it.
  function dynSentSkip(dir) {
    if (!dynSession || !dynSession.map.length) return;
    var t = mainAudio.currentTime || 0, map = dynSession.map, i;
    for (i = 0; i < map.length; i++) { if (t < map[i].end) break; }
    if (i >= map.length) i = map.length - 1;
    if (dir > 0) {
      if (i + 1 < map.length) mainAudio.currentTime = map[i + 1].start;
      return;
    }
    if (t - map[i].start < 1.5 && i > 0) mainAudio.currentTime = map[i - 1].start;
    else mainAudio.currentTime = map[i].start;
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
     Mirrors classic advanceTopic: stay on the page and swap the top player onto the dynNav
     target. Source priority: (a) the TARGET topic's own persisted dyn session for the current
     mode — accepted as-is, its stored key is authoritative (this page's exclusions are
     irrelevant to it); (b) the pre-rendered static combined TE/ET file as a placeholder.
     A second next/prev from the adopted state falls back to real page navigation. */
  function dynResolveAdopt(t) {
    var mode = currentMode;
    var meta = t.dynKey ? dynReadMeta(t.dynKey, mode) : null;
    return (meta ? dynRestoreSession(t.dynKey, mode, meta) : Promise.resolve(null)).then(function (sess) {
      if (sess) return { src: (NATIVE && sess.fileUri) ? sess.fileUri : sess.url, std: false, sess: sess };
      var file = t.prefix + '_' + mode.toUpperCase() + '.mp3';
      return buildUrl(file, t.tier === 'member' || t.tier === 'premium')
        .then(function (u) { return { src: u, std: true, sess: null }; });
    });
  }
  function dynApplyAdopt(t, r) {
    if (dynSession && dynSession.url && (!r.sess || r.sess.url !== dynSession.url)) {
      try { URL.revokeObjectURL(dynSession.url); } catch (_) {}
    }
    dynSession = r.sess;            // null for the static placeholder → sentence-skip no-ops, shim sends 'std'
    dynSessionIsLocal = false;
    dynStdRemote = r.std;
    dynAdopted = t;
    // Adopt the target's identity like classic advanceTopic (denial routing, TE/ET switches).
    mainPage = t.page;
    mainPrefix = t.prefix;
    mainTier = (t.tier === 'member' || t.tier === 'premium') ? t.tier : null;
    mainGated = !!mainTier;
    currentMainFile = mainPrefix + '_' + currentMode.toUpperCase() + '.mp3';
    if (dynLastLive != null) { var pc = document.getElementById('sc-' + dynLastLive); if (pc) pc.classList.remove('dyn-live'); dynLastLive = null; }
    mainAudio.src = r.src;
    mainAudio.load();
    mainSrcReady = true;
    // Now-playing strip, set directly — topics.js can't resolve test pages.
    var box = $('now-playing'), txt = $('now-playing-text');
    if (box) box.classList.add('show');
    if (txt) txt.innerHTML = 'Now playing <strong>' + escapeHtml(t.name) + '</strong>' + (r.std ? ' — standard audio' : '');
  }
  function dynAdvance(t) {
    if (!mainAudio.paused) mainAudio.pause();
    setMainIcon(false);
    dynResolveAdopt(t).then(function (r) {
      dynApplyAdopt(t, r);
      var f = $('scrubber-fill'); if (f) f.style.width = '0%';
      var c = $('time-cur'); if (c) c.textContent = '0:00';
      var tt = $('time-total'); if (tt) tt.textContent = '0:00';
      return mainAudio.play();
    }).then(function () { setMainIcon(true); })
      .catch(function (e) { handleDenied(e, (t.tier === 'member' || t.tier === 'premium') ? t.tier : null); });
  }
  var DYN_STYLES =
    '.dyn-status{text-align:center;font-size:13px;font-weight:500;color:var(--accent);padding:4px 0;}' +
    '.dyn-dots{display:inline-block;width:1.1em;text-align:left}' +
    ".dyn-dots::after{content:'...';display:inline-block;width:0;overflow:hidden;vertical-align:bottom;animation:dyn-dots 1.2s steps(3,start) infinite}" +
    '@keyframes dyn-dots{from{width:0}to{width:1.05em}}' +
    '.dyn-sent-btn{width:34px;height:34px}' +
    '.dyn-slider{display:flex;align-items:center;justify-content:center;gap:10px;font-size:12.5px;color:var(--text-tertiary);margin-top:8px}' +
    '.dyn-slider input{width:150px;accent-color:var(--accent)}' +
    '.sentence-card.dyn-off{opacity:.55;border-style:dashed}' +
    '.sentence-card.dyn-off .sent-preview{text-decoration:line-through}' +
    '.dyn-card-btn{width:26px;height:26px;border-radius:50%;border:.5px solid var(--border-strong);background:var(--surface);color:var(--text-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}' +
    '.dyn-card-btn svg{width:13px;height:13px}' +
    '.dyn-card-btn:hover{color:var(--accent);border-color:var(--accent)}' +
    '.sentence-card.dyn-live{border-color:var(--accent);}';
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
    var row = root.querySelector('.audio-row');
    if (row) {
      var stEl = document.createElement('div');
      stEl.id = 'dyn-status'; stEl.className = 'dyn-status'; stEl.hidden = true;
      row.parentNode.insertBefore(stEl, row.nextSibling);
      var sl = document.createElement('div');
      sl.className = 'dyn-slider';
      sl.innerHTML = 'Pauses <input id="dyn-pf" type="range" min="0.5" max="2" step="0.25"> <span id="dyn-pf-val">1×</span>';
      stEl.parentNode.insertBefore(sl, stEl.nextSibling);
      var pf = sl.querySelector('#dyn-pf'), pv = sl.querySelector('#dyn-pf-val');
      pf.value = String(dynFactor);
      pv.textContent = dynFactor + '×';
      pf.addEventListener('input', function () { pv.textContent = (parseFloat(pf.value) || 1) + '×'; });
      pf.addEventListener('change', function () {
        dynFactor = parseFloat(pf.value) || 1;
        try { localStorage.setItem('te_dyn_pf', String(dynFactor)); } catch (_) {}
        pv.textContent = dynFactor + '×';
        dynInvalidate();
      });
      var skips = row.querySelectorAll('.skip-btn');   // [back-10, fwd-10] (dyn buttons not yet inserted)
      var DIGIT1 = '<path d="M12.36 15.94v-4.27h-.09l-1.77.63v.69l1.01-.31v3.26h.85z"/>';
      var prevB = document.createElement('button');
      prevB.id = 'dyn-sent-prev'; prevB.className = 'skip-btn dyn-sent-btn';
      prevB.setAttribute('aria-label', 'Previous sentence'); prevB.title = 'Previous sentence';
      prevB.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>' + DIGIT1 + '</svg>';
      prevB.addEventListener('click', function () { dynSentSkip(-1); });
      var nextB = document.createElement('button');
      nextB.id = 'dyn-sent-next'; nextB.className = 'skip-btn dyn-sent-btn';
      nextB.setAttribute('aria-label', 'Next sentence'); nextB.title = 'Next sentence';
      nextB.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 13c0 4.4 3.6 8 8 8s8-3.6 8-8h-2c0 3.3-2.7 6-6 6s-6-2.7-6-6 2.7-6 6-6v4l5-5-5-5v4c-4.4 0-8 3.6-8 8z"/>' + DIGIT1 + '</svg>';
      nextB.addEventListener('click', function () { dynSentSkip(1); });
      if (skips[0]) row.insertBefore(prevB, skips[0]);
      if (skips[1]) row.insertBefore(nextB, skips[1].nextSibling);
    }
    sentences.forEach(function (s) {
      var hdr = document.querySelector('#sc-' + s.num + ' .sentence-header');
      if (!hdr) return;
      var flag = hdr.querySelector('.sent-flag-btn');
      var nb = document.createElement('button');
      nb.className = 'dyn-card-btn dyn-note-btn';
      nb.setAttribute('aria-label', 'Add to playlist'); nb.title = 'Add to playlist';
      nb.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>';
      nb.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        if (window.ThaiEarDyn && window.ThaiEarDyn.openPopup) {
          window.ThaiEarDyn.openPopup(TIER === 'premium' ? 'premium' : 'std', {
            topic_key: (cfg.dynKey || ''), num: s.num, prefix: PREFIX, tier: TIER || 'free',
            thai: s.thai, translit: s.translit || null, english: s.english
          });
        } else alert('Playlists unavailable');
      });
      var xb = document.createElement('button');
      xb.className = 'dyn-card-btn dyn-x-btn';
      function xPaint() {
        var on = !!dynExcluded[s.num];
        xb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="' + (on ? 'M12 5v14M5 12h14' : 'M5 12h14') + '"/></svg>';
        xb.setAttribute('aria-label', on ? 'Include in session' : 'Exclude from session');
        xb.title = on ? 'Include in session' : 'Exclude from session';
      }
      xPaint();
      xb.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        dynExcluded[s.num] = !dynExcluded[s.num];
        dynSaveExcluded();
        var card = document.getElementById('sc-' + s.num);
        if (card) card.classList.toggle('dyn-off', !!dynExcluded[s.num]);
        xPaint();
        dynInvalidate();
      });
      hdr.insertBefore(nb, flag ? flag.nextSibling : null);
      hdr.insertBefore(xb, nb.nextSibling);
      if (dynExcluded[s.num]) {
        var card0 = document.getElementById('sc-' + s.num);
        if (card0) card0.classList.add('dyn-off');
      }
    });
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
  var mainPage = PAGE_FILE;         // the live-unit page the top player is currently playing
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
  function ensureMainSrc() {
    if (DYN) return dynEnsureMainSrc();   // dynamic mode: stitched client-side session, never the static file
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
    if (DYN && dynSession && dynSessionIsLocal) dynHighlight(mainAudio.currentTime);   // dyn: highlight the playing card (this page's session only)
    writeWebResume();   // keep the cross-page resume position fresh while playing (web only, throttled)
  });
  mainAudio.addEventListener('ended', function () {
    setMainIcon(false);
    // repeat-one wins over autoplay: loop the current topic.
    if (repeatOn) {
      mainAudio.currentTime = 0;
      mainAudio.play().then(function () { setMainIcon(true); }).catch(function () {});
      return;
    }
    if (autoplayOn) advanceTopic(1);
  });

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
      ensureMainSrc().then(function () { mainAudio.play(); setMainIcon(true); setupMediaSession(); }).catch(function (e) { handleDenied(e, mainTier); });
    } else { mainAudio.pause(); setMainIcon(false); writeWebResume(true); }
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
    function endDrag() { if (!dragging) return; dragging = false; fill.style.transition = ''; }
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
    // Dyn pages: adopt the dynNav neighbour in place (persisted session or static placeholder).
    // A SECOND hop from an adopted state navigates for real — the user has moved two steps.
    if (DYN && cfg.dynNav) {
      if (dynAdopted) { location.href = dynAdopted.page; return; }
      var dynT = dir > 0 ? cfg.dynNav.next : cfg.dynNav.prev;
      if (dynT) dynAdvance(dynT);
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
    set('play', function () { if (mainAudio.paused) togglePlay(); });
    set('pause', function () { if (!mainAudio.paused) togglePlay(); });
    set('previoustrack', function () { advanceTopic(-1); });
    set('nexttrack', function () { advanceTopic(1); });
    // iOS Control Center shows the prev/next-TRACK buttons only when the seek handlers are
    // absent — otherwise it falls back to the ±15s skip buttons. Clear them explicitly so
    // our topic prev/next show on the lock screen. (Our on-page ±10s buttons are unaffected.)
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

    var sid = String(num).padStart(2, '0');
    var file = PREFIX + '_S' + sid + '_TH.mp3';
    sentPlaying = num;
    updateSentBtn(num, true);
    if (sentResetTimer) { clearTimeout(sentResetTimer); sentResetTimer = null; }
    // Resolve the src: local copy if downloaded, else free CDN / signed-URL fetch. Then play.
    sentSrcFor(file).then(function (u) {
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

  function cardHtml(s) {
    var st = states[s.num];
    var playing = sentPlaying === s.num;
    var displayThai = cleanThai(s.thai);
    var d = dispNum(s);
    // Flag control shows for everyone. Signed in → toggles a saved flag. Signed out → same
    // look (not greyed), but a click routes to the feature sign-in page (it doesn't flag).
    var A = window.ThaiEarAuth;
    var loggedIn = !!(A && A.getUser && A.getUser());
    var flagged = loggedIn && A.isFlagged && A.isFlagged(TOPIC_KEY, s.num);
    var flagBtn = loggedIn
      ? '<button class="sent-flag-btn' + (flagged ? ' flagged' : '') + '" onclick="flagSent(event,' + s.num + ')" ' +
          'aria-label="' + (flagged ? 'Remove flag from sentence ' : 'Flag sentence ') + d + '" ' +
          'title="' + (flagged ? 'Flagged — click to remove' : 'Flag this sentence') + '">' + FLAG_SVG + '</button>'
      : '<button class="sent-flag-btn" onclick="flagSignIn(event)" ' +
          'aria-label="Sign in to flag sentence ' + d + '" title="Sign in to flag sentences">' + FLAG_SVG + '</button>';
    return '<div class="sentence-card" id="sc-' + s.num + '">' +
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
        (st >= 3 ? '<div class="reveal-row row-notes">' +
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
    if (c) c.className = 'sentence-card st-' + (states[num] || 0);
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

  function render() {
    if (SSR) sentences.forEach(function (s) { syncCard(s.num); });
    else $('sentence-list').innerHTML = sentences.map(cardHtml).join('');
    applyDirClass();   // keep the reveal order in sync with the current TE/ET direction
    applyTranslitClass();   // reflect the stored transliteration preference (default on)

    var allOpen = sentences.every(function (s) { return states[s.num] === 3; });
    var btn = $('reveal-all-btn');
    if (!btn) return;
    btn.innerHTML = allOpen
      ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l12 12M6.5 6.6A2.5 2.5 0 0 0 10 10.5M1 8s2.5-5 7-5c1 0 2 .2 2.8.6M15 8s-.8 1.6-2.5 3M8 13c-4.5 0-7-5-7-5"/></svg> Collapse all'
      : '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/></svg> Reveal all';
  }

  function cycle(num) {
    if (!entitledForPage()) { gate(); return; }   // gated topic + not entitled → no reveal
    states[num] = (states[num] + 1) % 4; render();
  }

  function toggleAll() {
    if (!entitledForPage()) { gate(); return; }
    var allOpen = sentences.every(function (s) { return states[s.num] === 3; });
    sentences.forEach(function (s) { states[s.num] = allOpen ? 0 : 3; });
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
    var a = window.ThaiEarAuth;
    if (a && a.isReady && a.getUser && a.getUser() && a.loadFlags) {
      a.loadFlags().then(refreshFlags).catch(function () {});
    } else {
      refreshFlags(); // logged out (or auth gone) → show flags (SSR routes to sign-in on click)
    }
  }
  window.addEventListener('thaiear:auth', initFlags);

  /* ---- mount ---- */
  function mount() {
    if (!document.getElementById('player-styles')) {
      var style = document.createElement('style');
      style.id = 'player-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }
    if (TIER === 'premium') document.body.classList.add('premium-topic'); // gold-skin the controls
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
    downloadTopic: downloadTopic, deleteTopic: deleteTopic, confirmDelete: confirmDelete, cancelDelete: cancelDelete, refreshTopic: refreshTopic });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
