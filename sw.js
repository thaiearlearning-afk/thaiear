/* ============================================================
   sw.js — ThaiEar service worker (offline app shell + pages).
   ------------------------------------------------------------
   Makes the site (and the Capacitor app, which loads the live site)
   work offline: the HTML pages, shared JS, images and fonts are cached
   on the device, so the app can cold-start with no internet, browse the
   topic grid, and open any page that's been visited while online.

   AUDIO is deliberately NOT handled here: clips live on the separate
   origin audio.thaiear.com (out of this SW's scope) and the native app's
   download feature owns offline audio. /api/ is never cached (auth,
   audio-signing, checkout must always be live).

   Strategy, THREE paths (see the big notes in the fetch handler):
     • NAVIGATIONS and anything not precached: NETWORK-FIRST, capped by
       NET_TIMEOUT_MS. Online always gets fresh content, so the tandem-update
       model is preserved and the cache is the offline fallback.
     • TOPIC-PAGE NAVIGATIONS (2026-08-12): STALE-WHILE-REVALIDATE out of the
       version-keyed cache ONLY. They were network-first like everything else, so
       the cached copy was never used online and every topic open paid a live,
       never-edge-cached origin round trip whose latency swung from ~0.2 s to
       ~2.4 s — which is why opening a topic felt "sometimes fast, sometimes
       slow". Safe because a VERSION bump empties the topic pages out of the
       cache, so this path can never serve pre-deploy content.
     • PRECACHED SUB-RESOURCES (player.js, auth.js, topics.js, nav.js, the CSS,
       the self-hosted fonts, the icons): CACHE-FIRST. Bumping VERSION is what
       invalidates them, so revalidating per request only cost a round-trip —
       ~350 KB of it on every single page load, which is what made topic pages
       take seconds to open in the iPhone PWA and the Android app.
   The esm.sh Supabase bundle is cached cross-origin in VENDOR_CACHE.

   ⚠ Bump VERSION to invalidate old caches on deploy. With the cache-first path
   this is LOAD-BEARING, not just tidy: change a precached file without bumping
   and clients keep serving the old copy.
   ============================================================ */
const VERSION = 'v312';   // v309: consent bar no longer covers the end of every page (body padding) — it was eating taps on prev/next; signup + end-of-topic cards restyled
                          // (dlRefPrefixes, r75's "lock-independent ground truth") instead of
                          // trusting the thaiear_offline_pl RECORD, matching player.js's
                          // dynOwnedPrefixes(). A record outlives evicted clips — an iOS PWA
                          // clears Cache Storage and leaves localStorage — so record-without-files
                          // rendered a tick over a playlist with nothing on the device.
                          // v304: a REMOVED playlist row no longer says "update available" for
                          // ever. dlState()'s D0 looksLikeTopicClaim() fallback is right for a
                          // topic card and wrong for a playlist row — it answers true on a 'topic'
                          // ref, i.e. "that TOPIC is downloaded", so any playlist sharing a prefix
                          // with a downloaded topic inherited its verdict. A playlist's state is
                          // ownership-only now, matching player.js's PLMODE branch. pl-list.js is
                          // precached (cache-first).
                          // v303: playlist clips route off the LIVE tier (topics.js tierForPrefix),
                          // not the tier snapshotted into playlist_items when the sentence was
                          // saved. The 2026-08-10 free/premium reorganisation moved 9 first-parts'
                          // MP3s to the public bucket, so saved rows still saying 'member' asked
                          // /api/audio to sign a PRIVATE-bucket URL for a file that had moved —
                          // a hard 404 that aborted the whole playlist download, retry-proof.
                          // topics.js, player.js and pl-list.js are all precached (cache-first).
                          // v302: "Tone twisters" -> "Tongue twisters" (DISPLAY ONLY — audio handle
                          // ToneTwister_LI1 and page topic-39.html unchanged) + Facebook link on
                          // socials.html. index.html, topics.js and socials.html are all precached.
                          // v301: read.js audio element attached to the DOM so the `activation`
                          // conversion fires on the reading course. It was detached, so attrib.js's
                          // capturing `play` listener never saw it and the whole read arm recorded
                          // ZERO activations. read.js is PRECACHED and served cache-first, so this
                          // bump is what actually delivers the fix — without it nobody gets the new copy.
