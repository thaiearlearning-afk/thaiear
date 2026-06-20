/* ============================================================
   topics.js — SINGLE SOURCE OF TRUTH for the ThaiEar topic list.
   ------------------------------------------------------------
   ONE list, consumed by two places:
     • index.html  — renders the topic grid (cards, levels, lock).
     • every topic page — derives its eyebrow ("<level> · Topic X
       of N") from this list, so positions and the total update
       automatically. Add / remove / reorder a topic HERE ONLY —
       no per-page edits, exactly like nav.js owns the top bar.

   To use on a topic page:
     1. have  <div class="topic-eyebrow" id="topic-eyebrow"></div>
     2. load  <script src="topics.js" defer></script>
   This file finds the topic whose page == the current filename and
   fills that eyebrow. index.html instead reads window.ThaiEarTopics.

   ── LEVEL DISPLAY — difficulty is a RANGE, not a single badge ──
   Difficulty is a property of the SENTENCE, not the topic: each
   topic ramps its own sentences Beginner -> LI1 -> LI2, and most
   span two levels. So a topic's label shows a RANGE from its lowest
   level present (floor) to its highest (ceiling).
     Level order: beg < li1 < li2
     - floor == ceiling -> single label   e.g. "Beginner"
     - floor != ceiling -> range          e.g. "Beginner -> Lower int"
   NEVER collapse a two-level topic to "Mixed levels" — "Mixed" is the
   label that erased the intermediate tier. The eyebrow on each topic
   page uses this SAME text, so page and index card always agree.
   ============================================================ */

