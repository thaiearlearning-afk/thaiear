/* pl-list.js — the shared PLAYLIST LIST module (native-panel refactor, rollout r130).

   WHY THIS EXISTS. The index's Playlists panel used to iframe playlists.html?embed=1. The iframe
   leaked: modals were scoped to the frame, JS navigations caused index-inception (the whole index
   loading a second time INSIDE the panel), and the Capacitor bridge isn't available inside a
   same-origin iframe on the app, so native audio was silently dead. The owner ordered the panel be
   a TRUE part of the index document — no frame. This module is the entire playlist LIST experience
   (everything playlists.html's list view showed before this refactor), extracted so ANY host page
   can mount it directly into its own DOM: window.ThaiEarPlList.mount(rootEl).

   The `?pl={id}` PLAYER view (playlist rendered as a dyn topic page via player.js) is NOT part of
   this module — it stays a top-level destination on playlists.html?pl=ID, untouched by this pass.

   REQUIRED GLOBALS — must already be loaded on the host document before mount() is called:
     - window.ThaiEarDL    (dl-core.js)  — the shared download/manifest engine. mount() reads
       ThaiEarDL.capabilities() etc. lazily, at call time, never at script-load time.
     - window.ThaiEarAuth  (auth.js)     — MAY still be resolving when mount() runs (this module
       polls isReady()/PL() exactly like the original playlists.html code did, and listens for the
       'thaiear:auth' event to repaint once it's ready). Do not wait for it before calling mount().

   ALSO ASSUMES the host document defines the site's standard CSS custom properties (--bg,
   --surface, --border, --border-strong, --text-primary, --text-secondary, --text-tertiary,
   --accent, --accent-light, --accent-mid, --radius-sm/md/lg, --font-ui, --font-thai) — every page
   on the site defines the same values (index.html, playlists.html, dyn-index.html all agree), so
   this module does not redefine them. It DOES ensure `player-dyn.css` is linked (injecting the
   <link> itself if the host document doesn't already have one) — that stylesheet owns `.pl-box`,
   `.pl-note`, `.pl-add`, `.dyn-list/.dyn-card/.dyn-tick` (the remove-sentences rows) and the
   `#dyn-rm-bar`, which this module's markup depends on and which playlists.html already links for
   the `?pl=` player view anyway.

   API: window.ThaiEarPlList = { mount: function(rootEl) {...} }
     - mount(rootEl) renders the complete list experience INTO rootEl and wires it up. Idempotent
       per rootEl (a second mount() call on the same node is a no-op) — it does NOT auto-run on
       script load, only when a host page calls it.
     - Every link this module renders is an ordinary top-level link/navigation — the module is
       always mounted in the TOP document now (never inside an iframe), so no target="_top" tricks
       are needed here (unlike the legacy ?embed=1 <base> hack, which stays only in playlists.html
       for old cached copies of the index still iframing it during the cache-transition window).
     - Any link this module renders back to "the playlist list" (as opposed to the `?pl=` player,
       which stays `playlists.html?pl=ID`) points at `index.html#playlists` — the panel is the only
       list location now; there is no reason to route through the redirecting bare playlists.html.
*/
(function () {
  'use strict';
  if (window.ThaiEarPlList) return;   // script tag included twice — the export is already there

  var STYLE_ID = 'pl-list-styles';

  // player-dyn.css owns .pl-box/.pl-note/.pl-add/.dyn-list/.dyn-card/.dyn-tick/#dyn-rm-bar, which
  // this module's markup uses. playlists.html already links it (for the ?pl= player); index.html
  // does not, so make sure whichever host we're on has it — id-guarded, and also skipped if some
  // other <link> to the same file is already present (avoids a double-load on playlists.html).
  function ensureDynCss() {
    var links = document.getElementsByTagName('link'), i;
    for (i = 0; i < links.length; i++) {
      if (/(^|\/)player-dyn\.css(\?|$)/.test(links[i].getAttribute('href') || '')) return;
    }
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = 'player-dyn.css';
    document.head.appendChild(l);
  }

  // The list-only CSS that used to sit in playlists.html's inline <style> block. Global reset,
  // :root vars, body, .wrap/.eyebrow/h1 stay in playlists.html — the ?pl= player view's wrap also
  // uses those. Everything below is exclusive to the list experience this module owns.
  var CSS =
    '.lede { font-size: 13.5px; color: var(--text-secondary); margin-bottom: 1.4rem; }' +
    /* modal (pattern copied from account.html's delete-account modal) */
    '.modal-overlay { position: fixed; inset: 0; background: rgba(20,16,48,0.45); display: flex; align-items: center; justify-content: center; padding: 1.25rem; z-index: 1000; }' +
    '.modal-card { background: var(--surface); border-radius: var(--radius-lg); max-width: 400px; width: 100%; padding: 1.5rem 1.5rem 1.35rem; box-shadow: 0 12px 40px rgba(0,0,0,0.2); }' +
    '.modal-card h2 { font-size: 18px; font-weight: 600; margin-bottom: 0.5rem; }' +
    '.modal-card p { font-size: 14px; color: var(--text-secondary); margin-bottom: 1rem; line-height: 1.55; }' +
    '.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }' +
    '.btn { font-family: var(--font-ui); font-size: 14px; font-weight: 500; border-radius: var(--radius-sm); padding: 9px 18px; cursor: pointer; border: 0.5px solid var(--border-strong); transition: background 0.15s, border-color 0.15s, color 0.15s; }' +
    '.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }' +
    '.btn-primary:hover { background: var(--accent-mid); }' +
    '.btn-ghost { background: var(--surface); color: var(--text-secondary); }' +
    '.btn-ghost:hover { border-color: var(--accent); color: var(--accent); }' +
    '.btn-danger { background: #B00020; color: #fff; border-color: #B00020; }' +
    '.btn-danger:hover:not([disabled]) { background: #8a0019; }' +
    /* r92 — a DISABLED danger button must not look armed (matches dyn-index's Remove All). */
    '.btn[disabled] { opacity: .45; cursor: default; }' +
    /* round-10: playback moved to the ?pl= player view — the box keeps management only */
    '.pl-open { display: inline-block; font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; color: #fff; background: var(--accent); border-radius: 16px; padding: 6px 16px; text-decoration: none; margin: 1rem 8px 0 0; }' +
    '.pl-open:hover { background: var(--accent-mid); }' +
    '.pl-rm-list { margin: 0 0 0.75rem; }' +
    /* r76 — while "Remove sentences" select mode is open, the row's OTHER actions are hidden. */
    '.pl-box.rm-mode .pl-remsent, .pl-box.rm-mode .pl-rename, .pl-box.rm-mode .pl-del, .pl-box.rm-mode .pl-open { display: none; }' +
    /* Download area — mirrors index.html / dyn-index.html exactly. */
    '.dl-batch-bar { display: flex; flex-direction: column; gap: 8px; background: var(--surface); border: .5px solid var(--border); border-radius: var(--radius-md); padding: 12px; margin: 0 0 1rem; }' +
    '.dl-batch-btns { display: flex; gap: 8px; }' +
    '.dl-batch-btn { flex: 1; font-family: var(--font-ui); font-size: 13.5px; font-weight: 500; color: #fff; background: var(--accent); border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }' +
    '.dl-batch-btn:hover:not([disabled]) { background: var(--accent-mid); }' +
    '.dl-batch-btn[disabled] { background: var(--border); color: var(--text-tertiary); cursor: default; }' +
    '.dl-clear-btn { background: var(--surface); color: var(--text-secondary); border: .5px solid var(--border-strong); }' +
    '.dl-clear-btn:hover:not([disabled]) { background: var(--accent-light); color: var(--accent); }' +
    /* r85: Remove All is deliberately the quietest control — a reset, not a verb, no undo. */
    '.dl-removeall-btn { background: transparent; color: var(--text-tertiary); border: .5px solid var(--border); font-size: 12.5px; padding: 6px 10px; }' +
    '.dl-removeall-btn:hover:not([disabled]) { background: #FDF1F2; color: #B00020; border-color: #E8C4C8; }' +
    '.dl-batch-status { font-size: 13px; color: var(--text-secondary); min-height: 1.15em; }' +
    '.dl-batch-status.err { color: #B00020; }' +
    '.dl-batch-hint { font-size: 12.5px; color: var(--text-tertiary); }' +
    '.dl-share-note .more-body { display: none; }' +
    '.dl-share-note.open .more-body { display: inline; }' +
    '.dl-share-more { background: none; border: 0; padding: 0 0 0 5px; font: inherit; font-weight: 500; color: var(--accent); cursor: pointer; }' +
    '.modal-input { width: 100%; font-family: var(--font-ui); font-size: 15px; padding: 9px 11px; border: .5px solid var(--border-strong); border-radius: var(--radius-sm); margin-bottom: 1rem; }' +
    '.modal-input:focus { outline: none; border-color: var(--accent); }' +
    '.dl-select, .dl-badge { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; margin-left: 6px; flex-shrink: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }' +
    '.dl-select::before, .dl-badge::before { content: \'\'; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 52px; height: 52px; border-radius: 50%; }' +
    '.dl-dot { width: 23px; height: 23px; border-radius: 50%; background: var(--accent-light); border: 1.5px solid var(--accent-light); transition: background .15s, border-color .15s, transform .1s; }' +
    '.dl-select:hover .dl-dot { border-color: var(--accent); }' +
    '.dl-select.selected .dl-dot { background: var(--accent); border-color: var(--accent); }' +
    '.dl-select:active .dl-dot { transform: scale(0.92); }' +
    /* "Update available" — a dashed ring, deliberately not gold (gold means premium on this site). */
    '.dl-select.dl-update .dl-dot { background: transparent; border-color: var(--accent); border-style: dashed; }' +
    '.dl-select.dl-update.selected .dl-dot { background: var(--accent); border-style: solid; }' +
    '.dl-tick { display: inline-flex; align-items: center; justify-content: center; width: 27px; height: 27px; border-radius: 50%; color: var(--accent); border: 2px solid transparent; transition: border-color .15s, background .15s; }' +
    '.dl-badge.clear-selected .dl-tick { border-color: #9d92e0; background: var(--accent-light); }' +
    '.mode-download .dl-badge { opacity: .4; }' +
    '.mode-clear .dl-select { opacity: .4; }' +
    '.pl-dl-state { font-size: 12px; color: var(--accent); font-weight: 500; }' +
    '.dots { display: inline-block; width: 1.1em; text-align: left; }' +
    '.dots::after { content: \'...\'; display: inline-block; width: 0; overflow: hidden; vertical-align: bottom; animation: dots 1.2s steps(3,start) infinite; }' +
    '@keyframes dots { from { width: 0 } to { width: 1.05em } }' +
    /* image + caption block, mirroring guide.html's .fluency-* (khwai) pattern */
    '.fluency-block { text-align: center; margin: 1.25rem 0 1.5rem; }' +
    '.fluency-img { width: 150px; max-width: 42%; height: auto; display: block; margin: 0 auto 0.4rem; }' +
    '.fluency-text { font-size: 15px; font-weight: 500; color: var(--accent); letter-spacing: 0.02em; }' +
    '.fluency-text .dots::after { animation-duration: 1.5s; }' +
    /* Layout B (owner-approved r101) — the full-width dashed "add playlist" card. */
    '.pl-add-card { display: flex; flex-direction: column; align-items: center; gap: 8px; border: 1.5px dashed var(--accent); border-radius: var(--radius-lg); background: var(--accent-light); padding: 14px 12px; margin: 0 1px 1.25rem; }' +
    '.pl-add-card .pl-add { margin-bottom: 0; }' +
    '.pl-add-hint { font-family: var(--font-ui); font-size: 12.5px; font-weight: 500; color: var(--accent); text-align: center; line-height: 1.45; }';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // The markup mount() renders into rootEl — everything playlists.html's list view showed:
  // lede → meditator + animated-dots caption → layout-B add-card → download batch bar → boxes.
  var HTML =
    '<p class="lede">Build custom sessions from sentences you\'ve added on any topic page. Open a playlist to play it — the session file is constructed on your device, exactly like a topic.</p>' +
    '<div class="fluency-block">' +
      '<img class="fluency-img" src="meditator.png" alt="Meditating learner" width="150">' +
      '<div class="fluency-text">Eerily effective<span class="dots" aria-hidden="true"></span></div>' +
    '</div>' +
    '<div class="pl-add-card">' +
      '<button class="pl-add" id="pl-add" type="button">＋ Add playlist</button>' +
      '<span class="pl-add-hint">Add sentences to your playlists from topic pages</span>' +
    '</div>' +
    '<div class="dl-batch-bar" id="dl-batch-bar" hidden>' +
      '<div class="dl-batch-btns">' +
        '<button class="dl-batch-btn" id="dl-btn" type="button">Download Playlist(s)</button>' +
        '<button class="dl-batch-btn dl-clear-btn" id="clear-btn" type="button">Remove Selected Downloads</button>' +
      '</div>' +
      '<div class="dl-batch-btns dl-batch-btns-2">' +
        '<button class="dl-batch-btn dl-removeall-btn" id="removeall-btn" type="button">Remove All Downloads</button>' +
      '</div>' +
      '<span class="dl-batch-status" id="dl-status"></span>' +
      '<span class="dl-batch-hint dl-share-note" id="dl-share-note">' +
        '<span id="dl-hint">Tap a playlist\'s circle to download, or a tick to remove, then pick an action.</span>' +
        '<span class="more-body"><br><br>A playlist can say <strong>available offline</strong> when its sentences are already saved by something else — a topic you\'ve downloaded, or another playlist. Clearing this playlist won\'t remove those files while something else still needs them.<br><br>Downloaded playlists will always be available offline, no matter which other topic or playlist downloads you remove.</span>' +
        '<button type="button" class="dl-share-more" id="dl-share-more">more</button>' +
      '</span>' +
    '</div>' +
    '<div id="pl-root"><p class="pl-note">Loading…</p></div>';

  function mount(rootEl) {
    if (!rootEl || rootEl.__tePlMounted) return;   // idempotent — a second mount() call is a no-op
    rootEl.__tePlMounted = true;
    ensureDynCss();
    injectStyles();
    rootEl.innerHTML = HTML;

    var root = document.getElementById('pl-root');
    var openId = null;

    function PL() { return window.ThaiEarAuth && window.ThaiEarAuth.playlists; }
    function user() { return window.ThaiEarAuth && window.ThaiEarAuth.getUser && window.ThaiEarAuth.getUser(); }
    /* The auth view every ENTITLEMENT question must read — mirrors player.js's AUTHV(). Plain
       window.ThaiEarAuth (used above for playlists/getUser) is the REAL account and is deliberately
       left alone; anything asking "may they play/download this" goes through the simulator or the
       owner cannot test gating on the list side at all. Absent sim.js this is a pass-through. */
    // §D.1: the AUTH()/lockedFor plumbing lives in dl-core.js — ThaiEarDL.AUTH is the same
    // sim-aware accessor AUTHV() was.
    function AUTHV() { return ThaiEarDL.AUTH(); }
    /* One lock rule, defined in auth.js. ⚠ This is the DOWNLOAD gate, not the access one — every
       plOpenItems() consumer below is a download decision (download state, the download
       affordance, which clips to fetch). Playback locking in playlists is player.js's
       sentLocked(), which keeps using the access predicate. Since the 2026-08 tier retirement the
       two differ: a Free unit streams for anyone, but downloading it needs an account. */
    function plLocked(it) { return ThaiEarDL.dlLocked({ tier: plTier(it), prefix: it && it.prefix }, DL_OK); }
    /* ⚠ THE LIVE TIER, NEVER THE SAVED ONE (2026-08-13). `it.tier` is a snapshot written when the
       sentence was added to the playlist, so it cannot see a tier change — and the tier decides
       WHICH BUCKET the clip is fetched from. The 2026-08-10 demotion of the 9 former-member
       first-parts moved their MP3s to the PUBLIC bucket, leaving saved rows still saying 'member';
       dlFileUrl() then asked /api/audio to sign a private-bucket URL for a file that had moved, so
       every download of a playlist containing one 404'd on that clip and no retry could ever help
       (owner: ShoppingAndMoney_BEG_S323). topics.js ships with the deploy and is therefore the only
       thing that is current. Falls back to the snapshot for a prefix topics.js doesn't know. */
    function plTier(it) {
      var live = (window.ThaiEarTopics && window.ThaiEarTopics.tierForPrefix)
        ? window.ThaiEarTopics.tierForPrefix(it && it.prefix) : null;
      return live || (it && it.tier) || 'free';
    }
    // The items this visitor may actually download and play. Locked ones are simply not our business:
    // they are already shown sunk under "Premium content" and padlocked in the ?pl= view.
    function plOpenItems(p) {
      return ((p && p.items) || []).filter(function (it) { return !plLocked(it); });
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

    // On-brand confirmation modal (pattern copied from account.html's delete-account modal).
    // opts: { title, body(html), confirmText, cancelText, danger, onConfirm }
    function showModal(opts) {
      var ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML =
        '<div class="modal-card" role="dialog" aria-modal="true">' +
          '<h2>' + esc(opts.title) + '</h2>' +
          (opts.body ? '<p>' + opts.body + '</p>' : '') +   // no body → no empty <p> eating space
          // opts.input → a text field whose trimmed value is handed to onConfirm (rename).
          (opts.input ? '<input class="modal-input" id="modal-input" type="text" maxlength="' +
            (opts.input.maxlength || 60) + '" value="' + esc(opts.input.value || '') + '">' : '') +
          '<div class="modal-actions">' +
            // noCancel → a MESSAGE, not a choice; one button reads better than a fake decision.
            (opts.noCancel ? '' : '<button class="btn btn-ghost" id="modal-cancel">' + esc(opts.cancelText || 'Cancel') + '</button>') +
            '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" id="modal-ok">' + esc(opts.confirmText || 'Confirm') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      var cancelBtn = ov.querySelector('#modal-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', close);
      /* preventScroll: focusing an input inside a fixed overlay otherwise makes the browser scroll
         the PAGE BEHIND it to "reveal" the field. The overlay is already centred — nothing needs
         revealing. */
      var inp = ov.querySelector('#modal-input');
      if (inp) { try { inp.focus({ preventScroll: true }); } catch (_) { inp.focus(); } inp.select(); }
      /* r85 — requireText: the user must TYPE a word before the action arms (same guard account.html
         uses for delete-account: `requireText: 'DELETE'`). */
      var okBtn = ov.querySelector('#modal-ok');
      if (opts.requireText && inp) {
        okBtn.disabled = true;
        inp.addEventListener('input', function () {
          /* ⚠ EXACT MATCH, CASE-SENSITIVE — do not `.toUpperCase()` either side, and do not put
             `text-transform: uppercase` on the field: the display must not lie about `.value`. */
          okBtn.disabled = inp.value.trim() !== String(opts.requireText);
        });
      }
      okBtn.addEventListener('click', function () {
        var v = inp ? inp.value.trim() : null;
        if (opts.requireText) {
          if (String(v || '') !== String(opts.requireText)) { inp.focus(); return; }
        } else if (inp && !v) { inp.focus(); return; }   // an empty name is never a valid confirm
        close(); opts.onConfirm(v);
      });
    }

    /* One-button message dialog — the styled counterpart to alert(). */
    function msgModal(title, body) {
      showModal({ title: title, body: esc(body), confirmText: 'OK', noCancel: true, onConfirm: function () {} });
    }

    // Cache-first data source: the loaded server copy, else the localStorage copy — the latter
    // is readable even before auth/the Supabase client resolve.
    function currentLists() {
      var pl = PL();
      var lists = pl && pl.get ? pl.get() : null;
      if (!lists && pl && pl.peek) lists = pl.peek();
      if (!lists) { try { lists = JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) { lists = null; } }
      return lists || null;
    }
    var paintedJson = null;   // JSON of the playlist data currently painted as boxes (null = message/loading shown)
    function authReady() { return !!(window.ThaiEarAuth && window.ThaiEarAuth.isReady); }
    function showLoading() {
      paintedJson = null;
      root.innerHTML = '<p class="pl-note">Loading playlists<span class="dyn-dots"></span></p>';
    }

    /* == DOWNLOADS (r18d) =================================================================
       A playlist's clips belong to the TOPICS its sentences came from, so two playlists - or a
       playlist and a downloaded topic - can legitimately need the same file. Deleting one must
       never strip another. So each topic prefix's manifest entry carries a REFS list of who
       required it ('topic', 'pl-<id>'); clearing removes only that referrer, and the files go
       only when the last one does. The bias is deliberately toward over-retaining a few clips
       rather than ever deleting one that something still needs. */
    var DL_CACHE = 'thaiear-audio-dl';                                    // must match player.js
    function dlCacheKey(prefix, file) { return '/__offline-audio/' + prefix + '/' + file; }
    // §D.1: device/browser storage capability — shared with dyn-index.html via dl-core.js.
    var DLCAP = ThaiEarDL.capabilities();
    var DL_NATIVE = DLCAP.native, DL_FS = DLCAP.fs, DL_OK = DLCAP.ok;
    /* r129 — §1f: the list can render inside a panel/mounted host, where an outer page's own
       te-no-dl class may or may not already reach it. Download UI is app + installed-PWA only; a
       plain browser must never see circles/ticks/the batch bar, with normal-flow collapse. If the
       host page has ALREADY decided (te-no-dl already present on <html> or <body>), respect that
       rather than re-deriving and duplicating the class. Otherwise derive it ourselves — same
       predicate as the index/dyn-index (native via the bridged capabilities || standalone PWA). */
    (function () {
      var docEl = document.documentElement, bodyEl = document.body;
      var already = (docEl && docEl.className.indexOf('te-no-dl') !== -1) ||
                    (bodyEl && bodyEl.className.indexOf('te-no-dl') !== -1);
      var noDl = already;
      if (!already) {
        var standalone = false;
        try {
          standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
                       window.navigator.standalone === true;
        } catch (_) {}
        noDl = !(DL_NATIVE || standalone);
        if (noDl) docEl.className += ' te-no-dl';
      }
      /* …and where the batch bar is withheld, offer the app instead (app-cta.js). Keyed off the
         SAME `noDl` the class is — including the `already` case, where the host page decided for
         us — so the bar and the card can never both be visible, or both be missing.
         ⚠ rootEl.querySelector, NEVER document.getElementById: index.html's Topics panel has a
         #dl-batch-bar of its OWN, and since the rollout both panels live in the same document
         (native mount, no iframe). A document-wide lookup finds the TOPICS one — which is
         display:none while the Playlists panel is showing — so the card was inserted, reported
         present, and rendered 0×0 in the wrong panel. Duplicate ids across panels are a fact of
         the native-mount architecture; scope every lookup to the mounted root. */
      if (noDl && window.ThaiEarAppCTA) {
        window.ThaiEarAppCTA.insertBefore(rootEl.querySelector('#dl-batch-bar'), 'playlist');
      }
    })();
    /* r85 — ONE SELECTION SET. A row is simply SELECTED, and the BUTTON supplies the verb. Rows
       that cannot perform the chosen verb are skipped silently. */
    var dlSel = {}, dlBusy = false, dlWorking = {};

    // §D.1: manifest read/write moved to dl-core.js (shared with dyn-index.html) — these stay as
    // thin delegates so every existing dlManifest()/dlSetManifest() call site below is untouched.
    function dlManifest() { return ThaiEarDL.getManifest(); }
    function dlSetManifest(m) { ThaiEarDL.setManifest(m); }
    function dlPlMap() { try { return JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}'); } catch (_) { return {}; } }
    function dlSetPlMap(m) { try { localStorage.setItem('thaiear_offline_pl', JSON.stringify(m)); } catch (_) {} }

    /* ── r137: AUDIO-VERSION AWARENESS FOR PLAYLISTS ────────────────────────────────────────
       This list had none. A topic knew when its clips had been re-rendered on R2 (the index card
       and the topic page both read audio-versions.json); a playlist made of the very same clips
       never did, so a downloaded playlist quietly went on playing superseded audio with no surface
       offering the update. Mirrors the topic side rather than inventing a second mechanism.
       ⚠ THE BASELINE IS PER PLAYLIST, NOT PER PREFIX — and that difference is the whole design.
       The published stamp fingerprints a WHOLE TOPIC's audio, but a playlist holds a SUBSET of a
       prefix's clips and usually spans several prefixes. Writing the shared prefix-level `av` from
       a playlist download would tell the index and the topic page that the entire topic is current
       when only a handful of its clips were fetched — a lie that would suppress a real update
       prompt. So a playlist records its own baseline inside its own download record
       (thaiear_offline_pl[id].av = {prefix: stamp}) and never touches the manifest's.
       Conservative in the safe direction: a prefix's stamp moves when ANY clip in that topic
       changes, which may not be one this playlist uses, so it can offer an update that turns out
       to re-fetch identical bytes. Re-fetching a few clips we didn't need beats missing one we
       did — the same trade the topic side already makes. */
    var DL_AV = null, dlAvLoaded = false;
    function dlAvLoad() {
      if (dlAvLoaded) return Promise.resolve(DL_AV);
      return fetch('/audio-versions.json').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { DL_AV = m; dlAvLoaded = true; return DL_AV; })
        .catch(function () { DL_AV = null; dlAvLoaded = true; return null; });
    }
    // The stamps this playlist's clips were fetched against, or null if it has no record yet.
    function dlPlAv(id) { var r = dlPlMap()[id]; return (r && r.av) || null; }
    // Build the baseline to record for a run: the live stamp of every prefix it just fetched.
    function dlAvSnapshot(prefixes) {
      var out = {};
      if (!DL_AV) return out;
      prefixes.forEach(function (pfx) { if (DL_AV[pfx] != null) out[pfx] = DL_AV[pfx]; });
      return out;
    }
    /* Has any prefix this playlist uses been re-rendered since it was downloaded? Conservative on
       every unknown — no published map, no recorded baseline, or nothing published for a prefix all
       mean "not stale". A download made before this existed carries no baseline and therefore never
       nags; it adopts one the first time it is downloaded or updated again. */
    function dlAvStale(p) {
      if (!DL_AV) return false;
      var base = dlPlAv(p.id);
      if (!base) return false;
      var by = dlGroup(p), pfx;
      for (pfx in by) {
        var was = base[pfx], cur = DL_AV[pfx];
        if (was == null || cur == null) continue;
        if (was !== cur) return true;
      }
      return false;
    }
    /* "Downloaded" is a CONTENT question, never a flag.
         downloaded — every clip this playlist needs is present, whatever put it there
         update     — clips missing, but this playlist WAS downloaded before
         none       — clips missing and it never was */
    function dlHasAll(p) {
      var by = dlGroup(p), pfx;
      for (pfx in by) if (!ThaiEarDL.hasFiles(pfx, by[pfx].files)) return false;
      return true;
    }
    /* r79/r81 — OWNERSHIP, per prefix, COUNTED PER FILE. Does OUR `pl-<id>` ref cover every FILE
       this playlist needs (with the files actually present), and does it cover any at all? */
    function dlOwnedNeeded(p) {
      var by = dlGroup(p), ref = 'pl-' + p.id;
      var need = 0, owned = 0, pfx;
      for (pfx in by) {
        var c = ThaiEarDL.ownedCount(pfx, by[pfx].files, ref);
        need += c.need; owned += c.owned;
      }
      return { all: need > 0 && owned === need, some: owned > 0 };
    }
    /* FOUR states, because "its clips happen to be here" and "this playlist is downloaded" are not
       the same promise:
         downloaded — the playlist has its OWN claim. Durable.
         available  — every clip is present, but only because something ELSE holds them.
         update     — it was downloaded, and sentences have since been added.
         none       — clips missing and it was never downloaded. */
    function dlState(p) {
      if (!p.items.length) return 'none';
      /* NOTHING THIS VISITOR MAY PLAY. dlHasAll() over an EMPTY group is vacuously TRUE, so
         without this an all-premium playlist would read "downloaded" to someone who cannot hear a
         single sentence of it. Note dlHasAll() is deliberately NOT called on this branch.
         ⚠ ASK WHAT WE HOLD, NOT WHAT A RECORD CLAIMS (2026-08-13). This used to read
         `!!dlPlMap()[p.id]` — "is there a download record?" — while player.js's twin of this branch
         asks dynOwnedPrefixes(), i.e. "do we actually hold any files?". The two drift apart in one
         direction only: the record is a few bytes of localStorage and the clips are what a browser
         evicts under storage pressure (an iOS PWA will clear Cache Storage and leave localStorage
         standing). Record without files then rendered a green TICK over a playlist with nothing on
         the device, while the player, on the same playlist, hid its offline bar entirely — a
         claim trusted over the bytes, which is exactly the stale-record defect r79 fixed on the
         ownership path and r97 left standing here.
         dlRefPrefixes() is r75's own helper and is documented as "lock-independent ground truth" —
         it reads the manifest, so it answers the same question in the same units as the player,
         and it stays correct precisely BECAUSE it does not consult dlGroup() (which drops locked
         items and is what makes the normal ownership path unusable on this branch).
         Reachable only when every sentence is locked AND the files are gone but the record is not,
         so it is rare — but it is the same disagreement, and the two surfaces now answer it from
         the same evidence by construction rather than by happening to agree. */
      if (!plOpenItems(p).length) return dlRefPrefixes('pl-' + p.id).length ? 'downloaded' : 'none';
      var own = dlOwnedNeeded(p);                       // {all, some} — our ref + files, per prefix
      /* r137 — SUPERSEDED COUNTS AS 'update', exactly as it does on a topic card. Placed on the
         own.all branch only: a playlist that doesn't own everything already reads 'update', and one
         that owns nothing has nothing to be stale. Note the all-locked branch ABOVE deliberately
         never reaches here — r97's rule, an update is a FETCH and that visitor may not. */
      if (own.all) return dlAvStale(p) ? 'update' : 'downloaded';
      if (own.some) return 'update';                    // genuinely downloaded, then extended
      if (dlHasAll(p)) return 'available';              // owns none of it; the bytes are borrowed
      /* ⚠ NO D0 / looksLikeTopicClaim FALLBACK HERE — REMOVED 2026-08-13, DO NOT REINSTATE.
         It used to read: "a legacy/topic claim that doesn't cover our per-clip files reads as
         UPDATE, not NONE. Same predicate dyn-index's render() uses." The predicate is right for a
         TOPIC card and wrong for a PLAYLIST row, because looksLikeTopicClaim() answers true on an
         explicit 'topic' ref — which means "the user has THAT TOPIC downloaded", and says exactly
         nothing about whether THIS PLAYLIST was ever downloaded. A playlist's clips belong to the
         topics its sentences came from, so any playlist sharing a prefix with a downloaded topic
         inherited that topic's claim as its own verdict.
         Symptom (owner, 2026-08-13, iPhone): download a playlist, remove it, and the row goes on
         saying "update available" for ever, because dlClearOne() drops our 'pl-<id>' ref but keeps
         the entry alive on its surviving 'topic' ref. The `?pl=` player on the very same playlist
         correctly offered "Download for offline" — the two surfaces disagreeing again.
         THE RULE, from player.js's PLMODE branch (r79/r81/r97): a playlist's verdict is decided
         ENTIRELY BY OWNERSHIP — own.all / own.some, and nothing else. The player has no D0 branch
         for PLMODE at all, which is precisely why it was right. Both surfaces now answer the same
         question from the same evidence, by construction rather than by two predicates happening
         to agree — §B8's lesson 3, which the r79 comment records as having bitten three times
         before this one.
         Nothing is lost by dropping it: an interrupted playlist download records each clip as it
         lands (dlNoteClip), so any real progress shows up as own.some → 'update'. Reaching here
         means we own not one clip, and 'none' — a plain download circle — is the honest answer. */
      return 'none';
    }
    function dlStatus(msg, err) {
      var el = document.getElementById('dl-status'); if (!el) return;
      el.className = 'dl-batch-status' + (err ? ' err' : '');
      el.textContent = msg || '';
    }
    function dlStatusDots(msg) {
      var el = document.getElementById('dl-status'); if (!el) return;
      el.className = 'dl-batch-status';
      el.innerHTML = esc(msg) + '<span class="dots"></span>';   // the animated ellipsis is the only one
    }
    // "Please keep this page open" is a standing instruction while busy, not part of the
    // progress text — so no status line has to end in a dot or carry a separator.
    function dlKeepOpen(on) {
      var h = document.getElementById('dl-hint'); if (!h) return;
      h.textContent = on ? 'Please keep this page open' : "Tap a playlist's circle to download, or a tick to remove, then pick an action.";
      h.style.display = on ? '' : (Object.keys(dlSel).length ? 'none' : '');
    }
    // The control on a playlist head: nothing while it works, a tick if downloaded, a circle
    // otherwise. The tick appears only once clips AND construction have finished.
    function dlControl(p, st) {
      if (!DL_OK || !p.items.length) return '';
      if (dlWorking[p.id]) return '<span class="dots" aria-hidden="true"></span>';
      st = st || dlState(p);
      /* ⚠ REMOVAL IS ALWAYS AVAILABLE — this runs AFTER the download states, so it only ever
         suppresses the DOWNLOAD affordance, never the clear one. Do not move it above `downloaded`. */
      if (st !== 'downloaded' && !plOpenItems(p).length) return '';
      /* AVAILABLE-BY-CHANCE still offers the download, deliberately — a plain download circle. */
      if (st === 'available') {
        return '<span class="dl-select' + (dlSel[p.id] ? ' selected' : '') + '" data-dl="' + p.id +
          '" data-mode="sel" role="button" title="Available offline via another download - tap to select and download this playlist itself"' +
          ' aria-label="Available offline via another download - select to download this playlist itself"><span class="dl-dot"></span></span>';
      }
      if (st === 'update') {
        /* r137 — ONE WORDING FOR BOTH UPDATE ROUTES, the owner's r83 ruling applied here too:
           "you're missing clips vs your clips are superseded — a pointless distinction. It should
           just always be 'Download audio update?'" This row can now reach 'update' either way
           (added sentences, or re-rendered audio), and the action is identical, so the old
           "New sentences added" wording would be wrong half the time. */
        return '<span class="dl-select dl-update' + (dlSel[p.id] ? ' selected' : '') + '" data-dl="' + p.id +
          '" data-mode="sel" role="button" title="Download audio update - tap to select and update this download"' +
          ' aria-label="Download audio update - select to update this download"><span class="dl-dot"></span></span>';
      }
      if (st === 'downloaded') {
        return '<span class="dl-badge' + (dlSel[p.id] ? ' clear-selected' : '') + '" data-dl="' + p.id +
          '" data-mode="sel" role="button" title="Downloaded - tap to select">' +
          '<span class="dl-tick"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
          'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></span>';
      }
      return '<span class="dl-select' + (dlSel[p.id] ? ' selected' : '') + '" data-dl="' + p.id +
        '" data-mode="sel" role="button" aria-label="Select this playlist"><span class="dl-dot"></span></span>';
    }
    function dlPaintBar() {
      var bar = document.getElementById('dl-batch-bar'); if (!bar) return;
      var lists = currentLists() || [];
      bar.hidden = !DL_OK || !lists.some(function (p) { return p.items.length; });
      /* r85 — the counts show what each button WILL ACTUALLY DO, not how many rows are ticked. */
      var picked = lists.filter(function (p) { return dlSel[p.id]; });
      var nd = picked.filter(dlNeedsDownload).length;
      var nc = picked.filter(dlHasDownload).length;
      var d = document.getElementById('dl-btn'), c = document.getElementById('clear-btn');
      if (d && !dlBusy) d.textContent = nd ? ('Download Playlist(s) (' + nd + ')') : 'Download Playlist(s)';
      if (c && !dlBusy) c.textContent = nc ? ('Remove Selected Downloads (' + nc + ')') : 'Remove Selected Downloads';
      var hint = document.getElementById('dl-hint');
      if (hint && !dlBusy) hint.style.display = picked.length ? 'none' : '';
      root.classList.toggle('mode-download', picked.length > 0);
      root.classList.remove('mode-clear');   // r85: the two modes are gone; nothing dims anything now
    }
    /* ── SWIPE / BACK-GESTURE LEAVE GUARD (r93) ─────────────────────────────────────────────────
       A swipe-back / hardware back is a HISTORY navigation with no click, so the click-based guard
       below never sees it, and beforeunload does not reliably fire for an in-app history back in a
       WebView either. While a download runs we push one same-URL SENTINEL entry; a back gesture
       pops it, we re-push it and answer with this page's own modal. "Leave anyway" goes back TWO
       entries (the sentinel and the real one) — the navigation the user originally asked for.
       Same-URL pushState entries are SAME-DOCUMENT, so popping fires popstate WITHOUT reloading —
       safe to do mid-download. */
    (function () {
      var armed = false, skip = false;
      function push() { try { history.pushState({ teDlGuard: 1 }, '', location.href); } catch (_) {} }
      window.__teArmLeaveGuard = function () { if (armed) return; armed = true; push(); };
      window.__teDisarmLeaveGuard = function () {
        if (!armed) return;
        armed = false; skip = true;            // our own pop, not the user's - do not prompt on it
        try { history.back(); } catch (_) { skip = false; }
      };
      window.addEventListener('popstate', function () {
        if (skip) { skip = false; return; }
        if (!armed) return;
        push();                                 // cancel the gesture by returning to the sentinel
        showModal({
          title: 'Leave this page?',
          body: 'A download is in progress. If you leave now it won’t finish — you can start it again any time.',
          confirmText: 'Leave anyway', cancelText: 'Keep downloading', danger: true,
          onConfirm: function () { armed = false; skip = true; try { window.__teLeaveBypass(); } catch (_) {} try { history.go(-2); } catch (_) {} }
        });
      });
    })();
    function dlSetBusy(b) {
      /* r93: the swipe guard is armed exactly while a batch runs. */
      try { if (b) window.__teArmLeaveGuard(); else window.__teDisarmLeaveGuard(); } catch (_) {}
      dlBusy = b;
      dlKeepOpen(b);
      /* r85: all THREE buttons lock while a job runs — Remove All included. */
      var d = document.getElementById('dl-btn'), c = document.getElementById('clear-btn');
      var ra = document.getElementById('removeall-btn');
      if (d) d.disabled = b; if (c) c.disabled = b; if (ra) ra.disabled = b;
    }
    // Tap a circle/tick without toggling the box open underneath it.
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var t = e.target.closest('[data-dl]');
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      if (dlBusy) return;
      /* r85: one set, so a tap is just a toggle. ⚠ Note what is NOT here: `dlStatus('')`. A
         selection tap must never clear a line it does not own. */
      var id = t.getAttribute('data-dl');
      if (dlSel[id]) delete dlSel[id]; else dlSel[id] = true;
      render();
    }, true);

    function dlFileUrl(file, tier) {
      if (tier !== 'member' && tier !== 'premium') return Promise.resolve('https://audio.thaiear.com/' + file);
      var tok = (window.ThaiEarAuth && window.ThaiEarAuth.getAccessToken) ? window.ThaiEarAuth.getAccessToken() : null;
      if (!tok) return Promise.reject(new Error('Sign in to download this playlist'));
      return fetch('/api/audio?file=' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + tok } })
        .then(function (r) { if (!r.ok) { var ge = new Error('audio gate ' + r.status); ge.code = r.status; throw ge; } return r.json(); })
        .then(function (j) { if (!j || !j.url) throw new Error('no url'); return j.url; });
    }
    /* ⚠ r87 — RETRY WITH BACKOFF. §D.1: the retry/backoff loop itself lives in dl-core.js as
       ThaiEarDL.downloadOne (3-tries/600ms×attempt); `dlSaveOne` is a thin wrapper supplying this
       page's URL/path/cache details. */
    function dlSaveOne(prefix, tier, file) {
      return ThaiEarDL.downloadOne(file, {
        urlFn: function (f) { return dlFileUrl(f, tier); },
        native: DL_NATIVE, fs: DL_FS, nativePath: function (f) { return 'offline/' + prefix + '/' + f; },
        cacheName: DL_CACHE, cacheKeyFn: function (f) { return dlCacheKey(prefix, f); },
        label: 'playlists'
      });
    }
    /* ── LEAVE GUARD (click-intercept) ──────────────────────────────────────────────────────────
       Leaving mid-batch abandons the download. beforeunload cannot be styled/reworded, so an
       internal link click is intercepted and answered with this page's own modal; beforeunload is
       added purely as the un-stylable backstop for tab close / URL bar. */
    (function () {
      var bypass = false;
      /* r94: let the SWIPE guard suppress this too — one deliberate decision has to silence BOTH
         guards, not just the one that asked. */
      window.__teLeaveBypass = function () { bypass = true; };
      document.addEventListener('click', function (e) {
        if (bypass || !dlBusy) return;
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;
        if (a.target && a.target !== '_self') return;
        e.preventDefault(); e.stopPropagation();
        showModal({
          title: 'Download in progress',
          body: 'If you leave now, this download won’t finish. You can start it again any time.',
          confirmText: 'Leave anyway',
          cancelText: 'Keep downloading',
          onConfirm: function () { bypass = true; window.location.href = a.href; }
        });
      }, true);
      window.addEventListener('beforeunload', function (e) {
        if (dlBusy && !bypass) { e.preventDefault(); e.returnValue = ''; }
      });
    })();
    // Group a playlist's sentences by the topic their clips live under.
    function dlGroup(p) {
      var by = {};
      // Locked items are EXCLUDED — never try to download a clip the server will deny.
      plOpenItems(p).forEach(function (it) {
        var pfx = it.prefix; if (!pfx) return;
        var n = String(it.num).padStart(2, '0');
        // plTier(), not it.tier — the saved tier is a snapshot and routes to the wrong bucket.
        by[pfx] = by[pfx] || { tier: plTier(it), files: [] };
        by[pfx].files.push(pfx + '_S' + n + '_TH.mp3');
        by[pfx].files.push(pfx + '_S' + n + '_EN.mp3');
      });
      return by;
    }
    /* r85 — one clip, recorded, on first use. §D.1: mechanics live in dl-core.js as ThaiEarDL.noteClip. */
    function dlNoteClip(pfx, tier, file, ref) {
      ThaiEarDL.noteClip(pfx, file, ref, {
        seed: function () { return { tier: tier, files: [], at: Date.now(), dyn: true }; }
      });
    }
    function dlRunDownloads() {
      if (dlBusy) return;
      var lists = currentLists() || [];
      var picked = lists.filter(function (p) { return dlSel[p.id] && p.items.length && dlNeedsDownload(p); });
      if (!picked.length) { dlStatus('Select a playlist that needs downloading first.'); return; }
      if (!navigator.onLine) { dlStatus('You’re offline — reconnect to download playlists.', true); return; }
      dlSetBusy(true);
      var i = 0;
      (function next() {
        if (i >= picked.length) {
          dlSetBusy(false);
          dlStatus('Done — ' + picked.length + ' playlist' + (picked.length > 1 ? 's' : '') + ' saved offline.');
          dlSel = {}; render();
          return;
        }
        var p = picked[i], by = dlGroup(p), prefixes = Object.keys(by);
        var total = 0, done = 0, tDl0 = Date.now(), dlSecs = null;
        prefixes.forEach(function (k) { total += by[k].files.length; });
        dlWorking[p.id] = 1; render();
        dlStatus('Downloading “' + p.name + '”');
        var chain = Promise.resolve();
        prefixes.forEach(function (pfx) {
          chain = chain.then(function () {
            return DL_NATIVE
              ? DL_FS.mkdir({ directory: 'DATA', path: 'offline/' + pfx, recursive: true }).catch(function () {})
              : null;
          }).then(function () {
            // r19: six at a time, not one.
            return ThaiEarDL.pool(by[pfx].files, 6, function (f) {
              return dlSaveOne(pfx, by[pfx].tier, f).then(function () {
                done++;
                /* r85 — RECORD EACH CLIP AS IT LANDS, so an interrupted download is resumable. */
                dlNoteClip(pfx, by[pfx].tier, f, 'pl-' + p.id);
                dlStatus('Downloading “' + p.name + '” — clip ' + done + ' of ' + total);
              });
            });
          });
        });
        // r137: make sure the version map is in hand before recording the baseline — the mount-time
        // load may not have resolved yet if the user tapped Download immediately (same ordering
        // player.js uses: the clips land, THEN loadAudioVers, THEN the manifest write).
        chain.then(function () { return dlAvLoad(); }).then(function () {
          var m = dlManifest();
          prefixes.forEach(function (pfx) {
            // NOT ['topic'] — a playlist pulls only the sentences IT uses.
            var e = ThaiEarDL.mergeFiles(m, pfx, by[pfx].files, 'pl-' + p.id, function () {
              return { tier: by[pfx].tier, files: [], at: Date.now(), dyn: true };
            });
            e.at = Date.now();
          });
          dlSetManifest(m);
          /* r137 — INVALIDATE THIS PLAYLIST'S BUILT SESSION. Every file above was re-fetched and
             written over (this loop has no already-present skip), so the stitched mp3 may now be
             built from clips that no longer exist on disk in that form — and its key encodes
             SETTINGS, not clip content (player.js dynKeyFor), so it will never notice by itself.
             The same miss the index had: three surfaces change clips, only the topic page dropped
             the session. Safe unconditionally — a session is rebuildable from the clips on device.
             ⚠ Deliberately only the PLAYLIST's own namespace. A topic sharing these prefixes has
             its own session, and whether ITS audio actually moved is an audio-version question
             this list has no stamp for (see the note in the finalize loop above); the topic page
             and the index both answer it properly and drop their own session when it has. */
          ThaiEarDL.dropSessions('pl-' + p.id, DLCAP, DL_CACHE);
          /* r137 — record THIS PLAYLIST's audio baseline (see dlAvStale). Written here, where every
             clip has just landed, so the stamps are true when stored. Deliberately NOT written to
             the manifest's prefix-level `av`: this run fetched only the clips this playlist uses,
             and claiming the whole topic is current would suppress a genuine update prompt on the
             index card and the topic page. */
          var pm = dlPlMap();
          pm[p.id] = { prefixes: prefixes, at: Date.now(), av: dlAvSnapshot(prefixes) };
          dlSetPlMap(pm);
          dlSecs = ((Date.now() - tDl0) / 1000).toFixed(1);
          console.log('[dl] playlist ' + p.id + ': ' + total + ' clips in ' + dlSecs + 's');
        }).then(function () {
          delete dlWorking[p.id];
          dlStatus('“' + p.name + '” saved offline in ' + dlSecs + 's — open it to construct the mp3.');
          render(); i++; next();
        }).catch(function (err) {
          delete dlWorking[p.id];
          dlSetBusy(false);
          var ec = err && err.code;
          var msg = (ec === 402 || ec === 'licence') ? 'premium membership needed'
                  : (ec === 401 || ec === 403 || ec === 'noauth') ? 'sign in to download this'
                  : (err && err.message) || 'error';
          if (!navigator.onLine || /failed to fetch|load failed|network/i.test(msg)) {
            dlStatus('You’re offline — reconnect to download playlists.', true);
          } else {
            dlStatus('Stopped (' + msg + '). The clips already saved are kept — tap Download again to carry on.', true);
          }
          render();
        });
      })();
    }
    /* GHOST CLAIMS. Deleting a playlist used to leave its 'pl-<id>' ref in the manifest forever.
       ⚠ Only ever call this with an AUTHORITATIVE server list. Returns true if anything changed. */
    function dlReconcileRefs(lists) {
      if (!lists) return false;
      var live = {};
      lists.forEach(function (p) { live['pl-' + p.id] = true; });
      var m = dlManifest(), changed = false, orphaned = [];
      Object.keys(m).forEach(function (pfx) {
        var e = m[pfx];
        if (!e || !e.refs) return;
        var keep = e.refs.filter(function (r) { return r.indexOf('pl-') !== 0 || live[r]; });
        if (keep.length === e.refs.length) return;
        changed = true;
        if (keep.length) { e.refs = keep; m[pfx] = e; return; }
        orphaned.push({ pfx: pfx, files: e.files || [] });   // nothing claims these any more
        delete m[pfx];
      });
      /* ⚠ ALSO PURGE ORPHANED DOWNLOAD RECORDS — a record for a DELETED playlist otherwise survives
         forever, and dynNeededByOthers/neededByOthers bail to null on an unresolvable claim (null
         means "keep every file"), which turns a delete into a silent no-op. */
      var pmR = dlPlMap(), pmChanged = false;
      Object.keys(pmR).forEach(function (id) {
        if (live['pl-' + id]) return;
        delete pmR[id]; pmChanged = true;
        console.log('[dl] dropped orphaned download record for deleted playlist ' + id);
      });
      if (pmChanged) { dlSetPlMap(pmR); changed = true; }
      /* r78: third sweep in the same authoritative pass — built sessions for playlists that are
         gone. Deliberately BEFORE the `if (!changed) return false` bail. */
      if (dlSweepOrphanSessions(lists)) changed = true;
      if (!changed) return false;
      dlSetManifest(m);
      orphaned.forEach(function (o) {
        if (DL_NATIVE) DL_FS.rmdir({ directory: 'DATA', path: 'offline/' + o.pfx, recursive: true }).catch(function () {});
        else if (window.caches) caches.open(DL_CACHE).then(function (c) {
          o.files.forEach(function (f) { c.delete(dlCacheKey(o.pfx, f)).catch(function () {}); });
        }).catch(function () {});
      });
      console.log('[dl] reconciled ghost playlist refs — freed ' + orphaned.length + ' prefix(es)');
      return true;
    }
    /* r78 — ORPHANED BUILT SESSIONS. A stitched session (te_dyn_meta_<ns>_<mode> + its file)
       persists INDEPENDENTLY of the clips it was built from; sweep the ones belonging to playlists
       that no longer exist. Matches BOTH separators (`pl-`/`pl_`) and takes the mode from the key
       itself. ⚠ ONLY EVER FROM THE AUTHORITATIVE PATH (called from dlReconcileRefs only).
       ⚠ NEVER TOUCH A NAMESPACE THAT IS NOT pl-/pl_ — topic sessions share this key space. */
    function dlSweepOrphanSessions(lists) {
      var live = {};
      (lists || []).forEach(function (p) { live[String(p.id)] = true; });
      var kill = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('te_dyn_meta_') !== 0) continue;
          var rest = k.slice(12), us = rest.lastIndexOf('_');
          if (us <= 0) continue;
          var ns = rest.slice(0, us), mode = rest.slice(us + 1);
          if (ns.indexOf('pl-') !== 0 && ns.indexOf('pl_') !== 0) continue;   // topic session — not ours
          if (live[ns.slice(3)]) continue;                                    // playlist still exists
          var meta = null;
          try { meta = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) {}
          kill.push({ key: k, ns: ns, mode: mode, meta: meta });
        }
      } catch (_) { return false; }
      if (!kill.length) return false;
      kill.forEach(function (o) {
        try { localStorage.removeItem(o.key); } catch (_) {}
        var meta = o.meta;
        if (DL_NATIVE && meta && meta.file) {
          DL_FS.deleteFile({ path: meta.file, directory: 'DATA' }).catch(function () {});
        } else if (window.caches) {
          caches.open(DL_CACHE).then(function (c) {
            return c.delete('/dyn/' + o.ns + '/' + o.mode + '.' + ((meta && meta.ext) || 'wav'));
          }).catch(function () {});
        }
      });
      console.log('[dl] swept ' + kill.length + ' orphaned built session(s)');
      return true;
    }
    /* Twin of player.js's dynNeededByOthers — which clips under `pfx` do the SURVIVING downloaded
       claimants still need? Returns null when it cannot answer safely: null means keep everything. */
    function dlNeededByOthers(pfx, dropRef, survivingRefs) {
      var dl = {}, lists = null;
      try { dl = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}'); } catch (_) {}
      try { lists = JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) {}
      if (!lists) return null;
      var known = {};
      lists.forEach(function (q) { known['pl-' + q.id] = q; });
      for (var i = 0; i < survivingRefs.length; i++) {
        var r = survivingRefs[i];
        if (r.indexOf('pl-') === 0 && !known[r]) return null;
      }
      var need = {};
      lists.forEach(function (q) {
        var ref = 'pl-' + q.id;
        if (ref === dropRef || !dl[q.id]) return;
        (q.items || []).forEach(function (it) {
          if (it.prefix !== pfx) return;
          var n = String(it.num).padStart(2, '0');
          need[pfx + '_S' + n + '_TH.mp3'] = true;
          need[pfx + '_S' + n + '_EN.mp3'] = true;
        });
      });
      return need;
    }
    /* r75 — every prefix in the manifest carrying this ref. Lock-independent ground truth. */
    function dlRefPrefixes(ref) {
      var m = dlManifest(), out = [];
      Object.keys(m).forEach(function (pfx) {
        var e = m[pfx];
        if (e && e.refs && e.refs.indexOf(ref) >= 0) out.push(pfx);
      });
      return out;
    }
    function dlClearOne(p) {
      var pm = dlPlMap(), rec = pm[p.id];
      var prefixes = (rec && rec.prefixes && rec.prefixes.length) ? rec.prefixes : null;
      if (!prefixes) {
        var byRef = dlRefPrefixes('pl-' + p.id);
        prefixes = byRef.length ? byRef : Object.keys(dlGroup(p));
      }
      var m = dlManifest();
      var chain = Promise.resolve();
      prefixes.forEach(function (pfx) {
        var e = m[pfx]; if (!e) return;
        e.refs = (e.refs || ['topic']).filter(function (r) { return r !== 'pl-' + p.id; });
        var files = e.files || [];
        if (e.refs.length) {
          if (e.refs.indexOf('topic') !== -1) { m[pfx] = e; return; }
          var need = dlNeededByOthers(pfx, 'pl-' + p.id, e.refs);
          if (!need) { m[pfx] = e; return; }
          var keep = files.filter(function (f) { return need[f]; });
          if (keep.length) {
            var go = files.filter(function (f) { return !need[f]; });
            e.files = keep; delete e.bytes; m[pfx] = e;
            chain = chain.then(function () {
              if (DL_NATIVE) return Promise.all(go.map(function (f) {
                return DL_FS.deleteFile({ path: 'offline/' + pfx + '/' + f, directory: 'DATA' }).catch(function () {});
              }));
              if (!window.caches) return null;
              return caches.open(DL_CACHE).then(function (c) {
                return Promise.all(go.map(function (f) { return c.delete(dlCacheKey(pfx, f)).catch(function () {}); }));
              }).catch(function () {});
            });
            return;
          }
        }
        delete m[pfx];
        chain = chain.then(function () {
          if (DL_NATIVE) return DL_FS.rmdir({ directory: 'DATA', path: 'offline/' + pfx, recursive: true }).catch(function () {});
          if (!window.caches) return null;
          return caches.open(DL_CACHE).then(function (c) {
            return Promise.all(files.map(function (f) { return c.delete(dlCacheKey(pfx, f)).catch(function () {}); }));
          }).catch(function () {});
        });
      });
      dlSetManifest(m);
      // The playlist's own built sessions go too - otherwise "cleared" leaves them behind.
      // r137: this block was the original of ThaiEarDL.dropSessions — now the shared one, so the
      // four surfaces that invalidate a session cannot drift apart again.
      ThaiEarDL.dropSessions('pl-' + p.id, DLCAP, DL_CACHE);
      delete pm[p.id]; dlSetPlMap(pm);
      return chain;
    }
    /* r78 — RELEASE CLIPS ORPHANED BY REMOVING SENTENCES. RE-DERIVE what every downloaded claimant
       still needs under the affected prefixes and free the remainder.
       ⚠ Call only AFTER PL().load(true) has refreshed thaiear_playlists.
       THE THREE BAIL-OUTS ARE THE SAFETY: no cached list → keep everything; a 'topic' ref present →
       keep everything (the topic needs every clip); a pl- ref we cannot resolve → keep everything. */
    function dlPruneUnneeded(prefixes) {
      var chain = Promise.resolve();
      if (!prefixes || !prefixes.length) return chain;
      var lists = null;
      try { lists = JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) {}
      if (!lists) return chain;                       // cannot evaluate → keep everything
      var dl = dlPlMap(), m = dlManifest(), changed = false;
      var known = {};
      lists.forEach(function (q) { known['pl-' + q.id] = q; });
      prefixes.forEach(function (pfx) {
        var e = m[pfx];
        if (!e || !e.refs) return;                    // no refs field = implicit TOPIC download
        if (e.refs.indexOf('topic') !== -1) return;   // topic claim needs every clip
        for (var i = 0; i < e.refs.length; i++) {
          var r = e.refs[i];
          if (r.indexOf('pl-') === 0 && !known[r]) return;   // unresolvable claim → keep it all
        }
        var need = {};
        lists.forEach(function (q) {
          if (!dl[q.id]) return;                      // not a DOWNLOADED claimant
          (q.items || []).forEach(function (it) {
            if (it.prefix !== pfx) return;
            var n = String(it.num).padStart(2, '0');
            need[pfx + '_S' + n + '_TH.mp3'] = true;
            need[pfx + '_S' + n + '_EN.mp3'] = true;
          });
        });
        var files = e.files || [];
        var go = files.filter(function (f) { return !need[f]; });
        if (!go.length) return;
        var keep = files.filter(function (f) { return need[f]; });
        changed = true;
        if (keep.length) { e.files = keep; delete e.bytes; m[pfx] = e; }
        else { delete m[pfx]; }
        chain = chain.then(function () {
          if (DL_NATIVE) return Promise.all(go.map(function (f) {
            return DL_FS.deleteFile({ path: 'offline/' + pfx + '/' + f, directory: 'DATA' }).catch(function () {});
          }));
          if (!window.caches) return null;
          return caches.open(DL_CACHE).then(function (c) {
            return Promise.all(go.map(function (f) { return c.delete(dlCacheKey(pfx, f)).catch(function () {}); }));
          }).catch(function () {});
        });
      });
      if (changed) dlSetManifest(m);
      return chain;
    }
    /* r85 — WHAT EACH VERB CAN ACT ON. */
    function dlNeedsDownload(p) {
      var st = dlState(p);
      return st !== 'downloaded';          // none / available / update all have something to fetch
    }
    function dlHasDownload(p) {
      return !!dlPlMap()[p.id];            // a record of its OWN — 'available' is someone else's bytes
    }
    /* r85 — REMOVE ALL. ⚠⚠ ENUMERATE AND DELETE. NEVER `caches.delete('thaiear-audio-dl')` — the
       Read Thai course shares that bucket and must never be touched by this button. */
    function dlRemoveAll() {
      if (dlBusy) return;
      var m = dlManifest(), prefixes = Object.keys(m);
      // §D.1: the typed-REMOVE dialog now lives in dl-core.js as ThaiEarDL.removeAllModal — shared
      // with dyn-index.html so the two Remove All dialogs can never drift again.
      ThaiEarDL.removeAllModal(prefixes.length, function () {
          dlSetBusy(true);
          dlStatusDots('Removing all downloads');
        // §D.1: the disk sweep now lives in dl-core.js as ThaiEarDL.removeAllDownloads.
        ThaiEarDL.removeAllDownloads(DLCAP, DL_CACHE).then(function () {
            dlSel = {};
            dlSetBusy(false);
            dlStatus('All downloads removed.');
            render();
          });
        });
    }
    function dlRunClear() {
      if (dlBusy) return;
      var lists = currentLists() || [];
      var picked = lists.filter(function (p) { return dlSel[p.id] && dlHasDownload(p); });
      if (!picked.length) { dlStatus('Select a downloaded playlist first.'); return; }
      showModal({
        title: 'Remove ' + (picked.length > 1 ? 'these downloads?' : 'this download?'),
        body: 'You will no longer be able to listen to ' + (picked.length > 1 ? 'them' : 'it') +
          ' offline. The playlist itself is not affected.',
        confirmText: 'Remove', danger: true,
        onConfirm: function () {
          dlSetBusy(true);
          var i = 0;
          (function next() {
            if (i >= picked.length) {
              dlSetBusy(false);
              dlStatus('Removed ' + picked.length + ' download' + (picked.length > 1 ? 's' : '') + '.');
              dlSel = {}; render();
              return;
            }
            dlStatus('Removing “' + picked[i].name + '”...');
            dlClearOne(picked[i]).then(function () { i++; render(); next(); });
          })();
        }
      });
    }

    function render() {
      // a re-render invalidates any live batch-remove tick mode
      removing = null;
      setTimeout(dlPaintBar, 0);
      var rb = document.getElementById('dyn-rm-bar');
      if (rb) rb.parentNode.removeChild(rb);
      if (authReady() && !user()) {
        paintedJson = null;
        root.innerHTML = '<p class="pl-note">Sign in (via the Menu) to create and play playlists. Playlists are free for every account.</p>';
        return;
      }
      var lists = currentLists();
      if (!lists) { showLoading(); return; }   // no cache on this device yet → indicator until load resolves
      paintedJson = JSON.stringify(lists);
      if (!lists.length) {
        root.innerHTML = '<p class="pl-note">No playlists yet. Tap <strong>＋ Add playlist</strong>, then add sentences from any topic page (the “＋ Add sentences…” button under its player).</p>';
        return;
      }
      root.innerHTML = lists.map(function (p) {
        var st = dlState(p);
        return '<div class="pl-box' + (p.id === openId ? ' open' : '') + '" data-id="' + p.id + '">' +
          '<button class="pl-box-head" type="button">' +
            '<span class="pl-box-name">' + esc(p.name) + '</span>' +
            '<span class="pl-box-meta">' + p.items.length + ' sentence' + (p.items.length === 1 ? '' : 's') +
              (st === 'downloaded' ? ' · downloaded'
                : st === 'available' ? ' · available offline'
                : st === 'update' ? ' · update available' : '') + '</span>' +
            dlControl(p, st) +
          '</button>' +
          '<div class="pl-box-body">' +
            (p.items.length
              // Open playlist → the ?pl= PLAYER, which stays its own top-level page. Not the panel.
              ? '<a class="pl-open" href="playlists.html?pl=' + encodeURIComponent(p.id) + '">▶ Open player</a>'
              : '<p class="pl-note">This playlist is empty.</p>') +
            (p.items.length ? '<button class="pl-remsent" type="button">Remove sentences</button>' : '') +
            '<button class="pl-rename" type="button">Rename playlist</button>' +
            '<button class="pl-del" type="button">Delete playlist</button>' +
          '</div></div>';
      }).join('');
      root.querySelectorAll('.pl-box').forEach(function (box) {
        var id = box.getAttribute('data-id');
        var p = lists.filter(function (x) { return x.id === id; })[0];
        box.querySelector('.pl-box-head').addEventListener('click', function () {
          openId = (openId === id) ? null : id;
          render();
        });
        var rs = box.querySelector('.pl-remsent');
        if (rs) rs.addEventListener('click', function () { enterRemove(box, p); });
        box.querySelector('.pl-rename').addEventListener('click', function () {
          showModal({
            title: 'Rename “' + p.name + '”',
            input: { value: p.name, maxlength: 60 },
            confirmText: 'Save name',
            onConfirm: function (name) {
              if (!name || name === p.name) return;
              PL().rename(id, name).then(function () { render(); })
                .catch(function () { msgModal('Couldn’t rename', 'You appear to be offline. Reconnect and try again.'); });
            }
          });
        });
        box.querySelector('.pl-del').addEventListener('click', function () {
          showModal({
            title: 'Delete “' + p.name + '”?',
            body: 'This can’t be undone — the sentences themselves are not affected.',
            confirmText: 'Delete playlist', danger: true,
            onConfirm: function () {
              /* Release the download claim as part of the delete. dlClearOne() is the ONLY thing
                 that can remove this playlist's 'pl-<id>' ref. Order matters — remove() is the
                 network op that can fail, so it goes FIRST. `p` is captured here, so it survives
                 the record. */
              PL().remove(id)
                .then(function () { return dlClearOne(p); })
                .then(function () { if (openId === id) openId = null; render(); })
                .catch(function () { msgModal('Couldn’t delete', 'You appear to be offline. Reconnect and try again.'); });
            }
          });
        });
      });
    }

    /* ── Remove sentences: native tick mode over simple item rows ── */
    var removing = null;   // { id, marked: {tk|num: {topic_key, num}} }
    function enterRemove(box, p) {
      if (removing) return;
      removing = { id: p.id, marked: {} };
      box.classList.add('rm-mode');   /* r76: hide this row's other actions while selecting */
      var body = box.querySelector('.pl-box-body');
      var listEl = document.createElement('div');
      listEl.className = 'dyn-list removing pl-rm-list';
      listEl.innerHTML = p.items.map(function (it) {
        var key = it.topic_key + '|' + it.num;
        return '<div class="dyn-card" data-key="' + esc(key) + '">' +
          '<span class="dyn-tick" aria-hidden="true"></span>' +
          '<div class="dyn-txt"><div class="dyn-th">' + esc(String(it.thai).replace(/\s*\|\s*/g, ' ')) + '</div>' +
          '<div class="dyn-en">' + esc(it.english) + '</div></div></div>';
      }).join('');
      body.insertBefore(listEl, body.firstChild);
      listEl.querySelectorAll('.dyn-card').forEach(function (card) {
        card.addEventListener('click', function () {
          if (!removing) return;
          var key = card.getAttribute('data-key');
          if (removing.marked[key]) { delete removing.marked[key]; }
          else {
            var cut = key.lastIndexOf('|');
            removing.marked[key] = { topic_key: key.slice(0, cut), num: +key.slice(cut + 1) };
          }
          card.querySelector('.dyn-tick').classList.toggle('on', !!removing.marked[key]);
          rmCount();
        });
      });
      var bar = document.getElementById('dyn-rm-bar');
      if (!bar) { bar = document.createElement('div'); bar.id = 'dyn-rm-bar'; document.body.appendChild(bar); }
      bar.innerHTML = '<span id="dyn-rm-count"></span>' +
        '<span style="display:flex;gap:8px">' +
          '<button type="button" class="dyn-rm-cancel">Cancel</button>' +
          '<button type="button" class="dyn-rm-done">Done</button></span>';
      bar.querySelector('.dyn-rm-cancel').addEventListener('click', exitRemove);
      bar.querySelector('.dyn-rm-done').addEventListener('click', function () { rmDone(p); });
      bar.classList.add('show');
      rmCount();
    }
    function rmCount() {
      var c = document.getElementById('dyn-rm-count');
      if (!c || !removing) return;
      var n = 0; for (var k in removing.marked) n++;
      c.textContent = n + ' to remove';
    }
    function exitRemove() {
      removing = null;
      /* r76: clear the select-mode class wherever it is — queried, not captured, because render()
         can rebuild the DOM underneath us. */
      var rm = document.querySelector('.pl-box.rm-mode');
      if (rm) rm.classList.remove('rm-mode');
      var bar = document.getElementById('dyn-rm-bar');
      if (bar) bar.parentNode.removeChild(bar);
      var l = document.querySelector('.pl-rm-list');
      if (l) l.parentNode.removeChild(l);
    }
    function rmDone(p) {
      if (!removing) return;
      var items = [];
      for (var k in removing.marked) items.push(removing.marked[k]);
      if (!items.length) { exitRemove(); return; }
      /* r78: capture the prefixes of the sentences about to go, from the playlist's CURRENT items
         — after the removals land those entries are gone and the prefix is unrecoverable. */
      var affected = {};
      items.forEach(function (it) {
        (p.items || []).forEach(function (x) {
          if (x.topic_key === it.topic_key && x.num === it.num && x.prefix) affected[x.prefix] = 1;
        });
      });
      var bar = document.getElementById('dyn-rm-bar');
      var btns = bar ? bar.querySelectorAll('button') : [];
      btns.forEach(function (b) { b.disabled = true; });
      var cnt = document.getElementById('dyn-rm-count');
      var chain = Promise.resolve();
      items.forEach(function (it, i) {
        chain = chain.then(function () {
          if (cnt) cnt.textContent = 'Removing… ' + (i + 1) + ' of ' + items.length;
          return PL().removeItem(p.id, it.topic_key, it.num);
        });
      });
      chain.then(function () { exitRemove(); return PL().load(true); })
        /* r78: prune AFTER the reload, so `need` is computed from the post-removal contents. */
        .then(function () { return dlPruneUnneeded(Object.keys(affected)).catch(function () {}); })
        .then(function () { render(); })
        .catch(function () {
          btns.forEach(function (b) { b.disabled = false; });
          rmCount();
          msgModal('Couldn’t remove', 'You appear to be offline. Reconnect and try again.');
        });
    }

    (function wireDownloads() {
      var d = document.getElementById('dl-btn'), c = document.getElementById('clear-btn');
      var ra = document.getElementById('removeall-btn');
      if (d) d.addEventListener('click', dlRunDownloads);
      if (c) c.addEventListener('click', dlRunClear);
      if (ra) ra.addEventListener('click', dlRemoveAll);
      /* r137 — the audio-version map arrives async, and dlState() reads it synchronously, so the
         first paint can legitimately miss a stale playlist. Repaint once it lands (same pattern as
         the index's loadAv().then(renderGrid)). Offline this simply resolves to null and nothing
         is ever flagged — the conservative default dlAvStale() is built on. */
      dlAvLoad().then(function () { render(); }).catch(function () {});
    })();

    (function () {
      var n = document.getElementById('dl-share-note'), b = document.getElementById('dl-share-more');
      if (n && b) b.addEventListener('click', function () {
        n.classList.toggle('open');
        b.textContent = n.classList.contains('open') ? 'less' : 'more';
      });
    })();
    document.getElementById('pl-add').addEventListener('click', function () {
      if (!user()) { msgModal('Sign in to create playlists', 'Use the Menu to sign in — playlists are saved to your account.'); return; }
      showModal({
        title: 'New playlist',
        input: { value: '', maxlength: 60 },
        confirmText: 'Create',
        onConfirm: function (name) {
          if (!name) return;
          PL().create(name.slice(0, 60)).then(function (p) { openId = p.id; render(); })
            .catch(function (e) {
              var msg = (e && (e.message || e.details || e.hint)) || JSON.stringify(e);
              msgModal('Couldn’t create the playlist', /failed to fetch|load failed|network/i.test(String(msg))
                ? 'You appear to be offline. Reconnect and try again.' : String(msg));
            });
        }
      });
    });

    // CACHE-FIRST: paint the localStorage copy immediately (no waiting on auth/server); the
    // loading indicator only appears when this device has no cache at all.
    render();
    (function wait() {
      if (!authReady()) { setTimeout(wait, 250); return; }
      if (!PL() || !user()) { render(); return; }
      PL().load(true).then(function (lists) {
        /* The one authoritative list — the only safe moment to reconcile ghost refs. "authoritative"
           has to be ASKED FOR, not assumed: load() catches internally and RESOLVES with the
           localStorage copy, so a failed load is indistinguishable from a good one here.
           FAIL CLOSED, deliberately: if auth.js is an older cached copy with no authoritative(), skip
           reconciling rather than assume the list is trustworthy. */
        var freed = (PL().authoritative && PL().authoritative()) ? dlReconcileRefs(lists) : false;
        // repaint when the server copy differs from what's on screen, or the manifest just changed
        if (freed || JSON.stringify(lists || []) !== paintedJson) render();
      }).catch(function () {
        if (paintedJson === null) root.innerHTML = '<p class="pl-note">Couldn’t load playlists — check your connection.</p>';
      });
    })();
    window.addEventListener('thaiear:auth', function () {
      if (PL()) PL().load(true).then(render);
    });
    /* r80 — REPAINT ON RETURN. Two different responses:
         · pageshow[persisted] = a genuine bfcache restore, rare → reload contents AND repaint;
         · visibilitychange = app foregrounded, frequent → repaint only.
       ⚠ Skipped while a remove-sentences selection is open: render() clears `removing`, so
       repainting on app-switch would silently discard the user's ticks. */
    function repaintOnReturn(reload) {
      if (removing) return;  // never destroy an open selection
      if (reload && PL() && user() && navigator.onLine) {
        PL().load(true).then(render).catch(render);
        return;
      }
      render();
    }
    window.addEventListener('pageshow', function (e) { if (e && e.persisted) repaintOnReturn(true); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) repaintOnReturn(false); });
  }

  window.ThaiEarPlList = { mount: mount };
})();
