/* pl-quiz.js — the quizzes on a playlist. QUIZ_GO_LIVE_PLAN.md §2.7b + PL-AUTO.
   ──────────────────────────────────────────────────────────────────────────────────────────
   ⭐⭐ A PLAYLIST'S QUIZ CONTENT IS DERIVED FROM ITS OWN SENTENCES, EVERY TIME IT OPENS.
   Owner, 2026-09-22: "the playlists auto-derive their quiz content based on sentences they
   contain (and update when new sentences added, or conversely when removed)."

   That is the whole design, and it falls out of one decision: nothing is stored per playlist.
   The items are read at load, the units they come from are resolved, those units' authored
   halves are fetched, and the quiz is assembled in memory. Add a sentence and the next open
   includes it; remove one and it is gone. There is no per-playlist artifact to regenerate, no
   cache to invalidate and nothing that can go stale — because there is nothing saved.

   ⛔⛔ WHY NOT READ THE TOPIC PAGES. A playlist mixes topics, so this would mean fetching
   several ~200 KB HTML pages and scraping their data blocks. gen_quiz_data.js publishes the
   authored halves as `quiz-data/<unit>.json` in the SAME pass that writes the page, from the
   SAME object, so the side-car is a projection rather than a second copy — and
   `node gen_quiz_data.js <unit> --check` fails if the two ever disagree.

   ⛔ THREE QUIZZES, NOT FOUR. Vocab Trainer is topic-only (§6.5): a playlist is an arbitrary
   selection across topics, so there is no "this playlist's vocabulary" to curate and nobody to
   approve it. quiz.js already renders three whenever the unit key starts `pl:` — nothing here
   has to ask for that.

   ⚠ THE SYNTHETIC NUMBER IS THE KEY ON THIS PAGE. playlists.html gives every item a
   page-unique `num` (100001+i) because a real sentence number can repeat across a playlist,
   and keeps the real one in `clipNum`. quiz.js keys everything off `s.num`, and player.js's
   quizClipUrl/notePlaySentence resolve `clipNum` for audio and for the listen credit. So the
   merge RE-KEYS the side-cars from the real number to the synthetic one, once, here.
   ────────────────────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var DL_CACHE = 'thaiear-audio-dl';   /* where a downloaded playlist's side-cars are kept */
  var loaded = {};                     /* unit -> Promise<sidecar|null>, memoised per page */

  function T() { return window.ThaiEarTopics; }

  /* ── which units does this playlist draw on? ───────────────────────────────────────────
     ⚠ BY SENTENCE NUMBER, NEVER BY AUDIO PREFIX. A split topic's parts SHARE a prefix
     (topic-13a and topic-13b are both "…_LI1"), so a prefix cannot identify a unit and a
     lookup built on one would silently fetch the wrong half. `topic-sentences.json` is the
     authoritative {page: [nums]} map, it is precached so it resolves offline, and it is the
     same lookup the Progress page and the topic cards already use. */
  function unitsFor(items) {
    var map = window.ThaiEarSentenceNums;
    if (!map) return null;                       /* not in yet — the caller retries */
    var byNum = unitsFor._inv;
    if (!byNum || unitsFor._for !== map) {
      byNum = {};
      Object.keys(map).forEach(function (page) {
        var unit = String(page).replace(/\.html$/, '');
        (map[page] || []).forEach(function (n) { byNum[String(n)] = unit; });
      });
      unitsFor._inv = byNum; unitsFor._for = map;
    }
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      var u = byNum[String(it.clipNum != null ? it.clipNum : it.num)];
      if (u && !seen[u]) { seen[u] = 1; out.push(u); }
    });
    return out;
  }

  /* ── one unit's side-car: the downloaded copy first, then the network ───────────────────
     ⚠ SAME ORDER AS quizClipUrl(), AND FOR THE SAME REASON. A downloaded playlist must be
     able to run its quizzes with no network, and the version-keyed SW cache cannot be relied
     on for that: activate() deletes every cache that is not the current one, so a VERSION bump
     would take the side-cars with it. `thaiear-audio-dl` is one of the three caches that
     deliberately survive a release.
     ⚠ NEVER REJECTS. A unit whose side-car is missing simply contributes no authored data;
     its sentences then fall out of quiz 1 at eligibility and still work in the Builder and in
     Speak Thai. A playlist that half-loads is worth much more than one that fails. */
  /* ── which units actually HAVE a side-car ───────────────────────────────────
     ⛔⛔ WITHOUT THIS, A PLAYLIST FETCHES ONE FILE PER SOURCE UNIT AND MOST OF THEM 404.
     Owner, 2026-09-22: "the loading time to enter a quiz page via the playlist menu can be
     extraordinarily long - i think especially for longer playlists", and he named the cause
     himself: "the quiz is trying to pull quiz sentences that don't exist?" While 6 of 113 units
     are built, a playlist spanning ten units pays ten round trips to learn nothing.
     ⚠ THE COST IS NOT THE 404 ITSELF, IT IS THAT THERE ARE N OF THEM ON A COLD CONNECTION -
     and on a metered or flaky link each one can take seconds before it fails.
     ✅ The manifest is a few hundred bytes, precached, and generated from the directory by
     gen_quiz_data.js - so it cannot drift from what actually exists.
     ⚠ NEVER REJECTS, AND A MISSING MANIFEST MEANS "DO NOT FILTER". An older client, or one
     whose precache predates this file, must keep working exactly as before - degraded to the old
     404 behaviour, never to an empty quiz. That is why the failure value is `null` and not `[]`:
     an empty list would read as "no unit has data" and silently kill every playlist quiz. */
  var manifestP = null;
  function haveList() {
    if (manifestP) return manifestP;
    var url = 'quiz-data/index.json';
    manifestP = (function () {
      var fromDl = (window.caches && caches.open)
        ? caches.open(DL_CACHE).then(function (c) { return c.match('/' + url); })
            .then(function (r) { return r ? r.json() : null; })
            .catch(function () { return null; })
        : Promise.resolve(null);
      return fromDl.then(function (hit) {
        if (hit) return hit;
        return fetch(url).then(function (r) { return r.ok ? r.json() : null; })
                         .catch(function () { return null; });
      });
    })().then(function (m) {
      if (!m || !m.units || !m.units.length) return null;
      var set = {};
      m.units.forEach(function (u) { set[u] = 1; });
      return set;
    }).catch(function () { return null; });
    return manifestP;
  }

  function loadUnit(unit) {
    if (loaded[unit]) return loaded[unit];
    var url = 'quiz-data/' + unit + '.json';
    loaded[unit] = (function () {
      var fromDl = (window.caches && caches.open)
        ? caches.open(DL_CACHE)
            .then(function (c) { return c.match('/' + url); })
            .then(function (r) { return r ? r.json() : null; })
            .catch(function () { return null; })
        : Promise.resolve(null);
      return fromDl.then(function (hit) {
        if (hit) return hit;
        return fetch(url).then(function (r) { return r.ok ? r.json() : null; })
                         .catch(function () { return null; });
      });
    })();
    return loaded[unit];
  }

  /* ── assemble ──────────────────────────────────────────────────────────────────────────
     ⚠ RE-KEYED TO THE SYNTHETIC NUMBER. See the header: quiz.js asks for `s.num`, and on this
     page that is the page-unique id, not the spreadsheet one.
     ⛔ NO q3/q3x — Vocab Trainer is topic-only and the side-cars do not carry them.
     ⚠ A number that appears TWICE in a playlist (the same sentence added from two places) gets
     both copies filled from the one side-car entry, which is right: they are two cards and two
     questions about the same sentence, and the learner sees them as such. */
  function assemble(sentences, cars) {
    var q1 = {}, q2 = {}, enq = {}, bchips = {}, orders = {};
    var byReal = {};
    cars.forEach(function (c) { if (c) byReal[c.unit] = c; });
    /* one flat index over every loaded unit, keyed by the REAL number */
    var flat = { q1: {}, q2: {}, enq: {}, bchips: {}, orders: {} };
    Object.keys(byReal).forEach(function (u) {
      var c = byReal[u];
      ['q1', 'q2', 'enq', 'bchips', 'orders'].forEach(function (k) {
        var src = c[k]; if (!src) return;
        Object.keys(src).forEach(function (n) { flat[k][n] = src[n]; });
      });
    });
    (sentences || []).forEach(function (s) {
      var real = String(s.clipNum != null ? s.clipNum : s.num);
      var mine = String(s.num);
      if (flat.q1[real]) q1[mine] = flat.q1[real];
      if (flat.q2[real]) q2[mine] = flat.q2[real];
      if (flat.enq[real]) enq[mine] = flat.enq[real];
      if (flat.bchips[real]) bchips[mine] = flat.bchips[real];
      if (flat.orders[real]) orders[mine] = flat.orders[real];
    });
    var out = { q1: q1, q2: q2 };
    if (Object.keys(enq).length) out.enq = enq;
    if (Object.keys(bchips).length) out.bchips = bchips;
    if (Object.keys(orders).length) out.orders = orders;
    return out;
  }

  /* ── load quiz.css + quiz.js on demand ─────────────────────────────────────────────────
     ⚠ NOT IN THE PAGE'S OWN <head>/<script> LIST. playlists.html serves TWO views from one
     document — the list of playlists and the ?pl= player — and the list has no quizzes at all.
     Injecting here means the list view never pays for 164 KB of quiz engine.
     ⚠ quiz.js reads window.ThaiEarQuizAudio, which player.js defines, so it must come after
     player.js has run. The caller only reaches this once the player has mounted. */
  var enginePromise = null;
  function loadEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = new Promise(function (resolve, reject) {
      if (window.ThaiEarQuiz) { resolve(); return; }
      if (!document.querySelector('link[href="quiz.css"]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = 'quiz.css';
        document.head.appendChild(l);
      }
      var s = document.createElement('script');
      s.src = 'quiz.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('quiz.js')); };
      document.body.appendChild(s);
    });
    return enginePromise;
  }

  /* ── idle, so the playlist itself never waits ──────────────────────────────────────────
     The block sits at the FOOT of the page, under every sentence, so it has time. Running the
     fetches at idle keeps them off the critical path of a page whose real job is audio.
     ⚠ requestIdleCallback is not on WebKit; the timeout is the fallback, not a belt-and-braces
     extra. */
  function atIdle(fn) {
    if (window.requestIdleCallback) { requestIdleCallback(fn, { timeout: 2500 }); return; }
    setTimeout(fn, 1200);
  }

  function unhide() {
    try { document.documentElement.classList.remove('te-quiz-boot'); } catch (_) {}
  }

  /* ⭐ WARM THE TIGER BEFORE THE PICKER EXISTS — 2026-09-22, reported live: "the tiger picture
     also flashes on first render".
     quiz.js already warms it, but from inside mountButton(), which on a ?quiz= arrival happens
     milliseconds before the picker renders — no time for a fetch AND a decode. Here it starts
     the moment we know a quiz is being opened, which on a playlist is while the side-cars are
     still being fetched.
     ⚠ DECODE, NOT MERELY FETCH. Warming the HTTP cache still leaves the bitmap to be decoded on
     the frame the <img> is inserted, and that is the flash. decode() resolves once the bitmap
     exists. ⚠ Fire-and-forget: it must never delay the quiz it is decorating. */
  var warmed = false;
  function warmTiger() {
    if (warmed) return;
    warmed = true;
    try {
      var im = new Image();
      im.src = 'tiger.png';
      if (im.decode) im.decode().catch(function () {});
    } catch (_) {}
  }

  /* ── the public entry ──────────────────────────────────────────────────────────────────
     opts: { playlist: {id, name}, root: <element to append the block to> } */
  function mount(opts) {
    opts = opts || {};
    var p = opts.playlist, root = opts.root;
    var t = window.ThaiEarTopic;
    if (!p || !root || !t || !(t.sentences || []).length) return;

    /* ⛔ THE ARM'S ONE GATE. §2.1 flips a single constant in topics.js and this comes with it;
       there is deliberately no second condition to remember here. */
    var TT = T();
    if (!TT || !TT.quizGate) return;
    /* ⭐ ?quiz= MEANS "I CAME HERE FOR THE QUIZ", SO NOTHING WAITS — 2026-09-22, reported live:
       "when i hit 'enter quiz' on a playlist, it flashes to the playlist, before going into the
       quiz". That flash was `atIdle`: the idle pass is right for someone who opened the playlist
       to LISTEN and may never scroll to the block, and exactly wrong for someone who asked for
       the quiz by url. Same work, different urgency.
       ⛔ AND THE PAGE IS HIDDEN UP FRONT rather than after the quiz renders. Deciding late is
       what makes it a flash: the playlist paints, then gets covered. `te-quiz-boot` is set
       before anything is fetched and removed if the quiz cannot open, so the failure mode is
       "the playlist appears a moment later", never "a blank page". */
    /* ⚠ THE CLASS IS SET BY A BLOCKING HEAD SCRIPT IN playlists.html, NOT HERE, and that is the
       point: this file runs long after the first paint, so adding it here could only ever hide
       content the learner had already seen — a blink, which is a different ugliness rather than
       a fix. This module's only job with it is to REMOVE it, on every exit. */
    var wanted = /[?&]quiz=/.test(location.search);
    TT.quizGate().then(function (ok) {
      if (!ok) { unhide(); return; }
      if (wanted) { warmTiger(); build(p, root); }
      else atIdle(function () { build(p, root); });
    }, unhide);
  }

  function build(p, root) {
    var t = window.ThaiEarTopic;
    var units = unitsFor(t.sentences);
    /* ⚠ RETRY RATHER THAN GIVE UP. topic-sentences.json is fetched by topics.js and may not be
       in yet; loadSentenceNums() memoises itself, so asking again is free. Without this the
       quiz block would be absent on exactly the loads where the lookup was slow — an
       intermittent missing feature, which is the worst kind to be told about. */
    if (!units) {
      var TT = T();
      if (TT && TT.loadSentenceNums) {
        TT.loadSentenceNums().then(function () {
          if (unitsFor(t.sentences)) build(p, root); else unhide();
        }).catch(unhide);
      } else unhide();
      return;
    }
    if (!units.length) { unhide(); return; }
    /* ⚠ ASK THE MANIFEST FIRST. A null answer means "could not tell" and the old behaviour
       stands; a set means fetch only what exists. */
    /* ⚠ AN EXPLICIT SENTINEL, NOT A FALSY VALUE. A `return null` here would still flow into
       every later .then() in the chain, and the last of them MOUNTS THE ENTRY BLOCK - so "there is
       nothing to ask" would have shipped an entry block over no data. An object identity cannot be
       mistaken for a legitimate result the way null or undefined can. */
    var STOP = {};
    haveList().then(function (have) {
      var want = have ? units.filter(function (u) { return have[u]; }) : units;
      /* ⛔ ONLY when the manifest ANSWERED. `have === null` means it could not be read, and then
         `want` is the full list and the old fetch-and-tolerate-404 behaviour stands. */
      if (have && !want.length) { unhide(); return STOP; }
      /* ⭐⭐ THE ENGINE LOADS IN PARALLEL WITH THE DATA, NOT AFTER IT (owner, 2026-09-22:
         playlist quizzes "are slow to load").
         ⚠⚠ IT USED TO BE STRICTLY SERIAL — `return loadEngine()` sat in the .then AFTER
         Promise.all(loadUnit), so 164 KB of quiz.js + quiz.css did not start downloading until
         the last side-car had landed. The engine does not read the side-cars, so nothing ever
         required that ordering; it was just the shape the chain happened to have. On a playlist
         spanning ten units that is ten round trips of dead time before the biggest asset even
         starts.
         ⚠ STARTED HERE, NOT AT THE TOP OF build(): the STOP branch above means "no unit in this
         playlist has quiz data", and there the engine would be 164 KB fetched for a block that
         is never mounted. Now that all 113 units have data that branch is nearly unreachable,
         but "nearly" is not a reason to spend it.
         ⚠ quiz.js is safe to load early — its own boot() returns immediately on playlistMode
         (v602), so it does nothing until this file calls mountEntry(). */
      var engineP = loadEngine();
      return Promise.all([Promise.all(want.map(loadUnit)), engineP])
        .then(function (both) { return both[0]; });
    }).then(function (cars) {
      if (cars === STOP) return STOP;
      t.quiz = assemble(t.sentences, cars);
      return null;                 /* the engine was already awaited above */
    }).then(function (r) {
      if (r === STOP) return;
      if (!window.ThaiEarQuiz || !window.ThaiEarQuiz.mountEntry) { unhide(); return; }
      /* ⛔ THE SAME COMPONENT, MOUNTED SOMEWHERE ELSE (§2.7b). Owner, 2026-09-21: "at the
         bottom of the playlist under all the sentences there should be the quizzes box (3
         quizzes not 4, horizontal bars, stacking vertically)." The `three` treatment and the
         bar layout come from the unit key starting `pl:` — quiz.js decides that, not this. */
      var ctx = {
        unit: 'pl:' + p.id,
        unitName: p.name,
        mount: root,
        /* ⚠ THE ORIGIN KEEPS ?pl= AND DROPS ?quiz=. "Back to the playlist" must return to the
           playlist, not to the url that opened the quiz — which would reopen it. */
        originHref: location.pathname + location.search.replace(/([?&])quiz=[^&]*(&|$)/, '$1')
                                                       .replace(/[?&]$/, ''),
        originLabel: 'Back to the playlist'
      };
      window.ThaiEarQuiz.mountEntry(ctx);
      /* ⭐ ?quiz=menu — what the pill menu's "Enter quiz" row links to (DECISION 4). quiz.js's
         own bootFromUrl() cannot serve this: it derives the unit from the PATHNAME, which here
         is /playlists, and it runs at DOMContentLoaded, long before this page has built its
         window.ThaiEarTopic. So the playlist reads its own url, once, here.
         ⛔ A slug naming ONE quiz is honoured too, exactly as it is on a topic page — except
         `vocab`, which is topic-only; an unknown or inapplicable slug opens the picker rather
         than guessing or doing nothing. */
      var slug;
      try { slug = new URL(location.href).searchParams.get('quiz'); } catch (_) { slug = null; }
      if (!slug) { unhide(); return; }
      var start = null;
      (window.ThaiEarQuiz._quizzes || []).forEach(function (q) {
        if (q.key === slug && !q.topicOnly) start = q.id;
      });
      window.ThaiEarQuiz.open({
        unit: ctx.unit, unitName: ctx.unitName, kind: 'playlist',
        originHref: ctx.originHref, originLabel: ctx.originLabel, start: start,
        /* ⚠ ARRIVED BY URL, so the quiz must NOT push a second history entry: tapping "Enter
           quiz" already navigated here from the playlist menu. Owner, 2026-09-22 — a back-swipe
           should return to the MENU he left, not to the playlist he passed through. */
        fromUrl: true
      });
      /* ⚠ AFTER open(), not before: the quiz has hidden the page content itself by then, so
         removing the boot class reveals the QUIZ rather than the playlist behind it. Removing
         it earlier would show the playlist for exactly the frame this whole change removes. */
      unhide();
    }).catch(unhide);
  }

  window.ThaiEarPlQuiz = {
    mount: mount,
    /* test seams — the two pieces with real logic in them */
    _unitsFor: unitsFor,
    _assemble: assemble
  };
})();