(function () {
  'use strict';

  // Array order = DISPLAY order. `id` is the FROZEN internal handle (spreadsheet #,
  // topic-{id}.html filename, liveTopics key). The card number shown is the 1-based
  // POSITION in this array, computed at render — never the id.
  //
  // access: "member" (any signed-in user) or "premium" (active subscription) gates a
  // topic; omitting it (or "free") = open. THIS ARRAY IS THE SINGLE SOURCE OF TRUTH for
  // the free/member/premium split — it drives the index cards AND the prev/next buttons.
  // You do NOT hand-lock the prev/next buttons: decorateTopicNav() (below) reads each
  // button's destination topic, looks up its access here, and locks/unlocks it to match
  // (gold padlock = premium → subscribe.html; purple padlock = member → join.html).
  // So setting a topic's access here locks its card, the "Next" on the previous topic,
  // and the "Prev" on the next topic all at once — and unrestricting it (back to free)
  // removes those padlocks automatically. NEVER edit lock state into the page HTML.
  // Backend enforcement of the audio is Phase 3 (server-side; this layer is UX only).
  //
  // The list (names / levels / counts) is built from the master Content Plan — the
  // single source of truth. Do NOT hand-maintain it or carry over the old taxonomy.
  const topics = [
    { id: 1,  name: "Greetings & farewells", levels: ["beg"], sentences: 23 },
    { id: 2,  name: "Getting to know you", levels: ["beg"], sentences: 29 },
    { id: 3,  name: "Communication survival", levels: ["beg"], sentences: 22 },
    { id: 4,  name: "Colours & descriptions", levels: ["beg"], sentences: 36, access: "premium" },
    { id: 5,  name: "Weather & seasons", levels: ["beg"], sentences: 26, access: "premium" },
    { id: 6,  name: "Time & numbers", levels: ["beg"], sentences: 26, access: "premium" },
    { id: 7,  name: "Days & months", levels: ["beg"], sentences: 37, access: "premium" },
    { id: 8,  name: "Family & relationships", levels: ["beg"], sentences: 38, access: "premium" },
    { id: 9,  name: "Food & drink", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Food & drink 1", sentences: 32, page: "topic-09a.html", access: "member" },
        { name: "Food & drink 2", sentences: 26, page: "topic-09b.html" } ] },
    { id: 10, name: "Home & daily routine", levels: ["beg","li1"], sentences: 38, access: "premium" },
    { id: 11, name: "Shopping & money (everyday)", levels: ["beg","li1"], sentences: 30, access: "premium" },
    { id: 12, name: "Getting around & transport", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Getting around & transport 1", sentences: 26, page: "topic-12a.html", access: "member" },
        { name: "Getting around & transport 2", sentences: 24, page: "topic-12b.html" } ] },
    { id: 37, name: "Asking for help & emergencies", levels: ["beg","li1"], sentences: 36, access: "premium" },
    { id: 13, name: "Body & health", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Body & health 1", sentences: 28, page: "topic-13a.html", access: "member" },
        { name: "Body & health 2", sentences: 25, page: "topic-13b.html" } ] },
    { id: 14, name: "Feelings & emotions", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Feelings & emotions 1", sentences: 23, page: "topic-14a.html", access: "member" },
        { name: "Feelings & emotions 2", sentences: 26, page: "topic-14b.html" } ] },
    { id: 15, name: "Hobbies & free time", levels: ["beg","li1"], sentences: 33, access: "premium" },
    { id: 16, name: "Social life & events", levels: ["beg","li1"], sentences: 36, access: "premium" },
    { id: 38, name: "Idioms", levels: ["beg","li1"], sentences: 27, access: "premium" },
    { id: 17, name: "Plans & future", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Plans & future 1", sentences: 28, page: "topic-17a.html", access: "member" },
        { name: "Plans & future 2", sentences: 16, page: "topic-17b.html" } ] },
    { id: 18, name: "Clothing & appearance", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Clothing & appearance 1", sentences: 22, page: "topic-18a.html", access: "member" },
        { name: "Clothing & appearance 2", sentences: 33, page: "topic-18b.html" } ] },
    { id: 19, name: "Cooking & recipes", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Cooking & recipes 1", sentences: 30, page: "topic-19a.html", access: "member" },
        { name: "Cooking & recipes 2", sentences: 27, page: "topic-19b.html" } ] },
    { id: 20, name: "Work & study", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Work & study 1", sentences: 24, page: "topic-20a.html", access: "member" },
        { name: "Work & study 2", sentences: 24, page: "topic-20b.html" },
        { name: "Work & study 3", sentences: 24, page: "topic-20c.html" },
        { name: "Work & study 4", sentences: 21, page: "topic-20d.html" } ] },
    { id: 21, name: "Education system", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Education system 1", sentences: 26, page: "topic-21a.html", access: "member" },
        { name: "Education system 2", sentences: 26, page: "topic-21b.html" } ] },
    { id: 22, name: "Food culture & eating out", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Food culture & eating out 1", sentences: 29, page: "topic-22a.html", access: "member" },
        { name: "Food culture & eating out 2", sentences: 22, page: "topic-22b.html" } ] },
    { id: 23, name: "Nature & animals", levels: ["li1","li2"], sentences: 30, access: "premium" },
    { id: 24, name: "Technology & communication", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 25, name: "Media & entertainment", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 26, name: "Sport & exercise", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 27, name: "Travel & tourism", levels: ["li1","li2"], sentences: 30, access: "premium" },
    { id: 28, name: "Banking & finance", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 29, name: "Community & society", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 30, name: "Agriculture & rural life", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 31, name: "Crime, law & justice", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 32, name: "Thai geography & regions", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 33, name: "Ceremonies & rites of passage", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 34, name: "Thai culture & customs", levels: ["li1","li2"], access: "premium", parts: [
        { sentences: 22, access: "member" }, { sentences: 28 } ] },
    { id: 35, name: "Buddhism", levels: ["li1","li2"], access: "premium", parts: [
        { sentences: 22, access: "member" }, { sentences: 28 } ] },
    { id: 36, name: "Romantic relationships & dating", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 39, name: "Tone twisters", levels: ["li1","li2"], sentences: 19, access: "premium" },
  ];

  // Keyed by FROZEN id (never display position). Add entries as topics go live.
  const liveTopics = { 1: 'topic-01.html', 2: 'topic-02.html', 3: 'topic-03.html', 4: 'topic-04.html', 5: 'topic-05.html', 6: 'topic-06.html', 7: 'topic-07.html', 8: 'topic-08.html', 10: 'topic-10.html', 11: 'topic-11.html', 15: 'topic-15.html', 16: 'topic-16.html', 37: 'topic-37.html', 38: 'topic-38.html', 39: 'topic-39.html' };

  // Level order + labels. Difficulty is a RANGE: a topic's label shows floor -> ceiling.
  const LEVEL_ORDER = ['beg', 'li1', 'li2'];
  const LEVEL_CLASS = { beg: 'badge-beg', li1: 'badge-li1', li2: 'badge-li2' };
  const LEVEL_FULL  = { beg: 'Beginner', li1: 'Lower intermediate', li2: 'Intermediate' };
  const LEVEL_SHORT = { beg: 'Beginner', li1: 'Lower int', li2: 'Intermediate' };

  function levelBounds(levels) {
    const present = LEVEL_ORDER.filter(l => levels.includes(l));
    return [present[0], present[present.length - 1]]; // [floor, ceiling]
  }
  // Plain text of the level label, e.g. "Beginner" or "Beginner → Lower int".
  // Both the index badge AND the topic-page eyebrow use this — so they always match.
  function levelText(levels) {
    const [floor, ceiling] = levelBounds(levels);
    return floor === ceiling
      ? LEVEL_FULL[floor]
      : `${LEVEL_SHORT[floor]} → ${LEVEL_SHORT[ceiling]}`;
  }
  function levelBadge(levels) {
    const [floor] = levelBounds(levels);
    return `<div class="level-badges"><span class="level-badge ${LEVEL_CLASS[floor]}">${levelText(levels)}</span></div>`;
  }
  // A filter tab matches when its level lies WITHIN the topic's [floor, ceiling] range.
  function matchesFilter(levels, filter) {
    if (filter === 'all') return true;
    const [floor, ceiling] = levelBounds(levels);
    const f = LEVEL_ORDER.indexOf(filter);
    return f >= LEVEL_ORDER.indexOf(floor) && f <= LEVEL_ORDER.indexOf(ceiling);
  }

  // Find the topic (and split part, if any) whose page == filename, plus its
  // 1-based display position. Returns null if the page isn't in the list.
  // Compare WITHOUT the .html extension — Cloudflare Pages serves clean URLs
  // (location is /topic-03, not /topic-03.html), so we must match either form.
  function bare(f) { return String(f || '').toLowerCase().replace(/\.html$/, ''); }
  function findByPage(file) {
    file = bare(file);
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      if (t.parts) {
        for (const part of t.parts) {
          if (part && part.page && bare(part.page) === file) {
            return { pos: i + 1, topic: t, part };
          }
        }
      } else if (bare(liveTopics[t.id]) === file) {
        return { pos: i + 1, topic: t, part: null };
      }
    }
    return null;
  }

  // ---- access tiers (free / member / premium) ----------------------------------
  // free (or undefined): open to all. member: any signed-in user. premium: an active
  // subscription. ENFORCE_SUBSCRIPTION gates the premium check: while false, premium
  // behaves like member (signed-in is enough) so nothing breaks before Stripe is live.
  // Flip it to true at the Phase-4 cutover, together with the server ENFORCE_SUBSCRIPTION
  // env on /api/audio. (Real enforcement is server-side; this only drives the UX.)
  const ENFORCE_SUBSCRIPTION = true;
  function authState() {
    const a = window.ThaiEarAuth || {};
    return {
      loggedIn: !!(a.getUser && a.getUser()),
      subscribed: !!(a.isSubscribed && a.isSubscribed()),
    };
  }
  // Effective access for a topic OR one of its split parts. A part may carry its OWN
  // `access` (e.g. a split topic whose first part is a free member taster while the rest
  // stay premium); when it doesn't, it inherits the topic's access. Returns
  // 'free' | 'member' | 'premium'. This is the single rule both the index cards and the
  // prev/next nav use, so a part's tier is consistent everywhere.
  function accessFor(topic, part) {
    if (part && part.access) return part.access;
    return (topic && topic.access) || 'free';
  }

  // Can the current visitor open this topic? (drives card links + prev/next unlock)
  function canAccess(access) {
    if (access === 'premium') {
      const s = authState();
      return ENFORCE_SUBSCRIPTION ? s.subscribed : s.loggedIn;
    }
    if (access === 'member') return authState().loggedIn;
    return true; // free / undefined
  }

  // Shared surface for index.html (grid render) and anything else that needs the data.
  window.ThaiEarTopics = {
    topics, liveTopics, total: topics.length,
    LEVEL_ORDER, LEVEL_CLASS, LEVEL_FULL, LEVEL_SHORT,
    levelBounds, levelText, levelBadge, matchesFilter, findByPage,
    canAccess, accessFor, authState, ENFORCE_SUBSCRIPTION
  };

  // ---- topic-page eyebrow: "<level> · Topic X of N", derived from the list ----
  function currentPage() {
    return (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  }
  function fillEyebrow() {
    const el = document.getElementById('topic-eyebrow');
    if (!el) return; // not a topic page (e.g. index) — nothing to fill
    const found = findByPage(currentPage());
    if (!found) return; // page not in the list yet — leave the element as-is
    el.textContent = `${levelText(found.topic.levels)} · Topic ${found.pos} of ${topics.length}`;
  }

  // ---- prev/next nav: derive each button's lock state from its target's access ----
  // The buttons are NOT hand-locked. For each one we resolve its real destination topic
  // (data-target, else legacy data-locked-href, else href), look up that topic's access
  // in the list, and lock/unlock to match — exactly like the index cards. canAccess()
  // respects login/subscription (+ ENFORCE_SUBSCRIPTION), so this also unlocks for
  // entitled visitors. Gold padlock = premium → subscribe.html; purple = member → join.html.
  const NAV_LOCK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  let navStylesInjected = false;
  function injectNavLockStyles() {
    if (navStylesInjected) return; navStylesInjected = true;
    const s = document.createElement('style');
    s.textContent =
      '.topic-nav-lock{display:inline-flex;align-items:center;vertical-align:-2px;margin-right:4px}' +
      '.topic-nav-lock svg{width:11px;height:11px}' +
      '.topic-nav-lock.premium{color:var(--gold-dark)}' +   // gold = subscription
      '.topic-nav-lock.member{color:var(--accent)}';        // purple = sign-in
    (document.head || document.documentElement).appendChild(s);
  }
  // The button's real destination page, stored once on data-target so it survives re-runs
  // (after locking, href points at join/subscribe, not the topic).
  function navTarget(a) {
    let t = a.getAttribute('data-target') || a.getAttribute('data-locked-href') || a.getAttribute('href');
    if (t && !a.getAttribute('data-target')) a.setAttribute('data-target', t);
    return t;
  }
  // access of the topic (or specific split PART) a button points INTO; null if it isn't a
  // topic page (skip it). Uses the part's own tier when it has one, so a "Next" pointing at
  // a premium second part locks gold even though the topic's first part is member.
  function navAccessFor(target) {
    const found = findByPage(target || '');
    return found ? accessFor(found.topic, found.part) : null;
  }
  function decorateNavBtn(a) {
    const target = navTarget(a);
    const access = navAccessFor(target);
    if (access === null) return; // not a topic link (e.g. back-to-index) — leave alone
    const nameEl = a.querySelector('.topic-nav-name');
    const oldIcon = a.querySelector('.topic-nav-lock'); if (oldIcon) oldIcon.remove();
    if (nameEl) nameEl.textContent = nameEl.textContent.replace(/^\s*🔒\s*/, ''); // drop legacy emoji
    if (access === 'free' || canAccess(access)) {            // open (or entitled) → unlocked
      a.setAttribute('href', target);
      a.removeAttribute('data-locked-href');
      return;
    }
    a.setAttribute('href', access === 'premium'              // locked → route to the right gate
      ? 'subscribe.html'
      : 'join.html?next=' + encodeURIComponent(target));
    a.setAttribute('data-locked-href', target);
    injectNavLockStyles();
    if (nameEl) {
      const span = document.createElement('span');
      span.className = 'topic-nav-lock ' + access;
      span.innerHTML = NAV_LOCK_SVG;
      nameEl.insertBefore(span, nameEl.firstChild);
    }
  }
  function decorateTopicNav() {
    document.querySelectorAll('a.topic-nav-btn').forEach(function (a) {
      if (!a.classList.contains('disabled')) decorateNavBtn(a);
    });
  }
  window.addEventListener('thaiear:auth', decorateTopicNav); // re-run when login resolves/changes

  // Click-time safety net (auth is always resolved by click; covers cached/late-auth pages):
  // if an entitled user clicks a button whose href is still the gate (decorate hadn't run yet),
  // send them to the real topic. Only intervenes when the href is actually stale, and never on
  // modified clicks — so normal links keep native behaviour (ctrl/cmd/middle-click → new tab).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest ? e.target.closest('a.topic-nav-btn[data-target]') : null;
    if (!a) return;
    const target = a.getAttribute('data-target');
    const access = navAccessFor(target);
    const entitled = access !== null && (access === 'free' || canAccess(access));
    if (entitled && a.getAttribute('href') !== target) { // stale gate href → correct it
      e.preventDefault();
      window.location.href = target;
    } // locked + not entitled → let the default (join/subscribe) href proceed
  });

  function init() { fillEyebrow(); decorateTopicNav(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
