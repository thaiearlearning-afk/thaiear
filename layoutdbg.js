/* layoutdbg.js — LAYOUT FLASH / SHIFT DEBUGGER (owner-only). Keep this file.
   ------------------------------------------------------------------------------------------
   WHAT IT IS FOR. Any bug of the shape "something paints, then is replaced by something else"
   or "the page jumps once it loads". Those are invisible in a desktop browser and hard to catch
   by eye on a phone, and four blind attempts at one of them failed precisely because nobody
   could see what the DEVICE reported. This prints the sequence, with timings.
   (The project's rule, learned repeatedly: measure on the device. Inference has lost every time.)

   ── TURNING IT ON AND OFF ─────────────────────────────────────────────────────────────────
   ON   : it shows automatically for the owner while `te_layoutdbg` is not 'off'.
          Anywhere with an address bar you can also force it with ?layoutdbg=1.
   OFF  : tap ✕ on the overlay. That persists — it stays off on that device until re-armed.
   BACK : visit any page with ?layoutdbg=1 (web / desktop), or clear the key.
   ⚠ Once the owner hash has matched once on a device, it is remembered in te_layoutdbg_ok, so
     the tool KEEPS WORKING AFTER LOGOUT — the signed-out state is exactly what it is for.
   ⚠ The app and the installed PWA have NO ADDRESS BAR, so ?layoutdbg=1 does not exist there.
   That is why ON is the default rather than something you arm — on the two devices where these
   bugs actually appear, an arm-by-URL switch would make the tool unreachable.

   ── HOW IT IS GATED ───────────────────────────────────────────────────────────────────────
   Same two-stage gate as ownersim.js: the localStorage flag decides whether the file is
   FETCHED, the ACCOUNT decides whether it does anything.
   ⚠ The owner check reads `thaiear_identity`, NOT getUser(). That record survives sign-out, so
   the probe keeps working in the signed-OUT state — which matters, because several of these
   bugs ONLY appear when signed out, and a gate needing a live session could never see them.
   For anyone else: no overlay, no listeners, no cost.

   ── WHAT IT SHOWS ─────────────────────────────────────────────────────────────────────────
   One line per DISTINCT state, so the ORDER is visible rather than the end state: isReady,
   whether getUser() has a user, whether auth is running on the durable identity, which of the
   two localStorage records exist, and what the progress slot / offline bar are rendering at
   that instant. Polls at 40ms for 12s then stops by itself. "copy" puts the log on the
   clipboard. Extend snap() when you need a different element in the trace. */
