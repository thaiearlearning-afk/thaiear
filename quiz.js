/* quiz.js — the four quizzes. QUIZ_PROJECT.md. Phase 4: owner-gated, pilot units only.
   ──────────────────────────────────────────────────────────────────────────────────────────
   ⛔⛔ THE GOVERNING IDEA (§1): DERIVED, NEVER DUPLICATED. The question, the correct answer, the
   chip tray and the context sentence all come from window.ThaiEarTopic AT RUNTIME. Only the
   distractors, decoys and vocab list are authored, and they live in window.ThaiEarTopic.quiz.
   Edit a chip and the quiz changes with it in the same keystroke, because there is one copy.

   ⛔ THE QUIZ NUMBER IS A FROZEN ID, THE ORDER ON SCREEN IS NOT (§1).
        1 Listening comprehension · 2 Thai Builder · 3 Vocab Trainer · 4 Speak Thai
      Display order: Vocab · Listening · Builder · Speak — ascending difficulty. QUIZZES below is
      the ONE ordered array; every surface reads it. ⛔ Never sort by id, never renumber.

   ⛔ AUDIO AND LISTEN-CREDIT GO THROUGH window.ThaiEarQuizAudio (player.js), never direct. It
   owns the signed-URL mint cache, which is an entitlement boundary, and the offline-first read
   from thaiear-audio-dl, which is what makes a downloaded topic's quizzes work.
   ────────────────────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── the four quizzes, IN DISPLAY ORDER ────────────────────────────────────────────────── */
  /* ⭐ THE FOUR QUIZ ICONS. §9.0 called the V/L/B/S letters placeholders and the last
     undesigned thing in the arm; this closes it.
     ⚠ ONE VISUAL LANGUAGE, and it is the site's: 24-grid, stroked at 1.9, round caps and
     joins — the same construction as the sync glyph, the gear and the Read Thai icons. A filled
     set here would read as a different product from the rest of the sheet.
     ⚠ Each one says what the quiz ASKS, not what it is about: an ear taking in sound for
     listening, blocks being assembled for the Builder, a mouth speaking for Speak Thai, a book
     for the Vocab Trainer. */
  function icon(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"'
         + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var ICONS = {
    /* a book, half-open */
    vocab:  icon('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21.5z"/>'
          + '<path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v16h5.5a2.5 2.5 0 0 1 2.5 2.5z"/>'),
    /* an ear, with two waves coming in */
    listen: icon('<path d="M6 9a5 5 0 0 1 10 0c0 2.5-1.6 3.4-2.6 4.4-.8.8-1.1 1.6-1.2 2.6a2.6 2.6 0 0 1-5.2 0"/>'
          + '<path d="M9.4 9.2a1.9 1.9 0 0 1 3.2 1.3"/>'
          + '<path d="M19 7.5a6.5 6.5 0 0 1 0 9"/><path d="M21.6 4.5a10.5 10.5 0 0 1 0 15"/>'),
    /* three blocks being stacked */
    build:  icon('<rect x="3" y="14" width="7" height="7" rx="1.4"/>'
          + '<rect x="14" y="14" width="7" height="7" rx="1.4"/>'
          + '<rect x="8.5" y="3.5" width="7" height="7" rx="1.4"/>'),
    /* a mouth speaking, with sound leaving it */
    speak:  icon('<path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/>'
          + '<path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"/><path d="M12 17v4"/><path d="M8.5 21h7"/>')
  };

  var QUIZZES = [
    { id: 3, key: 'vocab', name: 'Vocab Trainer', ds: 'See a word, pick the Thai',
      icon: ICONS.vocab, step: 10, topicOnly: true },
    { id: 1, key: 'listen', name: 'Listening comprehension', ds: 'Hear Thai, pick the English',
      icon: ICONS.listen, step: 10 },
    { id: 2, key: 'build', name: 'Thai Builder', ds: 'See English, build the Thai',
      icon: ICONS.build, step: 5 },
    { id: 4, key: 'speak', name: 'Speak Thai', ds: 'See English, say it aloud, mark yourself',
      icon: ICONS.speak, step: 5 }
  ];
  function quizById(id) { for (var i = 0; i < QUIZZES.length; i++) if (QUIZZES[i].id === id) return QUIZZES[i]; return null; }

  /* ── §3A.1a structural exclusions ──────────────────────────────────────────────────────── */
  var MIN_CHIPS_Q2 = 3;        /* owner: "less than 3 chips is fine" — 15 sentences corpus-wide */
  /* ⚠ Quiz 1 has NO length rule. The owner kept the 2-chip idiom แกะดำ ("Black sheep") because it
     makes a perfectly good listening question. A sentence is out of quiz 1 exactly when no three
     plausible distractors could be written for it — so ABSENCE OF AUTHORED DATA *IS* THE
     EXCLUSION, and there is no second list to maintain. */

  /* ── §3A.6 head start caps. ⏳ PROVISIONAL: re-measure after the corpus-wide chip pass, which
     inflated the pilot's chip counts by ~11%. At that point cap 8 fires on 41.5% of sentences
     rather than 28.6%, which is no longer "long sentences". §11A decision B. */
  /* ⚠⚠ THE NUMBER IS WHAT THE LEARNER STILL BUILDS, SO A SMALLER NUMBER IS MORE HELP — which
     is why these are named and not numbered on screen. "6" looks like less than "10" and means
     the opposite. Owner, 2026-09-20: 6 Full, 8 Partial, 10 Slight, 0 Off.
     ⛔ 'on' IS A STORED KEY, NOT A LABEL. It is written to quiz_prefs and synced, so it cannot
     simply be renamed — a learner who set it before today has 'on' in their account and the
     radio would come back with nothing selected. It maps to 'partial', which is the level it
     always was (8). Keep the alias. */
  var HEADSTART = { full: 6, partial: 8, slight: 10, off: 0 };
  var HEADSTART_ALIAS = { on: 'partial' };
  function headKey(v) { return HEADSTART_ALIAS[v] || (HEADSTART[v] != null ? v : 'partial'); }

  var MAX_DECOYS = 4;          /* owner: "a cap of 4 decoys per sentence or its huge cognitive load" */

  /* ⚠⚠ FALLBACK ONLY. The real answer key is the PRECOMPUTED set in quiz.orders, written by
     gen_quiz_orders.js — §5.2 is explicit that storing it "removes all runtime cleverness: the
     check at answer time is a set membership test". This list exists solely so a page built
     before that generator ran still behaves sanely.
     ⛔ It is the SPEC'S list and nothing more — subject pronouns and polite/softening particles.
     An earlier draft here also had ก็ เลย สิ ล่ะ มัน, which the spec does not licence: over-
     accepting marks a WRONG answer RIGHT, a quieter fault than a false negative but still a
     fault, and it teaches something untrue just the same. */
  var DROPPABLE = { 'ครับ':1,'ค่ะ':1,'คะ':1,'นะ':1,'นะคะ':1,'นะครับ':1,'ค่ะนะ':1,'จ้ะ':1,'จ้า':1,
                    'ผม':1,'ฉัน':1,'ดิฉัน':1,'เรา':1 };

  var DEFAULTS = { len: 10, mode: 'even', hide: false, script: 'both', head: 'partial', nodecoy: false };

  /* ── state ─────────────────────────────────────────────────────────────────────────────── */
  var ov = null, sheet = null;
  var ctx = null;              /* { unit, origin, originHref, originLabel } */
  var run = null;              /* { q, prefs, items, i, right, answers, audio } */

  /* ── §9.3 the two site-wide display toggles ─────────────────────────────────────────────
     ✅ REUSE THE EXISTING localStorage KEYS so a learner's choice carries between a topic page
     and its quiz instead of being asked twice.
     ⛔ These are NOT quiz 2's three-way script setting (§5.1), and conflating them is the trap:
     the site toggle is two-state and cannot express "hide the Thai", which is the whole reason
     the three-way exists. The site toggle governs whether TRANSLITERATION IS SHOWN alongside;
     the three-way governs WHICH NOTATION the Builder tray and the written correction are in. */
  /* ⭐ QUIZ TEXT SIZE (owner, 2026-09-20). Five stops, applied as ONE scale factor on the sheet
     so every size and every gap moves together — the owner asked for the boxes and spacing to
     grow with the text, not just the glyphs.
     ⛔ SITE-WIDE, NOT PER QUIZ. It is a legibility preference like the Transliteration pill, not
     a difficulty setting, so it lives in localStorage beside the other two rather than in
     quiz_prefs. Nobody wants larger text in Vocab and smaller in Builder.
     ⚠⚠ AND IT IS APPLIED TO THE SHEET, NOT RE-RENDERED PER QUESTION. The owner's constraint was
     "without having a visible size change on render of the next question" — so the scale is a
     CSS custom property set once on the container; a new question inherits it already correct
     and never paints at one size then jumps to another. */
  var FONT_STOPS = [0.9, 1, 1.15, 1.3, 1.5];
  function fontScale() {
    var v = 1;
    try { v = parseFloat(localStorage.getItem('thaiear_quiz_fontscale')); } catch (_) {}
    return (FONT_STOPS.indexOf(v) >= 0) ? v : 1;
  }
  function setFontScale(v) {
    try { localStorage.setItem('thaiear_quiz_fontscale', String(v)); } catch (_) {}
    applyFontScale();
  }
  /* ⛔⛔ THE TEXT SIZE DOES NOT REACH THE PICKER (owner, 2026-09-20: "the font size selector
     has been affecting the main quizzes menu with the 4 quizzes - it doesnt need to do that,
     its predominantly just to help within the quiz itself to help read gloss chips").
     He is right, and it was also the cause of the picker overflowing: at 1.5 the four rows, the
     header and the mascot could not fit a phone screen, and the setting exists to make THAI
     legible, not to inflate a menu of four English buttons.
     ✅ It still applies on a quiz's own settings menu, so the stops give live feedback while
     you choose one — which is the only place other than a question where you would want it. */
  var scaleOff = false;
  function applyFontScale() {
    if (sheet) sheet.style.setProperty('--tq-scale', scaleOff ? '1' : String(fontScale()));
  }

  /* ⛔⛔ THE SITE TRANSLITERATION PILL DOES NOT REACH INSIDE THE QUIZ. It governs topic pages;
     in here the three-way script setting is the only control, on all four quizzes — see
     curScript(). translitOn()/setTranslit()/applyTranslit() and the .tq-tl-off class are all
     GONE, along with the CSS that hid .tlx/.o-tl/.tl, because a rule that hides a
     transliteration the learner just asked for is the exact fault this arm kept producing.
     ⚠ The history is worth keeping because the first two fixes were both partial. The pill was
     originally read at RENDER time, so it never reached an answered question (owner: "if i
     answer the question, then change the transliteration setting - it doesnt update until the
     next question ... interestingly modern thai font toggle works immediately" — that
     observation was the diagnosis: the font toggle is a class on <html>). Making it a class
     fixed the timing and created a worse bug, because it then hid `.tl` GLOBALLY, including on
     the Builder, whose three-way said to show it. Scoping the class with :not(.tq-threeway)
     fixed that and still left two different controls doing one job. The answer was to delete the
     control, not to scope it again. */
  /* ⚠ The overlay carries the unit's tier so its header can use the same ink as the entry
     block the learner just tapped — gold on a premium unit, accent otherwise. Without it the
     overlay looks like a different product from the block that opened it. */
  function applyTier() {
    var t = T();
    if (sheet) sheet.classList.toggle('premium', !!(t && t.tier === 'premium'));
  }

  /* ⭐⭐ THE THREE-WAY SCRIPT SETTING IS A CLASS TOO, for the same reason the site pill became
     one: the settings menu deliberately does not re-render the question, so anything baked in at
     render time cannot be reached. Owner: "when i change a setting in settings, it doesnt apply
     to the display until the next question ... font size and modern font apply immediately (as
     they ought to)."
     ⚠⚠ IT ALSO MARKS WHICH CONTROL OWNS THIS SCREEN, and that is the bug it fixes. §9.3 gives
     quizzes 2 and 4 the three-way and quizzes 1 and 3 the two-state site pill — exactly one
     control per surface. v571 made the site pill a class that hid `.tl` GLOBALLY, so a learner
     with the Builder's three-way on "Thai + transliteration" and the site pill off got no
     transliteration under the answer, from a control that is not even shown on that screen.
     ⚠ 'tl' (transliteration INSTEAD of Thai) still needs the next question: the tile's main text
     IS the Thai, so swapping it is a re-render, not a visibility change. both <-> thai are
     instant, which is the pair that actually gets toggled. */
  function thaiModern() {
    try { return localStorage.getItem('thaiear_thaifont') === 'modern'; } catch (_) { return false; }
  }
  function setThaiModern(on) {
    try { localStorage.setItem('thaiear_thaifont', on ? 'modern' : 'classic'); } catch (_) {}
    /* the same html class player.js uses, so the page behind the overlay follows too */
    try { document.documentElement.classList.toggle('te-thai-modern', !!on); } catch (_) {}
  }

  /* ── small helpers ─────────────────────────────────────────────────────────────────────── */
  function T() { return window.ThaiEarTopic || null; }
  function QD() { var t = T(); return (t && t.quiz) || {}; }
  function store() { return window.ThaiEarQuizStore || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function stripBars(s) { return String(s || '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sentByNum(n) {
    var ss = (T() || {}).sentences || [];
    for (var i = 0; i < ss.length; i++) if (String(ss[i].num) === String(n)) return ss[i];
    return null;
  }
  function chipsOf(s) {
    return (s && s.gloss || []).filter(function (g) { return g && g[0]; });
  }
  /* head gloss = the gloss minus its disambiguating parenthetical or quoted literal. Used for
     the §6.3 two-answer test. ⛔ Comparison only — §6.4 requires the FULL gloss to be rendered. */
  /* ⚠ The gloss WITHOUT its disambiguating parenthetical, case preserved — กับข้าว
     'food ("rice dishes")' → 'food'. Two words carrying the same one are §6.3 twins. */
  function bareGloss(g) {
    return String(g || '').replace(/\s*\(.*?\)|\s*"[^"]*"/g, '').trim();
  }
  function headGloss(g) {
    return bareGloss(g).toLowerCase().replace(/\.$/, '');
  }

  /* ── eligibility: what this quiz can ask about, net of BOTH kinds of exclusion ──────────── */
  function eligible(qid) {
    var t = T(); if (!t) return [];
    var qd = QD(), st = store();
    var ex = st ? st.excluded(ctx.unit, qid) : {};
    var out = [];

    if (qid === 3) {
      (qd.q3 || []).forEach(function (w) {
        if (!ex[w.th]) out.push({ key: w.th, word: w });
      });
      return out;
    }
    (t.sentences || []).forEach(function (s) {
      var n = String(s.num);
      if (ex[n]) return;
      if (qid === 1 && !(qd.q1 && qd.q1[n] && qd.q1[n].length >= 3)) return;   /* §3A.1a */
      if (qid === 2 && chipsOf(s).length < MIN_CHIPS_Q2) return;               /* §3A.1a */
      out.push({ key: n, sent: s });
    });
    return out;
  }

  /* ── §3A.3 selection: WHICH items a short run uses. Order is ALWAYS shuffled afterwards. ── */
  function pick(items, n, mode, qid) {
    var st = store();
    var stats = st ? st.itemStats(ctx.unit, qid) : {};
    var pool = items.slice();

    /* ⚠ Shuffle FIRST so ties inside a bucket are broken randomly. Without this every count is 0
       on run one, the sort is stable, and "even coverage" degenerates into "always items 1-10". */
    shuffle(pool);

    if (mode === 'random') { /* already shuffled */ }
    else if (mode === 'hard') {
      /* ⛔ Unseen always outranks seen — "hardest" is undefined with no history, and on run 1
         everything ties at 0/0. Among seen, Laplace-smoothed accuracy ascending: raw
         correct/seen pins an item to the top for ever on one unlucky first answer. */
      pool.sort(function (a, b) {
        var A = stats[a.key], B = stats[b.key];
        var sa = A ? A.seen : 0, sb = B ? B.seen : 0;
        if (!sa && !sb) return 0;
        if (!sa) return -1;
        if (!sb) return 1;
        return ((A.correct + 1) / (sa + 2)) - ((B.correct + 1) / (sb + 2));
      });
    } else {
      pool.sort(function (a, b) {                 /* even coverage: least-seen first */
        var A = stats[a.key], B = stats[b.key];
        return ((A ? A.seen : 0) - (B ? B.seen : 0));
      });
    }
    var take = (n === 'all' || n >= pool.length) ? pool.length : n;
    return shuffle(pool.slice(0, take));          /* ⛔ presentation order is always random */
  }

  /* ── prefs ─────────────────────────────────────────────────────────────────────────────── */
  function prefsFor(qid) {
    var st = store();
    var p = st ? st.prefs(ctx.unit, qid) : {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = (p && p[k] != null) ? p[k] : DEFAULTS[k]; });
    return out;
  }
  function savePrefs(qid, p) { var st = store(); if (st) st.setPrefs(ctx.unit, qid, p); }

  /* ── overlay plumbing ──────────────────────────────────────────────────────────────────── */
  function mount() {
    if (ov) return;
    ov = el('<div class="tq-overlay" role="dialog" aria-modal="true" hidden><div class="tq-sheet"></div></div>');
    sheet = ov.querySelector('.tq-sheet');
    /* ⚠ Backdrop click closes, but ONLY on the backdrop — a stray tap inside a tray must not
       destroy a half-built sentence. */
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov && !ov.hidden) close();
    });
    document.body.appendChild(ov);
  }
  /* ⭐⭐ THE OVERLAY TAKES A HISTORY ENTRY, SO THE BACK GESTURE CLOSES IT (owner, 2026-09-20).
     The quiz is a DOM overlay, not a navigation — so it pushed nothing, and an edge-swipe popped
     whatever brought the learner to the topic page in the first place. They opened a quiz and
     landed on the topics grid, two steps from where they were.
     ✅ Closing the overlay lands them exactly where "Back to the topic" does, for free: the topic
     page is still underneath at the scroll position they left it.
     ⚠ SAME URL. pushState with location.href adds an entry without changing the address, so a
     reload or a shared link still opens the topic page rather than a quiz that cannot be
     restored — the quiz has no URL state to restore from. */
  var pushedEntry = false;
  function pushEntry() {
    if (pushedEntry) return;
    try { history.pushState({ te_quiz: 1 }, '', location.href); pushedEntry = true; } catch (_) {}
  }
  /* ⚠ Only ever pops an entry we know is OURS. Without the state check, an explicit close on a
     history we did not push would send the learner back a page. */
  function dropEntry() {
    if (!pushedEntry) return;
    pushedEntry = false;
    try {
      if (history.state && history.state.te_quiz) history.back();
    } catch (_) {}
  }

  window.addEventListener('popstate', function () {
    if (!ov || ov.hidden) return;
    /* ⛔⛔ A SWIPE MID-RUN STILL WARNS. It is exactly the case the warning exists for — an
       unfinished run records nothing (§8.2) — and an edge-swipe is the easiest of all the exits
       to do by accident. popstate cannot be cancelled, so the entry is PUT BACK first and the
       question is asked; cancelling leaves the overlay open with its entry intact, and
       confirming drops it for real. */
    if (runInProgress()) {
      try { history.pushState({ te_quiz: 1 }, '', location.href); pushedEntry = true; } catch (_) {}
      confirmExit(function () { pushedEntry = false; doClose(); dropEntry0(); });
      return;
    }
    pushedEntry = false;
    doClose();
  });
  /* the confirmed-exit path has already cleared the flag, so it needs an unguarded pop */
  function dropEntry0() {
    try { if (history.state && history.state.te_quiz) history.back(); } catch (_) {}
  }

  function show() {
    mount(); applyFontScale();
    ov.hidden = false; document.documentElement.style.overflow = 'hidden';
    pushEntry();
  }

  /* ⭐ EXITING MID-QUIZ WARNS FIRST (owner, 2026-09-20). An unfinished run records nothing —
     §8.2 stores one best PERCENTAGE, and a part-finished run has no honest percentage to store
     (5 right out of 10 ASKED is not 50% when you only answered 6). So the warning is telling the
     truth about the data model, not nagging.
     ⛔ The site's own modal, never window.confirm — the same rule progress.html's reset follows.
     ⚠ It fires only DURING a run: closing the picker, the menu or the RESULTS screen has nothing
     to lose, and a confirm there would be pure friction. */
  function runInProgress() {
    return !!(run && run.items && run.i < run.items.length);
  }

  function confirmExit(then) {
    if (!runInProgress()) { then(); return; }
    var m = el('<div class="tq-confirm"><div class="tq-confirm-card" role="dialog" aria-modal="true">'
      + '<p><b>Leave this quiz?</b><br>You have answered ' + run.i + ' of ' + run.items.length
      + '. <strong>If you exit before finishing, your result will not be saved.</strong></p>'
      + '<div class="tq-confirm-actions">'
      + '<button type="button" class="tq-stay">Keep going</button>'
      + '<button type="button" class="tq-leave">Exit without saving</button>'
      + '</div></div></div>');
    ov.appendChild(m);
    m.querySelector('.tq-stay').onclick = function () { m.remove(); };
    m.querySelector('.tq-leave').onclick = function () { m.remove(); then(); };
    /* ⚠ A tap on the confirm's own backdrop cancels — the SAFE direction. Getting this the other
       way round would discard a run on a stray tap, which is the thing the warning exists to
       prevent. */
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
  }

  /* Tear the overlay down completely — only for a real departure from the quiz area. */
  function doClose() {
    stopAudio();
    if (ov) {
      var c = ov.querySelector('.tq-confirm');
      if (c) c.remove();
      ov.hidden = true;
    }
    document.documentElement.style.overflow = '';
    run = null;
  }

  /* ⭐ EXITING A QUIZ RETURNS TO THE QUIZ MENU, NOT THE PAGE (owner, 2026-09-20: "when i exit
     the quiz, I should return to the quiz menu, not the topic page").
     ⚠ It is the RIGHT default because leaving a quiz is nearly always "this one, not that one" —
     wrong length, wrong quiz, wrong moment — and dumping the learner back on the topic page makes
     them walk in through the front door again to try the next one. Leaving the quiz AREA is still
     one tap away, and it is the labelled one. */
  /* ⚠ MID-QUIZ, THE × GOES TO **THIS QUIZ'S** MENU, not the four-type picker (owner,
     2026-09-20: "maybe i want to change the decoy tile setting or whatever"). Leaving a run is
     nearly always "not like this" rather than "not this quiz" — wrong length, decoys on, head
     start too generous — and the screen that fixes all of those is one level up, not two.
     ⚠ The RESULTS screen's exit is deliberately different and still goes to the picker: there
     the run is finished, so the next question really is which quiz. */
  function backToQuizMenu() {
    stopAudio();
    var c = ov && ov.querySelector('.tq-confirm');
    if (c) c.remove();
    var qid = run && run.q && run.q.id;
    run = null;
    if (qid) openMenu(qid); else openPicker();
  }
  function close() { confirmExit(backToQuizMenu); }
  /* ⚠ A rotation or a window resize changes the row width, so the row count, so any height a
     question measured on render. One listener for the overlay, dispatched to whatever the
     current question registered — questions that measure nothing register nothing. */
  var relayoutTimer = null;
  window.addEventListener('resize', function () {
    if (!run || !run.relayout) return;
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () { if (run && run.relayout) run.relayout(); }, 120);
  });

  function render(html) {
    mount(); sheet.innerHTML = html;
    /* ⚠ Re-assert after every render: innerHTML wipes children, not the inline property, but a
       remount would lose it — and this is the one setting where a wrong value is visible. */
    applyFontScale();
    applyTier();
    sheet.scrollTop = 0; ov.scrollTop = 0;
  }
  /* ⛔ NO GLOBAL CLOSE BUTTON ON THESE SCREENS (owner, 2026-09-20). It did the wrong thing from
     every screen that is not a question: from the exclusions list, "I have not picked anything,
     get me out of here" means BACK TO THE MENU, not out of the quiz entirely — and that is
     exactly what the owner hit. Every non-question screen already has an explicit, labelled way
     onward, so a second unlabelled exit was only ambiguity.
     ⚠ The question screen keeps its own × (see bar()); that one routes through the warning. */
  /* ⚠ `hero` is for the PICKER only. head() is also used by the settings menu, the exclusions
     list and the results screen, and a tinted panel on every one of those would be four heavy
     bands in a row instead of a landing. The picker is the screen the learner arrives on. */
  /* ⚠ `icon` is a quiz's own glyph (owner, 2026-09-20: "for each quiz title within its menu
     and settings area ... to the left of the title e.g. Speak Thai can we have its associated
     symbol/icon?"). It is the SAME markup and the same 34px tinted chip as the picker row the
     learner just tapped, so the menu reads as that row opening rather than as a new screen.
     ⛔ It is passed IN, never looked up from the title: two quizzes could be renamed into each
     other's glyph by a string match and nothing would say so. */
  function head(title, sub, hero, icon) {
    var body = '<h3>' + esc(title) + '</h3>'
             + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '');
    if (icon) body = '<span class="tq-head-ic">' + icon + '</span>'
                   + '<div class="tq-head-tx">' + body + '</div>';
    return '<div class="tq-head' + (hero ? ' hero' : '') + (icon ? ' has-ic' : '') + '">'
         + body + '</div>';
  }
  function wireClose() { /* intentionally empty — see head() */ }

  /* ── audio ─────────────────────────────────────────────────────────────────────────────── */
  var au = null, auRevoke = null, auCredited = false, auNum = null;
  function stopAudio() {
    if (au) { try { au.pause(); } catch (_) {} }
    if (auRevoke) { try { auRevoke(); } catch (_) {} auRevoke = null; }
    au = null; auNum = null; auCredited = false;
  }
  /* Play a sentence's Thai. ⚠ Credit is gated on a DWELL (≥1.5s heard, or `ended`), never on
     play() — see the note on ThaiEarQuizAudio.credit. Under-counting is the safe direction. */
  /* ⭐⭐ A REAL PLAY/PAUSE CYCLE (owner, 2026-09-20). The button used to swap its triangle for a
     SQUARE — which reads as stop — and tapping it called playSentence() again, whose first act
     is stopAudio() followed by a fresh fetch and a restart. So the control showed one thing,
     promised another, and did a third.
     ⚠ THE LABEL MOVES WITH THE ICON. A pause icon above the words "Play the Thai" is the same
     fault in smaller print, so the button's own text is swapped and its original kept on the
     element — no second source of truth, and nothing to re-derive when the question changes. */
  function setPlayUI(btn, playing) {
    if (!btn) return;
    if (!btn.dataset.playLabel) {
      btn.dataset.playLabel = (btn.textContent || '').trim();
    }
    btn.classList.toggle('playing', !!playing);
    var tri = btn.querySelector('.tri');
    btn.textContent = playing ? 'Pause' : btn.dataset.playLabel;
    btn.insertBefore(tri || document.createElement('span'), btn.firstChild);
    if (tri) tri.className = 'tri';
  }

  /* The click handler for every audio button. ⚠ Resumes rather than restarts when it is the
     SAME sentence — restarting a clip someone paused two seconds in is its own small annoyance,
     and it would also re-mint the signed URL for no reason. */
  function toggleSentence(num, btn) {
    if (au && auNum === num) {
      if (au.paused) {
        au.play().then(function () { setPlayUI(btn, true); }).catch(function () {});
      } else {
        au.pause();
        setPlayUI(btn, false);
      }
      return;
    }
    playSentence(num, btn);
  }

  function playSentence(num, btn) {
    var QA = window.ThaiEarQuizAudio;
    if (!QA || !QA.clip) return Promise.resolve(false);
    stopAudio();
    auNum = num; auCredited = false;
    setPlayUI(btn, true);
    return QA.clip(num, 'TH').then(function (r) {
      au = new Audio(r.url); auRevoke = r.revoke;
      function creditOnce() {
        if (auCredited) return;
        auCredited = true;
        try { QA.credit(num, 1); } catch (_) {}
      }
      au.addEventListener('timeupdate', function () { if (au && au.currentTime >= 1.5) creditOnce(); });
      au.addEventListener('ended', function () {
        creditOnce();
        setPlayUI(btn, false);
      });
      /* ⚠ The element can be paused or resumed by something other than this button — a lock
         screen, a headset, the OS. Listening to the element rather than only to our own click
         is what keeps the icon honest in those cases. */
      au.addEventListener('pause', function () { if (au && !au.ended) setPlayUI(btn, false); });
      au.addEventListener('play', function () { setPlayUI(btn, true); });
      au.addEventListener('error', function () { setPlayUI(btn, false); });
      return au.play().then(function () { return true; }).catch(function () {
        setPlayUI(btn, false);
        return false;
      });
    }).catch(function () {
      setPlayUI(btn, false);
      return false;
    });
  }

  /* ── script mode (§5.1 three-way) ──────────────────────────────────────────────────────── */
  /* ⭐⭐ THE PROMPT THE PRODUCTION QUIZZES SHOW (§5.4).
     A published translation is written to READ well. The Thai Builder needs one that can be
     BUILT — one that cues every chip the learner has to place. Those are different jobs, and
     #1015 is the case that proved it: "Even if you're full, you shouldn't refuse the host's
     offer" is a good sentence and gives the learner no reason to reach for แล้ว, หาก, ชวน,
     กิน or ก็, five of its twelve chips.

     ⚠⚠ BOTH LINES, ALWAYS — not a subset someone had to grade. The owner flagged one rewrite as
     clunky and then named the real problem: "i also dont think you'll be able to judge which are
     clunky and which are okay." He is right; English register is not something this code can
     rank, and a detector that tried would be wrong without saying so. So where a rewrite exists,
     the quiz shows the buildable wording as the prompt and the published one underneath, smaller
     and labelled. Nobody has to decide which sentences deserve it.

     ⛔ THE SECOND LINE IS SECONDARY, NOT A SECOND PROMPT. It is what the sentence MEANS; the
     first line is how it is BUILT. If it were the same size the learner would work from whichever
     they read first, which is the ambiguity this is meant to remove. */
  function promptFor(s) {
    var o = (QD().enq || {})[String(s.num)];
    if (!o || !o.q) return '<p class="enq">' + esc(s.english) + '</p>';
    return '<p class="enq">' + esc(o.q) + '</p>'
      + (o.nat && o.nat !== o.q ? '<p class="enq-nat">' + esc(o.nat) + '</p>' : '');
  }

  /* ⭐⭐ ONE SCRIPT CONTROL FOR ALL FOUR QUIZZES (owner, 2026-09-20: "vocab quiz and
     listening comp quiz still have potential to show thai, transliterations or both - settings
     need to update for those as well. lets not create divergences between quizzes on the day we
     have made them").
     ⛔⛔ THIS REPLACES §9.3's SPLIT, which gave quizzes 2 and 4 the three-way and quizzes 1
     and 3 the site's two-state transliteration pill. The split was defensible as "one control
     per surface" and wrong as a whole: the same learner meets all four quizzes in one sitting,
     so two different controls over one thing is a divergence WITHIN the arm, not a tidy
     separation between halves of it. It also meant quizzes 1 and 3 simply could not say
     "transliteration only", which is the mode a learner who cannot yet read the script needs
     most.
     ⚠ The SITE pill no longer reaches inside the quiz sheet at all. It still governs topic
     pages; in here run.prefs.script is the only thing consulted, and it is per-quiz and
     persisted like every other quiz preference. */
  function curScript() {
    return (run && run.prefs && run.prefs.script) || 'both';
  }

  /* ⚠ Engines register a redraw for whatever they have put on screen that depends on the
     script mode, and the settings menu fires them all on the way out. COMPOSABLE rather than one
     slot, because a question and its reveal are drawn at different moments and both need it —
     a single assignment would have the reveal silently replace the question's. */
  function onRepaint(fn) {
    var prev = run.repaint;
    run.repaint = prev ? function () { prev(); fn(); } : fn;
  }

  function scriptBits(thai, translit, mode) {
    if (mode === 'thai') return { main: thai, sub: '' };
    if (mode === 'tl')   return { main: translit || thai, sub: '' };
    return { main: thai, sub: translit || '' };
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════
     THE PICKER
     ══════════════════════════════════════════════════════════════════════════════════════ */
  /* ── MY RESULTS (§3C) — the bottom of the picker ─────────────────────────────
     Owner, 2026-09-20: answered / correct / incorrect per quiz type, plus the best percentage,
     for EVERY unit that has results — grammar units and playlists included, not only this one.
     This unit's own rows float to the top under their own heading.

     ⛔ NO "TIMES TAKEN" COLUMN. The owner ruled it out and gave the reason: "that is meaningless
     actually when quizzes can be different length." A 5-question run and a 30-question run would
     count the same, so the number ranks nothing.

     ⚠ A UNIT WITH NO RESULTS IS NOT LISTED. 93 units of dashes is a table of contents, not a
     results page; this is about what you have actually done.

     ✅ Every number is a sum over the LOCAL mirror, so the panel is complete offline and becomes
     identical to the account copy once the outbox flushes. ⚠ That is also why it can briefly
     exceed what the server holds — the right direction: showing only what has synced would make
     a plane journey look like it never happened. */

  /* ⚠ A unit_key is not always a page. Topics and grammar units both resolve through topics.js
     (findByPage has covered both arms since 2026-08-27); a playlist key resolves to nothing and
     its raw form is a uuid nobody can read, so it gets a generic label rather than a wrong one. */
  function unitLabel(key) {
    var T = window.ThaiEarTopics;
    if (key === ctx.unit && ctx.unitName) return ctx.unitName;
    if (/^pl:/.test(key)) return 'A playlist';
    try {
      var f = T && T.findByPage && T.findByPage(key + '.html');
      if (f && f.unit && f.unit.name) return f.unit.name;
    } catch (_) {}
    return key;
  }
  /* ⚠ Grammar units and playlists have no Vocab Trainer (§1), so its absence there is correct
     and must not be drawn as a zero — a zero is a claim that you got them all wrong. */
  function unitHasVocab(key) { return !/^pl:/.test(key) && !/^grammar-/.test(key); }

  function resRow(q, r) {
    var wrong = Math.max(0, (r.answered || 0) - (r.correct || 0));
    return '<tr><th>' + esc(q.name) + '</th>'
      + '<td>' + (r.answered || 0) + '</td>'
      + '<td class="ok">' + (r.correct || 0) + '</td>'
      + '<td class="no">' + wrong + '</td>'
      + '<td class="best">' + (r.best == null ? '\u2014' : r.best + '%') + '</td></tr>';
  }

  function resTable(key, data) {
    var body = QUIZZES.filter(function (q) { return unitHasVocab(key) || q.id !== 3; })
      .map(function (q) {
        var r = data[q.id];
        return (r && (r.answered || r.best != null)) ? resRow(q, r) : '';
      }).join('');
    if (!body) return '';
    return '<table class="tq-res-t"><thead><tr><th></th><th>done</th><th>right</th>'
      + '<th>wrong</th><th>best</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function resultsPanel() {
    var st = store();
    if (!st || !st.resultsAll) return '';
    var all = st.resultsAll();
    var keys = Object.keys(all);
    if (!keys.length) return '';

    var here = all[ctx.unit] ? resTable(ctx.unit, all[ctx.unit]) : '';
    var others = keys.filter(function (k) { return k !== ctx.unit; }).sort()
      .map(function (k) {
        var t = resTable(k, all[k]);
        return t ? '<div class="tq-res-u"><p class="mlab">' + esc(unitLabel(k)) + '</p>' + t + '</div>' : '';
      }).join('');
    if (!here && !others) return '';

    return '<div class="tq-results">'
      + '<button type="button" class="tq-res-h" aria-expanded="false">My results'
      + '<span class="tq-res-cv" aria-hidden="true">\u25be</span></button>'
      + '<div class="tq-res-b" hidden>'
      + (here ? '<div class="tq-res-u"><p class="mlab">This unit</p>' + here + '</div>' : '')
      + (others ? '<p class="mlab tq-res-sep">Everywhere else</p>' + others : '')
      + '</div></div>';
  }

  /* ⭐ THE MASCOT, at the foot of the quiz menu. Same shape as the Muay Thai figure on /topics
     and the one on about.html: image, then a short line with an ellipsis that types itself.
     ⚠ THE ELLIPSIS ANIMATES **WIDTH**, NOT `content` — the Android app's webview cannot animate
     `content`, and steps(3, start) is what gives 1 -> 2 -> 3 dots. Copied deliberately from
     topics-page.css rather than reinvented; that file carries the same warning.
     ⚠ width AND height attributes are on the <img> so the browser reserves the box before the
     bytes arrive. The picker is a scrolling sheet and the block sits under the results panel, so
     a late-loading image with no intrinsic size would shove everything above it upward. */
  function mascot(file, w, h, line) {
    return '<div class="tq-mascot">'
      + '<img src="' + file + '" alt="" width="' + w + '" height="' + h + '" decoding="async">'
      + '<p class="tq-mascot-t">' + esc(line) + '<span class="dots"></span></p>'
      + '</div>';
  }
  function tigerBlock() { return mascot('tiger.png', 440, 389, 'Stay sharp'); }
  /* ⛔ THE ROOSTER IS NOT MOUNTED (owner, 2026-09-20: "since the my results is a dropdown, i
     dont think we need the rooster mascot there ... looks very busy so near the tiger").
     I had reasoned the two were never on screen together because the panel is collapsed — true
     of the default state and wrong about the one that matters: expanding the dropdown puts a
     second animal a few pixels below the first. The image stays in the repo; it is a mascot
     looking for a surface, not dead weight. */

  function wireResults() {
    var h = sheet.querySelector('.tq-res-h');
    if (!h) return;
    h.onclick = function () {
      var b = sheet.querySelector('.tq-res-b');
      var open = b.hidden;
      b.hidden = !open;
      h.setAttribute('aria-expanded', open ? 'true' : 'false');
      h.classList.toggle('open', open);
    };
  }

  function openPicker() {
    scaleOff = true;                 /* ↑ see applyFontScale: the picker is not scaled */
    var st = store();
    var rows = QUIZZES.map(function (q) {
      /* ⛔ Vocab Trainer is topic-only (§1). A grammar unit or playlist shows three, not four. */
      if (q.topicOnly && ctx.kind && ctx.kind !== 'topic') return '';
      var n = eligible(q.id).length;
      var best = st ? st.bestScore(ctx.unit, q.id) : null;
      return '<button type="button" data-q="' + q.id + '"' + (n ? '' : ' disabled') + '>'
           + '<span class="ic">' + q.icon + '</span>'
           + '<span><span class="nm">' + esc(q.name) + '</span>'
           + '<span class="ds">' + esc(n ? q.ds : 'nothing to ask yet') + '</span></span>'
           + '<span class="sc' + (best == null ? ' none' : '') + '">'
           + (best == null ? '—' : best + '%') + '</span></button>';
    }).join('');

    render('<div class="tq-fill">'
         + head('Test yourself', ctx.unitName || '', true)
         /* ⚠ THE GAPS ARE FLEXIBLE ELEMENTS, not margins — see .tq-gap in quiz.css. */
         + '<div class="tq-gap"></div>'
         + '<div class="qpick qpick-big">' + rows + '</div>'
         + '<div class="tq-gap"></div>'
         /* ⚠ ORDER: quizzes · tiger · the way out · My results (owner, 2026-09-20, who revised
            it: "i think back to topic button should be above the my results dropdown"). The tiger
            closes the four choices, and the exit stays ABOVE the dropdown because the dropdown
            EXPANDS — put the way out last and opening the results pushes it off the screen, which
            is the one control that must never need a scroll to reach. */
         + tigerBlock()
         + '<div class="tq-gap tq-gap-s"></div>'
         + '<div class="tq-minor"><button type="button" class="tq-return">&larr; '
         + esc(ctx.originLabel || 'Back') + '</button></div>'
         + resultsPanel() + '</div>');
    wireClose();
    sheet.querySelectorAll('.qpick button').forEach(function (b) {
      b.onclick = function () { openMenu(parseInt(b.dataset.q, 10)); };
    });
    sheet.querySelector('.tq-return').onclick = goBack;
    wireResults();
    show();
  }

  function goBack() {
    var href = ctx.originHref;
    /* ⚠ Return leaves the quiz as surely as the X does, so it takes the same warning. */
    if (runInProgress()) { confirmExit(function () { doClose(); dropEntry(); nav(); }); return; }
    doClose(); dropEntry(); nav();
    function nav() {
    /* ⛔ Not history.back() and not document.referrer (§3B.2): referrer is empty on a PWA cold
       start and wrong after a reload, and back() walks into the quiz just left. The call site
       passed its origin explicitly; falling back to the topic page is the owner's own fallback. */
      if (href && href !== location.pathname) location.href = href;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════
     THE PRE-QUIZ MENU (§3A)
     ══════════════════════════════════════════════════════════════════════════════════════ */
  function openMenu(qid) {
    scaleOff = false;
    var q = quizById(qid), p = prefsFor(qid);
    var items = eligible(qid);
    var n = items.length;

    /* §3A.1 — 10s for the recognition quizzes, 5s for the two production ones. An option at or
       above the available count is not shown.
       ⚠⚠ THE LADDER STOPS BEING LINEAR ONCE IT WOULD GET LONG. A unit's Vocab list is as big as
       its OWNED vocabulary: across the 93 units that runs 25–115 words, median 66, and topic-40
       tops out at 115. (Per unit — not per topic. 22a/22b only look small because their lists
       were hand-curated to ~20 for the pilot.) A plain ×10 ladder would then offer
       10·20·30·40·50·60·70·80·90·100·All, which is not a choice, it is a number pad.
       ⛔ NOT A SIDE-SCROLLING ROW. Horizontal scroll hides options off the edge with nothing to
       say they are there, and it is a fiddly target next to buttons that are themselves taps.
       The row already wraps, so nothing needs to be hidden — there just have to be few enough
       options to be a decision. Nobody chooses between 40 and 50 questions; they choose a quick
       one, a proper one, or the lot. So the ladder goes coarse as it climbs and is capped at
       five, with All always last and always honest about the true count. */
    var LADDER = (q.step === 5) ? [5, 10, 15, 20, 30, 50, 75]
                                : [10, 20, 30, 50, 75, 100];
    var steps = LADDER.filter(function (v) { return v < n; }).slice(0, 5);
    var segs = steps.map(function (v) {
      return '<button type="button" class="seg' + (p.len === v ? ' on' : '') + '" data-len="' + v + '">' + v + '</button>';
    }).join('') + '<button type="button" class="seg' + (p.len === 'all' || !steps.length ? ' on' : '')
      + '" data-len="all">All (' + n + ')</button>';

    /* §3A.6 — only shown where the unit actually has a sentence above the cap, otherwise it is a
       control with no possible effect, which is worse than its absence. */
    var maxChips = 0;
    if (qid === 2) items.forEach(function (it) { maxChips = Math.max(maxChips, chipsOf(it.sent).length); });
    /* ⚠ Against the SMALLEST cap — the most generous level. Testing the middle one hid the
       control on a unit where only 'Full' could ever have fired, which is a setting the learner
       could have used being withheld because a different setting could not. */
    var showHead = (qid === 2 && maxChips > HEADSTART.full);

    /* ⛔ NO SUBTITLE HERE (owner, 2026-09-20: "youve removed the sentences/ words available
       subtitle i never asked for"). It read "N sentences available" and its real cost was
       alignment: the icon chip centres against the whole text block, so a second line pushed the
       TITLE off the chip's centre line and the two stopped lining up. The count is not lost —
       the length row below says "All (N)". */
    var html = head(q.name, '', false, q.icon);

    html += '<div class="mgroup"><p class="mlab">How many questions</p><div class="segs">' + segs + '</div></div>';

    html += '<div class="mgroup"><p class="mlab">Question selection</p><div class="radios">'
      + radio('mode', 'even', p.mode, 'Even coverage', "favours ones you've seen least")
      + radio('mode', 'hard', p.mode, 'Hardest first', 'favours ones you get wrong')
      + radio('mode', 'rand', p.mode, 'Random', '')
      + '</div><p class="hint">Questions always appear in a random order. This only changes '
      + 'which ones a shorter quiz picks.</p></div>';

    if (qid === 1 || qid === 3) {
      html += '<div class="mgroup"><label class="checkrow"><input type="checkbox" class="c-hide"'
        + (p.hide ? ' checked' : '') + '><span>Hide the answers until I ask<br>'
        + '<span class="rd" style="color:var(--text-tertiary);font-size:12px">'
        + 'Attempt it in your head first. Does not affect your score.</span></span></label></div>';
    }

    /* ⛔ ALL FOUR QUIZZES, not just the two production ones — see curScript(). Every quiz puts
       Thai on the screen somewhere (quiz 1 and 4 in the reveal, quiz 3 in the options as well),
       so every quiz needs to be told how to write it. */
    html += '<div class="mgroup"><p class="mlab">Thai script</p><div class="radios">'
      + radio('script', 'both', p.script, 'Thai + transliteration', '')
      + radio('script', 'thai', p.script, 'Thai only', 'the hard mode')
      + radio('script', 'tl',   p.script, 'Transliteration only', "if you can't read the script yet")
      + '</div></div>';

    if (qid === 2) {
      html += '<div class="mgroup"><label class="checkrow"><input type="checkbox" class="c-nodecoy"'
        + (p.nodecoy ? ' checked' : '') + '><span>No decoy tiles<br>'
        + '<span class="rd" style="color:var(--text-tertiary);font-size:12px">'
        + 'Every tile belongs in the answer — just place them in the correct order.</span></span></label></div>';
      if (showHead) {
        var hk = headKey(p.head);
        html += '<div class="mgroup"><p class="mlab">Head start</p><div class="radios">'
          + radio('head', 'full',    hk, 'Full',    'you build the last ' + HEADSTART.full + ' chips')
          + radio('head', 'partial', hk, 'Partial', 'you build the last ' + HEADSTART.partial)
          + radio('head', 'slight',  hk, 'Slight',  'you build the last ' + HEADSTART.slight)
          + radio('head', 'off',     hk, 'Off',     'you build the whole sentence')
          + '</div></div>';
      }
    }

    html += fontGroup();

    /* ⭐ WITH THE OTHER SETTINGS, ABOVE THE EXCLUSIONS LINE (owner, 2026-09-20). It acts ON the
       settings above it, so below the start button it read as an afterthought — and it is not an
       exit, which is what everything in that footer is. */
    html += '<div class="mgroup"><button type="button" class="tq-all">'
      /* ⚠ THE SAME ICON THE DYN PLAYER USES FOR THE SAME JOB. Its sync button is literally
         "Apply these settings to all topics and playlists" (player.js ~8689), so the two
         controls must not look like different ideas. The old glyph was the single curved arrow,
         which is RESET rather than sync — and the owner read it exactly that way. */
      + '<svg class="tq-sync" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>'
      + '<path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'
      + '</svg><span class="tq-all-t">Use these settings for all ' + esc(q.name) + ' quizzes</span>'
      + '</button></div>';

    html += '<div class="mgroup"><button type="button" class="exline"><span>Excluded '
      + (qid === 3 ? 'words' : 'sentences') + '</span><b class="ex-n">'
      + Object.keys((store() ? store().excluded(ctx.unit, qid) : {})).length + '</b></button></div>';

    html += '<button type="button" class="startbtn">Start</button>'
      + '<div class="tq-minor">'
      + '<button type="button" class="tq-back">&larr; Other quizzes</button>'
      + '<button type="button" class="tq-return">&larr; ' + esc(ctx.originLabel || 'Back') + '</button>'
      + '</div>';

    render(html);
    wireClose();

    function readPrefs() {
      var cur = {
        len: p.len, mode: p.mode, hide: p.hide, script: p.script, head: p.head, nodecoy: p.nodecoy
      };
      var on = sheet.querySelector('.seg.on');
      cur.len = on ? (on.dataset.len === 'all' ? 'all' : parseInt(on.dataset.len, 10)) : 'all';
      var m = sheet.querySelector('input[name=mode]:checked'); if (m) cur.mode = m.value;
      var sc = sheet.querySelector('input[name=script]:checked'); if (sc) cur.script = sc.value;
      var hd = sheet.querySelector('input[name=head]:checked'); if (hd) cur.head = hd.value;
      var hi = sheet.querySelector('.c-hide'); if (hi) cur.hide = hi.checked;
      var nd = sheet.querySelector('.c-nodecoy'); if (nd) cur.nodecoy = nd.checked;
      return cur;
    }

    sheet.querySelectorAll('.seg').forEach(function (b) {
      b.onclick = function () {
        sheet.querySelectorAll('.seg').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
    });
    wireFontGroup();
    sheet.querySelector('.exline').onclick = function () { openExclusions(qid); };
    sheet.querySelector('.startbtn').onclick = function () {
      var cur = readPrefs(); savePrefs(qid, cur); start(qid, cur);
    };
    /* ⚠⚠ THE CONFIRMATION MUST EXPIRE WHEN IT STOPS BEING TRUE (owner, 2026-09-20: "when i click
       it, it changes forever. even if i change a setting, it doesn't change back"). It was
       latched and disabled, so after changing a setting the screen still claimed those settings
       were applied everywhere — a stale claim about the account, which is worse than no claim:
       the learner has no way to tell the button is now lying, and the only fix was to leave the
       menu. Now every control on this menu resets it. */
    var allBtn = sheet.querySelector('.tq-all');
    function resetAllBtn() {
      allBtn.classList.remove('done');
      allBtn.disabled = false;
      allBtn.querySelector('.tq-all-t').textContent =
        'Use these settings for all ' + q.name + ' quizzes';
    }
    allBtn.onclick = function () {
      var cur = readPrefs(); savePrefs(qid, cur);
      var st = store(); if (st) st.useEverywhere(ctx.unit, qid);
      allBtn.classList.add('done');
      allBtn.disabled = true;
      allBtn.querySelector('.tq-all-t').textContent =
        '\u2713 Applied to every ' + q.name + ' quiz';
    };
    /* every control that feeds readPrefs() un-latches it */
    sheet.querySelectorAll('.seg, .tq-fs, input[name=mode], input[name=script], input[name=head], '
                         + '.c-hide, .c-nodecoy, .c-tf').forEach(function (el) {
      el.addEventListener('click', resetAllBtn);
      el.addEventListener('change', resetAllBtn);
    });
    sheet.querySelector('.tq-back').onclick = openPicker;
    sheet.querySelector('.tq-return').onclick = goBack;
    show();
  }

  /* One renderer, used by the pre-quiz menu and the in-question settings — the owner asked for
     it in both, and two copies of a control is how they drift. */
  function fontGroup() {
    var cur = fontScale();
    return '<div class="mgroup"><p class="mlab">Text size</p><div class="tq-fsize">'
      + FONT_STOPS.map(function (v, i) {
          return '<button type="button" class="tq-fs' + (v === cur ? ' on' : '') + '"'
            + ' data-fs="' + v + '" style="font-size:' + (11 + i * 2.5) + 'px"'
            + ' aria-label="Text size ' + (i + 1) + ' of ' + FONT_STOPS.length + '">A</button>';
        }).join('')
      + '</div></div>';
  }
  function wireFontGroup() {
    sheet.querySelectorAll('.tq-fs').forEach(function (b) {
      b.onclick = function () {
        sheet.querySelectorAll('.tq-fs').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        setFontScale(parseFloat(b.dataset.fs));
      };
    });
  }

  function radio(name, val, cur, label, desc) {
    return '<label class="radio"><input type="radio" name="' + name + '" value="' + val + '"'
      + (cur === val ? ' checked' : '') + '><span class="rt">' + esc(label)
      + (desc ? ' <span class="rd">— ' + esc(desc) + '</span>' : '') + '</span></label>';
  }

  /* ── exclusions (§3A.2) — one list per quiz, re-includable with the same tap ────────────── */
  function openExclusions(qid) {
    scaleOff = false;
    var q = quizById(qid), st = store();
    var ex = st ? st.excluded(ctx.unit, qid) : {};
    var rows;
    if (qid === 3) {
      rows = (QD().q3 || []).map(function (w) {
        return '<label class="tq-exitem"><input type="checkbox" data-item="' + esc(w.th) + '"'
          + (ex[w.th] ? ' checked' : '') + '><span><span class="x-th">' + esc(w.th) + '</span>'
          + ((w.tl && prefsFor(qid).script !== 'thai') ? ' <span class="x-tl">' + esc(w.tl) + '</span>' : '')
          + '<span class="x-en">' + esc(w.en) + '</span></span></label>';
      }).join('');
    } else {
      rows = ((T() || {}).sentences || []).map(function (s) {
        return '<label class="tq-exitem"><input type="checkbox" data-item="' + s.num + '"'
          + (ex[String(s.num)] ? ' checked' : '') + '><span>' + esc(s.english)
          + '<span class="x-en">' + esc(stripBars(s.thai)) + '</span></span></label>';
      }).join('');
    }
    render(head('Exclude from ' + q.name,
                'Ticked items are skipped. This list is only for this quiz — it does not affect '
              + 'the player or the other quizzes.')
         + '<div class="tq-exlist">' + rows + '</div>'
         + '<button type="button" class="startbtn">&larr; Back to the ' + esc(q.name) + ' menu</button>');
    wireClose();
    sheet.querySelectorAll('.tq-exitem input').forEach(function (cb) {
      cb.onchange = function () {
        if (st) st.toggleExcluded(ctx.unit, qid, cb.dataset.item);
      };
    });
    sheet.querySelector('.startbtn').onclick = function () { openMenu(qid); };
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════
     RUNNING A QUIZ
     ══════════════════════════════════════════════════════════════════════════════════════ */
  function start(qid, prefs) {
    var items = pick(eligible(qid), prefs.len, prefs.mode, qid);
    if (!items.length) { openMenu(qid); return; }
    run = { q: quizById(qid), prefs: prefs, items: items, i: 0, right: 0, answers: [] };
    question();
  }

  function bar() {
    /* ⚠ The denominator can SHRINK mid-run now (an exclusion drops the current question), so
       guard the division rather than assume the length the run started with. */
    var pctW = run.items.length ? Math.round((run.i / run.items.length) * 100) : 100;
    /* ⚠ A QUESTION SCREEN NEEDS ITS OWN VISIBLE EXIT. The picker and the menu get one from
       head(), but a question is rendered from bar() — so until this was added the only ways out
       mid-quiz were Escape and a backdrop tap, neither of which is discoverable on a phone,
       where there is no Escape key at all. Found in the browser, not in the diff. */
    return '<div class="qbar">'
      + '<button class="qx" type="button" aria-label="Leave this quiz">&times;</button>'
      + '<span>' + (run.i + 1) + ' / ' + run.items.length + '</span>'
      + '<span class="qprog"><i style="width:' + pctW + '%"></i></span>'
      + '<button class="qopts" type="button" title="Quiz settings" aria-label="Quiz settings">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/>'
      + '<path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L14.9 3h-3.8l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.8 7.8 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.6h3.8l.4-2.6c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6z"/>'
      + '</svg></button></div>';
  }
  /* ⭐ THE EXCLUDE CONTROL LIVES ON THE QUESTION, NOT IN THE SETTINGS MENU (owner, 2026-09-20).
     Buried behind the gear it was invisible at the moment it is wanted — you decide you are done
     with a sentence WHILE you are looking at it, not after going hunting for a menu. It is the
     last thing in the sheet, so it is present before AND after the reveal and keeps the same
     place relative to the content.
     ⚠ It writes to THIS quiz's list only (§3A.2), so the label has to say so, or it reads as
     global — five separate lists per unit is the whole point of that section. */
  function foot() {
    return '<div class="tq-foot"><button type="button" class="tq-skip"></button></div>';
  }
  function paintSkip(b, on, answered) {
    b.classList.toggle('done', !!on);
    b.innerHTML = on
      ? '✓ Excluded from ' + esc(run.q.name)
        + '<span class="tq-skip-sub">from your next run — tap to undo</span>'
      : "Don't test me on this again"
        + '<span class="tq-skip-sub">'
        + (answered ? 'removes it from ' + esc(run.q.name) + ' only'
                    : 'skips it now, and drops it from ' + esc(run.q.name))
        + '</span>';
  }

  /* ⚠ "Has this question been answered yet?" is asked of the DOM, not of a flag the four
     engines would each have to remember to set. The reveal IS the answer state — it exists only
     once the question is marked — so the one place that already knows is the one place asked.
     ⛔ `.t-rev` alone will not do: the two-answer Vocab prompt ("Select 1 more") renders into
     the same container while the question is still open. */
  function answeredNow() {
    return !!(sheet && sheet.querySelector('.t-rev .reveal'));
  }

  /* Repaint the skip footer against the CURRENT answer state, without rebinding anything. */
  function refreshFoot() {
    var b = sheet && sheet.querySelector('.tq-skip');
    if (!b || !run || !run.items[run.i]) return;
    var st = store();
    paintSkip(b, st && st.isExcluded(ctx.unit, run.q.id, run.items[run.i].key), answeredNow());
  }

  function wireFoot() {
    var b = sheet.querySelector('.tq-skip');
    if (!b) return;
    var st = store(), key = run.items[run.i].key;
    var answered = answeredNow();
    paintSkip(b, st && st.isExcluded(ctx.unit, run.q.id, key), answered);
    b.onclick = function () {
      if (!st) return;
      var on = st.toggleExcluded(ctx.unit, run.q.id, key);

      /* ⭐⭐ EXCLUDING AN UNANSWERED QUESTION SKIPS IT NOW (owner, 2026-09-20, replacing §3A.5's
         "applies from the next run"): "you should auto navigate to the next question ... if doing
         a quiz of 10 and i remove 1 partway through, it becomes a quiz out of 9, that's fine."
         ⚠ NO REPLACEMENT IS DRAWN. The run simply gets one shorter — which the owner chose
         explicitly, and it is the honest arithmetic: the learner answered nine questions, so the
         score is out of nine. Pulling in a tenth would also mean the quiz you asked for and the
         quiz you sat were different lengths for a reason you never saw.
         ⛔ ONLY WHILE IT IS UNANSWERED. Once a question is marked, its result is already in
         run.answers and in run.right; removing the item would leave the numerator counting a
         question the denominator no longer does, and the score would read 8/7. An exclusion
         taken after the reveal therefore keeps the old behaviour and applies from the next run,
         which is what that button's own sub-label says in that state. */
      if (on && !answeredNow()) {
        run.items.splice(run.i, 1);
        stopAudio();
        /* ⚠ The index is NOT advanced: removing item i makes the next question item i. */
        return question();
      }
      paintSkip(b, on, answeredNow());
    };
  }

  function wireBar() {
    var o = sheet.querySelector('.qopts');
    if (o) o.onclick = inQuestionMenu;
    var x = sheet.querySelector('.qx');
    if (x) x.onclick = close;      /* close() routes through the exit warning */
  }

  function question() {
    scaleOff = false;
    if (run.i >= run.items.length) return results();
    /* ⚠ An engine may register a re-layout hook for the question it is drawing; it belongs to
       that question, so clear it before the next one or a stale closure runs against dead
       nodes and silently locks nothing. */
    run.relayout = null;
    run.repaint = null;
    var id = run.q.id;
    if (id === 1) qListen();
    else if (id === 2) qBuild();
    else if (id === 3) qVocab();
    else qSpeak();
  }

  function advance(itemKey, correct) {
    run.answers.push({ item: itemKey, correct: !!correct });
    if (correct) run.right++;
    run.i++;
    stopAudio();
    question();
  }

  /* ── Quiz 1 — Listening comprehension (§4.1) ───────────────────────────────────────────── */
  function qListen() {
    var it = run.items[run.i], s = it.sent;
    var opts = shuffle([{ t: s.english, ok: 1 }].concat(
      (QD().q1[String(s.num)] || []).slice(0, 3).map(function (t) { return { t: t, ok: 0 }; })));
    var hidden = run.prefs.hide;

    render(bar()
      + '<button class="playbtn" type="button"><span class="tri"></span>Play the Thai</button>'
      + (hidden ? '<button type="button" class="startbtn t-show">Show the options</button>' : '')
      + '<div class="t-opts"' + (hidden ? ' hidden' : '') + '>'
      + opts.map(function (o, i) { return '<button class="opt" type="button" data-i="' + i + '">' + esc(o.t) + '</button>'; }).join('')
      + '</div><div class="t-rev"></div>' + foot());
    wireBar(); wireFoot();

    var pb = sheet.querySelector('.playbtn');
    pb.onclick = function () { toggleSentence(s.num, pb); };
    /* ⚠ Auto-play once on arrival (§4.1). Hiding the options must not hide the QUESTION. */
    playSentence(s.num, pb);

    var sh = sheet.querySelector('.t-show');
    if (sh) sh.onclick = function () { sh.remove(); sheet.querySelector('.t-opts').hidden = false; };

    sheet.querySelectorAll('.opt').forEach(function (b) {
      b.onclick = function () {
        var o = opts[parseInt(b.dataset.i, 10)];
        sheet.querySelectorAll('.opt').forEach(function (x, i) {
          x.disabled = true;
          if (opts[i].ok) x.classList.add('right');
        });
        if (!o.ok) b.classList.add('wrong');
        reveal(s, o.ok);
      };
    });
  }

  /* shared reveal for the listening quiz: the Thai, its translit, and the chips */
  function reveal(s, ok) {
    var d = sheet.querySelector('.t-rev');
    function draw() {
      var b = scriptBits(stripBars(s.thai), stripBars(s.translit), curScript());
      d.innerHTML = '<div class="reveal"><p class="thaibig">' + esc(b.main) + '</p>'
        + (b.sub ? '<p class="tl">' + esc(b.sub) + '</p>' : '')
        + '<div class="chips">' + chipsOf(s).map(function (g) { return chipHtml(g); }).join('') + '</div>'
        + '<button class="nextbtn" type="button">' + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
      d.querySelector('.nextbtn').onclick = function () { advance(String(s.num), ok); };
    }
    draw();
    onRepaint(draw);
    showReveal(d);
  }

  /* ⚠ A reveal that lands below the fold reads as "nothing happened" — the owner hit exactly that
     shape on the two-answer question. Scroll it into view rather than trusting it to fit: the
     reveal's height varies with the sentence, the chip count and the text-size setting, so there
     is no layout that guarantees it. ⛔ Scroll the OVERLAY, not the page behind it. */
  function showReveal(d) {
    /* ⚠ THE ONE CHOKE POINT. All four engines call this the moment a question is marked, which
       makes it the only place that knows the answer state has changed — so the footer is
       repainted here rather than in four engines that would each have to remember. */
    refreshFoot();
    if (!d || !d.scrollIntoView) return;
    try { d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {
      try { d.scrollIntoView(false); } catch (_) {}
    }
  }

  function chipHtml(g, target) {
    /* ⚠ The chip follows the QUIZ's three-way, not the site pill — see curScript(). In 'tl'
       mode the chip's headword becomes the transliteration, which is the case a two-state pill
       could not express at all. */
    var b = scriptBits(g[0], g[2], curScript());
    var tl = b.sub ? '<span class="tlx">' + esc(b.sub) + '</span>' : '';
    /* ⚠ `target` marks the chip the question was ABOUT. Without it the learner has to find
       their word again in a row of a dozen chips, which is the opposite of what a breakdown is
       for. It is a highlight, not a different chip — same markup, one class. */
    var hit = (target && g[0] === target) ? ' is-target' : '';
    return '<span class="chip' + hit + '"><span class="th">' + esc(b.main) + '</span>'
      + '<span class="gl">' + esc(g[1]) + '</span>' + tl + '</span>';
  }

  /* ── Quiz 2 — Thai Builder (§5) ────────────────────────────────────────────────────────── */
  function qBuild() {
    var it = run.items[run.i], s = it.sent;
    var canon = chipsOf(s);
    var p = run.prefs;

    /* §3A.6 head start: a CAP, not a fixed prefix. A sentence at or below the cap gets none. */
    var cap = HEADSTART[headKey(p.head)] || 0;
    var lockN = (cap && canon.length > cap) ? (canon.length - cap) : 0;
    var locked = canon.slice(0, lockN);
    var buildable = canon.slice(lockN);

    var decoys = p.nodecoy ? [] : (QD().q2[String(s.num)] || []).slice(0, MAX_DECOYS);
    /* ⚠ A decoy is stored as [thai, translit, gloss] — the SAME SHAPE as a real chip, so the tray
       renderer cannot tell them apart and therefore cannot render them differently. That is the
       point: a decoy that looks different from a real tile is not a decoy. */
    var tray = shuffle(buildable.map(function (g) { return { g: g, real: 1 }; })
      .concat(decoys.map(function (d) {
        return { g: (typeof d === 'string') ? [d, '', ''] : [d[0], '', d[1]], real: 0 };
      })));

    var placed = [];   /* indexes into tray */

    render(bar()
      + promptFor(s)
      + (lockN ? '<p class="traylab">Start of the sentence (placed for you)</p>' : '')
      + '<div class="drop"></div>'
      + '<p class="traylab">Tap the tiles in order</p><div class="tray"></div>'
      + '<button class="nextbtn t-submit" type="button" disabled>Check</button>'
      + '<div class="t-rev"></div>' + foot());
    wireBar(); wireFoot();

    var dropEl = sheet.querySelector('.drop'), trayEl = sheet.querySelector('.tray');
    var submit = sheet.querySelector('.t-submit');

    function tileHtml(g, cls) {
      var b = scriptBits(g[0], g[2], p.script);
      return '<span class="tile ' + cls + '">' + esc(b.main)
        + (b.sub ? '<span class="tt">' + esc(b.sub) + '</span>' : '') + '</span>';
    }
    function paint() {
      /* ⛔ The answer box must not reveal how many positions remain — no empty numbered slots. */
      dropEl.innerHTML = locked.map(function (g) { return tileHtml(g, 'lock'); }).join('')
        + placed.map(function (ti) {
            /* ⚠⚠ A PLACED CHIP KEEPS ITS TRANSLITERATION. It used to render as the Thai alone,
               so the moment a chip entered the answer box the reading you were working from
               vanished — worst for exactly the learner who turned it on. The CSS had always
               anticipated this (.tile.in .tt is styled white against the accent fill); only the
               markup was missing. Same shape as the tray so the two cannot drift. */
            var b = scriptBits(tray[ti].g[0], tray[ti].g[2], p.script);
            return '<span class="tile in" data-p="' + ti + '">' + esc(b.main)
              + (p.script === 'both' && tray[ti].g[2]
                  ? '<span class="tt">' + esc(tray[ti].g[2]) + '</span>' : '') + '</span>';
          }).join('');
      dropEl.classList.toggle('filled', placed.length > 0);
      /* ⭐⭐ A TRAY CHIP KEEPS ITS OWN SLOT (owner, 2026-09-20: "rather than they keep sliding
         left as i select gloss chips, they stay in their positions, and if i unselect a gloss
         chip it returns to its original holding position").
         A taken chip used to render as nothing, so every chip after it shifted left and the
         whole tray re-flowed on every single tap. That makes the tray a moving target: you look
         away to place one chip and the one you were going to take next is somewhere else — and
         taking a chip back out reshuffled everything again, so there was no stable picture of
         what was left.
         ⚠⚠ THE SLOT IS THE SAME TILE, HIDDEN — not an empty box. Its width comes from its own
         Thai, so nothing else can reserve the right amount of room; an empty placeholder would
         have to guess, and would be wrong for every chip. `visibility: hidden` keeps the box and
         drops the ink.
         ✅ It also makes the tray's height constant by construction, which is the same fault the
         answer box needs a measured lock for — here the layout simply never changes. */
      trayEl.innerHTML = tray.map(function (t, i) {
        var taken = placed.indexOf(i) >= 0;
        return '<span class="tile' + (taken ? ' slot' : '') + '"'
          + (taken ? ' aria-hidden="true"' : ' data-t="' + i + '"') + '>'
          + esc(scriptBits(t.g[0], t.g[2], p.script).main)
          + (p.script === 'both' && t.g[2] ? '<span class="tt">' + esc(t.g[2]) + '</span>' : '') + '</span>';
      }).join('');
      submit.disabled = placed.length === 0;
      trayEl.querySelectorAll('[data-t]').forEach(function (n) {
        n.onclick = function () {
          if (dragMoved) { dragMoved = false; return; }
          placed.push(parseInt(n.dataset.t, 10)); paint();
        };
        wireDrag(n, 'tray');
      });
      dropEl.querySelectorAll('[data-p]').forEach(function (n) {
        n.onclick = function () {
          if (dragMoved) { dragMoved = false; return; }
          var ti = parseInt(n.dataset.p, 10);
          placed.splice(placed.indexOf(ti), 1); paint();
        };
        wireDrag(n, 'drop');
      });
    }

    /* ═════════════════════════════════════════════════════════════════════════════════════
       DRAGGING (owner, 2026-09-20)
       ═════════════════════════════════════════════════════════════════════════════════════
       ⛔ POINTER EVENTS, NOT HTML5 DRAG AND DROP. draggable="true" / dragstart does not fire on
       touch at all, so the whole feature would work on the desktop and silently not exist on the
       phone — which is where this quiz is actually taken. Pointer events are one code path for
       mouse, touch and pen.
       ⛔ TAPPING STILL WORKS. Dragging is added to tapping, not instead of it: a press that
       never travels more than DRAG_SLOP is still a tap and still places or removes the tile. The
       click handler checks dragMoved, because a real drag ends with a click event too and
       without the flag every drag would also fire the tap and undo itself.
       ⚠ THE LOCKED HEAD-START TILES ARE OUT OF ALL OF IT. They carry no data-p, so they are
       never given a handler, never picked up, and never counted as an insertion point — which
       is what makes "before the first movable tile" mean "after the whole locked prefix" for
       free, rather than by a special case that could be got wrong. */
    var DRAG_SLOP = 6;
    var dragMoved = false;
    var drag = null;
    /* ⛔⛔ ONCE THE ANSWER IS CHECKED, NOTHING MOVES. Submitting nulls the tap handlers, but a
       pointerdown listener is not an onclick and survives that — so without this the learner
       could still rearrange a marked answer underneath the reveal, and the tiles would no longer
       agree with what they were marked on. */
    var frozen = false;

    /* Only the movable tiles inside the answer box, in visual order. The locked ones are absent
       by construction (no data-p), so every index here is an index into `placed`. */
    function dropTiles() {
      return [].slice.call(dropEl.querySelectorAll('[data-p]'));
    }

    /* ⚠ Rows dominate. A wrapped flex row means the nearest tile by plain distance can easily
       be the one above or below the pointer, so the vertical difference is weighted — pick the
       row first, then the side of that tile's centre the pointer is on. */
    function insertIndexAt(x, y) {
      var nodes = dropTiles().filter(function (n) { return n !== drag.ghost; });
      if (!nodes.length) return 0;
      /* ⚠ "Before everything" has to be reachable. Nearest-tile-plus-side cannot express it:
         aim at the far left of the box, above the first movable tile, and the nearest tile is on
         the row below with the pointer to its left — which resolves to that tile's index, so the
         chip lands SECOND. The head of the list gets an explicit region: anything above the first
         movable tile's row, or left of it on that row, is index 0. */
      var f = nodes[0].getBoundingClientRect();
      if (y < f.top || (y <= f.bottom && x < f.left + f.width / 2)) return 0;
      var best = 0, bestD = Infinity, after = false;
      nodes.forEach(function (n, i) {
        var r = n.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var d = Math.abs(y - cy) * 3 + Math.abs(x - cx);
        if (d < bestD) { bestD = d; best = i; after = x > cx; }
      });
      return best + (after ? 1 : 0);
    }

    function inside(el, x, y) {
      var r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    function wireDrag(node, from) {
      node.addEventListener('pointerdown', function (ev) {
        if (frozen) return;
        if (ev.button != null && ev.button !== 0) return;      /* left / primary only */
        dragMoved = false;
        var startX = ev.clientX, startY = ev.clientY;
        var ti = parseInt(from === 'tray' ? node.dataset.t : node.dataset.p, 10);
        /* ⚠ Capture from the FIRST event, not from the moment the drag is recognised. A quick
           flick can clear the six-pixel slop and leave the tile in the same frame, and without
           capture that move is delivered to whatever is underneath — the drag then never starts
           and the tile just sits there, which reads as the feature being broken. */
        try { node.setPointerCapture(ev.pointerId); } catch (_) {}

        function move(e) {
          if (!dragMoved) {
            if (Math.abs(e.clientX - startX) < DRAG_SLOP && Math.abs(e.clientY - startY) < DRAG_SLOP) return;
            begin(e);
          }
          var r = drag.flyer;
          r.style.transform = 'translate(' + (e.clientX - drag.dx) + 'px,' + (e.clientY - drag.dy) + 'px)';
          /* live feedback: the gap opens where the tile would land */
          if (inside(dropEl, e.clientX, e.clientY)) {
            var idx = insertIndexAt(e.clientX, e.clientY);
            var nodes = dropTiles().filter(function (n) { return n !== drag.ghost; });
            dropEl.insertBefore(drag.ghost, nodes[idx] || null);
            drag.ghost.hidden = false;
            drag.target = idx;
          } else {
            drag.ghost.hidden = true;
            drag.target = -1;
          }
        }

        function begin(e) {
          dragMoved = true;
          var r = node.getBoundingClientRect();
          var flyer = node.cloneNode(true);
          flyer.className = node.className + ' tq-flyer';
          flyer.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483000;'
            + 'width:' + r.width + 'px;margin:0';
          document.body.appendChild(flyer);
          /* a placeholder of the same size, so the layout does not jump as the tile leaves */
          var ghost = document.createElement('span');
          ghost.className = 'tile tq-ghost';
          ghost.style.width = r.width + 'px';
          ghost.style.height = r.height + 'px';
          ghost.hidden = true;
          drag = { flyer: flyer, ghost: ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, target: -1 };
          node.classList.add('tq-lifted');
        }

        function up(e) {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.removeEventListener('pointercancel', up);
          if (!dragMoved) return;                       /* a tap: leave it to the click handler */
          var overDrop = inside(dropEl, e.clientX, e.clientY);
          var idx = overDrop ? insertIndexAt(e.clientX, e.clientY) : -1;
          drag.flyer.remove();
          if (drag.ghost.parentNode) drag.ghost.remove();
          node.classList.remove('tq-lifted');
          drag = null;

          if (from === 'tray') {
            /* ⚠ Dropped anywhere but the answer box = no change. A tray tile has nowhere else
               to go, so "cancel" is the only honest reading of a drop on empty space. */
            if (overDrop) placed.splice(idx, 0, ti);
          } else {
            var at = placed.indexOf(ti);
            placed.splice(at, 1);
            /* ⚠ The index was measured while this tile was still in the list, so an insertion
               point after its old home is one too many once it is gone. */
            if (overDrop) placed.splice(idx > at ? idx - 1 : idx, 0, ti);
            /* dropped outside: it goes back to the tray, which is what removing it means */
          }
          paint();
          /* ⚠⚠ The click that follows a real drag must not ALSO fire the tap handler, which
             would immediately undo the drag. The flag is therefore consumed by the click handler
             itself and cleared at the next pointerdown — never on a timer.
             ⛔ It was a setTimeout(0), and that is wrong twice over: a background tab throttles
             the timer to a second or more, so every tap in between was swallowed and tapping
             appeared to stop working after the first drag; and paint() has already replaced the
             nodes, so in a real browser the click may never be dispatched at all, leaving the
             flag true until something else happened to clear it. A flag whose lifetime is "until
             the event that consumes it" must not be given a lifetime in milliseconds. */
        }

        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
      });
    }

    paint();

    /* ⭐ THE LAYOUT IS LOCKED BEFORE THE FIRST TAP (owner, 2026-09-20: "the check button creeps up
       as the space gets smaller … should stay in a fixed position"). Tiles move between the tray
       and the answer box, so without this BOTH containers resize on every tap and everything
       below them walks up and down the screen — including the button you are aiming at, which is
       how you mis-tap.
       ⚠ Measured, not calculated: tile widths depend on the Thai, the font, the script mode and
       the text-size setting, so the only honest number is what the browser actually laid out.
       Taken on the initial paint, when EVERY tile is in the tray, which is the worst case for
       either container — a learner can place all of them, so the answer box needs the same room.
       The style sits on the containers themselves, so paint()'s innerHTML rewrites cannot clear it.

       ⚠⚠ MEASURE SYNCHRONOUSLY — NOT IN requestAnimationFrame. The first version deferred to
       rAF on the belief that scrollHeight reads 0 before layout. It does not: reading scrollHeight
       forces a synchronous reflow, so the number is right the moment paint() has written the
       tiles. And rAF does not fire at all in a HIDDEN tab, so that version silently locked
       nothing whenever the quiz was opened in a background tab — which is exactly how it was
       caught. A layout guarantee must not depend on the tab being on screen.

       ⚠ The web font can land after this and change every tile's width, so re-measure on
       fonts.ready — but MONOTONICALLY. By then the learner may already have moved tiles into the
       answer box, which makes the tray genuinely shorter; shrinking to that would undo the lock
       mid-tap, which is the fault itself. It may only ever grow. */
    var lockPx = 0;

    /* ⚠⚠ THE TRAY'S HEIGHT IS NOT THE ANSWER BOX'S WORST CASE. The answer box carries padding
       the tray does not, so the same tiles are TALLER once they are inside it — measured at
       104px in the tray and 111px in the box on the pilot unit. Locking both to the tray's
       number therefore still let the Check button move on the last tap, which is the whole
       complaint. So measure the box holding EVERYTHING, in a hidden copy of the box laid out at
       the real width: a clone, never the live node — rewriting the live innerHTML to measure it
       would destroy the click handlers on tiles already placed. */
    function fullDropPx() {
      var probe = dropEl.cloneNode(false);
      /* ⚠ The width must be COPIED from the live box, not inherited. `left:0;right:0` on an
         absolutely positioned clone resolves against the nearest POSITIONED ancestor, which
         here is the sheet — wider than the answer box, so the tiles fitted in fewer rows and
         the probe under-reported by a whole row (104px measured against a real 152px). */
      probe.style.cssText = 'position:absolute;visibility:hidden;top:-9999px;left:0;min-height:0'
        + ';width:' + dropEl.offsetWidth + 'px';
      /* ⚠ The probe must model the tile it is measuring. Placed chips now carry their
         transliteration, which makes them two lines tall — a probe without it under-reports the
         lock by a whole row and the Check button starts moving again. */
      probe.innerHTML = locked.map(function (g) { return tileHtml(g, 'lock'); }).join('')
        + tray.map(function (t) {
            return '<span class="tile in">' + esc(scriptBits(t.g[0], t.g[2], p.script).main)
              + (p.script === 'both' && t.g[2] ? '<span class="tt">' + esc(t.g[2]) + '</span>' : '')
              + '</span>';
          }).join('');
      dropEl.parentNode.insertBefore(probe, dropEl);
      /* offsetHeight, not scrollHeight: the box has a border and scrollHeight excludes it,
         which left the lock 3px short and the button still twitching on the last tap. */
      var h = probe.offsetHeight;
      probe.remove();
      return h;
    }
    function lockHeights(force) {
      /* ⚠⚠ A RE-MEASURE MUST CLEAR THE OLD FLOOR FIRST. The min-height from the last
         measurement is still on the nodes, so scrollHeight would report that floor rather than
         the content, and the box could then only ever grow — exactly wrong when the learner has
         just chosen a SMALLER text size. */
      if (force) { lockPx = 0; dropEl.style.minHeight = ''; }
      /* ⛔⛔ THE ANSWER BOX ONLY. The tray needs no lock: since a taken chip leaves a hidden
         RESERVED SLOT rather than vanishing, its height cannot change — constant by
         construction, which is better than a measured floor. Locking it too was worse than
         redundant: the shared number is the max of the tray AND the box's worst case, so it made
         the tray 30px taller than it ever needs, and releasing that on submit was itself a 30px
         jump at the moment the learner looks at the verdict. */
      var h = Math.max(fullDropPx(), 66 * fontScale());
      if (h <= lockPx) return;
      lockPx = h;
      dropEl.style.minHeight = h + 'px';
    }
    lockHeights();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { lockHeights(); });

    /* ⭐ THE LOCK FOLLOWS THE TEXT SIZE (owner, 2026-09-20: "this will have to be able to vary
       with selected font size"). Every number inside it — tile height, padding, gap, and how
       many tiles fit on a row — is multiplied by --tq-scale, so a height measured at 0.9 is
       simply wrong at 1.5: too short, and the Check button starts moving on the last tap again.
       The measurement is cheap and honest, so re-take it rather than trying to scale the old
       number. ⚠ The empty-box floor is scaled too, or the smallest stop keeps a box sized for
       the default.
       ⚠ A rotation is the same fault by another route — it changes the row width, so the row
       count, so the height — which is why this hook is on the run and not on the font control. */
    run.relayout = function () { lockHeights(true); };
    /* ⭐⭐ THE SCRIPT SETTING APPLIES TO THE QUESTION ALREADY ON SCREEN, and the owner found
       the mechanism himself: "if i click any of the gloss chips in the builder, they all update.
       so you just need to find that code path and trigger it on any settings change."
       ⚠⚠ IT HAD TO BE A RE-RENDER, NOT A CSS CLASS. v578 tried the class route, which is what
       makes the Thai-font and transliteration pills instant, and it CANNOT express this one:
       in 'tl' mode the tile's MAIN TEXT changes from the Thai to the transliteration, and there
       is no rule that turns one string into another. That is exactly the half that failed live
       — "transliteration only isn't transliteration only, it has thai script and
       transliteration" — because only the 'thai' branch had a rule and 'tl' had none.
       ✅ paint() rebuilds the tray and the answer box from `placed`, which is state, so the
       answer survives — the same property that makes it safe on every chip tap. And `p` IS
       run.prefs, not a copy, so it reads the new value with no plumbing. */
    run.repaint = paint;

    submit.onclick = function () {
      /* ⛔⛔ THE CHECK RUNS ON THE WHOLE BOX — LOCKED CHIPS INCLUDED — NEVER THE TAIL ALONE
         (§3A.6). Several accepted orders vary in the opening, so checking only what the learner
         placed marks a good sentence wrong. */
      var built = locked.map(function (g) { return g[0]; })
        .concat(placed.map(function (ti) { return tray[ti].g[0]; }));
      var ok = acceptedBy(s.num, built, canon.map(function (g) { return g[0]; }));
      if (!ok) logRejected(s.num, built);
      submit.disabled = true;
      frozen = true;
      trayEl.querySelectorAll('.tile').forEach(function (n) { n.onclick = null; });
      dropEl.querySelectorAll('.tile').forEach(function (n) { n.onclick = null; });

      /* ⛔ THE LOCK IS **NOT** RELEASED HERE ANY MORE. It used to be, so the reveal would fit
         on screen — but showReveal() already scrolls the reveal into view, so the release bought
         nothing and cost a 30px reflow at the exact moment the learner is reading the verdict.
         Owner's condition on the verdict-in-place change was "so long as there isnt a rendering
         race or any nasty flickers/shifts", and this was the shift. */

      /* ⛔ ON SUBMIT THE REAL THAI PLAYS, right or wrong, automatically, once (§5.1). */
      playSentence(s.num, null);

      /* ⭐ THE REVEAL IS ASYMMETRIC (§5.1): a correction is remediation, and remediation is only
         needed when there is something to remediate. A quiz that lectures after a right answer
         is a quiz people stop taking. */
      /* ⭐⭐ THE CHECK BUTTON BECOMES THE VERDICT (owner, 2026-09-20). Once you have checked,
         Check is dead weight sitting directly above a line that says "Not quite" — two rows
         saying one thing, on the screen that is already the longest in the quiz.
         ⛔⛔ THE SAME ELEMENT IS RE-LABELLED, NOT SWAPPED. His condition was "so long as there
         isnt a rendering race or any nasty flickers/shifts", and that rules out the obvious
         implementation: removing the button and inserting a pill would collapse its height for
         one frame and shunt everything below it up and back. Changing the class and the text of
         a node that is already there, at the same width and the same padding, cannot shift
         anything — there is no frame in which the box does not exist.
         ⚠ It stays a <button> and stays disabled: a re-labelled control must not still look
         pressable, and turning it into a <p> would be the swap this exists to avoid. */
      submit.classList.add('t-verdict', ok ? 'right' : 'wrong');
      submit.textContent = ok ? 'Correct' : 'Not quite';

      /* ⭐⭐ A NON-STANDARD BUT CORRECT ANSWER IS MARKED RIGHT **AND** SHOWN THE MODEL ANSWER
         (owner, 2026-09-20). Now that a sentence can license omitting กัน or ก็, and that fronting
         a time adverbial is accepted, "correct" covers several genuinely different sentences —
         and a learner who drops a word they were never sure about learns nothing from a bare
         tick. They are right, and they should also see what the sentence normally looks like.
         ⚠ ONLY WHEN IT DIFFERS. §5.1's asymmetry still holds for an exact match: a quiz that
         lectures after the textbook answer is a quiz people stop taking. The comparison is
         against the canonical chip order, which is the one the corpus actually records. */
      var exact = built.join('\u0001') === canon.map(function (g) { return g[0]; }).join('\u0001');

      /* ⭐ A REPLAY BUTTON, like the other three quizzes (owner, 2026-09-20). The Thai plays
         once automatically on submit (§5.1) and there was no way to hear it again — which is
         the one thing a learner wants most on the answer they just got wrong.
         ⚠ It goes UNDER the model answer and ABOVE Next, the same slot Vocab and Speak use, so
         the three reveals read the same way round. On an exact match there is no model answer,
         so the button is the only thing above Next and the spacing is unchanged. */
      var replay = '<button class="playbtn" type="button"><span class="tri"></span>'
                 + 'Play the Thai</button>';

      var d = sheet.querySelector('.t-rev');
      /* ⚠ The model answer is Thai, so it redraws with the script setting like every other
         reveal in the arm. paint() is already registered for the tray and the box; this composes
         with it rather than replacing it — see onRepaint. */
      onRepaint(function () { drawRev(); });
      function drawRev() {
      if (ok) {
        d.innerHTML = '<div class="reveal">'
          + modelAnswer(s, canon, p, exact ? 'exact' : 'variant')
          + replay
          + '<button class="nextbtn" type="button">'
          + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
      } else {
        /* ⛔⛔ THE WRITTEN CORRECTION HONOURS THE LEARNER'S SCRIPT SETTING. Someone working in
           transliteration must not be handed a wall of Thai at the one moment they are trying to
           learn from a mistake — and the reveal is naturally built from Thai-first data, so this
           is the easiest thing here to get wrong. */
        d.innerHTML = '<div class="reveal">'
          + modelAnswer(s, canon, p, 'wrong')
          + replay
          + '<button class="nextbtn" type="button">'
          + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
      }
      /* ⚠ toggleSentence, not playSentence: the clip is ALREADY playing from the automatic
         play on submit, so a fresh call would stop it and start it again from the top. This is
         the same control the other reveals use and it resumes rather than restarts. */
      var rb = d.querySelector('.playbtn');
      if (rb) rb.onclick = function () { toggleSentence(s.num, rb); };
      d.querySelector('.nextbtn').onclick = function () { advance(String(s.num), ok); };
      }
      drawRev();
      showReveal(d);
    };
  }

  /* One renderer for the model answer, used by BOTH branches — a learner who was wrong and a
     learner who was right-but-different need exactly the same thing, and two copies of it would
     drift. Only the heading changes.
     ⛔⛔ IT HONOURS THE LEARNER'S SCRIPT SETTING. Someone working in transliteration must not be
     handed a wall of Thai at the one moment they are trying to learn from a difference — and
     the reveal is naturally built from Thai-first data, so this is the easiest thing here to get
     wrong. */
  /* ⭐⭐ THE WRITTEN THAI IS SHOWN EVERY TIME (owner, 2026-09-20). Assembling chips and reading
     the finished sentence are different acts: you can place eight tiles correctly and never have
     seen the thing you built as a sentence. It was missing on exactly the answer where the
     learner has most earned it.
     ⚠ THE CHIPS ARE THE PART THAT IS CONDITIONAL, not the sentence. On an exact match the chip
     row would be a copy of what is still on screen directly above it, so it is dropped — the
     comparison is against the canonical order, which the caller has already computed, so this is
     a branch on a known fact rather than a guess.
     §5.1's asymmetry survives in the thing that matters: an exact answer gets no CORRECTION. It
     just gets to read what it wrote. */
  function modelAnswer(s, canon, p, mode) {
    var b = scriptBits(stripBars(s.thai), stripBars(s.translit), p.script);
    var exact = (mode === 'exact');
    var lab = (mode === 'wrong') ? 'The correct order'
            : (mode === 'variant') ? 'Yours works. The usual wording'
            : 'The sentence';
    return '<p class="mlab">' + lab + '</p>'
      + (exact ? '' : '<div class="chips">' + canon.map(chipHtml).join('') + '</div>')
      + '<p class="thaibig"' + (exact ? '' : ' style="margin-top:10px"') + '>' + esc(b.main) + '</p>'
      + (b.sub ? '<p class="tl">' + esc(b.sub) + '</p>' : '');
  }

  /* §5.2 — the answer space is the set of LICENSED VARIATIONS, not the permutation space.
     Accepted iff the built order is a SUBSEQUENCE of the canonical order that contains every
     NON-DROPPABLE chip. So: exact order always passes; leaving out a droppable particle or
     pronoun passes; re-ordering or including a decoy does not. */
  /* ⭐ THE ANSWER KEY IS A SET MEMBERSHIP TEST (§5.2). gen_quiz_orders.js enumerated every
     licensed variation — droppable subsets x mobile placements — at build time, so nothing here
     has to be clever and nothing can disagree with what was checked.
     ⚠ The stored set is exhaustive by construction; the runtime rule below is only reached on a
     page that predates the generator, and it CANNOT express the MOBILE class (a fronted time
     adverbial), so it is strictly weaker. Treat a fallback hit as a build that needs re-running. */
  function acceptedBy(num, built, canon) {
    var stored = (QD().orders || {})[String(num)];
    if (stored && stored.length) return stored.indexOf(built.join('\u0001')) >= 0;
    return accepts(built, canon);
  }

  function accepts(built, canon) {
    var i = 0;
    for (var j = 0; j < built.length; j++) {
      while (i < canon.length && canon[i] !== built[j]) {
        if (!DROPPABLE[canon[i]]) return false;      /* skipped a chip that cannot be dropped */
        i++;
      }
      if (i >= canon.length) return false;           /* a tile not in the canonical order (a decoy) */
      i++;
    }
    while (i < canon.length) { if (!DROPPABLE[canon[i]]) return false; i++; }
    return true;
  }

  /* ⭐ §11 Phase 5: "the highest-value artifact of this phase is the log of quiz-2 answers the
     checker REJECTED — every false negative is a gap in the accepted-order rule or a decoy that
     builds a real sentence, and there is no other way to find them." */
  function logRejected(num, built) {
    try {
      var K = 'te_quiz_rejected_v1';
      var L = JSON.parse(localStorage.getItem(K) || '[]');
      L.push({ at: Date.now(), unit: ctx.unit, num: num, built: built.join(' ') });
      localStorage.setItem(K, JSON.stringify(L.slice(-300)));
    } catch (_) {}
  }

  /* ── Quiz 3 — Vocab Trainer (§6) ───────────────────────────────────────────────────────── */
  function qVocab() {
    var it = run.items[run.i], w = it.word;
    var list = QD().q3 || [], pool = QD().q3x || [];

    /* §6.3 — if another word on THIS list answers the same prompt, the question asks for TWO. */
    var twins = list.filter(function (x) { return x.th !== w.th && headGloss(x.en) === headGloss(w.en); });
    var need = twins.length ? 2 : 1;

    /* ⚠ DEPRIORITISE A CONTAINING OPTION (owner, 2026-09-20). He met ของกิน beside ของกินเล่น
       for "snacks". ของกินเล่น IS the only right answer — ของกิน is food in general — so the
       question was fair, but one option being a SUBSTRING of another reads as a trick rather
       than a test, and it is the same containment class that ban A catches in quiz 2.
       ⛔ Deprioritised, NOT banned: a unit's list is only ~20 words, so a hard ban could leave a
       question short of options, and a short question is a worse fault than an awkward one.
       They sort last and are used only if nothing else is available. */
    function contains(a, b) {
      return a.length >= 2 && b.length >= 2 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
    }
    function rank(arr) {
      return shuffle(arr).sort(function (a, b) {
        return (contains(a.th, w.th) ? 1 : 0) - (contains(b.th, w.th) ? 1 : 0);
      });
    }
    var wrongs = rank(list.filter(function (x) {
      return x.th !== w.th && headGloss(x.en) !== headGloss(w.en) && x.pos === w.pos;
    })).concat(rank(list.filter(function (x) {
      return x.th !== w.th && headGloss(x.en) !== headGloss(w.en) && x.pos !== w.pos;
    }))).concat(rank(pool.slice()));

    var opts = [{ th: w.th, en: w.en, tl: w.tl, ok: 1 }];
    if (need === 2) opts.push({ th: twins[0].th, en: twins[0].en, tl: twins[0].tl, ok: 1 });
    for (var k = 0; opts.length < 4 && k < wrongs.length; k++) {
      if (!opts.some(function (o) { return o.th === wrongs[k].th; })) {
        opts.push({ th: wrongs[k].th, en: wrongs[k].en, tl: wrongs[k].tl, ok: 0 });
      }
    }
    shuffle(opts);

    var hidden = run.prefs.hide;
    /* ⛔⛔ A MULTI-ANSWER PROMPT ASKS WITH THE SHARED GLOSS ALONE — no parentheticals by
       default (owner, 2026-09-20: "just have 'food' - by default the multiple options in
       brackets not contained unless we need to be specific for some reason").
       กับข้าว and ของกิน are both glossed 'food', disambiguated as "rice dishes" and "things to
       eat", which is what makes them §6.3 twins. The prompt printed the TARGET's own gloss, so it
       read  food ("rice dishes")  while demanding two answers — it described one of the two and
       said nothing about the other.
       ⚠⚠ THAT IS A BIAS, NOT AN IMPRECISION, and the distinction is why this is a rule and not a
       one-line data edit: naming one answer's sense makes that answer findable and leaves the
       other to be guessed, so the question stops testing the same thing for both halves of its
       own answer. The owner's rule: "all or none, never just one or some."
       ✅ THE DEFAULT IS NONE, because the question is multiple choice — "the answer is in front
       of the user and if the distractors are chosen well it wont be confused". 'food' is
       unambiguous here precisely because อาหาร is not on the list. ⚠ That is a property of the
       OPTION SET, not of the word, which is the thing to check when adding a distractor.
       ⚠ §6.4 keeps the authored gloss verbatim, so this strips at RENDER time and edits nothing.
       The reveal still shows each option's own full gloss, which is where the distinction earns
       its keep — and `test_quiz_engine.js` fails if a twin group is MIXED, one member carrying a
       parenthetical and another not, because then the reveal cannot tell them apart either.
       ⚠ A one-answer question is untouched: there is no other answer to be fair to. */
    var promptEn = (need === 2) ? bareGloss(w.en) : w.en;
    render(bar()
      + '<p class="enq">' + esc(promptEn) + '</p>'
      + (need === 2 ? '<p class="tq-need">Select <b>2</b> answers</p>' : '')
      + (hidden ? '<button type="button" class="startbtn t-show">Show the options</button>' : '')
      + '<div class="t-opts"' + (hidden ? ' hidden' : '') + '>'
      + opts.map(function (o, i) { return optHtml(o, i); }).join('')
      + '</div><div class="t-rev"></div>' + foot());
    wireBar(); wireFoot();

    var sh = sheet.querySelector('.t-show');
    if (sh) sh.onclick = function () { sh.remove(); sheet.querySelector('.t-opts').hidden = false; };

    /* ⚠ The options are the one place outside the Builder where the QUESTION itself is Thai,
       so a script change has to reach them and not only the reveal. Only the inner text is
       rewritten — see optInner. */
    onRepaint(function () {
      sheet.querySelectorAll('.opt').forEach(function (x, xi) {
        if (!opts[xi]) return;
        var en = x.querySelector('.o-en');
        x.innerHTML = optInner(opts[xi]);
        if (en) x.appendChild(en);
      });
    });

    var chosen = [];
    /* ⭐ THE OWNER GOT STUCK ON A TWO-ANSWER QUESTION: he picked one, nothing happened, and
       nothing said why. §6.3 forbids marking the first pick (it would leak the answer to the
       second), so the screen is CORRECTLY inert — which means the only thing that can rescue it
       is telling him. The prompt goes where the reveal will appear, so it occupies the space the
       answer is about to use rather than shifting the page. */
    function prompt() {
      var d = sheet.querySelector('.t-rev');
      var left = need - chosen.length;
      d.innerHTML = (left > 0 && chosen.length > 0)
        ? '<p class="tq-more">Select ' + (left === 1 ? 'one more answer' : left + ' more answers') + '</p>'
        : '';
    }
    sheet.querySelectorAll('.opt').forEach(function (b) {
      b.onclick = function () {
        var i = parseInt(b.dataset.i, 10);
        /* ⛔⛔ NEITHER SELECTION IS MARKED UNTIL BOTH ARE MADE (§6.3): colouring the first leaks
           the answer to the second, turning a 2-of-4 question into a 1-of-3. */
        var at = chosen.indexOf(i);
        if (at >= 0) { chosen.splice(at, 1); b.classList.remove('picked'); prompt(); return; }
        chosen.push(i); b.classList.add('picked');
        if (chosen.length < need) { prompt(); return; }
        var ok = chosen.every(function (ci) { return opts[ci].ok; }) && chosen.length === need;
        sheet.querySelectorAll('.opt').forEach(function (x, xi) {
          x.disabled = true; x.classList.remove('picked');
          if (opts[xi].ok) x.classList.add('right');
          else if (chosen.indexOf(xi) >= 0) x.classList.add('wrong');
          /* ⭐ Owner: after answering, show what the OTHER options meant. Three quarters of the
             screen was otherwise a dead end — you learn the answer and nothing about the words
             you rejected. Re-rendered in place so nothing moves. */
          var enEl = document.createElement('span');
          enEl.className = 'o-en';
          enEl.textContent = opts[xi].en || '';
          if (!x.querySelector('.o-en')) x.appendChild(enEl);
        });
        vocabReveal(w, ok);
      };
    });
  }

  /* One renderer for a Vocab option. ⭐ `withEn` is the owner's request: after answering, the
     WRONG options show their English too — otherwise the learner learns nothing from the three
     they did not pick, which is three quarters of what was on screen. */
  function optHtml(o, i, withEn) {
    return '<button class="opt" type="button" data-i="' + i + '">'
      + optInner(o) + (withEn ? '<span class="o-en">' + esc(o.en || '') + '</span>' : '')
      + '</button>';
  }
  /* ⚠ Split out so a script change can rewrite an option's TEXT without touching the button:
     its right/wrong/picked classes and its disabled state are the record of what the learner
     did, and re-rendering the whole option would throw them away. */
  function optInner(o) {
    var b = scriptBits(o.th, o.tl, curScript());
    return '<span class="o-th">' + esc(b.main) + '</span>'
      + (b.sub ? '<span class="o-tl">' + esc(b.sub) + '</span>' : '');
  }

  function vocabReveal(w, ok) {
    var s = sentByNum(w.num) || (function () {
      /* find any sentence containing the word, so the context is always real */
      var ss = (T() || {}).sentences || [];
      for (var i = 0; i < ss.length; i++) {
        if (chipsOf(ss[i]).some(function (g) { return g[0] === w.th; })) return ss[i];
      }
      return null;
    })();
    var d = sheet.querySelector('.t-rev');
    /* ⚠ `first` guards the AUTOPLAY. A script change redraws this block, and the clip must not
       restart every time the learner changes a display setting — the reveal is re-rendered, not
       re-entered. */
    function draw(first) {
    var html = '<div class="reveal">';
    if (w.lit) html += '<p class="tq-say"><b>Literally:</b> ' + esc(w.lit) + '</p>';
    if (s) {
      /* ⭐ THE BREAKDOWN, NOT JUST THE SENTENCE (owner, 2026-09-20: "you should see the gloss
         chip breakdown for the sentence as well in the answer. right now its just thai +
         english"). A whole Thai sentence with a whole English sentence under it shows the word
         in use but does not show WHERE — the learner has the answer and still cannot point at
         it. The chips are the join, and they already exist on the sentence, so this duplicates
         nothing (§1) and follows the transliteration pill for free.
         ⚠ Under the English, not above it: read the sentence, read what it means, then take it
         apart. Putting the parts first makes the reveal open on a wall of small type. */
      var sb = scriptBits(stripBars(s.thai), stripBars(s.translit), curScript());
      html += '<p class="mlab">Appears in</p>'
        + '<p class="thaibig">' + esc(sb.main) + '</p>'
        + (sb.sub ? '<p class="tl">' + esc(sb.sub) + '</p>' : '')
        + '<p class="cen">' + esc(s.english) + '</p>'
        + (chipsOf(s).length
            ? '<div class="chips vchips">'
              + chipsOf(s).map(function (g) { return chipHtml(g, w.th); }).join('') + '</div>'
            : '')
        + '<button class="playbtn" type="button"><span class="tri"></span>Play the sentence</button>';
    }
    html += '<button class="nextbtn" type="button">'
      + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
    d.innerHTML = html;
    var pb = d.querySelector('.playbtn');
    if (pb && s) {
      pb.onclick = function () { toggleSentence(s.num, pb); };
      if (first) playSentence(s.num, pb);
    }
    d.querySelector('.nextbtn').onclick = function () { advance(w.th, ok); };
    }
    draw(true);
    onRepaint(function () { draw(false); });
    showReveal(d);
  }

  /* ── Quiz 4 — Speak Thai (§6A) ─────────────────────────────────────────────────────────── */
  function qSpeak() {
    var it = run.items[run.i], s = it.sent;
    /* ⚠ Speak Thai gets the buildable wording too. It is the same job as the Builder — produce
       the Thai from an English prompt — so a prompt that omits half the sentence's parts is the
       same fault here, and marking yourself against it is if anything harsher. */
    render(bar()
      + promptFor(s)
      + '<p class="tq-say">Say it in Thai, out loud. Then reveal and mark yourself — it is your own call.</p>'
      + '<button class="startbtn t-reveal" type="button">Reveal answer</button>'
      + '<div class="t-rev"></div>' + foot());
    wireBar(); wireFoot();

    sheet.querySelector('.t-reveal').onclick = function () {
      this.remove();
      var d = sheet.querySelector('.t-rev');
      function draw(first) {
        var b = scriptBits(stripBars(s.thai), stripBars(s.translit), curScript());
        d.innerHTML = '<div class="reveal">'
          + '<p class="thaibig">' + esc(b.main) + '</p>'
          + (b.sub ? '<p class="tl">' + esc(b.sub) + '</p>' : '')
          + '<button class="playbtn" type="button"><span class="tri"></span>Play the Thai</button>'
          + '<div class="chips">' + chipsOf(s).map(function (g) { return chipHtml(g); }).join('') + '</div>'
          + '<div class="tq-selfmark">'
          + '<button type="button" class="tq-got">I got it</button>'
          + '<button type="button" class="tq-not">Not quite</button>'
          + '</div></div>';
        var pb = d.querySelector('.playbtn');
        pb.onclick = function () { toggleSentence(s.num, pb); };
        /* ⛔ the real Thai plays on reveal (§6A.1) — on the FIRST draw only, so a script
           change does not restart the clip. */
        if (first) playSentence(s.num, pb);
        d.querySelector('.tq-got').onclick = function () { advance(String(s.num), true); };
        d.querySelector('.tq-not').onclick = function () { advance(String(s.num), false); };
      }
      draw(true);
      onRepaint(function () { draw(false); });
      showReveal(d);
    };
  }

  /* ── the in-question options menu (§3A.5) ──────────────────────────────────────────────── */
  /* ⭐⭐ THE QUESTION IS PUT ASIDE, NOT THROWN AWAY (owner, 2026-09-20: "if i have answered a
     question, and then click the settings in the top right, when i exit the settings and return
     to question, it reverts and is now unanswered").
     The menu used to finish with question(), which re-runs the engine from scratch: a new
     shuffle, new options, no answer, no reveal — and on a question the learner has already
     marked, that is destroying work. It also contradicted this screen's own subtitle, which
     promises the settings apply from the NEXT question.
     ⚠⚠ The fix MOVES the nodes into a detached fragment rather than stashing innerHTML.
     innerHTML is a string: the question would come back looking identical with every onclick
     gone — a worse bug than the one being fixed, because it looks fine. Moving elements keeps
     their handlers, classes and inline styles, which together are the answered state.
     ✅ Text size is the deliberate exception to "applies from the next question": it is a CSS
     variable on the sheet, so it reaches the restored question at once, which is what makes it
     usable as a control rather than a promise. */
  function inQuestionMenu() {
    scaleOff = false;
    var qid = run.q.id, p = run.prefs;
    var scaleBefore = fontScale();
    var keep = document.createDocumentFragment();
    while (sheet.firstChild) keep.appendChild(sheet.firstChild);
    var relayout = run.relayout, repaint = run.repaint;
    var scriptBefore = p.script;
    /* ⚠ The subtitle used to read "Applies from the next question", which was true when every
       one of these settings was baked in at render time. It is not true any more — the text
       size, the font, the transliteration pill and now the three-way script setting all reach
       the question you came from. Only the QUESTION COUNT and the question MIX cannot, because
       the run they describe is already under way. */
    var html = head('Options', 'Most of these apply straight away');
    html += '<div class="mgroup"><p class="mlab">Thai script</p><div class="radios">'
      + radio('script', 'both', p.script, 'Thai + transliteration', '')
      + radio('script', 'thai', p.script, 'Thai only', '')
      + radio('script', 'tl',   p.script, 'Transliteration only', '')
      + '</div></div>';
    if (qid === 1 || qid === 3) {
      html += '<div class="mgroup"><label class="checkrow"><input type="checkbox" class="c-hide"'
        + (p.hide ? ' checked' : '') + '><span>Hide the answers until I ask</span></label></div>';
    }
    html += fontGroup();
    /* ⛔⛔ EXACTLY ONE TRANSLITERATION CONTROL, AND IT IS THE THREE-WAY (owner, 2026-09-20:
       "show transliteration is confusingly an option in both of them!!", and then "lets not
       create divergences between quizzes on the day we have made them").
       The first fix showed the site pill on quizzes 1 and 3 and the three-way on 2 and 4 — one
       control per surface, but TWO controls across an arm the same learner walks through in one
       sitting, and the pill cannot say "transliteration only" at all. Now every quiz has the
       three-way and the SITE pill does not appear in here.
       ⚠ The Modern Thai font stays: it is genuinely site-wide and orthogonal — it says which
       FACE draws the Thai, not whether there is any. */
    html += '<div class="mgroup"><p class="mlab">Display</p>'
      + '<label class="checkrow"><input type="checkbox" class="c-tf"'
      + (thaiModern() ? ' checked' : '') + '><span>Modern Thai font</span></label></div>';
    /* ⛔ The exclude control is NOT in this menu any more — it is a footer on the
       question itself, where the learner is looking when they decide (owner, 2026-09-20). */
    html += '<button type="button" class="startbtn">Back to the question</button>';
    render(html);
    wireClose();
    wireFontGroup();
    sheet.querySelector('.startbtn').onclick = function () {
      var sc = sheet.querySelector('input[name=script]:checked'); if (sc) run.prefs.script = sc.value;
      var hi = sheet.querySelector('.c-hide'); if (hi) run.prefs.hide = hi.checked;
      /* ⚠ SITE-wide, not a quiz pref — deliberately not in run.prefs and not synced to
         quiz_prefs, because the learner set it for the whole site. */
      var tf = sheet.querySelector('.c-tf'); if (tf) setThaiModern(tf.checked);
      savePrefs(qid, run.prefs);
      restoreQuestion();
    };

    function restoreQuestion() {
      sheet.innerHTML = '';
      sheet.appendChild(keep);
      applyFontScale();
      sheet.scrollTop = 0; ov.scrollTop = 0;
      run.relayout = relayout;
      run.repaint = repaint;
      /* ⚠ Only when it CHANGED. paint() rewrites innerHTML and re-wires every tile, so firing
         it on a menu visit that touched nothing would drop any in-flight pointer capture for no
         reason at all. */
      if (repaint && run.prefs.script !== scriptBefore) repaint();
      /* ⚠ A text-size change re-flows the question that is coming back, so anything holding a
         measured height has to re-measure at the size it is now being drawn at. */
      if (relayout && fontScale() !== scaleBefore) relayout();
    }
  }

  /* ── results (§3B.1) ───────────────────────────────────────────────────────────────────── */
  function results() {
    scaleOff = false;
    var n = run.items.length, r = run.right;
    var pct = Math.round((r / n) * 100);
    var st = store();
    var prev = st ? st.bestScore(ctx.unit, run.q.id) : null;
    var isBest = (prev == null || pct > prev);
    if (st) {
      st.recordScore(ctx.unit, run.q.id, pct);
      st.noteAnswers(ctx.unit, run.q.id, run.answers);
    }
    var q = run.q;

    /* ⭐ THE RESULTS SCREEN FILLS THE SCREEN (owner, 2026-09-20: "everything is very top heavy,
       bottom 2/3 of screen nearly is white"). The score is the whole point of the screen, so it
       takes the space: the block centres in the sheet and the actions sit under it rather than
       everything bunching at the top of a tall phone viewport. */
    render('<div class="tq-fill tq-fill-res">'
      + head(q.name, '', false, q.icon)
      + '<div class="tq-res"><div class="tq-pct">' + pct + '%</div>'
      + '<div class="tq-raw">' + r + ' of ' + n + ' right</div>'
      + '<div class="tq-best' + (isBest ? ' tq-newbest' : '') + '">'
      + (isBest ? 'Your best yet' : 'Your best is ' + prev + '%') + '</div>'
      + (q.id === 4 ? '<p class="tq-say tq-selfnote">You marked this one yourself, so it is not '
          + 'comparable with the other quizzes.</p>' : '')
      + '</div>'
      + '<div class="tq-acts">'
      + '<button type="button" class="startbtn t-again">Try again</button>'
      + '<button type="button" class="tq-exit">&larr; All four quizzes</button>'
      + '<button type="button" class="tq-return">&larr; ' + esc(ctx.originLabel || 'Back') + '</button>'
      + '</div></div>');
    wireClose();
    var againPrefs = run.prefs;
    sheet.querySelector('.t-again').onclick = function () { start(q.id, againPrefs); };
    /* ⛔ The FOUR-TYPE picker, not this quiz's settings menu (owner, 2026-09-20: "it should take
       you to the main quiz menu with the four quiz types"). */
    sheet.querySelector('.tq-exit').onclick = function () { run = null; openPicker(); };
    sheet.querySelector('.tq-return').onclick = goBack;
    if (st) st.flush();
  }


  /* ══════════════════════════════════════════════════════════════════════════════════════
     PHASE 4 BOOTSTRAP — OWNER-GATED ENTRY (§10, §9.2)
     ══════════════════════════════════════════════════════════════════════════════════════
     ⛔ The ONLY entry point in Phase 4 is one button at the BOTTOM of a topic page, under all
     the sentences. NOT the card strip and NOT the Progress columns — those are public surfaces
     across 113 units and belong to Phase 8.

     ⚠ "At the bottom, under all the sentences" is the spec, not a suggestion (§9.2): someone
     arrives at a topic to LISTEN, and the quiz is what they reach when they are done. It must
     not compete with the player or interrupt the reading flow.

     ⚠ THIS IS PRIVACY, NOT SECURITY, AND THAT IS FINE HERE — nothing is entitled by it and the
     sentences are already public. Same SHA-256-of-the-lowercased-address pattern as ownersim.js
     (⛔ the plain address must never appear in a file — Golden Rule 0 covers the owner's own). */
  var OWNER_SHA = ['f158e8ba0177149ebd33d06f08ac400709d39133f9f366f7bdb3ac17bcb1c171'];

  function ownerEmail() {
    try {
      var id = JSON.parse(localStorage.getItem('thaiear_identity') || 'null');
      var e = id && id.user && id.user.email;
      return e ? String(e).trim().toLowerCase() : '';
    } catch (_) { return ''; }
  }
  /* Defensive throughout: anything missing (TextEncoder, subtle on a non-secure origin) must mean
     "not the owner", never an exception. */
  function isOwner() {
    var e = ownerEmail(), sub, enc;
    try {
      sub = window.crypto && window.crypto.subtle;
      enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
    } catch (_) { return Promise.resolve(false); }
    if (!e || !sub || !enc) return Promise.resolve(false);
    return sub.digest('SHA-256', enc.encode(e)).then(function (buf) {
      var h = Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return (b + 0x100).toString(16).slice(1);
      }).join('');
      return OWNER_SHA.indexOf(h) >= 0;
    }).catch(function () { return false; });
  }

  /* ⭐ THE ENTRY IS A FEATURE, NOT AN AFTERTHOUGHT (owner, 2026-09-20: "please make it more
     prominent … its a great feature. and shouldnt be an afterthought").
     A single quiet button under the sentences was easy to scroll past, and it also said nothing
     about what was behind it. This is a titled block with the four quizzes named in a 2x2 grid —
     which does three things at once: it takes real space, it says what you get, and each tile is
     a SHORTCUT straight into that quiz rather than decoration. It also carries each quiz's best
     score, so the block is worth looking at on a return visit.

     ⛔ TIER-COLOURED, from the page's own tier (owner: "blue/purple for free, gold for premium
     in keeping with the page's style"). ⚠ The gold pair is the TEXT gold #B29234 on #FBF5DC, not
     the graphic gold #F0CC5C — the palette rule is that the bright gold is for graphics and the
     darker one for anything bearing text, and the topic card's own premium pill already uses
     exactly this pair. Matching it is what makes the block look like part of the page. */
  function mountButton() {
    if (document.getElementById('tq-entry')) return;
    var t = T();
    if (!t || !(t.sentences || []).length || !t.quiz) return;   /* no authored data: no block */

    var premium = (t.tier === 'premium');
    var unit = location.pathname.replace(/^.*\//, '').replace(/\.html$/, '');
    var st = store();

    /* ⚠ A COLOUR PER QUIZ, from tints the stylesheet already has — the accent and the
       right/wrong pair. Inventing four hues for one component is how a palette drifts.
       ⛔ GOLD IS NOT ONE OF THEM, though the owner offered it. Gold is this site's PREMIUM
       signifier, so a gold tile on a free topic would say something untrue — and on a premium
       unit it would vanish into the block's own gold ground. The fourth is a slate.
       ⛔ AND NO SCORE ON THE TILE. It showed a dash per row and the owner had to ask what they
       were; worse, the dash was not even honest — bestScore() reads the LOCAL mirror and this
       block renders at page load, before any pull(), so an account WITH scores shows four
       dashes on a device that has not synced yet. The scores live in My Results, which is
       reached from the picker and therefore after a pull. */
    var TINT = { 3: 'v', 1: 'l', 2: 'b', 4: 's' };
    var tiles = QUIZZES.map(function (q) {
      return '<button type="button" class="tqe-tile t-' + TINT[q.id] + '" data-q="' + q.id + '">'
        + '<span class="tqe-ic">' + q.icon + '</span>'
        + '<span class="tqe-nm">' + esc(q.name) + '</span>'
        + '</button>';
    }).join('');

    var wrap = document.createElement('div');
    wrap.id = 'tq-entry';
    wrap.className = 'tq-entry' + (premium ? ' premium' : '');
    wrap.innerHTML =
        '<div class="tqe-head">'
      + '<h2 class="tqe-t">Test yourself on this topic</h2>'
      + '<p class="tqe-s">Four ways to practise what you have just heard</p>'
      + '</div>'
      + '<div class="tqe-grid">' + tiles + '</div>'
      + '<button type="button" class="tqe-go">Choose a quiz</button>'
      + '<p class="tqe-note">Owner-only while this is in testing.</p>';

    /* after the sentence list, wherever it ends. ⚠ Fall back to <main> then body — a topic page
       whose markup shifts must still get the block rather than silently not. */
    /* ⭐ WARM THE MASCOT (owner, 2026-09-20: "the tiger always loads v slowly. no issue with
       other images"). It is the SMALLEST of the site's mascots — 34KB against gecko's 122KB — so
       the cause is not weight, it is timing: every other mascot is in its page's initial HTML and
       is fetched during page load, while the tiger's first request happens at the instant the
       picker renders, which is the one moment it has to already be there.
       ⛔ NOT a PRECACHE entry: that is paid for by every device on every VERSION bump, for an
       image only the owner can currently see. This block is owner-gated, so warming it here costs
       exactly the people who will use it and nobody else.
       ⚠ Fire-and-forget, after the block is in the DOM, so it cannot delay the page. */
    try {
      var warm = new Image();
      warm.decoding = 'async';
      warm.src = 'tiger.png';
    } catch (_) {}

    var list = document.getElementById('sentence-list');
    if (list && list.parentNode) list.parentNode.insertBefore(wrap, list.nextSibling);
    else (document.querySelector('main') || document.body).appendChild(wrap);

    function open(qid) {
      window.ThaiEarQuiz.open({
        unit: unit,
        unitName: (document.querySelector('h1') || {}).textContent || document.title,
        kind: 'topic',
        originHref: location.pathname,
        originLabel: 'Back to the topic',
        start: qid || null
      });
    }
    wrap.querySelector('.tqe-go').onclick = function () { open(); };
    wrap.querySelectorAll('.tqe-tile').forEach(function (b) {
      b.onclick = function () { open(parseInt(b.dataset.q, 10)); };
    });
  }

  function boot() {
    if (!T() || !T().quiz) return;        /* only the pilot units carry quiz data */
    isOwner().then(function (ok) { if (ok) mountButton(); });
  }
  /* ⚠ Wait for DOMContentLoaded: the sentence list is SSR'd but this file may be deferred, and
     the identity record is read synchronously from localStorage, not from a live session. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  /* Auth can resolve after first paint (identity.js writes the marker, then auth.js confirms), so
     re-check once on the auth event. ⚠ Latched by the getElementById guard in mountButton. */
  try { window.addEventListener('thaiear:auth', boot); } catch (_) {}

  /* ══════════════════════════════════════════════════════════════════════════════════════
     PUBLIC API — one picker component, several call sites (§9.2)
     ══════════════════════════════════════════════════════════════════════════════════════ */
  window.ThaiEarQuiz = {
    /* opts: { unit, unitName, kind, originHref, originLabel } */
    open: function (opts) {
      opts = opts || {};
      if (!T() || !(T().sentences || []).length) return false;
      ctx = {
        unit: opts.unit || (location.pathname.replace(/^.*\//, '').replace(/\.html$/, '') || 'unknown'),
        unitName: opts.unitName || document.title.split('—')[0].trim(),
        kind: opts.kind || 'topic',
        originHref: opts.originHref || location.pathname,
        originLabel: opts.originLabel || 'Back to the topic'
      };
      var st = store();
      /* ⚠⚠ REPAINT WHEN THE PULL LANDS. bestScore() reads the LOCAL mirror, and on a device
         that has not synced yet that mirror is empty — so the picker painted "—" against every
         quiz for an account that HAS scores, and never corrected itself because nothing
         re-rendered. The UI still does not WAIT on the pull; it just stops ignoring the answer.
         ⚠ Guarded on the picker still being the visible screen: by the time a network round trip
         finishes the learner may be three questions into a quiz, and re-rendering then would
         throw the question away. */
      if (st && st.pull) {
        st.pull().then(function (ok) {
          if (ok && ov && !ov.hidden && sheet && sheet.querySelector('.qpick')) openPicker();
        }).catch(function () {});
      }
      /* ⚠ A tile on the entry block is a SHORTCUT into one quiz; the block's own button opens
         the picker. Both land in the same component (§9.2) — this only chooses the first screen. */
      if (opts.start) openMenu(opts.start); else openPicker();
      return true;
    },
    close: close,
    /* test seam */
    _accepts: accepts,
    _quizzes: QUIZZES
  };
})();
