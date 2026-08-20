/* ============================================================
   gtag.js — the Google tag, loaded ONLY after consent
   ------------------------------------------------------------
   One tag serves both Google Ads (conversions, bidding) and GA4
   (behaviour, funnels). It is deliberately NOT in the page <head>: the
   script is fetched only once ThaiEarConsent grants advertising or
   analytics, so a visitor who refuses never downloads it at all — which
   is what "prior consent" under PECR actually requires, as distinct from
   loading it and asking afterwards.

   ORDER MATTERS. consent.js must run BEFORE this file, because it pushes
   the Consent Mode v2 defaults (everything denied) into the dataLayer.
   Google's tag reads that queue on load and honours it. Reverse the two
   script tags and the tag boots with no consent state at all.

   ⚠ INERT IN THE APP AND INSTALLED PWA. ThaiEarConsent.granted() returns
   false there, so this never loads. No ad click ever lands inside the
   app, so there is nothing to measure and nothing to consent to.

   ⚠ THAT "NOT WIRED UP YET" WARNING WAS STALE AND IS GONE (corrected 2026-08-20).
   This file has been loaded site-wide and precached since sw v299 / 2026-08-12.
   attrib.js carried the identical stale warning and was corrected on 2026-08-17;
   this copy was simply missed. Do not re-add it.

   ⛔⛔ CURRENTLY DORMANT BY DESIGN — PAUSED, NOT RETIRED. DO NOT DELETE (owner,
   2026-08-20). Since consent.js gained `BANNER_OFF = true` (sw v372) no new visitor
   is ever asked for consent, so `granted()` is false for them and the Google script
   is never fetched. That makes THIS FILE, the GA4 property, the conversion actions
   and the labels below all look like dead code. THEY ARE NOT. The switch is one
   boolean in consent.js, and the expected moment to flip it back is the human-audio
   launch (or spending the £382 of ad credit before it expires ~23 Oct).
   Deleting any of it would turn a one-character change into a rebuild — and the
   conversion labels in particular are account-specific and slow to reconstruct.

   Conversion labels come from Goals → Conversions → each action → Tag
   setup. They are NOT secret (they ship in the page either way), but they
   ARE account-specific — recorded in MARKETING_VIDEO_AD_STRATEGY.md §6.8
   so they can be rebuilt without digging through the interface.
   ============================================================ */
(function () {
  'use strict';
  if (window.ThaiEarGtag) return;                    // load once

  var ADS_ID = 'AW-18383120038';
  var GA4_ID = 'G-JJNR0KRVXW';                       // GA4 property "ThaiEar", web stream 15423607852

  /* Event name -> conversion label. The bare label only; ADS_ID is prefixed below. */
  var CONVERSIONS = {
    activation:   '2yhQCOv9quAcEKbN4L1E',            // Page view · Primary · the Smart Bidding target
    signup:       'KY8OCLiJmuAcEKbN4L1E',            // Sign-up · Primary (its goal is not an account default)
    subscription: 'ado3CLuJmuAcEKbN4L1E',            // Subscribe · £5.55 GBP · Secondary where allowed
  };

  var loaded = false;

  function wanted() {
    var C = window.ThaiEarConsent;
    if (!C) return false;                            // consent.js absent — fail closed, never open
    return C.granted('advertising') || C.granted('analytics');
  }

  /* ---------- load the tag --------------------------------------------- */

  function load() {
    if (loaded || !wanted()) return;
    loaded = true;

    // consent.js already created dataLayer and pushed the v2 defaults.
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = window.gtag || gtag;

    // Load under whichever product was actually consented to. googletagmanager serves the same
    // library either way, but the id in the URL is the one whose container config is fetched —
    // so requesting AW- when only analytics was granted asks for something we may not configure.
    var C = window.ThaiEarConsent;
    var loaderId = C.granted('advertising') ? ADS_ID : GA4_ID;
    if (!loaderId) { loaded = false; return; }

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(loaderId);
    document.head.appendChild(s);

    gtag('js', new Date());
    // Auto-tagging supplies the gclid; we read it ourselves in attrib.js too,
    // because the first-party record has to survive a refused consent prompt.
    if (window.ThaiEarConsent.granted('advertising')) gtag('config', ADS_ID);
    if (GA4_ID && window.ThaiEarConsent.granted('analytics')) gtag('config', GA4_ID);

    flush();
  }

  /* ---------- send a conversion ---------------------------------------- */

  function send(name) {
    if (!loaded || !window.gtag) return false;
    var label = CONVERSIONS[name];

    // GA4 wants every event; Ads only wants the ones with a conversion action.
    if (GA4_ID && window.ThaiEarConsent.granted('analytics')) {
      window.gtag('event', name);
    }
    if (!label || !window.ThaiEarConsent.granted('advertising')) return false;

    var payload = { send_to: ADS_ID + '/' + label };
    if (name === 'subscription') { payload.value = 5.55; payload.currency = 'GBP'; }
    window.gtag('event', 'conversion', payload);
    return true;
  }

  /* ---------- drain whatever happened before consent -------------------
     attrib.js queues every event from page load. Someone can play a
     sentence, THEN accept the banner — without this, that activation is
     simply lost, and activation is the event bidding depends on. ------- */

  var flushed = {};
  function flush() {
    var A = window.ThaiEarAttrib;
    if (!A || !A.events) return;
    A.events().forEach(function (e) {
      if (flushed[e.event]) return;                  // once per page, mirroring attrib.js
      if (send(e.event)) flushed[e.event] = true;
    });
  }

  /* ---------- go --------------------------------------------------------- */

  // Hand attrib.js a real sender in place of its no-op stub.
  if (window.ThaiEarAttrib) {
    window.ThaiEarAttrib.send = function (name) {
      if (!loaded) { load(); return; }               // load() flushes, which covers this event
      if (!flushed[name] && send(name)) flushed[name] = true;
    };
  }

  if (window.ThaiEarConsent) {
    load();                                          // already decided on a previous visit
    window.ThaiEarConsent.onChange(load);            // or decides now
  }

  window.ThaiEarGtag = {
    loaded: function () { return loaded; },
    send: send,
    ids: function () { return { ads: ADS_ID, ga4: GA4_ID }; },
  };
})();
