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

   Strategy: same-origin GETs are NETWORK-FIRST (online always gets fresh
   content — the tandem-update model is preserved — and the cache is only
   used as the offline fallback). Google Fonts are cache-first.
   Bump VERSION to invalidate old caches on deploy.
   ============================================================ */
const VERSION = 'v1';
const CACHE = 'thaiear-' + VERSION;

// Best-effort precache so a brand-new install has the shell even before each
// asset is individually visited. Missing entries are ignored (never fail install).
const PRECACHE = [
  '/', '/index.html',
  '/nav.js', '/topics.js', '/player.js', '/auth.js', '/footer.js',
  '/logo.png', '/logoshort.png', '/favicon.png', '/favicon.ico',
  '/favicon-16.png', '/favicon-32.png', '/apple-touch-icon.png',
  '/khwai.png', '/meditator.png', '/muaythai.png', '/sakyantelephant.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return Promise.all(PRECACHE.map(function (u) { return c.add(u).catch(function () {}); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Cross-origin: cache Google Fonts (cache-first); leave audio.thaiear.com & everything else alone.
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      e.respondWith(
        caches.open(CACHE).then(function (c) {
          return c.match(req).then(function (hit) {
            return hit || fetch(req).then(function (res) { try { c.put(req, res.clone()); } catch (_) {} return res; });
          });
        })
      );
    }
    return;
  }

  if (url.pathname.indexOf('/api/') === 0) return; // never cache API calls

  // Same-origin pages + assets: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error());
      });
    })
  );
});
