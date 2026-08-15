/* authdbg.js — OWNER-ONLY auth-state probe (2026-08-15). TEMPORARY DIAGNOSTIC.
   ------------------------------------------------------------------------------------------
   WHY THIS EXISTS. A signed-out visitor in the app/PWA sees the working progress bar flash
   before the signup card, on every topic open. Four blind fixes failed because the bug does not
   reproduce in a desktop browser and nobody could see what the DEVICE actually reports. This
   prints exactly that, as it happens, so the next fix is aimed rather than guessed.
   (The project's own hard-won rule: measure on the device; inference has lost every time.)

   ⚠ DELETE THIS FILE once the flash is fixed. It is not a feature. Remove: this file, the
   loader block in nav.js, and the <script> nothing else references.

   ── HOW IT IS GATED ───────────────────────────────────────────────────────────────────────
   Same two-stage gate as ownersim.js, and for the same reason: the localStorage flag decides
   whether the file is FETCHED, the ACCOUNT decides whether it does anything.
   ⚠ The owner check reads `thaiear_identity`, NOT getUser(). That record survives sign-out —
   it is the very thing causing the bug — so the probe keeps working in the signed-OUT state we
   need to observe, which an email check against a live session could not do.
   For anyone else it renders nothing at all: no overlay, no listeners, no cost.

   ── WHAT IT SHOWS ─────────────────────────────────────────────────────────────────────────
   A timestamped log of every auth-relevant transition, so the ORDER is visible rather than the
   end state: isReady, whether getUser() has a user, whether auth is running on the durable
   identity, which of the two localStorage records exist, and what the progress slot / offline
   bar are actually rendering at that moment. If the bar paints before the card, this shows the
   exact millisecond and the auth values that caused it. */
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
    box.id = 'te-auth-dbg';
    box.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;margin:0;max-height:45vh;' +
      'overflow:auto;background:rgba(0,0,0,.88);color:#8f8;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;' +
      'padding:8px 10px 10px;white-space:pre;-webkit-overflow-scrolling:touch';
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
    paint();

    /* Poll rather than rely on events: the whole question is what happens BETWEEN them, and a
       missed transition is the one that matters. 40ms for 12s is plenty to catch a 1200ms race
       and a swap, and it stops on its own so it cannot sit burning battery. */
    snap('mount');
    var iv = setInterval(function () { snap(''); }, 40);
    setTimeout(function () { clearInterval(iv); snap('stop'); }, 12000);
    window.addEventListener('thaiear:auth', function () { snap('auth-event'); });
  }

  checkOwner().then(function (ok) { if (ok) mount(); });
})();
