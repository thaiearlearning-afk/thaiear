/* topics-page.js — the runtime layer for /topics and the five band pages.
 * 2026-08-21, homepage redesign.
 *
 * The cards are already in the DOM: gen_topics_pages.js ships them as static HTML so a
 * crawler sees all 93 topic links. This file only adds what CANNOT be baked into a page
 * every visitor shares — the tier filter, search, and per-user download state.
 *
 * ⚠⚠ HYDRATE, NEVER REBUILD. index.html's grid calls innerHTML on every thaiear:auth event
 * (auth.js legitimately fires ~5 times during startup), and a tap that lands during a
 * rebuild is destroyed along with the card it was on — the documented cause of the ~20%
 * "have to click twice" on the PWA. Every function here mutates cards in place. The one
 * exception is the SEARCH results grid, which has no static content to protect because
 * results are a query response, not page content.
 *
 * ⚠ No download BUTTONS here, by decision (owner, 2026-08-21): downloading happens inside a
 * topic or a playlist, and the card only ever REPORTS. Two visible states plus one
 * transient — tick = downloaded, dashed dot = update available, dots = downloading, nothing
 * = not downloaded or not entitled. Those are the shipped classes and the shipped CSS; the
 * only thing that changed is that the bare "not downloaded" circle is gone, because it was
 * the batch bar's SELECT control and the batch bar is going.
 */
