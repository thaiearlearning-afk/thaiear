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
          ? 'ON. Open a topic — the trace appears top-right. Play a sentence, then come back and Copy trace.'
          : 'Off. Turning it on takes effect on the NEXT page you open.') + '</span>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button type="button" id="ownersim-lat-toggle" style="' + SWBTN + '">' +
            (latOn() ? 'Turn probe off' : 'Turn probe on') + '</button>' +
          '<button type="button" id="ownersim-lat-copy" style="' + SWBTN + '">Copy trace</button>' +
        '</div><div id="ownersim-lat-out"></div>';
      lat.querySelector('#ownersim-lat-toggle').addEventListener('click', function () {
        set('te_lat', latOn() ? null : '1');
        paintLat();
      });
      lat.querySelector('#ownersim-lat-copy').addEventListener('click', function () {
        var out = lat.querySelector('#ownersim-lat-out');
        if (typeof window.__teLat !== 'function') {
          out.innerHTML = '<span style="color:#7A1F1F">No trace on this page. The probe only runs on a ' +
            'TOPIC or PLAYLIST page — open one, play a sentence, then press this there.</span>';
          return;
        }
        var s = '';
        try { s = JSON.stringify(window.__teLat(), null, 1); }
        catch (_) { out.textContent = 'could not read the trace'; return; }
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s); } catch (_) {}
        out.innerHTML = '<textarea readonly style="width:100%;height:170px;margin-top:8px;' +
          'font:11px/1.4 ui-monospace,monospace;-webkit-user-select:text;user-select:text"></textarea>';
        var ta = out.querySelector('textarea');
        ta.value = s;
        try { ta.focus(); ta.select(); } catch (_) {}
      });
    }
    paintLat();
    d.appendChild(lat);
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
      var v = swVerdict(out.caches, activeCache);
      var tone = (v.code === 'stuck' || v.code === 'undeleted') ? 'color:#7A1F1F'
               : v.code === 'unknown' ? 'opacity:.75' : 'color:#1F5D3A';
      rows.push('<span style="' + tone + '">' + v.html + '</span>');
    }
    if (window.ThaiEarPlayerBuild) rows.push('player: ' + esc(window.ThaiEarPlayerBuild));

    el.innerHTML = rows.join('<br>') +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button type="button" id="ownersim-sw-update" style="' + SWBTN + '">Check for update</button>' +
        '<button type="button" id="ownersim-sw-sweep" style="' + SWBTN + '"' +
          (activeCache && out.caches.length > 1 ? '' : ' disabled') + '>Clear orphan caches</button>' +
      '</div>';

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
  }
  var SWBTN = 'border:1px solid #7A1F1F;background:#fff;color:#7A1F1F;border-radius:6px;' +
    'padding:4px 9px;font:12px/1.3 system-ui,-apple-system,sans-serif;cursor:pointer';

  /* The email hash IS the gate — K_ON is not consulted here any more. Requiring a URL-set flag
     made the picker unreachable in a standalone PWA / the Android app, which have no address bar
     and are exactly where the simulator is needed. */
  function paint() { banner(); picker(); }
  function ui() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }
})();
