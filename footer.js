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

  /* ---- social links (single source; mirrored on socials.html + the index footer) ---- */
  const SOCIALS = [
    { label: 'Instagram', href: 'https://www.instagram.com/thaiear.co' },
    { label: 'TikTok',    href: 'https://www.tiktok.com/@thaiear' },
    { label: 'Socials',   href: 'socials.html' },
  ];

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
    .site-copyright-socials {
      display: flex; justify-content: center; flex-wrap: wrap;
      gap: 0.4rem 1.1rem; margin-bottom: 0.6rem;
    }
    .site-copyright-socials a {
      font-size: 12px; font-weight: 500; color: var(--text-secondary); text-decoration: none;
    }
    .site-copyright-socials a:hover { color: var(--accent); }
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
    const socials = SOCIALS.map(function (s) {
      const ext = /^https?:/.test(s.href) ? ' target="_blank" rel="noopener"' : '';
      return '<a href="' + s.href + '"' + ext + '>' + s.label + '</a>';
    }).join('');
    el.innerHTML =
      '<nav class="site-copyright-socials">' + socials + '</nav>' +
      '© ' + yearLabel() + ' ' + OWNER + '. All rights reserved.';
    document.body.appendChild(el);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
