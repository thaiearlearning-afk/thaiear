/* ============================================================
   billing.js — Premium bought INSIDE the Android app, through Google Play (2026-10-12)
   ------------------------------------------------------------
   window.ThaiEarBilling: buy() · restore() · sync() · offering() · diagnose() over RevenueCat's
   Capacitor plugin ("Purchases", in the app from 1.7 / versionCode 9). Plan and status:
   GOOGLE_PAYMENTS_PLAN.md (tooling repo) §3b; the server half is functions/api/google-play.js.

   ⛔ NOTHING HERE DECIDES WHO IS PREMIUM. A purchase only tells the SERVER to look
      (POST /api/google-play). The server asks RevenueCat and writes the one `subscriptions` row
      that audio.js, auth.js and the account page already read. A page that wants to know whether
      someone is Premium asks ThaiEarAuth, exactly as before.
   ⛔ SIGNED IN TO BUY. The ThaiEar user id IS the RevenueCat app user id, so a purchase belongs
      to an account, never to a phone. RevenueCat is never configured anonymously.
   ⚠ EVERY CALL RESOLVES, NONE REJECTS: { ok: true, … } or { ok: false, reason }. The website, an
      app older than 1.7, signed out, no key on the server — each is a plain reason, so a button
      wired to this can never be left half-pressed by an exception.
   ⚠ NOT LOADED BY ANY PAGE YET (B: the build, "no visible button"). The owner panel loads it for
      its billing check. Not in sw.js PRECACHE: buying needs the network anyway.
   ⛔ diagnose() never returns the user id or the key. The owner copies its output into a chat, and
      a user id is personal data (CLAUDE.md Golden Rule 0).
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarBilling) return;

  var API = '/api/google-play';
  /* Set when a purchase or restore STARTS on this device. autoInit() configures the SDK on a later
     page only where this is set: a payment that completes after the app was closed is acknowledged
     by the SDK once it is running again (Google refunds what is not acknowledged within 3 days),
     while a device that never opened the purchase sheet sends RevenueCat nothing. */
  var SEEN_KEY = 'te_rc_seen';
  var SYNC_DELAYS = [0, 1500, 4000];   // ms before each try of POST /api/google-play

  function cap() { return window.Capacitor || null; }
  function isApp() {
    var c = cap();
    try { return !!(c && c.isNativePlatform && c.isNativePlatform()); } catch (_) { return false; }
  }
  /* The INSTALLED app decides, not this file: the website updates at once and the app does not.
     Capacitor publishes each native plugin's methods synchronously as PluginHeaders (the same
     test player.js nativeHas() makes for NativeAudio). An app older than 1.7 has no Purchases
     entry, and every call below then answers { ok:false, reason:'unavailable' }. */
  function pluginHas(m) {
    try {
      var hs = (cap() && cap().PluginHeaders) || [];
      for (var i = 0; i < hs.length; i++) {
        if (hs[i] && hs[i].name === 'Purchases') {
          return (hs[i].methods || []).some(function (x) { return x && x.name === m; });
        }
      }
    } catch (_) {}
    return false;
  }
  function plugin() {
    if (!isApp() || !pluginHas('purchasePackage')) return null;
    var c = cap();
    return (c.Plugins && c.Plugins.Purchases) || null;
  }
  function auth() { return window.ThaiEarAuth || null; }
  function userId() {
    var a = auth(), u = a && a.getUser && a.getUser();
    return (u && u.id) ? String(u.id) : '';
  }
  function token() {
    var a = auth();
    if (!a) return Promise.resolve(null);
    try {
      return Promise.resolve(a.freshToken ? a.freshToken() : (a.getAccessToken ? a.getAccessToken() : null))
        .catch(function () { return null; });
    } catch (_) { return Promise.resolve(null); }
  }
  function isPremium() {
    var a = auth();
    try { return !!(a && a.isSubscribed && a.isSubscribed()); } catch (_) { return false; }
  }
  function offline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Every plugin call goes through here, so even a synchronous throw arrives as a rejection.
  function call(fn) { return Promise.resolve().then(fn); }
  function fail(reason, extra) {
    var o = { ok: false, reason: reason };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (_) {} }
  function seen() { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (_) { return false; } }

  /* ── what the plugin's errors mean ──────────────────────────────────────────────────────────
     The plugin rejects with code = RevenueCat's PurchasesErrorCode as a string ("1" = cancelled)
     and data.readableErrorCode = its name. Both are read, so a renamed field cannot turn a
     cancelled sheet into "something went wrong". */
  var BY_CODE = { '1': 'cancelled', '3': 'not_allowed', '6': 'already_owned', '7': 'owned_by_other_account',
                  '10': 'network', '11': 'bad_key', '15': 'busy', '20': 'pending', '23': 'store_config' };
  var BY_NAME = [['PURCHASECANCELLED', 'cancelled'], ['PAYMENTPENDING', 'pending'],
                 ['PRODUCTALREADYPURCHASED', 'already_owned'], ['RECEIPTALREADYINUSE', 'owned_by_other_account'],
                 ['NETWORK', 'network'], ['OPERATIONALREADYINPROGRESS', 'busy'],
                 ['PURCHASENOTALLOWED', 'not_allowed'], ['INVALIDCREDENTIALS', 'bad_key'],
                 ['CONFIGURATION', 'store_config']];
  function errReason(e) {
    var d = (e && e.data) || {};
    if (d.userCancelled === true) return 'cancelled';
    var code = (e && e.code != null) ? String(e.code) : (d.code != null ? String(d.code) : '');
    if (BY_CODE[code]) return BY_CODE[code];
    var name = String(d.readableErrorCode || d.readable_error_code || '').toUpperCase().replace(/[^A-Z]/g, '');
    for (var i = 0; i < BY_NAME.length; i++) if (name.indexOf(BY_NAME[i][0]) === 0) return BY_NAME[i][1];
    return 'error';
  }
  function errText(e) {
    var d = (e && e.data) || {};
    return String((e && e.message) || d.message || e || '').slice(0, 200);
  }

  /* ── server config: the public SDK key lives in Cloudflare, not in this file ─────────────── */
  var configP = null;
  function getConfig() {
    if (configP) return configP;
    var p = token().then(function (t) {
      if (!t) return null;
      return fetch(API, { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; });
    }).then(function (j) {
      if (!j || !j.apiKey) return null;
      return { apiKey: String(j.apiKey), serverReady: !!j.serverReady };
    }, function () { return null; });
    // Only a real answer is kept for the page's life; a failure is asked again next time.
    var mine = p.then(function (c) { if (!c && configP === mine) configP = null; return c; });
    configP = mine;
    return mine;
  }

  /* ── the SDK, configured for THIS account ───────────────────────────────────────────────────
     The native Purchases object outlives the page: the app keeps it across every navigation in
     one run. So a page cannot assume it starts unconfigured, and it must not assume the user is
     the one it was configured for — a sign-out and a different sign-in leave the old id inside.
     Configured → compare the id → logIn on a mismatch. Never logOut: that creates an anonymous
     RevenueCat user, the one thing this file exists never to make. */
  var readyFor = '', readyP = null;
  function ready() {
    var P = plugin();
    if (!P) return Promise.resolve(fail('unavailable'));
    var uid = userId();
    if (!uid) return Promise.resolve(fail('signed_out'));
    if (readyP && readyFor === uid) return readyP;
    readyFor = uid;
    var p = call(function () { return P.isConfigured(); }).then(function (r) {
      if (r && r.isConfigured) {
        return call(function () { return P.getAppUserID(); }).then(function (g) {
          if (g && String(g.appUserID) === uid) return { ok: true };
          return call(function () { return P.logIn({ appUserID: uid }); }).then(function () { return { ok: true, switched: true }; });
        });
      }
      return getConfig().then(function (c) {
        if (!c) return fail('not_configured');
        return call(function () { return P.configure({
          apiKey: c.apiKey,
          appUserID: uid,
          // No device identifiers: ThaiEar has no ad-attribution integration for them to serve.
          automaticDeviceIdentifierCollectionEnabled: false
        }); }).then(function () { return { ok: true, configured: true }; });
      });
    }).then(null, function (e) { return fail(errReason(e), { message: errText(e) }); });
    // A failure is not kept: the next call tries again. Only THIS attempt may clear the slot.
    var mine = p.then(function (r) { if (!r.ok && readyP === mine) { readyP = null; readyFor = ''; } return r; });
    readyP = mine;
    return mine;
  }

  /* ── the thing to buy: the current offering's monthly package ──────────────────────────────
     ONE monthly plan (owner, 2026-10-12). Falls back to the first package anywhere, so an
     offering set up without the "monthly" package type still sells. */
  function pickPackage(o) {
    if (!o) return null;
    var cur = o.current || null;
    if (cur && cur.monthly) return cur.monthly;
    if (cur && cur.availablePackages && cur.availablePackages.length) return cur.availablePackages[0];
    var all = o.all || {};
    for (var k in all) {
      if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
      var a = all[k];
      if (a && a.monthly) return a.monthly;
      if (a && a.availablePackages && a.availablePackages.length) return a.availablePackages[0];
    }
    return null;
  }
  function offering() {
    return ready().then(function (r) {
      if (!r.ok) return r;
      return call(function () { return plugin().getOfferings(); }).then(function (o) {
        var pkg = pickPackage(o);
        if (!pkg) return fail('no_offering');
        var pr = pkg.product || {};
        return { ok: true, pkg: pkg, productId: pr.identifier || '', price: pr.priceString || '', title: pr.title || '' };
      }, function (e) { return fail(errReason(e), { message: errText(e) }); });
    });
  }

  /* ── tell the server to look ────────────────────────────────────────────────────────────────
     Retried, because the purchase has ALREADY HAPPENED by the time this runs: a dropped request
     here must not read as a failed purchase. RevenueCat's webhook writes the same row within
     about a minute anyway, so a sync that never lands costs a delay, never the membership. */
  function syncOnce(t) {
    return fetch(API, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
      .then(function (r) {
        return r.json().then(null, function () { return {}; }).then(function (j) { return { status: r.status, j: j || {} }; });
      }, function () { return { status: 0, j: {} }; });
  }
  function sync() {
    return token().then(function (t) {
      if (!t) return fail('signed_out');
      var i = 0;
      function attempt() {
        return wait(SYNC_DELAYS[i]).then(function () { return syncOnce(t); }).then(function (res) {
          if (res.status === 200 && res.j.ok) {
            return { ok: true, premium: !!res.j.premium, source: res.j.source || null };
          }
          // 4xx is an answer (signed out, not configured), not a blip: do not hammer it.
          var retry = res.status === 0 || res.status >= 500;
          if (retry && ++i < SYNC_DELAYS.length) return attempt();
          return fail('sync_failed', { status: res.status, error: res.j.error || null });
        });
      }
      return attempt();
    });
  }

  /* ── buy / restore: one at a time ────────────────────────────────────────────────────────── */
  var busy = false;
  function guarded(run) {
    if (busy) return Promise.resolve(fail('busy'));
    busy = true;
    return Promise.resolve().then(run).then(null, function (e) {
      return fail('error', { message: errText(e) });
    }).then(function (r) { busy = false; return r; });
  }
  function settled() {
    // The store said yes. Whatever the sync says, the purchase stands.
    return sync().then(function (s) {
      return { ok: true, synced: !!s.ok, premium: s.ok ? s.premium : null, source: s.ok ? s.source : null };
    });
  }

  function buy() {
    return guarded(function () {
      if (!plugin()) return fail('unavailable');
      if (!userId()) return fail('signed_out');
      /* Already Premium from ANY source (website, comped, Google): never a second purchase.
         The buttons are hidden for them too; this is the floor under that. */
      if (isPremium()) return fail('already_premium');
      if (offline()) return fail('offline');
      return offering().then(function (o) {
        if (!o.ok) return o;
        markSeen();
        return call(function () { return plugin().purchasePackage({ aPackage: o.pkg }); }).then(settled, function (e) {
          var why = errReason(e);
          /* A payment the store has not finished (some cash and bank methods) completes later; the
             webhook writes the row then. "pending", never "failed". */
          return fail(why, why === 'cancelled' ? null : { message: errText(e) });
        });
      });
    });
  }

  function restore() {
    return guarded(function () {
      if (!plugin()) return fail('unavailable');
      if (!userId()) return fail('signed_out');
      if (offline()) return fail('offline');
      return ready().then(function (r) {
        if (!r.ok) return r;
        markSeen();
        return call(function () { return plugin().restorePurchases(); }).then(settled, function (e) {
          return fail(errReason(e), { message: errText(e) });
        });
      });
    });
  }

  /* Google's own subscriptions screen for this app. In the app, a play.google.com address leaves
     the WebView for the Play Store (Capacitor hands non-site URLs to the system). */
  function manageUrl(productId) {
    return 'https://play.google.com/store/account/subscriptions?package=com.thaiear.app' +
      (productId ? '&sku=' + encodeURIComponent(productId) : '');
  }

  /* For F (the buttons): a page that loads this file calls it once. Silent, and a no-op unless a
     purchase was ever started on this device (SEEN_KEY). */
  function autoInit() {
    if (!plugin() || !userId() || !seen()) return Promise.resolve(fail('skipped'));
    return ready();
  }

  // GET /api/google-play?check=1 → the server's word on its own RevenueCat credentials ('ok', …).
  function serverCheck() {
    return token().then(function (t) {
      if (!t) return 'signed_out';
      return fetch(API + '?check=1', { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && j.revenuecat) || 'unknown'; });
    }).then(null, function () { return 'unreachable'; });
  }

  /* ── the owner panel's check (ownersim.js). Read-only: it never buys or restores. ───────── */
  function diagnose() {
    var out = { app: isApp(), plugin: !!plugin(), signedIn: !!userId(), premium: isPremium() };
    try {
      var hs = (cap() && cap().PluginHeaders) || [];
      var h = hs.filter(function (x) { return x && x.name === 'Purchases'; })[0];
      out.methods = h ? (h.methods || []).length : 0;
    } catch (_) { out.methods = 0; }
    if (!out.plugin || !out.signedIn) return Promise.resolve(out);
    return getConfig().then(function (c) {
      out.serverKey = !!c;
      out.serverReady = !!(c && c.serverReady);
      return serverCheck();
    }).then(function (rcState) {
      // The server's own RevenueCat key + project id, tested there: a wrong project id is otherwise silent.
      out.revenuecat = rcState;
      return ready();
    }).then(function (r) {
      out.ready = r.ok ? 'yes' : r.reason + (r.message ? ': ' + r.message : '');
      if (!r.ok) return out;
      var P = plugin();
      return call(function () { return P.getAppUserID(); }).then(function (g) {
        out.idMatches = !!(g && String(g.appUserID) === userId());
        return call(function () { return P.getOfferings(); });
      }).then(function (o) {
        var cur = o && o.current;
        out.offering = cur ? (cur.identifier || '?') : 'none';
        out.packages = cur ? (cur.availablePackages || []).map(function (p) {
          var pr = (p && p.product) || {};
          return (p.identifier || '?') + ' ' + (pr.identifier || '?') + ' ' + (pr.priceString || '');
        }) : [];
      }, function (e) { out.offering = 'error ' + errReason(e) + ': ' + errText(e); })
        .then(function () { return call(function () { return P.getCustomerInfo(); }); })
        .then(function (ci) {
          var info = (ci && ci.customerInfo) || ci || {};
          var act = (info.entitlements && info.entitlements.active) || {};
          out.activeEntitlements = Object.keys(act);
          return out;
        }, function (e) { out.customerInfo = 'error ' + errReason(e) + ': ' + errText(e); return out; });
    }, function (e) { out.error = errText(e); return out; });
  }

  window.ThaiEarBilling = {
    // true only in an app that has the plugin (1.7+). Says nothing about whether the store sells.
    available: function () { return !!plugin(); },
    buy: buy,
    restore: restore,
    sync: sync,
    offering: function () { return offering().then(function (o) { if (o.ok) delete o.pkg; return o; }); },
    manageUrl: manageUrl,
    autoInit: autoInit,
    diagnose: diagnose
  };
})();
