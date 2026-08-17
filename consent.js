/* ============================================================
   consent.js — cookie consent + Google Consent Mode v2
   ------------------------------------------------------------
   The gate every advertising tag sits behind. Nothing that stores or
   transmits for advertising may fire until this grants it.

   WHY IT EXISTS: privacy.html §6 could truthfully say "we do not use
   advertising or tracking cookies" right up until the Google Ads tag went
   in. UK PECR requires PRIOR consent for any non-essential storage, and
   Consent Mode v2 is required for EEA/UK traffic before Google will use
   the data at all — so a half-built version gets the legal burden with
   none of the benefit.

   SHOWN ONCE. The choice is stored for 6 months. A returning visitor
   never sees it again unless they clear site data, switch device, or
   withdraw via ThaiEarConsent.show().

   ⚠ NOT SHOWN IN THE APP OR INSTALLED PWA — and not because it would be
   annoying there. No ad ever lands inside the app, so no advertising tag
   is loaded there, so there is nothing to consent to. `granted()` simply
   answers false and every tag stays dormant. Suppressing the BANNER while
   still firing tags would be the non-compliant version of this; don't
   refactor it into that.

   ⚠ ACCEPT AND REJECT ARE EQUALLY PROMINENT, DELIBERATELY. A bright
   "Accept all" beside a buried "manage settings" link is the single most
   common way these fail an ICO reading. Keep them the same size, weight
   and contrast if you touch the styling.

   ⚠ DISMISSING IS NOT CONSENTING. There is no ✕ and Esc does not close
   it: no choice means no storage, so the banner has nothing to remember
   and would simply return. Choosing Reject is the one-click way out.

   ⚠ The "NOT WIRED UP YET" warning that used to sit here was STALE and
   dangerously so in a legally-sensitive file — the tag shipped 2026-08-12
   (SESSION_2026-08-12_TRACKING.md). This file IS loaded site-wide and IS
   in sw.js PRECACHE. Corrected 2026-08-17.

   API: window.ThaiEarConsent
     .granted('advertising'|'analytics') -> bool
     .state()      -> { analytics, advertising, at } | null
     .show()       -> reopen the chooser (for a privacy.html link)
     .onChange(cb) -> called with state() on every decision
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarConsent) return;                 // load once

  var KEY     = 'te_consent';
  var VERSION = 1;                                   // bump to re-ask everyone
  var MAX_AGE = 182 * 24 * 60 * 60 * 1000;           // ~6 months

  /* ---------- Consent Mode v2 defaults ---------------------------------
     Pushed synchronously, before any Google tag can load, so the tag sees
     "denied" from its first instruction rather than racing us. Safe to run
     even though no tag is installed yet — the queue just waits. -------- */

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function pushConsent(state, isDefault) {
    var ad = state && state.advertising ? 'granted' : 'denied';
    var an = state && state.analytics ? 'granted' : 'denied';
    var payload = {
      ad_storage: ad,
      ad_user_data: ad,
      ad_personalization: ad,
      analytics_storage: an,
      functionality_storage: 'granted',
      security_storage: 'granted',
    };
    if (isDefault) payload.wait_for_update = 500;
    gtag('consent', isDefault ? 'default' : 'update', payload);
  }

  /* ---------- environment ---------------------------------------------- */

  // Same idiom as nav.js lockZoom() — keep them in step if either changes.
  var C = window.Capacitor;
  var native = !!(C && C.isNativePlatform && C.isNativePlatform());
  var standalone = window.navigator.standalone === true ||
    !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var IS_APP = native || standalone;

  function ls(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

  /* ---------- stored decision ------------------------------------------ */

  function read() {
    var raw = ls(function () { return localStorage.getItem(KEY); }, null);
    if (!raw) return null;
    var s = ls(function () { return JSON.parse(raw); }, null);
    if (!s || s.v !== VERSION || !s.at) return null;
    if (Date.now() - Date.parse(s.at) > MAX_AGE) return null;   // aged out — ask again
    return s;
  }

  function write(analytics, advertising) {
    var s = { v: VERSION, analytics: !!analytics, advertising: !!advertising, at: new Date().toISOString() };
    ls(function () { localStorage.setItem(KEY, JSON.stringify(s)); });
    current = s;
    pushConsent(s, false);
    listeners.forEach(function (cb) { ls(function () { cb(s); }); });
    return s;
  }

  var current = IS_APP ? null : read();
  var listeners = [];

  pushConsent(current, true);                        // denied unless already granted

  /* ---------- UI -------------------------------------------------------- */

  var CSS =
    '.te-consent{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;' +
    'border-top:1px solid #e3e3e3;box-shadow:0 -2px 16px rgba(0,0,0,.10);' +
    'font-family:Inter,system-ui,sans-serif;color:#222;padding:16px}' +
    '.te-consent-in{max-width:1080px;margin:0 auto;display:flex;flex-wrap:wrap;' +
    'align-items:center;gap:16px}' +
    '.te-consent-t{flex:1 1 320px;min-width:0;font-size:calc(.875rem * var(--te-ui, 1));line-height:1.5;margin:0}' +
    '.te-consent-t a{color:#B29234;text-decoration:underline}' +
    '.te-consent-b{display:flex;gap:8px;flex-wrap:wrap}' +
    /* Equal weight on both actions is a compliance requirement, not a style choice. */
    '.te-consent-b button{font:inherit;font-size:calc(.875rem * var(--te-ui, 1));font-weight:600;' +
    'padding:10px 18px;border-radius:8px;border:1px solid #222;background:#fff;color:#222;' +
    'cursor:pointer;min-height:44px}' +
    '.te-consent-b button:hover{background:#f5f5f5}' +
    /* Focus ring is currentColor, NOT the brand gold. Gold is the site's accent, so a gold ring
       around Reject read as "this is the recommended one" — a thumb on the scale nobody chose.
       It must stay visible though (WCAG 2.4.7): :focus-visible means keyboard users get it and
       mouse users never see it, which is what made the auto-focus bug so conspicuous. */
    '.te-consent-b button:focus-visible{outline:2px solid currentColor;outline-offset:2px}' +
    '.te-consent-more{background:none;border:0;padding:0;color:#B29234;text-decoration:underline;' +
    'cursor:pointer;font:inherit;font-size:calc(.8125rem * var(--te-ui, 1))}' +
    '.te-consent-opts{flex:1 1 100%;margin:4px 0 0;font-size:calc(.8125rem * var(--te-ui, 1))}' +
    '.te-consent-opts label{display:flex;gap:8px;align-items:flex-start;margin:8px 0}' +
    '@media (prefers-color-scheme:dark){' +
    '.te-consent{background:#1c1c1e;border-top-color:#3a3a3c;color:#f2f2f7}' +
    '.te-consent-b button{background:#1c1c1e;color:#f2f2f7;border-color:#f2f2f7}' +
    '.te-consent-b button:hover{background:#2c2c2e}}';

  var node = null;

  /* ⚠ THE BAR IS position:fixed;bottom:0, SO IT SITS ON TOP OF THE END OF EVERY PAGE.
     Nothing reserved space for it, so on a phone it covered the last ~177px of the viewport and
     whatever lived there was unclickable — `elementFromPoint` over a topic page's prev/next button
     at 390x700 returned the BAR, not the button (measured 2026-08-15).

     Reported as "prev/next need two taps": on Android the first tap is swallowed by the bar, that
     tap hides the browser URL bar, the viewport grows, the page shifts under the finger, and the
     second tap lands on the button. So it presented as a flaky double-tap rather than as an
     overlay — which is why it looked like a JS bug and is not one.

     Pad the BODY by the bar's real height instead of guessing: the copy wraps differently at every
     width and inflates with --te-ui (TEXT_SCALING.md), so a hardcoded value is wrong somewhere.
     Re-measured on resize/rotate, and cleared the moment the bar goes. */
  var padOn = false;
  function syncPad() {
    if (!node) return;
    var h = node.getBoundingClientRect().height;
    if (h > 0) { document.body.style.paddingBottom = Math.ceil(h) + 'px'; padOn = true; }
  }
  function clearPad() {
    if (!padOn) return;
    document.body.style.paddingBottom = '';
    padOn = false;
  }
  window.addEventListener('resize', syncPad);
  window.addEventListener('orientationchange', function () { setTimeout(syncPad, 200); });

  function close() {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    node = null;
    clearPad();
  }

  function render() {
    if (IS_APP || node) return;

    if (!document.getElementById('te-consent-css')) {
      var st = document.createElement('style');
      st.id = 'te-consent-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    node = document.createElement('div');
    node.className = 'te-consent';
    /* region, NOT dialog. The bar is non-modal — you can read and use the site without
       answering it — so announcing it as a dialog would promise a focus trap that does not
       exist. A labelled region is discoverable by screen readers without hijacking anything. */
    node.setAttribute('role', 'region');
    node.setAttribute('aria-label', 'Cookie choices');
    node.innerHTML =
      '<div class="te-consent-in">' +
        /* ⚠ COPY IS A COMPLIANCE SURFACE, NOT MARKETING SPACE — but it is allowed to make the
           honest case. The previous wording ("measure how well our adverts work … saying no
           changes nothing about what you can use or listen to") led with the least sympathetic
           reason and then argued AGAINST itself twice. You must say what the cookies do and how
           to withdraw; you are not required to talk the visitor out of it. Rewritten 2026-08-17.
           Every claim here is true of what actually fires: GA4 records which pages are used and
           where visitors arrive from, the Ads tag records whether an ad click led anywhere.
           ⚠ Keep the "it's optional" clause. It is true, it is the honest part of the trade, and
           dropping it entirely would be the point where persuasion turns into a dark pattern. */
        '<p class="te-consent-t"><strong>Help us improve ThaiEar.</strong> Cookies show us which ' +
          'lessons people actually use and how visitors find the site. Optional — nothing about ' +
          'your learning changes either way. <a href="/privacy">How we use them</a>.</p>' +
        /* ⚠ ORDER IS NOT REGULATED; PROMINENCE IS. No UK/EU rule sets left-vs-right, and the
           EDPB cookie-banner taskforce's violation list does not mention order. Accept-first is
           a legitimate nudge. What is NOT legitimate — and what the CSS above deliberately
           prevents — is pairing it with visual asymmetry: same size, weight, border, background
           and contrast on both, or this becomes the dark pattern regulators actually fine.
           ⚠ So: you may reorder these, or you may restyle them. Never both. Ideally never the
           second at all. */
        '<div class="te-consent-b">' +
          '<button type="button" data-te="accept">Okay</button>' +
          '<button type="button" data-te="reject">No thanks</button>' +
        '</div>' +
        '<button type="button" class="te-consent-more" data-te="more">Choose what to allow</button>' +
      '</div>';

    node.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-te]');
      if (!b) return;
      var a = b.getAttribute('data-te');
      if (a === 'accept') { write(true, true); close(); }
      else if (a === 'reject') { write(false, false); close(); }
      else if (a === 'more') { expand(); }
    });

    document.body.appendChild(node);
    syncPad();          // reserve its height so the end of the page is not underneath it

    /* ⚠ DO NOT AUTO-FOCUS A BUTTON HERE. It was doing first.focus(), which landed on Reject and
       drew a gold focus ring around it — a visible thumb on the scale that nobody chose, and the
       one asymmetry regulators do look for (in the other direction). It is also wrong for a
       non-modal bar: stealing focus on load throws keyboard and screen-reader users out of
       wherever they were reading. The buttons are reachable by Tab like any other control. */
  }

  function expand() {
    if (!node || node.querySelector('.te-consent-opts')) return;
    var box = document.createElement('div');
    box.className = 'te-consent-opts';
    box.innerHTML =
      '<label><input type="checkbox" checked disabled> ' +
        '<span><strong>Necessary</strong> — signing in, your playlists, offline downloads. ' +
        'Always on; the site cannot work without them.</span></label>' +
      '<label><input type="checkbox" data-cat="analytics"> ' +
        '<span><strong>Analytics</strong> — which pages and topics get used.</span></label>' +
      '<label><input type="checkbox" data-cat="advertising"> ' +
        '<span><strong>Advertising</strong> — whether an advert you clicked led anywhere.</span></label>' +
      '<div class="te-consent-b" style="margin-top:12px">' +
        '<button type="button" data-te="save">Save choices</button></div>';
    box.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-te="save"]');
      if (!b) return;
      var g = function (c) { var i = box.querySelector('[data-cat="' + c + '"]'); return !!(i && i.checked); };
      write(g('analytics'), g('advertising'));
      close();
    });
    node.querySelector('.te-consent-in').appendChild(box);
    syncPad();          // the options panel makes the bar much taller — re-reserve
  }

  /* ---------- go --------------------------------------------------------- */

  function boot() { if (!current && !IS_APP) render(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.ThaiEarConsent = {
    granted: function (cat) {
      if (IS_APP) return false;                      // no tags in the app, so nothing is granted
      return !!(current && current[cat]);
    },
    state: function () { return current ? JSON.parse(JSON.stringify(current)) : null; },
    show: function () { close(); render(); expand(); },
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    isApp: function () { return IS_APP; },
  };
})();