(function () {
  'use strict';

  var T = window.ThaiEarTopics;
  if (!T) return;

  /* ── localhost: re-add the .html ────────────────────────────────────────────
     These pages link each other by CLEAN url (topics-beginner), because Cloudflare Pages
     308s the .html form and that redirect is cf-cache-status: DYNAMIC — an uncached origin
     round trip measured at 127-1315 ms per hop. But `python -m http.server`, which is how
     every local review session is run, has no clean-url resolution, so every one of those
     links 404s during review. Same trade-off topics.js's hrefFor() already makes for topic
     pages, and the same fix: production stays clean, localhost gets the extension back. */
  (function () {
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.)/.test(location.hostname)) return;
    var links = document.querySelectorAll('a[href^="topics"], a[href^="read"], a[href^="playlists"]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href');
      if (!h || /\.html/.test(h) || /^https?:/.test(h)) continue;
      var hash = '', k = h.indexOf('#');
      if (k > -1) { hash = h.slice(k); h = h.slice(0, k); }
      links[i].setAttribute('href', h + '.html' + hash);
    }
  })();

  /* ── tier filter (band pages) ──────────────────────────────────────────────
     Toggles a class on cards that already exist. Never re-renders. */
  var tiers = document.getElementById('tp-tiers');
  if (tiers) {
    tiers.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.filter-tab') : null;
      if (!btn) return;
      var want = btn.getAttribute('data-tier');
      var all = tiers.querySelectorAll('.filter-tab');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
      btn.classList.add('active');
      var cards = document.querySelectorAll('#tp-grid .topic-card');
      var shown = 0;
      for (var j = 0; j < cards.length; j++) {
        var hit = want === 'all' || cards[j].getAttribute('data-tier') === want;
        cards[j].classList.toggle('tp-off', !hit);
        if (hit) shown++;
      }
      var msg = document.getElementById('tp-none');
      if (!shown && !msg) {
        msg = document.createElement('p');
        msg.className = 'grid-msg'; msg.id = 'tp-none';
        msg.textContent = 'Nothing in this level at that tier.';
        document.getElementById('tp-grid').appendChild(msg);
      } else if (msg) {
        msg.style.display = shown ? 'none' : '';
      }
    });
  }

  /* ── the band pill row: put the CURRENT band where it can be seen ──────────────
     On a phone the five band names do not fit, so .tp-tabs is a horizontal scroller. It
     always started at the left, i.e. on "Beginner", whatever band you were actually on —
     so choosing "Lower Intermediate → Intermediate" showed you a highlighted pill far off
     to the right, and choosing the last band showed you no highlighted pill at all
     (owner, 2026-08-21).
     `inline:'start'` puts the active pill at the LEFT EDGE, which is also the right answer
     for the last band: the browser scrolls as far as it can, which lands at the rightmost
     point with the pill visible. `block:'nearest'` is what stops it scrolling the PAGE as
     well — without it, landing on a band page would jump you past the heading. */
  (function () {
    var on = document.querySelector('.tp-tab.on');
    var row = on && on.parentElement;
    if (!on || !row || !on.scrollIntoView) return;
    if (row.scrollWidth <= row.clientWidth + 1) return;   // not scrolling — nothing to do
    try { on.scrollIntoView({ inline: 'start', block: 'nearest' }); }
    catch (e) { row.scrollLeft = on.offsetLeft - row.offsetLeft; }
  })();

  /* ── entitlement: unlock the Premium pill for a subscriber ─────────────────
     The static pill is the SIGNED-OUT state, because that is what a crawler and a
     first-time visitor get. A subscriber's pill is swapped in place — the <a> and its
     href never change, so a tap in flight survives.
     ⚠ Read through T.canAccess(), never a cached boolean: that indirection is what lets
     ownersim.js simulate an expired subscription (see the note above canUseOffline in
     auth.js). */
  function applyEntitlement() {
    var cards = document.querySelectorAll('.topic-card.premium');
    for (var i = 0; i < cards.length; i++) {
      var pill = cards[i].querySelector('.topic-premium');
      if (!pill) continue;
      var open = T.canAccess('premium');
      if (open === pill.classList.contains('unlocked')) continue;   // already right
      pill.classList.toggle('unlocked', open);
      pill.innerHTML = open ? 'Premium' : (LOCK_SVG + 'Premium');
    }
  }
  var LOCK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

  /* ── download state ────────────────────────────────────────────────────────
     Reported, never actioned. dl-core owns the manifest; if it is not on the page (a
     plain browser tab does not load it) there is simply nothing to show, which is
     correct — download UI is app + installed-PWA only. */
  var TICK =
    '<span class="dl-badge" title="Downloaded" aria-label="Downloaded"><span class="dl-tick">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
    '</span></span>';
  var UPDATE =
    '<span class="dl-select dl-update" title="Update available" aria-label="Audio update available">' +
    '<span class="dl-dot"></span></span>';

  /* ⚠ THESE TWO PREDICATES ARE COPIED VERBATIM FROM index.html, NOT REWRITTEN.
     "Downloaded" is not "there are clips for this prefix" — it is an OWNERSHIP question,
     and getting that wrong is a bug class that has surfaced FOUR separate times on the
     playlist side (it now has its own harness, test_pl_dlstate.js). An entry must claim
     the 'topic' ref, and completeness comes from ThaiEarDL.hasNeeded(), with the legacy
     _EN.mp3 probe only as the pre-refs fallback. Do not "simplify" any of it.
     index.html keeps its copies until it is replaced by the new home page; THIS becomes
     the owner at that point. */
  function offlineManifest() { return window.ThaiEarDL.getManifest(); }

  function isDownloaded(prefix) {
    var e = prefix && offlineManifest()[prefix];
    if (!e) return false;
    var owns = !e.refs || e.refs.indexOf('topic') !== -1;
    if (!owns) return false;
    var complete = window.ThaiEarDL.hasNeeded(prefix);
    if (complete !== null) return complete;
    return (e.files || []).some(function (f) { return /_EN\.mp3$/.test(f); });
  }

  /* Conservative by design: no published version map, or no baseline recorded at download
     time, means NOT stale. Nagging on missing information is worse than a late prompt. */
  function avStale(prefix) {
    var AV = window.__teAudioVersions;
    if (!AV) return false;
    var e = offlineManifest()[prefix];
    if (!e || e.av == null) return false;
    var cur = AV[prefix];
    return cur != null && e.av !== cur;
  }

  function applyDownloadState() {
    /* dl-core is not on a plain browser tab, and that is correct — download UI is app +
       installed-PWA only, so there is simply nothing to report. */
    if (!window.ThaiEarDL || !window.ThaiEarDL.getManifest) return;
    var cards = document.querySelectorAll('.topic-card[data-audio]');
    for (var i = 0; i < cards.length; i++) {
      var prefix = cards[i].getAttribute('data-audio');
      if (!prefix) continue;
      var done = isDownloaded(prefix);
      var want = done ? (avStale(prefix) ? 'upd' : 'dl') : '';
      var slot = cards[i].querySelector('.topic-meta-row');
      if (!slot) continue;
      var mark = slot.querySelector('.dl-badge, .dl-select');
      if ((mark ? mark.getAttribute('data-state') : '') === want) continue;   // already right
      if (mark) mark.parentNode.removeChild(mark);
      var cap = slot.querySelector('.topic-sent-count');
      if (cap) cap.textContent = cap.textContent.split(' · ')[0];
      if (!want) continue;
      var holder = document.createElement('span');
      holder.innerHTML = want === 'dl' ? TICK : UPDATE;
      var node = holder.firstChild;
      node.setAttribute('data-state', want);
      slot.appendChild(node);
      if (cap) cap.textContent += ' · ' + (want === 'dl' ? 'downloaded' : 'update available');
    }
  }

  /* audio-versions.json is written by generate_topic_audio.py on every audio build. It is
     what lets a re-rendered topic show "update available" even though the page TEXT did not
     change — player.js's own content hash cannot see an audio-only re-render. */
  function loadAv() {
    if (window.__teAudioVersions) return Promise.resolve();
    return fetch('audio-versions.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) window.__teAudioVersions = j; })
      .catch(function () {});
  }

  /* ── listening time ────────────────────────────────────────────────────────
     The one line on a card that is about YOU rather than about the topic, and the reason it is
     green rather than grey (.topic-plays, carried over from the old index grid unchanged).

     Σ repetitions × Thai clip length over the topic's sentences — topics.js owns the sum and the
     wording so this page, pl-list.js and progress.html cannot drift apart. It needs TWO lookups
     that no other part of this page wants (topic-sentences.json, clip-durations.json), which is
     why both are fetched lazily below rather than linked in the head.

     ⚠ RUNTIME ONLY, like the download state. gen_topics_pages.js ships these cards as static HTML
     to every visitor and a cache serves one copy to all of them, so a per-user figure baked in
     would show the last person's number to the next.

     ⚠ HYDRATE, NEVER REBUILD (the rule at the top of this file). The caption is created once and
     thereafter only its textContent changes, so a tap in flight on the card is never destroyed by
     a repaint — and auth.js notifies on EVERY recorded play, so repaints are frequent. */
  function applyListenTime() {
    var A = window.ThaiEarAuth;
    var user = A && A.getUser && A.getUser();
    /* Read the merged map ONCE for the whole grid. getPlayReps() re-reads and re-merges
       localStorage on every call (auth.js plysMergeOf), and a band page has up to 33 cards. */
    var reps = (user && A.getPlayReps) ? A.getPlayReps() : null;
    var ready = reps && window.ThaiEarSentenceNums && window.ThaiEarClipDurations;
    var cards = document.querySelectorAll('.topic-card[data-page]');
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i].querySelector('.topic-plays');
      var cap = ready ? T.listenCaptionFor(cards[i].getAttribute('data-page'), reps) : '';
      /* ⚠ EMPTY IT, NEVER REMOVE IT. The slot is what keeps every card the same height;
         removing it made a row holding one captioned card ~16px taller than the rest
         (99px vs 83px, measured 2026-08-22). Same reason as HYDRATE-NEVER-REBUILD above:
         the node stays, only its text changes. */
      if (!cap) {                       // signed out, or a lookup still in flight
        if (el) el.textContent = '';
        continue;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'topic-plays';
        cards[i].appendChild(el);       // last child = the bottom line of the card
      }
      if (el.textContent !== cap) el.textContent = cap;
    }
  }

  /* The two lookups, fetched once and only on this page. Both are in sw.js PRECACHE, so offline
     they come straight from the cache; both resolve null rather than rejecting, and
     applyListenTime() simply renders nothing until they are in — a card never briefly claims
     "0 mins" to someone who has listened. */
  var listenInputsAsked = false;
  function loadListenInputs() {
    var A = window.ThaiEarAuth;
    if (!A || !A.getUser || !A.getUser()) return;      // signed out: the feature does not exist
    /* ⚠ ONCE PER PAGE LOAD, not once per refresh(). refresh() runs on every thaiear:auth event,
       and auth.js fires one on every recorded play — so without this guard a listening session
       would issue a fresh /api/plays fetch per sentence heard. The two topics.js loaders memoise
       themselves; loadPlays() only does so AFTER it has succeeded, which is exactly the window
       that matters. Called from refresh() rather than at the bottom of this file because the
       user is not known yet when this script runs. */
    if (listenInputsAsked) return;
    listenInputsAsked = true;
    if (A.loadPlays) A.loadPlays().then(applyListenTime).catch(function () {});
    if (T.loadSentenceNums) T.loadSentenceNums().then(applyListenTime);
    if (T.loadClipDurations) T.loadClipDurations().then(applyListenTime);
  }

  function refresh() { applyEntitlement(); applyDownloadState(); applyListenTime(); loadListenInputs(); }

  /* auth.js fires this several times during startup — cheap here, because every apply is
     a no-op once the DOM already says the right thing. */
  window.addEventListener('thaiear:auth', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  refresh();
  loadAv().then(applyDownloadState);

  /* ── search (landing page only) ────────────────────────────────────────────
     Ranking and matching live in topics.js (searchUnits) so the rules sit next to the
     keyword data; this is only the UI. Results REPLACE the band list rather than filtering
     it — a query cuts across bands, and grouping the hits back into five headings would
     fragment a short result list into five one-card groups. */
  var q = document.getElementById('tp-q');
  if (!q) return;
  var clear = document.getElementById('tp-clear');
  var bands = document.getElementById('tp-bands');
  var results = document.getElementById('tp-results');
  var grid = document.getElementById('tp-res-grid');
  var head = document.getElementById('tp-res-head');
  var timer = null;

  /* ⚠ DELEGATED to ThaiEarTopics.cardHtml() (2026-08-27). This was the second of three copies
     of the topic-card markup, and the reason unifying them mattered: a search result is a
     topic card on a DIFFERENT surface, so any control added to the band cards alone silently
     disappeared the moment the visitor typed. The favourites heart would have done exactly
     that. One definition now, in topics.js, shared with the generator.

     `eq: false` preserves this surface's existing output — search results have never carried
     the .te-eq now-playing bars. No `static`, because unlike a generated band page this runs
     in the visitor's own browser, so the "unlocked" premium pill is correct here. */
  function cardHtml(u) { return T.cardHtml(u, { eq: false }); }

  function run() {
    var v = q.value.trim();
    if (clear) clear.hidden = !v;
    var live = T.topics.filter(function (u) { return !!u.page; })
                       .map(function (u) { return { u: u }; });
    var hits = T.searchUnits ? T.searchUnits(v, live) : null;
    if (!hits) {                       // null = not searching
      results.hidden = true;
      bands.hidden = false;
      return;
    }
    bands.hidden = true;
    results.hidden = false;
    head.textContent = hits.length ? (hits.length + (hits.length === 1 ? ' topic' : ' topics'))
                                   : '';
    grid.innerHTML = hits.length
      ? hits.map(function (h) { return cardHtml(h.unit); }).join('')
      : '<p class="grid-msg">No topics match that. Try a Thai word, or an English one like ' +
        '&ldquo;hospital&rdquo;.</p>';
    applyDownloadState();
    applyListenTime();      // results are rebuilt from scratch, so their captions are too
  }
  q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 120); });
  q.addEventListener('search', run);          // the native clear (Esc / the X on some browsers)
  if (clear) clear.addEventListener('click', function () { q.value = ''; run(); q.focus(); });
})();
