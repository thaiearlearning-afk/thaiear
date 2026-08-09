/* ============================================================
   ownersim.js — OWNER-ONLY entitlement simulator (2026-08-09).
   ------------------------------------------------------------
   Lets the owner see what an EXPIRED / SIGNED-OUT visitor sees without touching a real Supabase
   account or waiting for a subscription to lapse. Replaces the sim.js that was deleted with the
   test space at r135; the contract it relies on was never removed.

   ⚠ IT OVERRIDES ONLY THE AUTH ANSWER — never a decision. The simulated state is injected at the
   ThaiEarAuth boundary (getUser / isSubscribed / isSubscriptionFresh), exactly where the real
   Supabase answer enters. Everything downstream — canUseOffline, lockedFor, the 30-day grace
   arithmetic, sentLocked, dynApplyLockOrder, the "Premium content" heading, dynIncluded, the
   licence overlay — then runs UNMODIFIED on it. A switch that forced canUseOffline's return value
   would prove nothing: it would bypass the very code under test.

   That is only possible because auth.js deliberately calls this.isSubscribed() /
   this.isSubscriptionFresh() / this.getUser() rather than its module-private closure variables,
   and Object.create(real) can therefore shadow them. See the ⚠⚠ note above canUseOffline in
   auth.js — if that contract is ever broken, this file silently stops working and every
   entitlement test passes vacuously.

   ⚠ Object.create, NOT a hand-written object. An enumerated shim omits whatever it forgot —
   ThaiEarAuth.playlists, dynPrefs, anything added later — and the original sim.js broke
   "Add to a playlist" exactly that way. Inheriting through the prototype chain cannot go stale.

   ⚠ WHAT IT CANNOT SIMULATE: the server. /api/audio still sees the owner's real, entitled token,
   so a really-subscribed account is still handed signed URLs. This proves the UI LOCKS correctly;
   it cannot prove the server DENIES.

   Loaded by nav.js only when localStorage `te_ownersim` is '1' (armed once by visiting any page
   with ?ownersim=1). Not in the service worker's PRECACHE on purpose: it must not ship into every
   visitor's cache. Arm it while online and the ordinary network-first runtime cache keeps it
   available offline afterwards.
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarOwnerSim) return;              // load once
  var K_ON    = 'te_ownersim';                     // '1' = the tool is available on this device
  var K_STATE = 'te_ownersim_state';               // '' | 'premium' | 'expired' | 'signedout'
  var K_LIFE  = 'te_ownersim_life';                // stashed real thaiear_lifetime, restored on disarm

  function get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (_) {} }
  function state() { var s = get(K_STATE) || ''; return s === 'off' ? '' : s; }
  window.ThaiEarOwnerSim = { state: function () { return ownerOk ? state() : ''; } };

  /* ── OWNER GATE ────────────────────────────────────────────────────────────────────────────
     The localStorage flag decides whether this file is FETCHED; the account decides whether it
     DOES anything. Two owner accounts, held as SHA-256 of the lowercased address so a personal
     email is not sitting in plain text in a file anyone can request at /ownersim.js. That is
     privacy, not security, and it does not need to be more: the simulator can only ever REMOVE
     access from the device running it — it grants nothing, and /api/audio still answers to the
     real token — so a stranger arming it would just padlock their own screen.
     ⚠ Read from thaiear_identity, NOT getUser(): the 'signedout' state hides the user behind the
     wrapper, and the gate must keep working while it is armed (otherwise turning it off would be
     impossible). auth.js keeps that record for exactly this kind of offline-durable question. */
  var OWNER_SHA = [
    'f158e8ba0177149ebd33d06f08ac400709d39133f9f366f7bdb3ac17bcb1c171',
    'b923407d6637d0f83f9eaa4b5cf324523a265685ae444805e0422ea85c2b142e'
  ];
  var ownerOk = false;
  function realEmail() {
    try {
      var id = JSON.parse(localStorage.getItem('thaiear_identity') || 'null');
      var e = id && id.user && id.user.email;
      return e ? String(e).trim().toLowerCase() : '';
    } catch (_) { return ''; }
  }
  // Defensive throughout: anything missing (TextEncoder, subtle on a non-secure origin) must mean
  // "not the owner", never an exception that takes the whole file — and with it the Turn-off
  // button — down while a simulation is armed.
  function checkOwner() {
    var e = realEmail(), sub, enc;
    try {
      sub = window.crypto && window.crypto.subtle;
      enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
    } catch (_) { return Promise.resolve(false); }
    if (!e || !sub || !enc) return Promise.resolve(false);
    return sub.digest('SHA-256', enc.encode(e)).then(function (buf) {
      var h = Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return (b + 0x100).toString(16).slice(1);
      }).join('');
      return OWNER_SHA.indexOf(h) >= 0;
    }).catch(function () { return false; });
  }

  /* ── the auth view ─────────────────────────────────────────────────────────────────────────
     'premium'   — entitled: a live subscription, the normal signed-in-and-paying case.
     'expired'   — signed in, subscription gone. isSubscriptionFresh() true + isSubscribed() false
                   lands on canUseOffline's REAL "the server answered, and said no" branch, which
                   denies before any date arithmetic. Premium locks; member stays open, because
                   member only ever requires a signed-in user.
     'signedout' — no user at all: member AND premium lock.
     ⚠ isReady is NOT shadowed. The original forced it true, which can lock a paying user during
     the window before auth resolves; inheriting it keeps the real timing, and lockedFor()'s
     "auth still resolving → never lock" guard then behaves honestly. */
  function authView(real) {
    var s = state();
    if (!real || !s) return real;
    var signedIn = (s !== 'signedout');
    var subbed = (s === 'premium');
    var view = Object.create(real);                // inherits playlists, dynPrefs, signOut, everything
    view.getUser = function () { return signedIn ? (real.getUser ? real.getUser() : null) : null; };
    view.isSubscribed = function () { return subbed; };
    /* The simulated account has been ANSWERED FOR — that is what makes 'expired' a lapse rather
       than an unreachable server. Deliberately not delegating to the real one: offline it is
       false, which would send 'expired' down the grace-window branch and, on an account with
       fresh licence markers, grant access — the simulation would appear to do nothing. */
    view.isSubscriptionFresh = function () { return true; };
    view.getSubscription = function () {
      if (!subbed) return null;
      return real.getSubscription ? real.getSubscription() : null;
    };
    return view;
  }

  /* ⚠ thaiear_lifetime SHORT-CIRCUITS canUseOffline BEFORE ANY OTHER CHECK, so on a lifetime
     account (the owner's is one) leaving it set makes every simulated state pass vacuously —
     the toggle flips, nothing errors, and nothing changes. Clear it while armed and put the real
     value back on disarm. auth.js's refreshLifetime() has the matching guard so the server does
     not simply re-write it on the next auth resolve. */
  function applyLifetime() {
    if (state()) {
      if (get(K_LIFE) == null) set(K_LIFE, get('thaiear_lifetime') || '');
      set('thaiear_lifetime', null);
    } else if (get(K_LIFE) != null) {
      var v = get(K_LIFE);
      set('thaiear_lifetime', v ? v : null);
      set(K_LIFE, null);
    }
  }

  // Wrap as soon as auth.js has published ThaiEarAuth. Everything in the codebase re-reads
  // window.ThaiEarAuth per call, so swapping the object later is enough — no load-order fight.
  var wrapped = false;
  function wrap() {
    if (wrapped || !window.ThaiEarAuth) return;
    if (!state()) return;                          // nothing armed → leave the real object alone
    window.ThaiEarAuth = authView(window.ThaiEarAuth);
    wrapped = true;
    try { window.dispatchEvent(new CustomEvent('thaiear:auth')); } catch (_) {}
  }
  /* Everything below is gated on the account. Nothing is touched — not thaiear_lifetime, not
     ThaiEarAuth, not the DOM — for anyone else, so an armed flag on a non-owner device is inert.
     The identity record is in localStorage and readable immediately, so this resolves in a
     microtask; the poll below still covers auth.js publishing ThaiEarAuth after we get here. */
  function start() {
    applyLifetime();
    wrap();
    if (!wrapped && state()) {
      var tries = 0;
      var iv = setInterval(function () { wrap(); if (wrapped || ++tries > 80) clearInterval(iv); }, 50);
    }
    ui();
  }
  checkOwner().then(function (isOwner) {
    ownerOk = isOwner;
    if (!ownerOk) return;
    start();
  });

  /* ── UI ────────────────────────────────────────────────────────────────────────────────────
     A banner on EVERY page while armed — a simulation left on by accident would otherwise quietly
     invalidate every later test, and that failure looks exactly like a bug in the feature. The
     picker itself is only on the homepage, as asked.
     Changing state RELOADS rather than re-rendering: entitlement is read during mount by several
     surfaces, and a reload is the only way to be certain every one of them re-derives. */
  var LABEL = { premium: 'PREMIUM (entitled)', expired: 'EXPIRED (premium, non-lifetime)', signedout: 'SIGNED OUT' };
  function setState(v) { set(K_STATE, v || null); applyLifetime(); location.reload(); }

  function banner() {
    if (!state() || document.getElementById('ownersim-bar')) return;
    var b = document.createElement('div');
    b.id = 'ownersim-bar';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#7A1F1F;color:#fff;' +
      'font:600 12px/1.4 system-ui,-apple-system,sans-serif;padding:7px 12px;display:flex;gap:10px;' +
      'align-items:center;justify-content:center;text-align:center';
    b.innerHTML = '<span>SIMULATING: ' + (LABEL[state()] || state()) + '</span>' +
      '<button type="button" style="font:inherit;background:#fff;color:#7A1F1F;border:0;border-radius:12px;' +
      'padding:3px 12px;cursor:pointer">Turn off</button>';
    b.querySelector('button').addEventListener('click', function () { setState(''); });
    document.body.appendChild(b);
  }

  function picker() {
    // Homepage only. Matches how the owner asked for it: "right at bottom of index".
    var p = location.pathname.replace(/\/$/, '');
    if (!(p === '' || /\/index(\.html)?$/.test(p) || p === '/index.html')) return;
    if (document.getElementById('ownersim-panel')) return;
    var d = document.createElement('div');
    d.id = 'ownersim-panel';
    d.style.cssText = 'max-width:640px;margin:2rem auto 5rem;padding:14px 16px;border:1px dashed #7A1F1F;' +
      'border-radius:10px;font:13px/1.6 system-ui,-apple-system,sans-serif;color:#5A5A5A';
    var opts = [['', 'Off (real account)'], ['premium', 'Premium — entitled'],
                ['expired', 'Expired — premium, non-lifetime'], ['signedout', 'Signed out']];
    var cur = state();
    d.innerHTML = '<strong style="color:#7A1F1F">Owner: simulate account</strong><br>' +
      '<span style="font-size:12px">Overrides only the auth answer — every entitlement decision downstream runs for real. ' +
      'Cannot simulate the server: /api/audio still sees your real token.</span><br>' +
      opts.map(function (o) {
        return '<label style="display:inline-flex;align-items:center;gap:5px;margin:8px 12px 0 0;cursor:pointer">' +
          '<input type="radio" name="ownersim" value="' + o[0] + '"' + (cur === o[0] ? ' checked' : '') + '>' +
          o[1] + '</label>';
      }).join('');
    d.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'ownersim') setState(e.target.value);
    });
    document.body.appendChild(d);
  }

  function paint() { banner(); if (get(K_ON) === '1') picker(); }
  function ui() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }
})();
