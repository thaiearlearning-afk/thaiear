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
  /* ⚠ ONE ACCOUNT ONLY (owner, 2026-08-27). The second address was removed so that the
     other account sees the site exactly as a normal member does — no owner card, no panel,
     no unlisted section. Adding an account back means adding its SHA-256 here; the plain
     address must never appear in the file (Golden Rule 0 covers the owner's own too). */
  var OWNER_SHA = [
    'f158e8ba0177149ebd33d06f08ac400709d39133f9f366f7bdb3ac17bcb1c171'
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
  /* ⚠ 'expired' IS ALSO THE SIGNED-IN-FREE SIMULATION. Nothing in the codebase branches on
     “used to be subscribed” — gate(), premiumInfoSheet() and canUseOffline() all ask only “are you
     subscribed RIGHT NOW” — so a never-subscribed free account and a lapsed one are byte-identical
     here (signedIn + !subbed + fresh). Labelled for both so nobody adds a duplicate mode that
     silently does the same thing and gives false confidence in test coverage. */
  var LABEL = { premium: 'PREMIUM (entitled)', expired: 'SIGNED IN, NO SUBSCRIPTION (free or expired)', signedout: 'SIGNED OUT' };
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
    /* ⚠ FIXED AND COLLAPSED, NOT AN IN-FLOW BLOCK (2026-08-21).
       It used to be `margin:2rem auto 5rem` appended to <body>. That was harmless while the home
       page was a long scrolling grid, but the page is now a flex column that fills exactly one
       screen — body is `display:flex; min-height:100dvh` and the stage is `flex:1` — so ANY extra
       in-flow sibling takes its height out of the stage. The owner saw the whole splash squash to
       make room for a debug panel (his accounts only, which is why nobody else could see it).
       Taking it out of flow is the fix; collapsing it by default is why it is no longer ugly.
       Same reason the footer on that page is hand-built rather than appended after paint. */
    var d = document.createElement('div');
    d.id = 'ownersim-panel';
    d.style.cssText = 'position:fixed;right:12px;z-index:99998;max-width:min(420px,calc(100vw - 24px));' +
      'padding:14px 16px;border:1px dashed #7A1F1F;background:rgba(255,255,255,.97);' +
      'box-shadow:0 8px 28px rgba(0,0,0,.18);' +
      'border-radius:10px;font:13px/1.6 system-ui,-apple-system,sans-serif;color:#5A5A5A;' +
      'max-height:70vh;overflow:auto';
    var opts = [['', 'Off (real account)'], ['premium', 'Premium — entitled'],
                ['expired', 'Signed in, no subscription (free account or expired)'], ['signedout', 'Signed out']];
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
    /* ── WHICH BUILD IS THIS DEVICE ACTUALLY RUNNING? ──────────────────────────────────────────
       "have you picked up the new service worker?" was the blocker behind half a day of
       false-negative testing (2026-08-09) — an iOS PWA in particular holds an old worker across
       several launches, so a shipped fix looks like a fix that did not work.
       No sw.js change and no message channel needed: the cache NAME is 'thaiear-' + VERSION, so
       reading caches.keys() from the page answers it exactly. Shown only in this owner panel.
       ⚠ It reports the ACTIVE cache, which is what the page is really being served from — that is
       the question, not what the server last published. */
    var ver = document.createElement('div');
    ver.style.cssText = 'margin-top:10px;font-size:12px;color:#7A1F1F;line-height:1.65';
    ver.innerHTML = 'service worker: checking…';
    d.appendChild(ver);
    swReport(ver);

    /* ── DOWNLOAD STALENESS PROBE (2026-09-23) ─────────────────────────────────
       WHY IT IS HERE AND NOT IN A CONSOLE. "Is this download superseded?" is now decided by three
       values a device holds privately — the manifest's `ver` and `qz`, and the published per-unit
       quiz stamp — and the owner's devices are an Android WebView and an iPhone PWA, neither of
       which has a console or an address bar. Every wrong answer on this subject so far has come
       from reasoning about what those values PROBABLY are. This prints them.
       ⚠ ownersim.js is deliberately NOT precached, so this reaches a device with no VERSION bump
       and no new cache — the only diagnostic route into the app that does not need a release.
       ⚠ READ-ONLY. It never writes the manifest: a probe that repaired what it measured would
       destroy the evidence it exists to collect. */
    var stale = document.createElement('div');
    stale.style.cssText = 'margin-top:10px;font-size:12px;color:#7A1F1F;line-height:1.65';
    stale.innerHTML = 'downloads: checking\u2026';
    d.appendChild(stale);
    staleReport(stale);

    /* ── AUDIO LATENCY PROBE (2026-08-26) ───────────────────────────────────────────────────
       player.js records when the prewarm ran, whether the clip you tapped was already warm, and
       how long the tap took to make a sound. It is armed with ?lat=1 — WHICH DOES NOT EXIST IN
       THE APP OR AN INSTALLED PWA, neither of which has an address bar. Same trap as ?ownersim=1
       and layoutdbg's re-arm flag; this panel is the answer to it, because it is reachable on
       every device that actually needs measuring.
       ⚠ player.js reads te_lat ONCE, at parse time, so a change only takes effect on the NEXT
       page opened. The button says so — a switch that appears to do nothing gets pressed twice.
       ⚠ THE TEXTAREA IS THE DELIVERY, NOT THE CLIPBOARD. A WebView clipboard write can be refused
       or silently no-op, and a trace the owner cannot get out of the device is not a measurement. */
    var lat = document.createElement('div');
    lat.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px dashed #d8c8c8;' +
      'font-size:12px;line-height:1.65';
    function latOn() { return get('te_lat') === '1'; }
    function paintLat() {
      lat.innerHTML = '<strong style="color:#7A1F1F">Audio latency probe</strong><br>' +
        '<span>' + (latOn()
          ? 'ON. Open a topic — the trace panel appears top-right. Play a sentence, then press copy IN THAT PANEL.'
          : 'Off. Turning it on takes effect on the NEXT page you open.') + '</span>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button type="button" id="ownersim-lat-toggle" style="' + SWBTN + '">' +
            (latOn() ? 'Turn probe off' : 'Turn probe on') + '</button>' +
        '</div>' +
        '<span style="display:block;margin-top:6px;color:#7A1F1F">The trace is copied from the probe' +
        ' panel on the topic page itself — this panel only exists on the home page, so it can never' +
        ' see it.</span>';
      lat.querySelector('#ownersim-lat-toggle').addEventListener('click', function () {
        set('te_lat', latOn() ? null : '1');
        paintLat();
      });
    }
    paintLat();
    d.appendChild(lat);

    /* ── AUTH TRACE (2026-09-23) ────────────────────────────────────────────
       auth.js records the account-switch bug; this is the only way to reach it. Owner, 2026-09-23,
       when handed `ThaiEarAuth.trace(true)`: "i cant do this!! nowhere to type you that" — correct,
       and the mistake was mine. The Android WebView and the iPhone PWA have no console and no
       address bar, which is the whole reason this panel exists (see the ?lat=1 note above).
       ✅ ownersim.js is NOT precached, so this arrives with NO VERSION BUMP.
       ⚠ THE PANEL ONLY LOADS WHEN SIGNED IN (nav.js injects it for a signed-in user), and the bug
       leaves you signed OUT — so it cannot be read DURING the failure. It does not need to be: the
       ring is in localStorage and survives. Arm it signed in, reproduce, sign in again, read it.
       ⚠ A TEXTAREA, NOT THE CLIPBOARD. A WebView clipboard write can be refused or silently no-op,
       and a trace the owner cannot get off the device is not a measurement — the same reasoning
       the latency probe above already follows. */
    var atr = document.createElement('div');
    atr.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px dashed #d8c8c8;' +
      'font-size:12px;line-height:1.65';
    function authApi() { return window.ThaiEarAuth && window.ThaiEarAuth.trace ? window.ThaiEarAuth : null; }
    function trArmed() { return get('thaiear_authtrace_on') === '1'; }
    function trRows() {
      try { return (JSON.parse(localStorage.getItem('thaiear_authtrace') || '[]') || []).length; }
      catch (_) { return 0; }
    }
    function paintTr() {
      var A = authApi();
      if (!A) {
        atr.innerHTML = '<strong style="color:#7A1F1F">Auth trace</strong><br>' +
          '<span>Not available on this build — auth.js predates the trace (needs v653+).</span>';
        return;
      }
      var n = trRows();
      atr.innerHTML = '<strong style="color:#7A1F1F">Auth trace</strong> — the account-switch bug<br>' +
        '<span>' + (trArmed()
          ? ('ON, ' + n + ' event' + (n === 1 ? '' : 's') + ' recorded. Now: sign out, sign in with the ' +
             'OTHER Google account, let it fail, then sign back in and press Show.')
          : 'Off. Press Arm, then reproduce the account switch.') + '</span>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button type="button" id="ownersim-tr-arm" style="' + SWBTN + '">' +
            (trArmed() ? 'Disarm + clear' : 'Arm') + '</button>' +
          '<button type="button" id="ownersim-tr-show" style="' + SWBTN + '">Show (' + n + ')</button>' +
        '</div>' +
        '<textarea id="ownersim-tr-out" readonly style="width:100%;box-sizing:border-box;' +
          'margin-top:8px;height:150px;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;' +
          'border:1px solid #c9c0b0;border-radius:6px;padding:6px;display:none"></textarea>' +
        '<span style="display:block;margin-top:6px;color:#7A1F1F">Select the text and copy it — ' +
        'a WebView clipboard button cannot be trusted. No tokens, emails or user ids are recorded; ' +
        'accounts appear only as a 6-character hash.</span>';

      atr.querySelector('#ownersim-tr-arm').addEventListener('click', function () {
        var B = authApi(); if (!B) return;
        B.trace(trArmed() ? false : true);
        paintTr();
      });
      atr.querySelector('#ownersim-tr-show').addEventListener('click', function () {
        var B = authApi(); if (!B) return;
        var ta = atr.querySelector('#ownersim-tr-out');
        ta.value = B.trace() || '(empty)';
        ta.style.display = 'block';
        try { ta.focus(); ta.select(); } catch (_) {}
      });
    }
    paintTr();
    d.appendChild(atr);

    /* ── QUIZ REJECTION LOG (QUIZ_GO_LIVE_PLAN.md §2.10, 2026-09-22) ────────────────────────
       ⭐⭐ WHY THIS READER IS WORTH A PANEL. SOLUTION_FINDER.md §6c: the precision/recall
       asymmetry means a wrongly-ACCEPTED answer NEVER comes back — a learner told they are
       right does not report it. A wrongly-REJECTED one is the only signal that can reach us,
       and it arrives silently. quiz.js has recorded them since Phase 5 and there was NO
       retrieval path, so nobody could ever read them: the highest-value artifact of the launch,
       written to a key on one device and never looked at.
       ⚠ THE PANEL IS HERE BECAUSE OF WHERE THE OWNER TESTS. ?flags do not exist in the app or
       an installed PWA — no address bar — and offline behaviour is exactly what has to be
       tested there. This panel is already reachable on both.
       ⭐ THE ACCOUNT COUNT IS THE POINT OF THE THREE NUMBERS. "Queued" rising offline and
       falling to zero on reconnect while "in your account" rises by the same amount is the
       whole round trip, observed rather than asserted. A flush that merely reports success
       proves nothing.
       ⚠ THE TEXTAREA IS THE DELIVERY, NOT THE CLIPBOARD — same lesson as the latency probe: a
       WebView clipboard write can be refused or silently no-op, and evidence that cannot leave
       the device is not evidence.
       ⛔ GOLDEN RULE 0: these are ANSWERS, not people. A row is a unit, a sentence number and a
       chip order; there is no name, address or id here and none may be added. And what leaves
       this panel goes into a REPLY or a fix, never pasted row-by-row into a document. */
    var rej = document.createElement('div');
    rej.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px dashed #d8c8c8;' +
      'font-size:12px;line-height:1.65';
    function QS() { return window.ThaiEarQuizStore; }
    function paintRej(acct) {
      var S = QS();
      var rows = (S && S.rejections) ? S.rejections() : [];
      var queued = (S && S.pendingRejections) ? S.pendingRejections() : 0;
      /* ⚠ NOTHING LEARNER-WRITTEN IS INTERPOLATED INTO innerHTML HERE — only two counts and the
         account number. The rows themselves go into a textarea's `.value`, which is text by
         construction and needs no escaping. Keep it that way: a built chip order is Thai the
         learner typed, and putting it through innerHTML would be the one place that matters. */
      rej.innerHTML = '<strong style="color:#7A1F1F">Quiz rejection log</strong><br>' +
        '<span>' + rows.length + ' on this device · <b>' + queued + ' queued</b> to sync · ' +
        (acct == null ? 'account count unknown (offline or signed out)'
                      : '<b>' + acct + '</b> in your account') + '</span>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button type="button" id="ownersim-rej-refresh" style="' + SWBTN + '">Refresh</button>' +
          '<button type="button" id="ownersim-rej-flush" style="' + SWBTN + '">Sync now</button>' +
          '<button type="button" id="ownersim-rej-dump" style="' + SWBTN + '">Show the last 50</button>' +
        '</div>' +
        '<div id="ownersim-rej-said" style="margin-top:6px;font-weight:500"></div>' +
        (function () {
          /* ⛔ THE REASON THE QUEUE WILL NOT DRAIN, when there is one. Without this the panel
             says "5 queued" for ever and the owner has nothing to act on — which is exactly
             what happened on 2026-09-22. The message is escaped: it comes from the server. */
          var e = (S && S.lastError) ? S.lastError() : null;
          if (!e) return '';
          /* ⚠ ITS OWN ESCAPER. The `esc` further down this file is scoped to the service-worker
             block, so referring to it here throws and takes the whole panel with it. */
          var q = function (t) {
            return String(t).replace(/[&<>]/g, function (c) {
              return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
            });
          };
          return '<div style="margin-top:8px;padding:6px 8px;border-radius:6px;' +
            'background:#FBECEC;border:1px solid #E3BDBD;color:#7A1F1F">' +
            '<b>Last sync error</b> (' + q(e.k || '?') + '): ' + q(e.msg) + '</div>';
        }()) +
        '<span style="display:block;margin-top:6px;color:#7A1F1F">Offline test: get some Thai' +
        ' Builder answers rejected with the network off, watch <i>queued</i> rise, reconnect and' +
        ' watch it fall to zero while the account count rises by the same amount.</span>';
      rej.querySelector('#ownersim-rej-refresh').addEventListener('click', function () { loadRej(); });
      /* ⛔⛔ THE BUTTON SAYS WHAT IT DID. Owner, 2026-09-22: "im pressing sync now on quiz
         rejection log and its doing nothing".
         ⚠⚠ IT WAS SILENT IN EVERY SINGLE OUTCOME, which in a panel whose entire job is to answer
         "why will this not sync" is the defect. qzFlush() returns false immediately and says
         nothing when the outbox is EMPTY, when the browser reports offline, when there is no
         signed-in user, and when a previous flush is still in flight — and returns true on a
         clean drain, which also rendered identically. "Nothing happened" was four different
         facts wearing the same face.
         ⚠ The states are read BEFORE the flush, because a successful drain empties the outbox
         and afterwards "0 queued" cannot be told from "there was never anything to send".
         ⚠ ownersim.js is NOT precached (CLAUDE.md), so this reaches a device network-first with
         no VERSION bump and no new cache — which is the whole reason diagnostics live here. */
      rej.querySelector('#ownersim-rej-flush').addEventListener('click', function () {
        var S2 = QS();
        var note = function (msg, bad) {
          var el = rej.querySelector('#ownersim-rej-said');
          if (!el) return;
          el.style.color = bad ? '#7A1F1F' : '#1F5D3A';
          el.textContent = msg;
        };
        if (!S2 || !S2.flush) { note('No quiz store on this page.', true); return; }
        var before = (S2.pending ? S2.pending() : 0);
        var rejBefore = (S2.pendingRejections ? S2.pendingRejections() : 0);
        var online = !(typeof navigator !== 'undefined' && navigator.onLine === false);
        if (!before) {
          note('Nothing queued — the outbox is empty, so there is nothing to send. ('
             + rejBefore + ' of it rejections.)', false);
          loadRej();
          return;
        }
        if (!online) { note('The browser reports OFFLINE, so the flush was not attempted.', true); return; }
        note('Syncing ' + before + ' queued op(s)…', false);
        S2.flush().then(function (ok) {
          var after = (S2.pending ? S2.pending() : 0);
          var e = (S2.lastError ? S2.lastError() : null);
          if (ok && !after) note('Synced. ' + before + ' op(s) sent, outbox now empty.', false);
          else if (after < before) note('Partly synced: ' + (before - after) + ' sent, ' + after
             + ' still queued' + (e ? ' — ' + (e.k || '?') + ': ' + e.msg : '.'), true);
          else note('Nothing drained; ' + after + ' still queued'
             + (e ? ' — ' + (e.k || '?') + ': ' + e.msg
                  : '. No error was recorded, which points at the flush being skipped rather than'
                  + ' failing: not signed in, or another flush already in flight.'), true);
          loadRej();
        }, function (err) {
          note('The flush threw: ' + String((err && err.message) || err), true);
          loadRej();
        });
      });
      rej.querySelector('#ownersim-rej-dump').addEventListener('click', function () {
        var ta = document.createElement('textarea');
        ta.readOnly = true;
        ta.style.cssText = 'width:100%;height:150px;margin-top:8px;font:11px/1.45 ui-monospace,' +
          'Menlo,Consolas,monospace;border:1px solid #d8c8c8;border-radius:6px;padding:6px';
        /* newest first — the useful end of a tail */
        ta.value = rows.slice().reverse().map(function (r) {
          return r.unit + '  #' + r.item + '\n  built: ' + r.built +
                 (r.canon ? '\n  canon: ' + r.canon : '');
        }).slice(0, 50).join('\n') || '(nothing rejected on this device yet)';
        var old = rej.querySelector('textarea');
        if (old) old.parentNode.removeChild(old);
        rej.appendChild(ta);
        ta.focus(); ta.select();
      });

    }
    function loadRej() {
      var S = QS();
      if (S && S.rejectionCount) S.rejectionCount().then(paintRej);
      else paintRej(null);
    }
    loadRej();
    d.appendChild(rej);
    /* A collapsed handle by default — the panel is a diagnostic, not furniture. The choice is
       remembered so a testing session does not mean re-opening it on every navigation. */
    var t = document.createElement('button');
    t.id = 'ownersim-toggle';
    t.type = 'button';
    t.style.cssText = 'position:fixed;right:12px;z-index:99998;border:1px dashed #7A1F1F;' +
      'background:rgba(255,255,255,.97);color:#7A1F1F;border-radius:999px;padding:5px 11px;' +
      'font:12px/1.3 system-ui,-apple-system,sans-serif;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.16)';
    var OPEN_KEY = 'thaiear_ownersim_open';
    function isOpen() { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch (_) { return false; } }
    function paint() {
      var open = isOpen();
      d.style.display = open ? '' : 'none';
      t.textContent = open ? 'Owner ▾' : 'Owner ▸';
    }
    t.addEventListener('click', function () {
      try { localStorage.setItem(OPEN_KEY, isOpen() ? '0' : '1'); } catch (_) {}
      paint(); place();
    });

    /* Sit clear of the red "simulation live" banner, which is itself fixed to the bottom and only
       present while a simulation is running. Measured rather than assumed, because its height
       depends on how the text wraps. */
    function place() {
      var b = document.getElementById('ownersim-bar');   // the banner's real id
      var bh = b ? Math.ceil(b.getBoundingClientRect().height) : 0;
      t.style.bottom = (bh + 12) + 'px';
      d.style.bottom = (bh + 12 + (isOpen() ? 34 : 0)) + 'px';
    }

    document.body.appendChild(d);
    document.body.appendChild(t);
    paint(); place();
    window.addEventListener('resize', place);
  }

  /* ══ SERVICE-WORKER REPORT ════════════════════════════════════════════════════════════════
     WHAT THIS REPLACED, AND WHY. The panel used to print one line — caches.keys() filtered to
     thaiear-vN — under the label "build on this device". Every word of that was misleading once
     more than one cache existed: it listed FOUR versions with no way to tell which one was
     serving the page, so "my PWA is showing v416 through v419" could not be answered, and the
     honest reading (are these orphans, or is the device stuck?) was a coin flip. Getting that
     wrong by inference has now cost two wrong diagnoses.

     THE TWO QUESTIONS IT NOW SEPARATES:
       · WHICH VERSION IS SERVING ME?  Only the worker knows — VERSION is a constant inside sw.js
         and every registration slot reports the same scriptURL. So we ask it (sw.js's te-version
         handler) over a MessageChannel and await one reply.
       · WHICH CACHES EXIST?  caches.keys(), as before — but now labelled against the answer above,
         so an orphan reads as an orphan.

     ⚠ ORPHANS ARE EXPECTED WHEN SHIPPING FAST, and saying so is half the point. caches.open()
     creates thaiear-vN before any file is fetched, and only activate() deletes old caches, so a
     worker superseded mid-install never activates and never cleans up after itself. Several
     stacked caches with the NEWEST one active is housekeeping. The newest cache NOT being active
     is the fault worth chasing.

     ⚠ NO REPLY IS ITSELF A READING, not an error: it means the active worker predates the
     te-version handler, i.e. this device has not taken v423 yet. Say that in words rather than
     showing a spinner for ever — a 1.5s timeout, because a sleeping worker takes a moment to
     boot and a hung one must not leave the panel blank. */
  function swAsk(timeoutMs) {
    return new Promise(function (resolve) {
      var sw = navigator.serviceWorker;
      if (!sw || !sw.controller) { resolve(null); return; }
      var done = false;
      var ch = new MessageChannel();
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs || 1500);
      ch.port1.onmessage = function (e) {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(e.data && e.data.te === 'version' ? e.data : null);
      };
      try { sw.controller.postMessage('te-version', [ch.port2]); }
      catch (_) { clearTimeout(timer); resolve(null); }
    });
  }

  function swReport(el) {
    var out = { active: null, caches: [], reg: null };
    var jobs = [];

    jobs.push(swAsk().then(function (r) { out.active = r; }));
    /* ── IS A PRECACHE HOLE STILL OUTSTANDING ON THIS DEVICE? (2026-09-19, sw v564) ──────────
       The state the v564 retry exists to clear, read straight from the page — CacheStorage is
       reachable here, so this needs no service-worker change and no version bump.
       ⚠ THIS IS THE ONLY DIRECT CHECK THAT THE FIX WORKED. A build tag alone can mostly only
       falsify (a laggard proves the retry is failing; seeing none proves little, per
       SW_ACTIVATE_FIX_PLAN.md §11's trap). Watching a record APPEAR and then GO is the repair
       happening. Deliberately device-local: no beacon, no user id, nothing leaves the phone —
       a remote version raises a PECR question (/api/seen is consent-free precisely because it
       touches no device storage) and a Golden-Rule-0 question (counts, not per-user rows). */
    jobs.push(
      (window.caches && window.caches.has ? window.caches.has('thaiear-gaps') : Promise.resolve(false))
        .then(function (yes) {
          if (!yes) return null;
          return window.caches.open('thaiear-gaps')
            .then(function (gc) { return gc.match('/__te_gaps'); })
            .then(function (r) { return r ? r.json() : null; });
        })
        .then(function (g) { out.gaps = g; })
        .catch(function () {})
    );
    jobs.push(
      (window.caches && window.caches.keys ? window.caches.keys() : Promise.resolve([]))
        .then(function (ks) {
          out.caches = ks.filter(function (k) { return /^thaiear-v\d+$/.test(k); })
            /* Numeric, not lexical: v9 must not sort above v421. */
            .sort(function (a, b) { return (+a.slice(9)) - (+b.slice(9)); });
        }).catch(function () {})
    );
    jobs.push(
      (navigator.serviceWorker && navigator.serviceWorker.getRegistration
        ? navigator.serviceWorker.getRegistration() : Promise.resolve(null))
        .then(function (r) { out.reg = r || null; }).catch(function () {})
    );

    Promise.all(jobs).then(function () { swPaint(el, out); });
  }

  /* ⚠ THE VERDICT IS A PURE FUNCTION, ON PURPOSE. It is the only part of this panel that
     REASONS rather than reports, it is the sentence the owner will act on, and getting it
     backwards would send someone chasing a bug that is not there — or, worse, call a real stall
     "normal". Split out so it can be tested against every state directly; the panel itself needs
     a live service worker and an owner email hash to render at all.

     ⚠⚠ CORRECTED 2026-08-22, SAME DAY, AND THE CORRECTION IS THE WHOLE POINT OF THE FUNCTION.
     The first version said several caches with the newest active was "normal when shipping fast".
     THAT IS WRONG, and it would have talked the owner out of a real fault. activate() deletes
     EVERY cache that is not the current one (bar thaiear-vendor / -dl / -audio-dl), so a settled
     device has EXACTLY ONE. Orphans cannot survive an activation. Therefore:

         more than one cache  ⟹  no activation has completed since the oldest of them appeared.

     The only benign multi-cache state is the brief window while an install is in flight — two
     caches, the newer one not yet active. Everything else means activations are not happening,
     which is precisely the v408 stall in a milder dress.

     States: tidy · installing (transient, 2) · undeleted (newest active, others survived —
     activate() ran but its delete did not finish) · stuck (newest NOT active) · unknown. */
  function swVerdict(list, activeCache) {
    var n = list.length;
    var newest = list[n - 1];
    if (!activeCache) {
      return { code: 'unknown', html: n + ' cache(s). Which is active is unknown until this device takes v423+.' };
    }
    if (n === 1) return { code: 'tidy', html: 'tidy — one cache, and it is the active one.' };
    if (newest !== activeCache) {
      /* The active worker is older than a build this device has already downloaded. */
      return { code: 'stuck', html: '<b>STUCK: ' + (n - 1) + ' cache(s) newer than the active one (newest is ' +
        newest.slice(8) + ').</b> This device downloaded builds it is not running — installs are ' +
        'not activating. Tap Check for update.' };
    }
    if (n === 2) {
      return { code: 'installing', html: 'one older cache alongside the active one — normal for a few ' +
        'seconds while an install finishes. If it is still here in a minute, tap Clear orphan caches.' };
    }
    return { code: 'undeleted', html: '<b>' + (n - 1) + ' old caches survived this worker’s activate().</b> ' +
      'It should have deleted every one of them, so activations have been failing or partial. ' +
      'Not serving you anything wrong right now — the newest IS active — but it is worth clearing.' };
  }
  /* Exposed for the harness only. ownersim.js is a debug module that never loads for anyone but
     the owner, so this adds no surface to the real site. */
  try { window.__teSwVerdict = swVerdict; } catch (_) {}

  function swPaint(el, out) {
    var esc = function (t) { return String(t).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    var activeCache = out.active && out.active.cache;
    var rows = [];

    rows.push('<strong>service worker</strong>');
    rows.push('active: ' + (out.active
      ? esc(out.active.version)
      : (navigator.serviceWorker && navigator.serviceWorker.controller
          /* The handler shipped in v423, so silence localises the active worker to "older than
             that" — which is the answer, not a failure. */
          ? 'older than v423 (no reply)'
          : 'none controlling this page')));

    var reg = out.reg;
    if (reg) {
      if (reg.waiting) rows.push('waiting: a newer worker is installed and ready — tap Update');
      if (reg.installing) rows.push('installing: a newer worker is downloading now');
    }

    if (!out.caches.length) rows.push('caches: none yet');
    else {
      var newest = out.caches[out.caches.length - 1];
      var labelled = out.caches.map(function (k) {
        var v = k.slice(8);   // 'thaiear-' is 8 chars
        if (activeCache && k === activeCache) return '<b>' + esc(v) + ' (active)</b>';
        return esc(v);
      });
      rows.push('caches: ' + labelled.join(' · '));
      /* ⚠ THE LINE THAT SAYS WHETHER v564 IS DOING ITS JOB ON THIS DEVICE. A record present means
         the last activate could not re-fetch those files and they are running OLD inside a CURRENT
         cache — the exact state that had the owner on sw v563 with player.js at r222. It should
         clear itself within a navigation or two online; if it sits there, the retry is failing and
         that is a finding. No record at all is the healthy state, and also the uninformative one. */
      if (out.gaps && out.gaps.length) {
        rows.push('<span style="color:#7A1F1F">⚠ ' + out.gaps.length +
          ' precache file' + (out.gaps.length === 1 ? '' : 's') + ' still STALE — ' +
          esc(out.gaps.slice(0, 4).join(', ')) + (out.gaps.length > 4 ? ' …' : '') +
          '<br>(running old copies inside the current cache; a navigation online should clear it)</span>');
      } else if (out.gaps !== undefined) {
        /* ⚠ 2026-09-24 — THIS LINE USED TO CLAIM MORE THAN IT KNOWS. It said "no stale files
           outstanding" while the owner's phone ran v671 holding v670's player.js: the record it
           reads had been lost (the v672 fix in sw.js), so its absence proved nothing. It now says
           only what it measures, and the byte check below says the rest. */
        rows.push('<span style="color:#1F5D3A">re-fetch record: none pending</span>');
      }
      rows.push('<span data-pcverify style="opacity:.75">precache vs live: checking…</span>');
      var v = swVerdict(out.caches, activeCache);
      var tone = (v.code === 'stuck' || v.code === 'undeleted') ? 'color:#7A1F1F'
               : v.code === 'unknown' ? 'opacity:.75' : 'color:#1F5D3A';
      rows.push('<span style="' + tone + '">' + v.html + '</span>');
    }
    if (window.ThaiEarPlayerBuild) rows.push('player: ' + esc(window.ThaiEarPlayerBuild));
    rows.push('<span data-swdiag style="color:#8A8A8A;font-size:11px">update log: …</span>');

    el.innerHTML = rows.join('<br>') +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button type="button" id="ownersim-sw-update" style="' + SWBTN + '">Check for update</button>' +
        '<button type="button" id="ownersim-sw-sweep" style="' + SWBTN + '"' +
          (activeCache && out.caches.length > 1 ? '' : ' disabled') + '>Clear orphan caches</button>' +
        '<button type="button" id="ownersim-sw-refresh" style="' + SWBTN + '"' +
          (activeCache ? '' : ' disabled') + '>Re-download app files</button>' +
        /* ⚠ THE LAYOUT DEBUGGER'S ONLY REACHABLE SWITCH. layoutdbg.js is armed by
           ?layoutdbg=1, and the app and the installed PWA have no address bar — which is why it
           used to default ON and sit over every page. It defaults off now, so this panel is how
           it gets turned back on; the panel itself works everywhere. */
        '<button type="button" id="ownersim-dbg" style="' + SWBTN + '">' +
          (layoutDbgOn() ? 'Layout debugger: ON' : 'Layout debugger: off') + '</button>' +
      '</div>';

    pcVerify(el.querySelector('[data-pcverify]'), activeCache, esc);
    swDiag(el.querySelector('[data-swdiag]'), esc);

    var dbg = el.querySelector('#ownersim-dbg');
    if (dbg) dbg.addEventListener('click', function () {
      var on = !layoutDbgOn();
      try { localStorage.setItem('te_layoutdbg', on ? 'on' : 'off'); } catch (_) {}
      /* ⚠ Turning it ON needs a reload, because nav.js decides whether to FETCH the script at
         page load. Turning it OFF can hide the overlay there and then, so it does. */
      if (on) { dbg.textContent = 'Layout debugger: ON — reload'; return; }
      dbg.textContent = 'Layout debugger: off';
      var box = document.getElementById('te-layout-dbg');
      if (box && box.remove) box.remove();
    });

    var u = el.querySelector('#ownersim-sw-update');
    if (u) u.addEventListener('click', function () {
      u.textContent = 'checking…';
      (navigator.serviceWorker.getRegistration() || Promise.resolve(null))
        .then(function (r) {
          if (!r) return null;
          return r.update().then(function () {
            /* A worker that installed but is waiting will sit there until every tab controlled by
               the old one goes away. Nudging it is the whole reason the panel has this button. */
            if (r.waiting) r.waiting.postMessage('te-skip-waiting');
          });
        })
        .catch(function () {})
        .then(function () { setTimeout(function () { swReport(el); }, 1200); });
    });

    var sweep = el.querySelector('#ownersim-sw-sweep');
    if (sweep) sweep.addEventListener('click', function () {
      /* ⚠ ONLY thaiear-vN CACHES, and NEVER the active one — deleting that would strip the shell
         this page is running on until it refetched. The three durable caches (thaiear-vendor,
         thaiear-dl, thaiear-audio-dl) do not match the pattern at all, so downloaded topics and
         downloaded audio cannot be touched here. Disabled outright unless we KNOW which cache is
         active, so there is no path where it guesses. */
      sweep.textContent = 'clearing…';
      Promise.all(out.caches.filter(function (k) { return k !== activeCache; })
        .map(function (k) { return window.caches.delete(k).catch(function () {}); }))
        .then(function () { swReport(el); });
    });

    /* ── THE CASE NEITHER BUTTON ABOVE CAN REACH (2026-09-19) ────────────────────────────────
       Owner, on the Android app: the panel reported the NEW worker version while the player still
       reported the PREVIOUS build tag, and force-closing changed nothing.
       That is not a stuck install — it is a completed one carrying a stale file. activate()'s
       migrateGaps() copies any PRECACHE entry the new install failed to fetch out of the OUTGOING
       cache, on purpose, so that a deploy can never leave a device worse off offline; the rescued
       entry is then re-fetched, and on a flaky link THAT can fail too. The result is a correct,
       active thaiear-v<new> cache holding one or more files from v<old>. Cache-first then serves
       them for ever, because nothing re-checks a precached sub-resource.
       ⚠ "Check for update" cannot fix it (the worker is already current) and "Clear orphan caches"
       cannot either (the stale entry is in the ACTIVE cache, which that button must never touch).
       So: re-fetch every entry of the active cache from the NETWORK and put it back.
       ⚠ A FAILED FETCH LEAVES THE OLD ENTRY ALONE. Replacing it with an error, or deleting it,
       would turn a cosmetic staleness into a broken shell offline — the exact harm migrateGaps
       exists to prevent. Failures are counted and reported instead. */
    var refresh = el.querySelector('#ownersim-sw-refresh');
    if (refresh) refresh.addEventListener('click', function () {
      if (!activeCache || !window.caches) return;
      refresh.disabled = true;
      refresh.textContent = 'redownloading…';
      /* ⚠⚠ THE URL MUST BE BUSTED, OR THIS BUTTON IS A NO-OP — AND THE FIRST VERSION OF IT WAS
         (2026-09-19). A fetch() issued from the page goes THROUGH the service worker, and the
         worker serves a precached sub-resource CACHE-FIRST: so asking for /player.js returned the
         very stale copy we were trying to replace, and it was then written straight back.
         `cache: 'reload'` does not help — it controls the HTTP cache, not the service worker.
         ⚠ THIS EXACT TRAP IS ALREADY IN THE PROJECT NOTES: the v292→v295 incident could not
         self-heal because cachePage()'s c.add() "fetches through the worker, which handed the
         stale copy back". Same mechanism, same day of the week.
         A query string the precache has never seen misses the cache-first lookup and reaches the
         network; Cloudflare ignores it for a static asset, so the bytes are the real file. The
         response is stored under the CLEAN key, and the busted entry the worker may have cached
         on the way past is removed again. */
      var bust = 'te-refresh=' + Date.now();
      window.caches.open(activeCache).then(function (c) {
        return c.keys().then(function (reqs) {
          var done = 0, failed = 0, junk = [];
          return reqs.reduce(function (p, req) {
            return p.then(function () {
              // Same-origin only: the audio CDN is another origin and not ours to refetch here.
              if (req.url.indexOf(location.origin) !== 0) return;
              if (req.url.indexOf('te-refresh=') > -1) { junk.push(req); return; }
              var u = req.url + (req.url.indexOf('?') > -1 ? '&' : '?') + bust;
              return fetch(u, { cache: 'reload', credentials: 'same-origin' })
                .then(function (res) {
                  if (!res || !res.ok) { failed++; return; }
                  return c.put(req, res.clone()).then(function () { done++; })
                    .catch(function () { failed++; });
                })
                .catch(function () { failed++; });
            });
          }, Promise.resolve()).then(function () {
            // Drop any ?te-refresh= entries the worker stored as it passed them through.
            return c.keys().then(function (after) {
              return Promise.all(after.concat(junk)
                .filter(function (r2) { return r2.url.indexOf('te-refresh=') > -1; })
                .map(function (r2) { return c.delete(r2).catch(function () {}); }));
            }).then(function () { return { done: done, failed: failed, c: c }; });
          });
        });
      }).then(function (r) {
        /* ⚠ PROVE IT, DO NOT ANNOUNCE IT. "refreshed 31" says a loop ran, not that the file
           changed — which is precisely how the first version read as success while changing
           nothing. Read the build tag back OUT OF THE CACHE. */
        return r.c.match(location.origin + '/player.js').then(function (res) {
          return res ? res.text() : '';
        }).then(function (txt) {
          var m = txt.match(/DYN_BUILD\s*=\s*'([^']+)'/);
          r.tag = m ? m[1] : '?';
          return r;
        }).catch(function () { r.tag = '?'; return r; });
      }).then(function (r) {
        refresh.textContent = 'cached player.js is now ' + r.tag +
          ' (' + r.done + ' files' + (r.failed ? ', ' + r.failed + ' failed' : '') + ') — reloading';
        setTimeout(function () { location.reload(); }, 2500);
      }).catch(function () {
        refresh.disabled = false;
        refresh.textContent = 'failed — retry';
      });
    });
  }
  function layoutDbgOn() {
    try { return localStorage.getItem('te_layoutdbg') === 'on'; } catch (_) { return false; }
  }

  var SWBTN = 'border:1px solid #7A1F1F;background:#fff;color:#7A1F1F;border-radius:6px;' +
    'padding:4px 9px;font:12px/1.3 system-ui,-apple-system,sans-serif;cursor:pointer';

  /* The email hash IS the gate — K_ON is not consulted here any more. Requiring a URL-set flag
     made the picker unreachable in a standalone PWA / the Android app, which have no address bar
     and are exactly where the simulator is needed. */
  /* ⛔ THE DYN HIGHLIGHT PROBE (🔎 hl) IS DELETED (owner, 2026-09-20, twice: "can we hide
     the 'h1' probe that is showing on all my topic pages", then "also get rid of h1 in the
     bottom left for fucks sake").
     It was a ONE-OFF measurement for the r221 Android highlight bug of 2026-09-19: it read the
     dyn session's map and duration out of localStorage and printed them, because the app has no
     console. That bug is closed, and the probe was mounting a fixed dashed pill in the corner of
     every topic page the owner opened, on every device, indefinitely.
     ⚠ THE LESSON, which is the only reason this note exists: a diagnostic mounted for the owner
     UNCONDITIONALLY has no expiry and nothing ever reports it. It shipped inside paint(), beside
     the banner and the picker, which are permanent fixtures — so it quietly inherited their
     lifetime. A probe for one specific bug belongs behind a toggle, as the layout debugger now
     is, or it belongs deleted with the bug. Do not re-add this one; write a fresh one against
     whatever fault is actually in hand. */

  /* ⭐ 2026-09-24 — DO THE FILES IN THE ACTIVE CACHE MATCH THE LIVE SITE? Compared by ETag, which
     Cloudflare Pages derives from the content, via a HEAD request per file. The owner's phone read
     "no stale files outstanding" on v671 while its player.js was v670's; this is the check that
     would have said so.
     ⚠ The URL is BUSTED (?te-verify=…), or the service worker answers cache-first and we compare
     the cache with itself — the same trap the Re-download button documents. A HEAD is never
     stored by the worker (Cache.put refuses non-GET), so this leaves nothing behind.
     ⚠ A cached entry with no ETag (e.g. a rescued copy from an old worker) is reported as
     UNVERIFIABLE, never as a match. Read-only; the Re-download button is the remedy. */
  function pcVerify(span, activeCache, esc) {
    if (!span) return;
    if (!activeCache || !window.caches) { span.textContent = 'precache vs live: no active cache'; return; }
    var bust = 'te-verify=' + Date.now();
    caches.open(activeCache).then(function (c) {
      return c.keys().then(function (reqs) {
        reqs = reqs.filter(function (q) {
          return q.url.indexOf(location.origin) === 0 && q.url.indexOf('te-refresh=') === -1;
        });
        var same = 0, stale = [], unk = 0, failed = 0, i = 0;
        function lane() {
          if (i >= reqs.length) return Promise.resolve();
          var q = reqs[i++];
          return c.match(q).then(function (r) {
            var mine = r && r.headers.get('etag');
            if (!mine) { unk++; return; }
            var u = q.url + (q.url.indexOf('?') > -1 ? '&' : '?') + bust;
            return fetch(u, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
              .then(function (res) {
                var live = res && res.ok && res.headers.get('etag');
                if (!live) { failed++; return; }
                var norm = function (t) { return String(t).replace(/^W\//, ''); };
                if (norm(live) === norm(mine)) same++;
                else stale.push(new URL(q.url).pathname + ' (' +
                  String(r.headers.get('date') || '?').replace(/^\w+, /, '').replace(/ GMT$/, '') + ')');
              }, function () { failed++; });
          }).catch(function () { failed++; }).then(lane);
        }
        var lanes = [];
        for (var n = 0; n < Math.min(6, reqs.length); n++) lanes.push(lane());
        return Promise.all(lanes).then(function () {
          /* Measured 2026-09-24: the no-ETag entries are the precached HTML pages (Cloudflare
             sends none for HTML). They are served stale-while-revalidate, so each visit refreshes
             them — unlike a script, which cache-first never re-checks. */
          var tail = (unk ? ' · ' + unk + ' pages without an ETag (they refresh on each visit)' : '') +
                     (failed ? ' · ' + failed + ' could not be checked (offline?)' : '');
          if (stale.length) {
            span.style.opacity = '1';
            span.innerHTML = '<b style="color:#7A1F1F">⚠ precache vs live: ' + stale.length +
              ' file' + (stale.length === 1 ? '' : 's') + ' OLD — ' + esc(stale.slice(0, 5).join(', ')) +
              (stale.length > 5 ? ' …' : '') + '</b><br>(tap Re-download app files) ' +
              esc(same + ' match' + tail);
          } else {
            span.innerHTML = '<span style="color:#1F5D3A">precache vs live: all ' + same +
              ' checked files match</span>' + esc(tail);
          }
        });
      });
    }).catch(function () { span.textContent = 'precache vs live: check failed'; });
  }
  /* The sw.js v672 breadcrumbs (thaiear-diag): what each recent update actually did — install
     entry count and timing, which files activate had to rescue from the old version, and whether
     the re-fetch landed. Read-only. */
  function swDiag(span, esc) {
    if (!span || !window.caches) return;
    caches.has('thaiear-diag').then(function (yes) {
      if (!yes) { span.textContent = 'update log: none yet (written from sw v672 on)'; return; }
      return caches.open('thaiear-diag').then(function (dc) { return dc.match('/__te_diag'); })
        .then(function (r) { return r ? r.json() : null; })
        .then(function (log) {
          if (!log) { span.textContent = 'update log: empty'; return; }
          var vs = Object.keys(log).sort(function (a, b) { return (+b.slice(1)) - (+a.slice(1)); });
          span.innerHTML = 'update log:' + vs.map(function (v) {
            return '<br><b>' + esc(v) + '</b> ' + (log[v] || []).map(function (row) {
              var d = row[2];
              var txt = d && typeof d === 'object'
                ? Object.keys(d).filter(function (k) { return d[k] !== '' && d[k] != null; })
                    .map(function (k) { return k + ':' + d[k]; }).join(',')
                : '';
              return esc(row[1] + (txt ? '[' + txt + ']' : '') + '@' + (row[0] / 1000).toFixed(1) + 's');
            }).join(' › ');
          }).join('');
        });
    }).catch(function () { span.textContent = 'update log: read failed'; });
  }

  /* Print, per downloaded unit, the three values that decide whether it is offered an update,
     and the verdict each surface reaches from them. ⛔ The verdict is RE-DERIVED here rather than
     imported, because the point is to compare it against what the page and the card actually
     show — a probe that called the same function would agree with a broken one by construction. */
  /* ⚠ 2026-09-26 — THE PANEL LIVES ON THE HOME SPLASH, AND THE SPLASH DOES NOT LOAD topics.js.
     Only nav.js's Android-app now-playing bar injects it there (Capacitor-gated), so on Android
     this probe worked and on the iPhone PWA every row read "? — quiet (no published stamp)": no
     topic list → no unit name → no sig lookup → a silent all-clear. Load it on demand, and if it
     still is not there, say so rather than print a verdict. */
  function withTopics(cb) {
    if (window.ThaiEarTopics) return cb();
    var s = document.getElementById('te-topics-js'), done = false;
    function fin() { if (!done) { done = true; cb(); } }
    if (!s) {
      s = document.createElement('script'); s.id = 'te-topics-js'; s.src = '/topics.js';
      document.head.appendChild(s);
    }
    s.addEventListener('load', fin); s.addEventListener('error', fin);
    setTimeout(fin, 5000);
  }
  function staleReport(el) { withTopics(function () { staleReportNow(el); }); }
  function staleReportNow(el) {
    var T = window.ThaiEarTopics;
    var man = {};
    try { man = JSON.parse(localStorage.getItem('thaiear_offline') || '{}'); } catch (_) {}
    var prefixes = Object.keys(man);
    if (!prefixes.length) { el.innerHTML = 'downloads: <b>none on this device</b>'; return; }

    fetch('/quiz-data/index.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        var sig = (j && j.sig) || null, pver = (j && j.ver) || null;
        var all = T ? [].concat(T.topics || [], T.structures || []) : [];
        var rows = [], nStale = 0;
        prefixes.forEach(function (pfx) {
          var e = man[pfx] || {};
          if (!e.refs || e.refs.indexOf('topic') === -1) return;   // not a topic's own download
          var u = null;
          for (var i = 0; i < all.length; i++) if (all[i].audio === pfx) { u = all[i]; break; }
          var unit = u ? String(u.page || '').replace(/\.html$/, '') : '?';
          var pub = (sig && sig[unit] != null) ? sig[unit] : null;
          var pv = (pver && pver[unit] != null) ? pver[unit] : null;
          var verdict, why;
          if (pub == null) { verdict = 'quiet'; why = 'no published stamp for this unit'; }
          else if (!e.ver) { verdict = 'UPDATE'; why = 'no ver — predates the content stamp'; }
          else if (e.qz == null) { verdict = 'UPDATE'; why = 'no qz — updated before v645'; }
          else if (e.qz !== pub) { verdict = 'UPDATE'; why = 'qz differs — quiz re-published'; }
          /* r217 — the PUBLISHED PAGE HASH as well. Without it this probe reported "quiet"
             for a unit the card was correctly flagging, because it could only see the quiz
             sig: a third opinion, which is the last thing this bug needed. */
          else if (pv != null && e.ver !== pv) { verdict = 'UPDATE'; why = 'page differs — text or quiz block re-published'; }
          else { verdict = 'quiet'; why = 'current'; }
          if (verdict === 'UPDATE') nStale++;
          rows.push('<div style="margin:3px 0 0"><b>' + esc(unit) + '</b> — ' +
            (verdict === 'UPDATE' ? '<b style="color:#B00">UPDATE</b>' : 'quiet') +
            ' <span style="color:#8A8A8A">(' + esc(why) + ')</span><br>' +
            '<span style="color:#8A8A8A;font-size:11px">ver:' + (e.ver ? esc(String(e.ver)) : '—') +
            '  qz:' + (e.qz == null ? '—' : esc(String(e.qz))) +
            '  sig:' + (pub == null ? '—' : esc(String(pub))) +
            '  pageVer:' + (pv == null ? '—' : esc(String(pv))) + '</span>' +
            (unit !== '?' ? '<br><span data-saved="' + esc(unit) + '" data-pv="' + esc(pv == null ? '' : String(pv)) +
              '" style="color:#8A8A8A;font-size:11px">saved copies: …</span>' : '') + '</div>');
        });
        if (!rows.length) { el.innerHTML = 'downloads: <b>no topic downloads</b> (playlist clips only)'; return; }
        el.innerHTML = 'downloads: <b>' + rows.length + '</b>, ' +
          (nStale ? '<b style="color:#B00">' + nStale + ' should offer an update</b>'
                  : '<b>all current</b>') +
          (sig ? '' : ' <span style="color:#B00">⚠ stamp map did not load — every row reads quiet</span>') +
          (all.length ? '' : ' <span style="color:#B00">⚠ topic list did not load — units show as ? and every row reads quiet</span>') +
          '<div data-pjs style="color:#8A8A8A;font-size:11px">player.js: …</div>' +
          rows.join('');
        /* 2026-09-24 — WHICH player.js WILL A TOPIC PAGE RUN? The r226 cachePage() fix deletes
           same-path strays, and the phone re-saved /topic-01 with the strays still there; this
           tells "the old code ran" from "the delete failed" without inference. */
        var pj = el.querySelector('[data-pjs]');
        caches.keys().then(function (ks) {
          var act = ks.filter(function (k) { return /^thaiear-v\d+$/.test(k); }).pop();
          if (!act) { pj.textContent = 'player.js: no version cache'; return; }
          return caches.open(act).then(function (c) { return c.match('/player.js'); }).then(function (r) {
            if (!r) { pj.textContent = 'player.js: not in ' + act; return; }
            var d = (r.headers.get('date') || '').replace(/^\w+, /, '').replace(/ GMT$/, '');
            return r.text().then(function (t) {
              var has = t.indexOf('r226') !== -1;
              pj.innerHTML = 'player.js in ' + esc(act) + ': ' + (has ? 'HAS the r226 page-key fix ✓'
                : '<b style="color:#B00">OLD — no r226 fix</b>') + ' (' + esc(d) + ', ' + t.length + ' chars)';
            });
          });
        }).catch(function () { pj.textContent = 'player.js: read failed'; });
        var spans = el.querySelectorAll('[data-saved]');
        for (var k = 0; k < spans.length; k++) savedCopies(spans[k]);
      });
  }
  /* 2026-09-24 — THE PAGE BYTES THEMSELVES, which the rows above cannot see. Owner, on the
     Android app: topic-01, topic-02 and topic-36b read "Page update available" INSIDE the page
     OFFLINE only, "downloaded" online, and a tick on the card — while every row above reads
     quiet (ver == pageVer, qz == sig). With the stamps current, the only comparison left that
     can raise the page prompt is dynCheckPageUpdate()'s `e.ver !== contentHash()`: the COPY
     BEING RENDERED hashes differently from the published page. Offline the SW answers a topic
     navigation from the version cache first, then thaiear-dl (sw.js FALLBACK_CACHES), so this
     hashes BOTH copies with player.js's exact construction and prints when each was fetched.
     ⚠ Read-only: a probe that repaired what it measured would destroy the evidence. */
  function savedCopies(span) {
    var unit = span.getAttribute('data-saved'), pv = span.getAttribute('data-pv');
    if (!window.caches) { span.textContent = 'saved copies: caches API unavailable'; return; }
    function h53(t) {
      var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (var i = 0, ch; i < t.length; i++) {
        ch = t.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    function pageHash(html) {
      var m = html.replace(/\r\n/g, '\n').match(/window\.ThaiEarTopic\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
      if (!m) return 'no data block';
      var pg; try { pg = (new Function('return (' + m[1] + ')'))(); } catch (_) { return 'unparseable'; }
      var S1 = String.fromCharCode(1), S2 = String.fromCharCode(2), S3 = String.fromCharCode(3);
      var base = (pg.sentences || []).map(function (x) {
        return [x.num, x.thai || '', x.english || ''].join(S1);
      }).join(S2);
      return h53(base + S3 + JSON.stringify(pg.quiz || ''));
    }
    /* ⚠ EVERY ENTRY, not the first match. The first cut used c.match(), which returns ONE entry —
       and the question it raised (topic-13b's copy survived an Update unchanged) is whether a
       re-save lands under a DIFFERENT key (query string, .html) beside the old one, which a
       single match cannot show. keys() is in insertion order, which is also match() order, so
       the first entry listed is the one an offline lookup is answered with. */
    function one(name) {
      return caches.open(name).then(function (c) {
        return c.keys().then(function (reqs) {
          var mine = reqs.filter(function (q) {
            var p = new URL(q.url).pathname;
            return p === '/' + unit || p === '/' + unit + '.html';
          });
          if (!mine.length) return name + ': none';
          return Promise.all(mine.map(function (q) {
            var u = new URL(q.url);
            return c.match(q).then(function (r) {
              if (!r) return u.pathname + u.search + ' → gone';
              var d = r.headers.get('date') || '';
              return r.text().then(function (t) {
                var hv = pageHash(t);
                return u.pathname + u.search + ' ' + hv + (pv ? (hv === pv ? ' ✓' : ' ✗ OLD') : '') +
                  (d ? ' (' + d.replace(/^\w+, /, '').replace(/ GMT$/, '') + ')' : '') +
                  (r.redirected ? ' [redirected]' : '');
              });
            });
          })).then(function (ls) { return name + ' [' + mine.length + ']: ' + ls.join(' | '); });
        });
      }).catch(function () { return name + ': read failed'; });
    }
    caches.keys().then(function (ks) {
      var list = ks.filter(function (k) { return /^thaiear-v\d+$/.test(k) || k === 'thaiear-dl'; });
      return Promise.all(list.map(one));
    }).then(function (parts) {
      span.innerHTML = 'saved copies — ' + parts.map(function (p) {
        return /✗/.test(p) ? '<b style="color:#B00">' + esc(p) + '</b>' : esc(p);
      }).join(' · ');
    }).catch(function () { span.textContent = 'saved copies: read failed'; });
  }
  function esc(x) {
    return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function paint() { banner(); picker(); }
  function ui() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }
})();
