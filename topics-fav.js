/* topics-fav.js — the favourites heart, and the Favourites view. (2026-08-27)
 * ---------------------------------------------------------------------------------------
 * Two jobs, one module because they are the same concern:
 *   1. the heart on every topic card, wherever a topic card appears;
 *   2. /topics-favourites — the favourited units, grouped by band, in grid order.
 *
 * DATA lives in auth.js (ThaiEarAuth.favourites, table public.favourites). This file is
 * presentation only. See favourites_schema.sql for why it is a row per favourite and not a
 * list blob — the short version is that a blob is what let a background sync clobber an
 * unpushed local change on 2026-08-25.
 *
 * ⚠ WHY EVENT DELEGATION AND NOT PER-BUTTON LISTENERS. Topic cards are created after load on
 * two surfaces: search results (topics-page.js re-renders #tp-res-grid on every keystroke)
 * and this page's own grid. A listener bound at load would be attached to buttons that get
 * thrown away, and the replacements would be dead. One delegated listener on the document
 * cannot go stale.
 *
 * ⚠ WHY A MutationObserver AS WELL. Delegation handles CLICKS on new cards; it does not PAINT
 * them. A search result rendered after the favourites load would show an empty heart for a
 * topic that is favourited. The observer repaints whatever appears, so no surface has to know
 * this module exists.
 *
 * ⚠ thaiear:auth FIRES ~25 TIMES on a real device (it is fired once per recorded play among
 * other things). The load is latched — an unlatched retry here would be one network request
 * per sentence heard, which is the exact shape of a bug already fixed twice on this codebase.
 */