const CACHE = 'thaiear-' + VERSION;
/* ⚠ VERSION-INDEPENDENT, NEVER SWEPT ON ACTIVATE (2026-08-09).
   The Supabase ESM bundle used to live in the version-keyed CACHE, so EVERY deploy destroyed it —
   and it is only ever RUNTIME-cached, so nothing put it back until the user next opened the site
   ONLINE. In that window auth.js's `import(SUPABASE_ESM)` could not resolve offline, so the client
   was never created, getUser() stayed null, and every signed-in offline surface fell back to its
   logged-out state: the playlists panel showed "Sign in (via the Menu)…" instead of the playlists
   sitting in localStorage a few lines away. Reported 2026-08-09 as "I see none of my playlists"
   in airplane mode, immediately after two deploys.
   This is the same trap the PRECACHE comment below already warns about for the shell pages —
   "anything only ever runtime-cached vanishes on every deploy" — with the one asset that offline
   AUTH depends on left on the wrong side of it.
   A separate cache, not a PRECACHE entry, because the @2 entry point pulls further chunks from
   esm.sh at import time; a bucket that survives keeps the whole module graph without this file
   needing to know esm.sh's internal layout. */
const VENDOR_CACHE = 'thaiear-vendor';
// Network-first is great online but offline the WebView's fetch can hang for many seconds before it
// rejects, making cached pages crawl in. If the network hasn't answered within this window and we
// have the page cached, serve the cache at once (and let the network refresh it in the background).
const NET_TIMEOUT_MS = 2000;
/* ADAPTIVE OFFLINE HINT (2026-08-09). `navigator.onLine` is useless here — it reports *online* in
   airplane mode in this WebView — so the worker learns from what actually happened instead: once a
   request has failed or blown NET_TIMEOUT_MS, assume the network is down for a short window and
   answer from cache immediately (see the fast path in the fetch handler). Any success clears it.
   Short on purpose: the cost of being wrong is serving a cached copy for a few seconds while the
   background revalidate refreshes it, which is what the timeout path already did anyway. The state
   is in memory, so a terminated worker simply re-learns it — nothing to invalidate. */
const NET_DOWN_MS = 10000;
/* How long to wait before writing a revalidated TOPIC page back into the cache. We have already
   handed the page the cached Response, and overwriting a cache entry whose body is still streaming
   can abort that read in WebKit (see the probeOnly note in the fetch handler). 3 s is comfortably
   past the point a 75 KB HTML body has been parsed, and the write happens inside waitUntil so the
   worker stays alive for it. */
const REVALIDATE_WRITE_DELAY_MS = 3000;
/* Which NAVIGATIONS take the stale-while-revalidate path in the fetch handler.
   Two families, both answered instantly from the version-keyed cache:

   1. TOPIC PAGES. Matches the clean URL Cloudflare Pages serves (/topic-04a) and the .html form
      (older bookmarks and inbound links still 308 through it). Split parts carry a single letter
      suffix: topic-04a, topic-25d, topic-32b.

   2. PRECACHED SHELL PAGES (added 2026-08-12) — the homepage, the 13 read pages, about, guide,
      account, progress, sentences and the rest. 29 navigable pages were sitting in the version
      cache, seeded at install, and STILL paying a full network round trip on every open. Home is
      the most-opened page on the site and the app's Home -> topic -> Home loop paid it twice.
      ⚠ This family is SAFER than topic pages, not riskier: a precache entry is fetched from the
      network during install, so the cached copy IS the deployed copy for this VERSION, and a
      VERSION bump re-seeds the lot. Topic pages are only runtime-cached, and they were already
      cleared for this treatment.
      Auth-gated shells (account/progress/sentences) are fine — only their SHELL is precached and
      per-user data is fetched by JS on load, which is exactly the existing design.
      Query strings are ignored on lookup (?next=, ?feature=1, ?sub=success): they are read by the
      page's own JS, never by the server, so one cached shell serves them all. */
