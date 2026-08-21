/* ============================================================
   read.js — renderer + test engine for the "Read Thai" section.
   ------------------------------------------------------------
   Each page carries  <div id="read-root" data-read="mid"></div>
   and loads read-data.js before this file. Everything on the
   page — explainer grid, tests, tone table, quiz, prev/next —
   is rendered here from window.ThaiEarRead.

   Progress lives in localStorage (thaiear_read_v1) for now;
   Supabase sync can be layered on later the same way sentence
   progress was.
   ============================================================ */
(function () {
  'use strict';

  /* ⚠ LINK TO THE CLEAN URL, NEVER `read-foo.html` (2026-08-12).
     Cloudflare Pages 308-redirects /read-foo.html → /read-foo, and that redirect is
     `cf-cache-status: DYNAMIC` — a full, uncached origin round trip (127–1315 ms measured on the
     equivalent topic links, median ~0.6 s by curl). It also runs BEFORE the service worker starts,
     so Navigation Preload (sw v293) cannot cover it. read-data.js keeps `page: "read-foo.html"` as
     the section's identity key; only the emitted href is stripped. */
  var LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(location.hostname);
  function pageHref(p) {
    var s = String(p || '').replace(/\.html$/i, '');
    return (LOCAL_HOST && s) ? s + '.html' : s;   // localhost has no clean-URL resolution
  }

  var D = window.ThaiEarRead;
  if (!D) {
    // read-data.js (which sets window.ThaiEarRead to the data object) hasn't loaded — e.g. a host
    // page pulled in read.js without it. Stand up a harmless stub so window.ThaiEarRead.mountHub(...)
    // (r130 native-panel API, see mountHub below) fails soft with a console warning instead of
    // throwing "Cannot read properties of undefined". Nothing else in this file can run without D.
    window.ThaiEarRead = window.ThaiEarRead || {};
    window.ThaiEarRead.mountHub = function () {
      console.warn('ThaiEarRead.mountHub: read-data.js has not loaded — nothing to render.');
    };
    return;
  }

  // Reading audio lives in the public R2 bucket under read/ (deployed 2026-07-22).
  // Localhost override: define window.ThaiEarReadAudioBase = 'read-audio/' before this loads.
  var IS_LOCALHOST = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  // Localhost previews serve the clips same-origin from /read-audio/ (the canonical local copies):
  // the CDN's CORS policy only allows the thaiear.com origin, so cross-origin fetches would fail.
  var AUDIO_BASE = window.ThaiEarReadAudioBase ||
    (IS_LOCALHOST ? 'read-audio/' : 'https://audio.thaiear.com/read/');
  // BUMP ON EVERY AUDIO RELEASE: the zone's 4h Browser Cache TTL means replaced
  // same-name clips play stale from users' browsers — a new query string is a
  // new URL, so every cache (edge + browser) misses and fetches fresh.
  var AUDIO_VER = '?v=3';

  /* ── audio ─────────────────────────────────────────────── */
  var player = new Audio();

  /* ⚠ THIS ELEMENT MUST STAY IN THE DOM. Do not "tidy" the append away.
     attrib.js detects the `activation` conversion with a CAPTURING listener on
     `document` for `play`. Media events do not bubble, but they do capture —
     and capture only reaches an element that is actually IN the document, because
     a detached node has no ancestors and so `document` is not in its event path.
     While this was detached, every reading clip played silently as far as Google
     Ads and GA4 were concerned: the entire read arm recorded ZERO activations.
     That is not merely a reporting gap — it would have made any paid traffic to
     /read look worthless next to the topic pages, and taught Smart Bidding to
     starve it. player.js has never had the bug because it ships a real
     <audio id="sent-audio-el"> in its markup (player.js ~:2325).
     `display:none` keeps it inert; a control-less <audio> renders nothing anyway. */
  player.style.display = 'none';
  if (document.body) document.body.appendChild(player);
  else document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(player);
  });

  var playingEl = null;
  function stopHighlight() {
    if (playingEl) { playingEl.classList.remove('playing'); playingEl = null; }
  }
  player.addEventListener('ended', stopHighlight);
  player.addEventListener('pause', stopHighlight);

  // Preload: fetch every clip the current page can play into a blob URL so
  // taps play instantly instead of waiting on a network round-trip.
  var blobUrls = {};
  var prefetchSeen = {};
  function prefetch(ids) {
    var queue = ids.filter(function (id) { return id && !prefetchSeen[id]; });
    queue.forEach(function (id) { prefetchSeen[id] = true; });
    var i = 0, active = 0, MAX = 6;
    function pump() {
      while (active < MAX && i < queue.length) {
        (function (id) {
          active++;
          fetchClip(clipUrl(id))
            .then(function (r) { return r && r.ok ? r.blob() : null; })
            .then(function (b) { if (b) blobUrls[id] = URL.createObjectURL(b); })
            .catch(function () {})
            .then(function () { active--; pump(); });
        })(queue[i++]);
      }
    }
    pump();
  }
  /* Prefetch is a nice-to-have that was competing with the page's own load: a lesson fires
     ~18 clip fetches during boot, costing bandwidth and main-thread time that first paint
     needs. Pushed past load. Nothing breaks if a clip has not arrived when the user taps —
     play() already falls back to clipUrl(id) for anything missing from blobUrls. */
  function prefetchWhenIdle(ids) {
    var run = function () {
      if (window.requestIdleCallback) window.requestIdleCallback(function () { prefetch(ids); }, { timeout: 3000 });
      else setTimeout(function () { prefetch(ids); }, 300);
    };
    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run, { once: true });
  }
  function sectionAudioIds(key) {
    var ids = [];
    if (key === 'hub') {
      D.toneDemo.forEach(function (d) { ids.push(d.audio); });
      return ids;
    }
    var sec = sectionByKey(key);
    if (!sec) return ids;
    if (sec.kind === 'letters') {
      allItemsFor(key).forEach(function (it) { ids.push(it.audio, it.audio + '-word'); });
    } else if (sec.kind === 'vowels') {
      allItemsFor(key).forEach(function (it) { ids.push(it.audio, it.audio + '-ex'); });
    } else if (sec.kind === 'sounds') {
      D.soundsPage.sections.forEach(function (s) { s.chips.forEach(function (c) { ids.push(c.audio); }); });
      D.soundsPage.aspTest.forEach(function (w) { ids.push(w.audio); });
      D.letters.forEach(function (l) { if (!l.obsolete) ids.push(l.audio); });
    } else if (sec.kind === 'finals') {
      D.finalsPage.groups.forEach(function (g) { ids.push(g.ex.audio); });
      D.finalsPage.hearTest.forEach(function (w) { ids.push(w.audio); });
      var la = letterAudioMap();
      finalsLetterMap().forEach(function (p) { if (la[p.ch]) ids.push(la[p.ch].audio); });
      ids.push('yaw-yak-word', 'bpaw-bplaa-word', 'quiz-glai-near');
    } else if (sec.kind === 'tones') {
      D.toneRules.rows.forEach(function (r) { r.cells.forEach(function (c) { if (c) ids.push(c.audio); }); });
    } else if (sec.kind === 'clusters') {
      D.clustersPage.true.concat(D.clustersPage.false).concat(D.clustersPage.leading)
        .forEach(function (w) { ids.push(w.audio); });
    } else if (sec.kind === 'quiz') {
      D.quiz.forEach(function (w) { ids.push(w.audio); });
      D.quizB.forEach(function (w) { ids.push(w.audio); });
      D.quizC.forEach(function (w) { ids.push(w.audio); });
    }
    return ids;
  }

  function play(id, el) {
    stopHighlight();
    player.src = blobUrls[id] || clipUrl(id);
    player.play().catch(function () {});
    if (el) { el.classList.add('playing'); playingEl = el; }
  }

  /* ── offline download (whole course) ───────────────────────
     The 14 pages + read.js/read-data.js/read.css are already in the service worker's
     PRECACHE, so the course INTERFACE works offline for everyone. This engine saves the
     one missing piece — all ~208 audio clips (~1.5 MB) — into the durable
     'thaiear-audio-dl' Cache Storage cache (sw.js preserves it across versions).
     Playback is cache-first via fetchClip(), so a downloaded course plays with no
     internet on the Android app, the iOS home-screen PWA, and desktop alike.
     AUDIO_VER is part of every cached URL: bumping it on an audio release automatically
     invalidates the download and flips the hub card to "update available". */
  var DL_CACHE = 'thaiear-audio-dl';
  var DL_KEY = 'thaiear_read_offline';   // {ver, count, ts} — separate from the topics' manifest
  function clipUrl(id) { return AUDIO_BASE + id + '.mp3' + AUDIO_VER; }
  function cachesOk() { return 'caches' in window; }
  function fetchClip(url) {
    if (!cachesOk()) return fetch(url);
    return caches.open(DL_CACHE)
      .then(function (c) { return c.match(url); })
      .then(function (hit) { return hit || fetch(url); })
      .catch(function () { return fetch(url); });
  }
  function allCourseAudioIds() {
    var seen = {}, out = [];
    ['hub'].concat(D.sections.map(function (s) { return s.key; })).forEach(function (key) {
      sectionAudioIds(key).forEach(function (id) {
        if (id && !seen[id]) { seen[id] = true; out.push(id); }
      });
    });
    return out;
  }
  function dlManifest() {
    try { return JSON.parse(localStorage.getItem(DL_KEY) || 'null'); } catch (_) { return null; }
  }
  function dlDownload(onProgress) {
    var ids = allCourseAudioIds();
    var done = 0, failed = 0;
    return caches.open(DL_CACHE).then(function (cache) {
      return new Promise(function (resolve) {
        var i = 0, active = 0, MAX = 6;
        function pump() {
          if (i >= ids.length && active === 0) return resolve();
          while (active < MAX && i < ids.length) {
            (function (id) {
              active++;
              var url = clipUrl(id);
              cache.match(url)
                .then(function (hit) {
                  if (hit) return true;
                  return fetch(url).then(function (r) {
                    if (!r.ok) throw 0;
                    return cache.put(url, r).then(function () { return true; });
                  });
                })
                .catch(function () { failed++; })
                .then(function () {
                  done++;
                  if (onProgress) onProgress(done, ids.length);
                  active--; pump();
                });
            })(ids[i++]);
          }
        }
        pump();
      });
    }).then(function () {
      if (failed) throw failed;
      /* r92: record the SIZE too, so the card can tell the user what the download costs them —
         the topic pages have always shown their MB and this one never did (owner, 2026-08-01).
         Measured from the cache we just filled rather than guessed from a constant, and stored so
         the card never has to re-measure 200+ clips on every render. */
      return dlMeasure(ids).then(function (bytes) {
        localStorage.setItem(DL_KEY, JSON.stringify({
          ver: AUDIO_VER, count: ids.length, ts: Date.now(), bytes: bytes
        }));
      });
    });
  }
  /* r92 — total bytes of the course's cached clips. Reads each stored response and sums its blob
     size; a clip that cannot be read is skipped rather than failing the whole measurement, so a
     partial answer is still better than none. Called once at download time; the result is cached in
     DL_KEY. Returns 0 if Cache Storage is unavailable, and the caller then shows no figure. */
  function dlMeasure(ids) {
    if (!cachesOk()) return Promise.resolve(0);
    return caches.open(DL_CACHE).then(function (cache) {
      return Promise.all(ids.map(function (id) {
        return cache.match(clipUrl(id))
          .then(function (hit) { return hit ? hit.blob() : null; })
          .then(function (b) { return b ? b.size : 0; })
          .catch(function () { return 0; });
      })).then(function (sizes) {
        return sizes.reduce(function (a, b) { return a + b; }, 0);
      });
    }).catch(function () { return 0; });
  }
  function dlFmtMb(b) { return (b / 1048576).toFixed(1) + ' MB'; }
  function dlRemove() {
    localStorage.removeItem(DL_KEY);
    if (!cachesOk()) return Promise.resolve();
    return caches.open(DL_CACHE).then(function (cache) {
      return cache.keys().then(function (keys) {
        return Promise.all(keys.filter(function (req) {
          return /\/read(-audio)?\//.test(req.url);   // only the course's clips, never topic audio
        }).map(function (req) { return cache.delete(req); }));
      });
    }).catch(function () {});
  }
  // iOS can evict Cache Storage under pressure — the tick must never lie. Spot-check a
  // sample of clips; any miss flips the card back to a (fast, cache-first) re-download.
  function dlVerify() {
    var m = dlManifest();
    if (!m || !cachesOk()) return Promise.resolve(false);
    var ids = allCourseAudioIds();
    var sample = [];
    for (var i = 0; i < ids.length; i += Math.max(1, Math.floor(ids.length / 8))) sample.push(ids[i]);
    return caches.open(DL_CACHE).then(function (cache) {
      return Promise.all(sample.map(function (id) { return cache.match(clipUrl(id)); }));
    }).then(function (hits) {
      return hits.every(function (h) { return !!h; });
    }).catch(function () { return false; });
  }

  /* ── hub offline-download card ─────────────────────────── */
  function dlCardVisible() {
    var native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    var dev = IS_LOCALHOST || /[?&]readdl=1/.test(location.search);
    return cachesOk() && (native || standalone || dev);
  }
  function mountDlCard(root) {
    /* No offline storage on this device (plain browser tab, desktop or phone) → the app card
       takes the slot the download card would have had, in front of the same anchor. app-cta.js
       is loaded by read.html and by index.html (whose Read panel mounts this hub natively); if
       it is missing we fall through to the old silent return. */
    /* SIGNED OUT → the signup card, in BOTH environments (owner, 2026-08-15).
       In a browser it stands in for the download card that is withheld. In the app the real
       download card renders below it, so the signup card goes in FRONT of it rather than instead
       of it — otherwise a signed-out app user gets no ask at all, which is what happened when this
       branch only ran in the !dlCardVisible() case. signupHtml() drops its app zone by itself in
       the app, so the same call is right in both. */
    var A = window.ThaiEarAppCTA;
    var anchor = root.querySelector('.section-header') || root.firstChild;
    if (A && A.authGuess && A.authGuess() === 'out') {
      A.insertSignupBefore(anchor, 'read');
      if (!dlCardVisible()) return;         // browser: the card IS the slot, nothing more to draw
    } else if (!dlCardVisible()) {
      if (A) A.insertBefore(anchor, 'read');   // signed in, cannot download → the plain app card
      return;
    }
    var card = document.createElement('div');
    card.className = 'read-dl';
    card.innerHTML =
      '<div class="read-dl-row">' +
        '<div class="read-dl-text">' +
          '<div class="read-dl-title"><span class="read-dl-ico" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>' +
          '</span>Take the course offline</div>' +
          '<div class="read-dl-desc" id="read-dl-desc"></div>' +
        '</div>' +
        '<button class="read-dl-btn" id="read-dl-btn" type="button"></button>' +
      '</div>' +
      '<div class="read-dl-barwrap" id="read-dl-barwrap" hidden><div class="read-dl-bar" id="read-dl-bar"></div></div>' +
      '<div class="read-dl-foot" id="read-dl-foot"></div>';
    var anchor = root.querySelector('.section-header');
    root.insertBefore(card, anchor || root.firstChild);

    var desc = card.querySelector('#read-dl-desc');
    var btn = card.querySelector('#read-dl-btn');
    var barwrap = card.querySelector('#read-dl-barwrap');
    var bar = card.querySelector('#read-dl-bar');
    var foot = card.querySelector('#read-dl-foot');
    var busy = false;

    function render(state) {
      card.setAttribute('data-state', state);
      barwrap.hidden = state !== 'busy';
      btn.disabled = state === 'busy';
      foot.textContent = 'Your test scores are saved on this device and work offline either way.';
      if (state === 'none') {
        desc.textContent = 'Save all twelve steps and every audio clip (about 2 MB) — then learn with no internet, even in airplane mode.';
        btn.textContent = 'Download';
      } else if (state === 'busy') {
        btn.textContent = 'Saving…';
      } else if (state === 'done') {
        /* r92: show the size alongside, matching the topic pages. Older downloads predate the
           stored figure, so the sentence simply omits it rather than showing a wrong or zero MB. */
        var dlm = dlManifest();
        var mb = (dlm && typeof dlm.bytes === 'number' && dlm.bytes > 0) ? ' (' + dlFmtMb(dlm.bytes) + ')' : '';
        desc.textContent = '✓ Available offline' + mb + ' — every step, test and audio clip.';
        /* r92 — BACKFILL FOR DOWNLOADS THAT PREDATE THE FIGURE. Everyone who already had the course
           saved has a DL_KEY with no `bytes`, so they would see no size at all and reasonably
           conclude the feature was broken. Measure once, in the background, then write it into the
           record and repaint — so it appears by itself and never has to be measured again.
           Guarded by `dlm` so it cannot run when nothing is downloaded, and it only ever ADDS a
           field: a failed or zero measurement leaves the record untouched rather than storing a
           wrong figure. */
        if (dlm && typeof dlm.bytes !== 'number') {
          dlMeasure(allCourseAudioIds()).then(function (bytes) {
            if (!bytes) return;
            var cur = dlManifest(); if (!cur) return;
            cur.bytes = bytes;
            try { localStorage.setItem(DL_KEY, JSON.stringify(cur)); } catch (_) {}
            if (desc.isConnected) desc.textContent = '✓ Available offline (' + dlFmtMb(bytes) + ') — every step, test and audio clip.';
          }).catch(function () {});
        }
        btn.textContent = 'Remove';
      } else if (state === 'update') {
        desc.textContent = 'The course audio has been updated since you saved it — refresh your download.';
        btn.textContent = 'Update';
      } else if (state === 'repair') {
        desc.textContent = 'Some saved audio is missing — your device may have cleared it to free space. A quick repair re-saves it.';
        btn.textContent = 'Repair';
      } else if (state === 'error') {
        desc.textContent = 'Couldn’t finish the download — check your connection and try again.';
        btn.textContent = 'Retry';
      }
    }
    function startDownload() {
      if (busy) return;
      busy = true;
      render('busy');
      dlDownload(function (done, total) {
        desc.textContent = 'Saving audio… ' + done + ' of ' + total;
        bar.style.width = Math.round(done / total * 100) + '%';
      }).then(function () { busy = false; render('done'); })
        .catch(function () { busy = false; render('error'); });
    }
    btn.addEventListener('click', function () {
      var state = card.getAttribute('data-state');
      if (state === 'done') {
        if (window.confirm('Remove the offline copy of the Read Thai course? You can download it again any time.')) {
          dlRemove().then(function () { render('none'); });
        }
      } else {
        startDownload();
      }
    });

    var m = dlManifest();
    if (!m) render('none');
    else if (m.ver !== AUDIO_VER) render('update');
    else {
      render('done');
      dlVerify().then(function (ok) { if (!ok) render('repair'); });
    }
  }

  /* ── progress store ────────────────────────────────────── */
  var LS_KEY = 'thaiear_read_v1';
  function loadProg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; }
  }
  function saveProg(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (_) {} }
  function recordResult(section, mode, correct, total) {
    var p = loadProg();
    var key = section + ':' + mode;
    var rec = p[key] || { attempts: 0, bestCorrect: 0, bestTotal: 0 };
    rec.attempts += 1;
    rec.sumCorrect = (rec.sumCorrect || 0) + correct;   // running totals → average
    rec.sumTotal = (rec.sumTotal || 0) + total;
    if (rec.bestTotal === 0 || correct / total > rec.bestCorrect / rec.bestTotal ||
        (correct / total === rec.bestCorrect / rec.bestTotal && total > rec.bestTotal)) {
      rec.bestCorrect = correct; rec.bestTotal = total;
    }
    rec.lastCorrect = correct; rec.lastTotal = total; rec.lastDate = new Date().toISOString().slice(0, 10);
    p[key] = rec;
    saveProg(p);
  }
  function sectionStats(sectionKey) {
    var p = loadProg(), attempts = 0, best = null;
    Object.keys(p).forEach(function (k) {
      if (k.indexOf(sectionKey + ':') !== 0) return;
      var r = p[k];
      attempts += r.attempts;
      if (!best || (r.bestCorrect / r.bestTotal) > (best.c / best.t)) best = { c: r.bestCorrect, t: r.bestTotal };
    });
    return { attempts: attempts, best: best };
  }
  function modeStats(sectionKey, mode) {
    var r = loadProg()[sectionKey + ':' + mode];
    return r || null;
  }
  // The canonical tests per section kind, with display names — used everywhere
  // a per-test progress list is shown (hub cards + test-panel headers).
  function sectionModes(sec) {
    if (sec.kind === 'letters') return [['s2l', 'Sound → letter'], ['l2s', 'Letter → sound']];
    if (sec.kind === 'vowels')  return [['s2l', 'Sound → vowel'], ['l2s', 'Vowel → sound']];
    if (sec.kind === 'sounds')  return [['asp', 'Aspirated or not?'], ['fam', 'Which family?']];
    // finals: 'l2f' was ONE 12-random-letter test; it is now the two fixed halves l2fA/l2fB that
    // between them cover all 35 letters. The old 'finals:l2f' progress record is deliberately
    // orphaned rather than migrated — a "best 12/12" from the old test would sit on a part that
    // is now 18 questions and, being ratio-ranked, could never be displaced.
    if (sec.kind === 'finals')  return [['l2fA', 'Letter → final sound 1'], ['l2fB', 'Letter → final sound 2'], ['pick', 'Round up the letters'], ['hear', 'Hear the ending']];
    if (sec.kind === 'clusters') return [['read', 'Read the cluster'], ['hear', 'Hear → pick the word']];
    if (sec.kind === 'quiz')    return [['partA', 'Part A'], ['partB', 'Part B'], ['partC', 'Part C']];
    return [];
  }
  // One line per test: "Sound → letter — 2× · best 8/9" (or "not yet").
  function statLinesHtml(sec) {
    var ms = sectionModes(sec);
    if (!ms.length) return '';
    return ms.map(function (m) {
      var r = modeStats(sec.key, m[0]);
      var right = r ? (r.attempts + '× · best ' + r.bestCorrect + '/' + r.bestTotal) : 'not yet';
      return '<div class="pp-line"><span class="pp-name">' + m[1] + '</span> — ' + right + '</div>';
    }).join('');
  }
  function anyTested(sec) {
    return sectionModes(sec).some(function (m) { return !!modeStats(sec.key, m[0]); });
  }

  /* ── helpers ───────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  var SVG_PLAY = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><polygon points="4,2 13,8 4,14"/></svg>';
  var SVG_SPEAKER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  var SVG_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
  function sectionByKey(key) {
    for (var i = 0; i < D.sections.length; i++) if (D.sections[i].key === key) return D.sections[i];
    return null;
  }
  function itemsFor(key) {
    var pool = (key.charAt(0) === 'v') ? D.vowels : D.letters;
    return pool.filter(function (it) { return it.cls === key && !it.obsolete; });
  }
  function allItemsFor(key) {
    var pool = (key.charAt(0) === 'v') ? D.vowels : D.letters;
    return pool.filter(function (it) { return it.cls === key; });
  }
  function isVowelSection(key) { return key.charAt(0) === 'v'; }

  /* ── glossary: first instance of a technical term on each page gets a
     blue underlined marker + ⓘ; hover/click opens a definition popover
     with a link to the step where the term is taught. ─────────────── */
  var GLOSSARY = {
    // "stop" is the term the reader meets EARLIEST and had no entry for: the finals page (step 8)
    // says "Three are stops" and labels every group "stop · dead", a whole step before the sounds
    // page (step 9) defines it. Every other term on that page was already covered.
    stop:        { re: /\bstops?\b/i, title: 'stop',
                   def: 'A sound made by blocking the air completely, then releasing it in a burst: g, k, b, p, d, t, j, ch. Only stops can be aspirated or unaspirated — and at the end of a Thai syllable the burst never comes.', ref: 'sounds' },
    aspirated:   { re: /\b(aspirated|aspiration)\b/i, title: 'aspirated',
                   def: 'Said with a puff of air right after the consonant — hold your palm in front of your mouth and you’ll feel it. English p, t, k at the start of a word are aspirated.', ref: 'sounds' },
    unaspirated: { re: /\bunaspirated\b/i, title: 'unaspirated',
                   def: 'Said with no puff of air. Thai ป and ต are unaspirated — harder and flatter than English p and t.', ref: 'sounds' },
    fricative:   { re: /\bfricatives?\b/i, title: 'fricative',
                   def: 'A sound made by forcing air through a narrow gap: s, f, h. Friction, not a burst.', ref: 'sounds' },
    sonorant:    { re: /\bsonorants?\b/i, title: 'sonorant',
                   def: 'A sound that can ring on continuously: m, n, ng, y, r, l, w.', ref: 'sounds' },
    voiced:      { re: /\bvoiced\b/i, title: 'voiced',
                   def: 'Made with the voicebox vibrating from the start. Put your fingers on your throat and say English b — the buzz is voicing. b and d are voiced; p and t are not.', ref: 'sounds' },
    nasal:       { re: /\bnasals?\b/i, title: 'nasal',
                   def: 'A sound where the air comes out through the nose: m, n, ng.' },
    liquid:      { re: /\bliquids?\b/i, title: 'liquid',
                   def: 'The flowing r and l sounds.' },
    glide:       { re: /\bglides?\b/i, title: 'glide',
                   def: 'A consonant that is almost a vowel: y and w.' },
    live:        { re: /\blive\b/i, title: 'live syllable',
                   def: 'A syllable that ends ringing on — a long vowel, or an m, n, ng, y or w sound at the end.', ref: 'tones' },
    dead:        { re: /\bdead\b/i, title: 'dead syllable',
                   def: 'A syllable that stops abruptly — a short open vowel, or a p, t or k sound at the end.', ref: 'tones' }
  };
  var currentSecKey = null;

  function markTerms(scope) {
    Object.keys(GLOSSARY).forEach(function (key) {
      var g = GLOSSARY[key];
      // No marker on the page that TEACHES the term — the tooltip exists so a
      // reader elsewhere needn't navigate away; here the explanation is on-page.
      if (g.ref && g.ref === currentSecKey) return;
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!n.nodeValue || !g.re.test(n.nodeValue)) return NodeFilter.FILTER_SKIP;
          var el = n.parentElement;
          if (!el) return NodeFilter.FILTER_SKIP;
          if (el.closest('.test-panel, .gl-term, .gl-pop, button, .tone-chip, .tt-ex, .letter-card, .tone-table, h1, h2, h3, .read-h2, .read-eyebrow, .path-card')) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var node = walker.nextNode();
      if (!node) return;
      var m = node.nodeValue.match(g.re);
      var word = node.splitText(m.index);
      word.splitText(m[0].length);
      var span = document.createElement('span');
      span.className = 'gl-term';
      span.setAttribute('data-term', key);
      span.innerHTML = esc(word.nodeValue) + '<sup class="gl-i">i</sup>';
      word.parentNode.replaceChild(span, word);
    });
  }

  var popEl = null;
  function glPop() {
    if (popEl) return popEl;
    popEl = document.createElement('div');
    popEl.className = 'gl-pop';
    popEl.setAttribute('hidden', '');
    popEl.innerHTML = '<button class="gl-x" type="button" aria-label="Dismiss">×</button>' +
      '<div class="gl-title"></div><div class="gl-def"></div><a class="gl-ref" href="#"></a>';
    document.body.appendChild(popEl);
    popEl.querySelector('.gl-x').addEventListener('click', closePop);
    return popEl;
  }
  function closePop() { if (popEl) popEl.setAttribute('hidden', ''); }
  function openPop(termEl) {
    var key = termEl.getAttribute('data-term');
    var g = GLOSSARY[key];
    if (!g) return;
    var pop = glPop();
    pop.querySelector('.gl-title').textContent = g.title;
    pop.querySelector('.gl-def').textContent = g.def;
    var refA = pop.querySelector('.gl-ref');
    var refSec = g.ref ? sectionByKey(g.ref) : null;
    if (refSec && refSec.key !== currentSecKey) {
      refA.textContent = 'Explained in Step ' + (D.sections.indexOf(refSec) + 1) + ' — ' + refSec.title;
      refA.setAttribute('href', pageHref(refSec.page));
      refA.style.display = 'block';
    } else if (refSec) {
      refA.textContent = 'Explained in full further down this page.';
      refA.removeAttribute('href');
      refA.style.display = 'block';
    } else {
      refA.style.display = 'none';
    }
    pop.removeAttribute('hidden');
    var r = termEl.getBoundingClientRect();
    var top = r.bottom + window.scrollY + 6;
    var left = Math.max(10, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 270));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.gl-term') : null;
    if (t) { openPop(t); return; }
    if (popEl && !popEl.hasAttribute('hidden') && !e.target.closest('.gl-pop')) closePop();
  });
  document.addEventListener('mouseover', function (e) {
    var t = e.target.closest ? e.target.closest('.gl-term') : null;
    if (t) openPop(t);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

  /* ── eyebrow + prev/next ───────────────────────────────── */
  function renderChrome(sec) {
    var idx = D.sections.indexOf(sec);
    // The results page is an overview, not a numbered step — 12 learning steps.
    var stepCount = D.sections.filter(function (s) { return s.kind !== 'results'; }).length;
    var eyebrow = document.getElementById('read-eyebrow');
    if (eyebrow) {
      eyebrow.textContent = sec.kind === 'results'
        ? 'Read Thai · Your results'
        : 'Read Thai · Step ' + (idx + 1) + ' of ' + stepCount;
    }
    var intro = document.getElementById('read-intro');
    if (intro) {
      if (sec.intro) intro.textContent = sec.intro;
      else intro.style.display = 'none';
    }
    var nav = document.getElementById('read-nav');
    if (!nav) return;
    var prev = idx > 0 ? D.sections[idx - 1] : null;
    var next = idx < D.sections.length - 1 ? D.sections[idx + 1] : null;
    function btn(s, side) {
      if (!s) {
        return '<span class="read-nav-btn disabled ' + (side === 'r' ? 'read-nav-right' : '') + '">' +
          '<span class="read-nav-label">' + (side === 'r' ? 'Next' : 'Previous') + '</span>' +
          '<span class="read-nav-name">—</span></span>';
      }
      return '<a class="read-nav-btn ' + (side === 'r' ? 'read-nav-right' : '') + '" href="' + pageHref(s.page) + '">' +
        '<span class="read-nav-label">' + (side === 'r' ? 'Next' : 'Previous') + '</span>' +
        '<span class="read-nav-name">' + esc(s.short) + '</span></a>';
    }
    nav.innerHTML = btn(prev, 'l') + btn(next, 'r');
    var all = document.getElementById('read-all');
    // r130: the hub now lives natively in the index's Read panel (mountHub, above), so this
    // back-link routes THERE, not to read.html — index.html#read-lessons is a new deep-link hash
    // the index side handles (opens the Read panel, scrolls to the learning-path/#lessons position
    // minus ~72px; coordinator's side, not this file). read.html itself is still live for SEO/direct
    // visits and its OWN #lessons hash-landing (scrollToLessons, boot(), above) is unchanged.
    if (all) all.innerHTML = '<a href="index.html#read-lessons">← All reading sections</a>';
  }

  /* ── explainer grid (letters + vowels share it) ────────── */
  function letterCardHtml(it, vowel) {
    var main = vowel
      ? '<div class="lc-name">' + esc(it.name) + '</div><div class="lc-sound">' + esc(it.sound) + '</div>'
      : '<div class="lc-name">' + esc(it.name) + '</div><div class="lc-sound">&ldquo;' + esc(it.en) + '&rdquo;</div>';
    var word = vowel
      ? '<button class="lc-word" data-audio="' + it.audio + '-ex" type="button">' + SVG_PLAY +
        '<span class="th">' + esc(it.ex) + '</span> ' + esc(it.ext) + ' · ' + esc(it.en) + '</button>'
      : '<button class="lc-word" data-audio="' + it.audio + '-word" type="button">' + SVG_PLAY +
        '<span class="th">' + esc(it.word) + '</span> ' + esc(it.wt) + '</button>';
    return '<div class="letter-card' + (it.obsolete ? ' obsolete' : '') + '" data-audio="' + it.audio + '" role="button" tabindex="0" aria-label="Play ' + esc(it.name) + '">' +
      (it.obsolete ? '<span class="obsolete-chip">obsolete</span>' : '') +
      '<span class="lc-hint">' + SVG_SPEAKER + '</span>' +
      '<div class="lc-ch">' + esc(it.ch) + '</div>' + main + word + '</div>';
  }
  function wireGrid(root) {
    root.querySelectorAll('.letter-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        var wordBtn = e.target.closest('.lc-word');
        if (wordBtn) { e.stopPropagation(); play(wordBtn.getAttribute('data-audio'), wordBtn); return; }
        play(card.getAttribute('data-audio'), card);
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(card.getAttribute('data-audio'), card); }
      });
    });
  }

  /* ── test engine ───────────────────────────────────────── */
  /* ── sign-in gate ──────────────────────────────────────────
     The reading section is free to browse, but the tests need a (free)
     account so progress is tracked — same tier as member topics. auth.js
     (loaded by nav.js) exposes window.ThaiEarAuth. `?testauth=1` bypasses
     the gate for localhost previewing. */
  /* Sign-in gate is LIVE (free-member tier for all reading tests).
     `?testauth=1` remains as the localhost preview bypass. */
  var GATE_OFF = false;
  var AUTH_BYPASS = GATE_OFF || /[?&]testauth=1/.test(location.search);
  function isSignedIn() {
    try {
      return !!(window.ThaiEarAuth && window.ThaiEarAuth.getUser && window.ThaiEarAuth.getUser());
    } catch (_) { return false; }
  }
  function signInGateHtml() {
    var here = location.pathname.split('/').pop() || 'read.html';
    return '<div class="signin-gate">' +
      '<div class="sg-title">Sign in to test yourself</div>' +
      '<p>The tests are free — signing in means every attempt, best score and average is saved to your results page.</p>' +
      '<a class="rd-play-pill sg-btn" href="join.html?feature=1&next=' + encodeURIComponent(here) + '">Sign in — it\'s free</a>' +
      '</div>';
  }
  // Returns true (and renders the gate) when the visitor must sign in first.
  function requireSignIn(panel) {
    if (isSignedIn() || AUTH_BYPASS) return false;
    panel.innerHTML = signInGateHtml();
    return true;
  }
  // Auth resolves async after page load — re-check briefly so a signed-in
  // user landing on a gated render gets their content without a reload.
  function watchAuth(cb) {
    var tries = 0;
    var iv = setInterval(function () {
      if (isSignedIn()) { clearInterval(iv); cb(); }
      else if (++tries > 16) clearInterval(iv);
    }, 600);
  }

  // While a test runs, hide the explainer content above it — otherwise the
  // answers (letter grids, family lists) are visible by scrolling up.
  function hideAnswers() {
    document.body.classList.add('te-testing');
    window.scrollTo(0, 0);
  }
  function showAnswers() { document.body.classList.remove('te-testing'); }

  // mode 's2l' = hear the name, pick the symbol; 'l2s' = see the symbol, pick the sound.
  function startTest(panel, sec, mode) {
    if (requireSignIn(panel)) return;
    hideAnswers();
    var items = itemsFor(sec.key);
    var vowel = isVowelSection(sec.key);
    var order = shuffle(items);
    var qi = 0, score = 0, answered = false;

    function makeChoices(target) {
      var others = shuffle(items.filter(function (x) { return x !== target; })).slice(0, 3);
      return shuffle(others.concat([target]));
    }
    // Score is repainted in place on grading, not only on the next render — the question now stays
    // on screen after it's answered, so a header still showing the old score next to a "Correct"
    // message would look broken.
    function countText() { return 'Question ' + (qi + 1) + ' of ' + order.length + ' · Score ' + score; }
    function paintCount() {
      var el = panel.querySelector('.tq-count');
      if (el) el.textContent = countText();
    }
    function progressHtml() {
      return '<div class="tq-top">' +
        '<span class="tq-count">' + countText() + '</span>' +
        '<span class="tq-actions">' +
        '<button class="tq-icon-btn" id="tq-refresh" type="button" title="Shuffle and restart">' + SVG_REFRESH + 'Restart</button>' +
        '<button class="tq-icon-btn" id="tq-exit" type="button">Exit</button>' +
        '</span></div>' +
        '<div class="tq-bar"><div class="tq-bar-fill" style="width:' + (qi / order.length * 100) + '%"></div></div>';
    }
    function renderQuestion() {
      answered = false;
      var target = order[qi];
      var choices = makeChoices(target);
      var html = progressHtml();
      if (mode === 's2l') {
        html += '<div class="tq-question">' +
          '<div class="tq-prompt">Listen, then choose the matching ' + (vowel ? 'vowel' : 'letter') + '</div>' +
          '<button class="tq-big-play" id="tq-play" type="button">' + SVG_SPEAKER + ' Play sound</button></div>' +
          '<div class="tq-choices">' + choices.map(function (c, i) {
            return '<button class="tq-choice" data-i="' + i + '" type="button"><span class="c-sym">' + esc(c.ch) + '</span></button>';
          }).join('') + '</div>';
      } else {
        html += '<div class="tq-question">' +
          '<div class="tq-prompt">Which sound is this ' + (vowel ? 'vowel' : 'letter') + '? Play each option, then choose.</div>' +
          '<div class="tq-big-symbol">' + esc(target.ch) + '</div></div>' +
          '<div class="tq-choices">' + choices.map(function (c, i) {
            return '<div class="tq-choice audio-opt" data-i="' + i + '">' +
              '<span class="c-play">' + SVG_PLAY + '</span>' +
              '<span class="c-label">Option ' + (i + 1) + '</span>' +
              '<button class="c-pick" type="button">This one</button></div>';
          }).join('') + '</div>';
      }
      html += '<div class="tq-feedback" id="tq-feedback"></div>';
      panel.innerHTML = html;

      var fb = panel.querySelector('#tq-feedback');
      // Same contract as the custom-test runner: never auto-advance, never auto-replay. The learner
      // presses Next when they're done comparing; the HINT tells them the options are tappable.
      function showNextBtn() {
        if (panel.querySelector('#tq-next')) return;
        fb.insertAdjacentHTML('beforeend', '<br><button class="tq-next" id="tq-next" type="button">Next →</button>');
        panel.querySelector('#tq-next').addEventListener('click', nextQuestion);
      }
      var HINT = '<span class="tq-hint">Tap the other options to hear and compare.</span>';
      function finishQuestion(chosenIdx, choiceEls) {
        if (answered) return;
        answered = true;
        var right = choices[chosenIdx] === target;
        choiceEls.forEach(function (el, i) {
          if (choices[i] === target) el.classList.add(right && i === chosenIdx ? 'correct' : 'revealed');
        });
        choiceEls[chosenIdx].classList.add(right ? 'correct' : 'wrong');
        if (right) score++;
        fb.innerHTML = (right
          ? '<span class="ok">Correct — ' + esc(target.name) + '</span>'
          : '<span class="no">Not quite — this is ' + esc(target.name) + '</span>') + HINT;
        paintCount();
        showNextBtn();
      }

      var choiceEls = Array.prototype.slice.call(panel.querySelectorAll('.tq-choice'));
      if (mode === 's2l') {
        var playBtn = panel.querySelector('#tq-play');
        playBtn.addEventListener('click', function () { play(target.audio, playBtn); });
        setTimeout(function () { play(target.audio, playBtn); }, 250);
        choiceEls.forEach(function (el) {
          var i = parseInt(el.getAttribute('data-i'), 10);
          el.addEventListener('click', function () {
            if (answered) { play(choices[i].audio, el); return; }
            finishQuestion(i, choiceEls);
          });
        });
      } else {
        choiceEls.forEach(function (el) {
          var i = parseInt(el.getAttribute('data-i'), 10);
          el.addEventListener('click', function (e) {
            if (e.target.closest('.c-pick')) { if (!answered) finishQuestion(i, choiceEls); return; }
            play(choices[i].audio, el);
          });
        });
      }
      panel.querySelector('#tq-refresh').addEventListener('click', function () { startTest(panel, sec, mode); });
      panel.querySelector('#tq-exit').addEventListener('click', function () { renderTestHome(panel, sec); });
    }
    function nextQuestion() {
      qi++;
      if (qi >= order.length) { renderResult(); return; }
      renderQuestion();
    }
    function renderResult() {
      recordResult(sec.key, mode, score, order.length);
      var pct = score / order.length;
      var verdict = pct === 1 ? 'Perfect — you own this set.' :
        pct >= 0.8 ? 'Strong — a couple more runs and it’s automatic.' :
        pct >= 0.5 ? 'Good start — shuffle and go again.' :
        'Keep at it — replay the letters above, then retest.';
      var st = modeStats(sec.key, mode);
      panel.innerHTML = '<div class="tq-result">' +
        '<div class="tq-score">' + score + ' / ' + order.length + '</div>' +
        '<div class="tq-verdict">' + verdict +
        (st ? '<br>Attempt ' + st.attempts + ' · best ' + st.bestCorrect + '/' + st.bestTotal : '') + '</div>' +
        '<div class="tq-result-btns">' +
        '<button class="rd-play-pill" id="tq-again" type="button">' + SVG_REFRESH + ' Test again (reshuffled)</button>' +
        '<button class="rd-ghost-pill" id="tq-switch" type="button">Switch mode</button>' +
        '<button class="rd-ghost-pill" id="tq-back" type="button">Done</button>' +
        '</div></div>';
      panel.querySelector('#tq-again').addEventListener('click', function () { startTest(panel, sec, mode); });
      panel.querySelector('#tq-switch').addEventListener('click', function () { startTest(panel, sec, mode === 's2l' ? 'l2s' : 's2l'); });
      panel.querySelector('#tq-back').addEventListener('click', function () { renderTestHome(panel, sec); });
    }
    renderQuestion();
  }

  function modeRecordHtml(sec, mode) {
    var r = modeStats(sec.key, mode);
    if (!r) return '<span class="tm-record">Not tested yet</span>';
    return '<span class="tm-record">Tested ' + r.attempts + '× · best ' + r.bestCorrect + '/' + r.bestTotal + '</span>';
  }
  function renderTestHome(panel, sec) {
    showAnswers();
    var vowel = isVowelSection(sec.key);
    var noun = vowel ? 'vowel' : 'letter';
    panel.innerHTML =
      '<div class="test-head"><h2>Test yourself</h2></div>' +
      (anyTested(sec) ? '<div class="test-stat-lines">' + statLinesHtml(sec) + '</div>' : '') +
      '<p class="test-sub">Multiple choice over every ' + noun + ' in this section, in a fresh random order each run — so you learn the sounds and shapes, not the sequence.</p>' +
      '<div class="test-modes">' +
      '<button class="test-mode-btn" id="mode-s2l" type="button">' +
      '<span class="tm-title">' + SVG_SPEAKER + ' Sound → ' + noun + '</span>' +
      '<span class="tm-desc">Hear a ' + noun + '’s name, pick the right symbol from four.</span>' +
      modeRecordHtml(sec, 's2l') + '</button>' +
      '<button class="test-mode-btn" id="mode-l2s" type="button">' +
      '<span class="tm-title"><span style="font-family:var(--font-thai);font-weight:600">' + (vowel ? 'า' : 'ก') + '</span> ' + (vowel ? 'Vowel' : 'Letter') + ' → sound</span>' +
      '<span class="tm-desc">See a symbol, play the four sounds, pick the one that matches.</span>' +
      modeRecordHtml(sec, 'l2s') + '</button>' +
      '</div>';
    panel.querySelector('#mode-s2l').addEventListener('click', function () { startTest(panel, sec, 's2l'); });
    panel.querySelector('#mode-l2s').addEventListener('click', function () { startTest(panel, sec, 'l2s'); });
  }

  /* ── generic custom test runner (sounds + finals pages) ──
     buildFn() -> array of questions:
       { promptText, symbol?, audio?, choices: [{label, thai?}], correctIdx (single)
         OR multi: true + correctSet: [idx,...], answerText }                    */
  function runCustomTest(panel, sec, mode, buildFn, homeFn) {
    if (requireSignIn(panel)) return;
    hideAnswers();
    var qs = buildFn();
    var qi = 0, score = 0, answered = false;

    // Score is repainted in place the moment a question is graded, not only on the next render —
    // the question now stays on screen after it's answered, so a header still reading the old score
    // next to a "Correct" message would look broken.
    function countText() { return 'Question ' + (qi + 1) + ' of ' + qs.length + ' · Score ' + score; }
    function paintCount() {
      var el = panel.querySelector('.tq-count');
      if (el) el.textContent = countText();
    }
    function head() {
      return '<div class="tq-top">' +
        '<span class="tq-count">' + countText() + '</span>' +
        '<span class="tq-actions">' +
        '<button class="tq-icon-btn" id="tq-refresh" type="button" title="Shuffle and restart">' + SVG_REFRESH + 'Restart</button>' +
        '<button class="tq-icon-btn" id="tq-exit" type="button">Exit</button>' +
        '</span></div>' +
        '<div class="tq-bar"><div class="tq-bar-fill" style="width:' + (qi / qs.length * 100) + '%"></div></div>';
    }
    function next() {
      qi++;
      if (qi >= qs.length) { result(); return; }
      render();
    }
    function result() {
      recordResult(sec.key, mode, score, qs.length);
      var pct = score / qs.length;
      var verdict = pct === 1 ? 'Perfect — you own this.' :
        pct >= 0.8 ? 'Strong — a couple more runs and it’s automatic.' :
        pct >= 0.5 ? 'Good start — shuffle and go again.' :
        'Keep at it — re-read the section above, then retest.';
      var st = modeStats(sec.key, mode);
      panel.innerHTML = '<div class="tq-result">' +
        '<div class="tq-score">' + score + ' / ' + qs.length + '</div>' +
        '<div class="tq-verdict">' + verdict +
        (st ? '<br>Attempt ' + st.attempts + ' · best ' + st.bestCorrect + '/' + st.bestTotal : '') + '</div>' +
        '<div class="tq-result-btns">' +
        '<button class="rd-play-pill" id="tq-again" type="button">' + SVG_REFRESH + ' Test again (reshuffled)</button>' +
        '<button class="rd-ghost-pill" id="tq-back" type="button">Done</button>' +
        '</div></div>';
      panel.querySelector('#tq-again').addEventListener('click', function () { runCustomTest(panel, sec, mode, buildFn, homeFn); });
      panel.querySelector('#tq-back').addEventListener('click', function () { homeFn(panel, sec); });
    }
    function render() {
      answered = false;
      var q = qs[qi];
      var html = head() + '<div class="tq-question">' +
        (q.promptText ? '<div class="tq-prompt">' + q.promptText + '</div>' : '') +
        (q.symbol ? '<div class="tq-big-symbol' + (q.audio ? ' clickable" title="Tap to hear this letter' : '') + '">' + esc(q.symbol) + '</div>' : '') +
        (q.audio && !q.symbol ? '<button class="tq-big-play" id="tq-play" type="button">' + SVG_SPEAKER + ' ' + (q.playLabel || 'Play word') + '</button>' : '') +
        '</div>' +
        '<div class="tq-choices choices-' + q.choices.length + '">' + q.choices.map(function (c, i) {
          return '<button class="tq-choice txt" data-i="' + i + '" type="button">' +
            (c.thai ? '<span class="c-sym">' + esc(c.thai) + '</span>' : '<span class="c-txt">' + esc(c.label) + '</span>') +
            '</button>';
        }).join('') + '</div>' +
        (q.multi ? '<div style="text-align:center;margin-top:12px"><button class="tq-next" id="tq-submit" type="button">Check</button></div>' : '') +
        '<div class="tq-feedback" id="tq-feedback"></div>';
      panel.innerHTML = html;

      var fb = panel.querySelector('#tq-feedback');
      var tiles = Array.prototype.slice.call(panel.querySelectorAll('.tq-choice'));
      if (q.audio) {
        var pb = panel.querySelector('#tq-play');
        if (pb) pb.addEventListener('click', function () { play(q.audio, pb); });
        var sym = panel.querySelector('.tq-big-symbol.clickable');
        if (sym) sym.addEventListener('click', function () { play(q.audio, sym); });
        setTimeout(function () { play(q.audio, pb || sym); }, 250);
      }
      // Every graded question ends the same way: feedback, then a "Next →" the learner presses when
      // they're ready. Nothing auto-advances and nothing auto-replays — a right answer isn't proof
      // they knew it, and a wrong one is when they most want to sit and compare. Audio they've
      // already heard is theirs to replay by tapping (the symbol / the tiles / the play button).
      function showNextBtn() {
        if (panel.querySelector('#tq-next')) return;
        fb.insertAdjacentHTML('beforeend', '<br><button class="tq-next" id="tq-next" type="button">Next →</button>');
        panel.querySelector('#tq-next').addEventListener('click', next);
      }
      // revealAudio is the ONE sound that still plays on grading, because it is not a replay:
      // "Read the cluster" shows a written word with no audio at all until it's answered (its mode
      // description promises "the audio confirms after you answer"), so this is the first hearing.
      // Make the word tappable once answered — before that a tap would hand over the answer.
      function playReveal() {
        if (!q.revealAudio) return;
        play(q.revealAudio);
        if (q.audio) return;                       // already has its own replay affordance
        var s = panel.querySelector('.tq-big-symbol');
        if (!s) return;
        s.classList.add('clickable');
        s.setAttribute('title', 'Tap to hear this word again');
        s.addEventListener('click', function () { play(q.revealAudio, s); });
      }
      // Answering opens a post-answer review: the tiles lock as answers but stay tappable so any
      // that carry audio can be played and compared before moving on. Locking is a CLASS, not the
      // `disabled` attribute — a disabled button never fires a click, which is exactly what was
      // swallowing those taps on "Hear → pick the word". The `answered` guard is what actually
      // prevents re-grading, so nothing is lost by dropping the attribute.
      function lockTiles() {
        tiles.forEach(function (el, j) {
          el.classList.add('locked');
          if (q.choices[j] && q.choices[j].audio) el.classList.add('replayable');
        });
      }
      var anyTileAudio = q.choices.some(function (c) { return !!c.audio; });
      var REPLAY_HINT = '<span class="tq-hint">Tap the ' + (q.multi ? 'letters' : 'options') +
        ' to hear them again and compare.</span>';
      function gradeSingle(i) {
        if (answered) return;
        answered = true;
        var right = i === q.correctIdx;
        tiles.forEach(function (el, j) {
          if (j === q.correctIdx) el.classList.add(right && j === i ? 'correct' : 'revealed');
        });
        tiles[i].classList.add(right ? 'correct' : 'wrong');
        lockTiles();
        if (right) { score++; paintCount(); }
        fb.innerHTML = (right
          ? '<span class="ok">Correct — ' + esc(q.answerText) + '</span>'
          : '<span class="no">Not quite — ' + esc(q.answerText) + '</span>') +
          (anyTileAudio ? REPLAY_HINT : '');
        playReveal();
        showNextBtn();
      }
      function gradeMulti() {
        if (answered) return;
        answered = true;
        var right = true;
        tiles.forEach(function (el, j) {
          var shouldBe = q.correctSet.indexOf(j) !== -1;
          var isSel = el.classList.contains('selected');
          if (shouldBe) el.classList.add(isSel ? 'correct' : 'revealed');
          else if (isSel) el.classList.add('wrong');
          if (shouldBe !== isSel) right = false;
        });
        var sub = panel.querySelector('#tq-submit');
        if (sub) sub.style.display = 'none';
        lockTiles();
        if (right) { score++; paintCount(); }
        fb.innerHTML = (right
          ? '<span class="ok">Correct — ' + esc(q.answerText) + '</span>'
          : '<span class="no">Not quite — ' + esc(q.answerText) + '</span>') +
          (anyTileAudio ? REPLAY_HINT : '');
        showNextBtn();
      }
      tiles.forEach(function (el, i) {
        el.addEventListener('click', function () {
          if (answered) {
            // post-answer review: ANY tile that has audio speaks it, so the learner can hear the
            // one they picked against the right one. Was multi-only, which left the single-choice
            // "Hear → pick the word" silent even though its tiles are real words with recordings.
            if (q.choices[i].audio) play(q.choices[i].audio, el);
            return;
          }
          if (q.multi) {
            el.classList.toggle('selected');
            // reinforce: a letter tile speaks its name as you pick it (multi only — this is a
            // selection, not the answer; the answer is the Check button. A single-choice tap IS
            // the answer, so it must stay silent.)
            if (q.choices[i].audio) play(q.choices[i].audio, el);
          } else gradeSingle(i);
        });
      });
      if (q.multi) panel.querySelector('#tq-submit').addEventListener('click', gradeMulti);
      panel.querySelector('#tq-refresh').addEventListener('click', function () { runCustomTest(panel, sec, mode, buildFn, homeFn); });
      panel.querySelector('#tq-exit').addEventListener('click', function () { homeFn(panel, sec); });
    }
    render();
  }

  function customModeBtn(sec, mode, id, title, desc) {
    return '<button class="test-mode-btn" id="' + id + '" type="button">' +
      '<span class="tm-title">' + SVG_SPEAKER + ' ' + title + '</span>' +
      '<span class="tm-desc">' + desc + '</span>' +
      modeRecordHtml(sec, mode) + '</button>';
  }
  function chipRow(chips) {
    return '<div class="tone-demo-row chips-' + chips.length + '">' + chips.map(function (c) {
      return '<button class="tone-chip" data-audio="' + c.audio + '" type="button">' +
        '<div class="tc-thai">' + esc(c.thai) + '</div>' +
        '<div class="tc-t">' + esc(c.t) + '</div>' +
        '<div class="tc-tone">' + esc(c.tag || '') + '</div>' +
        '<div class="tc-en">' + esc(c.en) + '</div></button>';
    }).join('') + '</div>';
  }
  function wireChips(root) {
    root.querySelectorAll('.tone-chip').forEach(function (chip) {
      chip.addEventListener('click', function () { play(chip.getAttribute('data-audio'), chip); });
    });
  }

  /* ── sounds page ───────────────────────────────────────── */
  // Test families derive from the rule panel's data — single source.
  function famData() {
    return D.soundsPage.rule.families.map(function (f) {
      return { label: f.label.replace(/s$/, ''), chars: f.letters.replace(/[^ก-ฮ]/g, '') };
    });
  }
  function soundsTestHome(panel, sec) {
    showAnswers();
    panel.innerHTML =
      '<div class="test-head"><h2>Test yourself</h2></div>' +
      (anyTested(sec) ? '<div class="test-stat-lines">' + statLinesHtml(sec) + '</div>' : '') +
      '<p class="test-sub">Both tests shuffle every run.</p>' +
      '<div class="test-modes">' +
      customModeBtn(sec, 'asp', 'mode-asp', 'Aspirated or not?',
        'Hear a word — decide whether its first sound has the puff of air. ' + D.soundsPage.aspTest.length + ' words.') +
      customModeBtn(sec, 'fam', 'mode-fam', 'Which family?',
        'See a letter, pick its sound family. 12 random letters each run.') +
      '</div>';
    panel.querySelector('#mode-asp').addEventListener('click', function () {
      runCustomTest(panel, sec, 'asp', buildAspTest, soundsTestHome);
    });
    panel.querySelector('#mode-fam').addEventListener('click', function () {
      runCustomTest(panel, sec, 'fam', buildFamTest, soundsTestHome);
    });
  }
  function buildAspTest() {
    return shuffle(D.soundsPage.aspTest).map(function (w) {
      var choices = [{ label: 'Aspirated' }, { label: 'Unaspirated' }];
      return {
        promptText: 'Listen — is the first sound aspirated?',
        audio: w.audio,
        choices: choices,
        correctIdx: w.asp ? 0 : 1,
        answerText: w.thai + ' ' + w.t + ' (' + w.en + ') is ' + (w.asp ? 'aspirated' : 'unaspirated')
      };
    });
  }
  function letterAudioMap() {
    var m = {};
    D.letters.forEach(function (l) { m[l.ch] = { audio: l.audio, name: l.name }; });
    return m;
  }
  function buildFamTest() {
    var fams = famData();
    var la = letterAudioMap();
    var pool = [];
    fams.forEach(function (f, fi) {
      f.chars.split('').forEach(function (ch) { pool.push({ ch: ch, fi: fi }); });
    });
    return shuffle(pool).slice(0, 12).map(function (p) {
      var li = la[p.ch] || {};
      return {
        promptText: 'Which sound family is this letter? Tap the letter to hear its name again.',
        symbol: p.ch,
        audio: li.audio,
        choices: fams.map(function (f) { return { label: f.label }; }),
        correctIdx: p.fi,
        answerText: p.ch + (li.name ? ' (' + li.name + ')' : '') + ' is ' + fams[p.fi].label.toLowerCase()
      };
    });
  }
  function renderSounds(root, sec) {
    var R = D.soundsPage.rule;
    var html = D.soundsPage.sections.map(function (s) {
      return '<div class="read-panel"><h2>' + esc(s.heading) + '</h2><p>' + esc(s.body) + '</p>' + chipRow(s.chips) + '</div>';
    }).join('') +
      '<div class="read-panel"><h2>' + esc(R.heading) + '</h2><p>' + esc(R.body) + '</p>' +
      '<div class="final-grid fam-grid">' + R.families.map(function (f) {
        return '<div class="final-card">' +
          '<div class="fc-sound fam-label">' + esc(f.label) + '</div>' +
          '<div class="fc-letters">' + esc(f.letters) + '</div>' +
          '<div class="fc-type">' + esc(f.note) + '</div></div>';
      }).join('') + '</div></div>' +
      '<div class="test-panel" id="test-panel"></div>';
    root.innerHTML = html;
    wireChips(root);
    soundsTestHome(root.querySelector('#test-panel'), sec);
  }

  /* ── finals page ───────────────────────────────────────── */
  var SOUND8 = ['-k', '-t', '-p', '-ng', '-n', '-m', '-y', '-w'];
  function finalsTestHome(panel, sec) {
    showAnswers();
    var lp = finalsLetterParts();
    panel.innerHTML =
      '<div class="test-head"><h2>Test yourself</h2></div>' +
      (anyTested(sec) ? '<div class="test-stat-lines">' + statLinesHtml(sec) + '</div>' : '') +
      '<p class="test-sub">Four tests, shuffled every run.</p>' +
      '<div class="test-modes modes-4">' +
      customModeBtn(sec, 'l2fA', 'mode-l2fa', 'Letter → final sound 1',
        'Part 1 of 2 — see a letter, pick the sound it makes at the end of a word. ' +
        lp[0].length + ' letters, endings mixed.') +
      customModeBtn(sec, 'l2fB', 'mode-l2fb', 'Letter → final sound 2',
        'Part 2 of 2 — the other ' + lp[1].length + ' letters. Together the parts cover every ' +
        'letter that can end a syllable.') +
      customModeBtn(sec, 'pick', 'mode-pick', 'Round up the letters',
        'Select ALL the letters that make the given final sound — one or many.') +
      customModeBtn(sec, 'hear', 'mode-hear', 'Hear the ending',
        'Hear a word, pick the sound it ends with. ' + D.finalsPage.hearTest.length + ' words.') +
      '</div>';
    panel.querySelector('#mode-l2fa').addEventListener('click', function () {
      runCustomTest(panel, sec, 'l2fA', function () { return buildL2fTest(0); }, finalsTestHome);
    });
    panel.querySelector('#mode-l2fb').addEventListener('click', function () {
      runCustomTest(panel, sec, 'l2fB', function () { return buildL2fTest(1); }, finalsTestHome);
    });
    panel.querySelector('#mode-pick').addEventListener('click', function () {
      runCustomTest(panel, sec, 'pick', buildPickTest, finalsTestHome);
    });
    panel.querySelector('#mode-hear').addEventListener('click', function () {
      runCustomTest(panel, sec, 'hear', buildHearTest, finalsTestHome);
    });
  }
  function finalsLetterMap() {
    var map = [];
    D.finalsPage.groups.forEach(function (g) {
      g.letters.split(' ').forEach(function (ch) { if (ch) map.push({ ch: ch, sound: g.sound }); });
    });
    return map;
  }
  // The two halves of the letter → final sound test. Every letter on the chart appears in
  // exactly one part, so doing both covers the lot — that's the point of the split (the old
  // single test drew 12 at random from all 35, so most letters never came up).
  //
  // Dealt ALTERNATELY over the chart order, which is grouped by ending sound. That mixes the
  // endings evenly through both parts — a part cut along the groups would give its own answers
  // away. The deal is FIXED, not random, so a part's best score means the same thing every run;
  // only the question ORDER shuffles (in buildL2fTest).
  function finalsLetterParts() {
    var a = [], b = [];
    finalsLetterMap().forEach(function (p, i) { (i % 2 ? b : a).push(p); });
    return [a, b];
  }
  function buildL2fTest(part) {
    var la = letterAudioMap();
    return shuffle(finalsLetterParts()[part]).map(function (p) {
      var li = la[p.ch] || {};
      var others = shuffle(SOUND8.filter(function (s) { return s !== p.sound; })).slice(0, 3);
      var choices = shuffle(others.concat([p.sound]));
      return {
        promptText: 'At the end of a word, this letter sounds like… (tap the letter to hear its name)',
        symbol: p.ch,
        audio: li.audio,
        choices: choices.map(function (s) { return { label: s }; }),
        correctIdx: choices.indexOf(p.sound),
        answerText: p.ch + (li.name ? ' (' + li.name + ')' : '') + ' at the end of a word sounds like ' + p.sound
      };
    });
  }
  function buildPickTest() {
    var map = finalsLetterMap();
    var la = letterAudioMap();
    return shuffle(D.finalsPage.groups).map(function (g) {
      var correct = g.letters.split(' ').filter(Boolean);
      if (correct.length > 5) correct = shuffle(correct).slice(0, 5);
      var wrong = shuffle(map.filter(function (p) { return p.sound !== g.sound; }))
        .slice(0, 8 - correct.length).map(function (p) { return p.ch; });
      var tiles = shuffle(correct.concat(wrong));
      var correctSet = [];
      tiles.forEach(function (ch, i) { if (correct.indexOf(ch) !== -1) correctSet.push(i); });
      return {
        promptText: 'Select ALL the letters that sound like <b>' + g.sound + '</b> at the end of a word, then press Check. Each letter speaks its name as you tap it.',
        choices: tiles.map(function (ch) { return { label: ch, thai: ch, audio: (la[ch] || {}).audio }; }),
        multi: true,
        correctSet: correctSet,
        answerText: g.sound + ' here: ' + correct.join(' ')
      };
    });
  }
  function buildHearTest() {
    return shuffle(D.finalsPage.hearTest).map(function (w) {
      var others = shuffle(SOUND8.filter(function (s) { return s !== w.final; })).slice(0, 3);
      var choices = shuffle(others.concat([w.final]));
      return {
        promptText: 'Listen — which sound does the word end with?',
        audio: w.audio,
        choices: choices.map(function (s) { return { label: s }; }),
        correctIdx: choices.indexOf(w.final),
        answerText: w.thai + ' ' + w.t + ' (' + w.en + ') ends with ' + w.final
      };
    });
  }
  function renderFinals(root, sec) {
    var F = D.finalsPage;
    var html =
      '<h2 class="read-h2">The eight endings</h2>' +
      '<p class="read-p">Three are stops (the syllable is <strong>dead</strong>), five are sonorants (the syllable is <strong>live</strong>). ' + esc(F.translitNote) + '</p>' +
      '<div class="final-grid">' + F.groups.map(function (g) {
        return '<div class="final-card">' +
          '<div class="fc-sound">' + esc(g.sound) + '</div>' +
          '<div class="fc-type">' + esc(g.type) + '</div>' +
          '<div class="fc-letters">' + esc(g.letters) + '</div>' +
          '<button class="tt-ex" data-audio="' + g.ex.audio + '" type="button">' + SVG_PLAY +
          '<span class="th">' + esc(g.ex.thai) + '</span><span class="rr">' + esc(g.ex.t) + '</span></button>' +
          '<span class="tt-en">' + esc(g.ex.en) + '</span>' +
          '</div>';
      }).join('') + '</div>' +
      '<p class="read-p">Letters you\'ll never see ending a syllable: <span class="th">' + esc(F.neverFinal) + '</span>.</p>' +

      '<h2 class="read-h2">The silent-letter mark ◌์</h2>' +
      '<p class="read-p">A small mark called <em>gaa-ran</em> (<span class="th">การันต์</span>) written over a letter kills it — the letter is written but not spoken. Common in words borrowed from other languages: <span class="th">ยักษ์</span> <em>yák</em> (giant) — the <span class="th">ษ</span> is silent.</p>' +
      '<p class="read-p" style="margin-bottom:0.25rem"><button class="tt-ex" data-audio="yaw-yak-word" type="button">' + SVG_PLAY + '<span class="th">ยักษ์</span><span class="rr">yák</span></button></p>' +

      '<div class="test-panel" id="test-panel"></div>';
    root.innerHTML = html;
    root.querySelectorAll('.tt-ex').forEach(function (btn) {
      btn.addEventListener('click', function () { play(btn.getAttribute('data-audio'), btn); });
    });
    finalsTestHome(root.querySelector('#test-panel'), sec);
  }

  /* ── clusters page ─────────────────────────────────────── */
  function clusterPool() {
    var C = D.clustersPage;
    return C.true.concat(C.false).concat(C.leading);
  }
  function clustersTestHome(panel, sec) {
    showAnswers();
    panel.innerHTML =
      '<div class="test-head"><h2>Test yourself</h2></div>' +
      (anyTested(sec) ? '<div class="test-stat-lines">' + statLinesHtml(sec) + '</div>' : '') +
      '<p class="test-sub">Both tests shuffle every run and cover every word on this page.</p>' +
      '<div class="test-modes">' +
      customModeBtn(sec, 'read', 'mode-read', 'Read the cluster',
        'See a word, pick how it\'s pronounced from four options. The audio confirms after you answer.') +
      customModeBtn(sec, 'hear', 'mode-hear', 'Hear → pick the word',
        'Hear a word, pick the right written form from four.') +
      '</div>';
    panel.querySelector('#mode-read').addEventListener('click', function () {
      runCustomTest(panel, sec, 'read', buildClusterReadTest, clustersTestHome);
    });
    panel.querySelector('#mode-hear').addEventListener('click', function () {
      runCustomTest(panel, sec, 'hear', buildClusterHearTest, clustersTestHome);
    });
  }
  function buildClusterReadTest() {
    return shuffle(clusterPool()).map(function (w) {
      var opts = shuffle([w.t].concat(w.wrong));
      return {
        promptText: 'How is this word pronounced?',
        symbol: w.thai,
        choices: opts.map(function (t) { return { label: t }; }),
        correctIdx: opts.indexOf(w.t),
        revealAudio: w.audio,
        answerText: w.thai + ' is ' + w.t + ' (' + w.en + ')'
      };
    });
  }
  function buildClusterHearTest() {
    var pool = clusterPool();
    return shuffle(pool).map(function (w) {
      var others = shuffle(pool.filter(function (x) { return x !== w; })).slice(0, 3);
      var opts = shuffle(others.concat([w]));
      return {
        promptText: 'Listen — which word did you hear?',
        audio: w.audio,
        // each option is a real word with its own recording, so after answering they can all be
        // tapped and compared against the clip that was played
        choices: opts.map(function (x) { return { label: x.thai, thai: x.thai, audio: x.audio }; }),
        correctIdx: opts.indexOf(w),
        answerText: w.thai + ' ' + w.t + ' (' + w.en + ')'
      };
    });
  }
  function clusterChipsHtml(list) {
    return chipRow(list.map(function (w) {
      return { thai: w.thai, t: w.t, en: w.en, tag: w.note || (w.cl || ''), audio: w.audio };
    }));
  }
  function renderClusters(root, sec) {
    var C = D.clustersPage;
    var html =
      '<div class="read-panel"><h2>True clusters — one syllable</h2><p>' + esc(C.trueIntro) + '</p>' +
      clusterChipsHtml(C.true) + '</div>' +
      '<div class="read-panel"><h2>Fake clusters — silent ร</h2><p>' + esc(C.falseIntro) + '</p>' +
      clusterChipsHtml(C.false) + '</div>' +
      '<div class="read-panel"><h2>Pairs that split — two syllables</h2><p>' + esc(C.leadingIntro) + '</p>' +
      clusterChipsHtml(C.leading) + '</div>' +
      '<div class="test-panel" id="test-panel"></div>';
    root.innerHTML = html;
    wireChips(root);
    clustersTestHome(root.querySelector('#test-panel'), sec);
  }

  /* ── letters / vowels page ─────────────────────────────── */
  function renderLetterSection(root, sec) {
    var vowel = isVowelSection(sec.key);
    var items = allItemsFor(sec.key);
    var live = items.filter(function (i) { return !i.obsolete; });
    var dead = items.filter(function (i) { return i.obsolete; });
    var html = '';
    if (!vowel) {
      html += '<div class="read-note">Every Thai consonant has a two-part name: its <strong>sound</strong> plus a <strong>word that starts with it</strong> — like saying &ldquo;A for Apple.&rdquo; So <span class="th">ก</span> is <em>gaw gài</em>: &ldquo;gaw&rdquo; is the sound, <span class="th">ไก่</span> <em>gài</em> means chicken. Tap a card to hear the full name, or the pill to hear just the word.</div>';
    } else {
      html += '<div class="read-note">Vowel names all start with <em>sara</em> (<span class="th">สระ</span> — &ldquo;vowel&rdquo;). Tap a card to hear the name, or the pill to hear a real word that uses it.</div>';
    }
    html += '<div class="letter-grid">' + live.map(function (it) { return letterCardHtml(it, vowel); }).join('') + '</div>';
    if (dead.length) {
      html += '<h2 class="read-h2">Obsolete ' + (dead.length > 1 ? 'letters' : 'letter') + '</h2>' +
        '<p class="read-p">Part of the traditional 44-letter alphabet but no longer used in modern spelling — worth recognising, so ' + (dead.length > 1 ? 'they are' : 'it is') + ' shown here, but never tested.</p>' +
        '<div class="letter-grid">' + dead.map(function (it) { return letterCardHtml(it, vowel); }).join('') + '</div>';
    }
    html += '<div class="test-panel" id="test-panel"></div>';
    root.innerHTML = html;
    wireGrid(root);
    renderTestHome(root.querySelector('#test-panel'), sec);
  }

  /* ── tone rules page ───────────────────────────────────── */
  function ttExHtml(cell) {
    if (!cell) return '<span class="tt-empty">—</span>';
    return '<span class="tt-tone tt-' + cell.tone + '">' + cell.tone + '</span>' +
      '<button class="tt-ex" data-audio="' + cell.audio + '" type="button">' + SVG_PLAY +
      '<span class="th">' + esc(cell.thai) + '</span><span class="rr">' + esc(cell.t) + '</span></button>' +
      '<span class="tt-en">' + esc(cell.en) + '</span>';
  }
  function renderTones(root) {
    var R = D.toneRules;
    var html =
      '<p class="read-p">Thai doesn’t write tones directly. Instead, each syllable’s tone is <strong>derived</strong> from four things: the <strong>class</strong> of its first consonant (that’s why you learned the classes), whether the syllable is <strong>live or dead</strong>, the <strong>vowel length</strong>, and any <strong>tone mark</strong>. Learn the rules and you can read the tone of any word you meet.</p>' +

      '<h2 class="read-h2">Live and dead syllables</h2>' +
      '<p class="read-p">A syllable is <strong>live</strong> if it can ring on: it ends in a long vowel or a sonorant sound — m, n, ng, y, w (<span class="th">มา</span>, <span class="th">นอน</span>, <span class="th">ยาว</span>). It’s <strong>dead</strong> if it cuts off short: a short open vowel, or a p / t / k stop at the end (<span class="th">จะ</span>, <span class="th">รัก</span>, <span class="th">มาก</span>). Note the four self-contained vowels <span class="th">◌ำ ใ◌ ไ◌ เ◌า</span> end in m / y / w sounds, so they’re always <strong>live</strong>.</p>' +

      '<h2 class="read-h2">The four tone marks</h2>' +
      '<p class="read-p">Marks sit above the initial consonant. What they produce depends on the class — the names are just the Thai numbers 1–4.</p>' +
      '<div class="marks-row">' + D.toneMarks.map(function (m) {
        return '<div class="mark-item"><div class="m-sym">' + m.mark + '</div><div class="m-name">' + esc(m.name) + '</div>' +
          (m.t ? '<div class="m-note">' + esc(m.t) + '</div>' : '<div class="m-note">&nbsp;</div>') + '</div>';
      }).join('') + '</div>' +

      '<h2 class="read-h2">The rules — one table</h2>' +
      '<p class="read-p">Find the class row, then the column that matches the syllable. Tap any example to hear the tone. Spoken out loud, the low-class row reads: <em>low + live = mid · low + dead-short = high · low + dead-long = falling · <span class="th">◌่</span> = falling · <span class="th">◌้</span> = high</em> — and likewise for the other rows.</p>' +
      '<div class="tone-table-scroll"><table class="tone-table"><thead><tr><th></th>' +
      R.columns.map(function (c) { return '<th>' + c.replace('◌่', '<span class="th">◌่</span>').replace('◌้', '<span class="th">◌้</span>').replace('◌๊', '<span class="th">◌๊</span>').replace('◌๋', '<span class="th">◌๋</span>') + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      R.rows.map(function (row) {
        return '<tr><td class="cls-cell">' + esc(row.cls) + '</td>' +
          row.cells.map(function (cell) { return '<td>' + ttExHtml(cell) + '</td>'; }).join('') + '</tr>';
      }).join('') +
      '</tbody></table></div>' +

      '<h2 class="read-h2">Two spelling tricks to know</h2>' +
      '<p class="read-p"><strong>Silent <span class="th">ห</span></strong> — a leading <span class="th">ห</span> before a group-2 sonorant isn’t pronounced; it just lends its high class, unlocking tones the sonorant can’t make alone: <span class="th">หมู</span> <em>mǔu</em> (pig), <span class="th">หนู</span> <em>nǔu</em> (mouse), <span class="th">แหวน</span> <em>wǎen</em> (ring).</p>' +
      '<p class="read-p"><strong>Silent <span class="th">อ</span></strong> — the same trick with <span class="th">อ</span> lending mid class, in exactly four words: <span class="th">อย่า อยู่ อย่าง อยาก</span> (<em>yàa, yùu, yàang, yàak</em>).</p>' +
      '<p class="read-p">That’s the whole system. Clusters next — one last spelling pattern to apply it to — then the reading quiz makes it reflex.</p>';
    root.innerHTML = html;
    root.querySelectorAll('.tt-ex').forEach(function (btn) {
      btn.addEventListener('click', function () { play(btn.getAttribute('data-audio'), btn); });
    });
  }

  /* ── reading quiz page ─────────────────────────────────── */
  function renderQuiz(root) { renderQuizPart(root, 'A'); }
  // First consonant of a word + its class — shown on reveal so the reader can
  // check WHY a tone went wrong without leaving the quiz. Skips preposed vowels.
  function firstConsInfo(thai) {
    var CLS_NAME = { mid: 'mid class', high: 'high class', low1: 'low class', low2: 'low class' };
    var clsOf = {};
    D.letters.forEach(function (l) { clsOf[l.ch] = CLS_NAME[l.cls]; });
    for (var i = 0; i < thai.length; i++) {
      var ch = thai.charAt(i);
      if ('เแโใไ'.indexOf(ch) !== -1) continue;   // vowel written before its consonant
      return clsOf[ch] ? { ch: ch, label: clsOf[ch] } : null;
    }
    return null;
  }
  function renderQuizPart(root, part) {
    // The quiz page IS a test — gated whole (free sign-in), like member topics.
    if (!isSignedIn() && !AUTH_BYPASS) {
      root.innerHTML = signInGateHtml();
      watchAuth(function () { renderQuizPart(root, part); });
      return;
    }
    var words = part === 'A' ? D.quiz : (part === 'B' ? D.quizB : D.quizC);
    var order = shuffle(words);
    var marks = {}; // audio id -> 'got' | 'missed'
    var attemptRecorded = false;

    function summaryHtml() {
      var done = Object.keys(marks).length;
      var got = Object.keys(marks).filter(function (k) { return marks[k] === 'got'; }).length;
      if (!done) return 'Read each word aloud — tone included — then check with the audio and mark yourself.';
      return '<strong>' + got + ' / ' + done + '</strong> marked right' +
        (done === order.length ? ' — finished! Shuffle to run it again.' : ' · ' + (order.length - done) + ' to go');
    }
    function updateSummary() {
      var el = root.querySelector('#quiz-summary');
      if (el) el.innerHTML = summaryHtml();
    }
    var html =
      '<div class="quiz-tabs">' +
      '<button class="tq-icon-btn' + (part === 'A' ? ' on' : '') + '" id="qp-a" type="button">Part A — everyday words</button>' +
      '<button class="tq-icon-btn' + (part === 'B' ? ' on' : '') + '" id="qp-b" type="button">Part B — full coverage</button>' +
      '<button class="tq-icon-btn' + (part === 'C' ? ' on' : '') + '" id="qp-c" type="button">Part C — short sentences</button>' +
      '</div>' +
      '<div class="tq-top">' +
      '<span class="tq-count">' + order.length + (part === 'C' ? ' sentences' : ' words') + ' · shuffled every load</span>' +
      '<button class="tq-icon-btn" id="quiz-shuffle" type="button" title="Shuffle and clear marks">' + SVG_REFRESH + 'Shuffle</button>' +
      '</div>' +
      (part === 'B' ? '<div class="read-note">' + esc(D.quizBNote) + '</div>' : '') +
      (part === 'C' ? '<div class="read-note">' + esc(D.quizCNote) + '</div>' : '') +
      '<div class="quiz-summary" id="quiz-summary">' + summaryHtml() + '</div>' +
      '<div class="quiz-cards">' +
      order.map(function (w, i) {
        return '<div class="quiz-card" data-audio="' + w.audio + '">' +
          '<span class="qc-num">' + (i + 1) + '</span>' +
          '<span class="qc-thai">' + esc(w.thai) + '</span>' +
          '<span class="qc-btns">' +
          '<button class="rd-play-pill qc-play" type="button">' + SVG_PLAY + ' Check by ear</button>' +
          '<button class="rd-ghost-pill qc-reveal" type="button">Reveal</button>' +
          '</span>' +
          '<span class="qc-reveal-area">' +
          '<span class="qc-t">' + esc(w.t) + '</span>' +
          (function () {
            if (part === 'C') return '';   // sentences: many initials, no single class chip
            var fc = firstConsInfo(w.thai);
            return fc ? '<span class="qc-cls">(<span class="th">' + esc(fc.ch) + '</span> — ' + fc.label + ')</span>' : '';
          })() +
          '<span class="qc-en">' + esc(w.en) + '</span>' +
          (w.note ? '<span class="qc-note">' + esc(w.note) + '</span>' : '') +
          '<span class="qc-mark">' +
          '<button class="got" type="button">✓ Got it</button>' +
          '<button class="missed" type="button">✗ Missed</button>' +
          '</span></span></div>';
      }).join('') +
      '</div>' +
      '<div class="quiz-submit-wrap">' +
      '<button class="rd-play-pill quiz-submit-btn" id="quiz-submit" type="button">Submit results</button>' +
      '<div class="quiz-submit-msg" id="quiz-submit-msg"></div>' +
      '</div>';
    root.innerHTML = html;

    var submitBtn = root.querySelector('#quiz-submit');
    var submitMsg = root.querySelector('#quiz-submit-msg');
    submitBtn.addEventListener('click', function () {
      var done = Object.keys(marks).length;
      if (attemptRecorded) {
        submitMsg.textContent = 'Already saved — press Shuffle to run it again.';
        return;
      }
      if (done < order.length) {
        submitMsg.textContent = 'Mark every word first — ' + (order.length - done) + ' still to go.';
        return;
      }
      var got = Object.keys(marks).filter(function (k) { return marks[k] === 'got'; }).length;
      recordResult('quiz', 'part' + part, got, order.length);
      attemptRecorded = true;
      submitMsg.innerHTML = 'Score: <strong>' + got + ' / ' + order.length + '</strong> (' +
        Math.round(100 * got / order.length) + '%) — saved to <a href="read-results.html">Your results</a>.';
    });

    root.querySelector('#quiz-shuffle').addEventListener('click', function () { renderQuizPart(root, part); });
    root.querySelector('#qp-a').addEventListener('click', function () { renderQuizPart(root, 'A'); });
    root.querySelector('#qp-b').addEventListener('click', function () { renderQuizPart(root, 'B'); });
    root.querySelector('#qp-c').addEventListener('click', function () { renderQuizPart(root, 'C'); });
    root.querySelectorAll('.quiz-card').forEach(function (card) {
      var id = card.getAttribute('data-audio');
      var playBtn = card.querySelector('.qc-play');
      playBtn.addEventListener('click', function () { play(id, playBtn); });
      card.querySelector('.qc-reveal').addEventListener('click', function () { card.classList.add('revealed'); });
      var gotBtn = card.querySelector('.got'), missBtn = card.querySelector('.missed');
      gotBtn.addEventListener('click', function () {
        marks[id] = 'got'; gotBtn.classList.add('on'); missBtn.classList.remove('on'); updateSummary();
      });
      missBtn.addEventListener('click', function () {
        marks[id] = 'missed'; missBtn.classList.add('on'); gotBtn.classList.remove('on'); updateSummary();
      });
    });
  }

  /* ── results page ──────────────────────────────────────── */
  function renderResults(root) {
    var totalAttempts = 0, testedModes = 0, totalModes = 0;
    var panels = D.sections.map(function (s) {
      var ms = sectionModes(s);
      if (!ms.length) return '';
      var rows = ms.map(function (m) {
        totalModes++;
        var r = modeStats(s.key, m[0]);
        if (r) { totalAttempts += r.attempts; testedModes++; }
        var avg = (r && r.sumTotal) ? Math.round(100 * r.sumCorrect / r.sumTotal) + '%' : '—';
        return '<tr><td class="rt-name">' + m[1] + '</td>' +
          '<td>' + (r ? r.attempts + '×' : '—') + '</td>' +
          '<td>' + (r ? r.bestCorrect + ' / ' + r.bestTotal : '—') + '</td>' +
          '<td>' + avg + '</td></tr>';
      }).join('');
      return '<div class="read-panel results-panel"><h2><a href="' + pageHref(s.page) + '">' + esc(s.title) + '</a></h2>' +
        '<table class="results-table"><thead><tr><th>Test</th><th>Times done</th><th>Best</th><th>Average</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
    }).join('');
    root.innerHTML =
      '<div class="read-panel results-hero">' +
      '<p>You\'ve taken <strong>' + totalAttempts + '</strong> test' + (totalAttempts === 1 ? '' : 's') +
      ' across <strong>' + testedModes + ' of ' + totalModes + '</strong> test types. ' +
      (testedModes < totalModes ? 'The tests you haven\'t tried yet show a dash — click a section title to jump straight to it.'
        : 'Every test tried — keep retesting until the best scores are perfect.') + '</p></div>' +
      panels +
      '<div class="clear-progress-wrap">' +
      '<button class="rd-ghost-pill clear-progress-btn" id="clear-progress" type="button">Clear my reading progress</button>' +
      '</div>';
    var clearBtn = root.querySelector('#clear-progress');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (!confirm('This permanently deletes ALL your Read Thai test history — every attempt, best score and average, across every section. It cannot be undone.\n\nClear everything?')) return;
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      location.reload();
    });
  }

  /* ── hub page ──────────────────────────────────────────── */
  // Split into hubBodyHtml() (markup only) + wireHub() (listeners) so both renderHub() — read.html's
  // own #read-root, unchanged — and mountHub() (r130, below) — the index panel's native container —
  // build and wire the identical hub body. renderHub()'s own behaviour is byte-equivalent to before
  // this split: same HTML string assigned to root.innerHTML, same listeners wired straight after.
  function hubBodyHtml() {
    var teach = D.sections;
    var html =
      '<div class="read-panel"><h2>Every letter belongs to a class — and the class carries the tone</h2>' +
      '<p>Thai has <strong>no capital letters and no spaces between words</strong> — just 42 consonants in everyday use, about 26 vowel shapes, and 5 tones. The tone a word carries is derived from the letters themselves: the consonant’s <strong>class</strong> (mid, high or low), the vowel, how the syllable ends, and the tone marks.</p>' +
      '<p>Hear the five tones on one syllable — tap each:</p>' +
      '<div class="tone-demo-row">' + D.toneDemo.map(function (d) {
        return '<button class="tone-chip" data-audio="' + d.audio + '" type="button">' +
          '<div class="tc-thai">' + esc(d.thai) + '</div>' +
          '<div class="tc-t">' + esc(d.t) + '</div>' +
          '<div class="tc-tone">' + esc(d.tone) + '</div>' +
          '<div class="tc-en">' + esc(d.en) + '</div></button>';
      }).join('') + '</div></div>' +

      '<div class="read-panel"><h2>How we write the sounds (and the tones)</h2>' +
      '<p>Until the script is second nature, we show a transliteration next to every Thai word, with an accent on the vowel telling you the tone — the same five you just heard:</p>' +
      '<div class="key-grid">' + D.toneKey.map(function (k) {
        return '<div class="key-item"><div class="k-mark">' + k.mark + '</div><div class="k-name">' + k.name + ' tone</div></div>';
      }).join('') + '</div>' +
      '</div>' +

      '<div class="section-header" id="lessons" style="margin-top:2rem"><span class="section-title" style="font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-tertiary)">The learning path — test yourself at every step</span></div>' +
      '<div class="read-path">' + teach.map(function (s, i) {
        var progress = anyTested(s)
          ? '<div class="path-progress done">' + statLinesHtml(s) + '</div>'
          : '<div class="path-progress">Not tested yet</div>';
        if (s.kind === 'tones') progress = '<div class="path-progress">Reading quiz section</div>';
        if (s.kind === 'results') progress = '<div class="path-progress">All your scores in one place</div>';
        return '<a class="path-card" href="' + pageHref(s.page) + '">' +
          '<span class="path-step">' + (s.kind === 'results' ? 'Overview' : 'Step ' + (i + 1)) + '</span>' +
          '<span class="path-name">' + esc(s.title) + '</span>' +
          '<span class="path-blurb">' + s.blurb + '</span>' + progress + '</a>';
      }).join('') + '</div>';
    return html;
  }
  function wireHub(root) {
    root.querySelectorAll('.tone-chip').forEach(function (chip) {
      chip.addEventListener('click', function () { play(chip.getAttribute('data-audio'), chip); });
    });
    mountDlCard(root);
  }
  function renderHub(root) {
    root.innerHTML = hubBodyHtml();
    wireHub(root);
  }

  /* ── native hub mount (r130) ──────────────────────────────────────────────
     window.ThaiEarRead.mountHub(rootEl) — renders the hub INTO A HOST PAGE'S OWN CONTAINER,
     natively (no iframe). Built to retire the index page's <iframe src="read.html?embed=1">:
     that iframe showed the whole read.html page with its nav/mode-toggle hidden via the
     `.te-embed` CSS (still in read.html, untouched, for any other embed use); this instead
     renders just the hub BODY straight into the caller's element, and the caller (index.html,
     NOT edited by this change — a separate integration step wires the container + loads
     read.css) supplies its own page chrome.
     Renders: the "Jump to lessons" control, the h1 + eyebrow + two intro paragraphs (copied
     verbatim from read.html's static markup — read.html itself is untouched, so this is a
     second, hand-kept-in-sync copy; update both if that copy ever changes), then the same hub
     body as renderHub() (tone-demo panel, transliteration key, and the learning-path grid with
     its `#lessons` anchor).
     Deliberately OMITS vs the full page: the site nav, the Topic Sentences/Read Thai mode
     toggle, and the decorative betta-mascot "Don't break my flow" block — none of those are
     part of "the hub", they're page chrome/decoration the host page already owns or doesn't need.
     Idempotent: a second call is a no-op (one panel per page load). */
  var hubMounted = false;
  function injectHubMountCss() {
    if (document.getElementById('te-hub-mount-css')) return;
    var s = document.createElement('style');
    s.id = 'te-hub-mount-css';
    /* Same rules the index's iframe-onload script used to inject into read.html's embedded
       document (index.html, pre-r130), animating the jump control's three chevrons in sequence
       (.75s cycle, .25s stagger per chevron).
       r137b — THE JUMP CONTROL *IS* THE SUBTITLE NOW (owner). The old '.read-eyebrow{margin:...}'
       rule is gone with the eyebrow it repositioned; the margin moves onto .te-jump so the read
       panel's title→subtitle gap is the same 6px/16px the topics and playlists panels get from
       .panel-sub. `font-family:inherit` matters here and did not before: a <button> does not
       inherit the page font, and .read-eyebrow sets everything EXCEPT the family — so as a
       decoration under the title that passed unnoticed, but as the subtitle it would have been the
       one property visibly out of step with the other two panels. */
    s.textContent =
      '.te-jump{display:block;background:none;border:0;cursor:pointer;padding:0;margin:6px 0 16px;' +
        'text-align:left;font-family:inherit}' +
      '.te-jump .jch{display:inline-block;opacity:.22;animation:te-jl .75s linear infinite}' +
      '.te-jump .jch.j2{animation-delay:.25s}' +
      '.te-jump .jch.j3{animation-delay:.5s}' +
      '@keyframes te-jl{0%{opacity:.22}15%{opacity:1}45%,100%{opacity:.22}}';
    document.head.appendChild(s);
  }
  function mountHub(rootEl) {
    if (!rootEl || hubMounted) return;
    hubMounted = true;
    injectHubMountCss();
    var chevrons = '<span class="jch j1">&gt;</span><span class="jch j2">&gt;</span><span class="jch j3">&gt;</span>';
    rootEl.innerHTML =
      /* r137b — TITLE THEN SUBTITLE, like the other two panels (owner). Was: jump button ABOVE the
         h1, then a "Read Thai — the on-ramp" eyebrow beneath it. The eyebrow is deleted and the
         jump control takes its slot, so all three panels of the index switcher now read
         title-then-subtitle with identical type and spacing (.read-title is property-for-property
         .panel-title, including the 600px step to 20px; .te-jump now carries .panel-sub's margin).
         ⚠ THIS DELIBERATELY DIVERGES FROM read.html, which keeps its own eyebrow — that page has
         its own chrome (nav, mode toggle) and is the SEO landing page. The "hand-kept-in-sync copy"
         note above applies to the INTRO PARAGRAPHS, not to this heading block any more. */
      '<h1 class="read-title">Learn to read Thai, from zero</h1>' +
      '<button type="button" class="read-eyebrow te-jump" id="te-jump-btn">' + chevrons + ' Jump to lessons ' + chevrons + '</button>' +
      '<p class="read-intro" style="margin-bottom:0.8rem">Reading Thai script enables you to determine a word\'s tone, and therefore its meaning. For example, "mǎa" (rising tone) means "dog", "máa" (high tone) means "horse", and "maa" (mid tone) is the verb "come".</p>' +
      '<p class="read-intro" style="margin-top:0">Thai script may look intimidating at first, but it follows a clear logic and can be learned with a systematic approach. This section takes you from nothing to reading real words in twelve steps. This reading course does not just present you with information, but gives you the opportunity to test yourself, and re-test at each step, until you are confident. Tests shuffle every time, so you\'re recognising sounds and symbols, not memorising an order. You will be reading Thai script in no time. Congratulations for taking this important step of your Thai learning journey.</p>' +
      hubBodyHtml();
    wireHub(rootEl);
    var jumpBtn = rootEl.querySelector('#te-jump-btn');
    // Plain in-document scroll — content is native now, no iframe offset math needed. Reuses the
    // exact same landing spot (#lessons, minus 72px) as read.html's own #lessons hash-landing.
    if (jumpBtn) jumpBtn.addEventListener('click', scrollToLessons);
    markTerms(rootEl);   // scoped to rootEl, not document.body — the index page has plenty of
                          // other text on it that must never pick up a glossary marker.
    prefetchWhenIdle(sectionAudioIds('hub'));
  }
  window.ThaiEarRead.mountHub = mountHub;

  // read.html's own #lessons hash-landing (boot(), below) uses this to land on the "learning path"
  // heading instead of the hub top — minus 72px of grace so it isn't glued to the viewport edge
  // (owner spec, DYN_ROLLOUT §2.2b). mountHub()'s "Jump to lessons" button (above) reuses it too,
  // now that the hub can render on the index natively. #lessons only exists once the hub body has
  // been built (renderHub or mountHub), so this must run AFTER that, and must win over the browser's
  // own native hash-jump-on-load — take over scroll restoration and scroll on the next paint once
  // layout has settled. (A lesson's back-link routes to index.html#read-lessons since r130 — see
  // renderChrome, above — not to read.html#lessons; that hash remains read.html's own, unchanged.)
  function scrollToLessons() {
    var el = document.getElementById('lessons');
    if (!el) return;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var y = el.getBoundingClientRect().top + window.pageYOffset - 72;
        window.scrollTo(0, y < 0 ? 0 : y);
      });
    });
  }

  /* ── boot ──────────────────────────────────────────────── */
  function boot() {
    var root = document.getElementById('read-root');
    // Belt & braces (r130): every real read.html/read-*.html page wraps #read-root in .read-wrap
    // (see read.html and e.g. read-mid.html); a host page that merely happens to reuse the id
    // "read-root" for something unrelated — the index page's native panel container is deliberately
    // given a DIFFERENT id precisely to avoid this — still won't trip the self-boot.
    if (!root || !root.closest('.read-wrap')) return;
    var key = root.getAttribute('data-read');
    if (key === 'hub') {
      var toLessons = location.hash === '#lessons';
      if (toLessons && 'scrollRestoration' in history) history.scrollRestoration = 'manual';
      renderHub(root);
      /* The jump control is STATIC in read.html's markup (2026-08-21), so unlike the index
         panel — where mountHub() builds it — this path has to bring its own CSS and handler.
         Both are the same ones mountHub uses; without them the control is three inert '>'
         characters. Guarded on the element so read-*.html lesson pages are unaffected. */
      var jumpBtn = document.getElementById('te-jump-btn');
      if (jumpBtn) { injectHubMountCss(); jumpBtn.addEventListener('click', scrollToLessons); }
      markTerms(document.body);
      prefetchWhenIdle(sectionAudioIds('hub'));
      if (toLessons) scrollToLessons();
      return;
    }
    var sec = sectionByKey(key);
    if (!sec) return;
    currentSecKey = sec.key;
    renderChrome(sec);
    if (sec.kind === 'letters' || sec.kind === 'vowels') renderLetterSection(root, sec);
    else if (sec.kind === 'sounds') renderSounds(root, sec);
    else if (sec.kind === 'finals') renderFinals(root, sec);
    else if (sec.kind === 'clusters') renderClusters(root, sec);
    else if (sec.kind === 'tones') renderTones(root);
    else if (sec.kind === 'quiz') renderQuiz(root);
    else if (sec.kind === 'results') renderResults(root);
    /* No glossary markers on the RESULTS page (owner, 2026-08-01). The ⓘ terms exist to teach a
       reader who meets a technical word mid-lesson; the results page is a score summary, not a
       teaching surface, so "Aspirated" there should read as a plain test name. */
    if (sec.kind !== 'results') markTerms(document.body);
    prefetchWhenIdle(sectionAudioIds(key));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
