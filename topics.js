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
  // access: "premium" gates a topic (Phase 2 UX). A premium card shows a 🔒 Premium
  // pill and links to subscribe.html instead of its topic page. Omitting access (or
  // "free") = open. THIS ARRAY IS THE SOURCE OF TRUTH for the free/premium split.
  // NOTE: the prev/next buttons on adjacent topic pages are static HTML — when you
  // change a topic's access, also update the buttons that point INTO it (e.g. topics
  // 3 & 4 premium → "Next" on topic-02.html and "Previous" on topic-05.html are
  // locked to subscribe.html). Backend enforcement of the audio is Phase 3.
  //
  // The list (names / levels / counts) is built from the master Content Plan — the
  // single source of truth. Do NOT hand-maintain it or carry over the old taxonomy.
  const topics = [
    { id: 1,  name: "Greetings & farewells", levels: ["beg"], sentences: 23 },
    { id: 2,  name: "Getting to know you", levels: ["beg"], sentences: 29 },
    { id: 3,  name: "Communication survival", levels: ["beg"], sentences: 22, access: "premium" },
    { id: 4,  name: "Colours & descriptions", levels: ["beg"], sentences: 36, access: "premium" },
    { id: 5,  name: "Weather & seasons", levels: ["beg"], sentences: 26 },
    { id: 6,  name: "Time, days, numbers & dates", levels: ["beg"], parts: [
        { name: "Time, days & schedules",   sentences: 23, page: "topic-06a.html" },
        { name: "Numbers, dates & counting", sentences: 29, page: "topic-06b.html" } ] },
    { id: 7,  name: "Family & relationships", levels: ["beg"], sentences: 38 },
    { id: 8,  name: "Food & drink", levels: ["beg","li1"], parts: [
        { name: "Food & drink 1", sentences: 32, page: "topic-08a.html" },
        { name: "Food & drink 2", sentences: 26, page: "topic-08b.html" } ] },
    { id: 9,  name: "Home & daily routine", levels: ["beg","li1"], sentences: 38 },
    { id: 10, name: "Shopping & money (everyday)", levels: ["beg","li1"], sentences: 30 },
    { id: 11, name: "Getting around & transport", levels: ["beg","li1"], sentences: 30 },
    { id: 36, name: "Asking for help & emergencies", levels: ["beg","li1"], sentences: 20 },
    { id: 12, name: "Body & health", levels: ["beg","li1"], parts: [20, 20] },
    { id: 13, name: "Feelings & emotions", levels: ["beg","li1"], sentences: 30 },
    { id: 14, name: "Hobbies & free time", levels: ["beg","li1"], sentences: 30 },
    { id: 15, name: "Social life & events", levels: ["beg","li1"], sentences: 25 },
    { id: 16, name: "Plans & future", levels: ["beg","li1"], sentences: 20 },
    { id: 17, name: "Clothing & appearance", levels: ["beg","li1"], sentences: 30 },
    { id: 18, name: "Cooking & recipes", levels: ["beg","li1"], sentences: 30 },
    { id: 19, name: "Work & study", levels: ["li1","li2"], parts: [20, 20] },
    { id: 20, name: "Education system", levels: ["li1","li2"], sentences: 25 },
    { id: 21, name: "Food culture & eating out", levels: ["li1","li2"], sentences: 30 },
    { id: 22, name: "Nature & animals", levels: ["li1","li2"], sentences: 30 },
    { id: 23, name: "Technology & communication", levels: ["li1","li2"], sentences: 25 },
    { id: 24, name: "Media & entertainment", levels: ["li1","li2"], sentences: 25 },
    { id: 25, name: "Sport & exercise", levels: ["li1","li2"], sentences: 25 },
    { id: 26, name: "Travel & tourism", levels: ["li1","li2"], sentences: 30 },
    { id: 27, name: "Banking & finance", levels: ["li1","li2"], sentences: 25 },
    { id: 28, name: "Community & society", levels: ["li1","li2"], sentences: 25 },
    { id: 29, name: "Agriculture & rural life", levels: ["li1","li2"], sentences: 25 },
    { id: 30, name: "Crime, law & justice", levels: ["li1","li2"], sentences: 25 },
    { id: 31, name: "Thai geography & regions", levels: ["li1","li2"], sentences: 25 },
    { id: 32, name: "Ceremonies & rites of passage", levels: ["li1","li2"], sentences: 25 },
    { id: 33, name: "Thai culture & customs", levels: ["li1","li2"], parts: [22, 28] },
    { id: 34, name: "Buddhism", levels: ["li1","li2"], parts: [22, 28] },
    { id: 35, name: "Romantic relationships & dating", levels: ["li1","li2"], sentences: 25 },
  ];

  // Keyed by FROZEN id (never display position). Add entries as topics go live.
  const liveTopics = { 1: 'topic-01.html', 2: 'topic-02.html', 3: 'topic-03.html', 4: 'topic-04.html', 5: 'topic-05.html', 7: 'topic-07.html', 9: 'topic-09.html' };

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
  function findByPage(file) {
    file = String(file || '').toLowerCase();
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      if (t.parts) {
        for (const part of t.parts) {
          if (part && part.page && part.page.toLowerCase() === file) {
            return { pos: i + 1, topic: t, part };
          }
        }
      } else if (String(liveTopics[t.id] || '').toLowerCase() === file) {
        return { pos: i + 1, topic: t, part: null };
      }
    }
    return null;
  }

  // Shared surface for index.html (grid render) and anything else that needs the data.
  window.ThaiEarTopics = {
    topics, liveTopics, total: topics.length,
    LEVEL_ORDER, LEVEL_CLASS, LEVEL_FULL, LEVEL_SHORT,
    levelBounds, levelText, levelBadge, matchesFilter, findByPage
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

  // ---- unlock premium prev/next buttons for entitled (logged-in) visitors ----
  // A premium neighbour's button carries href="subscribe.html" + data-locked-href="topic-NN.html"
  // and a 🔒 in its name. For a logged-in user, point it at the real page and drop the lock —
  // mirrors the index cards. (Phase 4: also require an active subscription.)
  function entitled() {
    try { return !!(window.ThaiEarAuth && window.ThaiEarAuth.getUser && window.ThaiEarAuth.getUser()); }
    catch (_) { return false; }
  }
  function unlockNav() {
    if (!entitled()) return;
    document.querySelectorAll('a.topic-nav-btn[data-locked-href]').forEach(function (a) {
      a.setAttribute('href', a.getAttribute('data-locked-href'));
      const n = a.querySelector('.topic-nav-name');
      if (n) n.textContent = n.textContent.replace(/^\s*🔒\s*/, ''); // strip leading 🔒
    });
  }
  window.addEventListener('thaiear:auth', unlockNav); // re-run when login state resolves/changes

  // Robust fallback: decide at CLICK time (auth is always resolved by the time a user clicks),
  // so a locked button works even if the auth event hadn't rewritten the href yet, or the page
  // was served from cache. Entitled → go to the real page; otherwise the default subscribe link.
  document.addEventListener('click', function (e) {
    const a = e.target.closest ? e.target.closest('a.topic-nav-btn[data-locked-href]') : null;
    if (a && entitled()) {
      e.preventDefault();
      window.location.href = a.getAttribute('data-locked-href');
    }
  });

  function init() { fillEyebrow(); unlockNav(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
