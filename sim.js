/* ============================================================================
   sim.js — OWNER ENTITLEMENT SIMULATOR (test build only)
   ----------------------------------------------------------------------------
   Lets the owner exercise premium/member gating — online AND offline — without
   touching a real Supabase account or waiting a month for a subscription to
   lapse. Loaded by playlists.html and the topic-test pages; read by player.js.

   THE DESIGN RULE THAT MAKES IT A REAL TEST:
     It overrides only the AUTH ANSWER, never a decision. The simulated account
     is injected at the ThaiEarAuth boundary (getUser / isSubscribed) — exactly
     where the real Supabase answer enters the app — and every downstream check
     then runs UNMODIFIED on it: canUseOffline, the 30-day grace arithmetic,
     sentLocked, entitledForPage, the licence overlay.
     A switch that forced canUseOffline() to return false would prove nothing;
     it would bypass the code under test. Likewise `elapse()` overrides nothing
     at all — it BACKDATES the real localStorage markers and lets the real
     arithmetic decide.

   WHAT IT CANNOT DO: change the SERVER's answer. /api/audio still sees the
   owner's real, valid token, so a genuinely-subscribed owner is still handed
   signed URLs. setDeny(true) covers that gap by making the client treat every
   gated request as refused (402) — which is what exercises the
   "server disagrees with the client" fallback in dynBuildSessionFor.

   Everything here is INERT unless a flag is set, and the whole file (plus its
   <script> tags and the ~10 lines in player.js that call it) is deleted at
   rollout.
   ============================================================================ */
