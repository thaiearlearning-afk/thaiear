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

  /* ---- app / installed-PWA only: lock out zoom ----
     An accidental double-tap zoom breaks the illusion of an app, and there is nothing here
     worth zooming into — the type is already sized for a phone. Applied ONLY in the native
     app and an installed (standalone) PWA: on the website itself, pinch-zoom stays available,
     because disabling it is an accessibility failure and would cost the Lighthouse
     Best-Practices/a11y score the site currently holds at 100.
     touch-action:manipulation is what actually kills double-tap in WebKit (which ignores
     user-scalable=no); gesturestart covers Safari's pinch. Deliberately NOT pan-x/pan-y, which
     would also intercept the scrubber drag. */
  (function lockZoom() {
    var C = window.Capacitor;
    var native = !!(C && C.isNativePlatform && C.isNativePlatform());
    var standalone = window.navigator.standalone === true ||
      !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!native && !standalone) return;
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) {
      var c = vp.getAttribute('content') || 'width=device-width, initial-scale=1.0';
      if (!/maximum-scale/.test(c)) c += ', maximum-scale=1';
      if (!/user-scalable/.test(c)) c += ', user-scalable=no';
      vp.setAttribute('content', c);
    }
    var st = document.createElement('style');
    st.id = 'te-nozoom';
    st.textContent = 'html{touch-action:manipulation;-webkit-text-size-adjust:100%}';
    (document.head || document.documentElement).appendChild(st);
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
    });
  })();

  /* ---- OS TEXT-SCALING GUARD → the --te-ui multiplier ----------------------
     ANDROID ONLY, in practice. Android's system font-size setting drives the WebView's
     `WebSettings.textZoom`, which multiplies TEXT ONLY — padding, gaps, icon boxes and
     container widths do not move. So text outgrows the boxes drawn for it. There is no CSS
     opt-out: `-webkit-text-size-adjust` governs Android's *font boosting*, not textZoom.
     (iOS is NOT affected: Dynamic Type never applies to px web text, and iOS Page Zoom
     scales the whole layout proportionally, which is safe. The probe returns 1 there, and
     on every desktop browser, so this whole mechanism is a no-op outside Android.)

     WHAT THIS DOES: measure the zoom factor, then hand the CSS a counter-multiplier in
     `--te-ui` so SITE CHROME can cancel most of it out:
         font-size: calc(13px * var(--te-ui, 1))
     textZoom multiplies the *used* font size, so the two cancel: 13 × (1.15/1.4) × 1.4 = 15.
     Body/sentence text deliberately does NOT use the var and scales in full.

     ⚠ IT CAPS, IT DOES NOT FREEZE. Chrome text still grows, up to CAP (15%), then holds.
     A hard freeze would make the accessibility setting do nothing at all to the nav, fails
     WCAG 1.4.4 (text resizable to 200%), and gets flagged by Play Store pre-launch
     accessibility reports. Raise/lower CAP here — it is the one knob.

     ⚠ THE STRUCTURAL FIXES ARE THE REAL FIX; this is the polish on top. Every layout that
     uses --te-ui must ALSO survive var(--te-ui) resolving to 1 (min-width:0, wrapping,
     ellipsis, min-height not height). If the probe ever misreads, the layout still holds.

     Runs at defer-script time (body is parsed, first paint has not happened), so scaled
     users do not see a full-size flash. Re-measured on resize and on returning to the app,
     because the user can change the setting while we are backgrounded. */
  (function uiScale() {
    var CAP = 1.15;                    // chrome may grow 15%, then stops
    var root = document.documentElement;
    var last = null;

    /* A 100px/1 block renders 100px tall — unless textZoom is on, when it renders 130px at
       "Large". getComputedStyle is no good here: it reports the SPECIFIED size, not the
       zoomed one, so the ratio has to be read off a real rendered box. */
    function measure() {
      var host = document.body || root;
      if (!host) return 1;
      var p = document.createElement('div');
      p.setAttribute('aria-hidden', 'true');
      p.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:auto;height:auto;' +
        'padding:0;margin:0;border:0;visibility:hidden;white-space:nowrap;font:400 100px/1 monospace';
      p.textContent = 'M';
      host.appendChild(p);
      var h = p.offsetHeight;
      if (p.parentNode) p.parentNode.removeChild(p);
      return h > 0 ? h / 100 : 1;      // 0 = not laid out (hidden tab) → assume unscaled
    }

    function apply() {
      var r = measure();
      // 1.02 dead-band: sub-pixel rounding must not trigger a pointless counter-scale.
      var s = (r > 1.02) ? Math.min(1, CAP / r) : 1;
      s = Math.round(s * 1000) / 1000;
      if (s === last) return;
      last = s;
      root.style.setProperty('--te-ui', String(s));
      root.style.setProperty('--te-ui-raw', String(Math.round(r * 100) / 100));
    }

    apply();
    var t = null;
    function requeue() { if (t) clearTimeout(t); t = setTimeout(apply, 250); }
    window.addEventListener('resize', requeue);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) requeue(); });
    // Exposed so the measured factor can be read on a device with no address bar
    // (ThaiEarUIScale.raw() — see the debug-by-measurement rule).
    window.ThaiEarUIScale = {
      apply: apply,
      raw: measure,
      get: function () { return last; }
    };
  })();

  /* ---- offline: register the service worker (caches the app shell + pages) ----
     Runs on every page since nav.js loads everywhere. Enables offline browse/play
     in the app (and PWA offline on the web). Audio is handled separately. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      // r98: NEVER register on localhost — a SW registered during a local review session precaches
      // the pages/JS and then silently serves stale copies across edit rounds (bit twice, 2026-08-01).
      // Also unregister any worker a previous session already left on this origin.
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(location.hostname)) {
        navigator.serviceWorker.getRegistrations().then(function (rs) {
          rs.forEach(function (r) { r.unregister(); });
        }).catch(function () {});
        return;
      }
      navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('SW register failed', e); });
    });
  }

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
    members: true,
  };

  /* ---- TOP-BAR LINKS ----------------------------------------------------
     The one list to edit when adding an ordinary top-bar link.
     (Blog is parked here, commented out, ready to switch on later.) */
  const LINKS = [
    // 'Home' and 'About' now live in the Menu dropdown (see MENU_ITEMS) to keep
    // the top bar uncramped on mobile. (Home is redundant anyway — the logo links
    // to the index page.)
    // Read Thai top-bar entry removed — reading is reached via the index's Read panel now (owner, 2026-08-02).
    // { label: 'Blog',  href: 'blog.html' },
  ];

  /* ---- where the person/account icon points ---------------------------- */
  const ACCOUNT_HREF = 'account.html';

  /* ---- person icon ------------------------------------------------------ */
  const PERSON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>';

  /* ---- styles (own the nav's CSS here too, so it's truly single-source).
     Uses the page's design tokens — they must be defined in :root. -------- */
  /* ⚠ TEXT-SCALING RULES FOR THIS BAR (Android textZoom — see the uiScale() note above).
     The nav is the tightest strip on the site: a fixed-height flex row with an unbreakable
     wordmark at one end and an unbreakable username at the other. Three things keep it intact
     when the OS inflates text, and all three matter:
       1. `min-height`, never `height` — a 54px box clipped the username the moment it took a
          second line (measured: 58px tall inside 54px, owner-reported "username on two lines").
       2. The username TRUNCATES (nowrap + max-width + ellipsis). It comes from the Google
          profile name, so it can be arbitrarily long and has no shrink point of its own —
          it was what pushed the bar apart. The person icon next to it carries the meaning,
          and Account lives in its dropdown, so an ellipsis costs nothing.
       3. `min-width: 0` on the flex row, so the truncation is actually reachable — a flex
          item's automatic minimum size is its min-content width, which otherwise pins it.
     The `calc(… * var(--te-ui, 1))` sizes then cap the growth at 15%. The var is polish:
     with it absent (resolving to 1) the three rules above still hold the layout. */
  const STYLES = `
    .site-nav { background: var(--surface); border-bottom: 0.5px solid var(--border);
      padding: 0 2rem; min-height: 54px; display: flex; align-items: center; gap: 10px;
      justify-content: space-between; position: sticky; top: 0; z-index: 100; }
    .nav-logo { display: flex; align-items: center; gap: 4px; text-decoration: none; flex-shrink: 0; }   /* tight to the swirl — one brand mark, not strangers (owner, 2026-08-02) */
    .nav-logo img { height: 26px; width: auto; display: block; }   /* swirl at 85% of the 31px size, gap unchanged at 4px so it stays tight to the wordmark (owner, 2026-08-02) */
    .nav-wordmark { font-family: var(--font-thai); font-size: calc(20px * var(--te-ui, 1)); font-weight: 600;
      color: #1C124E; letter-spacing: 0.02em; white-space: nowrap; }
    .nav-wordmark span { color: #1C124E; font-weight: 600; }
    .nav-links { display: flex; gap: 1.75rem; align-items: center; min-width: 0; }
    .nav-links a { font-size: calc(13px * var(--te-ui, 1)); font-weight: 500; color: var(--text-secondary);
      text-decoration: none; }
    .nav-links a:hover { color: var(--text-primary); }
    .nav-links a.active { color: var(--text-primary); }

    /* members area (dormant until FEATURES.members) */
    .nav-person { display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 50%; color: var(--text-secondary);
      text-decoration: none; transition: background .15s, color .15s; }
    .nav-person:hover { background: var(--accent-light); color: var(--accent); }
    /* person icon is also a .nav-menu-btn (dropdown trigger) — keep its accent hover, and don't
       let .nav-menu-btn's text/gap styles distort the circular icon button. */
    .nav-person.nav-menu-btn { gap: 0; }
    .nav-person.nav-menu-btn:hover { color: var(--accent); }
    .nav-person svg { width: 18px; height: 18px; }
    .nav-auth { font-size: calc(13px * var(--te-ui, 1)); font-weight: 500; color: var(--accent);
      text-decoration: none; white-space: nowrap; flex-shrink: 0; }
    .nav-auth:hover { color: var(--accent-mid); }
    .nav-username { font-size: calc(13px * var(--te-ui, 1)); font-weight: 500; color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 12ch; }

    /* "Menu" dropdown — member features (Progress, My sentences). Visible to everyone;
       logged-out clicks route to the login page (handled by the item hrefs). */
    .nav-menu { position: relative; display: inline-flex; }
    .nav-menu-btn { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-ui);
      font-size: calc(13px * var(--te-ui, 1)); font-weight: 500; color: var(--text-secondary);
      background: none; border: none; cursor: pointer; padding: 0; white-space: nowrap; flex-shrink: 0; }
    .nav-menu-btn:hover { color: var(--text-primary); }
    .nav-menu-caret { width: 10px; height: 10px; transition: transform 0.18s; }
    .nav-menu-btn[aria-expanded="true"] .nav-menu-caret { transform: rotate(180deg); }
    .nav-menu-drop { position: absolute; top: calc(100% + 12px); right: 0; min-width: 168px;
      background: var(--surface); border: 0.5px solid var(--border-strong); border-radius: var(--radius-md);
      box-shadow: 0 8px 28px rgba(0,0,0,0.13); padding: 5px; z-index: 200; display: flex; flex-direction: column; }
    .nav-menu-drop a { font-size: calc(13px * var(--te-ui, 1)); font-weight: 500; color: var(--text-secondary);
      text-decoration: none; padding: 8px 12px; border-radius: var(--radius-sm); white-space: nowrap; }
    .nav-menu-drop a:hover { background: var(--accent-light); color: var(--accent); }
    .nav-menu-drop a.active { color: var(--accent); }
    .nav-menu-drop[hidden] { display: none; }

    @media (max-width: 600px) {
      .site-nav { padding: 0 1rem; }
      .nav-links { gap: 1rem; }
      .nav-links a { font-size: calc(12px * var(--te-ui, 1)); }
      /* Android "display size" shrinks the CSS viewport as well as inflating text, so the
         phone case is the narrow one AND the big-text one at the same time. Give the name
         less rope here — the person icon beside it is what actually identifies the account. */
      .nav-username { max-width: 9ch; }
    }
    @media (max-width: 380px) {
      .nav-wordmark { font-size: calc(18px * var(--te-ui, 1)); }
      .nav-username { max-width: 7ch; }
    }
  `;

  /* ---- render helpers --------------------------------------------------- */
  function currentPage() {
    return (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  }

  // True when running inside the Capacitor native app (vs the website in a browser).
  function isNativeApp() {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
    catch (_) { return false; }
  }

  function linksHtml() {
    const here = currentPage();
    const onHome = here === 'index.html';
    return LINKS
      // No "Home" link while you're on the home page (you only need it elsewhere).
      .filter(l => !(onHome && l.href.toLowerCase() === 'index.html'))
      .map(l => {
        const classes = [l.cls || '', l.href.toLowerCase() === here ? 'active' : ''].filter(Boolean).join(' ');
        return `<a href="${l.href}"${classes ? ` class="${classes}"` : ''}>${l.label}</a>`;
      }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Member-features dropdown — shown to EVERYONE (logged in or not). Each item points at
  // its page when signed in; when signed out it points at the login page (join.html, which
  // bounces back to the page via ?next after sign-in). So a non-member who clicks Progress
  // or My sentences lands on the login page, exactly as intended.
  // `public: true` items (e.g. About) always link straight to their page, even
  // when logged out. The rest are member features: logged-out clicks route to the
  // login page (join.html) which bounces back via ?next after sign-in.
  const MENU_ITEMS = [
    { label: 'Home', page: 'index.html', public: true },
    // Read Thai mobile-menu entry removed — reading is reached via the index's Read panel now (owner, 2026-08-02).
    { label: 'About', page: 'about.html', public: true },
    { label: 'Guide', page: 'guide.html', public: true },
    { label: 'Socials', page: 'socials.html', public: true },
    // Visible everywhere INCLUDING inside the Capacitor app (owner, 2026-08-02 — the page now
    // documents offline downloads/playlists, useful in-app; supersedes the old fourth-wall hide).
    { label: 'App', page: 'app.html', public: true },
  ];
  // Personal / account items — these live in the person-icon dropdown (logged in only),
  // NOT the generic Menu above.
  const PERSON_ITEMS = [
    { label: 'Account', page: 'account.html' },
    { label: 'My progress', page: 'progress.html' },
    { label: 'My sentences', page: 'sentences.html' },
  ];
  function menuHtml() {
    if (!FEATURES.members) return '';
    const loggedIn = !!getUser();
    const here = currentPage();
    const native = isNativeApp();
    const items = MENU_ITEMS.filter(it => !(it.hideInApp && native)).map(it => {
      const href = (it.public || loggedIn) ? it.page : ('join.html?feature=1&next=' + encodeURIComponent(it.page));
      const classes = [it.cls || '', it.page.toLowerCase() === here ? 'active' : ''].filter(Boolean).join(' ');
      return `<a href="${href}"${classes ? ` class="${classes}"` : ''}>${it.label}</a>`;
    }).join('');
    return (
      `<div class="nav-menu" id="nav-menu">` +
        `<button type="button" class="nav-menu-btn" id="nav-menu-btn" aria-haspopup="true" aria-expanded="false">` +
          `Menu` +
          `<svg class="nav-menu-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
        `</button>` +
        `<div class="nav-menu-drop" id="nav-menu-drop" hidden>${items}</div>` +
      `</div>`
    );
  }

  // Personal/account dropdown hung off the person icon (logged in only): Account, My progress,
  // My sentences. Generic links live in the separate "Menu" dropdown (MENU_ITEMS).
  function personMenuHtml() {
    const here = currentPage();
    const links = PERSON_ITEMS.map(it => {
      const active = it.page.toLowerCase() === here ? ' class="active"' : '';
      return `<a href="${it.page}"${active}>${it.label}</a>`;
    }).join('');
    return (
      `<div class="nav-menu" id="nav-person-menu">` +
        `<button type="button" class="nav-person nav-menu-btn" id="nav-person-btn" aria-haspopup="true" aria-expanded="false" aria-label="Your account" title="Account">${PERSON_SVG}</button>` +
        `<div class="nav-menu-drop" id="nav-person-drop" hidden>${links}</div>` +
      `</div>`
    );
  }

  /* Has auth actually resolved? Until it has, the nav must render NEITHER state.
     Supabase resolves a few hundred ms after paint, so rendering "Log in" in the meantime made
     every load flash logged-out before the username appeared — harmless in itself, but after the
     offline-logout bug it reads as "I've been signed out again" every single time, which is the
     last thing a user needs to see. A same-width placeholder holds the slot so nothing shifts;
     ThaiEarNav.refresh() repaints it the moment auth fires. */
  function authReady() {
    try { return !!(window.ThaiEarAuth && window.ThaiEarAuth.isReady); } catch (_) { return false; }
  }

  function memberHtml() {
    if (!FEATURES.members) return '';
    if (!authReady()) {
      return '<span class="nav-auth nav-auth-pending" aria-hidden="true" ' +
        'style="display:inline-block;min-width:48px;opacity:0"></span>';
    }
    const user = getUser();
    if (user) {
      // Logged in: username + person-icon dropdown (Account / My progress / My sentences).
      return (
        `<span class="nav-username">${escapeHtml(user.username)}</span>` +
        personMenuHtml()
      );
    }
    // Logged out: send to the account page, which shows the Terms/Privacy notice next
    // to the "Sign in with Google" button (rather than firing OAuth silently from the nav).
    return `<a class="nav-auth" href="account.html">Log in</a>`;
  }

  function navHtml() {
    return (
      `<nav class="site-nav">` +
        `<a class="nav-logo" href="index.html">` +
          `<img src="nav-swirl.png" alt="ThaiEar logo" width="132" height="128">` +
          `<span class="nav-wordmark">Thai<span>Ear</span></span>` +
        `</a>` +
        `<div class="nav-links">${linksHtml()}${menuHtml()}${memberHtml()}</div>` +
      `</nav>`
    );
  }

  // Open/close the dropdowns (Menu + person icon). Wired fresh each mount (the nav is re-rendered
  // on auth change). Generalised over every .nav-menu so both drops work and opening one closes
  // the other.
  function wireMenus() {
    document.querySelectorAll('.nav-menu-btn').forEach(function (btn) {
      const menu = btn.closest('.nav-menu');
      const drop = menu ? menu.querySelector('.nav-menu-drop') : null;
      if (!drop) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const willOpen = drop.hasAttribute('hidden');
        closeAllMenus();
        if (willOpen) { drop.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
      });
    });
  }
  function closeAllMenus() {
    document.querySelectorAll('.nav-menu-drop').forEach(function (drop) {
      if (drop.hasAttribute('hidden')) return;
      drop.setAttribute('hidden', '');
      const menu = drop.closest('.nav-menu');
      const btn = menu ? menu.querySelector('.nav-menu-btn') : null;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }
  // Close on outside-click / Escape (added once; query elements live so re-mounts are fine).
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest || !e.target.closest('.nav-menu')) closeAllMenus();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAllMenus(); });

  /* ---- load the auth layer once (only when members UI is on) ------------
     auth.js wires Supabase, exposes window.ThaiEarAuth, and calls
     ThaiEarNav.refresh() when the login state changes. Loading it from here
     means no page needs its own <script> — the single-source nav owns it. */
  function ensureAuth() {
    if (!FEATURES.members) return;
    if (document.getElementById('thaiear-auth-js')) return;
    const s = document.createElement('script');
    s.id = 'thaiear-auth-js';
    s.src = 'auth.js';
    document.body.appendChild(s);
  }

  /* ---- load the site-wide copyright footer once ------------------------
     footer.js owns the © line and injects it at the bottom of the page.
     Loading it from here means no page needs its own <script> — the nav,
     which is already on every page, brings the footer with it. */
  function ensureFooter() {
    if (document.getElementById('thaiear-footer-js')) return;
    const s = document.createElement('script');
    s.id = 'thaiear-footer-js';
    s.src = 'footer.js';
    document.body.appendChild(s);
  }

  /* ---- mount ------------------------------------------------------------ */
  let lastNavHtml = null;   // r149: the exact string we last wrote — see the note in mount()
  function mount() {
    /* EMBED MODE (r126): a page loaded with ?embed=1 (read/playlists inside the index switcher
       panels) must not build a nav AT ALL. The CSS hide (`.te-embed #site-nav-root`) was never
       enough by itself: the injection below REPLACES #site-nav-root with <nav class="site-nav">,
       so the selector stopped matching the moment the nav existed — a second full ThaiEar header
       rendered inside each panel (owner-reported, 2026-08-02). The pages' embed CSS now also
       covers nav.site-nav as a backstop, but skipping the build here is the real fix (and it keeps
       the app's now-playing bar from duplicating inside embedded panels too).
       ⚠ ensureAuth() must STILL run: read.html and playlists.html carry no auth.js tag of their
       own — the nav loader is what brings auth in, and the embedded panels (member-gated read
       tests, the playlists list) need a signed-in ThaiEarAuth exactly as much as the full pages. */
    if (document.documentElement.className.indexOf('te-embed') >= 0) { ensureAuth(); return; }
    ensureAuth();
    ensureFooter();
    if (!document.getElementById('site-nav-styles')) {
      const style = document.createElement('style');
      style.id = 'site-nav-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }
    /* r149 — REBUILD ONLY WHEN THE MARKUP ACTUALLY CHANGED (owner, 2026-08-08: on the iPhone PWA
       the index logo flickers and the Menu dropdown "promptly snaps shut", settling after a second
       or two).
       CAUSE: auth.js's notify() calls ThaiEarNav.refresh() — i.e. this function — from NINE places,
       several of which fire during a normal load (cached subscription status, then the live read,
       then consent, then the lifetime refresh). Every one of them threw the whole <nav> away and
       built a new one. Two consequences, and the owner reported both:
         • the open dropdown is INSIDE the discarded node, so the menu shuts under your finger;
         • the logo <img> is brand new each time, with nothing decoded, so it paints empty for a
           frame — the same defect fixed on sentences.html at r141, same cause, same cure.
       Nearly every one of those refreshes produces byte-identical markup: nothing in the nav
       changes between "cached status says subscribed" and "the server agrees".
       ⚠ COMPARE AGAINST WHAT WE LAST WROTE, NEVER AGAINST el.outerHTML — reading it back gives the
       browser's NORMALISED serialisation (attribute order, quote style, entity encoding), so an
       identical nav can compare unequal and rebuild on every call anyway. That exact trap cost
       progress.html a full rebuild per render before r144; this is the same fix. */
    const html = navHtml();
    const existing = document.querySelector('nav.site-nav');
    if (existing && lastNavHtml === html) { setupNowPlayingBar(existing); return; }
    lastNavHtml = html;

    // Place the <nav> at BODY level (replace the placeholder rather than nest
    // inside it) so position:sticky works down the whole page. The 54px
    // placeholder is swapped 1:1 for the 54px nav, so there's no layout jump.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const el = tmp.firstElementChild;
    /* Carry the DECODED logo bitmap across a genuine rebuild (r141's lesson from sentences.html:
       a detached node keeps its decode, a fresh <img> re-decodes and flashes). The one surviving
       rebuild — signing in or out — then costs no flicker either. */
    const oldImg = existing ? existing.querySelector('.nav-logo img') : null;
    const newImg = el.querySelector('.nav-logo img');
    if (oldImg && newImg && oldImg.src === newImg.src) newImg.replaceWith(oldImg);
    // Re-open whatever was open, so a rebuild that DOES happen mid-interaction is not felt either.
    const openBtnIdx = existing
      ? [].slice.call(existing.querySelectorAll('.nav-menu-btn'))
          .findIndex(function (b) { return b.getAttribute('aria-expanded') === 'true'; })
      : -1;
    const slot = document.getElementById('site-nav-root') || existing;
    if (slot) slot.replaceWith(el);
    wireMenus();
    if (openBtnIdx >= 0) {
      const btn = el.querySelectorAll('.nav-menu-btn')[openBtnIdx];
      const drop = btn && btn.closest('.nav-menu') ? btn.closest('.nav-menu').querySelector('.nav-menu-drop') : null;
      if (drop) { drop.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
    }
    setupNowPlayingBar(el);
  }

  /* ---- "Now playing" bar (Capacitor app only) ----
     The native player keeps going as you move around the app, so on NON-topic pages (index, account,
     etc.) show a small bar with the playing topic that links back to it. Topic pages already show it
     in their player. Liveness comes from the engine's own time ticks, so it works on any page. */
  function setupNowPlayingBar(navEl) {
    if (window.ThaiEarTopic) return;          // topic pages display now-playing in the player
    const NA = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.NativeAudio : null;
    if (!NA || document.getElementById('te-np-bar')) return;   // app only; once
    if (!document.getElementById('te-np-styles')) {
      const s = document.createElement('style');
      s.id = 'te-np-styles';
      s.textContent =
        '.te-np-bar{position:sticky;top:54px;z-index:40;display:none;align-items:center;gap:9px;' +
        'background:var(--accent-light,#EEEDFE);color:var(--accent,#4B41AD);text-decoration:none;' +
        'padding:9px 14px;font-family:var(--font-ui,system-ui,sans-serif);font-size:calc(13px * var(--te-ui, 1));font-weight:500;' +
        'border-bottom:0.5px solid var(--border,rgba(0,0,0,0.1))}' +
        '.te-np-bar.show{display:flex}' +
        // Premium playing topic → gold bar (eq bars use currentColor, so they follow). Keyed on the
        // played topic's tier stored in thaiear_np, NOT the current page.
        '.te-np-bar.te-np-premium{background:#FBF5DC;color:#B29234}' +
        '.te-np-eq{display:inline-flex;align-items:flex-end;gap:2px;height:13px;flex-shrink:0}' +
        '.te-np-eq i{width:3px;background:currentColor;border-radius:1px;animation:te-np-eq 0.9s ease-in-out infinite}' +
        '.te-np-eq i:nth-child(1){height:6px}.te-np-eq i:nth-child(2){height:12px;animation-delay:0.2s}.te-np-eq i:nth-child(3){height:8px;animation-delay:0.4s}' +
        '@keyframes te-np-eq{0%,100%{transform:scaleY(0.4)}50%{transform:scaleY(1)}}' +
        '.te-np-text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.te-np-text strong{font-weight:600}' +
        '.te-np-go{opacity:0.55;font-size:18px;line-height:1;flex-shrink:0}';
      document.head.appendChild(s);
    }
    const bar = document.createElement('a');
    bar.id = 'te-np-bar';
    bar.className = 'te-np-bar';
    bar.innerHTML = '<span class="te-np-eq"><i></i><i></i><i></i></span><span class="te-np-text"></span><span class="te-np-go">›</span>';
    navEl.insertAdjacentElement('afterend', bar);

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function update() {
      let np; try { np = JSON.parse(localStorage.getItem('thaiear_np') || 'null'); } catch (_) { np = null; }
      if (!np || !np.page || !np.name) { bar.classList.remove('show'); return; }
      bar.setAttribute('href', np.page);
      bar.querySelector('.te-np-text').innerHTML = 'Now playing: <strong>' + esc(np.name) + '</strong>';
      bar.classList.toggle('te-np-premium', np.access === 'premium');
      bar.classList.add('show');
    }
    let stale = null;
    function alive() { update(); if (stale) clearTimeout(stale); stale = setTimeout(function () { bar.classList.remove('show'); }, 1600); }
    function hide() { if (stale) clearTimeout(stale); bar.classList.remove('show'); }
    NA.addListener('time', alive);                              // a tick = something is playing
    NA.addListener('ended', hide);
    NA.addListener('playing', function (d) { if (d && d.playing === false) hide(); });

    // ---- track control on NON-topic pages (no player.js here, so the lock-screen ⏮/⏭/autoplay would
    //      otherwise do nothing). Advances the persistent native player straight from this page. ----
    const AUDIO_BASE = 'https://audio.thaiear.com';
    if (!window.ThaiEarTopics && !document.getElementById('te-topics-js')) {
      const sc = document.createElement('script'); sc.id = 'te-topics-js'; sc.src = 'topics.js'; sc.defer = true;
      document.head.appendChild(sc);                           // need the topic list for next/prev
    }
    function isDl(prefix) { try { return !!JSON.parse(localStorage.getItem('thaiear_offline') || '{}')[prefix]; } catch (_) { return false; } }
    // Same premium offline-licence rule as the topic player — applied here so an expired member can't
    // advance into a downloaded premium topic from a non-topic page. KEEP OFFLINE_GRACE_MS IN SYNC WITH
    // player.js (1 min for testing → 30 days for prod).
    const OFFLINE_GRACE_MS = 50 * 24 * 60 * 60 * 1000;   // 50 days (prod) — keep in sync with player.js
    function canUseOffline(tier) {
      if (tier !== 'premium') return true;
      try { if (localStorage.getItem('thaiear_lifetime') === '1') return true; } catch (_) {} // lifetime → no offline timeout
      const a = window.ThaiEarAuth, subbed = a && a.isSubscribed && a.isSubscribed();
      // Only GRANT on the online fast-path — never DENY from it (navigator.onLine lies in the WebView,
      // reporting online in airplane mode / at cold start). Denial = grace window + end-date below only.
      if (navigator.onLine && subbed) return true;
      // Trust the captured real end date when present (correct billing semantics); the backstop window
      // is only a fallback for when no end date was captured. KEEP IN SYNC WITH player.js canUseOffline.
      const last = parseInt(localStorage.getItem('thaiear_lastVerified') || '0', 10);
      const until = parseInt(localStorage.getItem('thaiear_sub_until') || '0', 10);
      if (until && Date.now() < until) return true;   // valid captured end date
      return !!last && (Date.now() - last) < OFFLINE_GRACE_MS;   // fallback: verified within backstop
    }
    function remoteUrl(file, access) {
      if (access !== 'member' && access !== 'premium') return Promise.resolve(AUDIO_BASE + '/' + file);
      const tok = window.ThaiEarAuth && window.ThaiEarAuth.getAccessToken && window.ThaiEarAuth.getAccessToken();
      if (!tok) return Promise.reject({ code: 'noauth' });
      return fetch('/api/audio?file=' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + tok } })
        .then(function (r) { if (!r.ok) return Promise.reject({ code: r.status }); return r.json(); })
        .then(function (j) { if (!j || !j.url) return Promise.reject({ code: 'nourl' }); return j.url; });
    }
    function resolveUrl(file, prefix, access) {
      const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (FS && isDl(prefix) && canUseOffline(access)) {       // offline: prefer the local download (if licence ok)
        return FS.getUri({ directory: 'DATA', path: 'offline/' + prefix + '/' + file })
          .then(function (r) { return (r && r.uri) ? r.uri : remoteUrl(file, access); })
          .catch(function () { return remoteUrl(file, access); });
      }
      return remoteUrl(file, access);
    }
    function npGet() { try { return JSON.parse(localStorage.getItem('thaiear_np') || 'null'); } catch (_) { return null; } }
    function bareP(p) { return String(p || '').toLowerCase().replace(/\.html$/, ''); }
    function playable(unit) {                       // genuinely playable now? (same rule as the topic player)
      if (!unit || !unit.audio) return false;
      const T = window.ThaiEarTopics;
      if (navigator.onLine && T && T.canAccess && T.canAccess(unit.access)) return true;
      return isDl(unit.audio) && canUseOffline(unit.access);
    }
    function nextPlayable(fromPage, dir) {          // skip non-playable topics → next that actually plays
      const T = window.ThaiEarTopics;
      if (!T || !T.nextAccessible) return null;
      let page = fromPage, max = (T.liveSequence ? T.liveSequence().length : 60) + 1;
      for (let i = 0; i < max; i++) {
        const unit = T.nextAccessible(page, dir);
        if (!unit || !unit.audio) return null;
        if (playable(unit)) return unit;
        if (bareP(unit.page) === bareP(fromPage)) return null;
        page = unit.page;
      }
      return null;
    }
    function navAdvance(dir) {
      const np = npGet();
      if (!np || !np.page) return;
      const unit = nextPlayable(np.page, dir);      // skip anything that can't actually play now
      if (!unit || !unit.audio) return;
      const file = unit.audio + '_' + (np.mode === 'et' ? 'ET' : 'TE') + '.mp3';
      resolveUrl(file, unit.audio, unit.access).then(function (url) {
        return NA.prepare({ url: url, title: unit.name || 'ThaiEar', subtitle: 'ThaiEar', artwork: 'https://thaiear.com/apple-touch-icon.png' })
          .then(function () { return NA.play(); })
          .then(function () {
            let page = String(unit.page || '').toLowerCase(); if (page && !/\.html$/.test(page)) page += '.html';
            try { localStorage.setItem('thaiear_np', JSON.stringify({ page: page, name: unit.name, prefix: unit.audio, mode: np.mode || 'te', access: unit.access || 'free' })); } catch (_) {}
          });
      }).catch(function () {});
    }
    NA.addListener('command', function (d) {
      const a = d && d.action;
      if (a === 'thaiear.NEXT') navAdvance(1);
      else if (a === 'thaiear.PREV') navAdvance(-1);
      else if (a === 'thaiear.REPEAT') { try { localStorage.setItem('thaiear_repeat', localStorage.getItem('thaiear_repeat') === '1' ? '0' : '1'); } catch (_) {} }
    });
    NA.addListener('ended', function () {
      let rep = false, auto = false;
      try { rep = localStorage.getItem('thaiear_repeat') === '1'; auto = localStorage.getItem('thaiear_autoplay') === '1'; } catch (_) {}
      if (rep) { NA.seekTo({ seconds: 0 }).then(function () { NA.play(); }).catch(function () {}); }   // repeat-one
      else if (auto) { navAdvance(1); }                                                                // autoplay continues off-page
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  /* Let the auth layer refresh the nav after login/logout without a reload. */
  window.ThaiEarNav = { refresh: mount };
})();
