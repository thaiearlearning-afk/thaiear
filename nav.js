/* ============================================================
   nav.js — SINGLE SOURCE OF TRUTH for the ThaiEar top nav.
   ------------------------------------------------------------
   Every page injects this nav into <div id="site-nav-root">.
   To add / remove / rename a top-bar link, or to take the
   members area live, you edit THIS FILE ONLY — no page edits.

   Each page must:
     1. define the design tokens in :root (every page already does
        — --surface, --border, --font-thai, --accent, etc.)
     2. contain  <div id="site-nav-root" style="min-height:54px"></div>
        where the nav should appear
     3. load this file:  <script src="nav.js" defer></script>
   ============================================================ */

(function () {
  'use strict';

  /* ---- AUTH INTEGRATION POINT -------------------------------------------
     The ONLY thing the real members system needs to provide later.
     Wire your auth provider to expose window.ThaiEarAuth.getUser(),
     returning  null  (logged out)  or  { username: "toby" }  (logged in).
     Until then this returns null and the nav shows the logged-out state. */
  function getUser() {
    try {
      if (window.ThaiEarAuth && typeof window.ThaiEarAuth.getUser === 'function') {
        return window.ThaiEarAuth.getUser();
      }
    } catch (_) {}
    return null;
  }

  /* ---- FEATURE FLAGS ----------------------------------------------------
     Ship the markup now, reveal it later — no page edits when it goes live.
     Flip `members` to true to switch on the Members button, the person
     icon, and the login/username slot across the whole site at once. */
  const FEATURES = {
    members: false,
  };

  /* ---- TOP-BAR LINKS ----------------------------------------------------
     The one list to edit when adding an ordinary top-bar link.
     (Blog is parked here, commented out, ready to switch on later.) */
  const LINKS = [
    { label: 'Home',  href: 'index.html' },
    { label: 'About', href: '#' },
    // { label: 'Blog',  href: 'blog.html' },
  ];

  /* ---- where the members destinations point ----------------------------
     One destination that itself forks (signed-in view vs sign-up) so the
     nav never has to know the auth state to route. */
  const MEMBERS_HREF = 'members.html';
  const LOGIN_HREF    = 'login.html';

  /* ---- person icon ------------------------------------------------------ */
  const PERSON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>';

  /* ---- styles (own the nav's CSS here too, so it's truly single-source).
     Uses the page's design tokens — they must be defined in :root. -------- */
  const STYLES = `
    .site-nav { background: var(--surface); border-bottom: 0.5px solid var(--border);
      padding: 0 2rem; height: 54px; display: flex; align-items: center;
      justify-content: space-between; position: sticky; top: 0; z-index: 100; }
    .nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .nav-logo img { height: 44px; width: auto; display: block; }
    .nav-wordmark { font-family: var(--font-thai); font-size: 20px; font-weight: 600;
      color: #1C124E; letter-spacing: 0.02em; }
    .nav-wordmark span { color: #1C124E; font-weight: 600; }
    .nav-links { display: flex; gap: 1.75rem; align-items: center; }
    .nav-links a { font-size: 13px; font-weight: 500; color: var(--text-secondary);
      text-decoration: none; }
    .nav-links a:hover { color: var(--text-primary); }
    .nav-links a.active { color: var(--text-primary); }

    /* members area (dormant until FEATURES.members) */
    .nav-person { display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 50%; color: var(--text-secondary);
      text-decoration: none; transition: background .15s, color .15s; }
    .nav-person:hover { background: var(--accent-light); color: var(--accent); }
    .nav-person svg { width: 18px; height: 18px; }
    .nav-auth { font-size: 13px; font-weight: 500; color: var(--accent); text-decoration: none; }
    .nav-auth:hover { color: var(--accent-mid); }
    .nav-username { font-size: 13px; font-weight: 500; color: var(--text-primary); }

    @media (max-width: 600px) {
      .site-nav { padding: 0 1rem; }
      .nav-links { gap: 1rem; }
      .nav-links a { font-size: 12px; }
    }
    @media (max-width: 380px) {
      .nav-wordmark { font-size: 18px; }
    }
  `;

  /* ---- render helpers --------------------------------------------------- */
  function currentPage() {
    return (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  }

  function linksHtml() {
    const here = currentPage();
    return LINKS.map(l => {
      const active = l.href.toLowerCase() === here ? ' class="active"' : '';
      return `<a href="${l.href}"${active}>${l.label}</a>`;
    }).join('');
  }

  function memberHtml() {
    if (!FEATURES.members) return '';
    const user = getUser();
    const authSlot = user
      ? `<span class="nav-username">${user.username}</span>`
      : `<a class="nav-auth" href="${LOGIN_HREF}">Log in</a>`;
    return (
      `<a href="${MEMBERS_HREF}">Members</a>` +
      `<a class="nav-person" href="${MEMBERS_HREF}" aria-label="Members area">${PERSON_SVG}</a>` +
      authSlot
    );
  }

  function navHtml() {
    return (
      `<nav class="site-nav">` +
        `<a class="nav-logo" href="index.html">` +
          `<img src="logoshort.png" alt="ThaiEar logo">` +
          `<span class="nav-wordmark">Thai<span>Ear</span></span>` +
        `</a>` +
        `<div class="nav-links">${linksHtml()}${memberHtml()}</div>` +
      `</nav>`
    );
  }

  /* ---- mount ------------------------------------------------------------ */
  function mount() {
    if (!document.getElementById('site-nav-styles')) {
      const style = document.createElement('style');
      style.id = 'site-nav-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }
    // Place the <nav> at BODY level (replace the placeholder rather than nest
    // inside it) so position:sticky works down the whole page. The 54px
    // placeholder is swapped 1:1 for the 54px nav, so there's no layout jump.
    const tmp = document.createElement('div');
    tmp.innerHTML = navHtml();
    const el = tmp.firstElementChild;
    const slot = document.getElementById('site-nav-root') || document.querySelector('nav.site-nav');
    if (slot) slot.replaceWith(el);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  /* Let the auth layer refresh the nav after login/logout without a reload. */
  window.ThaiEarNav = { refresh: mount };
})();
