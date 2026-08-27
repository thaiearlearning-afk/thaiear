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

  function signedIn() { var a = A(); return !!(a && a.getUser && a.getUser()); }

  /* ── paint ──────────────────────────────────────────────────────────────────────────
     Hearts ship in the markup with `hidden` and are revealed here, never created. Creating
     them on demand would move the card's other contents on a late auth resolve; the markup
     is identical for every visitor and only its visibility is per-user, which is the same
     rule .topic-plays follows. */
  function paint(root) {
    var a = A();
    var favs = (a && a.favourites) ? a.favourites.peek() : {};
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

  /* Favourited units, in GRID ORDER. Order comes from topics.js array position, which IS the
     display order — so a favourites list re-sorts itself for free whenever the grid is
     re-ordered (as 93 units were on 2026-08-27) with nothing to maintain here.
     ⚠ Unknown pages are DROPPED: a favourite whose topic has since been retired must not
     render as a broken card. This is the client-side referential integrity the table cannot
     enforce, because topics.js is a JS file and not a foreign key. */
  function liveFavourites() {
    var t = T(), a = A();
    if (!t || !a || !a.favourites) return [];
    var favs = a.favourites.peek();
    return t.topics.filter(function (u) { return u.page && favs[u.page]; });
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

  /* ── the Favourites page ────────────────────────────────────────────────────────────── */
  function renderFavPage() {
    var root = document.getElementById('tp-fav-root');
    if (!root) return;
    var t = T();
    if (!t) return;
    if (!signedIn()) {
      root.innerHTML = '<p class="tp-fav-empty">Sign in to keep a list of favourite topics.</p>';
      return;
    }
    var units = liveFavourites();
    if (!units.length) {
      root.innerHTML = '<p class="tp-fav-empty">You haven’t added any favourite topics yet ' +
                       '— select the heart on any topic to add it here.</p>';
      return;
    }
    /* Grouped by band, bands in grid order, units in grid order within each band. Only bands
       that actually have a favourite get a heading — an empty "Advanced" header above nothing
       would read as a loading failure. */
    var html = '', curBand = null, open = false;
    units.forEach(function (u) {
      var b = t.levelBounds(u.levels);
      var key = b[0] === b[1] ? b[0] : b[0] + '-' + b[1];
      if (key !== curBand) {
        if (open) html += '</div>';
        curBand = key;
        html += '<h2 class="tp-fav-band">' + t.levelText(u.levels) + '</h2>' +
                '<div class="topic-grid">';
        open = true;
      }
      html += t.cardHtml(u);
    });
    if (open) html += '</div>';
    root.innerHTML = html;
    paint(root);
  }

  /* ── wiring ─────────────────────────────────────────────────────────────────────────── */
  function refresh() {
    var a = A();
    if (!a || !a.favourites) return;
    if (!signedIn()) { loaded = false; paint(); renderFavPage(); return; }
    if (loaded || loading) { paint(); renderFavPage(); return; }
    loading = true;
    a.favourites.load().then(function () {
      loaded = true; loading = false;
      paint(); renderFavPage();
    }).catch(function () { loading = false; });
  }

  window.addEventListener('thaiear:auth', refresh);
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