(function () {
  'use strict';

  function T() { return window.ThaiEarTopics; }
  function A() { return window.ThaiEarAuth; }

  var loaded = false;      // the latch — see the ~25x note above
  var loading = false;

  function authReady() { var a = A(); return !!(a && a.isReady); }
  /* ⭐ FIRST-PAINT GUESS (2026-09-25, owner: the Favourites pills "jump as it loads in").
     auth.js is injected late by nav.js, so for the first ~0.5–1 s of every load getUser() is
     null. Until then this view painted "Sign in to keep a list…" and the grid only arrived
     after the session AND the favourites fetch resolved — the whole list popping in under the
     heading. The hearts on the band pages likewise appeared late, empty.
     ✅ Until auth.js has resolved, trust identity.js's synchronous guess PLUS the favourites
     mirror auth.js keeps in localStorage — but ONLY when that mirror was written for the same
     user the guess names (FAV_UID_KEY, written below after every confirmed load). The mirror
     is not cleared on sign-out, so without the uid check the next person to sign in on this
     browser would see the previous one's list flash up. Once auth is ready this returns null
     and the real answer rules, so a stale guess heals on the first auth event. */
  var FAV_UID_KEY = 'thaiear_favourites_uid';
  function earlyFavs() {
    if (authReady()) return null;
    try {
      var I = window.ThaiEarIdentity, g = I && I.guess && I.guess();
      var uid = g && g.state === 'in' && g.user && g.user.id;
      if (!uid || localStorage.getItem(FAV_UID_KEY) !== String(uid)) return null;
      var m = JSON.parse(localStorage.getItem('thaiear_favourites') || 'null');
      return (m && typeof m === 'object') ? m : null;
    } catch (_) { return null; }
  }
  function signedIn() {
    var a = A();
    if (a && a.getUser && a.getUser()) return true;
    return earlyFavs() !== null;
  }
  function peekFavs() {
    var a = A();
    if (a && a.favourites && (authReady() || !earlyFavs())) return a.favourites.peek();
    return earlyFavs() || {};
  }

  /* ── paint ──────────────────────────────────────────────────────────────────────────
     Hearts ship in the markup with `hidden` and are revealed here, never created. Creating
     them on demand would move the card's other contents on a late auth resolve; the markup
     is identical for every visitor and only its visibility is per-user, which is the same
     rule .topic-plays follows. */
  function paint(root) {
    var favs = peekFavs();
    var show = signedIn();
    var btns = (root || document).querySelectorAll('.topic-fav');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var card = btn.closest ? btn.closest('.topic-card') : null;
      var page = card && card.getAttribute('data-page');
      if (!page) continue;
      if (show) btn.removeAttribute('hidden'); else btn.setAttribute('hidden', '');
      var on = !!favs[page];
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', (on ? 'Remove ' : 'Add ') +
        (card.querySelector('.topic-name') || {}).textContent +
        (on ? ' from favourites' : ' to favourites'));
    }
    paintCount();
  }

  /* The Favourites tile on /topics carries a per-user count, so it ships EMPTY and is filled
     here — the same reason .topic-plays ships empty. A number baked into the generated page
     would be one visitor's count shown to everyone. */
  function paintCount() {
    var el = document.getElementById('tp-fav-count');
    if (!el) return;
    if (!signedIn()) { el.textContent = ''; return; }
    var n = liveFavourites().length;
    el.textContent = n === 1 ? '1 topic' : n + ' topics';
  }

  /* Favourited units, in GRID ORDER, split by ARM.
     Order comes from array position, which IS the display order in both arrays — so a
     favourites list re-sorts itself for free whenever the grid is re-ordered (as 93 units were
     on 2026-08-27) with nothing to maintain here.

     ⚠ BOTH ARRAYS. This walked `topics` alone until 2026-08-27, which was not merely
     incomplete: a favourited GRAMMAR unit would have hit the drop-unknown rule below and
     vanished silently — heart filled, nothing in the view, no error. Any future arm must be
     added here too, and that is what the ARMS list is for.

     ⚠ Unknown pages are DROPPED: a favourite whose unit has since been retired must not render
     as a broken card. This is the client-side referential integrity the table cannot enforce,
     because topics.js is a JS file and not a foreign key — favourites_schema.sql says the same
     from the other side. */
  function favUnits() {
    var t = T();
    var out = { grammar: [], topics: [] };
    if (!t) return out;
    var favs = peekFavs();
    var pick = function (arr) {
      return (arr || []).filter(function (u) { return u && u.page && favs[u.page]; });
    };
    out.grammar = pick(t.structures);
    out.topics = pick(t.topics);
    return out;
  }
  /* Flat, grammar first — the same order the view renders, so the tile count and the page
     can never disagree about what "a favourite" is. */
  function liveFavourites() {
    var g = favUnits();
    return g.grammar.concat(g.topics);
  }

  /* ── the heart ──────────────────────────────────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.topic-fav') : null;
    if (!btn) return;
    /* The card is a <div> with a stretched <a> overlay, so without these the tap would also
       follow the link. preventDefault alone is not enough — the anchor's ::after is a sibling
       overlay, so the click must not bubble to it either. */
    e.preventDefault();
    e.stopPropagation();
    var card = btn.closest('.topic-card');
    var page = card && card.getAttribute('data-page');
    var a = A();
    if (!page || !a || !a.favourites || !signedIn()) return;
    var on = a.favourites.toggle(page);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    paintCount();
    renderFavPage();          // no-op unless we are ON the favourites page
  });

  /* ── entering and leaving the favourites circuit ────────────────────────────────────────
     Opening a topic FROM the Favourites view puts the tab into favourites mode: prev/next on
     that topic then walk the favourites circle instead of its difficulty band, wrapping at both
     ends (topics.js sequenceFor / favNavRepoint).

     ⚠ sessionStorage, NOT a query param — see the long note in topics.js. The short version is
     that a `?from=fav` would make a second URL for identical content and break the property that
     a topic reached from Favourites is the SAME route, which is what guarantees play tracking,
     exclusions and dyn settings cannot diverge by how you got there.

     ⚠ THE MODE IS CLEARED BY OPENING A TOPIC FROM ANYWHERE ELSE — a band page, a search result,
     the grammar hub. All of those load this file, so one delegated handler covers them: leaving
     via a card writes the mode, arriving via a card anywhere else drops it. Prev/next INSIDE the
     circuit are .topic-nav-btn on a topic page, which does not load this file at all, so walking
     the circle correctly keeps the mode.

     The list is stored as PAGES in view order, never as unit objects: it is re-resolved against
     topics.js on every read, so a unit that is retired or renamed drops out of the circle instead
     of haunting it. */
  var FAV_NAV_KEY = 'thaiear_fav_nav';
  function setFavCircuit(pages) {
    try {
      if (pages && pages.length > 1) sessionStorage.setItem(FAV_NAV_KEY, JSON.stringify(pages));
      else sessionStorage.removeItem(FAV_NAV_KEY);      // one favourite is not a circle
    } catch (_) {}
  }
  function clearFavCircuit() { try { sessionStorage.removeItem(FAV_NAV_KEY); } catch (_) {} }

  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a.topic-card-link') : null;
    if (!link) return;
    if (document.getElementById('tp-fav-root')) {
      /* Leaving the Favourites view by opening a unit — arm the circuit in the order the view
         is showing, which is grammar first then topics, exactly what liveFavourites() returns. */
      setFavCircuit(liveFavourites().map(function (u) { return u.page; }));
    } else {
      clearFavCircuit();
    }
  }, true);   // capture: must run before anything that might stop propagation

  /* ── the Favourites page ────────────────────────────────────────────────────────────── */
  function renderFavPage() {
    var root = document.getElementById('tp-fav-root');
    if (!root) return;
    var t = T();
    if (!t) return;
    /* ⚠ EVERY branch goes through the ONE signature below, including the two empty states.
       An early return that skipped it would leave data-fav-sig describing content that is no
       longer on the page: remove your last favourite (empty state painted, signature still
       reading the old four) and re-add the same four, and the signature would match, the
       rebuild would be skipped, and the view would sit on "You haven't added any favourite
       topics yet" while the tile said 4. Distinct sentinels, so signed-out and empty-but-signed-
       in cannot collide either. */
    var groups = signedIn() ? favUnits() : null;
    var sig = groups
      ? groups.grammar.concat(groups.topics).map(function (u) { return u.page; }).join(',')
      : ' signed-out';
    if (root.getAttribute('data-fav-sig') === sig) return;
    root.setAttribute('data-fav-sig', sig);

    if (!groups) {
      root.innerHTML = '<p class="tp-fav-empty">Sign in to keep a list of favourite topics.</p>';
      return;
    }
    if (!groups.grammar.length && !groups.topics.length) {
      root.innerHTML = '<p class="tp-fav-empty">You haven’t added any favourite topics yet ' +
                       '— select the heart on any topic to add it here.</p>';
      return;
    }
    var html = '';
    /* The quiz strip goes IN THE MARKUP, exactly as gen_topics_pages.js emits it for the band
       cards — not inserted afterwards by topics-page.js. Inserted later, each card was built at
       109px and grew to 139px once the gate resolved (2026-09-25 measurement), and equalise()
       had already measured the short one. */
    var opts = { quiz: !!(t.quizPublic && t.quizPublic()) };

    /* GRAMMAR FIRST, under one heading of its own (owner, 2026-08-27). Not merged into the
       difficulty bands: every structure unit is `li1`, so merging would scatter them through
       the Lower-intermediate band interleaved with topics — "Dâi (ได้)" between two topic
       cards. They are a different KIND of unit, not a difficulty peer, and the go-live plan
       for /topics groups them the same way (STRUCTURES_SECTION_PLAN.md §12.4). One heading,
       no band subdivision, units in `structures` order. */
    if (groups.grammar.length) {
      html += '<h2 class="tp-fav-band">Grammar by Ear</h2><div class="topic-grid">';
      groups.grammar.forEach(function (u) { html += t.cardHtml(u, opts); });
      html += '</div>';
    }

    /* Then the topic arm, grouped by band, bands in grid order, units in grid order within
       each band. Only bands that actually have a favourite get a heading — an empty
       "Advanced" header above nothing would read as a loading failure. */
    var curBand = null, open = false;
    groups.topics.forEach(function (u) {
      var b = t.levelBounds(u.levels);
      var key = b[0] === b[1] ? b[0] : b[0] + '-' + b[1];
      if (key !== curBand) {
        if (open) html += '</div>';
        curBand = key;
        html += '<h2 class="tp-fav-band">' + t.levelText(u.levels) + '</h2>' +
                '<div class="topic-grid">';
        open = true;
      }
      html += t.cardHtml(u, opts);
    });
    if (open) html += '</div>';

    /* ⚠⚠ REBUILD ONLY WHEN THE SET ACTUALLY CHANGED (owner, 2026-08-27: "Thai listening time"
       flashed up and vanished, and the download tick never appeared at all).

       Both this module and topics-page.js listen for thaiear:auth, which fires ~25 times on a
       real device. topics-page.js registers FIRST (it is loaded first), so on every one of those
       events it decorated the cards — tick, entitlement pill, listening caption — and then this
       function replaced root.innerHTML and threw all of it away. The caption was visible for the
       microseconds between the two listeners; the tick, which arrives later still via the
       download manifest, never survived at all.

       That is the HYDRATE-NEVER-REBUILD rule this codebase already has for grids (index.html's
       ~20% "have to click twice" came from rebuilding under a finger). The signature makes the
       common case a no-op: the DOM is rebuilt only when the favourites set or its order really
       differs, which is a toggle, not an auth event. */
    root.innerHTML = html;
    paint(root);
    /* Cards that did not exist a moment ago carry none of the per-user decoration. Ask
       topics-page.js for it rather than re-implementing the tick here — same code path as a
       band card, so a favourites card cannot look different from the real thing. */
    var tp = window.ThaiEarTopicsPage;
    if (tp && tp.decorate) tp.decorate();
    equalise();
  }

  /* ⭐ ONE CARD HEIGHT FOR THE WHOLE PAGE (owner, 2026-09-23: the pills "are same as each other
     but DIFFERENT between sections"). Each section is its own .topic-grid, and grid-auto-rows:1fr
     equalises rows WITHIN a grid only -- see the long note in topics-page.css for why merging the
     sections into one grid is not available (the interleaved <h2> headings get stretched to a
     full card row).
     ⚠ RELEASE BEFORE MEASURING. The property is set to 0 first, or every measurement after the
     first returns the height THIS FUNCTION last imposed and the card can only ever grow.
     ⚠ AFTER decorate(), never before: the tick, the entitlement pill and the listening caption
     all change a card's height, and they arrive later than the markup.
     ⚠ Rounded UP. A fractional min-height against a fractional natural height leaves a 1px
     disagreement that reads as the exact bug this fixes. */
  function equalise() {
    var root = document.getElementById('tp-fav-root');
    if (!root) return;
    var cards = root.querySelectorAll('.topic-card');
    if (!cards.length) { root.style.removeProperty('--tp-fav-card-h'); return; }
    root.style.setProperty('--tp-fav-card-h', '0px');
    var max = 0, i;
    for (i = 0; i < cards.length; i++) {
      var h = cards[i].getBoundingClientRect().height;
      if (h > max) max = h;
    }
    if (max > 0) root.style.setProperty('--tp-fav-card-h', Math.ceil(max) + 'px');
  }

  /* Re-measure whenever the layout could have moved under us: a width change re-wraps the
     names, and the OS text size can be changed while the app is backgrounded -- the same two
     signals nav.js re-measures --te-ui on, and for the same reason. Debounced, because resize
     fires continuously and each pass forces two layouts.
     ⚠ ALSO on thaiear:auth: decorate() adds the entitlement pill and the listening caption on
     that event, and both change card height AFTER this has already run once. */
  var eqT = null;
  function requeueEqualise() { clearTimeout(eqT); eqT = setTimeout(equalise, 200); }
  try {
    window.addEventListener('resize', requeueEqualise);
    window.addEventListener('thaiear:auth', requeueEqualise);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) requeueEqualise();
    });
  } catch (_) {}

  /* ── wiring ─────────────────────────────────────────────────────────────────────────── */
  function refresh() {
    var a = A();
    if (!a || !a.favourites) return;
    if (!signedIn()) { loaded = false; paint(); renderFavPage(); return; }
    /* Signed in on the GUESS only (earlyFavs): paint from the mirror, but never call load()
       yet — with no real user it resolves an EMPTY set and caches it, and the latch below would
       then keep "no favourites yet" on screen after auth confirmed the real list. */
    if (!(a.getUser && a.getUser())) { paint(); renderFavPage(); return; }
    if (loaded || loading) { paint(); renderFavPage(); return; }
    loading = true;
    a.favourites.load().then(function () {
      loaded = true; loading = false;
      /* Record whose list the mirror now holds, for earlyFavs() on the next load. */
      try { var u = a.getUser && a.getUser(); if (u && u.id) localStorage.setItem(FAV_UID_KEY, String(u.id)); } catch (_) {}
      paint(); renderFavPage();
    }).catch(function () { loading = false; });
  }

  window.addEventListener('thaiear:auth', refresh);

  /* ── returning to a page that was never re-run ────────────────────────────────────────
     ⚠ iOS BACK-SWIPE DOES NOT RE-EXECUTE THE PAGE (owner, 2026-08-27). It restores the
     document from the back/forward cache: no DOMContentLoaded, no script re-run, no
     thaiear:auth. So favouriting on /topics-favourites and swiping back to /topics left the
     tile count frozen at whatever it said when the page was last painted — "0 topics" after
     adding four, and a manual reload was the only cure. The hearts on a band page had the
     same fault for the same reason.

     Two signals, because they cover different restores:
       pageshow + event.persisted  the bfcache restore itself (back-swipe, back button)
       visibilitychange            returning to a backgrounded tab or a re-foregrounded PWA,
                                   which on iOS is where the worker runs at all
     resync() first, always: the in-memory cache belongs to THIS document and is stale by
     construction after time spent in another one. The localStorage mirror is written on every
     toggle, so it is already right — the cache in front of it is the only thing that is not.
     Then unlatch so the next auth event re-reads the server; the repaint below is instant and
     does not wait for it. */
  function restored() {
    var a = A();
    if (a && a.favourites && a.favourites.resync) a.favourites.resync();
    loaded = false;                     // let the next refresh() re-read the account copy
    paint();
    renderFavPage();
    refresh();
  }
  window.addEventListener('pageshow', function (e) { if (e && e.persisted) restored(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') restored();
  });
  /* Repaint cards that appear after load (search results, and this page's own grid). Scoped to
     childList+subtree on body; the callback is cheap and only touches .topic-fav nodes. */
  if (window.MutationObserver) {
    var pending = null;
    new MutationObserver(function () {
      if (pending) return;                       // coalesce a burst of insertions into one paint
      pending = setTimeout(function () { pending = null; paint(); }, 0);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* Paint immediately from the local mirror so a returning visitor's hearts are filled on
     FIRST PAINT rather than after the network answers, then refresh once auth resolves. */
  paint();
  renderFavPage();
  refresh();

  window.ThaiEarFav = { paint: paint, list: liveFavourites, refresh: refresh };
})();
