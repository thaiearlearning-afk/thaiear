/* dl-core.js — SHARED DOWNLOAD/REMOVE ENGINE (§D.1 consolidation, 2026-08-02).
   Plain script, no ES modules, no build step — mirrors the rest of this codebase's IIFE + var
   style. Exposes window.ThaiEarDL. Loaded by dyn-index.html (the reference implementation this
   was extracted FROM) and by playlists.html's playlist-list download machinery. player.js keeps
   its own third copy for now — folding it in is a separate pass, out of scope here.

   WHAT THIS DOES NOT DO: no UI, no DOM rendering, no grouping-by-unit / grouping-by-playlist
   logic. Those stay in each page — a topic list and a playlist list group their sentences
   differently and render different rows. This module is the MECHANICS underneath: the manifest
   format, the retrying downloader, the ownership arithmetic, the Remove-All sweep, the typed-
   REMOVE dialog, and the one D0 predicate both pages must agree on.

   Manifest format is UNCHANGED: localStorage 'thaiear_offline' → { [prefix]: { files, refs,
   tier, at, dyn, av, ver, bytes? } }. Do not alter that shape here — every consumer on the site
   (this module, both pages, player.js) reads/writes it directly. */
(function () {
  'use strict';

  var MANIFEST_KEY = 'thaiear_offline';

  // ── manifest read/write ──────────────────────────────────────────────────────────────────
  function getManifest() {
    try { return JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}'); } catch (_) { return {}; }
  }
  function setManifest(m) {
    try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(m)); } catch (_) {}
  }

  // ── incremental per-file recording (+ optional av stamping) ─────────────────────────────
  /* One clip, recorded — the write that runs as each file lands, so an interrupted download
     leaves usable, resumable progress instead of nothing (dyn-index r86 / playlists r85).
     `opts.seed()` builds a fresh entry when none exists yet — each page's own default shape
     (dyn-index's carries `ver`/`av`, playlists' does not) stays caller-supplied rather than
     invented here. `opts.avMap` / `opts.tier` / `opts.dyn` are OPTED IN per call so an EXISTING
     entry is only ever touched the way the original call site touched it: dyn-index refreshes
     tier/dyn/av on every write; playlists only sets them via the seed, on first write. Passing
     none of those three reproduces playlists' dlNoteClip exactly; passing all three reproduces
     dyn-index's noteClip exactly. */
  function noteClip(prefix, file, ref, opts) {
    opts = opts || {};
    var m = getManifest();
    var existed = !!m[prefix];
    var e = m[prefix] || (opts.seed ? opts.seed() : { tier: opts.tier, files: [] });
    e.files = e.files || [];
    if (e.files.indexOf(file) < 0) e.files.push(file);
    e.refs = (e.refs || (existed ? ['topic'] : [])).filter(function (r) { return r !== ref; });
    e.refs.push(ref);
    if (opts.avMap && e.av == null && opts.avMap[prefix] != null) e.av = opts.avMap[prefix];
    if (opts.tier != null) e.tier = opts.tier;
    e.at = Date.now();
    if (opts.dyn) e.dyn = true;
    delete e.bytes;             // the cached per-prefix total is stale the moment files change
    m[prefix] = e;
    setManifest(m);
    return e;
  }
  /* Batch twin of noteClip — merges a whole file LIST into manifest[prefix] in one shot (the
     end-of-run finalize both pages run after their per-clip writes already landed). Operates on
     a manifest object the CALLER read and will write once, so playlists.html can finalize several
     prefixes under a single setManifest() call, exactly as it did before extraction. Neither
     original finalize block touched `bytes`/`tier`/`dyn`/`av` inside this step (those are applied
     by the caller afterwards, see both pages' finalize call sites), so this stays files+refs only. */
  function mergeFiles(m, prefix, fileList, ref, seedFn) {
    var existed = !!m[prefix];
    var e = m[prefix] || seedFn();
    var seen = {};
    (e.files || []).concat(fileList).forEach(function (f) { seen[f] = true; });
    e.files = Object.keys(seen);
    e.refs = (e.refs || (existed ? ['topic'] : [])).filter(function (r) { return r !== ref; });
    e.refs.push(ref);
    m[prefix] = e;
    return e;
  }

  // ── per-file download, with retry/backoff + URL re-derivation ───────────────────────────
  /* Twin implementations in dyn-index (saveOne) and playlists (dlSaveOne) were IDENTICAL in
     shape and constants (r87): 3 tries, 600ms × attempt, URL re-derived on EVERY attempt because
     a presigned R2 URL is short-lived and retrying the same one would just fail again once it
     expired. `opts.urlFn(file)` is the one thing that legitimately differs per caller (the
     member/premium sign-in wording differs between "this topic" and "this playlist"), so it stays
     a caller-supplied function rather than living here. */
  var DL_MAX_TRIES = 3;
  function downloadOne(file, opts) {
    opts = opts || {};
    function attempt(tryNo) {
      return opts.urlFn(file).then(function (url) {
        if (opts.native) {
          return opts.fs.downloadFile({ url: url, path: opts.nativePath(file), directory: opts.nativeDirectory || 'DATA',
            recursive: true, connectTimeout: 15000, readTimeout: 20000 });
        }
        return caches.open(opts.cacheName).then(function (cache) {
          return fetch(url, { mode: 'cors', cache: 'no-store' }).then(function (res) {
            if (!res || !res.ok) throw new Error('http ' + (res && res.status) + ' for ' + file);
            if (res.type === 'opaque') throw new Error('CORS not enabled for ' + file);
            return cache.put(opts.cacheKeyFn(file), res);
          });
        });
      }).catch(function (err) {
        if (tryNo >= DL_MAX_TRIES) throw err;
        console.warn((opts.label || 'dl-core') + ': download retry ' + (tryNo + 1) + '/' + DL_MAX_TRIES + ' for ' + file, err);
        return new Promise(function (r) { setTimeout(r, 600 * tryNo); }).then(function () { return attempt(tryNo + 1); });
      });
    }
    return attempt(1);
  }
  // Bounded-concurrency runner (same shape as player.js's dynPool) — the lane structure both
  // download loops run their pool of downloadOne() calls through. Six lanes, not one: see the
  // r19 comment on both pages (18 clips downloaded strictly in series is a prime suspect for
  // where the minutes went).
  function pool(items, n, worker) {
    var i = 0;
    function lane() {
      if (i >= items.length) return Promise.resolve();
      return worker(items[i++]).then(lane);
    }
    var lanes = [];
    for (var k = 0; k < Math.min(n, items.length); k++) lanes.push(lane());
    return Promise.all(lanes);
  }

  // ── storage capability detection ─────────────────────────────────────────────────────────
  // native = Capacitor app (Filesystem plugin); webOk = a browser/PWA with Cache Storage.
  // `ok` mirrors playlists' DL_OK (native OR web-capable); `webOk` mirrors dyn-index's WEB_DL
  // (web-capable AND NOT native) — both pages read the field shaped for their own local var.
  function capabilities() {
    var C = window.Capacitor;
    /* r129: the playlists LIST runs embedded in the index panel (same-origin iframe). Capacitor
       injects its bridge into the TOP frame only, so inside the panel `window.Capacitor` is
       undefined and this fell back to the WEB storage path INSIDE THE NATIVE APP — downloads hung
       (owner: "perpetual ellipsis") and would have landed in Cache Storage where the native player
       never looks. Same-origin parent lookup restores the real bridge. */
    if (!C && window.parent && window.parent !== window) { try { C = window.parent.Capacitor; } catch (_) {} }
    var native = !!(C && C.isNativePlatform && C.isNativePlatform());
    var fs = (native && C.Plugins) ? C.Plugins.Filesystem : null;
    var webOk = !native && !!window.caches;
    return { native: native, fs: fs, webOk: webOk, ok: native || webOk };
  }

  // ── presence / ownership predicates (per-FILE owned==need counting, r81) ────────────────
  /* Of `neededFiles` under `prefix`, how many does THIS `ref`'s claim actually own — counted by
     the individual FILES, not the prefix as a unit. (r81: prefix-level counting made a single
     added sentence in a single-topic playlist invisible — "12 of 14 files owned" collapsed to
     "0 of 1 prefixes owned".) Returns {need, owned}; the caller decides what {all, some} mean for
     its own multi-prefix aggregate — that grouping is page-specific (a playlist groups several
     prefixes together; a topic unit is just the one). */
  function ownedCount(prefix, neededFiles, ref) {
    var e = getManifest()[prefix];
    var ours = !!(e && e.refs && e.refs.indexOf(ref) >= 0);
    var seen = {};
    if (ours) (e.files || []).forEach(function (f) { seen[f] = true; });
    var owned = 0;
    neededFiles.forEach(function (f) { if (seen[f]) owned++; });
    return { need: neededFiles.length, owned: owned };
  }
  // Does manifest[prefix] hold every one of `neededFiles`, REGARDLESS of who claims them —
  // "the bytes exist", not "we own them" (dyn-index's isDownloaded and playlists' dlHasAll both
  // ask this question, one via a count heuristic, one via this exact check).
  function hasFiles(prefix, neededFiles) {
    var have = ((getManifest()[prefix] || {}).files) || [];
    var seen = {};
    have.forEach(function (f) { seen[f] = true; });
    for (var i = 0; i < neededFiles.length; i++) if (!seen[neededFiles[i]]) return false;
    return true;
  }

  // ── D0 caption/state predicate ───────────────────────────────────────────────────────────
  /* D0 MIGRATION RULE (coordinator-approved, 2026-08-02, part of the D.1 pass). A manifest entry
     that is clearly a TOPIC claim — an explicit 'topic' ref, an IMPLICIT one (an entry written
     before `refs` existed at all is a pre-refs topic download by construction — see the standing
     comment on dyn-index's ownedByTopic), or the classic pre-dyn combined files
     (`<prefix>_TE.mp3` / `_ET.mp3`, from before per-sentence clips existed) — but that does NOT
     hold the full set of per-clip files a dyn build needs, must read as an UPDATE, not as "not
     downloaded" / "none". Otherwise a user's old classic download, or a dyn download interrupted
     before a single clip landed under this exact ref, silently reads as gone.
     Deliberately PURE and entry-based: it does not take the needed-file list, so each page layers
     it on top of its OWN completeness check (dyn-index's count-based hasAllClips, playlists'
     per-file dlOwnedNeeded) rather than this module re-deriving what "complete" means for either
     caller. */
  function looksLikeTopicClaim(prefix, e) {
    if (!e) return false;
    if (!e.refs) return true;                                    // predates `refs` → implicit topic
    if (e.refs.indexOf('topic') >= 0) return true;
    var files = e.files || [];
    return files.indexOf(prefix + '_TE.mp3') >= 0 || files.indexOf(prefix + '_ET.mp3') >= 0;
  }

  // ── Remove All: disk sweep (BOTH storage paths) + meta/manifest cleanup ─────────────────
  // Every `te_dyn_meta_*` localStorage key — a built (stitched) session record. Collected before
  // the sweep runs so both pages clear them the same way (the underlying FILE goes with the disk
  // sweep below; only the small JSON record needs removing here).
  function collectDynMetaKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('te_dyn_meta_') === 0) out.push(k);
      }
    } catch (_) {}
    return out;
  }
  /* r91 — SWEEP THE DISK, NOT THE MANIFEST. An ordinary per-prefix clear only ever deletes what
     the manifest says exists; a manifest that has forgotten a prefix (an old bug, a botched write)
     leaves its files stranded forever, reachable by no button on the device. "Remove All" instead
     enumerates the actual storage: native rmdir of the whole offline/ tree (also clears the empty
     directories a file-level delete leaves behind), or — on web — every Cache Storage key under
     /__offline-audio/ (clips) and /dyn/ (stitched sessions).
     ⚠⚠ NEVER `caches.delete(cacheName)` wholesale: read.js stores the Read Thai course (208
     clips) in the SAME cache, under full remote URLs, never under these two same-origin path
     prefixes — so it is out of range by construction, not by luck. Walking and filtering by path
     is the thing that keeps it safe. */
  function sweepAllDisk(cap, cacheName) {
    cacheName = cacheName || 'thaiear-audio-dl';
    return Promise.resolve().then(function () {
      if (cap.native) return cap.fs.rmdir({ directory: 'DATA', path: 'offline', recursive: true }).catch(function () {});
      if (!window.caches) return null;
      return caches.open(cacheName).then(function (c) {
        return c.keys().then(function (reqs) {
          return Promise.all(reqs.filter(function (rq) {
            var path = '';
            try { path = new URL(rq.url).pathname; } catch (_) { path = String(rq.url); }
            return path.indexOf('/__offline-audio/') === 0 || path.indexOf('/dyn/') === 0;
          }).map(function (rq) { return c.delete(rq).catch(function () {}); }));
        });
      }).catch(function () {});
    });
  }
  // Full Remove-All: sweep the disk (both paths), drop every built-session record, and clear both
  // manifest keys. Callers still own their own busy/status/selection/render bookkeeping around
  // this — this is the storage side only.
  function removeAllDownloads(cap, cacheName) {
    var metas = collectDynMetaKeys();
    return sweepAllDisk(cap, cacheName).then(function () {
      metas.forEach(function (k) { try { localStorage.removeItem(k); } catch (_) {} });
      try { localStorage.removeItem('thaiear_offline'); } catch (_) {}
      try { localStorage.removeItem('thaiear_offline_pl'); } catch (_) {}
    });
  }

  // ── the typed-REMOVE confirm modal ───────────────────────────────────────────────────────
  /* Word-for-word the same dialog on both pages already (dyn-index r89: "lifted from
     playlists.html so the two Remove All dialogs are identical"). Uses the shared `.modal-overlay`
     / `.modal-card` / `.btn` / `.modal-input` classes both pages already carry in their own CSS.
     Case-sensitive exact match on "REMOVE" (r95) — do not add `.toUpperCase()` or a
     `text-transform` on the field; both were tried and rejected, see the pages' own comments. */
  function removeAllModal(count, onConfirm) {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-card" role="dialog" aria-modal="true">' +
        '<h2>Remove ALL downloads?</h2>' +
        '<p>This removes every downloaded topic and playlist from this device' +
          (count ? ' — ' + count + ' item' + (count === 1 ? '' : 's') : '') +
          ', plus any leftover files from interrupted downloads. ' +
          'You can download them again any time, but it can’t be undone.' +
          '<br><br>Your <strong>Read Thai course</strong> download is not affected.' +
          '<br><br>Type <strong>REMOVE</strong> to confirm.</p>' +
        '<input class="modal-input" id="ra-input" type="text" maxlength="10">' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" id="ra-cancel">Cancel</button>' +
          '<button class="btn btn-danger" id="ra-ok" disabled>Remove all</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    var inp = ov.querySelector('#ra-input'), ok = ov.querySelector('#ra-ok');
    try { inp.focus({ preventScroll: true }); } catch (_) {}
    inp.addEventListener('input', function () { ok.disabled = inp.value.trim() !== 'REMOVE'; });
    ov.querySelector('#ra-cancel').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ok.addEventListener('click', function () {
      if (inp.value.trim() !== 'REMOVE') return;
      close(); onConfirm();
    });
  }

  // ── entitlement accessor hook ─────────────────────────────────────────────────────────────
  /* Reads through the owner's sim panel when it's present (the test space's entitlement
     simulator), and collapses to plain window.ThaiEarAuth once sim.js is deleted at rollout
     cleanup — the exact hook both pages already used inline. */
  function AUTH() {
    var S = window.ThaiEarSim;
    return (S && S.authView) ? S.authView(window.ThaiEarAuth) : window.ThaiEarAuth;
  }
  // Shared lockedFor plumbing. `canStoreOffline` is supplied BY THE CALLER, not decided here:
  // dyn-index and playlists deliberately disagree on it (dyn-index always passes false for a
  // fresh-download decision, r38/T-1; playlists passes its own DL_OK) and that difference is real
  // product behaviour, not a bug this consolidation should erase.
  function locked(item, canStoreOffline) {
    var a = AUTH();
    if (!a || typeof a.lockedFor !== 'function') return false;   // stale auth.js → never lock out
    return a.lockedFor({ tier: (item && item.tier) || 'free', prefix: item && item.prefix },
                       { canStoreOffline: !!canStoreOffline });
  }

  window.ThaiEarDL = {
    getManifest: getManifest,
    setManifest: setManifest,
    noteClip: noteClip,
    mergeFiles: mergeFiles,
    downloadOne: downloadOne,
    pool: pool,
    capabilities: capabilities,
    ownedCount: ownedCount,
    hasFiles: hasFiles,
    looksLikeTopicClaim: looksLikeTopicClaim,
    collectDynMetaKeys: collectDynMetaKeys,
    sweepAllDisk: sweepAllDisk,
    removeAllDownloads: removeAllDownloads,
    removeAllModal: removeAllModal,
    AUTH: AUTH,
    locked: locked
  };
})();
