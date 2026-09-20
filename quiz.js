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
  var QUIZZES = [
    { id: 3, key: 'vocab', name: 'Vocab Trainer', ds: 'See a word, pick the Thai',
      icon: 'V', step: 10, topicOnly: true },
    { id: 1, key: 'listen', name: 'Listening comprehension', ds: 'Hear Thai, pick the English',
      icon: 'L', step: 10 },
    { id: 2, key: 'build', name: 'Thai Builder', ds: 'See English, build the Thai',
      icon: 'B', step: 5 },
    { id: 4, key: 'speak', name: 'Speak Thai', ds: 'See English, say it aloud, mark yourself',
      icon: 'S', step: 5 }
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
  var HEADSTART = { on: 8, slight: 10, off: 0 };

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

  var DEFAULTS = { len: 10, mode: 'even', hide: false, script: 'both', head: 'on', nodecoy: false };

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
  function translitOn() {
    try { return localStorage.getItem('thaiear_translit') !== '0'; } catch (_) { return true; }
  }
  function setTranslit(on) {
    try { localStorage.setItem('thaiear_translit', on ? '1' : '0'); } catch (_) {}
  }
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
  function headGloss(g) {
    return String(g || '').replace(/\s*\(.*?\)|\s*"[^"]*"/g, '').trim().toLowerCase().replace(/\.$/, '');
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
  function show() { mount(); ov.hidden = false; document.documentElement.style.overflow = 'hidden'; }

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
  function close() { confirmExit(doClose); }
  function render(html) { mount(); sheet.innerHTML = html; sheet.scrollTop = 0; ov.scrollTop = 0; }
  function head(title, sub) {
    return '<div class="tq-head"><h3>' + esc(title) + '</h3>'
         + '<button class="tq-x" type="button" aria-label="Close">&times;</button></div>'
         + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '');
  }
  function wireClose() {
    var x = sheet.querySelector('.tq-x');
    if (x) x.onclick = close;
  }

  /* ── audio ─────────────────────────────────────────────────────────────────────────────── */
  var au = null, auRevoke = null, auCredited = false, auNum = null;
  function stopAudio() {
    if (au) { try { au.pause(); } catch (_) {} }
    if (auRevoke) { try { auRevoke(); } catch (_) {} auRevoke = null; }
    au = null; auNum = null; auCredited = false;
  }
  /* Play a sentence's Thai. ⚠ Credit is gated on a DWELL (≥1.5s heard, or `ended`), never on
     play() — see the note on ThaiEarQuizAudio.credit. Under-counting is the safe direction. */
  function playSentence(num, btn) {
    var QA = window.ThaiEarQuizAudio;
    if (!QA || !QA.clip) return Promise.resolve(false);
    stopAudio();
    auNum = num; auCredited = false;
    if (btn) btn.classList.add('playing');
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
        if (btn) btn.classList.remove('playing');
      });
      au.addEventListener('error', function () { if (btn) btn.classList.remove('playing'); });
      return au.play().then(function () { return true; }).catch(function () {
        if (btn) btn.classList.remove('playing');
        return false;
      });
    }).catch(function () {
      if (btn) btn.classList.remove('playing');
      return false;
    });
  }

  /* ── script mode (§5.1 three-way) ──────────────────────────────────────────────────────── */
  function scriptBits(thai, translit, mode) {
    if (mode === 'thai') return { main: thai, sub: '' };
    if (mode === 'tl')   return { main: translit || thai, sub: '' };
    return { main: thai, sub: translit || '' };
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════
     THE PICKER
     ══════════════════════════════════════════════════════════════════════════════════════ */
  function openPicker() {
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

    render(head('Test yourself', ctx.unitName || '')
         + '<div class="qpick">' + rows + '</div>'
         + '<div class="tq-minor"><button type="button" class="tq-return">&larr; '
         + esc(ctx.originLabel || 'Back') + '</button></div>');
    wireClose();
    sheet.querySelectorAll('.qpick button').forEach(function (b) {
      b.onclick = function () { openMenu(parseInt(b.dataset.q, 10)); };
    });
    sheet.querySelector('.tq-return').onclick = goBack;
    show();
  }

  function goBack() {
    var href = ctx.originHref;
    /* ⚠ Return leaves the quiz as surely as the X does, so it takes the same warning. */
    if (runInProgress()) { confirmExit(function () { doClose(); nav(); }); return; }
    doClose(); nav();
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
    var q = quizById(qid), p = prefsFor(qid);
    var items = eligible(qid);
    var n = items.length;

    /* §3A.1 — 10s for the recognition quizzes, 5s for the two production ones. An option at or
       above the available count is not shown; the row is capped at six plus All. */
    var steps = [];
    for (var v = q.step; v <= q.step * 6 && v < n; v += q.step) steps.push(v);
    var segs = steps.map(function (v) {
      return '<button type="button" class="seg' + (p.len === v ? ' on' : '') + '" data-len="' + v + '">' + v + '</button>';
    }).join('') + '<button type="button" class="seg' + (p.len === 'all' || !steps.length ? ' on' : '')
      + '" data-len="all">All (' + n + ')</button>';

    /* §3A.6 — only shown where the unit actually has a sentence above the cap, otherwise it is a
       control with no possible effect, which is worse than its absence. */
    var maxChips = 0;
    if (qid === 2) items.forEach(function (it) { maxChips = Math.max(maxChips, chipsOf(it.sent).length); });
    var showHead = (qid === 2 && maxChips > HEADSTART.on);

    var html = head(q.name, n + (qid === 3 ? ' words' : ' sentences') + ' available');

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

    if (qid === 2 || qid === 4) {
      html += '<div class="mgroup"><p class="mlab">Thai script</p><div class="radios">'
        + radio('script', 'both', p.script, 'Thai + transliteration', '')
        + radio('script', 'thai', p.script, 'Thai only', 'the hard mode')
        + radio('script', 'tl',   p.script, 'Transliteration only', "if you can't read the script yet")
        + '</div></div>';
    }

    if (qid === 2) {
      html += '<div class="mgroup"><label class="checkrow"><input type="checkbox" class="c-nodecoy"'
        + (p.nodecoy ? ' checked' : '') + '><span>No decoy tiles<br>'
        + '<span class="rd" style="color:var(--text-tertiary);font-size:12px">'
        + 'Every tile belongs in the answer — order only.</span></span></label></div>';
      if (showHead) {
        html += '<div class="mgroup"><p class="mlab">Head start</p><div class="radios">'
          + radio('head', 'on',     p.head, 'On',     'you build the last ' + HEADSTART.on + ' chips')
          + radio('head', 'slight', p.head, 'Slight', 'you build the last ' + HEADSTART.slight)
          + radio('head', 'off',    p.head, 'Off',    'you build the whole sentence')
          + '</div></div>';
      }
    }

    html += '<div class="mgroup"><button type="button" class="exline"><span>Excluded '
      + (qid === 3 ? 'words' : 'sentences') + '</span><b class="ex-n">'
      + Object.keys((store() ? store().excluded(ctx.unit, qid) : {})).length + '</b></button></div>';

    html += '<button type="button" class="startbtn">Start</button>'
      + '<div class="tq-minor">'
      + '<button type="button" class="tq-all">Use these settings for all ' + esc(q.name) + ' quizzes</button>'
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
    sheet.querySelector('.exline').onclick = function () { openExclusions(qid); };
    sheet.querySelector('.startbtn').onclick = function () {
      var cur = readPrefs(); savePrefs(qid, cur); start(qid, cur);
    };
    sheet.querySelector('.tq-all').onclick = function (e) {
      var cur = readPrefs(); savePrefs(qid, cur);
      var st = store(); if (st) st.useEverywhere(ctx.unit, qid);
      e.target.textContent = '✓ Applied to every ' + q.name + ' quiz';
      e.target.classList.add('done');
      e.target.disabled = true;
    };
    sheet.querySelector('.tq-back').onclick = openPicker;
    sheet.querySelector('.tq-return').onclick = goBack;
    show();
  }

  function radio(name, val, cur, label, desc) {
    return '<label class="radio"><input type="radio" name="' + name + '" value="' + val + '"'
      + (cur === val ? ' checked' : '') + '><span class="rt">' + esc(label)
      + (desc ? ' <span class="rd">— ' + esc(desc) + '</span>' : '') + '</span></label>';
  }

  /* ── exclusions (§3A.2) — one list per quiz, re-includable with the same tap ────────────── */
  function openExclusions(qid) {
    var q = quizById(qid), st = store();
    var ex = st ? st.excluded(ctx.unit, qid) : {};
    var rows;
    if (qid === 3) {
      rows = (QD().q3 || []).map(function (w) {
        return '<label class="tq-exitem"><input type="checkbox" data-item="' + esc(w.th) + '"'
          + (ex[w.th] ? ' checked' : '') + '><span><span class="x-th">' + esc(w.th) + '</span>'
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
         + '<button type="button" class="startbtn">Done</button>');
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
    var pctW = Math.round((run.i / run.items.length) * 100);
    /* ⚠ A QUESTION SCREEN NEEDS ITS OWN VISIBLE EXIT. The picker and the menu get one from
       head(), but a question is rendered from bar() — so until this was added the only ways out
       mid-quiz were Escape and a backdrop tap, neither of which is discoverable on a phone,
       where there is no Escape key at all. Found in the browser, not in the diff. */
    return '<div class="qbar">'
      + '<button class="qx" type="button" aria-label="Leave this quiz">&times;</button>'
      + '<span>' + (run.i + 1) + ' / ' + run.items.length + '</span>'
      + '<span class="qprog"><i style="width:' + pctW + '%"></i></span>'
      + '<button class="qopts" type="button" title="Options">&#8943;</button></div>';
  }
  function wireBar() {
    var o = sheet.querySelector('.qopts');
    if (o) o.onclick = inQuestionMenu;
    var x = sheet.querySelector('.qx');
    if (x) x.onclick = close;      /* close() routes through the exit warning */
  }

  function question() {
    if (run.i >= run.items.length) return results();
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
      + '</div><div class="t-rev"></div>');
    wireBar();

    var pb = sheet.querySelector('.playbtn');
    pb.onclick = function () { playSentence(s.num, pb); };
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
    d.innerHTML = '<div class="reveal"><p class="thaibig">' + esc(stripBars(s.thai)) + '</p>'
      + (translitOn() ? '<p class="tl">' + esc(stripBars(s.translit)) + '</p>' : '')
      + '<div class="chips">' + chipsOf(s).map(chipHtml).join('') + '</div>'
      + '<button class="nextbtn" type="button">' + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
    d.querySelector('.nextbtn').onclick = function () { advance(String(s.num), ok); };
  }
  function chipHtml(g) {
    /* ⚠ The per-chip transliteration follows the SITE toggle (§9.3), exactly as the chip on a
       topic page does — .g-tl is what #sentence-list.translit-off hides there. */
    var tl = (g[2] && translitOn()) ? '<span class="tlx">' + esc(g[2]) + '</span>' : '';
    return '<span class="chip"><span class="th">' + esc(g[0]) + '</span>'
      + '<span class="gl">' + esc(g[1]) + '</span>' + tl + '</span>';
  }

  /* ── Quiz 2 — Thai Builder (§5) ────────────────────────────────────────────────────────── */
  function qBuild() {
    var it = run.items[run.i], s = it.sent;
    var canon = chipsOf(s);
    var p = run.prefs;

    /* §3A.6 head start: a CAP, not a fixed prefix. A sentence at or below the cap gets none. */
    var cap = HEADSTART[p.head] || 0;
    var lockN = (cap && canon.length > cap) ? (canon.length - cap) : 0;
    var locked = canon.slice(0, lockN);
    var buildable = canon.slice(lockN);

    var decoys = p.nodecoy ? [] : (QD().q2[String(s.num)] || []).slice(0, MAX_DECOYS);
    var tray = shuffle(buildable.map(function (g) { return { g: g, real: 1 }; })
      .concat(decoys.map(function (th) { return { g: [th, '', ''], real: 0 }; })));

    var placed = [];   /* indexes into tray */

    render(bar()
      + '<p class="enq">' + esc(s.english) + '</p>'
      + (lockN ? '<p class="traylab">Start of the sentence (placed for you)</p>' : '')
      + '<div class="drop"></div>'
      + '<p class="traylab">Tap the tiles in order</p><div class="tray"></div>'
      + '<button class="nextbtn t-submit" type="button" disabled>Check</button>'
      + '<div class="t-rev"></div>');
    wireBar();

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
        + placed.map(function (ti) { return '<span class="tile in" data-p="' + ti + '">'
            + esc(scriptBits(tray[ti].g[0], tray[ti].g[2], p.script).main) + '</span>'; }).join('');
      dropEl.classList.toggle('filled', placed.length > 0);
      trayEl.innerHTML = tray.map(function (t, i) {
        return placed.indexOf(i) >= 0 ? '' : '<span class="tile" data-t="' + i + '">'
          + esc(scriptBits(t.g[0], t.g[2], p.script).main)
          + (p.script === 'both' && t.g[2] ? '<span class="tt">' + esc(t.g[2]) + '</span>' : '') + '</span>';
      }).join('');
      submit.disabled = placed.length === 0;
      trayEl.querySelectorAll('[data-t]').forEach(function (n) {
        n.onclick = function () { placed.push(parseInt(n.dataset.t, 10)); paint(); };
      });
      dropEl.querySelectorAll('[data-p]').forEach(function (n) {
        n.onclick = function () {
          var ti = parseInt(n.dataset.p, 10);
          placed.splice(placed.indexOf(ti), 1); paint();
        };
      });
    }
    paint();

    submit.onclick = function () {
      /* ⛔⛔ THE CHECK RUNS ON THE WHOLE BOX — LOCKED CHIPS INCLUDED — NEVER THE TAIL ALONE
         (§3A.6). Several accepted orders vary in the opening, so checking only what the learner
         placed marks a good sentence wrong. */
      var built = locked.map(function (g) { return g[0]; })
        .concat(placed.map(function (ti) { return tray[ti].g[0]; }));
      var ok = acceptedBy(s.num, built, canon.map(function (g) { return g[0]; }));
      if (!ok) logRejected(s.num, built);
      submit.disabled = true;
      trayEl.querySelectorAll('.tile').forEach(function (n) { n.onclick = null; });
      dropEl.querySelectorAll('.tile').forEach(function (n) { n.onclick = null; });

      /* ⛔ ON SUBMIT THE REAL THAI PLAYS, right or wrong, automatically, once (§5.1). */
      playSentence(s.num, null);

      /* ⭐ THE REVEAL IS ASYMMETRIC (§5.1): a correction is remediation, and remediation is only
         needed when there is something to remediate. A quiz that lectures after a right answer
         is a quiz people stop taking. */
      var d = sheet.querySelector('.t-rev');
      if (ok) {
        d.innerHTML = '<div class="reveal"><p class="opt right" style="margin:0">Correct</p>'
          + '<button class="nextbtn" type="button">'
          + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
      } else {
        /* ⛔⛔ THE WRITTEN CORRECTION HONOURS THE LEARNER'S SCRIPT SETTING. Someone working in
           transliteration must not be handed a wall of Thai at the one moment they are trying to
           learn from a mistake — and the reveal is naturally built from Thai-first data, so this
           is the easiest thing here to get wrong. */
        var b = scriptBits(stripBars(s.thai), stripBars(s.translit), p.script);
        d.innerHTML = '<div class="reveal"><p class="opt wrong" style="margin:0 0 10px">Not quite</p>'
          + '<p class="mlab">The correct order</p>'
          + '<div class="chips">' + canon.map(chipHtml).join('') + '</div>'
          + '<p class="thaibig" style="margin-top:10px">' + esc(b.main) + '</p>'
          + (b.sub ? '<p class="tl">' + esc(b.sub) + '</p>' : '')
          + '<button class="nextbtn" type="button">'
          + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
      }
      d.querySelector('.nextbtn').onclick = function () { advance(String(s.num), ok); };
    };
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

    var wrongs = shuffle(list.filter(function (x) {
      return x.th !== w.th && headGloss(x.en) !== headGloss(w.en) && x.pos === w.pos;
    })).concat(shuffle(list.filter(function (x) {
      return x.th !== w.th && headGloss(x.en) !== headGloss(w.en) && x.pos !== w.pos;
    }))).concat(shuffle(pool.slice()));

    var opts = [{ th: w.th, ok: 1 }];
    if (need === 2) opts.push({ th: twins[0].th, ok: 1 });
    for (var k = 0; opts.length < 4 && k < wrongs.length; k++) {
      if (!opts.some(function (o) { return o.th === wrongs[k].th; })) opts.push({ th: wrongs[k].th, ok: 0 });
    }
    shuffle(opts);

    var hidden = run.prefs.hide;
    render(bar()
      + '<p class="enq">' + esc(w.en) + '</p>'
      + (need === 2 ? '<p class="tl">Select 2</p>' : '')
      + (hidden ? '<button type="button" class="startbtn t-show">Show the options</button>' : '')
      + '<div class="t-opts"' + (hidden ? ' hidden' : '') + '>'
      + opts.map(function (o, i) { return '<button class="opt" type="button" data-i="' + i + '"><span class="o-th">' + esc(o.th) + '</span></button>'; }).join('')
      + '</div><div class="t-rev"></div>');
    wireBar();

    var sh = sheet.querySelector('.t-show');
    if (sh) sh.onclick = function () { sh.remove(); sheet.querySelector('.t-opts').hidden = false; };

    var chosen = [];
    sheet.querySelectorAll('.opt').forEach(function (b) {
      b.onclick = function () {
        var i = parseInt(b.dataset.i, 10);
        /* ⛔⛔ NEITHER SELECTION IS MARKED UNTIL BOTH ARE MADE (§6.3): colouring the first leaks
           the answer to the second, turning a 2-of-4 question into a 1-of-3. */
        var at = chosen.indexOf(i);
        if (at >= 0) { chosen.splice(at, 1); b.classList.remove('picked'); return; }
        chosen.push(i); b.classList.add('picked');
        if (chosen.length < need) return;
        var ok = chosen.every(function (ci) { return opts[ci].ok; }) && chosen.length === need;
        sheet.querySelectorAll('.opt').forEach(function (x, xi) {
          x.disabled = true; x.classList.remove('picked');
          if (opts[xi].ok) x.classList.add('right');
          else if (chosen.indexOf(xi) >= 0) x.classList.add('wrong');
        });
        vocabReveal(w, ok);
      };
    });
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
    var html = '<div class="reveal">';
    if (w.lit) html += '<p class="tq-say"><b>Literally:</b> ' + esc(w.lit) + '</p>';
    if (s) {
      html += '<p class="mlab">Appears in</p>'
        + '<p class="thaibig">' + esc(stripBars(s.thai)) + '</p>'
        + '<p class="tl">' + esc(s.english) + '</p>'
        + '<button class="playbtn" type="button"><span class="tri"></span>Play the sentence</button>';
    }
    html += '<button class="nextbtn" type="button">'
      + (run.i + 1 >= run.items.length ? 'See your score' : 'Next') + '</button></div>';
    d.innerHTML = html;
    var pb = d.querySelector('.playbtn');
    if (pb && s) { pb.onclick = function () { playSentence(s.num, pb); }; playSentence(s.num, pb); }
    d.querySelector('.nextbtn').onclick = function () { advance(w.th, ok); };
  }

  /* ── Quiz 4 — Speak Thai (§6A) ─────────────────────────────────────────────────────────── */
  function qSpeak() {
    var it = run.items[run.i], s = it.sent;
    render(bar()
      + '<p class="enq">' + esc(s.english) + '</p>'
      + '<p class="tq-say">Say it in Thai, out loud. Then reveal and mark yourself — it is your own call.</p>'
      + '<button class="startbtn t-reveal" type="button">Reveal answer</button>'
      + '<div class="t-rev"></div>');
    wireBar();

    sheet.querySelector('.t-reveal').onclick = function () {
      this.remove();
      var b = scriptBits(stripBars(s.thai), stripBars(s.translit), run.prefs.script);
      var d = sheet.querySelector('.t-rev');
      d.innerHTML = '<div class="reveal">'
        + '<p class="thaibig">' + esc(b.main) + '</p>'
        + (b.sub ? '<p class="tl">' + esc(b.sub) + '</p>' : '')
        + '<button class="playbtn" type="button"><span class="tri"></span>Play the Thai</button>'
        + '<div class="chips">' + chipsOf(s).map(chipHtml).join('') + '</div>'
        + '<div class="tq-selfmark">'
        + '<button type="button" class="tq-got">I got it</button>'
        + '<button type="button" class="tq-not">Not quite</button>'
        + '</div></div>';
      var pb = d.querySelector('.playbtn');
      pb.onclick = function () { playSentence(s.num, pb); };
      playSentence(s.num, pb);          /* ⛔ the real Thai plays on reveal (§6A.1) */
      d.querySelector('.tq-got').onclick = function () { advance(String(s.num), true); };
      d.querySelector('.tq-not').onclick = function () { advance(String(s.num), false); };
    };
  }

  /* ── the in-question options menu (§3A.5) ──────────────────────────────────────────────── */
  function inQuestionMenu() {
    var qid = run.q.id, p = run.prefs;
    var cur = run.items[run.i];
    var html = head('Options', 'Applies from the next question');
    if (qid === 2 || qid === 4) {
      html += '<div class="mgroup"><p class="mlab">Thai script</p><div class="radios">'
        + radio('script', 'both', p.script, 'Thai + transliteration', '')
        + radio('script', 'thai', p.script, 'Thai only', '')
        + radio('script', 'tl',   p.script, 'Transliteration only', '')
        + '</div></div>';
    }
    if (qid === 1 || qid === 3) {
      html += '<div class="mgroup"><label class="checkrow"><input type="checkbox" class="c-hide"'
        + (p.hide ? ' checked' : '') + '><span>Hide the answers until I ask</span></label></div>';
    }
    html += '<div class="mgroup"><p class="mlab">Display</p>'
      + '<label class="checkrow"><input type="checkbox" class="c-tl"'
      + (translitOn() ? ' checked' : '') + '><span>Show transliteration</span></label>'
      + '<label class="checkrow"><input type="checkbox" class="c-tf"'
      + (thaiModern() ? ' checked' : '') + '><span>Modern Thai font</span></label></div>';
    html += '<div class="mgroup"><button type="button" class="exline"><span>'
      + 'Don\'t test me on this again <span class="rd" style="color:var(--text-tertiary)">'
      + '— in ' + esc(run.q.name) + ' only</span></span><b class="x-mark"></b></button></div>'
      + '<button type="button" class="startbtn">Back to the question</button>';
    render(html);
    wireClose();
    sheet.querySelector('.exline').onclick = function () {
      var st = store();
      if (st) st.toggleExcluded(ctx.unit, qid, cur.key);
      this.querySelector('.x-mark').textContent = '✓';
      /* ⚠ An exclusion taken mid-run does NOT shorten the run in progress — the item is already
         on the question list and removing it would move the score denominator under the learner. */
    };
    sheet.querySelector('.startbtn').onclick = function () {
      var sc = sheet.querySelector('input[name=script]:checked'); if (sc) run.prefs.script = sc.value;
      var hi = sheet.querySelector('.c-hide'); if (hi) run.prefs.hide = hi.checked;
      /* ⚠ These two are SITE-wide, not quiz prefs — they are deliberately not in run.prefs and
         not synced to quiz_prefs, because the learner set them for the whole site. */
      var tl = sheet.querySelector('.c-tl'); if (tl) setTranslit(tl.checked);
      var tf = sheet.querySelector('.c-tf'); if (tf) setThaiModern(tf.checked);
      savePrefs(qid, run.prefs);
      question();      /* ⚠ re-renders the CURRENT question with the new setting */
    };
  }

  /* ── results (§3B.1) ───────────────────────────────────────────────────────────────────── */
  function results() {
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

    render(head(q.name, '')
      + '<div class="tq-res"><div class="tq-pct">' + pct + '%</div>'
      + '<div class="tq-raw">' + r + ' / ' + n + '</div>'
      + '<div class="tq-best' + (isBest ? ' tq-newbest' : '') + '">'
      + (isBest ? 'Your best yet' : 'Your best is ' + prev + '%') + '</div></div>'
      + (q.id === 4 ? '<p class="tq-say" style="margin-top:14px">You marked this one yourself, so it '
          + 'is not comparable with the other quizzes.</p>' : '')
      + '<button type="button" class="startbtn t-again">Try again</button>'
      + '<div class="tq-minor">'
      + '<button type="button" class="tq-exit">Exit to the quiz menu</button>'
      + '<button type="button" class="tq-return">&larr; ' + esc(ctx.originLabel || 'Back') + '</button>'
      + '</div>');
    wireClose();
    sheet.querySelector('.t-again').onclick = function () { start(q.id, run.prefs); };
    sheet.querySelector('.tq-exit').onclick = function () { openMenu(q.id); };
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

  function mountButton() {
    if (document.getElementById('tq-entry')) return;
    var t = T();
    if (!t || !(t.sentences || []).length || !t.quiz) return;   /* no authored data: no button */

    var wrap = document.createElement('div');
    wrap.id = 'tq-entry';
    wrap.style.cssText = 'max-width:760px;margin:28px auto 40px;padding:0 16px';
    var unit = location.pathname.replace(/^.*\//, '').replace(/\.html$/, '');
    wrap.innerHTML =
      '<button type="button" style="width:100%;background:var(--quiz-bg,#F1F7F3);'
      + 'color:var(--quiz-ink,#1F5D3A);border:0.5px solid var(--quiz-line,rgba(31,93,58,.18));'
      + 'border-radius:var(--radius-md,10px);padding:14px;font:600 15px/1.2 var(--font-ui,Inter,system-ui,sans-serif);'
      + 'cursor:pointer">Test yourself</button>'
      + '<p style="margin:7px 0 0;font:11.5px/1.4 var(--font-ui,Inter,system-ui,sans-serif);'
      + 'color:var(--text-tertiary,#9A9A9A);text-align:center">Owner-only while this is in testing.</p>';

    /* Put it after the sentence list, wherever that ends. ⚠ Fall back to the end of <main>, then
       body — a topic page whose markup shifts must still get the button rather than silently not. */
    var list = document.getElementById('sentence-list');
    var host = (list && list.parentNode) || document.querySelector('main') || document.body;
    if (list && list.parentNode) list.parentNode.insertBefore(wrap, list.nextSibling);
    else host.appendChild(wrap);

    wrap.querySelector('button').onclick = function () {
      window.ThaiEarQuiz.open({
        unit: unit,
        unitName: (document.querySelector('h1') || {}).textContent || document.title,
        kind: 'topic',
        originHref: location.pathname,
        originLabel: 'Back to the topic'
      });
    };
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
      if (st && st.pull) st.pull();      /* best-effort; the UI never waits on it */
      openPicker();
      return true;
    },
    close: close,
    /* test seam */
    _accepts: accepts,
    _quizzes: QUIZZES
  };
})();
