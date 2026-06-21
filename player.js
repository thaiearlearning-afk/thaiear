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
        return NA.prepare({ url: st.src, title: nativeMeta.title, subtitle: nativeMeta.subtitle, artwork: nativeMeta.artwork })
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
    try { localStorage.setItem('thaiear_np', JSON.stringify({ page: mainPage, name: nativeMeta.title, prefix: mainPrefix, mode: currentMode })); } catch (_) {}
  }
  // On mount, if the engine is already playing (a time tick arrives), sync this page's TOP player to
  // it — adopting another topic's identity if needed — so it shows + controls the live track.
  function syncToPlayingTrack() {
    if (!NA) return;
    var np; try { np = JSON.parse(localStorage.getItem('thaiear_np') || 'null'); } catch (_) { np = null; }
    if (!np || !np.prefix) return;
    var done = false;
    NA.addListener('time', function () {
      if (done) return; done = true;
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

  /* ---- offline downloads (Capacitor app only) ----
     A topic can be downloaded for offline listening: the two combined files (_TE/_ET) plus every
     per-sentence clip, stored in app-private storage (Filesystem DATA). Playback then prefers the
     local copy — the native engine plays the file:// directly; the web sentence <audio> uses
     Capacitor.convertFileSrc. PREMIUM downloads carry an offline LICENCE: they only play offline if
     the subscription was verified online within OFFLINE_GRACE_MS (a lapsed/cancelled member loses
     offline access once that window passes). Free + member topics have no expiry. Guarded on NATIVE;
     the website never shows any of this. */
  // TESTING VALUE — 1 minute so the failsafe is easy to test. PRODUCTION: 30 days =
  // 30 * 24 * 60 * 60 * 1000 = 2592000000.  (Keep nav.js OFFLINE_GRACE_MS in sync.)
  var OFFLINE_GRACE_MS = 1 * 60 * 1000;
  var Filesystem = (NATIVE && window.Capacitor.Plugins) ? window.Capacitor.Plugins.Filesystem : null;
  var OFFLINE = !!(NATIVE && Filesystem);

  // Persist a downloaded topic's PAGE (+ shared scripts) in a cache the service worker never
  // version-wipes, so the page still opens offline after an SW update. Self-heals whenever we're
  // online on a downloaded topic's page. (The SW's activate step preserves the 'thaiear-dl' cache.)
  var DL_PAGE_CACHE = 'thaiear-dl';
  function cachePage() {
    if (!window.caches || !navigator.onLine) return;
    try {
      caches.open(DL_PAGE_CACHE).then(function (c) {
        [location.href, '/player.js', '/topics.js', '/nav.js', '/auth.js', '/footer.js'].forEach(function (u) {
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
  function markDownloaded(prefix, tier, files) { var m = getManifest(); m[prefix] = { tier: tier || 'free', files: files, at: Date.now() }; setManifest(m); }
  function removeDownloaded(prefix) { var m = getManifest(); delete m[prefix]; setManifest(m); }
  function downloadedTier(prefix) { var e = getManifest()[prefix]; return e ? e.tier : null; }

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
    if (navigator.onLine) {
      if (subbed) { stampVerified(); return true; }
      if (a && a.isReady) return false;   // definitively not subscribed
      // auth still loading → fall through to the window
    }
    // Offline: must have re-verified within the backstop window (catches mid-period cancellation)
    // AND the membership's real end date (current_period_end) must not have passed.
    var last = parseInt(localStorage.getItem('thaiear_lastVerified') || '0', 10);
    var until = parseInt(localStorage.getItem('thaiear_sub_until') || '0', 10);
    var withinBackstop = !!last && (Date.now() - last) < OFFLINE_GRACE_MS;
    var membershipActive = !until || Date.now() < until;   // no end date captured → backstop alone
    return withinBackstop && membershipActive;
  }

  function localUri(prefix, file) {
    if (!Filesystem) return Promise.resolve(null);
    return Filesystem.getUri({ directory: 'DATA', path: offlineDir(prefix) + '/' + file })
      .then(function (r) { return (r && r.uri) ? r.uri : null; })
      .catch(function () { return null; });
  }
  // Main (native) player: local file:// if downloaded + licence ok, else the remote URL.
  function mainSrcFor(file) {
    if (OFFLINE && isDownloaded(mainPrefix)) {
      if (canUseOffline(mainTier)) return localUri(mainPrefix, file).then(function (uri) { return uri || buildUrl(file, mainGated); });
      if (!navigator.onLine) return Promise.reject({ code: 'licence' }); // downloaded premium, offline licence lapsed
    }
    return buildUrl(file, mainGated);
  }
  // Sentence (web <audio>) player: convertFileSrc(local) if downloaded + licence ok, else remote.
  function sentSrcFor(file) {
    if (OFFLINE && isDownloaded(PREFIX)) {
      if (canUseOffline(TIER)) {
        return localUri(PREFIX, file).then(function (uri) {
          return uri ? (window.Capacitor.convertFileSrc ? window.Capacitor.convertFileSrc(uri) : uri) : buildUrl(file);
        });
      }
      if (!navigator.onLine) return Promise.reject({ code: 'licence' });
    }
    return buildUrl(file);
  }

  function downloadTopic() {
    if (!OFFLINE) return;
    var files = topicFiles();
    var done = 0;
    downloadingNow = true;
    setOfflineState('downloading', 0, files.length);
    // Create the topic's folder first (downloadFile won't always make parent dirs).
    Filesystem.mkdir({ directory: 'DATA', path: offlineDir(PREFIX), recursive: true })
      .catch(function () {})                  // already exists → fine
      .then(function () {
        var chain = Promise.resolve();
        files.forEach(function (file) {
          chain = chain.then(function () {
            return buildUrl(file, GATED).then(function (url) {
              return Filesystem.downloadFile({ url: url, path: offlineDir(PREFIX) + '/' + file, directory: 'DATA', recursive: true });
            }).then(function () { done++; setOfflineState('downloading', done, files.length); });
          });
        });
        return chain;
      })
      .then(function () {
        markDownloaded(PREFIX, TIER || 'free', files);
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
  function deleteTopic() {
    if (!OFFLINE) return;
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
        '<button class="offline-btn offline-del" onclick="deleteTopic()">Delete</button>';
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
    if (!OFFLINE) { bar.style.display = 'none'; return; }  // website / non-app: never shown
    bar.style.display = 'flex';
    var dl = isDownloaded(PREFIX);
    if (dl) cachePage();   // self-heal: re-persist the page whenever we open a downloaded topic online
    setOfflineState(dl ? 'downloaded' : 'idle');
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

  /* ---- styles (the player owns its own CSS; page keeps only chrome) ----
     Depends on the page's :root design tokens, which every page defines. */
  var STYLES = `
    .progress-controls { margin-bottom: 0.9rem; min-height: 0; }
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
    .controls-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
    .reveal-all-btn { font-size: 12px; font-family: var(--font-ui); color: var(--text-secondary); background: none; border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: background 0.15s; }
    .reveal-all-btn:hover { background: var(--surface); }
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
      .sentence-header { padding: 0.6rem 0.85rem; }
      .sent-preview { font-size: 15px; }
      .row-thai { font-size: 17px; }
      .reveal-row { padding: 0.5rem 0.85rem; }
      .gloss-chip { font-size: 11px; padding: 2px 7px; }
      .cultural-note { font-size: 11px; }
      .orientation-text { font-size: 12px; }
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
    .te-licence-eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--gold-dark, #C8A030); background: var(--gold-light, #FBF5DC); padding: 4px 11px; border-radius: 20px; margin-bottom: 0.9rem; }
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
      '<strong>How to use this topic:</strong> Listen to the <strong>Thai first</strong> audio a couple of times to build familiarity. ' +
      'Then switch to <strong>English first</strong> to test your recall — hear the English prompt and try to produce the Thai before it plays. Feel free to pause anytime, especially on your first few listens. ' +
      'Click any sentence below to reveal the Thai, English translation, and word notes. Flag any sentences you want to revisit.' +
    '</p>' +
    '<div class="controls-row">' +
      '<button class="reveal-all-btn" id="reveal-all-btn" onclick="toggleAll()">' +
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/></svg>' +
        ' Reveal all' +
      '</button>' +
      '<span class="sent-count-label">' + sentences.length + ' sentences</span>' +
    '</div>' +
    '<div id="sentence-list"></div>' +
    '<audio id="sent-audio-el" preload="none" style="display:none"></audio>';

  /* ---- helpers ---- */
  function dispNum(s) { return s.display != null ? s.display : s.num; }
  function cleanThai(thai) { return thai.replace(/ \| /g, ' '); }
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
  // Not entitled (logged out / no access) → send to the paywall. Transient errors just log;
  // the play button is already reset by the caller.
  function handleDenied(err, tier) {
    if (tier == null) tier = TIER;
    var code = err && err.code;
    // Offline premium download whose licence has lapsed → friendly in-page message (no navigation).
    if (code === 'licence') { showLicenceOverlay(); return; }
    var gate = (code === 'noauth' || code === 401 || code === 402 || code === 403);
    if (!gate) { console.warn('player.js: audio unavailable', err); return; }
    // Member content is free behind a login → send to the free-membership explainer
    // (which has the Google sign-in), with ?next back to this topic page.
    if (tier === 'member') {
      var page = (location.pathname.split('/').pop() || '');
      if (!/\.html$/.test(page)) page += '.html';   // clean URLs (/topic-02) → topic-02.html
      window.location.href = 'join.html?next=' + encodeURIComponent(page);
      return;
    }
    // Premium (or any other denial) → the paywall.
    window.location.href = 'subscribe.html';
  }

  var PLAY_TRI  = '<polygon points="5,2 14,8 5,14"/>';
  var PLAY_BARS = '<rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/>';
  function setMainIcon(playing) {
    var i = $('play-icon'); if (i) i.innerHTML = playing ? PLAY_BARS : PLAY_TRI;
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (_) {} }
  }

  /* ---- state ---- */
  var states = {};
  sentences.forEach(function (s) { states[s.num] = 0; });
  var sentPlaying = null;
  var sentLock = false;
  var slowMode = false;
  var resumeMainAfter = false;   // main-pause coordination: was the top player playing when a sentence took over?

  function toggleSlow(e) {
    e.stopPropagation();
    e.preventDefault();
    slowMode = !slowMode;
    document.querySelectorAll('.speed-toggle').forEach(function (btn) { btn.classList.toggle('active', slowMode); });
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
  if (!mainGated && !OFFLINE) { mainAudio.src = AUDIO_BASE + '/' + currentMainFile; mainSrcReady = true; }

  // Resolve + attach the current main file's src if not already done (premium- and offline-aware).
  function ensureMainSrc() {
    if (mainSrcReady) return Promise.resolve();
    return mainSrcFor(currentMainFile).then(function (u) {
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
      ensureMainSrc().then(function () { mainAudio.play(); setMainIcon(true); setupMediaSession(); }).catch(function (e) { handleDenied(e, mainTier); });
    } else { mainAudio.pause(); setMainIcon(false); }
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

  function switchAudio(mode) {
    if (currentMode === mode) return;
    currentMode = mode;
    if (NATIVE) { try { localStorage.setItem('thaiear_dir', mode); } catch (_) {} }
    var wasPlaying = !mainAudio.paused;
    mainAudio.pause();
    setMainIcon(false);
    currentMainFile = mainPrefix + '_' + mode.toUpperCase() + '.mp3';
    mainSrcReady = false;                 // new file → re-resolve (premium needs a fresh signed URL)
    if (!mainGated && !OFFLINE) { mainAudio.src = AUDIO_BASE + '/' + currentMainFile; mainAudio.load(); mainSrcReady = true; }
    var f = $('scrubber-fill'); if (f) f.style.width = '0%';
    var c = $('time-cur'); if (c) c.textContent = '0:00';
    $('btn-te').classList.toggle('active', mode === 'te');
    $('btn-et').classList.toggle('active', mode === 'et');
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
      txt.innerHTML = 'Now playing <a href="' + href + '"><strong>' + escapeHtml(unit.name) + '</strong></a>' + (lvl ? ' · ' + escapeHtml(lvl) : '')
        + (moved ? ' <a href="#" class="np-return" id="np-return" title="Bring the player back to this topic">↩ Return</a>' : '');
      var rb = $('np-return'); if (rb) rb.onclick = function (e) { e.preventDefault(); returnToThisTopic(); };
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
    if (sentLock) return;
    sentLock = true;
    setTimeout(function () { sentLock = false; }, 300);
    var sa = getSentAudio();

    // tapping the playing sentence again stops it
    if (sentPlaying === num) {
      sa.pause(); sa.src = ''; sentPlaying = null; updateSentBtn(num, false);
      maybeResumeMain();
      return;
    }
    // stop any other sentence (top player stays paused — don't resume between clips)
    if (sentPlaying !== null) { sa.pause(); updateSentBtn(sentPlaying, false); sentPlaying = null; }

    // main-pause coordination: if the top player is going, pause it and remember to resume
    if (!mainAudio.paused) { resumeMainAfter = true; mainAudio.pause(); setMainIcon(false); }

    var sid = String(num).padStart(2, '0');
    var file = PREFIX + '_S' + sid + '_TH.mp3';
    sentPlaying = num;
    updateSentBtn(num, true);
    if (sentResetTimer) { clearTimeout(sentResetTimer); sentResetTimer = null; }
    // Resolve the src: local copy if downloaded, else free CDN / signed-URL fetch. Then play.
    sentSrcFor(file).then(function (u) {
      if (sentPlaying !== num) return;   // user stopped/switched while the URL was resolving
      sa.src = u;
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
      return '<span class="gloss-chip"><span class="g-thai">' + pair[0] + '</span><span class="g-eq">=</span><span class="g-eng">' + pair[1] + '</span></span>';
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
        '<div class="reveal-row row-thai">' + displayThai + '</div>' +
        (st >= 2 ? '<div class="reveal-row row-english">' + s.english + '</div>' : '') +
        (st >= 3 ? '<div class="reveal-row row-notes">' +
          '<div class="gloss-row">' + chipHtml(s.gloss) + '</div>' +
          (s.cultural ? '<div class="cultural-note">' + s.cultural + '</div>' : '') +
        '</div>' : '') +
      '</div>' : '') +
    '</div>';
  }

  function render() {
    $('sentence-list').innerHTML = sentences.map(cardHtml).join('');
    var allOpen = sentences.every(function (s) { return states[s.num] === 3; });
    var btn = $('reveal-all-btn');
    btn.innerHTML = allOpen
      ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l12 12M6.5 6.6A2.5 2.5 0 0 0 10 10.5M1 8s2.5-5 7-5c1 0 2 .2 2.8.6M15 8s-.8 1.6-2.5 3M8 13c-4.5 0-7-5-7-5"/></svg> Collapse all'
      : '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/></svg> Reveal all';
  }

  function cycle(num) { states[num] = (states[num] + 1) % 4; render(); }

  function toggleAll() {
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
    window.location.href = 'join.html?feature=1&next=' + encodeURIComponent(PAGE_FILE);
  }
  function flagSent(e, num) {
    e.stopPropagation(); e.preventDefault();
    var a = window.ThaiEarAuth;
    if (!a || !(a.getUser && a.getUser()) || !a.toggleFlag) return;
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

  // Load the user's flags once, then re-render the list so flag state shows; re-run on auth.
  function initFlags() {
    var a = window.ThaiEarAuth;
    if (a && a.isReady && a.getUser && a.getUser() && a.loadFlags) {
      a.loadFlags().then(render).catch(function () {});
    } else {
      render(); // logged out (or auth gone) → re-render (flags show but route to sign-in)
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
    renderOfflineBar();
    syncToPlayingTrack();   // if the engine is already playing another topic, reflect/adopt it
  }

  // inline onclick in the injected markup call these by name
  Object.assign(window, { switchAudio: switchAudio, togglePlay: togglePlay, skip: skip,
    toggleAll: toggleAll, cycle: cycle, toggleSentPlay: toggleSentPlay, toggleSlow: toggleSlow,
    progAdd: progAdd, progRemove: progRemove, flagSent: flagSent, flagSignIn: flagSignIn,
    advanceTopic: advanceTopic, toggleAutoplay: toggleAutoplay, toggleRepeat: toggleRepeat,
    downloadTopic: downloadTopic, deleteTopic: deleteTopic });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
