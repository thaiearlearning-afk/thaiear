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

  /* ---- styles (own them here so it's truly single-source) --------------
     Uses the page's design tokens, which every page defines in :root. */
  const STYLES = `
    .site-copyright {
      text-align: center;
      padding: 1.1rem 1rem;
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
    el.innerHTML = '© ' + yearLabel() + ' ' + OWNER + '. All rights reserved.';
    document.body.appendChild(el);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