function isTopicNav(req, url) {
  return req.mode === 'navigate' && /^\/topic-\d{1,3}[a-z]?(\.html)?$/i.test(url.pathname);
}
function isPrecachedNav(req, url) {
  if (req.mode !== 'navigate') return false;
  var p = url.pathname;
  // Try the path as-is, then the .html <-> clean variant, since Pages serves /about for /about.html.
  return PRECACHE_PATHS.has(p) ||
         PRECACHE_PATHS.has(p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html');
}
function isInstantNav(req, url) { return isTopicNav(req, url) || isPrecachedNav(req, url); }
var netDownUntil = 0;
function netLooksDown() { return Date.now() < netDownUntil; }
function noteNetDown() { netDownUntil = Date.now() + NET_DOWN_MS; }
function noteNetUp() { netDownUntil = 0; }

// Topic pages (topic-NN.html) 308-redirect to clean URLs (/topic-NN). A *redirected* Response
// can't be used for a navigation (the browser throws net::ERR_FAILED), so rebuild a clean,
// non-redirected copy before caching/serving any such response.
function cleanRedirect(res) {
  if (!res || !res.redirected) return Promise.resolve(res);
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

// Friendly fallback for an uncached page requested offline (instead of the webview's blank error).
function offlinePage() {
  var html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · ThaiEar</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#FAFAF8;color:#1A1A1A;text-align:center}' +
    '.b{padding:2rem;max-width:23rem}h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}' +
    'p{color:#5A5A5A;line-height:1.6;margin:.25rem 0 1.4rem}' +
    'button{display:inline-block;background:#4B41AD;color:#fff;border:none;font:inherit;font-weight:500;padding:10px 18px;border-radius:8px;cursor:pointer}' +
    '.alt{margin:1rem 0 0}.alt a{color:#4B41AD;text-decoration:none;font-weight:500;font-size:.9rem}' +
    '</style></head><body><div class="b"><h1>You’re offline</h1>' +
    '<p>This page isn’t available without a connection.</p>' +
    '<button onclick="if(history.length>1){history.back()}else{location.href=&#39;/index.html&#39;}">Go back</button>' +
    '<p class="alt"><a href="/index.html">Home</a></p></div></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Positive cache lookup (returns a Response or null — NEVER the offline page), used by the timeout
// fast-path so we only short-circuit to cache when we genuinely have the resource. Ignores the query
// string (member links carry ?next/?feature) and tries the .html<->clean variant for downloaded
// topic pages (persisted under their clean /topic-NN key).
function positiveCacheMatch(req, url) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    if (req.mode === 'navigate') {
      var p = url.pathname;
      var alt = p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html';
      return caches.match(alt, { ignoreSearch: true });
    }
    return null;
  });
}

// Thorough offline fallback, used when the network actually fails: exact match, then the home-grid
// and pathname/.html<->clean variants, finally the friendly offline page.
function cacheFallback(req, url) {
  return caches.match(req).then(function (hit) {
    if (hit) return cleanRedirect(hit);   // never hand the browser a redirected response for a nav
    if (req.mode === 'navigate') {
      // Home/index: serve the cached grid from either key so the logo/Home link always works.
      var p = url.pathname;
      if (p === '/' || p === '/index.html' || p === '/index') {
        return caches.match('/index.html').then(function (i) {
          return i ? cleanRedirect(i) : caches.match('/').then(function (r) { return r ? cleanRedirect(r) : offlinePage(); });
        });
      }
      // Match by PATHNAME, ignoring any query string (?next=, ?feature=1, ?sub=success…), then the
      // .html<->clean variant (downloaded topic pages live under their clean /topic-NN key).
      var alt = p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html';
      return caches.match(p, { ignoreSearch: true }).then(function (h1) {
        if (h1) return cleanRedirect(h1);
        return caches.match(alt, { ignoreSearch: true }).then(function (h2) {
          return h2 ? cleanRedirect(h2) : offlinePage();
        });
      });
    }
    return Response.error();
  });
}

