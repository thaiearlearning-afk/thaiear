/* ============================================================
   topics.js — SINGLE SOURCE OF TRUTH for the ThaiEar topic list.
   ------------------------------------------------------------
   ONE list, consumed by two places:
     • index.html  — renders the topic grid (cards, levels, lock).
     • every topic page — derives its eyebrow (the difficulty, e.g.
       "BEGINNER") from this list. Add / remove / reorder a topic HERE
       ONLY — no per-page edits, exactly like nav.js owns the top bar.

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
     Level order: beg < li1 < li2 < adv   (adv = Advanced: tertiary / niche)
     - floor == ceiling -> single label   e.g. "Beginner"
     - floor != ceiling -> range          e.g. "Beginner -> Lower intermediate"
                                                "Intermediate -> Advanced"
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
    { id: 1,  name: "Greetings & farewells", levels: ["beg"], sentences: 23, audio: "Greetings_BEG" },
    { id: 2,  name: "Getting to know you", levels: ["beg"], sentences: 29, audio: "GettingToKnow_BEG" },
    { id: 3,  name: "Communication survival", levels: ["beg"], sentences: 22, audio: "CommSurvival_BEG" },
    { id: 4,  name: "Colours & descriptions", levels: ["beg"], access: "premium", parts: [
        { name: "Colours & descriptions 1", sentences: 21, page: "topic-04a.html", access: "member", audio: "ColoursAndDescriptions_BEG" },
        { name: "Colours & descriptions 2", sentences: 21, page: "topic-04b.html", audio: "ColoursAndDescriptions2_BEG" } ] },
    { id: 5,  name: "Weather & seasons", levels: ["beg"], sentences: 30, access: "premium", audio: "Weather_BEG" },
    { id: 6,  name: "Time & numbers", levels: ["beg"], sentences: 30, access: "premium", audio: "Time_BEG" },
    { id: 7,  name: "Days & months", levels: ["beg"], sentences: 37, access: "premium", audio: "Dates_BEG" },
    { id: 8,  name: "Family & relationships", levels: ["beg"], sentences: 38, access: "premium", audio: "Family_BEG" },
    // ── new topics (not yet built): no page / audio / liveTopics entry → render as locked "coming soon" cards.
    { id: 40, name: "Animals", levels: ["beg"], sentences: 37, access: "premium", audio: "Animals_BEG" },
    { id: 41, name: "Places around town", levels: ["beg"], access: "premium", parts: [
        { name: "Places around town 1", sentences: 26, page: "topic-41a.html", access: "member", audio: "Places_BEG" },
        { name: "Places around town 2", sentences: 27, page: "topic-41b.html", audio: "Places2_BEG" } ] },
    { id: 9,  name: "Food & drink", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Food & drink 1", sentences: 39, page: "topic-09a.html", access: "member", audio: "Food_BEG" },
        { name: "Food & drink 2", sentences: 26, page: "topic-09b.html", audio: "Food_LI1" } ] },
    { id: 10, name: "Home & daily routine", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Home & daily routine 1", sentences: 24, page: "topic-10a.html", audio: "HomeAndDailyRoutine_BEG" },
        { name: "Home & daily routine 2", sentences: 23, page: "topic-10b.html", audio: "HomeAndDailyRoutine2_BEG" } ] },
    { id: 11, name: "Shopping & money", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Shopping & money 1", sentences: 22, page: "topic-11a.html", access: "member", audio: "ShoppingAndMoney_BEG" },
        { name: "Shopping & money 2", sentences: 29, page: "topic-11b.html", audio: "ShoppingAndMoney2_BEG" } ] },
    { id: 12, name: "Getting around & transport", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Getting around & transport 1", sentences: 26, page: "topic-12a.html", audio: "Transport_BEG" },
        { name: "Getting around & transport 2", sentences: 24, page: "topic-12b.html", audio: "Transport_LI1" } ] },
    { id: 37, name: "Asking for help & emergencies", levels: ["beg","li1"], sentences: 40, access: "premium", audio: "Emergency_BEG" },
    { id: 42, name: "Occupations", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Occupations 1", sentences: 30, page: "topic-42a.html", access: "member", audio: "Occupations_BEG" },
        { name: "Occupations 2", sentences: 30, page: "topic-42b.html", audio: "Occupations_LI1" } ] },
    { id: 13, name: "Body & health", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Body & health 1", sentences: 28, page: "topic-13a.html", audio: "Health_BEG" },
        { name: "Body & health 2", sentences: 25, page: "topic-13b.html", audio: "Health_LI1" } ] },
    { id: 14, name: "Feelings & emotions", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Feelings & emotions 1", sentences: 28, page: "topic-14a.html", access: "member", audio: "Feelings_BEG" },
        { name: "Feelings & emotions 2", sentences: 34, page: "topic-14b.html", audio: "Feelings_LI1" } ] },
    { id: 15, name: "Hobbies & free time", levels: ["beg","li1"], sentences: 37, access: "premium", audio: "Hobbies_BEG" },
    { id: 16, name: "Social life & events", levels: ["beg","li1"], sentences: 40, access: "premium", audio: "SocialLife_BEG" },
    { id: 38, name: "Idioms", levels: ["beg","li1"], sentences: 27, access: "premium", audio: "Idiom_BEG" },
    { id: 17, name: "Plans & future", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Plans & future 1", sentences: 28, page: "topic-17a.html", access: "member", audio: "Plans_BEG" },
        { name: "Plans & future 2", sentences: 16, page: "topic-17b.html", audio: "Plans_LI1" } ] },
    { id: 18, name: "Clothing & appearance", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Clothing & appearance 1", sentences: 22, page: "topic-18a.html", access: "member", audio: "Clothing_BEG" },
        { name: "Clothing & appearance 2", sentences: 33, page: "topic-18b.html", audio: "Appearance_LI1" } ] },
    { id: 19, name: "Cooking & recipes", levels: ["beg","li1"], access: "premium", parts: [
        { name: "Cooking & recipes 1", sentences: 31, page: "topic-19a.html", audio: "Cooking_BEG" },
        { name: "Cooking & recipes 2", sentences: 27, page: "topic-19b.html", audio: "Recipes_LI1" } ] },
    { id: 20, name: "Work & study", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Work & study 1", sentences: 24, page: "topic-20a.html", access: "member", audio: "Job_LI1" },
        { name: "Work & study 2", sentences: 24, page: "topic-20b.html", audio: "Workplace_LI1" },
        { name: "Work & study 3", sentences: 24, page: "topic-20c.html", audio: "Career_LI2" },
        { name: "Work & study 4", sentences: 21, page: "topic-20d.html", audio: "Study_LI1" } ] },
    { id: 21, name: "Education system", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Education system 1", sentences: 26, page: "topic-21a.html", access: "member", audio: "Schooling_LI1" },
        { name: "Education system 2", sentences: 26, page: "topic-21b.html", audio: "System_LI2" } ] },
    { id: 22, name: "Food culture & eating out", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Food culture & eating out 1", sentences: 29, page: "topic-22a.html", access: "member", audio: "FoodSocial_LI1" },
        { name: "Food culture & eating out 2", sentences: 22, page: "topic-22b.html", audio: "FoodCulture_LI2" } ] },
    { id: 23, name: "Nature, environment & conservation", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Nature, environment & conservation 1", sentences: 30, page: "topic-23a.html", access: "member", audio: "Nature_LI1" },
        { name: "Nature, environment & conservation 2", sentences: 34, page: "topic-23b.html", audio: "Nature_LI2" } ] },
    { id: 24, name: "Technology & communication", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 25, name: "Media & entertainment", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 26, name: "Sport & exercise", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Sport & exercise 1", sentences: 24, page: "topic-26a.html", access: "member", audio: "Sport_LI1" },
        { name: "Sport & exercise 2", sentences: 28, page: "topic-26b.html", audio: "Sport_LI2" } ] },
    { id: 27, name: "Travel & tourism", levels: ["li1","li2"], access: "premium", parts: [
        { name: "Travel & tourism 1", sentences: 25, page: "topic-27a.html", audio: "Travel_LI1" },
        { name: "Travel & tourism 2", sentences: 27, page: "topic-27b.html", audio: "Travel2_LI1" },
        { name: "Travel & tourism 3", sentences: 26, page: "topic-27c.html", audio: "Travel_LI2" } ] },
    { id: 28, name: "Banking & finance", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 29, name: "Community & society", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 30, name: "Agriculture & rural life", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 31, name: "Crime, law & justice", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 32, name: "Thai geography & regions", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 33, name: "Ceremonies & rites of passage", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 34, name: "Thai culture & customs", levels: ["li1","li2"], access: "premium", parts: [
        { sentences: 22, access: "member" }, { sentences: 28 } ] },
    { id: 35, name: "Buddhism", levels: ["li2","adv"], access: "premium", parts: [
        { name: "Buddhism 1", sentences: 20, page: "topic-35a.html", access: "member", audio: "Temple_LI1" },
        { name: "Buddhism 2", sentences: 18, page: "topic-35b.html", audio: "HolyDays_LI1" },
        { name: "Buddhism 3", sentences: 19, page: "topic-35c.html", audio: "Dhamma_LI2" },
        { name: "Buddhism 4", sentences: 23, page: "topic-35d.html", audio: "Meditation_LI2" },
        { name: "Buddhism 5", sentences: 30, page: "topic-35e.html", audio: "Monastic_LI2" } ] },
    { id: 36, name: "Romantic relationships & dating", levels: ["li1","li2"], sentences: 25, access: "premium" },
    { id: 39, name: "Tone twisters", levels: ["li1","li2"], sentences: 19, access: "premium", audio: "ToneTwister_LI1" },
    // ── parked ideas promoted to "coming soon" (TOPIC_IDEAS.md). Not yet built / scoped, so no
    //    sentence count yet; shown as a SINGLE list entry — any future a/b split only surfaces at
    //    build time. Fresh frozen IDs, appended (no renumber).
    { id: 43, name: "Muay Thai", levels: ["li1","li2"], access: "premium" },
    { id: 44, name: "Humour", levels: ["beg","li1"], access: "premium" },
  ];

  // Keyed by FROZEN id (never display position). Add entries as topics go live.
  const liveTopics = { 1: 'topic-01.html', 2: 'topic-02.html', 3: 'topic-03.html', 4: 'topic-04.html', 5: 'topic-05.html', 6: 'topic-06.html', 7: 'topic-07.html', 8: 'topic-08.html', 10: 'topic-10.html', 11: 'topic-11.html', 15: 'topic-15.html', 16: 'topic-16.html', 37: 'topic-37.html', 38: 'topic-38.html', 39: 'topic-39.html', 40: 'topic-40.html' };

  // Level order + labels. Difficulty is a RANGE: a topic's label shows floor -> ceiling.
  // `adv` (Advanced) is the tertiary tier — niche / highly specialised topics whose
  // sentences are a genuine step up (e.g. Buddhism). Added after li2.
  const LEVEL_ORDER = ['beg', 'li1', 'li2', 'adv'];
  const LEVEL_CLASS = { beg: 'badge-beg', li1: 'badge-li1', li2: 'badge-li2', adv: 'badge-adv' };
  const LEVEL_FULL  = { beg: 'Beginner', li1: 'Lower intermediate', li2: 'Intermediate', adv: 'Advanced' };
  // User-facing labels are NEVER abbreviated — "Lower int" is internal shorthand only. LEVEL_SHORT
  // therefore matches LEVEL_FULL (kept as a separate export for back-compat / future tweaks).
  const LEVEL_SHORT = { beg: 'Beginner', li1: 'Lower intermediate', li2: 'Intermediate', adv: 'Advanced' };

  function levelBounds(levels) {
    const present = LEVEL_ORDER.filter(l => levels.includes(l));
    return [present[0], present[present.length - 1]]; // [floor, ceiling]
  }
  // Plain text of the level label, e.g. "Beginner" or "Beginner → Lower intermediate".
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

  // ---- continuous-playback sequence (drives the player's autoplay + prev/next) -------
  // A "unit" is one playable page: a non-split topic, or one part of a split topic. The
  // player swaps between these (same audio element, no page reload) so playback survives a
  // locked screen. Built straight from this list so it stays a single source of truth.
  // A unit must have BOTH a page (it's built/live) and an `audio` prefix to be playable.
  function unitOf(topic, part, pos) {
    return {
      pos: pos,
      id: topic.id,
      page: part ? part.page : liveTopics[topic.id],
      name: part ? (part.name || topic.name) : topic.name,
      audio: part ? part.audio : topic.audio,
      access: accessFor(topic, part),
      levels: topic.levels
    };
  }
  // All live, playable units in DISPLAY order (split topics expanded into their parts).
  function liveSequence() {
    const seq = [];
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      if (t.parts) {
        t.parts.forEach(function (p) { if (p && p.page && p.audio) seq.push(unitOf(t, p, i + 1)); });
      } else if (liveTopics[t.id] && t.audio) {
        seq.push(unitOf(t, null, i + 1));
      }
    }
    return seq;
  }
  // The unit for a given page (null if the page isn't a live, playable unit).
  function pageUnit(page) {
    page = bare(page);
    const seq = liveSequence();
    for (let i = 0; i < seq.length; i++) if (bare(seq[i].page) === page) return seq[i];
    return null;
  }
  // Walk the sequence from `page` in `dir` (+1 next / -1 prev), wrapping last<->first,
  // skipping any unit the current visitor can't access. Returns the next accessible unit,
  // or the current page's unit if it's the only accessible one, or null if `page` isn't in
  // the sequence. canAccess() reads live auth, so this is correct per visitor tier.
  function nextAccessible(page, dir) {
    const seq = liveSequence();
    if (!seq.length) return null;
    const p = bare(page);
    let idx = -1;
    for (let i = 0; i < seq.length; i++) if (bare(seq[i].page) === p) { idx = i; break; }
    if (idx === -1) return null;
    const n = seq.length;
    for (let step = 1; step <= n; step++) {
      const j = ((idx + dir * step) % n + n) % n;
      // Offline, a downloaded topic counts as accessible (the in-page player can use its local audio).
      if (canAccess(seq[j].access) || (!navigator.onLine && offlineHas(seq[j].audio))) return seq[j];
    }
    return seq[idx]; // nothing else accessible — stay put
  }

  // Shared surface for index.html (grid render) and anything else that needs the data.
  window.ThaiEarTopics = {
    topics, liveTopics, total: topics.length,
    LEVEL_ORDER, LEVEL_CLASS, LEVEL_FULL, LEVEL_SHORT,
    levelBounds, levelText, levelBadge, matchesFilter, findByPage,
    canAccess, accessFor, authState, ENFORCE_SUBSCRIPTION,
    liveSequence, pageUnit, nextAccessible
  };

  // ---- topic-page eyebrow: the difficulty (e.g. "BEGINNER"), derived from the list ----
  function currentPage() {
    return (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  }
  function fillEyebrow() {
    const el = document.getElementById('topic-eyebrow');
    if (!el) return; // not a topic page (e.g. index) — nothing to fill
    const found = findByPage(currentPage());
    if (!found) return; // page not in the list yet — leave the element as-is
    // Difficulty only (CSS uppercases it, e.g. "BEGINNER"). The "Topic X of Y" counter was
    // dropped — the position number carried no learner value and just added visual noise.
    el.textContent = levelText(found.topic.levels);
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
      '.topic-nav-lock.premium{color:#B29234}' +            // premium text-gold (matches index pill)
      '.topic-nav-lock.member{color:var(--accent)}' +       // purple = sign-in
      // A prev/next button INTO a premium topic lights up light-gold on hover instead of purple
      // (keyed on the destination tier, set by decorateNavBtn → tracks topics.js access).
      '.topic-nav-btn.nav-to-premium:hover{background:#FBF5DC;border-color:var(--gold-dark)}';
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
  // Is a topic's audio prefix present in the offline-download manifest?
  function offlineHas(prefix) {
    if (!prefix) return false;
    try { return !!JSON.parse(localStorage.getItem('thaiear_offline') || '{}')[prefix]; } catch (_) { return false; }
  }
  // The audio prefix for a target page (to check the offline manifest).
  function navAudioFor(target) {
    const found = findByPage(target || '');
    if (!found) return null;
    return (found.part && found.part.audio) ? found.part.audio : found.topic.audio;
  }
  function decorateNavBtn(a) {
    const target = navTarget(a);
    const access = navAccessFor(target);
    if (access === null) return; // not a topic link (e.g. back-to-index) — leave alone
    // Tier-tint the hover regardless of lock state: a button INTO a premium topic lights up gold,
    // others purple. Reads the destination's access (above), so it follows topics.js automatically.
    injectNavLockStyles();
    a.classList.toggle('nav-to-premium', access === 'premium');
    const nameEl = a.querySelector('.topic-nav-name');
    const oldIcon = a.querySelector('.topic-nav-lock'); if (oldIcon) oldIcon.remove();
    if (nameEl) nameEl.textContent = nameEl.textContent.replace(/^\s*🔒\s*/, ''); // drop legacy emoji
    // Offline, a downloaded destination is reachable (its page is cached + audio is local).
    const downloadedOffline = !navigator.onLine && offlineHas(navAudioFor(target));
    if (access === 'free' || canAccess(access) || downloadedOffline) { // open / entitled / offline-download → unlocked
      a.setAttribute('href', target);
      a.removeAttribute('data-locked-href');
      return;
    }
    // Navigable-preview model: gated topics are still reachable by anyone — point prev/next at the
    // REAL page (never the paywall, and never steer to subscribe in the app). The padlock icon below
    // still signals the tier; the on-page gating (reveal/flag/play) enforces the actual restriction.
    a.setAttribute('href', target);
    a.removeAttribute('data-locked-href');
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
  window.addEventListener('online', decorateTopicNav);       // offline-download unlock follows connectivity
  window.addEventListener('offline', decorateTopicNav);

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
    } // gated buttons now also point at `target` (navigable preview) → default proceeds to the page
  });

  function init() { fillEyebrow(); decorateTopicNav(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