(function () {
  'use strict';

  var K_TIER = 'te_sim_tier';       // '' | 'premium' | 'premium-nolife' | 'expired' | 'signedout'
  var K_NOID = 'te_sim_no_identity';// '1' = DISARM the durable offline identity (reproduce the bug)
  var K_DENY = 'te_sim_deny';       // '1' = pretend /api/audio returns 402
  var K_ELAPSED = 'te_sim_elapsed'; // days backdated, for the panel's own display
  var K_BACKUP = 'te_sim_backup';   // originals, so Restore is exact

  // The real markers canUseOffline() reads. Backdating these IS the elapsed-time test.
  //   thaiear_lastVerified — when the subscription was last confirmed online
  //   thaiear_sub_until    — captured real period end; an OR-branch that grants access on its
  //                          own, so it has to move too or nothing changes
  //   thaiear_lifetime     — lifetime members never time out, so it must be lifted
  var LICENCE_KEYS = ['thaiear_lastVerified', 'thaiear_sub_until', 'thaiear_lifetime'];

  /* ── BOOT TRACE ─────────────────────────────────────────────────────────────────────────
     "It logs out for half a second and then logs back in" has now defeated two fixes reasoned
     from the code. This records what ACTUALLY happens during a boot — sim.js's purge, then every
     decision auth.js makes — so the next run names the mechanism instead of inviting a third
     guess. Reset at each sim.js load; auth.js appends. Inert without sim.js, i.e. in production. */
  var K_TRACE = 'te_sim_trace';
  var K_ID_PEEK = 'thaiear_identity';   // read-only peek for the trace; auth.js owns this key
  /* ⚠ CONSECUTIVE DUPLICATES COLLAPSE TO "msg ×N" — THE INSTRUMENT MUST NOT DESTROY THE EVIDENCE.
     2026-07-31: an E9 boot trace came back as 60/60 lines of "stampOfflineLicence SUPPRESSED",
     because an entitlement check runs PER SENTENCE per render and the buffer is only 60 deep. The
     flood had evicted every line about the run being investigated, so the trace was unreadable
     exactly when it was needed. This is the third time an instrument on this project has hidden its
     own evidence (see also the purge control and the repaint-lagged checkbox), so the fix is
     structural rather than a one-off silencing of that message: no repeated line, present or
     future, can ever flush the buffer again. */
  function trace(msg) {
    try {
      var stamp = new Date().toISOString().slice(17, 23);
      var t = JSON.parse(localStorage.getItem(K_TRACE) || '[]');
      var last = t.length ? t[t.length - 1] : '';
      // Match on the message body, ignoring the leading timestamp and any existing "×N" suffix.
      var body = last.replace(/^\d{2}\.\d{3} /, '').replace(/ ×\d+$/, '');
      if (body === msg) {
        var n = (/ ×(\d+)$/.exec(last) || [0, 1])[1];
        t[t.length - 1] = stamp + ' ' + msg + ' ×' + (parseInt(n, 10) + 1);
      } else {
        t.push(stamp + ' ' + msg);
      }
      localStorage.setItem(K_TRACE, JSON.stringify(t.slice(-60)));
    } catch (_) {}
  }
  function traceRead() { try { return JSON.parse(localStorage.getItem(K_TRACE) || '[]'); } catch (_) { return []; } }

  function get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (_) {} }

  function tier() { var v = get(K_TIER) || ''; return v === 'off' ? '' : v; }
  function denies() { return get(K_DENY) === '1'; }
  function elapsedDays() { var v = get(K_ELAPSED); return v ? parseInt(v, 10) : 0; }

  /* The auth VIEW every entitlement check reads. With no simulation this returns the real
     ThaiEarAuth untouched; with one, a read-only shim of the same shape, so callers cannot
     tell the difference. */
  /* ⚠ DELEGATE, never enumerate. This shim used to be a hand-written object listing the handful
     of methods I happened to think of — so ThaiEarAuth.playlists (and dynPrefs, and anything
     added later) simply did not exist on it. The moment player.js started reading AUTHV() instead
     of window.ThaiEarAuth, "Add to a playlist" died with "Playlists unavailable".
     Object.create(real) inherits EVERY property through the prototype chain and lets us override
     only the three answers the simulation is actually about, so nothing can be missing again. */
  function authView(real) {
    var s = tier();
    if (!real || !s) return real;
    var signedIn = (s !== 'signedout');
    // 'premium-nolife' = a real paying subscriber who is NOT a lifetime member. Needed because a
    // lifetime account can't exercise the offline-expiry paths at all: canUseOffline returns true
    // on the lifetime flag before any date arithmetic runs, and auth.js's refreshLifetime rewrites
    // that flag every time it confirms the account online. auth.js honours this state by clearing
    // (and not re-setting) thaiear_lifetime — an override of the SERVER's lifetime answer, not of
    // the expiry decision, which still runs for real.
    var subbed = (s === 'premium' || s === 'premium-nolife');
    var view = Object.create(real);          // inherits playlists, dynPrefs, signOut, everything
    view.isReady = true;
    view.getUser = function () { return signedIn ? (real.getUser ? real.getUser() : { sim: true }) : null; };
    view.isSubscribed = function () { return subbed; };
    /* WHO you are is simulated; whether the server could ANSWER is not — that must stay real, or
       the simulation cannot reproduce being offline. Returning true unconditionally made every
       state look like a fresh server verdict, so the offline branch was unreachable. */
    view.isSubscriptionFresh = function () {
      return !!(real.isSubscriptionFresh && real.isSubscriptionFresh());
    };
    view.getSubscription = function () { return (subbed && real.getSubscription) ? real.getSubscription() : null; };
    return view;
  }

  // Backdate the licence markers by `days`. Stashes the originals once, so repeated calls (or a
  // different day count) never lose the true values.
  // Snapshot the REAL markers once, before anything mutates them. Must run before EVERY path
  // that writes them (elapse and the armed branch of restore), or arming a state first would
  // clear thaiear_lifetime with nothing recorded to put back.
  function stash() {
    if (get(K_BACKUP)) return;
    var b = {};
    LICENCE_KEYS.forEach(function (k) { b[k] = get(k); });
    set(K_BACKUP, JSON.stringify(b));
  }
  function elapse(days) {
    if (!days) { restore(); return; }
    stash();
    var past = Date.now() - days * 24 * 60 * 60 * 1000;
    set('thaiear_lastVerified', past);
    set('thaiear_sub_until', past);      // period end in the past too
    set('thaiear_lifetime', null);       // lifetime would otherwise never expire
    set(K_ELAPSED, days);
  }

  /* "Now" means "last verified just now" — NOT "give me my real membership back".
     It used to restore the backup unconditionally, which handed the owner's genuine
     thaiear_lifetime='1' and future sub_until to a simulated EXPIRED account. canUseOffline
     short-circuits on the lifetime flag before any other check, so Expired + Now granted full
     access and the simulation looked broken.
     While an account state is armed, the simulator owns these markers: set lastVerified to now
     and clear the two that would override the simulated account. The REAL values are only put
     back when the simulation is switched off (Account: Real), which is the only moment they
     should return. */
  function restore() {
    if (tier()) {
      stash();
      set('thaiear_lastVerified', Date.now());
      set('thaiear_lifetime', null);
      set('thaiear_sub_until', null);
      set(K_ELAPSED, null);
      return;
    }
    restoreReal();
  }
  function restoreReal() {
    var raw = get(K_BACKUP);
    if (raw) {
      var b = {};
      try { b = JSON.parse(raw) || {}; } catch (_) {}
      LICENCE_KEYS.forEach(function (k) { set(k, b[k]); });
      set(K_BACKUP, null);
    }
    set(K_ELAPSED, null);
  }

  /* Reproduce the 8-hours-offline logout in one tap, instead of waiting 8 hours.
     supabase-js 2.111.0, on a refresh failure that isn't a retryable FETCH error while the access
     token has already expired, calls _removeSession() — which deletes sb-<ref>-auth-token from
     localStorage. That single deletion is the whole bug: auth.js's old guard read that key, so
     once it vanished the user was logged out for good and the refresh token went with it.
     This deletes exactly that key and nothing else. Reload afterwards:
       BEFORE the fix → signed out, sign-in does nothing offline.
       AFTER  the fix → still signed in (restored from thaiear_identity), and reconnecting
                        silently re-seeds the supabase session from the stored refresh token. */
  function killSbKeys() {
    var killed = [];
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) {
          localStorage.removeItem(k); killed.push(k);
        }
      }
    } catch (_) {}
    return killed;
  }
  /* Deleting the key is not enough on its own: the CURRENT page still has a live supabase client
     holding the session in memory, and it re-saves. Its auto-refresh ticks every ~30 s, and iOS
     also re-runs recovery on visibilitychange — either of which rewrites sb-<ref>-auth-token
     while you are reading the confirm dialog. The session then reappears on the next load and the
     test silently passes when it should have failed. (Observed: "logged out for a split second,
     then logged back in.")
     So arm a one-shot BOOT purge as well. sim.js is a synchronous script that runs before nav.js
     injects auth.js, so re-killing the key here — at load, below — guarantees supabase-js starts
     the next page with genuinely no stored session, whatever the old page did on its way out. */
  /* STICKY, not one-shot. The first version armed a flag consumed on the next boot — and the boot
     trace showed it arriving as pf=0 kill=0 sb=1, i.e. the flag was simply not there and Supabase's
     own session signed the user straight back in. Rather than keep theorising about what ate a
     one-shot flag on a real device (dialog behaviour, an intervening load, WebView lifecycle), make
     the state DURABLE: while "keep purged" is on, sim.js deletes the supabase key on EVERY load,
     before auth.js exists. No timing to get wrong, and you can navigate the test space freely with
     the session reliably absent. Turn it off to go back to normal. */
  var K_KEEP_PURGED = 'te_sim_keep_purged';
  function keepPurged() { return get(K_KEEP_PURGED) === '1'; }
  function setKeepPurged(on) { set(K_KEEP_PURGED, on ? '1' : null); if (!on) return []; return killSbKeys(); }
  function purgeSupabaseSession() {
    set(K_KEEP_PURGED, '1');
    return killSbKeys();
  }

  /* Expire the stored ACCESS token — reproduces "I lost premium after an hour or two".
     The JWT lives ~1 h; once it lapses supabase-js must refresh it, and offline that refresh
     fails and fires a null-session auth change even though nobody signed out. This rewrites
     expires_at/expires_in in supabase's own stored session to the past, which is exactly the
     state the app reaches after an hour idle — then reload and watch what the REAL code does.
     It edits only those two timestamp fields; the tokens and user are left intact. */
  function expireAccessToken() {
    var hits = [];
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('sb-') !== 0 || k.indexOf('-auth-token') === -1) continue;
        var o = JSON.parse(localStorage.getItem(k) || 'null');
        var s = (o && o.currentSession) ? o.currentSession : o;
        if (!s) continue;
        var past = Math.floor(Date.now() / 1000) - 3600;   // an hour ago
        s.expires_at = past;
        s.expires_in = 0;
        localStorage.setItem(k, JSON.stringify(o));
        hits.push(k);
      }
    } catch (_) {}
    return hits;
  }

  /* DISARM the durable offline identity. This is the CONTROL: with it on, auth.js ignores
     thaiear_identity and behaves exactly as it did before the fix, so purge + reload should log
     you out. Turn it back off and the same sequence should keep you signed in. Without this you
     are taking the fix on trust — with it you can watch the bug appear and disappear. */
  function noIdentity() { return get(K_NOID) === '1'; }
  function setNoIdentity(on) { set(K_NOID, on ? '1' : null); }

  /* HARD reload: drop the service-worker SHELL cache and re-register, so the next load definitely
     comes from the network. Only useful ONLINE (offline there is nothing to re-fetch, and you'd
     just have thrown away the shell).
     ⚠ The shell cache is `thaiear-<VERSION>` (e.g. thaiear-v81) but the DOWNLOAD caches are
     `thaiear-dl` and `thaiear-audio-dl`. A naive 'thaiear-' prefix match would delete the user's
     downloaded audio — the very thing under test. Match the version shape explicitly. */
  var SHELL_CACHE_RE = /^thaiear-v\d+$/;
  function hardReload() {
    var jobs = [];
    try {
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (keys) {
          return Promise.all(keys.filter(function (k) { return SHELL_CACHE_RE.test(k); })
            .map(function (k) { return caches.delete(k); }));
        }));
      }
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
          return Promise.all(rs.map(function (r) { return r.update().catch(function () {}); }));
        }));
      }
    } catch (_) {}
    return Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }
  // Which shell cache is actually present — so the panel can SHOW the build rather than guess.
  function shellCaches() {
    if (!window.caches || !caches.keys) return Promise.resolve([]);
    return caches.keys().then(function (k) { return k.filter(function (x) { return SHELL_CACHE_RE.test(x); }); })
      .catch(function () { return []; });
  }

  /* ── GATED-AUDIO PROBE ──────────────────────────────────────────────────────────────────
     Checklist step 1.4 ("after a purge, does gated audio still work?") previously meant leaving
     this page for a topic or playlist — at which point you are no longer testing the state you
     just created, and a reload en route can mask the very fault being looked for. These three
     buttons exercise the gate IN PLACE.

     One real free clip, one member, one premium — chosen from the three test units so they are
     the same files the player itself requests:
       free    → straight off the public CDN, no token. The CONTROL: if this fails too, it is the
                 network, not the gate.
       member  → /api/audio, needs a signed-in user
       premium → /api/audio, needs an active subscription (this is the one 1.4 cares about)

     Scope, stated honestly: this tests TOKEN → /api/audio → signed URL → the bytes play. It does
     NOT exercise the player's offline clip resolution or session stitching — those are covered by
     actually playing a topic. Offline it will fail on the network, which is expected and reported
     as such rather than as a gate failure. */
  var PROBE = {
    free:    { file: 'CommSurvival_BEG_S53_TH.mp3',            gated: false, label: 'free (control)' },
    member:  { file: 'ShoppingAndMoney_BEG_S323_TH.mp3',       gated: true,  label: 'member' },
    premium: { file: 'ColoursAndDescriptions2_BEG_S87_TH.mp3', gated: true,  label: 'premium' }
  };
  function probeAudio(kind) {
    var p = PROBE[kind];
    if (!p) return Promise.resolve({ ok: false, note: 'unknown probe' });
    if (!p.gated) {
      return Promise.resolve({ ok: true, url: 'https://audio.thaiear.com/' + p.file, note: 'public CDN, no token' });
    }
    var a = window.ThaiEarAuth;
    var tok = a && a.getAccessToken && a.getAccessToken();
    if (!tok) return Promise.resolve({ ok: false, note: 'no access token — not signed in?' });
    return fetch('/api/audio?file=' + encodeURIComponent(p.file), { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j && j.url) return { ok: true, url: j.url, note: 'HTTP ' + r.status + ' — signed URL issued' };
          // 401 = token rejected (this is what a STALE token after a purge looks like)
          // 402 = signed in but no subscription · 403 = token invalid
          return { ok: false, note: 'HTTP ' + r.status + (j && j.error ? ' — ' + j.error : '') };
        });
      })
      .catch(function (e) { return { ok: false, note: 'network error (' + (e && e.message || 'offline?') + ')' }; });
  }

  function reset() { set(K_TIER, null); set(K_DENY, null); set(K_NOID, null); set(K_KEEP_PURGED, null); restoreReal(); }

  function active() { return !!tier() || !!elapsedDays() || denies() || noIdentity() || keepPurged(); }

  /* One-shot boot purge — runs NOW, at script load, before auth.js exists. This is the half of
     the purge that actually makes the test honest; see purgeSupabaseSession() above. */
  var bootPurged = [];
  /* Do NOT clear per load. The panel is on a different page from the failure, so navigating to
     read the trace used to erase the very run being investigated. Keep a rolling buffer across
     loads with a page marker, and clear explicitly from the panel instead. */
  trace('── load ' + (location.pathname.split('/').pop() || '/') + ' ──');
  // Sticky: enforced on EVERY load while armed, before auth.js exists.
  if (keepPurged()) bootPurged = killSbKeys();
  function sbKeysPresent() {
    var n = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) n.push(k);
      }
    } catch (_) {}
    return n;
  }
  trace('BUILD r30b');
  trace('sim tier=' + (tier() || 'real') + ' dis=' + (noIdentity()?1:0) + ' kp=' + (keepPurged()?1:0) + ' kill=' + bootPurged.length +
        ' sb=' + sbKeysPresent().length + ' id=' + (get(K_ID_PEEK)?1:0) +
        ' so=' + (get('thaiear_signed_out')==='1'?1:0));

  /* ── ARMED BADGE ────────────────────────────────────────────────────────────────────────
     The simulator is already test-space-wide: sim.js is loaded on topic-test / test2 / test3 /
     playlists, and the state lives in localStorage, so setting it once governs every one of them.
     What was missing is that nothing on a TOPIC page told you it was armed — which is exactly how
     a forgotten toggle turns into a false bug report ("premium is locked!" when you set Expired
     twenty minutes ago). So whenever anything is armed, stamp a small badge on every page, and
     make it a link back to the panel so the settings are reachable without hunting.
     Renders nothing at all when the simulator is idle, i.e. for every real user. */
  /* Reaching topic-test3 meant going out through the real index and back in — and leaving the
     test space is exactly when a reload can reset the state you just set up. sim.js is loaded on
     every test page and nowhere else, so it is the natural (and single) place to own a test-space
     nav: one strip, every page, no duplication.
     `?k=` is carried on every link so the password gate never interrupts, and the armed state is
     shown in the same strip — a forgotten toggle is how a stale simulation becomes a false bug
     report. Real users never see this: sim.js ships only on the password-gated test pages. */
  var TEST_PAGES = [
    ['dyn-index.html', 'Index'],
    ['topic-test.html', '1·free'],
    ['topic-test2.html', '2·member'],
    ['topic-test3.html', '3·premium'],
    ['playlists.html', 'Playlists + SIM']
  ];
  function mountBadge() {
    if (document.getElementById('te-sim-bar')) return;
    var here = (location.pathname.split('/').pop() || '').replace(/\.html$/, '');
    var bar = document.createElement('div');
    bar.id = 'te-sim-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#2A2118;' +
      'display:flex;align-items:center;gap:2px;padding:4px 6px;overflow-x:auto;white-space:nowrap;' +
      '-webkit-overflow-scrolling:touch;box-shadow:0 1px 6px rgba(0,0,0,.35)';
    TEST_PAGES.forEach(function (p) {
      var a = document.createElement('a');
      var on = (here === p[0].replace(/\.html$/, ''));
      a.href = p[0] + '?k=cu38961y';
      a.textContent = p[1];
      a.style.cssText = 'flex:0 0 auto;font:600 11px/1 system-ui,sans-serif;padding:6px 8px;border-radius:5px;' +
        'text-decoration:none;color:' + (on ? '#2A2118' : '#E8DCC4') + ';background:' + (on ? '#E8DCC4' : 'transparent');
      bar.appendChild(a);
    });
    /* ⚠ READ THE TRACE FROM *ANY* TEST PAGE — added 2026-07-31 because this cost two captures.
       The boot trace panel lives on playlists.html, but the faults happen on topic pages, and in
       airplane mode the owner could not get back to it at all (no address bar, strip route lands on
       a playlists page whose panel was hidden). Asking someone to reproduce a fault in one place and
       read the evidence in another is a broken workflow, not a tester problem.
       This button dumps the whole trace into a scrollable overlay ON THE CURRENT PAGE, with a copy
       button, so the evidence is always where the failure is. Works offline — it is pure
       localStorage. */
    var tb = document.createElement('button');
    tb.type = 'button';
    tb.textContent = '📋 trace';
    tb.style.cssText = 'flex:0 0 auto;font:600 11px/1 system-ui,sans-serif;padding:6px 8px;border-radius:5px;' +
      'border:none;color:#2A2118;background:#C9A227;cursor:pointer';
    tb.addEventListener('click', function () {
      var old = document.getElementById('te-sim-tracepop'); if (old) { old.remove(); return; }
      var pop = document.createElement('div');
      pop.id = 'te-sim-tracepop';
      pop.style.cssText = 'position:fixed;inset:34px 8px 8px;z-index:2147483647;background:#1E1811;color:#E8DCC4;' +
        'border-radius:8px;padding:10px;overflow:auto;-webkit-overflow-scrolling:touch;' +
        'font:600 11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;box-shadow:0 4px 24px rgba(0,0,0,.5)';
      var lines = traceRead();
      pop.textContent = lines.length ? lines.join('\n') : '(no trace — reload to capture one)';
      var row = document.createElement('div');
      row.style.cssText = 'position:sticky;top:0;display:flex;gap:6px;margin:-10px -10px 8px;padding:8px 10px;background:#1E1811';
      ['📋 Copy', 'Clear', 'Close'].forEach(function (label) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.style.cssText = 'font:600 11px/1 system-ui,sans-serif;padding:6px 10px;border-radius:5px;border:none;cursor:pointer;background:#C9A227;color:#2A2118';
        b.addEventListener('click', function () {
          if (label === 'Close') { pop.remove(); return; }
          if (label === 'Clear') { set(K_TRACE, '[]'); pop.remove(); return; }
          var txt = (traceRead() || []).join('\n');
          try { navigator.clipboard.writeText(txt).then(function () { b.textContent = '✓ copied'; },
            function () { b.textContent = '✗ screenshot it'; }); }
          catch (_) { b.textContent = '✗ screenshot it'; }
        });
        row.appendChild(b);
      });
      pop.insertBefore(row, pop.firstChild);
      document.body.appendChild(pop);
    });
    bar.appendChild(tb);
    /* 📦 STORE DUMP — added 2026-07-31 because a whole evening of delete/size bugs was diagnosed by
       READING code and guessing at state, and the last one could not be resolved that way at all.
       Every question in this class ("why is this still on disk / still counted / still claimed?") is
       answerable from three localStorage objects plus what is actually stored. Show them.
       Test-space only; goes with the rest of the scaffolding at rollout. */
    var sb = document.createElement('button');
    sb.type = 'button';
    sb.textContent = '📦 store';
    sb.style.cssText = 'flex:0 0 auto;font:600 11px/1 system-ui,sans-serif;padding:6px 8px;border-radius:5px;' +
      'border:none;color:#2A2118;background:#8FBF6F;cursor:pointer';
    sb.addEventListener('click', function () {
      var old = document.getElementById('te-sim-storepop'); if (old) { old.remove(); return; }
      var man = {}, plDl = {}, lists = null;
      try { man = JSON.parse(localStorage.getItem('thaiear_offline') || '{}'); } catch (_) {}
      try { plDl = JSON.parse(localStorage.getItem('thaiear_offline_pl') || '{}'); } catch (_) {}
      try { lists = JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) {}
      var out = ['── thaiear_offline (manifest) ──'];
      var keys = Object.keys(man);
      if (!keys.length) out.push('(empty)');
      keys.forEach(function (k) {
        var e = man[k] || {};
        out.push(k + '\n   refs=' + JSON.stringify(e.refs || '(none → implicit topic)') +
          '\n   files=' + ((e.files || []).length) +
          '  bytes=' + (typeof e.bytes === 'number' ? (e.bytes / 1048576).toFixed(2) + 'MB' : '—') +
          '  dyn=' + (e.dyn ? 1 : 0) + '  tier=' + (e.tier || '—'));
      });
      out.push('', '── thaiear_offline_pl (downloaded playlists) ──');
      var pk = Object.keys(plDl);
      out.push(pk.length ? pk.map(function (k) {
        return k + ' → ' + JSON.stringify((plDl[k] || {}).prefixes || []);
      }).join('\n') : '(none)');
      out.push('', '── thaiear_playlists (cached contents) ──');
      /* ⚠ If this reads "(NOT CACHED)", dynNeededByOthers() returns null and every release path
         silently keeps ALL files — that is the single most likely cause of "I deleted it and the
         clips are still there". */
      if (!lists) out.push('(NOT CACHED — release paths cannot evaluate claims, so they keep everything)');
      else lists.forEach(function (p) {
        var byPfx = {};
        (p.items || []).forEach(function (it) { byPfx[it.prefix] = (byPfx[it.prefix] || 0) + 1; });
        out.push('pl-' + p.id + '  "' + p.name + '"  items=' + ((p.items || []).length) +
          '  downloaded=' + (plDl[p.id] ? 'YES' : 'no') + '\n   ' + JSON.stringify(byPfx));
      });
      /* ⚠ BUILT SESSIONS. The stitched mp3/wav for a unit persists INDEPENDENTLY of the clips it was
         built from, so a unit can play offline with almost no clips on disk — which is exactly the
         state the owner reached: 10 clips present, 50 needed, and the topic still "reconstructs".
         Every release path is supposed to remove these (te_dyn_meta_<key>_<mode> plus the stored
         file), so anything listed here after a clear is either a delete that missed or a session
         rebuilt since. The clip dump alone could never show this. */
      out.push('', '── BUILT SESSIONS (te_dyn_meta_*) ──');
      var metaKeys = [];
      try {
        for (var mi = 0; mi < localStorage.length; mi++) {
          var mk2 = localStorage.key(mi);
          if (mk2 && mk2.indexOf('te_dyn_meta_') === 0) metaKeys.push(mk2);
        }
      } catch (_) {}
      if (!metaKeys.length) out.push('(none)');
      metaKeys.forEach(function (mk2) {
        var mv = null; try { mv = JSON.parse(localStorage.getItem(mk2) || 'null'); } catch (_) {}
        out.push(mk2 + '\n   file=' + ((mv && mv.file) || (mv && mv.ext ? '(cache .' + mv.ext + ')' : '—')) +
          '  key=' + ((mv && mv.key) ? String(mv.key).slice(0, 48) : '—'));
      });
      /* ⚠ WHAT IS ACTUALLY STORED, not what the manifest claims (added 2026-07-31). The manifest is
         bookkeeping and it can be right while the disk is wrong: every per-file delete in every
         release path ends in `.catch(function(){})`, so a failing delete is invisible and the entry
         is trimmed anyway. The owner proved the gap behaviourally — a topic kept reconstructing
         from clips the manifest no longer listed, and only a whole-directory rmdir cleared them.
         Counting real entries is the only way to see it. */
      out.push('', '── ACTUALLY STORED (vs manifest) ──');
      var storedLines = [];
      var pending = 0, doneFn = null;
      function finish() { if (doneFn) doneFn(); }
      var FSP = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.Filesystem : null;
      if (FSP) {
        keys.forEach(function (k) {
          pending++;
          FSP.readdir({ path: 'offline/' + k, directory: 'DATA' }).then(function (r) {
            var n = ((r && r.files) || []).length;
            storedLines.push(k + '  on-disk=' + n + '  manifest=' + ((man[k] || {}).files || []).length +
              (n !== ((man[k] || {}).files || []).length ? '   ⚠ MISMATCH' : ''));
          }).catch(function (e) {
            storedLines.push(k + '  on-disk=? (' + ((e && e.message) || 'readdir failed') + ')');
          }).then(function () { if (!--pending) finish(); });
        });
      } else if (window.caches) {
        pending++;
        caches.open('thaiear-audio-dl').then(function (c) { return c.keys(); }).then(function (reqs) {
          var byPfx = {};
          reqs.forEach(function (rq) {
            var mt = /\/__offline-audio\/([^/]+)\//.exec(rq.url);
            if (mt) byPfx[mt[1]] = (byPfx[mt[1]] || 0) + 1;
          });
          var seen = {};
          keys.concat(Object.keys(byPfx)).forEach(function (k) {
            if (seen[k]) return; seen[k] = 1;
            var real = byPfx[k] || 0, claimed = ((man[k] || {}).files || []).length;
            storedLines.push(k + '  in-cache=' + real + '  manifest=' + claimed +
              (real !== claimed ? '   ⚠ MISMATCH' : ''));
          });
        }).catch(function (e) {
          storedLines.push('(cache read failed: ' + ((e && e.message) || e) + ')');
        }).then(function () { if (!--pending) finish(); });
      } else {
        storedLines.push('(no Filesystem and no Cache Storage on this device)');
      }
      var pop = document.createElement('div');
      pop.id = 'te-sim-storepop';
      pop.style.cssText = 'position:fixed;inset:34px 8px 8px;z-index:2147483647;background:#12180F;color:#DDEBD0;' +
        'border-radius:8px;padding:10px;overflow:auto;-webkit-overflow-scrolling:touch;' +
        'font:600 11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;box-shadow:0 4px 24px rgba(0,0,0,.5)';
      pop.textContent = out.join('\n') + '\n(reading storage…)';
      // The storage read is async; repaint once it lands so the dump is complete before it is copied.
      doneFn = function () {
        out.push.apply(out, storedLines.length ? storedLines : ['(nothing stored)']);
        pop.textContent = out.join('\n');
        pop.insertBefore(row, pop.firstChild);
      };
      if (!pending) doneFn();
      var row = document.createElement('div');
      row.style.cssText = 'position:sticky;top:0;display:flex;gap:6px;margin:-10px -10px 8px;padding:8px 10px;background:#12180F';
      ['📋 Copy', 'Close'].forEach(function (label) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.style.cssText = 'font:600 11px/1 system-ui,sans-serif;padding:6px 10px;border-radius:5px;border:none;cursor:pointer;background:#8FBF6F;color:#12180F';
        b.addEventListener('click', function () {
          if (label === 'Close') { pop.remove(); return; }
          try { navigator.clipboard.writeText(out.join('\n')).then(function () { b.textContent = '✓ copied'; },
            function () { b.textContent = '✗ screenshot it'; }); }
          catch (_) { b.textContent = '✗ screenshot it'; }
        });
        row.appendChild(b);
      });
      pop.insertBefore(row, pop.firstChild);
      document.body.appendChild(pop);
    });
    bar.appendChild(sb);
    var bits = [];
    if (tier()) bits.push(tier());
    if (elapsedDays()) bits.push(elapsedDays() + 'd');
    if (denies()) bits.push('deny');
    if (noIdentity()) bits.push('no-id');
    if (keepPurged()) bits.push('PURGED');
    /* Live licence verdict. player.js registers canUseOffline on this object, so on any topic
       page the strip can show what the REAL check returns for premium right now — no need to open
       a topic and infer from whether audio plays. Also prints the three markers it reads, so a
       surprising verdict is immediately traceable to its inputs. */
    try {
      if (window.ThaiEarSim && window.ThaiEarSim.canUseOffline) {
        var verdict = window.ThaiEarSim.canUseOffline('premium') ? 'GRANT' : 'DENY';
        var lv = get('thaiear_lastVerified'), su = get('thaiear_sub_until'), lf = get('thaiear_lifetime');
        var age = lv ? Math.round((Date.now() - parseInt(lv, 10)) / 86400000) + 'd' : '—';
        bits.push('licence:' + verdict + ' (v' + age + (lf === '1' ? ' LIFETIME' : '') +
          (su ? (parseInt(su, 10) > Date.now() ? ' until:future' : ' until:past') : ' until:—') + ')');
      }
    } catch (_) {}
    var st = document.createElement('span');
    st.style.cssText = 'flex:0 0 auto;margin-left:auto;padding:5px 8px;border-radius:5px;' +
      'font:600 11px/1 system-ui,sans-serif;' +
      (bits.length ? 'background:#C08A2E;color:#fff' : 'color:#8A7A5E');
    st.textContent = bits.length ? '🧪 ' + bits.join(' · ') : 'sim off';
    bar.appendChild(st);
    var root = document.body || document.documentElement;
    root.appendChild(bar);
    // Push the page down so the strip never covers the site nav or the eyebrow.
    try {
      var h = bar.offsetHeight || 32;
      document.body.style.paddingTop = (parseFloat(getComputedStyle(document.body).paddingTop || 0) + h) + 'px';
    } catch (_) {}
  }
  function remountBadge() {
    var old = document.getElementById('te-sim-bar');
    if (old) {
      // undo the padding this strip added, or each remount would push the page further down
      try {
        var h = old.offsetHeight || 0;
        var cur = parseFloat(getComputedStyle(document.body).paddingTop || 0);
        document.body.style.paddingTop = Math.max(0, cur - h) + 'px';
      } catch (_) {}
      old.remove();
    }
    mountBadge();
  }
  window.addEventListener('thaiear:auth', function () { setTimeout(remountBadge, 50); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBadge);
  else mountBadge();

  window.ThaiEarSim = {
    bootPurged: function () { return bootPurged.slice(); },
    mountBadge: mountBadge,
    remountBadge: function () { remountBadge(); },
    tier: tier,
    denies: denies,
    authView: authView,
    elapse: elapse,
    restore: restore,
    restoreReal: restoreReal,
    reset: reset,
    purgeSupabaseSession: purgeSupabaseSession,
    keepPurged: keepPurged,
    setKeepPurged: setKeepPurged,
    expireAccessToken: expireAccessToken,
    noIdentity: noIdentity,
    setNoIdentity: setNoIdentity,
    hardReload: hardReload,
    shellCaches: shellCaches,
    probeAudio: probeAudio,
    trace: trace,
    traceClear: function () { set(K_TRACE, '[]'); },
    traceRead: traceRead,
    sbKeysPresent: sbKeysPresent,
    probeFile: function (k) { return (PROBE[k] || {}).file || ''; },
    active: active,
    get: function () { return { tier: tier(), elapsedDays: elapsedDays(), deny: denies(), noIdentity: noIdentity() }; },
    setTier: function (v) {
      var wasArmed = !!tier();
      set(K_TIER, v || null);
      // Switching back to Real is the ONLY moment the genuine licence markers should return.
      if (wasArmed && !v) restoreReal();
      // Arming a state: make the markers agree with it immediately, so the very first check
      // after the change is not answered by leftover real ones.
      if (v) restore();
    },
    setDeny: function (on) { set(K_DENY, on ? '1' : null); }
  };
})();
