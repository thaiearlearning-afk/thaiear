/* ============================================================
   v.js — controller for a small allow-listed area (functions/api/vault.js).
   ------------------------------------------------------------
   PUBLIC and deliberately generic. Every name, label, sentence and language comes from the private
   data that /api/vault returns to an allowed, signed-in account; this file names none of them. For
   anyone else the page stays an empty shell: signed out, nothing is even requested.

   What it does, in order:
     1. waits for the account; installs the area's own plays store (wrapAuth) BEFORE the player loads;
     2. reads the area's data — /api/vault online, else this device's saved copy (thaiear-dl
        /v-data/…), and only if that copy was saved for THIS account (te_v_uid);
     3. renders the menu (?t absent) or one unit (?t=<key>): builds window.ThaiEarTopic with cfg.vault
        (player.js / quiz.js read every area-specific choice from there) and injects player.js + quiz.js.

   ⛔ Rules that hold it together (owning doc: the vault BUILD.md in the tooling repo):
     · ONE staleness predicate, isStale(), read by the card AND the page (cfg.vault.stale) —
       DOWNLOAD_UPDATE_PATH.md §0. Its one signal is the unit's `dv`, which covers data AND clips.
     · saveData() writes only data whose dv equals the published one, and only a download may move
       the recorded stamp (player.js cachePage(), vaultSaveArmed).
     · plays, listening and quiz results live in `te_v_*` keys on this device only; auth.js
       privateWipe() removes them, with everything else here, on sign-out or a change of account.
   ============================================================ */
