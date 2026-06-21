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
const VERSION = 'v3';
const CACHE = 'thaiear-' + VERSION;

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
      // Keep the current shell cache AND the persistent downloaded-pages cache ('thaiear-dl').
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== 'thaiear-dl'; }).map(function (k) { return caches.delete(k); })); })
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

  if (url.pathname.indexOf('/api/') === 0) return;  // never cache API calls
  if (/\.apk$/i.test(url.pathname)) return;         // don't intercept/cache the APK download

  // Same-origin pages + assets: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        cleanRedirect(copy).then(function (clean) { caches.open(CACHE).then(function (c) { c.put(req, clean); }); });
      }
      return res;
    }).catch(function () {
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
          return offlinePage(); // any other uncached page → friendly offline notice, not a blank error
        }
        return Response.error();
      });
    })
  );
});