// Best-effort precache so a brand-new install has the shell even before each
// asset is individually visited. Missing entries are ignored (never fail install).
const PRECACHE = [
  '/', '/index.html',
  // Navigable non-topic "shell" pages — precached so they open offline (each renders its own
  // logged-out/offline state) instead of falling through to the generic offline notice. Topic pages
  // are intentionally NOT here (cached on visit / via the download feature).
  '/account.html', '/subscribe.html', '/join.html', '/about.html', '/guide.html', '/socials.html', '/app.html',
  '/progress.html', '/sentences.html', '/privacy.html', '/terms.html', '/refunds.html', '/deleted.html',
  // Read Thai section (learn-to-read on-ramp, 2026-07-22): hub + 13 sub-pages + its
  // shared assets. Audio is NOT precached (208 clips on the CDN — cached on play).
  '/read.html', '/read-mid.html', '/read-high.html', '/read-low1.html', '/read-low2.html',
  '/read-vowels-long.html', '/read-vowels-short.html', '/read-vowels-special.html',
  '/read-finals.html', '/read-sounds.html', '/read-tones.html', '/read-clusters.html',
  '/read-quiz.html', '/read-results.html',
  '/read.js', '/read-data.js', '/read.css', '/betta.png',
  '/nav.js', '/topics.js', '/player.js', '/auth.js', '/footer.js',
  '/pl-list.js',   // r130: shared playlist-list module (index panel + playlists.html legacy embed)
  '/dl-core.js',   // r121: shared download engine (§D.1) — real product code, consumed by playlists.html (and the index from P2b)
  /* The "Study ThaiEar offline" app card. It never RENDERS in the app or an installed PWA — it is
     the plain-browser-tab counterpart to the download controls — but every topic page, read.html
     and index.html now carry its <script> tag, so an un-precached copy would mean a failed request
     on every offline page open in the very contexts that never use it. Cheap to seed, so seed it. */
  '/app-cta.js',
  /* Advertising measurement, r166. All three are on all 122 landable pages, so an un-precached
     copy means three failed requests on every offline page open. They are also the wrong thing to
     let a network fetch decide: consent.js carries the visitor's stored cookie choice and MUST be
     available to run before any tag can, offline included.
     NOTE gtag.js does not fetch googletagmanager unless consent was granted — and in the app and
     installed PWA it never does at all — so seeding these costs three small files and no requests. */
  '/consent.js', '/attrib.js', '/gtag.js',
  // Playlists + the owner entitlement simulator. PRECACHED because the offline behaviour is
  // exactly what they exist to test, and runtime caching couldn't guarantee it: bumping VERSION
  // creates a NEW cache and drops the old one, so anything only ever runtime-cached vanishes on
  // every deploy until it is visited online again. That is why the toggles were missing in
  // airplane mode. (Both disappear at rollout — playlists.html becomes a normal shell page.)
  '/playlists.html',
  /* ⚠ THE TEST SPACE ITSELF MUST BE PRECACHED, FOR EXACTLY THE REASON GIVEN ABOVE — and these were
     missed (2026-07-31). Runtime caching cannot hold them: bumping VERSION creates a NEW cache and
     drops the old one, so a topic-test page only ever runtime-cached VANISHES on every deploy until
     it is visited online again. Fifteen VERSION bumps in one day therefore wiped the owner's
     offline test pages fifteen times, and every airplane-mode test on iPhone silently fell back to
     the SW's offline page: no sim.js, so no test-space strip, no boot trace, no dyn player — which
     is why three captures in a row contained no topic-page lines at all, why the strip kept
     disappearing, and why the owner had to route back in via the live homepage.
     The offline behaviour of these pages IS the thing under test, so they cannot be left to a cache
     that a deploy destroys. They go with the rest of the scaffolding at rollout (§E). */
  '/player-dyn.css',   // the whole dyn player chrome — REAL product code (r127)
  /* r138 — GENERATED (gen_dyncss.js) from player.js's DYN_STYLES so topic pages can link the dyn
     control styles + the r28 body.te-v2 restyle in <head> and have them apply at FIRST PAINT.
     ⚠ MUST STAY PRECACHED alongside player-dyn.css: both are now render-blocking <link>s on every
     topic page, so an un-precached copy would mean a network round trip before a downloaded topic
     could paint offline — exactly the case the offline download exists to serve. */
  '/player-dyn-mount.css',
  // PWA install vehicle: manifest + its icons, so "Add to Home Screen" works and the
  // installed app has its launch icon available offline.
  '/manifest.json', '/icon-512.png', '/icon-512-maskable.png',
  '/logo-hero.png', '/nav-swirl-2x.png', '/favicon.png', '/favicon.ico',
  '/favicon-16.png', '/favicon-32.png', '/favicon-192.png', '/apple-touch-icon.png',
  '/khwai.jpg', '/meditator.png', '/muaythai.png', '/sakyantelephant.jpg', '/gecko.png', '/hornbill.png', '/yak.png',
  // Self-hosted fonts (replaced Google Fonts 2026-06-24): precache the full used set so a
  // freshly-downloaded topic renders Sarabun (Thai) + Inter offline, not the system fallback.
  '/fonts/inter-latin-300.woff2', '/fonts/inter-latin-400.woff2',
  '/fonts/inter-latin-500.woff2', '/fonts/inter-latin-600.woff2',
  '/fonts/sarabun-thai-300.woff2', '/fonts/sarabun-thai-400.woff2',
  '/fonts/sarabun-thai-500.woff2', '/fonts/sarabun-thai-600.woff2',
  '/fonts/sarabun-latin-300.woff2', '/fonts/sarabun-latin-400.woff2',
  '/fonts/sarabun-latin-500.woff2', '/fonts/sarabun-latin-600.woff2'
];

/* Fast lookup for the cache-first path in the fetch handler below. */
const PRECACHE_PATHS = new Set(PRECACHE);

/* Add a list of URLs a few at a time. ~150 simultaneous fetches on a phone is exactly how the
   install below used to end up half-finished: the burst is throttled or the radio drops, entries
   fail, and .catch() swallows it. Small batches are far more likely to complete. */