(function () {
  'use strict';
  if (window.__teAuthDbg) return;
  window.__teAuthDbg = true;

  var OWNER_SHA = [
    'f158e8ba0177149ebd33d06f08ac400709d39133f9f366f7bdb3ac17bcb1c171',
    'b923407d6637d0f83f9eaa4b5cf324523a265685ae444805e0422ea85c2b142e'
  ];
  function realEmail() {
    try {
      var id = JSON.parse(localStorage.getItem('thaiear_identity') || 'null');
      var e = id && id.user && id.user.email;
      return e ? String(e).trim().toLowerCase() : '';
    } catch (_) { return ''; }
  }
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

  var t0 = Date.now();
  var lines = [];
  var last = '';
  var box = null;

  function has(k) { try { return localStorage.getItem(k) ? 'Y' : '-'; } catch (_) { return '?'; } }

  /* One line per DISTINCT state, not per poll — the point is the sequence of changes. */
  function snap(tag) {
    var a = window.ThaiEarAuth;
    var prog = document.getElementById('progress-controls');
    var bar = document.getElementById('offline-bar');
    var slot = !prog ? '-'
      : prog.querySelector('.te-signup') ? 'CARD'
      : prog.querySelector('.prog-ctl-card') ? 'BAR'
      : (prog.innerHTML.trim() === '' ? 'empty' : '?');
    var obar = !bar ? '-'
      : bar.querySelector('.te-signup') ? 'CARD'
      : bar.querySelector('.te-appcta') ? 'APP'
      : (bar.style.display === 'none' ? 'hidden' : '?');
    var rec =
      'rdy=' + (a && a.isReady ? 'Y' : 'N') +
      ' usr=' + (a && a.getUser && a.getUser() ? 'Y' : 'N') +
      ' prov=' + (a && a.isProvisional ? (a.isProvisional() ? 'Y' : 'N') : '?') +
      ' id=' + has('thaiear_identity') +
      ' out=' + has('thaiear_signed_out') +
      ' | slot=' + slot + ' bar=' + obar;
    if (rec === last) return;
    last = rec;
    lines.push('+' + String(Date.now() - t0).padStart(5) + 'ms ' + rec + (tag ? '  <' + tag + '>' : ''));
    paint();
  }

  function paint() {
    if (!box) return;
    box.textContent = lines.join('\n');
  }

  function mount() {
    box = document.createElement('pre');
    box.id = 'te-layout-dbg';
    box.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;margin:0;max-height:45vh;' +
      'overflow:auto;background:rgba(0,0,0,.88);color:#8f8;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;' +
      'padding:8px 10px 10px;white-space:pre;-webkit-overflow-scrolling:touch';
    var hide = document.createElement('button');
    hide.textContent = '✕';
    hide.title = 'Hide (stays off on this device until re-armed with ?layoutdbg=1)';
    hide.style.cssText = 'position:fixed;left:8px;bottom:calc(45vh + 6px);z-index:2147483647;' +
      'font:12px system-ui;padding:6px 12px;border-radius:6px;border:0;background:#555;color:#fff';
    hide.onclick = function () {
      try { localStorage.setItem('te_layoutdbg', 'off'); } catch (_) {}
      [box, close, hide].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    };
    var close = document.createElement('button');
    close.textContent = 'copy';
    close.style.cssText = 'position:fixed;right:8px;bottom:calc(45vh + 6px);z-index:2147483647;' +
      'font:12px system-ui;padding:6px 12px;border-radius:6px;border:0;background:#4B41AD;color:#fff';
    close.onclick = function () {
      try { navigator.clipboard.writeText(lines.join('\n')); close.textContent = 'copied'; }
      catch (_) { close.textContent = 'select manually'; }
    };
    (document.body || document.documentElement).appendChild(box);
    (document.body || document.documentElement).appendChild(close);
    (document.body || document.documentElement).appendChild(hide);
    paint();

    /* Poll rather than rely on events: the whole question is what happens BETWEEN them, and a
       missed transition is the one that matters. 40ms for 12s is plenty to catch a 1200ms race
       and a swap, and it stops on its own so it cannot sit burning battery. */
    snap('mount');
    var iv = setInterval(function () { snap(''); }, 40);
    setTimeout(function () { clearInterval(iv); snap('stop'); }, 12000);
    window.addEventListener('thaiear:auth', function () { snap('auth-event'); });
  }

  function armed() {
    try {
      if (/[?&]layoutdbg=1/.test(location.search)) { localStorage.setItem('te_layoutdbg', 'on'); return true; }
      return localStorage.getItem('te_layoutdbg') !== 'off';
    } catch (_) { return true; }
  }
  /* ⚠ REMEMBER THAT THE OWNER WAS VERIFIED — thaiear_identity does NOT survive an explicit
     logout. auth.js's clearIdentity() removes it and raises the signed-out marker, so a gate
     reading only that record vanished the moment the owner signed out (reported 2026-08-15) —
     which is precisely when several of these bugs appear. It survives a session EXPIRY, not a
     deliberate sign-out; those are different things and this depended on the wrong one.
     So once the hash has matched on this device, keep our own key. It is ours, so nothing in the
     auth flow clears it, and ?layoutdbg=0 / the ✕ still turn the tool off.
     Privacy, not security — same reasoning as ownersim.js: a stranger who set this by hand would
     see a readout of their OWN auth state and nothing else. */
  var OK_KEY = 'te_layoutdbg_ok';
  function remember() { try { localStorage.setItem(OK_KEY, '1'); } catch (_) {} }
  function wasOwner() { try { return localStorage.getItem(OK_KEY) === '1'; } catch (_) { return false; } }

  if (armed()) {
    if (wasOwner()) mount();
    else checkOwner().then(function (ok) { if (ok) { remember(); mount(); } });
  }
})();
