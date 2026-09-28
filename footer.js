/* ============================================================
   footer.js — SINGLE SOURCE OF TRUTH for the ThaiEar copyright line.
   ------------------------------------------------------------
   Injected on EVERY page automatically by nav.js (which is itself
   loaded on every page). To change the copyright wording, owner
   name, or start year, edit THIS FILE ONLY — no page edits.

   The notice is deliberately SITE-LEVEL: it asserts copyright in
   the original work you own (sentence selection, curation, English,
   glosses, design) — not in the Thai language or the TTS engine.
   ============================================================ */

(function () {
  'use strict';

  /* ---- the one place to edit ------------------------------------------- */
  const OWNER      = 'ThaiEar';
  const START_YEAR = 2026;

  /* Show a single year, or a range once time has passed (never goes stale). */
  function yearLabel() {
    const now = new Date().getFullYear();
    return now > START_YEAR ? START_YEAR + '–' + now : String(START_YEAR);
  }

  /* ---- NO social links (owner, 2026-09-29) ----------------------------------------------
     Instagram · TikTok · YouTube · Socials used to sit above the © line here. The posts do not
     suit the brand yet, so the socials page is unplugged: no footer links, no menu entry (nav.js),
     noindex, out of the sitemap. socials.html stays live for anyone holding the URL. To restore,
     take this file's SOCIALS list, pageHref() and .site-copyright-socials styles back from git
     (before sw v748), along with the static footers in gen_topics_pages.js / gen_home_splash.js. */

  /* ---- styles (own them here so it's truly single-source) --------------
     Uses the page's design tokens, which every page defines in :root. */
  const STYLES = `
    .site-copyright {
      text-align: center;
      padding: 1.1rem 1rem 1.3rem;
      font-size: 12px;
      color: var(--text-secondary);
      border-top: 0.5px solid var(--border);
    }
  `;

  function mount() {
    if (document.getElementById('site-copyright')) return; // already placed
    // If a page hand-builds its own footer (e.g. index.html), it owns the
    // copyright line itself — don't inject a second one.
    if (document.querySelector('.site-footer')) return;
    if (!document.getElementById('site-copyright-styles')) {
      const style = document.createElement('style');
      style.id = 'site-copyright-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }
    const el = document.createElement('footer');
    el.className = 'site-copyright';
    el.id = 'site-copyright';
    el.textContent = '© ' + yearLabel() + ' ' + OWNER + '. All rights reserved.';
    document.body.appendChild(el);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