function addBatched(c, urls, width) {
  var i = 0;
  function lane() {
    if (i >= urls.length) return Promise.resolve();
    var u = urls[i++];
    return c.add(u).catch(function () {}).then(lane);
  }
  var lanes = [];
  for (var n = 0; n < Math.min(width || 6, urls.length); n++) lanes.push(lane());
  return Promise.all(lanes);
}

/* ⚠ PRECACHE REPAIR (2026-08-09) — WHY A DEPLOY MUST NOT BE ABLE TO BREAK OFFLINE.
   install() fires one c.add() per PRECACHE entry and swallows every failure, and skipWaiting()
   activates the new worker whether or not they landed. activate() then DELETES the previous
   version's cache — which still held all of them. So one flaky install left permanent holes, and
   the device came out of the deploy WORSE offline than it went in, with nothing ever retrying.
   Reported 2026-08-09 after five VERSION bumps in a day: the Read hub rendered as unstyled plain
   text (read.css missing), lessons fell through to the offline page (read-*.html missing), and
   meditator.png had vanished from the playlists panel — all of them precache entries.
   Two-stage repair, in this order, because the first stage needs NO network and therefore works
   even when the new worker is picked up offline:
     1. fill any gap from the OUTGOING cache before deleting it — a deploy can then never lose
        content the device already had;
     2. re-fetch just those gaps once the old caches are gone, so a migrated (possibly stale) copy
        is replaced by the current one whenever there IS a connection.
   Only ever fills gaps — an entry the install DID land is never overwritten by an older copy. */