(function () {
  'use strict';
  var root = document.getElementById('v-root');
  if (!root) return;

  var DL = 'thaiear-dl';
  var K_ME = '/v-data/me';
  function kT(k) { return '/v-data/t' + k; }
  var LS_UID = 'te_v_uid', LS_LANG = 'te_v_lang', LS_PLAYS = 'te_v_plays';
  var LOCAL = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(location.hostname);
  function href(q) { return (LOCAL ? '/v.html' : '/v') + (q || ''); }
  var tKey = (/[?&]t=(\d+)/.exec(location.search) || [])[1] || null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function jget(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (_) { return null; } }
  function parse(t) { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } }
  function lang() { return lsGet(LS_LANG) === 'en' ? 'en' : 'th'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function A() { return window.ThaiEarAuth || null; }
  /* identity.js answers synchronously, before auth.js has even loaded — which is what lets a
     downloaded unit open from the device at once (player.js mintUid uses the same guess). */
  function guessUid() {
    try {
      var I = window.ThaiEarIdentity, g = (I && I.guess) ? I.guess() : null;
      return (g && g.state === 'in' && g.user && g.user.id) ? g.user.id : null;
    } catch (_) { return null; }
  }
  function uid() { var a = A(), u = a && a.getUser && a.getUser(); return (u && u.id) || guessUid(); }

  /* ── 1. the account ─────────────────────────────────────────────────────────────────────── */
  function waitAuth() {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function tick() {
        var a = A();
        if (a && a.isReady) return res(a.getUser ? a.getUser() : null);
        if (Date.now() - t0 > 12000) return res(a && a.getUser ? a.getUser() : null);
        setTimeout(tick, 80);
      })();
    });
  }

  /* The area's plays and listening never touch the account's counters, the Progress page or the
     server: player.js asks window.ThaiEarAuth, so on THIS page that object answers from `te_v_plays`.
     Everything else (the session, the token, the user) passes through to auth.js unchanged. */
  function playsGet() {
    var o = jget(LS_PLAYS), me = uid();
    if (!o || o.u !== me) o = { u: me, c: {}, r: {} };
    return o;
  }
  /* ⛔ WRAPPED THE MOMENT auth.js ASSIGNS IT, not after it is ready: a downloaded unit opens before
     auth resolves, and not one play may reach the account's counters in between. auth.js attaches
     playlists / dynPrefs / favourites AFTER creating the object (window.ThaiEarAuth.x = …), so those
     three are accessors on the wrapper: reads answer "none here", writes go through to the real one. */
  function interceptAuth() {
    var real = window.ThaiEarAuth ? wrapAuth(window.ThaiEarAuth) : undefined;
    try {
      Object.defineProperty(window, 'ThaiEarAuth', { configurable: true, enumerable: true,
        get: function () { return real; },
        set: function (v) { real = (v && !v.__vWrapped) ? wrapAuth(v) : v; } });
    } catch (_) {}
  }
  function wrapAuth(a) {
    var W = Object.create(a);
    W.__vWrapped = true;
    W.getPlays = function () { return uid() ? playsGet().c : {}; };
    W.getPlayReps = function () { return uid() ? playsGet().r : {}; };
    W.getPlayCount = function (n) { return uid() ? (playsGet().c[String(n)] || 0) : 0; };
    W.getPlayRepCount = function (n) { return uid() ? (playsGet().r[String(n)] || 0) : 0; };
    W.loadPlays = function () { return Promise.resolve(W.getPlays()); };
    W.isPlaysLoaded = function () { return true; };
    W.notePlay = function (num, n, reps) {
      if (!uid()) return;
      var o = playsGet(), k = String(num);
      o.c[k] = (o.c[k] || 0) + (n || 1);
      o.r[k] = (o.r[k] || 0) + (reps || n || 1);
      lsSet(LS_PLAYS, JSON.stringify(o));
      try { window.dispatchEvent(new CustomEvent('thaiear:auth', { detail: a.getUser() })); } catch (_) {}
    };
    W.flushPlays = function () { return Promise.resolve(); };
    W.getPlayStats = function () { return { daysListened: 0, streak: 0, bestStreak: 0, lastListenDate: null }; };
    var P0 = { goal: 5, topics: {} };
    W.getProgressData = function () { return P0; };
    W.isProgressLoaded = function () { return true; };
    W.getTopicProgress = function () { return 0; };
    W.loadProgress = function () { return Promise.resolve(P0); };
    ['addProgress', 'removeProgress', 'setProgressGoal', 'resetProgress'].forEach(function (m) {
      W[m] = function () { return Promise.resolve(P0); };
    });
    ['dynPrefs', 'playlists', 'favourites'].forEach(function (k) {   // settings stay on this device; no playlists
      Object.defineProperty(W, k, { configurable: true, get: function () { return null; },
        set: function (v) { a[k] = v; } });
    });
    W.canDesktopDownload = function () { return false; };
    return W;
  }
  interceptAuth();

  /* ── 2. the data ────────────────────────────────────────────────────────────────────────── */
  function fetchT(url, opts, ms) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (ctl) opts.signal = ctl.signal;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }
  /* /api/ is never cached by sw.js, so this is the network or nothing. */
  function api(q) {
    var a = A(), tok = (a && a.getAccessToken) ? a.getAccessToken() : null;
    if (!tok) return Promise.resolve(null);
    return fetchT('/api/vault?' + q, { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store',
      credentials: 'same-origin' }, 9000)
      .then(function (r) { return (r && r.ok) ? r.text() : null; })
      .catch(function () { return null; });
  }
  function cacheText(key) {
    if (!window.caches) return Promise.resolve(null);
    return caches.open(DL).then(function (c) { return c.match(key); })
      .then(function (r) { return r ? r.text() : null; }).catch(function () { return null; });
  }
  function cachePut(key, text) {
    if (!window.caches) return Promise.resolve(false);
    return caches.open(DL).then(function (c) {
      return c.put(key, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    }).then(function () { return true; }).catch(function () { return false; });
  }
  /* A saved copy is read only by the account it was saved for (privateWipe also removes it). */
  function mine(u) { return !!u && lsGet(LS_UID) === u; }

  var ME = null;
  function topicOf(me, k) {
    var ts = (me && me.topics) || [];
    for (var i = 0; i < ts.length; i++) if (String(ts[i].key) === String(k)) return ts[i];
    return null;
  }
  function loadMe(u) {
    return api('q=me').then(function (t) {
      var me = parse(t);
      if (me) { lsSet(LS_UID, u); cachePut(K_ME, t); return me; }
      return mine(u) ? cacheText(K_ME).then(parse) : null;
    });
  }
  function loadTopic(u, k) {
    return api('q=t' + k).then(function (t) {
      var d = parse(t);
      if (d) return d;
      return mine(u) ? cacheText(kT(k)).then(parse) : null;
    });
  }

  /* ⛔ THE ONE STALENESS PREDICATE (card + page). A download is stale when the stamp it recorded
     (`ver`, written by player.js cachePage() from data it saved and checked) is not the unit's
     published dv. '' — a first download whose data save failed — is stale, which is true. */
  function isStale(k, e) {
    var t = topicOf(ME, k);
    return !!(t && e && e.ver !== t.dv);
  }
  /* The verified save, called by player.js cachePage(). Fetches the unit and the menu (which holds
     the published dv) past the worker, writes only a matching pair, and resolves with the dv saved.
     `onlyIf`: a self-heal may only re-save data whose dv equals the stamp already recorded. */
  function saveData(k, onlyIf) {
    return Promise.all([api('q=t' + k), api('q=me')]).then(function (r) {
      var d = parse(r[0]), me2 = parse(r[1]), t2 = topicOf(me2, k);
      if (!d || !t2 || d.dv !== t2.dv) return null;
      if (onlyIf != null && d.dv !== onlyIf) return null;
      return cachePut(kT(k), r[0]).then(function (ok) {
        if (!ok) return null;
        cachePut(K_ME, r[1]);
        ME = me2;
        return d.dv;
      });
    });
  }

  /* The translation-language switch, IN PLACE (owner, 2026-10-06: a reload was "very jarring").
     player.js and quiz.js hold THE SAME sentence and card objects as cfg, so rewriting their fields
     here is enough; player.js's ThaiEarPlayerRelang() then redraws, relabels and rebuilds the dyn
     session exactly as a setting change does. Called by the page toggle and the quiz menu's radio. */
  var D = null;                                    // the open unit's data, kept for the switch
  function setLang(l) {
    l = (l === 'en') ? 'en' : 'th';
    if (l === lang()) return;
    lsSet(LS_LANG, l);
    var cfg = window.ThaiEarTopic, v = cfg && cfg.vault;
    if (!v || !D || !ME) return;                   // the menu has no switch
    var gi = (l === 'en') ? 1 : 2, ui = ME.ui || {};
    v.gloss = (l === 'en') ? 'EN' : 'TH';
    v.glossAlt = (l === 'en') ? 'TH' : 'EN';
    v.glossKey = l;
    v.glossName = (ui.quizLang || {})[l];
    ME.topics.forEach(function (t) { v.names[t.prefix] = t['name_' + l] || t.name_en; });
    (cfg.dynChain || []).forEach(function (c) { c.name = v.names[c.prefix] || c.name; });
    D.sentences.forEach(function (src, i) {
      var s = cfg.sentences[i];
      if (!s) return;
      var pv = firstContent(src.chips, gi);
      s.preview = pv[0]; s.previewEn = pv[1];
      s.english = src[l];
      s.gloss = src.chips.map(function (c) { return [c[0], c[gi], '']; });
      s.cultural = src['note_' + l] || '';
    });
    D.vocab.forEach(function (c, i) { if (cfg.quiz.q3[i]) cfg.quiz.q3[i].en = c[l]; });
    D.pool.forEach(function (c, i) { if (cfg.quiz.q3x[i]) cfg.quiz.q3x[i].en = c[l]; });
    document.body.classList.toggle('v-th', l === 'th');
    root.querySelectorAll('.v-toggle button').forEach(function (b) {
      var on = b.getAttribute('data-l') === l;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var sub = root.querySelector('.v-sub-h');
    if (sub) sub.textContent = D['name_' + l] || D.name_en;
    root.querySelectorAll('.topic-nav-btn').forEach(function (a) {
      var t = topicOf(ME, (/[?&]t=(\d+)/.exec(a.getAttribute('href')) || [])[1]);
      var nm = a.querySelector('.topic-nav-name');
      if (t && nm) nm.textContent = t['name_' + l] || t.name_en;
    });
    document.querySelectorAll('input[name=vlang]').forEach(function (r) { r.checked = (r.value === l); });
    if (window.ThaiEarPlayerRelang) window.ThaiEarPlayerRelang();
  }

  /* ── 3a. the menu ───────────────────────────────────────────────────────────────────────── */
  function manifest() { return jget('thaiear_offline') || {}; }
  function dlState(t) {
    var e = manifest()[t.prefix];
    if (!e) return '';
    var owns = !e.refs || e.refs.indexOf('topic') >= 0;
    if (!owns || !e.need || (e.files || []).length < e.need) return '';
    return isStale(t.key, e) ? 'upd' : 'dl';
  }
  function humanTime(sec) {
    var mins = Math.round((sec || 0) / 60), h = Math.floor(mins / 60), m = mins - h * 60;
    return h ? h + 'h ' + m + 'min' : m + ' min';
  }
  function listenSecs(t) {
    var r = playsGet().r, s = 0;
    (t.secs || []).forEach(function (x) { var n = r[String(x[0])]; if (n) s += x[1] * n; });
    return s;
  }
  var TICK = '<span class="dl-badge" title="Downloaded" aria-label="Downloaded"><span class="dl-tick">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></span>';
  var UPD = '<span class="dl-select dl-update" title="Update available" aria-label="Update available">' +
    '<span class="dl-dot"></span></span>';

  function renderMenu(me) {
    var T = window.ThaiEarTopics, L = lang(), ui = me.ui || {};
    if (!T || !T.cardHtml) return;
    var css = document.getElementById('v-menu-css');
    if (css) css.media = 'all';
    root.className = 'tp-wrap tp-wide';
    var cards = me.topics.map(function (t) {
      var u = { page: 'v-' + t.key + '.html', name: t.name_de || t['name_' + L], sentences: t.n, audio: t.prefix };
      return T.cardHtml(u, { fav: false, pill: false, eq: false, quiz: true, quizIds: [3, 4],
        href: href('?t=' + t.key), quizHref: href('?t=' + t.key + '&quiz=menu') });
    }).join('');
    root.innerHTML = '<header class="v-menu-head"><h1>' + esc(ui.title || '') + '</h1></header>' +
      '<div class="topic-grid" id="tp-grid">' + cards + '</div>';
    /* the unit's name in the learner's own language, under the target-language title */
    me.topics.forEach(function (t) {
      var nm = root.querySelector('.topic-card[data-audio="' + t.prefix + '"] .topic-name');
      if (nm) nm.insertAdjacentHTML('afterend', '<span class="v-sub">' + esc(t['name_' + L] || t.name_en) + '</span>');
    });
    paintMenu(me);
    window.addEventListener('thaiear:auth', function () { paintMenu(ME); });   // ME: refreshMe() may replace it
  }
  /* Listening time, the download mark and the quiz figures — the area's own, from its own stores. */
  function paintMenu(me) {
    var st = window.ThaiEarQuizStore, ui = me.ui || {}, names = (ui.quiz || {});
    me.topics.forEach(function (t) {
      var card = root.querySelector('.topic-card[data-audio="' + t.prefix + '"]');
      if (!card) return;
      var cap = card.querySelector('.topic-plays');
      if (cap) cap.textContent = (ui.listen || '') + ': ' + humanTime(listenSecs(t));
      var slot = card.querySelector('.topic-meta-row'), want = dlState(t);
      var mark = slot && slot.querySelector('.dl-badge, .dl-select');
      if (slot && (mark ? mark.getAttribute('data-state') : '') !== want) {
        if (mark) mark.parentNode.removeChild(mark);
        if (want) {
          var h = document.createElement('span');
          h.innerHTML = want === 'dl' ? TICK : UPD;
          h.firstChild.setAttribute('data-state', want);
          slot.appendChild(h.firstChild);
        }
      }
      card.querySelectorAll('.tqs-c').forEach(function (c) {
        var q = c.getAttribute('data-q');
        if (names[q]) c.title = names[q].name;
        var b = st && st.bestScore ? st.bestScore(t.prefix, +q) : null;
        c.textContent = (b == null) ? '—' : (b + '%');
      });
    });
  }

  /* ── 3b. one unit ───────────────────────────────────────────────────────────────────────── */
  function firstContent(chips, gi) {
    for (var i = 0; i < chips.length; i++) {
      var g = String(chips[i][gi] || '');
      if (g && g.charAt(0) !== '(') return [chips[i][0].replace('...', ' … '), g];
    }
    return [chips.length ? chips[0][0] : '', ''];
  }
  function buildCfg(me, d, k) {
    var L = lang(), gi = (L === 'en') ? 1 : 2, ui = me.ui || {};
    var names = {};
    me.topics.forEach(function (t) { names[t.prefix] = t['name_' + L] || t.name_en; });
    var chain = me.topics.map(function (t) {
      return { page: 'v?t=' + t.key, prefix: t.prefix, tier: 'member', name: names[t.prefix],
        dynKey: t.prefix, nums: (t.secs || []).map(function (x) { return x[0]; }), noStd: true };
    });
    return {
      dyn: true, style2: true, ssr: false, tier: 'member',
      audioPrefix: d.prefix, dynKey: d.prefix, quizUnit: d.prefix,
      dynChain: chain, dynChainWrap: true,
      sentences: d.sentences.map(function (s) {
        var pv = firstContent(s.chips, gi);
        return { num: s.num, display: s.label, preview: pv[0], previewEn: pv[1],
          thai: s.de, translit: null, english: s[L],
          gloss: s.chips.map(function (c) { return [c[0], c[gi], '']; }),
          cultural: s['note_' + L] || '' };
      }),
      quiz: {
        q3: d.vocab.map(function (c) {
          return { th: c.de, en: c[L], tl: '', pos: c.pos, num: c.num, hl: c.hl, xt: c.xt,
            appears: c.appears, first: c.first };
        }),
        q3x: d.pool.map(function (c) { return { th: c.de, en: c[L], tl: '', pos: c.pos }; })
      },
      vault: {
        target: 'DE', gloss: L === 'en' ? 'EN' : 'TH', glossAlt: L === 'en' ? 'TH' : 'EN', glossKey: L,
        targetName: ui.lang, glossName: (ui.quizLang || {})[L], ui: ui, quizzes: [3, 4], names: names,
        stale: function (e) { return isStale(k, e); },
        saveData: function (onlyIf) { return saveData(k, onlyIf); },
        setLang: setLang
      }
    };
  }
  function renderTopic(me, d, k) {
    var L = lang(), ui = me.ui || {}, i, idx = -1;
    for (i = 0; i < me.topics.length; i++) if (String(me.topics[i].key) === String(k)) idx = i;
    var name = d.name_de || d['name_' + L], sub = d['name_' + L] || d.name_en;
    document.title = name + ' — ThaiEar';
    if (L === 'th') document.body.classList.add('v-th');
    var pair = ui.pair || {};
    function tbtn(l) {
      return '<button type="button" data-l="' + l + '"' + (l === L ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') +
        '>' + esc(pair[l] || l) + '</button>';
    }
    function navBtn(t, dir) {
      if (!t) return '<span></span>';
      return '<a class="topic-nav-btn topic-nav-' + (dir < 0 ? 'left' : 'right') + '" href="' + esc(href('?t=' + t.key)) + '">' +
        (dir < 0 ? '<span>←</span>' : '') +
        '<span><span class="topic-nav-label">' + (dir < 0 ? 'Previous' : 'Next') + '</span><br>' +
        '<span class="topic-nav-name">' + esc(t['name_' + L] || t.name_en) + '</span></span>' +
        (dir > 0 ? '<span>→</span>' : '') + '</a>';
    }
    root.className = 'page-wrap';
    root.innerHTML = '<h1 class="topic-title">' + esc(name) + '</h1>' +
      '<p class="v-sub v-sub-h">' + esc(sub) + '</p>' +
      '<div class="v-toggle" role="group">' + tbtn('th') + tbtn('en') + '</div>' +
      '<div id="player-root"></div>' +             // player.js builds its own #sentence-list inside

      '<nav class="topic-nav" aria-label="Topic navigation">' +
      navBtn(me.topics[idx - 1], -1) + navBtn(me.topics[idx + 1], 1) + '</nav>';
    root.querySelectorAll('.v-toggle button').forEach(function (b) {
      b.onclick = function () { setLang(b.getAttribute('data-l')); };
    });
    D = d;
    window.ThaiEarTopic = buildCfg(me, d, k);
    ['player.js', 'quiz.js'].forEach(function (src) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;              // player.js before quiz.js, as on a topic page
      document.body.appendChild(s);
    });
  }

  /* ── boot ───────────────────────────────────────────────────────────────────────────────────
     ⛔ NOT html.te-plays (the band pages' caption reserve): player-dyn-mount.css, loaded here too,
     has `.te-plays { display: none }` for its own element, which hides the whole document. */
  function show(me, d) {
    ME = me;
    if (!tKey) { root.hidden = false; renderMenu(me); return true; }
    if (!topicOf(me, tKey) || !d || !d.sentences) return false;
    root.hidden = false;
    renderTopic(me, d, tKey);
    return true;
  }
  /* The menu file is the one place the published stamps live: refreshing it is how a unit opened
     from the device learns an update exists. Card and page then re-ask the ONE predicate. */
  function refreshMe() {
    return waitAuth().then(function (u) {
      if (!u || !u.id) return;
      return api('q=me').then(function (t) {
        var me2 = parse(t);
        if (!me2 || !me2.topics) return;
        lsSet(LS_UID, u.id);
        cachePut(K_ME, t);
        ME = me2;
        if (!tKey) paintMenu(ME);
        else if (window.ThaiEarPlayerRecheck) window.ThaiEarPlayerRecheck();
      });
    }).catch(function () {});
  }
  function fromNetwork() {
    return waitAuth().then(function (u) {
      if (!u || !u.id) return;                     // signed out: the shell stays empty
      return Promise.all([loadMe(u.id), tKey ? loadTopic(u.id, tKey) : null]).then(function (r) {
        if (r[0] && r[0].topics) show(r[0], r[1]); // not allowed, or nothing saved here: empty
      });
    });
  }
  /* ⭐ A DOWNLOADED UNIT OPENS FROM THE DEVICE AT ONCE (owner, 2026-10-06: "can it just retrieve from
     downloads if downloaded rather than try online?"), like a downloaded topic page. Only for THIS
     account's saved copy (te_v_uid), known synchronously from identity.js; the network is then asked
     in the background, for nothing but the published stamps. The menu does the same with its file. */
  (function boot() {
    var g = guessUid(), e = tKey ? manifest()['X' + tKey] : null;
    if (g && mine(g) && (!tKey || (e && (!e.refs || e.refs.indexOf('topic') >= 0)))) {
      Promise.all([cacheText(K_ME), tKey ? cacheText(kT(tKey)) : null]).then(function (r) {
        var me = parse(r[0]), d = parse(r[1]);
        if (me && me.topics && show(me, d)) { refreshMe(); return; }
        return fromNetwork();
      }).catch(function () {});
      return;
    }
    fromNetwork().catch(function () {});
  })();
})();
