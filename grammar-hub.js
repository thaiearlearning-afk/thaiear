/* grammar-hub.js — the owner-only entry point to the Grammar by Ear section (2026-08-27).
   ------------------------------------------------------------------------------------------
   Injects a "Grammar by Ear" card at the TOP of the band list on /topics, visible only to the
   owner's accounts. The section itself is live but unlisted: its pages are noindex, and the
   `structures` array in topics.js is deliberately invisible to every generator that reads
   `.topics`, so nothing links to it publicly.

   ⛔ THIS IS HIDING, NOT SECURITY, AND IT IS NOT PRETENDING OTHERWISE. Anyone reading topics.js
   can see the array; anyone guessing /grammar-07 gets the page. The REAL enforcement is that
   units 3-20 carry access:"premium" and their MP3s live in the private thaiear-audio-premium
   bucket, so /api/audio refuses to sign a URL for a non-subscriber. See
   STRUCTURES_SECTION_PLAN.md §4.3 — three layers, only the third of which is enforcement.

   ⚠ NOT PRECACHED, exactly like ownersim.js. That is deliberate and load-bearing: this file
   never ships into a visitor's cache, and it can be changed with no sw.js VERSION bump.
   Do not add it to PRECACHE.

   ⚠ THE CARD IS INJECTED AFTER AUTH RESOLVES, which moves already-painted content — normally
   forbidden (see the `deferred-writes-only-move-unpainted` rule, and DYN_ROLLOUT.md). Accepted
   here, and recorded so it is not "fixed" later: the judder is visible ONLY to the one account
   that sees the card, and the alternative — the card in static HTML, hidden by CSS — would put
   the section's existence in the page source for every visitor, which is the one thing this
   file exists to avoid.

   AT GO-LIVE (plan §12.2 i) this whole file is deleted and the card becomes real static HTML in
   topics.html — which is also what makes it a crawlable internal link. */
(function () {
  'use strict';

  /* ── OWNER GATE ────────────────────────────────────────────────────────────────────────────
     The same two accounts as ownersim.js, held as SHA-256 of the lowercased address so no
     personal email sits in plain text in a file anyone can request at /grammar-hub.js.
     CLAUDE.md Golden Rule 0 covers the owner's own address too.
     ⚠ Read from thaiear_identity, NOT getUser(): identity.js writes that record synchronously
     at parse time and it survives offline, which is the whole reason it exists. */
  /* ⚠ ONE ACCOUNT ONLY (owner, 2026-08-27). The second address was removed so that the
     other account sees the site exactly as a normal member does — no owner card, no panel,
     no unlisted section. Adding an account back means adding its SHA-256 here; the plain
     address must never appear in the file (Golden Rule 0 covers the owner's own too). */
  var OWNER_SHA = [
    'f158e8ba0177149ebd33d06f08ac400709d39133f9f366f7bdb3ac17bcb1c171'
  ];

  function realEmail() {
    try {
      var id = JSON.parse(localStorage.getItem('thaiear_identity') || 'null');
      var e = id && id.user && id.user.email;
      return e ? String(e).trim().toLowerCase() : '';
    } catch (_) { return ''; }
  }

  // Defensive throughout: anything missing (TextEncoder, subtle on a non-secure origin) must
  // mean "not the owner", never an exception. A thrown error here would be silent and the card
  // would simply never appear, which is indistinguishable from working correctly.
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

  /* ── the card ──────────────────────────────────────────────────────────────────────────────
     Owner's placement: FIRST in the band list, above Beginner — not appended. The section is a
     third arm alongside the topics and Read Thai, not a difficulty band, so it leads. */
  var CARD_ID = 'tp-band-grammar';

  function unitCount() {
    var T = window.ThaiEarTopics;
    return (T && T.structures && T.structures.length) || 0;
  }

  // hrefFor re-adds .html on localhost, where python -m http.server has no clean-URL
  // resolution and a bare /grammar would 404 through the whole local review session.
  function href() {
    var T = window.ThaiEarTopics;
    return (T && T.hrefFor) ? T.hrefFor('grammar.html') : 'grammar';
  }

  /* ⚠⚠ THE CARD MUST BE A DIRECT CHILD OF #tp-bands, AND MUST CARRY class="tp-band" (owner,
     2026-08-27). Band heights are equalised in CSS, not JS: `.tp-bands { display: grid;
     grid-auto-rows: 1fr }` makes every ROW as tall as the tallest, so the pills always match
     however their names wrap. That is why this card is inserted INTO #tp-bands rather than
     beside it, and why it reuses the .tp-band class rather than styling itself.
     ✅ The consequence worth knowing: because the equalisation is the grid's own doing and not a
     measured JS pass, a card added LATE — as this one is, after the owner gate resolves — is
     equalised automatically with no re-measure and nothing to re-trigger. If this ever moves out
     of the grid, or a wrapper element is introduced between it and #tp-bands, the row sizing stops
     applying to it and it will render short against the others.
     ⛔ Do not give it its own height, min-height or padding overrides. topics-page.css §"the five
     band rows" records why a min-height reserve was the WRONG instrument here twice. */
  function mount() {
    var bands = document.getElementById('tp-bands');
    if (!bands) return;                             // not /topics — nothing to do
    if (document.getElementById(CARD_ID)) return;   // idempotent: never mount twice
    var n = unitCount();
    if (!n) return;                                 // topics.js absent or arrived late

    var a = document.createElement('a');
    a.id = CARD_ID;
    a.className = 'tp-band bc-li1';
    a.href = href();
    a.innerHTML =
      '<span class="tp-band-name">Grammar by Ear</span>' +
      '<span class="tp-band-count">' + n + ' units</span>' +
      '<span class="tp-band-go" aria-hidden="true">&rsaquo;</span>';
    bands.insertBefore(a, bands.firstChild);
  }

  function run() {
    checkOwner().then(function (ok) { if (ok) mount(); });
  }

  /* ⚠ topics.js is loaded WITHOUT defer on the band pages but the identity record can be
     written slightly later, and auth can resolve later still. Run on DOM ready, and again on
     thaiear:auth — mount() is idempotent and cheap, so a second call costs nothing. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
  window.addEventListener('thaiear:auth', run);
})();