function precacheGaps(c) {
  var gaps = [];
  return Promise.all(PRECACHE.map(function (u) {
    return c.match(u).then(function (hit) { if (!hit) gaps.push(u); }).catch(function () { gaps.push(u); });
  })).then(function () { return gaps; });
}
function migrateGaps(c, gaps, olds) {
  if (!gaps.length || !olds.length) return Promise.resolve(gaps);
  return Promise.all(gaps.map(function (u) {
    return (function tryOld(i) {
      if (i >= olds.length) return Promise.resolve();
      return caches.open(olds[i])
        .then(function (oc) { return oc.match(u); })
        .then(function (hit) { return hit ? c.put(u, hit.clone()) : tryOld(i + 1); })
        .catch(function () { return tryOld(i + 1); });
    })(0);
  })).then(function () { return gaps; });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return addBatched(c, PRECACHE, 6); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      // Keep the current shell cache, the persistent downloaded-PAGES cache ('thaiear-dl'), and the
      // downloaded-AUDIO cache ('thaiear-audio-dl', the web/PWA offline-audio store) — neither
      // downloads cache is ever version-wiped, so offline content survives an SW update.
      .then(function (keys) {
        var doomed = keys.filter(function (k) {
          return k !== CACHE && k !== VENDOR_CACHE && k !== 'thaiear-dl' && k !== 'thaiear-audio-dl';
        });
        return caches.open(CACHE).then(function (c) {
          return precacheGaps(c)
            // 1. rescue what the install missed from the cache we are about to delete (no network)
            .then(function (gaps) { return migrateGaps(c, gaps, doomed); })
            // 2. only now is it safe to drop the old versions
            .then(function (gaps) {
              return Promise.all(doomed.map(function (k) { return caches.delete(k); }))
                .then(function () {
                  /* 3. refresh the rescued copies — ⚠ DELIBERATELY NOT RETURNED, so activation
                     does NOT wait for it. Returning it (v258) was a serious regression: OFFLINE
                     every gap is a fetch that HANGS for many seconds, and with ~73 gaps after a
                     failed install that kept waitUntil pending for minutes — during which
                     clients.claim() below had not run, so the new worker controlled nothing and
                     every request bypassed the SW straight into a dead network. That is what the
                     owner saw on 2026-08-09: downloaded topics taking 5-6s to open, a totally
                     white screen, auth flickering signed-out-then-back-in, and playlist writes
                     failing because currentUser was still null.
                     The content is already correct at this point — stage 1 migrated it out of the
                     outgoing cache with no network — so this is purely an opportunistic
                     freshening and must never gate activation. */
                  addBatched(c, gaps, 6);
                });
            });
        });
      })
      /* ⚠ REPAIR THE POISONED `thaiear-dl` (2026-08-12). See the long note in the fetch handler:
         cachePage() used to copy the shared SCRIPTS into this never-version-wiped cache, where
         they then shadowed every fresh copy forever. Fixing the lookup stops the bleeding for new
         installs; this evicts the copies already sitting on people's devices, which is what
         actually repairs the owner's broken index.
         ⚠ ONLY evicts an entry once the CURRENT version cache is confirmed to hold that file, so
         this can never take away an offline fallback — worst case it does nothing. Pages (the
         reason this cache exists) and audio-versions.json are untouched: only the shared scripts,
         which are all PRECACHE entries and therefore guaranteed present in CACHE. Deliberately not
         returned into waitUntil's chain would be wrong here — it is cache-only work with no
         network, so it is safe to await and we want it done before clients.claim(). */
      .then(function () {
        var POISONED = ['/topics.js', '/player.js', '/nav.js', '/auth.js', '/footer.js'];
        return caches.open('thaiear-dl').then(function (dl) {
          return caches.open(CACHE).then(function (c) {
            return Promise.all(POISONED.map(function (u) {
              return c.match(u).then(function (fresh) {
                return fresh ? dl.delete(u) : null;   // never evict what CACHE cannot replace
              }).catch(function () {});
            }));
          });
        }).catch(function () {});
      })
      /* NAVIGATION PRELOAD (2026-08-11) — the fix for "a topic I have NOT opened before takes a
         few seconds in the app/PWA, but is instant in the phone browser".
         With a controlling worker, a navigation cannot start until the worker is RUNNING, and in a
         standalone PWA / Capacitor WebView the worker is usually terminated between visits. So the
         cost was serialised: boot sw.js, THEN begin the network request. A browser tab with no
         controlling worker just issues the request, which is exactly why it felt fast there.
         Preload tells the browser to start the navigation request IN PARALLEL with booting the
         worker, so the cost becomes max(boot, network) instead of boot + network. Nothing else
         changes — the fetch handler simply uses e.preloadResponse when it is there.
         Local registration setting, NOT a network call, so it cannot violate the
         "nothing in activate may await the network" rule above. Guarded because iOS Safari only
         gained support in 17; where it is absent, preloadResponse is undefined and the handler
         falls back to its own fetch(). */
      .then(function () {
        if (self.registration && self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable().catch(function () {});
        }
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Cross-origin: cache the Supabase ESM bundle (esm.sh) cache-first, so auth works offline (the
  // import is pinned to @2, so a stable cached copy is fine); leave audio & the rest alone.
  // (Fonts used to be Google-hosted and cached here; they're self-hosted now — handled same-origin.)
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'esm.sh') {
      /* Stale-while-revalidate out of the SURVIVING vendor cache (see VENDOR_CACHE above).
         Cache-first so offline auth works instantly; the background refresh keeps the pinned @2
         copy current without there ever being a moment when it is absent. The revalidate must
         swallow its own failure — offline it always rejects, and an uncaught rejection here would
         surface as an SW error on every page load. */
      e.respondWith(
        caches.open(VENDOR_CACHE).then(function (c) {
          return c.match(req).then(function (hit) {
            var net = fetch(req).then(function (res) {
              if (res && res.ok) { try { c.put(req, res.clone()); } catch (_) {} }
              return res;
            }).catch(function () { return null; });
            if (hit) return hit;                     // serve at once, refresh behind it
            return net.then(function (res) { return res || Response.error(); });
          });
        })
      );
    }
    return;
  }

  if (url.pathname.indexOf('/api/') === 0) return;  // never cache API calls
  if (/\.apk$/i.test(url.pathname)) return;         // don't intercept/cache the APK download

  /* ⚠ PRECACHED SUB-RESOURCES ARE CACHE-FIRST (2026-08-11). Do not "restore" them to network-first.
     These are the version-keyed shell files — player.js, auth.js, topics.js, nav.js, the CSS, the
     fonts, the icons. Bumping VERSION is what invalidates them: activate() re-seeds the new cache
     from the network, which is the entire point of a version-keyed precache. Revalidating them on
     every request bought nothing and cost a network round-trip each.

     What it cost, measured on a topic page in a real browser: player.js reported transferSize 0 —
     a worker response — yet a duration of 3534 ms, because the worker was fetching all 457 KB from
     the network before answering. Roughly 350 KB of precached JS behaved that way on EVERY
     navigation, serialised behind the HTML, so scripts did not begin until ~3 s and load landed at
     8.2 s on DESKTOP. The owner reported topic pages taking "a few seconds" to open specifically in
     the iPhone PWA and the Android app, and fine in desktop Edge — the same work on a phone CPU and
     a WebView fetch.

     NAVIGATIONS ARE DELIBERATELY EXCLUDED. Pages stay network-first so the tandem-update model
     holds and an online visitor always gets fresh content. This only changes sub-resources whose
     freshness is already governed by VERSION.

     THE DEPENDENCY THIS CREATES: if you change a precached file you MUST bump VERSION, or clients
     keep the old copy. That was already the standing rule (see the PRECACHE note above); this makes
     it load-bearing rather than merely tidy. */
  /* ⚠⚠ LOOK IN `CACHE` ONLY — NEVER `caches.match()` (fixed 2026-08-12, and this was a REAL BUG
     that shipped with v292, not a theoretical one).
     `caches.match(req)` with no cacheName searches EVERY cache in CREATION ORDER, and
     `thaiear-dl` is never version-wiped by design. player.js's cachePage() used to copy
     `/topics.js`, `/player.js`, `/nav.js`, `/auth.js` and `/footer.js` into it, so on any device
     that had ever downloaded a topic, `thaiear-dl` was created BEFORE the current version cache
     and therefore WON every lookup. Those five files were frozen at whenever cachePage() last
     ran, and no VERSION bump could ever dislodge them — the entire point of a version-keyed
     precache, silently defeated for exactly the users who use the app most.
     It could not even self-heal: cachePage()'s `c.add('/topics.js')` fetches THROUGH this handler,
     which served the stale thaiear-dl copy straight back into thaiear-dl.
     Symptom it produced (owner, 2026-08-12): a stale topics.js against fresh CSS on the index —
     retired "coming soon" topics reappearing at the bottom of the grid and comically oversized
     padlock SVGs. Anything that depends on a shared script matching the page it ships with can
     surface this way, so treat "impossible" staleness on ONE device as this first.
     `thaiear-dl`'s correct role is OFFLINE FALLBACK — it is still searched by cacheFallback() and
     positiveCacheMatch() when the network actually fails. It must never shadow a live lookup. */
  if (req.mode !== 'navigate' && PRECACHE_PATHS.has(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then(function (c) { return c.match(req); }).then(function (hit) {
        if (hit) return hit;
        // Not seeded yet (install still running, or a partial install): fetch and store it.
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          noteNetUp();
          return res;
        }).catch(function () { noteNetDown(); return cacheFallback(req, url); });
      })
    );
    return;
  }

  // Same-origin pages + assets: network-first for freshness (preserves the tandem-update model),
  // but capped by NET_TIMEOUT_MS. Offline, the WebView's fetch can hang for many seconds before it
  // rejects — which made cached pages slow to appear. So if the network hasn't answered in time AND
  // we have the resource cached, serve the cache immediately while the network keeps running in the
  // background to refresh it (stale-while-revalidate). On a real network failure, fall back fully.
  e.respondWith((function () {
    /* probeOnly: report recovery but DO NOT touch the cache. Used by the offline fast path below,
       which has already handed the CACHED response to the page. Writing the same entry while its
       body is still streaming can abort that read in WebKit — surfacing as a blob error page on
       navigation (owner saw one once, tapping the logo in airplane mode just after an update).
       The next request that goes through the normal path caches as usual, so nothing goes stale;
       this only removes a write that was racing a read for no benefit. */
    function fromNetwork(probeOnly) {
      /* Use the navigation-preload response when the browser has one in flight (see the note in
         activate). It was started in parallel with booting this worker, so it is already ahead of
         anything fetch() could begin now. Resolves to undefined when preload is unsupported or
         this is not a navigation — then we issue the request ourselves exactly as before.
         ⚠ It must be consumed or the browser warns about an unused preload response. */
      var started = (req.mode === 'navigate' && e.preloadResponse)
        ? e.preloadResponse.then(function (pre) { return pre || fetch(req); }, function () { return fetch(req); })
        : fetch(req);
      return started.then(function (res) {
        noteNetUp();
        if (!probeOnly && res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          cleanRedirect(copy).then(function (clean) { caches.open(CACHE).then(function (c) { c.put(req, clean); }); });
        }
        return res;
      }, function (err) { noteNetDown(); throw err; });
    }
    /* ⚠ FAST PATH — the network is already known to be down, so do NOT pay NET_TIMEOUT_MS again.
       This is what made every offline page load slow (owner, 2026-08-09: a downloaded topic taking
       "5 or 6 seconds to open", and "issues each time airplane mode is on" rather than once after a
       deploy). Each same-origin request waited the full 2 s before falling back to cache, and a page
       is many requests in waves, so the cost stacked on EVERY load — the worker re-discovered the
       outage per resource instead of remembering it.
       Cache-first here, with the network still fired in the background so recovery is noticed and
       the copy refreshes. Falls through to the normal path on a cache miss, so nothing that is not
       cached is answered any less correctly. */
    if (netLooksDown()) {
      return positiveCacheMatch(req, url).then(function (hit) {
        if (!hit) return fromNetwork().catch(function () { return cacheFallback(req, url); });
        fromNetwork(true).catch(function () {});   // recovery PROBE only — never writes the entry we are serving
        return cleanRedirect(hit);
      });
    }

    /* ⚠⚠ STALE-WHILE-REVALIDATE FOR TOPIC PAGES + THE PRECACHED SHELL (2026-08-12) — why opening
       a topic was "intermittently slow, sometimes fast", and why Home was never instant either.
       Navigations were network-first with no exception, so the SW's own cached copy was NEVER used
       while online. Measured on the live site with the page sitting in thaiear-v293 and the worker
       already warm (workerStart 6 ms): TTFB 1569 ms, load 2950 ms. The cache was right there and
       was skipped. Every topic open therefore paid a live origin round trip — and Cloudflare
       returns `cf-cache-status: DYNAMIC` for HTML, so it is never edge-cached and its latency
       swings (219 ms → 2409 ms measured on one machine in one minute). Above NET_TIMEOUT_MS the
       worker gave up and served the cache INSTANTLY, so the same page alternated between instant
       and ~2 s purely on network jitter. That oscillation was the reported symptom.

       ⚠ THE SAFETY PROPERTY IS THAT WE LOOK IN `CACHE` ONLY — the version-keyed cache — and NOT
       via caches.match(), which would also search `thaiear-dl`. Topic pages are deliberately not
       precached, and activate() deletes every non-current cache, so a VERSION bump leaves CACHE
       with NO topic pages in it: the first visit to each topic after a deploy is always a network
       fetch. That makes it impossible for this path to serve pre-deploy content, which is what
       keeps the tandem text/audio model intact. `thaiear-dl` survives deploys BY DESIGN, so it
       must stay out of the instant path — it keeps its existing role as the offline fallback
       reached through cacheFallback().

       The PRECACHED SHELL pages (Home, the 13 read pages, about/guide/account/…) join this path
       for the same reason and with a stronger guarantee — see isInstantNav() above. 29 navigable
       pages were sitting in this very cache and still paying a network round trip on every open. */
    if (isInstantNav(req, url)) {
      return caches.open(CACHE)
        .then(function (c) {
          /* ⚠ TRY THE .html <-> CLEAN VARIANT TOO, or this path silently does nothing for the
             pages it was added for. Cloudflare Pages serves /about, but PRECACHE (and therefore
             the cache KEY) is '/about.html' — so matching the request URL alone missed on every
             real navigation, fell through to the network, and looked exactly like success.
             Same reasoning as positiveCacheMatch(); this one is scoped to CACHE on purpose. */
          return c.match(req, { ignoreSearch: true }).then(function (hit) {
            if (hit) return hit;
            var p = url.pathname;
            var alt = p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html';
            return c.match(alt, { ignoreSearch: true });
          });
        })
        .then(function (hit) {
          if (!hit) return networkFirstWithTimeout();   // first visit this VERSION → normal path
          /* ⚠ THE REVALIDATE WRITE IS DELAYED, AND THAT IS NOT COSMETIC. We have just handed the
             page this cached Response; overwriting the same cache entry while its body is still
             streaming can abort that read in WebKit — the exact bug the probeOnly flag above was
             added for (it surfaced as a blob error page on navigation). fromNetwork(true) fetches
             WITHOUT writing (and consumes e.preloadResponse, so no "unused preload response"
             warning), then we write once the body has certainly been consumed. */
          try {
            e.waitUntil(fromNetwork(true).then(function (res) {
              if (!res || !res.ok || res.type !== 'basic') return;
              return cleanRedirect(res.clone()).then(function (clean) {
                return new Promise(function (done) {
                  setTimeout(function () {
                    caches.open(CACHE)
                      .then(function (c) { return c.put(req, clean); })
                      .catch(function () {})
                      .then(done, done);
                  }, REVALIDATE_WRITE_DELAY_MS);
                });
              });
            }).catch(function () {}));
          } catch (_) {}
          return cleanRedirect(hit);
        });
    }

    return networkFirstWithTimeout();

    function networkFirstWithTimeout() {
      var network = fromNetwork();
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          /* Did not answer in time — remember that, so the NEXT request skips the wait entirely.
             Deliberately also on a TIMEOUT, not just a rejection: offline in this WebView a fetch
             usually hangs rather than failing, so waiting for the rejection would never teach us
             anything in the case that matters most. */
          noteNetDown();
          positiveCacheMatch(req, url).then(function (hit) {
            if (hit && !settled) { settled = true; resolve(cleanRedirect(hit)); }
          });
        }, NET_TIMEOUT_MS);
        network.then(
          function (res) { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } },
          function () { if (!settled) { settled = true; clearTimeout(timer); resolve(cacheFallback(req, url)); } }
        );
      });
    }
  })());
});
