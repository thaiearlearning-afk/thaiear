/* ============================================================
   auth.js — ThaiEar authentication (Supabase + Google).
   ------------------------------------------------------------
   Loaded automatically by nav.js when the members UI is on, so
   no page needs its own <script>. Responsibilities:
     • create the Supabase client
     • expose window.ThaiEarAuth.{ getUser, signInWithGoogle, sendMagicLink, verifyOtpHash, signOut, isReady }
     • keep the cached current user in sync and tell the nav to re-render

   getUser() is SYNCHRONOUS (the nav calls it during render) and returns
   the cached user — null until the session resolves, then the real user.
   On any auth change we refresh the nav and fire a `thaiear:auth` event.

   The publishable key + project URL below are PUBLIC by design (Supabase
   Row-Level Security protects the data). The secret service-role key is
   NEVER here — it only ever lives in Cloudflare environment settings.
   ============================================================ */

(function () {
  'use strict';
  if (window.ThaiEarAuth) return; // load once

  // Custom auth domain (Supabase custom-domain add-on) so the Google OAuth consent
  // screen shows a ThaiEar-branded host instead of the raw project domain. The old
  // pyfyyiegmxwmfshgwvze.supabase.co URL still works server-side (functions use it via env).
  var SUPABASE_URL = 'https://auth.thaiear.com';
  var SUPABASE_KEY = 'sb_publishable_Msf5wsXw0KdugHGd5C2-mA_TNxbhT0e';
  var SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';

  var client = null;
  var currentUser = null;
  var currentSession = null;
  var currentSubscribed = false; // active Stripe subscription? (read from Supabase via RLS)
  /* Did a CLEAN server read actually answer this session? The offline grace window exists for when
     we CANNOT check; once the server has told us authoritatively that someone is not subscribed,
     the window must not keep granting access. Set true only on an error-free read, cleared on
     sign-out and on any failure, so the fallback stays generous exactly when it should. */
  var subFresh = false;
  var subFreshAt = 0;
  /* Freshness must EXPIRE. It was set once on a clean read and never cleared, so loading a page
     online and then switching on airplane mode left it true in memory — the app went on believing
     it had a live server answer while offline, and the whole offline branch stayed unreachable.
     That is why the 51-day case passed once (reloaded while already offline) and never again.
     Two bounds: a short TTL, and an explicit clear when the device reports going offline. */
  var SUB_FRESH_TTL_MS = 5 * 60 * 1000;
  /* The offline grace window — the FALLBACK for when no real period end was ever captured. A paying
     member is governed by thaiear_sub_until (their actual billing period), which is checked first.
     ⚠ Keep player.js + nav.js in step. Moved here 2026-07-31 with canUseOffline below. */
  var OFFLINE_GRACE_MS = 50 * 24 * 60 * 60 * 1000;
  // In-memory throttle for canUseOffline's licence stamp — see the note at that call site for why
  // it deliberately does NOT read thaiear_lastVerified.
  var lastStampAttempt = 0;
  // The offline manifest, read-only. player.js owns writing it; this is only ever asked "does this
  // prefix have an entry", for the member-tier rule in lockedFor().
  function hasOfflineEntry(prefix) {
    try { return !!(JSON.parse(localStorage.getItem('thaiear_offline') || '{}') || {})[prefix]; }
    catch (_) { return false; }
  }
  var currentSub = null;         // {status, cancel_at_period_end, current_period_end}
  var currentConsent = false;    // opted in to marketing email? (profiles row)
  var consentLoaded = false;     // has that consent flag been read from profiles yet?
  var currentProgress = null;    // { goal:int, topics:{ key:count } } — lazy-loaded from `progress`
  var progressLoaded = false;    // has the progress row been read yet?
  var currentFlags = null;       // map "topicKey:num" -> {topic_key,num,sentence} — lazy from `sentence_flags`
  var flagsLoaded = false;       // has the flag set been read yet?

  /* ══ IN-FLIGHT DE-DUPLICATION (2026-08-12) ═══════════════════════════════════════════════════
     Several independent surfaces ask for the same row at the same moment — the player, the
     progress strip, the flags list, the dyn prefs, and every re-render triggered by notify(),
     which fires two or three times while auth resolves. Each used to issue its OWN request,
     because the "loaded" flag only flips when the FIRST answer lands, so every caller racing
     inside that window missed the cache and queried again.

     Measured on ONE signed-in topic page: 24 Supabase requests, 18 of them byte-identical
     duplicates fired 1-3 ms apart (dyn_prefs 6x, progress 6x, sentence_flags 6x). Slowest single
     request 4874 ms.

     ⚠ THIS CHANGES NOTHING ABOUT ENTITLEMENT, and that is deliberate. It does not alter what is
     fetched, when the first fetch starts, what any caller receives, or any cache/expiry/offline
     rule. The second caller simply awaits the first request instead of starting an identical one.
     Every existing guard (progressDirty, raceLocal's OFFLINE_FALLBACK_MS, the "only a CLEAN read
     may overwrite" rule, the ownersim guard) runs exactly as before, once instead of N times.

     ⚠ THE TIMEOUT IS LOAD-BEARING, NOT TIDINESS. Offline this WebView's fetch HANGS rather than
     failing (the reason NET_TIMEOUT_MS and raceLocal exist at all). Without a cap, one hung
     request would pin its slot forever and every later caller would join a promise that never
     settles — which would silently disable the 'online' event's refreshSubscription(), i.e. the
     user never regains a live verdict after reconnecting. Releasing the slot early is harmless:
     the worst case is one extra request, which is exactly what happened before this existed. */
  var IN_FLIGHT_MAX_MS = 10000;
  var inFlight = {};
  // `force` = "I specifically want a fresh read" (dynPrefs.load(true)); it starts a new request and
  // publishes it as the in-flight one, so ordinary concurrent callers join the FRESHER read rather
  // than adding yet another. Without this, force would be silently downgraded to a cache hit.
  function once(key, make, force) {
    if (inFlight[key] && !force) return inFlight[key];
    var p = make();
    inFlight[key] = p;
    var t = setTimeout(function () { if (inFlight[key] === p) inFlight[key] = null; }, IN_FLIGHT_MAX_MS);
    var clear = function () { clearTimeout(t); if (inFlight[key] === p) inFlight[key] = null; };
    p.then(clear, clear);        // identity check above: a slot already reclaimed must not be clobbered
    return p;
  }
  // A different user (or a sign-out) invalidates anything still in flight for the previous one.
  function clearInFlight() { inFlight = {}; }

  // Goal steps the loading bars snap to. The goal auto-advances to the smallest
  // step that still contains the highest count, so a bar can never overflow.
  var GOAL_STEPS = [5, 10, 20, 50, 100];
  function nextGoalFor(n) {
    for (var i = 0; i < GOAL_STEPS.length; i++) { if (GOAL_STEPS[i] >= n) return GOAL_STEPS[i]; }
    return GOAL_STEPS[GOAL_STEPS.length - 1]; // cap at 100
  }
  function maxCount(topics) {
    var m = 0; for (var k in topics) { if (topics[k] > m) m = topics[k]; } return m;
  }

  function userFromSession(session) {
    if (!session || !session.user) return null;
    var u = session.user;
    var meta = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || '',
      /* ⚠ LOAD-BEARING FOR ATTRIBUTION, not decoration. attrib.js:108 bails on the whole
         signup handler when this is absent, so omitting it silently kills BOTH the
         first-party ad_attribution row AND the Google Ads `signup` conversion — which is
         exactly what happened between the file shipping and 2026-08-18 (zero rows, ever).
         Do not slim this object back down. */
      created_at: u.created_at || '',
      username: meta.full_name || meta.name || (u.email ? u.email.split('@')[0] : 'Member'),
      avatar: meta.avatar_url || ''
    };
  }

  // Read the persisted Supabase session straight from localStorage (key: sb-<ref>-auth-token). Used
  // as an OFFLINE fallback for init: client.auth.getSession() fires a network token-refresh when the
  // access token is expired, which hangs ~8s offline before returning. supabase-js@2 stores the
  // session object directly (older builds wrapped it in { currentSession }).
  var SB_REF = (SUPABASE_URL.match(/\/\/([^.]+)\./) || [])[1] || '';
  var SB_STORAGE_KEY = 'sb-' + SB_REF + '-auth-token';
  function readStoredSession() {
    try {
      var raw = localStorage.getItem(SB_STORAGE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      var s = (o && o.currentSession) ? o.currentSession : o;
      return (s && s.user) ? s : null;
    } catch (_) { return null; }
  }

  /* ══ DURABLE OFFLINE IDENTITY (2026-07-29) ═══════════════════════════════════════════════════
     THE BUG THIS FIXES: after ~8 h offline both the PWA and the app showed the user as logged
     OUT, and tapping sign-in did nothing — so every offline download became unplayable, because
     entitlement needs a user.

     MEASURED CAUSE (read out of the pinned bundle, @supabase/supabase-js@2 → 2.111.0):
       catch (err) { if (isAuthError(err)) { if (!isAuthRetryableFetchError(err)) {
           const stored = await getItem(storage, storageKey);
           if (stored?.expires_at * 1000 > Date.now()) { ...preserve... }
           else await this._removeSession();      // ← DELETES sb-<ref>-auth-token
     Once the access token has expired, a refresh failure that is NOT classified as a retryable
     FETCH error makes supabase-js purge its own stored session. Offline that is easy to hit —
     auth.thaiear.com is a custom domain behind Cloudflare, so a dead network can yield an edge
     HTML response that parses as an API error rather than a network error. There is a second
     purge on the getUser() path too.
     The old guard below asked readStoredSession() — the SUPABASE-owned key. Once supabase had
     deleted it the guard could not fire, the genuine-logout path ran, and the refresh token that
     would have restored them silently was gone as well. Hence "sign in did nothing": offline
     OAuth cannot complete, and the recovery material had been destroyed.

     THE FIX: keep our OWN copy of who is signed in, under a key supabase-js never touches.
     It is the source of truth for "is someone signed in" while offline; supabase remains the
     source of truth whenever it can actually answer. Storing the tokens here is no weaker than
     today — supabase-js already keeps exactly these in the same localStorage, same origin; this
     is a duplicate so a library-internal purge cannot strand the user. Cleared ONLY by a real
     signOut(). */
  // Boot trace (test build only; inert without sim.js) — see sim.js BOOT TRACE.
  var ID_KEY = 'thaiear_identity';
  var SIGNED_OUT_KEY = 'thaiear_signed_out';
  function readIdentity() {
    try {
      if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return null;  // they really did log out
      var o = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      return (o && o.user && o.user.id) ? o : null;
    } catch (_) { return null; }
  }
  // Mirror a live session into our own store. Called on every auth resolution that has a user.
  function writeIdentity(session) {
    try {
      var u = session && session.user;
      if (!u) return;
      localStorage.setItem(ID_KEY, JSON.stringify({
        user: u,
        access_token: session.access_token || null,
        refresh_token: session.refresh_token || null,
        at: Date.now()
      }));
      localStorage.removeItem(SIGNED_OUT_KEY);
    } catch (_) {}
  }
  function clearIdentity() {
    try { localStorage.removeItem(ID_KEY); localStorage.setItem(SIGNED_OUT_KEY, '1'); } catch (_) {}
  }
  /* Any durable evidence this device is signed in — ours first (survives a supabase purge), then
     supabase's own copy for accounts that signed in before this mechanism existed.
     The signed-out marker is checked HERE as well as inside readIdentity(): supabase's signOut()
     can settle after forceLocal() has already wiped its key and write session state back, and a
     second tab can do the same. Without this check that stale key resurrects the user and a real
     logout silently undoes itself. */
  function anySignedIn() {
    try { if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return null; } catch (_) {}
    var id = readIdentity();
    if (id) return id;
    var s = readStoredSession();
    return s ? { user: s.user } : null;
  }

  /* Reconnect recovery: if supabase has no session but we still hold tokens, hand them back so
     the user is restored WITHOUT a fresh OAuth round trip. This is what makes sign-in work again
     after a long offline spell — the refresh token long outlives the 1 h access token, so this
     normally succeeds the moment the network returns. */
  // The actual OAuth kick-off, factored out of signInWithGoogle so the offline recovery path
  // above can fall through to it. Native app → deep-link flow; web → ordinary page redirect.
  function startGoogleSignIn() {
    if (!client) return;
    if (isNative()) { nativeGoogleSignIn(); return; }
    client.auth.signInWithOAuth({
      provider: 'google',
      // prompt=select_account → Google always shows the account chooser, so signing
      // in is a deliberate confirmation rather than a silent re-auth.
      options: { redirectTo: window.location.href, queryParams: { prompt: 'select_account' } }
    });
  }

  var reseeding = false;
  var restoredFromIdentity = false;   // true while the app is running on OUR record, not supabase's
  function reseedSession() {
    if (reseeding || !client) return Promise.resolve(false);
    var id = readIdentity();
    if (!id || !id.refresh_token) return Promise.resolve(false);
    reseeding = true;
    return client.auth.setSession({ access_token: id.access_token || '', refresh_token: id.refresh_token })
      .then(function (r) {
        reseeding = false;
        var s = r && r.data && r.data.session;
        if (s) {
          writeIdentity(s);
          restoredFromIdentity = false;   // supabase owns a real session again
          currentSession = s;             // so getAccessToken() stops handing out the stale token
          return true;
        }
        return false;
      })
      .catch(function () { reseeding = false; return false; });
  }

  function notify() {
    try { if (window.ThaiEarNav && window.ThaiEarNav.refresh) window.ThaiEarNav.refresh(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('thaiear:auth', { detail: currentUser })); } catch (e) {}
  }

  // Read the user's own subscription row (RLS) and cache active/not, then re-notify
  // so cards/pages re-render once we know. Logged out → not subscribed.
  // Write the offline-licence markers read by player.js/nav.js canUseOffline: WHEN we last confirmed
  // the membership online + its real end date. Mirrors player.js stampVerified but lives here so it
  // fires on any page the moment auth confirms an active sub — including the index grid download path,
  // where player.js never loads. (current_period_end may be an ISO string or epoch s/ms.)
  /* P3 cleanup (r135): the owner entitlement simulator went with the test space. */
  function stampOfflineLicence() {
    try {
      localStorage.setItem('thaiear_lastVerified', String(Date.now()));
      var end = currentSub && currentSub.current_period_end;
      if (end != null && end !== '') {
        var t = (typeof end === 'number') ? (end < 1e12 ? end * 1000 : end) : Date.parse(end);
        if (t && !isNaN(t)) localStorage.setItem('thaiear_sub_until', String(t));
      }
    } catch (_) {}
  }
  function refreshSubscription() {
    if (!client || !currentUser) {
      currentSubscribed = false; currentSub = null; subFresh = false;
      // Drop only the cached subscription STATUS here (so the nav/account render logged-out). Do NOT
      // clear the premium OFFLINE licence stamps (thaiear_lifetime/lastVerified/sub_until) on a bare
      // currentUser == null: supabase-js emits a null-session auth change when it can't refresh an
      // EXPIRED access token OFFLINE (~1h in — the JWT lifetime), which is NOT a real sign-out. Wiping
      // the stamps here locked a signed-in (even lifetime) member out of their downloads mid-flight.
      // A deliberate sign-out still scrubs them via signOut()'s forceLocal; a different account signing
      // in re-derives them online (stampOfflineLicence/refreshLifetime). See onAuthStateChange guard.
      try { localStorage.removeItem('thaiear_sub_cache'); } catch (_) {}
      notify(); return;
    }
    // Seed from the last KNOWN-GOOD cache for THIS user FIRST, so a premium member is recognised
    // instantly — including OFFLINE, where the live query below hangs ~8s then fails. Without this,
    // isSubscribed() was false offline and premium topic cards wrongly routed to subscribe.html
    // instead of opening (or showing the "you're offline" page). The live read confirms/corrects when
    // online. (Audio is still licence-gated by canUseOffline, so this is UX/routing only.)
    try {
      var cached = JSON.parse(localStorage.getItem('thaiear_sub_cache') || 'null');
      if (cached && cached.uid === currentUser.id && cached.sub) {
        currentSub = cached.sub;
        currentSubscribed = (cached.sub.status === 'active' || cached.sub.status === 'trialing');
      }
    } catch (_) {}
    notify(); // reflect the cached status immediately (cards/nav) before the live read returns
    /* ⚠ STARTED HERE, IN PARALLEL — it used to be chained off the query below, so two reads of the
       SAME subscriptions row ran back to back and the second waited a full round trip for the
       first (measured 1004 ms apart). refreshLifetime() reads nothing this function produces: it
       re-queries the row itself and only touches the thaiear_lifetime flag, so there was never a
       data dependency to honour — only an accident of where the call sat.
       ⚠ AND THEY ARE STILL TWO SEPARATE QUERIES, ON PURPOSE. Folding `lifetime` into the select
       below would save one request and would undo the isolation the comment on refreshLifetime()
       spells out: if the `lifetime` column is ever missing, a combined select fails as a WHOLE and
       takes normal subscription detection down with it. One extra request is the price of that
       guarantee, and it is worth paying — this pair is 2 of 24 requests, not the problem. */
    refreshLifetime();
    client.from('subscriptions').select('status,cancel_at_period_end,current_period_end').maybeSingle()
      .then(function (res) {
        /* Only a CLEAN read may overwrite the cached seed. postgrest-js converts a failed fetch
           into a RESOLVED {data:null, error} — it does not reject — so offline this .then ran
           with data:null and blanked currentSubscribed to false, undoing the cache seed above
           and reading a paid-up member as unsubscribed. The .catch below never saw it. */
        if (res && res.error) return;
        subFresh = true; subFreshAt = Date.now();   // authoritative answer, whatever it says
        currentSub = (res && res.data) || null;
        var s = currentSub && currentSub.status;
        currentSubscribed = (s === 'active' || s === 'trialing');
        // Persist the last KNOWN-GOOD subscription (only on a clean read) so the account page can show
        // the real "Premium — active until …" status while OFFLINE (when the live query can't run).
        try { if (res && !res.error) localStorage.setItem('thaiear_sub_cache', JSON.stringify({ uid: currentUser.id, sub: currentSub })); } catch (_) {}
        // Stamp the offline-licence markers on EVERY page (not just when player.js is loaded) so a
        // member who downloads from the index grid — without ever opening a topic page — can still play
        // offline. player.js/nav.js's canUseOffline reads these. Only on a clean ONLINE read of an
        // active membership; offline failures (catch below) leave the existing stamps intact.
        if (res && !res.error && currentSubscribed) stampOfflineLicence();
      })
      .catch(function () { /* offline / failed → KEEP the cached seed above; don't blank to not-subscribed */ })
      .then(function () { notify(); });   // refreshLifetime() now starts in parallel, above
  }

  // Maintain the OFFLINE lifetime flag (thaiear_lifetime) used by player.js/nav.js to let true
  // "lifetime" members (£0-forever) keep downloaded premium audio with NO offline timeout. Kept
  // SEPARATE and error-tolerant from the core subscription query above, so it can never affect normal
  // subscription detection: if the `lifetime` column doesn't exist yet, or we're offline, we leave the
  // cached flag untouched. The flag is ONLY ever set when the server confirms lifetime AND active, and
  // ONLY when online — so a regular paying user can never be flagged, and a revoked member is cleared
  // the next time they connect. Offline, the last-known value persists (that's the whole point).
  function refreshLifetime() {
    /* Owner simulator: while ANY account state is simulated, stop maintaining the REAL lifetime
       flag — we are pretending to be a different account, so the real server answer must not be
       written back. Applies to EVERY simulated state, not just 'premium-nolife' (that narrower
       version was a bug): `thaiear_lifetime` short-circuits canUseOffline before any date
       arithmetic runs, so on a genuinely-lifetime device this re-granted full offline access a
       second after every page load — which is why "Expired" and the 31/41/51-day buttons appeared
       to do nothing. Overrides the SERVER's answer only; the expiry decision still runs for real. */
    if (!client || !currentUser || !navigator.onLine) return; // offline → keep whatever's cached
    // Deduped: init and the onAuthStateChange right behind it both reach here.
    once('lifetime', function () {
      return client.from('subscriptions').select('lifetime,status').maybeSingle()
        .then(function (res) {
          if (!res || res.error) return;                      // column missing / query error → don't touch flag
          var d = res.data;
          var subbed = d && (d.status === 'active' || d.status === 'trialing');
          try {
          /* ⚠ THE OWNER SIMULATOR OWNS THIS FLAG WHILE ARMED (ownersim.js, 2026-08-09).
             canUseOffline() short-circuits on thaiear_lifetime BEFORE any other check, so on a
             lifetime account — the owner's is one — re-writing it here would make every simulated
             state pass vacuously: the toggle flips, nothing errors, and nothing changes. That is
             the failure the ⚠⚠ note above canUseOffline warns about, and it looks exactly like
             success. This overrides the SERVER's lifetime answer only; the expiry decision itself
             still runs for real. Clearing (the else) stays unconditional — a simulation should
             never be able to GRANT access that the server did not. */
            var simOn = !!(window.ThaiEarOwnerSim && window.ThaiEarOwnerSim.state());
            if (d && d.lifetime && subbed && !simOn) localStorage.setItem('thaiear_lifetime', '1');
            else localStorage.removeItem('thaiear_lifetime'); // not lifetime (or not active) → clear
          } catch (_) {}
        })
        .catch(function () {});                                // network/error → leave cached flag intact
    });
  }

  /* ══ DESKTOP MP3 DOWNLOAD ENTITLEMENT (2026-08-07) ═══════════════════════════════════════════
     Answers two questions for the whole site: may I save MP3s to this computer, and may I grant
     that to other people. Both come from /api/desktop-dl, which re-derives them from the caller's
     JWT — this is a CACHE OF A SERVER ANSWER, never a decision made here.

     ⚠ NOT DERIVED FROM `lifetime`, AND NOT PERSISTED TO localStorage. Deliberately different from
     the offline-licence markers a few functions above. Those exist so a paid-up member keeps their
     downloads while offline; this one has no offline job at all — you cannot save a new MP3 without
     the clips anyway. Persisting it would create exactly the forgeable flag this feature was
     designed to avoid: a monk who loses access must lose the button, and a localStorage boolean
     anyone can set is not a permission. Unknown/offline reads as NO. */
  var dlAllowed = false, dlAdmin = false, dlChecked = false;
  function refreshDesktopDl() {
    if (!currentUser || !currentSession) { dlAllowed = false; dlAdmin = false; dlChecked = false; return; }
    var tok = currentSession.access_token;
    if (!tok || !navigator.onLine) return;
    fetch('/api/desktop-dl', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        // A failed/absent answer leaves the previous state alone rather than granting anything —
        // the initial state is already "no", so a first-load failure is a closed door, not an open one.
        if (!d) return;
        dlAllowed = !!d.canDownload; dlAdmin = !!d.isAdmin; dlChecked = true;
        notify();   // player.js re-checks on thaiear:auth and mounts the button then
      })
      .catch(function () {});
  }

  // Read the user's marketing-consent flag (profiles row), cache it, re-notify.
  function refreshProfile() {
    if (!client || !currentUser) { currentConsent = false; consentLoaded = false; return; }
    // Deduped: init and the onAuthStateChange that follows it both call this, ~6 ms apart.
    once('profile', function () {
      return client.from('profiles').select('marketing_opt_in').maybeSingle()
        .then(function (res) { currentConsent = !!(res && res.data && res.data.marketing_opt_in); })
        .catch(function () { currentConsent = false; })
        .then(function () { consentLoaded = true; notify(); });
    });
  }

  // ---- offline-first sync for progress + flags ---------------------------
  // Edits apply to a LOCAL cache immediately (so progress + flags work with NO connection) and write
  // through to Supabase; if the write can't happen (offline), it's queued and flushed on reconnect.
  // This is single-user data, so reconnect is simply last-write-wins (the device's local state wins).
  // All keys are uid-scoped in localStorage so a different sign-in never reads stale data.
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function uid() { return currentUser && currentUser.id; }

  function persistProgress() { if (uid()) lsSet('thaiear_progress', { uid: uid(), data: currentProgress }); }
  function loadPersistedProgress() { var c = lsGet('thaiear_progress'); return (c && c.uid === uid()) ? c.data : null; }
  function progressDirty() { return lsGet('thaiear_progress_dirty') === uid(); }
  function markProgressDirty() { if (uid()) lsSet('thaiear_progress_dirty', uid()); }
  function clearProgressDirty() { try { localStorage.removeItem('thaiear_progress_dirty'); } catch (_) {} }
  function flushProgress() {
    if (!client || !currentUser || !navigator.onLine || !progressDirty()) return;
    saveProgress().then(clearProgressDirty).catch(function () {});
  }

  function persistFlags() { if (uid()) lsSet('thaiear_flags', { uid: uid(), map: currentFlags }); }
  function loadPersistedFlags() { var c = lsGet('thaiear_flags'); return (c && c.uid === uid()) ? c.map : null; }
  function pendingFlags() { var c = lsGet('thaiear_flags_pending'); return (c && c.uid === uid()) ? c.ops : {}; }
  function setPendingFlags(ops) { if (uid()) lsSet('thaiear_flags_pending', { uid: uid(), ops: ops }); }
  function queueFlag(key, tk, num, nugget, flagged) { var o = pendingFlags(); o[key] = { tk: tk, num: num, nugget: nugget, flagged: flagged }; setPendingFlags(o); }
  function unqueueFlag(key) { var o = pendingFlags(); delete o[key]; setPendingFlags(o); }
  function pushFlag(key, tk, num, nugget, flagged) {
    if (!client || !currentUser) return;
    var op = flagged
      ? client.from('sentence_flags').upsert({ user_id: currentUser.id, topic_key: tk, num: num, sentence: nugget, created_at: new Date().toISOString() })
      : client.from('sentence_flags').delete().eq('user_id', currentUser.id).eq('topic_key', tk).eq('num', num);
    return op.then(function (res) { if (res && res.error) throw res.error; unqueueFlag(key); }).catch(function () {});
  }
  function flushFlags() {
    if (!client || !currentUser || !navigator.onLine) return;
    var ops = pendingFlags();
    Object.keys(ops).forEach(function (key) { var o = ops[key]; pushFlag(key, o.tk, o.num, o.nugget, o.flagged); });
  }
  // Overlay any unsynced local flag toggles on top of a freshly-fetched server map.
  function applyPendingFlags() {
    var ops = pendingFlags();
    Object.keys(ops).forEach(function (key) {
      var o = ops[key];
      if (o.flagged) currentFlags[key] = { topic_key: o.tk, num: o.num, sentence: o.nugget };
      else delete currentFlags[key];
    });
  }
  /* == PER-SENTENCE PLAY COUNTS =================================================
     "How many times have I heard sentence 1220." Owning doc: PLAYS_COUNTER.md.

     WARNING: THIS IS A COUNTER, AND IT DELIBERATELY DOES NOT WORK LIKE ANYTHING ELSE IN THIS FILE.
     Everything above and below - flags, progress, dyn_prefs, the playlist outbox - queues the
     DESIRED FINAL VALUE and lets the newest write win. That is right for a toggle and wrong here:
     play 1220 three times on the phone offline and twice in the browser offline, reconnect both,
     and last-write-wins stores 3 or 2 when the answer is 5. So this queues DELTAS and the server
     ADDS them (functions/api/plays.js -> apply_plays()). Do NOT "harmonise" it with its neighbours.

     Local shape, keyed by uid() for the same non-negotiable reason as every other queue here -
     a pending write must never leak into whichever account signs in next:

         { uid, synced: {num:n}, pending: {num:n}, outbox: {batchId, deltas} | null }

     - synced  = what the server is known to hold.
     - pending = heard since, not yet handed to a batch.
     - outbox  = the batch currently in flight (or awaiting a retry). SEPARATE FROM `pending`
                 ON PURPOSE. If a play landed in the same bucket that is being sent, the ack would
                 fold in plays the server never received, and they would be lost for ever.
     - The batchId is minted WHEN THE BATCH IS FORMED and persisted with it, so a retry - even
       after a reload, even days later - carries the SAME id and the server recognises it as a
       replay instead of adding the plays twice.

     Displayed value is synced + pending + outbox, so the number moves the instant something is
     heard, online or off. */
  var PLYS_KEY = 'thaiear_plays';
  var plysCache = null;        // the parsed local store; null until first touched
  var plysLoaded = false;      // has the server blob been read this session?
  var plysTimer = null;
  var plysFlushing = false;
  var plysResync = false;      // a duplicate ack asked us to re-read the server total
  /* The server-decided figures the Progress page shows. NOT computed here and never sent by the
     client — /api/plays decides them from last_listen_date, the same discipline as /api/seen
     deciding days_active. A counter a browser can set is a counter a browser can invent.
     Cached in localStorage so the page has something honest to show offline. */
  var plysStats = null;
  var PLYS_STATS_KEY = 'thaiear_plays_stats';

  /* ⚠⚠ TWO COUNTERS, BECAUSE "A PLAY" MEANS TWO DIFFERENT THINGS (2026-08-20).
       counts / pending  = PASSES.       One trip through a sentence, however many times the dyn
                                         player repeated the Thai inside it. This is what the pill
                                         shows and what the topic/playlist MINIMUM rolls up, and
                                         that roll-up only means "complete listens" if a repeat
                                         setting cannot inflate it.
       reps / pendingReps = REPETITIONS. How many times the Thai was actually heard. This is what
                                         "sentences listened to" and "Thai listening time" mean;
                                         hearing something four times is four listens and the time
                                         figure is simply wrong without it.
     They travel in ONE batch and are merged by the same server-side increment, so they cannot get
     out of step. Do not collapse them back into one number — each is wrong for the other's job. */
  function plysBlank() { return { synced: {}, syncedReps: {}, pending: {}, pendingReps: {}, outbox: null }; }
  function plysRead() {
    var c = lsGet(PLYS_KEY);
    return (c && c.uid === uid())
      ? { synced: c.synced || {}, syncedReps: c.syncedReps || c.synced || {},
          pending: c.pending || {}, pendingReps: c.pendingReps || c.pending || {},
          outbox: c.outbox || null }
      : plysBlank();
  }
  // Reads may use the cached copy — they are called per card on every repaint.
  function plysStore() {
    if (!plysCache) plysCache = plysRead();
    return plysCache;
  }
  /* ⚠⚠ EVERY MUTATION MUST GO THROUGH HERE — READ-MODIFY-WRITE, NEVER A BLIND OVERWRITE.
     localStorage is shared by every ThaiEar page in the browser; `plysCache` is per-page and is
     read ONCE. So a page holding a stale snapshot that called plysPersist() wrote its old copy
     over whatever another page had queued in the meantime, and those plays were gone — a
     classic lost update. The owner hit it: three real plays recorded in a playlist vanished,
     and the topic page briefly showed the higher number before settling on the lower one.
     It needs nothing exotic to happen — a second tab, or a bfcache restore, is enough.
     Re-reading immediately before every mutation closes it: JS is single-threaded per page, so
     between this read and the write below nothing else in THIS page can run, and another page's
     write either lands before the read (and is picked up) or after the write (and picks us up). */
  function plysMutate(fn) {
    plysCache = plysRead();      // adopt whatever is on disk right now
    fn(plysCache);
    plysPersist();
    return plysCache;
  }
  function plysPersist() {
    if (uid() && plysCache) lsSet(PLYS_KEY, { uid: uid(),
      synced: plysCache.synced, syncedReps: plysCache.syncedReps,
      pending: plysCache.pending, pendingReps: plysCache.pendingReps,
      outbox: plysCache.outbox });
  }

  function plysAddInto(target, src) {
    Object.keys(src || {}).forEach(function (k) { target[k] = (target[k] || 0) + src[k]; });
    return target;
  }
  /* Merge one bucket family. `which` is 'synced'/'pending' (PASSES) or the Reps pair. */
  function plysMergeOf(syncKey, pendKey, outKey) {
    plysCache = plysRead();
    var st = plysCache, out = {};
    plysAddInto(out, st[syncKey]);
    plysAddInto(out, st[pendKey]);
    if (st.outbox) plysAddInto(out, st.outbox[outKey] || st.outbox.deltas);
    return out;
  }
  // REPETITIONS — what "sentences listened to" and the listening time are built from.
  function plysMergedReps() { return plysMergeOf('syncedReps', 'pendingReps', 'reps'); }

  // The number a user sees: everything known plus everything not yet delivered.
  function plysMerged() {
    /* Re-read rather than trusting the cache: another page may have recorded a play since this
       one last looked, and a number that is quietly behind is the same defect as a wrong one. */
    plysCache = plysRead();
    var st = plysCache, out = {};
    plysAddInto(out, st.synced);
    plysAddInto(out, st.pending);
    if (st.outbox) plysAddInto(out, st.outbox.deltas);
    return out;
  }

  /* Record n plays of one sentence. Local and instant - never awaits the network, never rejects.
     Called from player.js on the dwell rule (2s of playback, or the clip/block ending). */
  function plysNote(num, n, reps) {
    if (!currentUser) return;                 // signed out: the feature does not exist
    n = Math.max(1, Math.min(500, parseInt(n, 10) || 1));
    /* Repetitions default to the passes when the caller does not say — the true minimum, since a
       sentence cannot be passed through zero times. player.js passes the dyn repeat setting. */
    reps = Math.max(n, Math.min(500, parseInt(reps, 10) || 0));
    plysMutate(function (st) {                // ⚠ read-modify-write — see plysMutate
      st.pending[String(num)] = (st.pending[String(num)] || 0) + n;
      st.pendingReps[String(num)] = (st.pendingReps[String(num)] || 0) + reps;
    });
    notify();                                 // repaint the chips
    /* Debounced, not immediate: a dyn session produces one of these every few seconds and each
       POST is a round trip. 20s bundles a normal listening run into a handful of requests while
       still landing well inside a typical page visit. pagehide/visibilitychange force it early. */
    if (plysTimer) clearTimeout(plysTimer);
    plysTimer = setTimeout(function () { plysTimer = null; plysFlush(); }, 20000);
  }

  /* Deliver whatever is queued. Safe to call at any time and from anywhere; it is a no-op when
     there is nothing to send, no session, or no network. Never throws, never rejects. */
  function plysFlush() {
    if (plysFlushing || !currentUser) return Promise.resolve();
    // Form a batch if one is not already outstanding. A batch already in flight is retried AS IS,
    // with its original id - that is what makes the retry idempotent server-side.
    var st = plysMutate(function (st) {
      if (!st.outbox && Object.keys(st.pending).length) {
        st.outbox = {
          batchId: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : plUuidFallback(),
          deltas: st.pending,
          reps: st.pendingReps
        };
        st.pending = {};
        st.pendingReps = {};
      }
    });
    if (!st.outbox) return Promise.resolve();
    var tok = currentSession && currentSession.access_token;
    if (!tok || !navigator.onLine) return Promise.resolve();   // stays queued; 'online' retries

    plysFlushing = true;
    var sending = st.outbox;
    return fetch('/api/plays', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: sending.batchId, deltas: sending.deltas,
                             reps: sending.reps || sending.deltas }),
      keepalive: true        // survives the navigation that triggered the flush
    }).then(function (res) {
      if (res.ok) {
        /* ⚠⚠ A REPLAY MUST NOT BE FOLDED IN. /api/plays answers 200 {duplicate:true} when it has
           already applied this batch id, and that is a SUCCESS — but the server added nothing, so
           adding the deltas to `synced` here would inflate the local total above the truth. The
           owner saw exactly that: a sentence read 11 on the topic page, then dropped to 8 the
           moment plysLoad() replaced `synced` with the server's copy.

           ⚠ AND THIS IS THE COMMON PATH, NOT AN EDGE CASE. The POST is `keepalive` and is fired
           from pagehide, so it very often LANDS while the response never gets back to a page that
           is already unloading. The fetch rejects, the outbox is kept, the next page retries — and
           the retry is a duplicate. Any bug here would fire on ordinary navigation, repeatedly.

           So on a duplicate we drop the batch and force a re-read instead of guessing: the server
           total is authoritative and already contains it. Self-healing, no arithmetic. */
        return res.json().catch(function () { return {}; }).then(function (d) {
          plysMutate(function (cur) {
            cur.outbox = null;                 // re-applied: plysMutate re-read the disk copy
            if (d && d.duplicate) { plysLoaded = false; plysResync = true; }
            else {
              plysAddInto(cur.synced, sending.deltas);
              plysAddInto(cur.syncedReps, sending.reps || sending.deltas);
            }
          });
        });
      }
      /* 4xx vs 5xx IS THE WHOLE ERROR POLICY, and /api/plays is written to honour it.
         4xx - malformed; it can never succeed, so drop it or it blocks every later batch for ever.
         5xx / offline - transient; keep it, with its id, and try again. There is deliberately no
         age cap (unlike the playlist outbox, where a stuck op disables download GC): nothing here
         is gated on the queue being empty, so a stuck batch is harmless, and discarding it would
         silently delete real listening. */
      if (res.status >= 400 && res.status < 500) {
        console.warn('[plays] dropped an unsyncable batch (' + res.status + ')');
        plysMutate(function (cur) { cur.outbox = null; });
      }
    }).catch(function () {
      /* Network failure - keep it queued. No log: offline is the normal case here. */
    }).then(function () {
      plysFlushing = false;
      /* Re-read AFTER the flush has settled, never inside it: plysLoad() calls plysFlush(), and
         doing that while plysFlushing is still true would silently no-op. */
      if (plysResync) { plysResync = false; plysLoad(); }
      // More arrived while that was in flight - deliver it too rather than waiting 20s.
      if (Object.keys(st.pending).length && navigator.onLine) plysFlush();
    });
  }

  /* Read the server blob once per session and reconcile it with what is queued locally.
     The server value REPLACES `synced` rather than being merged into it: it already contains
     every batch this device has had acknowledged, plus anything other devices have added. What is
     still in `pending`/`outbox` is by definition NOT in it, and stays on top. */
  function plysStatsGet() {
    if (plysStats) return plysStats;
    var c = lsGet(PLYS_STATS_KEY);
    plysStats = (c && c.uid === uid()) ? c.data : { daysListened: 0, streak: 0, bestStreak: 0, lastListenDate: null };
    return plysStats;
  }
  function plysStatsSet(d) {
    plysStats = {
      daysListened: d.daysListened || 0, streak: d.streak || 0,
      bestStreak: d.bestStreak || 0, lastListenDate: d.lastListenDate || null,
    };
    if (uid()) lsSet(PLYS_STATS_KEY, { uid: uid(), data: plysStats });
  }

  function plysLoad() {
    if (plysLoaded) return Promise.resolve(plysMerged());
    var tok = currentSession && currentSession.access_token;
    if (!currentUser || !tok || !navigator.onLine) return Promise.resolve(plysMerged());
    return fetch('/api/plays', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (d && d.counts) {
          /* ⚠ read-modify-write: this page may have been sitting on a stale snapshot while
             another page queued plays, and a blind write here would delete them. */
          plysMutate(function (cur) {
            cur.synced = d.counts;
            /* An older server, or a row written before the column existed, sends no reps. Falling
               back to the passes is the honest floor, never zero. */
            cur.syncedReps = d.reps || d.counts;
          });
          plysStatsSet(d);
          plysLoaded = true; notify();
        }
        plysFlush();                                  // deliver anything queued from last time
        return plysMerged();
      })
      .catch(function () { return plysMerged(); });   // offline -> the local copy is the answer
  }

  /* FLUSH BEFORE THE PAGE GOES, OR MOST LISTENING IS NEVER RECORDED.
     Exactly the bug that made user_activity.listens near-worthless at sw v350 and had to be fixed
     in v351: plays inside the debounce window live only in localStorage, and while THAT survives a
     navigation, the 20s timer does not - so a user who plays four sentences and moves on every
     couple of minutes would never deliver anything until some later page happened to sit still.
     pagehide AND visibilitychange: iOS Safari frequently gives no pagehide when the user switches
     apps or locks the phone. `keepalive` on the POST is what lets it outlive the page. */
  window.addEventListener('pagehide', function () { plysFlush(); });
  /* Another tab (or the playlist player in a second window) recorded a play. localStorage is
     shared but `plysCache` is per-page and is never re-read once populated, so without this the
     other tab's numbers stay stale until a reload — which is part of what "slow to update" looked
     like. Cheap: re-read the record and repaint, nothing more.
     ⚠ Only when nothing of ours is in flight. Mid-flush the on-disk copy is a snapshot the running
     flush is about to supersede, and adopting it would resurrect an outbox we have just cleared. */
  window.addEventListener('storage', function (e) {
    if (!e || e.key !== PLYS_KEY || plysFlushing || !currentUser) return;
    plysCache = null;
    plysStore();
    notify();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') plysFlush();
  });

  /* Flush queued writes whenever the connection returns.
     ⚠ plFlush() is declared further down (with the playlists API) — a hoisted function
     declaration, and this listener only runs on an event, so the ordering is safe. It matters
     more than the others: until the playlist outbox drains, playlists.authoritative() stays false
     and dlReconcileRefs() cannot reap ghost download claims. */
  window.addEventListener('online', function () { flushProgress(); flushFlags(); dpFlush(); plFlush(); plysFlush(); });

  // ---- listening progress (own `progress` row, RLS) ----------------------
  // One jsonb row per user: { goal, topics:{ topicKey:count } }. Read on demand
  // (topic pages + the progress page), not on every page load. Read-modify-write
  // is fine here — a user only touches their own single row.
  // Offline, the WebView's fetch to Supabase hangs ~8s before rejecting, and navigator.onLine can't
  // be trusted to detect that (it reports "online" in airplane mode). So for read fetches we RACE the
  // server query against a short timer: if the server hasn't answered in OFFLINE_FALLBACK_MS, resolve
  // with the last-known LOCAL copy at once. The query keeps running in the background, so a slow-but-
  // online client still refreshes the cache for next time. localFn must set the *Loaded flag + cache.
  var OFFLINE_FALLBACK_MS = 1200;
  function raceLocal(query, localFn) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(localFn()); } }, OFFLINE_FALLBACK_MS);
      query.then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function () { if (!done) { done = true; clearTimeout(t); resolve(localFn()); } }
      );
    });
  }

  // De-duplicated wrapper — see IN-FLIGHT DE-DUPLICATION above. Deliberately wrapped HERE rather
  // than at loadProgress(), so mutateProgress() and every other internal caller dedupes too
  // without each site having to remember to.
  function fetchProgress() { return once('progress', fetchProgressUncached); }
  function fetchProgressUncached() {
    if (!client || !currentUser) { currentProgress = { goal: 5, topics: {} }; progressLoaded = true; return Promise.resolve(currentProgress); }
    if (progressDirty()) {                       // unsynced local edits win — don't let the server clobber them
      var ld = loadPersistedProgress();
      if (ld) { currentProgress = ld; progressLoaded = true; flushProgress(); return Promise.resolve(currentProgress); }
    }
    var localProgress = function () {            // offline / slow → last-known local copy (or a fresh default)
      currentProgress = loadPersistedProgress() || { goal: 5, topics: {} };
      progressLoaded = true;
      return currentProgress;
    };
    var query = client.from('progress').select('goal,topics').maybeSingle()
      .then(function (res) {
        if (res && res.error) throw res.error;
        var d = (res && res.data) || null;
        currentProgress = { goal: (d && d.goal) || 5, topics: (d && d.topics) || {} };
        progressLoaded = true; persistProgress();
        return currentProgress;
      });
    return raceLocal(query, localProgress);
  }
  function saveProgress() {
    if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
    var row = {
      user_id: currentUser.id,
      goal: currentProgress.goal,
      topics: currentProgress.topics,
      updated_at: new Date().toISOString()
    };
    return client.from('progress').upsert(row).then(function (res) {
      if (res && res.error) throw res.error;
      return currentProgress;
    });
  }
  // Ensure the cache is populated, run fn (which mutates currentProgress), update the LOCAL copy
  // immediately (optimistic), then write through. Offline → stays queued + flushed on reconnect.
  function mutateProgress(fn) {
    if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
    var ready = (progressLoaded && currentProgress) ? Promise.resolve(currentProgress) : fetchProgress();
    return ready.then(function () {
      fn(currentProgress);
      persistProgress(); markProgressDirty();
      // Optimistic: resolve IMMEDIATELY on the local cache so the button never hangs offline, then
      // write through in the BACKGROUND. If the write fails/offline, the dirty flag keeps it queued
      // and the 'online' event flushes it (flushProgress). Mirrors toggleFlag. (Previously this
      // AWAITED saveProgress(), so offline the button spun ~8s while the WebView's Supabase fetch
      // hung — and could even revert when navigator.onLine wrongly reported "online" in airplane mode.)
      saveProgress().then(clearProgressDirty).catch(function () {});
      return currentProgress;
    });
  }

  // ---- flagged sentences (own `sentence_flags` rows, RLS) ----------------
  // One row per flagged sentence; the sentence nugget is stored so the My-sentences
  // page is self-contained. Cached as a map keyed by "topicKey:num".
  function flagKey(tk, num) { return tk + ':' + num; }
  // De-duplicated wrapper — see IN-FLIGHT DE-DUPLICATION above.
  function fetchFlags() { return once('flags', fetchFlagsUncached); }
  function fetchFlagsUncached() {
    if (!client || !currentUser) { currentFlags = {}; flagsLoaded = true; return Promise.resolve(currentFlags); }
    var localFlags = function () {                  // offline / slow → last-known local set
      currentFlags = loadPersistedFlags() || {};
      flagsLoaded = true;
      return currentFlags;
    };
    var query = client.from('sentence_flags').select('topic_key,num,sentence')
      .then(function (res) {
        if (res && res.error) throw res.error;
        var map = {};
        (res && res.data || []).forEach(function (r) { map[flagKey(r.topic_key, r.num)] = r; });
        currentFlags = map; flagsLoaded = true;
        applyPendingFlags();                        // overlay any unsynced local toggles, then push them
        persistFlags(); flushFlags();
        return currentFlags;
      });
    return raceLocal(query, localFlags);
  }

  // ---- Capacitor native OAuth (app only) ---------------------------------
  // In a web browser, Google sign-in is an ordinary page redirect. Inside the
  // Capacitor app that bounces out to an external browser and the session never
  // comes back. So when running NATIVELY we open Google in a system browser tab,
  // return via the com.thaiear.app:// deep link, and complete the session here in
  // the webview. All of this is gated by isNative(), so the website is unaffected.
  var NATIVE_REDIRECT = 'com.thaiear.app://auth-callback';
  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }
  function capPlugin(name) {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  }
  // App-only: Stripe checkout returns via checkout-return.html → the com.thaiear.app://checkout-return
  // deep link → here. Close the in-app browser, refresh membership, and land on the right page. The
  // webview never lost its session, so the user is still logged in (the broken bit was the return trip).
  function handleCheckoutReturn(url) {
    if (!url || url.indexOf('checkout-return') === -1) return;
    var Browser = capPlugin('Browser');
    try { if (Browser && Browser.close) Browser.close(); } catch (_) {}
    var status = 'success';
    try { status = (new URLSearchParams(url.split('?')[1] || '')).get('status') || 'success'; } catch (_) {}
    if (status === 'cancel') { try { window.location.href = '/subscribe.html'; } catch (_) {} return; }
    refreshSubscription();   // re-read the (now active) subscription, then show the success page
    try { window.location.href = '/account.html?sub=success'; } catch (_) {}
  }
  function nativeGoogleSignIn() {
    var Browser = capPlugin('Browser');
    client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: NATIVE_REDIRECT,
        skipBrowserRedirect: true, // don't navigate the webview; we open the tab ourselves
        queryParams: { prompt: 'select_account' }
      }
    }).then(function (res) {
      var url = res && res.data && res.data.url;
      if (!url) { console.warn('[native-auth] no OAuth url returned'); return; }
      if (Browser && Browser.open) Browser.open({ url: url });
      else window.location.href = url; // last-resort fallback
    }).catch(function (e) { console.error('[native-auth] sign-in failed', e); });
  }
  // The deep link returns from Google → Supabase → app. Handle BOTH Supabase
  // flows: implicit (tokens in the URL hash) and PKCE (?code= exchanged here).
  function handleAuthDeepLink(url) {
    if (!url || url.indexOf('auth-callback') === -1) return;
    var Browser = capPlugin('Browser');
    var close = function () { try { if (Browser && Browser.close) Browser.close(); } catch (_) {} };
    try {
      var hp = new URLSearchParams(url.split('#')[1] || '');
      var at = hp.get('access_token'), rt = hp.get('refresh_token');
      if (at && rt) {
        client.auth.setSession({ access_token: at, refresh_token: rt })
          .then(close).catch(function (e) { console.error('[native-auth] setSession', e); close(); });
        return;
      }
      var code = new URLSearchParams((url.split('?')[1] || '').split('#')[0]).get('code');
      if (code) {
        client.auth.exchangeCodeForSession(code)
          .then(close).catch(function (e) { console.error('[native-auth] exchangeCode', e); close(); });
        return;
      }
      console.warn('[native-auth] deep link had no token or code:', url);
    } catch (e) { console.error('[native-auth] deep link parse failed', e); }
  }

  // Public API. getUser() is synchronous; the rest are no-ops until the
  // Supabase client has loaded (avoids errors if a button is hit very early).
  window.ThaiEarAuth = {
    isReady: false,
    getUser: function () { return currentUser; },
    // The Supabase session JWT, for authorising premium-audio requests to /api/audio.
    // Synchronous + cached; null until the session resolves or when logged out.
    getAccessToken: function () { return currentSession ? currentSession.access_token : null; },
    // Synchronous + cached. False until the subscription row resolves (or when not subscribed).
    // The real gate is server-side (/api/audio); this just drives the unlocked/locked UX.
    isSubscribed: function () { return currentSubscribed; },
    // True only when a clean server read answered this session — see subFresh.
    isSubscriptionFresh: function () { return subFresh && (Date.now() - subFreshAt) < SUB_FRESH_TTL_MS; },
    getSubscription: function () { return currentSub; }, // {status, cancel_at_period_end, current_period_end}

    /* ── desktop MP3 download (see refreshDesktopDl) ────────────────────────────────────────
       Synchronous + cached, like isSubscribed(). False until the server answers, and false again
       the moment the user signs out. player.js calls this to decide whether the button exists at
       all; account.html calls isDesktopDlAdmin() to decide whether the granting panel exists. */
    canDesktopDownload: function () { return dlAllowed; },
    isDesktopDlAdmin: function () { return dlAdmin; },
    isDesktopDlChecked: function () { return dlChecked; },
    // Re-ask the server — used by the admin panel after it grants or revokes, so an admin who
    // changes their OWN access sees it take effect without a reload.
    refreshDesktopDl: function () { refreshDesktopDl(); },

    /* ══ THE ONE OFFLINE-ENTITLEMENT PREDICATE (added 2026-07-31) ═══════════════════════════════
       Both surfaces ask THIS. Previously player.js decided entitlement and playlists.html had no
       tier awareness at all — so its download path fetched locked clips, hit 401/402 and failed
       wholesale, while r31's content-based dlHasAll() then demanded those same clips forever.
       Keeping one copy is the point: the SAME rule fixed in one place and missed in the other is
       bug #7 (sentLocked vs entitledForPage) and §B4 (stampVerified's two call sites) — twice.
       It lives in auth.js because auth.js already owns all three licence markers
       (thaiear_lastVerified / thaiear_sub_until / thaiear_lifetime) and writes them via
       stampOfflineLicence(), and because EVERY surface loads auth.js while only the `?pl=` view
       loads player.js.

       ⚠⚠ MUST call this.isSubscribed() / this.isSubscriptionFresh() / this.getUser() — NEVER the
       module-private currentSubscribed / subFresh / currentUser. sim.js wraps ThaiEarAuth with
       Object.create(real) (sim.js:88), so ONLY property lookups can be overridden. Reading the
       closure variables directly would silently bypass the simulator and make every entitlement
       test (A/B/X/R/1.x/2.x) pass vacuously against the owner's real lifetime account — a failure
       that looks exactly like success. */
    canUseOffline: function (tier) {
      if (tier !== 'premium') return true;
      // Lifetime members never time out offline. auth.js only sets this flag when the server
      // confirms lifetime+active while online, so a regular paying user cannot reach it.
      try { if (localStorage.getItem('thaiear_lifetime') === '1') return true; } catch (_) {}
      /* ONE question decides everything: DID THE SERVER ANSWER US THIS SESSION? navigator.onLine
         reports online in airplane mode and isSubscribed() reads a cached flag — neither can be
         trusted. isSubscriptionFresh() is true only after a clean subscriptions read.
           answered + subscribed → grant, and stamp (an authoritative confirmation)
           answered + not        → deny outright; the server has spoken
           no answer             → fall through to the offline rules below */
      if (this.isSubscriptionFresh && this.isSubscriptionFresh()) {
        if (this.isSubscribed && this.isSubscribed()) {
          /* Stamp at most once a minute. This runs PER SENTENCE per render (sentLocked → here), so
             an unthrottled stamp meant dozens of localStorage writes — and dozens of trace lines —
             for a single playlist paint. Re-stamping a licence stamped seconds ago adds nothing.
             ⚠ THROTTLED ON AN IN-MEMORY CLOCK, NOT ON thaiear_lastVerified. The first attempt keyed
             off the persisted marker and did NOT WORK: while the owner simulator is armed
             stampOfflineLicence() returns early without writing, so the marker never advances and
             the throttle re-fires forever — 299 calls in one burst in the r42 trace, with a
             backdated "Last verified". A guard must never depend on a value the guarded call is
             free to skip writing. */
          if (Date.now() - lastStampAttempt > 60000) { lastStampAttempt = Date.now(); stampOfflineLicence(); }
          return true;
        }
        return false;
      }
      // Server did NOT answer. Trust the captured real period end first (correct billing: cancel =
      // access until period end); the grace window is only the fallback when none was captured.
      // Past both, deny — which surfaces as "Reconnect to keep listening", NOT the paywall,
      // because we are not claiming they lapsed, only that we can no longer vouch for them.
      var last = 0, until = 0;
      try {
        last = parseInt(localStorage.getItem('thaiear_lastVerified') || '0', 10);
        until = parseInt(localStorage.getItem('thaiear_sub_until') || '0', 10);
      } catch (_) {}
      if (until && Date.now() < until) return true;
      return !!last && (Date.now() - last) < OFFLINE_GRACE_MS;
    },

    /* Is THIS item locked for the current visitor? The one lock rule, shared by player.js's
       sentLocked() and playlists.html's dlGroup(). Pass {tier, prefix}.
       `opts.canStoreOffline` is the CALLER's storage-backend capability (player.js:
       OFFLINE||WEB_DL||DYN_WEB_DL; playlists.html: DL_OK). It is passed in rather than re-derived
       here so behaviour stays byte-identical to what each surface did before this consolidation. */
    lockedFor: function (item, opts) {
      var tier = (item && item.tier) || 'free';
      if (tier !== 'member' && tier !== 'premium') return false;
      if (tier === 'premium') return !this.canUseOffline('premium');
      // MEMBER = any signed-in user. A download of theirs stays open (nothing to expire).
      var pfx = item && item.prefix;
      if (opts && opts.canStoreOffline && pfx && hasOfflineEntry(pfx)) return false;
      if (!this.isReady) return false;          // auth still resolving → never lock a paying user
      return !(this.getUser && this.getUser());
    },
    /* DOWNLOAD-only gate — ACCESS and DOWNLOAD became different questions with the 2026-08 tier
       retirement. A Free unit STREAMS for anyone signed in or not, but only a signed-in user may
       DOWNLOAD it: downloads (with playlists, progress and flagging) are what an account is for.

       ⚠ Do NOT fold this into lockedFor(). That predicate answers "may this visitor HEAR this",
       and it also drives player.js's sentLocked() and dynUnitLocked() — teaching it that free
       needs an account would silently mute free sentences for logged-out visitors, which is the
       exact opposite of the tier retirement's purpose.

       Layered deliberately: the tier rules run FIRST (via lockedFor), so premium still needs a
       live subscription and this only ever adds the account requirement on top. */
    downloadLockedFor: function (item, opts) {
      if (this.lockedFor(item, opts)) return true;
      // Already on disk → stays usable, same principle as the member rule in lockedFor().
      var pfx = item && item.prefix;
      if (opts && opts.canStoreOffline && pfx && hasOfflineEntry(pfx)) return false;
      if (!this.isReady) return false;          // auth still resolving → never lock a paying user
      return !(this.getUser && this.getUser());
    },
    // True inside the Capacitor app. Pages use this to HIDE any upgrade-to-premium / checkout CTA
    // (Google Play reader-app rule: no in-app purchase or steering to web payment). Web is unaffected.
    isNative: function () { return isNative(); },
    // Marketing-email consent (cached). setMarketingConsent upserts the profiles row.
    getMarketingConsent: function () { return currentConsent; },
    // Has the consent flag finished loading from the profiles row? Lets the account
    // UI hold off rendering until it knows, so it never flashes the wrong state.
    isMarketingConsentLoaded: function () { return consentLoaded; },
    setMarketingConsent: function (optIn) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var row = {
        user_id: currentUser.id,
        email: currentUser.email || null,
        marketing_opt_in: !!optIn,
        marketing_opt_in_at: optIn ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };
      return client.from('profiles').upsert(row).then(function (res) {
        if (res && res.error) throw res.error;
        currentConsent = !!optIn;
        // Best-effort sync to MailerLite. Pull a FRESH token from the client (the cached
        // session can be momentarily stale), and log the outcome so failures are visible in
        // the console rather than silently swallowed. Consent is already saved in Supabase
        // above, so we never fail the save if MailerLite is briefly unavailable.
        return client.auth.getSession().then(function (s) {
          var tok = s && s.data && s.data.session && s.data.session.access_token;
          if (!tok) { console.warn('[marketing] no access token — MailerLite sync skipped'); return true; }
          return fetch('/api/marketing', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
            body: JSON.stringify({ optIn: !!optIn })
          }).then(function (r) {
            return r.text().then(function (t) {
              if (r.ok) console.log('[marketing] MailerLite sync ok:', t);
              else console.warn('[marketing] MailerLite sync failed', r.status, t);
              return true;
            });
          }, function (e) { console.warn('[marketing] MailerLite sync error', e); return true; });
        });
      });
    },
    // ---- listening progress -------------------------------------------------
    // The bar goal steps (5,10,20,50,100) — the progress page reads this to build
    // the toggle so the values live in one place.
    progressGoalSteps: function () { return GOAL_STEPS.slice(); },
    // Synchronous, cached. getProgressData() is null until loadProgress() resolves.
    getProgressData: function () { return currentProgress; },
    isProgressLoaded: function () { return progressLoaded; },
    getProgressGoal: function () { return currentProgress ? currentProgress.goal : 5; },
    getTopicProgress: function (key) { return (currentProgress && currentProgress.topics[key]) || 0; },
    // Async. Resolves the cached row (fetching once); safe to call repeatedly.
    loadProgress: function () {
      if (progressLoaded && currentProgress) return Promise.resolve(currentProgress);
      return fetchProgress();
    },
    addProgress: function (key) {
      return mutateProgress(function (p) {
        var n = (p.topics[key] || 0) + 1;
        p.topics[key] = n;
        if (n > p.goal) p.goal = nextGoalFor(n); // auto-advance so the bar never overflows
      });
    },
    removeProgress: function (key) {
      return mutateProgress(function (p) {
        var n = Math.max(0, (p.topics[key] || 0) - 1);
        if (n === 0) delete p.topics[key]; else p.topics[key] = n;
      });
    },
    // Set the global goal. Never below the highest count (the bars can't overflow),
    // so a goal smaller than the current max is clamped up to the next valid step.
    setProgressGoal: function (goal) {
      return mutateProgress(function (p) {
        var floor = nextGoalFor(maxCount(p.topics));
        p.goal = Math.max(goal, floor);
      });
    },
    // Wipe all counts (the goal is left as-is). (Caller confirms first.)
    resetProgress: function () {
      return mutateProgress(function (p) { p.topics = {}; });
    },
    // ---- per-sentence play counts (PLAYS_COUNTER.md) -------------------------
    // Synchronous and always safe to call: the local store answers instantly, online or off,
    // signed in or not. Signed out it is an empty map, because the feature does not exist there.
    getPlays: function () { return currentUser ? plysMerged() : {}; },
    /* REPETITIONS, not passes. getPlays() is what the pill and the topic/playlist minimum use;
       this is what the headline total and the listening time use. ⚠ They are different numbers on
       purpose — see plysBlank(). */
    getPlayReps: function () { return currentUser ? plysMergedReps() : {}; },
    getPlayCount: function (num) {
      if (!currentUser) return 0;
      return plysMerged()[String(num)] || 0;
    },
    /* One sentence's REPETITIONS — how many times its Thai was actually heard. This is what the
       collapsed pill shows (owner, 2026-08-22: "if 4 Thai repeats, EACH individual repeat adds
       one"), and it is the same measure every listening-time roll-up sums.
       ⚠ getPlayCount() — the PASSES figure — is now displayed NOWHERE. It is still recorded and
       still synced, and it is what playsMin() would need if the retired minimum roll-up ever came
       back, so do not delete either. See PLAYS_COUNTER.md §2a. */
    getPlayRepCount: function (num) {
      if (!currentUser) return 0;
      return plysMergedReps()[String(num)] || 0;
    },
    // Async: pull the account copy once per session, then resolve the merged map. Callers may
    // repeat it freely. Offline it resolves the local copy rather than hanging or rejecting.
    loadPlays: function () { return plysLoad(); },
    isPlaysLoaded: function () { return plysLoaded; },
    /* Record that a sentence was heard. player.js calls this ONCE per sentence per listen -
       the dwell rule (2s of playback, or the clip/block ending) lives there, not here, because
       only the player knows whether audio was actually running. Thai repeats set to 4 is still
       ONE call: repeats are one listen, not four. Fire and forget; returns nothing. */
    notePlay: function (num, n, reps) { plysNote(num, n, reps); },
    // Deliver the queue now. Called by the pagehide/visibilitychange hooks and on 'online';
    // exposed for tests and for anything that wants to force delivery before navigating.
    flushPlays: function () { return plysFlush(); },
    /* Server-decided listening stats for the Progress page: { daysListened, streak, bestStreak,
       lastListenDate }. Synchronous and always defined — the cached copy answers offline.
       ⚠ These are NOT computed client-side. /api/plays decides them from last_listen_date, in
       UTC days, so a streak can break at 07:00 Bangkok; the page says so in words. */
    getPlayStats: function () { return currentUser ? plysStatsGet() : { daysListened: 0, streak: 0, bestStreak: 0, lastListenDate: null }; },
    /* Reset every counter to zero. ⚠ A RESET, NOT AN ERASURE — the row survives and tracking
       continues; deleting the account is what removes the record, via account.html. Clears the
       LOCAL store too, including any queued outbox, or the next flush resurrects what was just
       cleared. Resolves true on success. */
    resetPlays: function () {
      var tok = currentSession && currentSession.access_token;
      if (!currentUser || !tok) return Promise.resolve(false);
      return fetch('/api/plays', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } })
        .then(function (res) {
          if (!res.ok) return false;
          plysCache = plysBlank();
          plysPersist();
          plysStatsSet({});
          plysLoaded = true;
          notify();
          return true;
        })
        .catch(function () { return false; });
    },

    // ---- flagged sentences --------------------------------------------------
    loadFlags: function () {
      if (flagsLoaded && currentFlags) return Promise.resolve(currentFlags);
      return fetchFlags();
    },
    isFlagsLoaded: function () { return flagsLoaded; },
    isFlagged: function (tk, num) { return !!(currentFlags && currentFlags[flagKey(tk, num)]); },
    // All flagged records: [{ topic_key, num, sentence }, …]
    getFlags: function () {
      if (!currentFlags) return [];
      return Object.keys(currentFlags).map(function (k) { return currentFlags[k]; });
    },
    // Toggle a sentence flag. nugget = { num, preview, thai, english, gloss, cultural, audioPrefix }.
    // Resolves to the new state (true = now flagged, false = now unflagged).
    // Optimistic: toggle the LOCAL cache + persist immediately (works offline), queue the desired state,
    // and write through. Resolves to the new state right away; a failed/offline write is flushed later.
    toggleFlag: function (tk, nugget) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var num = nugget.num, key = flagKey(tk, num);
      var ready = (flagsLoaded && currentFlags) ? Promise.resolve() : fetchFlags();
      return ready.then(function () {
        var nowFlagged = !currentFlags[key];
        if (nowFlagged) currentFlags[key] = { topic_key: tk, num: num, sentence: nugget };
        else delete currentFlags[key];
        persistFlags();
        queueFlag(key, tk, num, nugget, nowFlagged);
        pushFlag(key, tk, num, nugget, nowFlagged); // write through (clears the queue entry on success)
        return nowFlagged;
      });
    },
    // Remove a flag by (topicKey, num) — used by the My-sentences page's remove button.
    removeFlag: function (tk, num) {
      if (!client || !currentUser) return Promise.reject(new Error('not signed in'));
      var key = flagKey(tk, num);
      var ready = (flagsLoaded && currentFlags) ? Promise.resolve() : fetchFlags();
      return ready.then(function () {
        var nugget = (currentFlags[key] && currentFlags[key].sentence) || { num: num };
        delete currentFlags[key];
        persistFlags();
        queueFlag(key, tk, num, nugget, false);
        pushFlag(key, tk, num, nugget, false);
        return true;
      });
    },
    signInWithGoogle: function () {
      if (!client) { console.warn('ThaiEar auth still loading…'); return; }
      /* Safety net for the offline-logout case: if we still hold tokens for this device, restore
         the session from them rather than starting an OAuth round trip that cannot complete
         without a network. Costs one promise when it doesn't apply, and turns the reported
         "tapping sign in did nothing" into an actual sign-in the moment there IS a connection. */
      if (!currentUser && readIdentity()) {
        reseedSession().then(function (ok) {
          if (ok) return;                       // restored — onAuthStateChange re-renders
          if (!navigator.onLine) { alert('You’re offline. You’ll be signed back in automatically when you reconnect — your downloads keep working in the meantime.'); return; }
          startGoogleSignIn();
        });
        return;
      }
      startGoogleSignIn();
    },
    // Passwordless "magic link": Supabase emails a one-click sign-in link. Creating an
    // account and signing in are the same action (shouldCreateUser defaults true).
    //
    // ⚠ SINCE 2026-08-19 THE EMAIL DOES NOT LINK TO SUPABASE'S /auth/v1/verify ANY MORE.
    // Both email templates ("Confirm signup" for a new address, "Magic Link" for a
    // returning one) point at our own /confirm page carrying {{ .TokenHash }}, which
    // verifies on a CLICK via verifyOtpHash below. Reason: a magic link is single-use and
    // Microsoft Defender "Safe Links" pre-fetches URLs in email to detonate them — it was
    // spending the token before the human ever clicked, silently blocking signup for every
    // Office 365 / university / corporate address. Evidence: ADS_OPERATIONS.md §4.2.
    //
    // So detectSessionInUrl no longer does the work for this flow; confirm.html does.
    //
    // ⚠⚠ DO NOT "TIDY" emailRedirectTo TO THE CLEAN /account. It was changed to /account on
    // 2026-08-19 and REVERTED the same hour, deliberately. `/account.html` is the value proven
    // to be in Supabase's Redirect-URLs allow-list (it is what production sends today and
    // sign-ins work); `/account` may not be, and an allow-list miss fails the send itself —
    // i.e. it would break sign-in for EVERYONE to save a redirect that, since the TokenHash
    // switch, is never even followed. We build our own URL from {{ .TokenHash }}, so this
    // value is not navigated to at all in the new flow. Zero benefit, total downside.
    // (If you ever do want the clean URL: add it to Auth → URL Configuration → Redirect URLs
    // FIRST, verify a real send, and only then change it here.)
    // Returns the Supabase promise ({ data, error }) so the caller can show feedback.
    sendMagicLink: function (email) {
      if (!client) return Promise.reject(new Error('auth still loading'));
      return client.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + '/account.html' }
      });
    },
    /* The click-side half of the interstitial. confirm.html calls this from its button
       handler and NOWHERE ELSE — calling it on page load would hand the token straight
       back to the scanner and undo the whole fix.

       ⚠ `type` must match how gotrue ISSUED the token, and the correct string is not
       obvious: Supabase's own docs use `type=email` for BOTH the "Confirm signup" and
       "Magic Link" templates, while the client's EmailOtpType union also accepts 'signup'
       and 'magiclink'. Getting it wrong fails every sign-in, so confirm.html does NOT rely
       on one guess — it cascades through the candidates. That is safe because a rejected
       verifyOtp does not spend the token: gotrue looks the token up by hash AND type and a
       mismatch is a lookup miss, not a consumption.
       Returns Supabase's { data, error } shape. */
    verifyOtpHash: function (tokenHash, type) {
      if (!client) return Promise.reject(new Error('auth still loading'));
      return client.auth.verifyOtp({ token_hash: tokenHash, type: type || 'email' });
    },
    /* Belt and braces: the same OTP rendered as {{ .Token }}, for a scanner that presses
       buttons or a link mangled in transit. ⚠ It is the SAME record as the link — not a
       second credential — so whichever is used first spends both. */
    verifyOtpCode: function (email, token, type) {
      if (!client) return Promise.reject(new Error('auth still loading'));
      return client.auth.verifyOtp({ email: email, token: token, type: type || 'email' });
    },
    signOut: function () {
      if (!client) return Promise.resolve();
      // Logout must work even with NO connection. Supabase's signOut() POSTs to /logout to revoke the
      // token (and even scope:'local' can make that network call), which hangs forever offline — and
      // navigator.onLine is unreliable in the webview (frequently reports "online" in airplane mode),
      // so we can't branch on it. Strategy: attempt a local sign-out but RACE it against a short timeout,
      // then ALWAYS finish with a guaranteed local teardown (wipe the cached Supabase session, reset the
      // cached state, and notify) so the UI logs out within ~1.5s no matter what the network does.
      var forceLocal = function () {
        try {
          for (var i = localStorage.length - 1; i >= 0; i--) {
            var k = localStorage.key(i);
            if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) localStorage.removeItem(k);
          }
        } catch (_) {}
        currentSession = null; currentUser = null;
        currentSubscribed = false; currentSub = null;
        dlAllowed = false; dlAdmin = false; dlChecked = false;   // desktop-dl: never survives a sign-out
        // Clear the premium OFFLINE licence stamps too, so a DIFFERENT account signing in on this
        // device can't reuse the previous user's verification to play their premium downloads offline.
        // (A real premium user re-stamps automatically next time they're online — see stampVerified.)
        try {
          localStorage.removeItem('thaiear_lifetime');
          localStorage.removeItem('thaiear_lastVerified');
          localStorage.removeItem('thaiear_sub_until');
        } catch (_) {}
        // Drop OUR durable identity too and raise the signed-out marker — this is the ONLY thing
        // that may log a user out now, so it has to be unambiguous. Without it the offline
        // fallback would faithfully sign them straight back in.
        clearIdentity();
        notify();   // re-render nav + account page as logged-out
      };
      var attempt = client.auth.signOut({ scope: 'local' }).catch(function () {});
      var timeout = new Promise(function (res) { setTimeout(res, 1500); });
      return Promise.race([attempt, timeout]).then(forceLocal);
    }
  };

  // ---- playlists (2026-07-27, DYNAMIC_PLAYER_PLAN.md → PLAYLISTS) -----------------------------
  // Free feature for ANY signed-in account (not premium-gated). Tables playlists/playlist_items
  // (top-level playlists_schema.sql, RLS on user_id). Items carry a display nugget
  // (thai/translit/english) + prefix/tier so playlist pages render and build audio without
  // loading topic pages. Cached in localStorage (thaiear_playlists) for offline reads.
  // All methods are additive and guarded — if the tables don't exist yet, load() degrades to
  // the local cache and the UI just shows what it has.
  var plCache = null;
  /* r76 — MUTATION SEQUENCE GUARD. `load()` ends in a wholesale `plCache = lists`, and it is a
     TWO-step fetch (playlists, then items), so it holds a stale snapshot across a wide window.
     playlists.html fires `load(true)` on EVERY `thaiear:auth` event, including TOKEN_REFRESHED,
     which arrives on its own schedule. A local mutation landing inside that window was therefore
     overwritten by the older server copy — the user created a playlist, saw it appear, then saw it
     vanish, assumed the save had failed, created it again, and ended up with a real duplicate.
     (Owner, 2026-08-01: "on about two occasions of about 20 trials"; the rate is just how often a
     token refresh overlaps a create.)
     Every mutating method bumps plSeq. load() captures it at the start and, if it has moved by the
     time the response lands, DISCARDS the response rather than overwriting a newer local state.
     The cost is a slightly staler read until the next load; the alternative is silently destroying
     a write the user just made. This protects create/remove/rename/addItem/removeItem alike — they
     were all exposed to the same overwrite, not just create. */
  var plSeq = 0;
  /* Was the value the LAST resolved load() handed back an authoritative server read?
     ⚠ LOAD-BEARING: dlReconcileRefs() frees download claims for playlists that "no longer exist",
     and its contract says it may only ever see an authoritative list — reconciling against a
     cache-only or failed load could read "no playlists" and free clips that are legitimately
     claimed. But load() CATCHES INTERNALLY AND RESOLVES with plLocal(), so a failed load already
     looked identical to a good one at the call site (pre-existing; the sequence guard adds a
     second such path). Callers that act destructively on the result MUST check this first. */
  var plLoadAuth = false;
  function plStore() { try { localStorage.setItem('thaiear_playlists', JSON.stringify(plCache)); } catch (_) {} }
  function plLocal() { try { return JSON.parse(localStorage.getItem('thaiear_playlists') || 'null'); } catch (_) { return null; } }

  /* ══ OFFLINE WRITE OUTBOX (2026-08-09, OFFLINE_PLAYLISTS_PLAN.md Part A) ═════════════════════
     Every playlist mutation used to POST and reject with no connection, so nothing a user did
     offline survived — you could flag a sentence on a plane but not add it to a playlist. This is
     the flags outbox (pendingFlags/pushFlag/flushFlags/applyPendingFlags above) generalised to
     four operation types, and it is keyed by uid() for the same non-negotiable reason: a queued
     write must never leak into whichever account signs in next.

     ⚠ IDS ARE MINTED CLIENT-SIDE AND ARE FINAL FROM BIRTH. `playlists.id` is a plain uuid primary
     key and RLS only checks user_id, so an explicit id is allowed. DO NOT "simplify" this into a
     temporary id that gets replaced by a server id on reconnect: a playlist id is not just a
     database key, it is a NAMESPACE across four local stores —
        · manifest download claims   refs: ['pl-<id>']        (pl-list.js dlReconcileRefs)
        · download records           dlPlMap()[<id>]
        · built session metadata     te_dyn_meta_pl-<id>_<mode>
        · the stitched audio itself  /dyn/pl-<id>/<mode>.(wav|m4a|ogg)
     — and the code that walks them is the one function on this project that can DELETE the user's
     downloaded audio. Remapping an id means rewriting all four. Minting the real UUID up front
     means nothing is ever remapped.

     SHAPE — a collapsed two-tier outbox, not a raw op log. Playlists have ordering constraints
     (a list must exist before its items) but the ops still COLLAPSE, exactly like flags:
        lists:   { <listId>: {op:'create'|'delete', name, position, at} }
        renames: { <listId>: name }
        items:   { '<listId>:<topicKey>:<num>': {op:'add'|'remove', listId, tk, num, payload, at} }
     Toggling an item on/off/on collapses to ONE entry. A list created AND deleted while offline
     collapses to nothing sent at all. Flush order per round: creates → renames → items → deletes,
     and every push is idempotent (upsert / delete) so an interrupted flush is safely re-runnable. */
  var PL_PEND_KEY = 'thaiear_pl_pending';
  var PL_PEND_MAX_AGE = 30 * 24 * 3600 * 1000;   // see plPendPrune()
  function plPendGet() {
    var c = lsGet(PL_PEND_KEY);
    var o = (c && c.uid === uid())
      ? { lists: c.lists || {}, renames: c.renames || {}, items: c.items || {} }
      : { lists: {}, renames: {}, items: {} };
    return plPendPrune(o);
  }
  function plPendSet(o) { if (uid()) lsSet(PL_PEND_KEY, { uid: uid(), lists: o.lists, renames: o.renames, items: o.items }); }
  function plPendEmpty(o) {
    o = o || plPendGet();
    return !Object.keys(o.lists).length && !Object.keys(o.renames).length && !Object.keys(o.items).length;
  }
  /* AGE CAP — the release valve for anything plOpFatal() fails to recognise. An op that can never
     succeed but is not classified fatal would sit in the outbox forever, and because
     authoritative() is gated on the outbox being empty (see below) that would permanently disable
     dlReconcileRefs — the garbage collector for downloads. The device would quietly stop
     reclaiming space, with no symptom until it is full. Unknown errors stay TRANSIENT on purpose
     (discarding a user's write on an unclassified blip is worse than a delayed reap), so this cap
     is what guarantees the outbox always drains eventually. */
  function plPendPrune(o) {
    var now = Date.now(), changed = false;
    ['lists', 'items'].forEach(function (bucket) {
      Object.keys(o[bucket]).forEach(function (k) {
        var e = o[bucket][k];
        if (e && e.at && (now - e.at) > PL_PEND_MAX_AGE) {
          delete o[bucket][k]; changed = true;
          console.warn('[pl] dropped a queued playlist op older than 30 days (' + bucket + ' ' + k + ')');
        }
      });
    });
    if (changed) plPendSet(o);
    return o;
  }
  function plItemKey(listId, tk, num) { return listId + ':' + tk + ':' + num; }
  /* crypto.randomUUID() needs a secure context AND Safari 15.4+ — the app and thaiear.com are both
     https, but an older iPhone still on 15.0 would otherwise throw here and take create() with it.
     getRandomValues() is available far further back; the version/variant bits are set by hand so
     the result is a well-formed v4 and Postgres accepts it as a uuid. */
  function plUuidFallback() {
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [], i;
    for (i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
           '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }
  /* Can this error EVER succeed on a retry? Only a known-semantic failure is dropped; everything
     else — fetch failure, 5xx, 429, timeout, an expired token (401 recovers after a refresh), a
     missing table mid-migration — stays queued. Direction chosen deliberately: unknown → retry,
     because losing a user's write is worse than a late reap, and the age cap catches the rest. */
  function plOpFatal(e) {
    if (!e) return false;
    var code = String(e.code || '');
    // 23503 FK violation (the playlist was deleted on another device — the canonical case),
    // 23505 unique violation, 42501 insufficient privilege / RLS refusal.
    if (code === '23503' || code === '23505' || code === '42501') return true;
    var st = e.status || (e.originalError && e.originalError.status) || 0;
    return st === 403 || st === 404 || st === 409;
  }
  function plUnqueue(bucket, key) {
    var o = plPendGet();
    if (o[bucket] && o[bucket][key] !== undefined) { delete o[bucket][key]; plPendSet(o); }
  }
  // Forget every queued op belonging to a list — used when a create+delete pair collapses, and
  // when a create is dropped as unsyncable (its items could only ever FK-fail after it).
  function plPendPurgeList(id, o) {
    var own = !o; o = o || plPendGet();
    delete o.lists[id]; delete o.renames[id];
    Object.keys(o.items).forEach(function (k) { if (o.items[k].listId === id) delete o.items[k]; });
    if (own) plPendSet(o);
    return o;
  }
  function plQueueCreate(id, name, position) {
    var o = plPendGet();
    o.lists[id] = { op: 'create', name: name, position: position || 0, at: Date.now() };
    plPendSet(o);
  }
  function plQueueDelete(id) {
    var o = plPendGet();
    // Created AND deleted while offline → nothing ever reaches the server.
    if (o.lists[id] && o.lists[id].op === 'create') { plPendPurgeList(id, o); plPendSet(o); return; }
    plPendPurgeList(id, o);                                  // its item ops are moot now
    o.lists[id] = { op: 'delete', at: Date.now() };
    plPendSet(o);
  }
  function plQueueRename(id, name) {
    var o = plPendGet();
    // A list that has not been created on the server yet is renamed in place, not separately.
    if (o.lists[id] && o.lists[id].op === 'create') o.lists[id].name = name;
    else o.renames[id] = name;
    plPendSet(o);
  }
  /* Is this list still waiting to be CREATED server-side? An item push must not overtake its
     parent: the row would fail the foreign key, plOpFatal() would correctly judge that unsyncable,
     and the user's addition would be silently dropped. While a create is queued the immediate
     attempt is skipped entirely and plFlush() delivers it — that replays in dependency order and
     already has the same guard (`blocked`). */
  function plCreatePending(id) {
    var o = plPendGet();
    return !!(o.lists[id] && o.lists[id].op === 'create');
  }
  function plQueueItem(op, listId, tk, num, payload) {
    var o = plPendGet();
    o.items[plItemKey(listId, tk, num)] = { op: op, listId: listId, tk: tk, num: num, payload: payload || null, at: Date.now() };
    plPendSet(o);
  }

  /* The raw server calls, factored out so the immediate attempt and the replay share ONE
     implementation (in particular the plNotes fallback below, which must not be duplicated). */
  function plChk(r) { if (r && r.error) throw r.error; return r; }
  function plPushCreate(rec) {
    return client.from('playlists')
      .upsert({ id: rec.id, user_id: currentUser.id, name: rec.name, position: rec.position || 0 })
      .then(plChk);
  }
  function plPushRename(id, name) {
    return client.from('playlists').update({ name: name }).eq('id', id).then(plChk);
  }
  function plPushDelete(id) {
    return client.from('playlists').delete().eq('id', id).then(plChk);
  }
  function plPushItemAdd(row) {
    var conflict = { onConflict: 'playlist_id,topic_key,num' };
    var send = {};
    Object.keys(row).forEach(function (k) { send[k] = row[k]; });
    if (!plNotes) { delete send.gloss; delete send.cultural; }
    return client.from('playlist_items').upsert(send, conflict)
      .then(function (r) {
        // r145: the notes columns may not exist yet — demote once and retry without them.
        if (r.error && plNotes && plSchemaErr(r.error)) {
          plNotes = false;
          delete send.gloss; delete send.cultural;
          return client.from('playlist_items').upsert(send, conflict);
        }
        return r;
      })
      .then(plChk);
  }
  function plPushItemRemove(listId, tk, num) {
    return client.from('playlist_items').delete()
      .eq('playlist_id', listId).eq('topic_key', tk).eq('num', num).then(plChk);
  }
  /* One attempt at one queued op. Resolves either way — the caller is a fire-and-forget write
     path, never a place to surface an exception. Returns true if the op left the outbox. */
  function plRunOp(bucket, key, fn, onFatal) {
    if (!client || !currentUser) return Promise.resolve(false);
    /* ⚠ fn() IS CALLED INSIDE THE TRY. Since 2026-08-09 the mutations no longer await this — they
       fire it and return — so a SYNCHRONOUS throw from the query builder would escape into the
       caller instead of being caught by the .catch below, taking create()/addItem() down with it
       and losing the very write the outbox exists to protect. The op stays queued either way, so
       plFlush() still delivers it. */
    var p;
    try { p = fn(); } catch (e) { return Promise.resolve(false); }
    if (!p || typeof p.then !== 'function') return Promise.resolve(false);
    return p
      .then(function () { plUnqueue(bucket, key); return true; })
      .catch(function (e) {
        if (!plOpFatal(e)) return false;                     // transient — stays queued, retried later
        /* SILENT BY DESIGN (owner, 2026-08-09): a console line and nothing else. The op that gets
           dropped is nearly always one whose intent is already moot — you deleted the playlist on
           another device, so "add a sentence to it" no longer means anything — and a dialog saying
           "1 offline change couldn't be saved" invites worry about a deliberate action. */
        console.warn('[pl] dropped an unsyncable queued op (' + bucket + ' ' + key + '):', e && (e.code || e.message));
        plUnqueue(bucket, key);
        if (onFatal) onFatal();
        return true;
      });
  }
  /* ⚠ BOUNDED AWAIT — the correct middle ground, after both extremes failed (2026-08-09).
       · Original: the mutations AWAITED the push. Online that is right and is what the owner
         tested and confirmed. Offline a WebView fetch HANGS for many seconds, so create() only
         resolved after that and player.js never reached dynEnterSelect — "I cannot select any
         sentences" on iPhone; and dynSelDone chains addItem sequentially, so N sentences meant
         N hangs on Android.
       · Then fire-and-forget. That fixed the hang but changed the ONLINE path too, and the owner
         lost adding-to-playlists online — a far worse failure than a slow one.
     So: wait, but never longer than OFFLINE_FALLBACK_MS. Online the push settles well inside that
     and behaviour is byte-identical to the version that worked; offline the caller is released at
     1.2 s while the op stays queued for plFlush(). Same instrument raceLocal() already uses on the
     read path — do not replace this with either extreme again. */
  function plSettle(p, value) {
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (!done) { done = true; clearTimeout(t); resolve(value); } }
      var t = setTimeout(function () { if (!done) { done = true; resolve(value); } }, OFFLINE_FALLBACK_MS);
      p.then(fin, fin);
    });
  }
  var plFlushing = null;
  /* Replay the outbox in dependency order: creates → renames → items → deletes. Sequential, not
     parallel — a list has to exist before its items can reference it. Re-entrant-safe (the online
     event and a thaiear:auth event routinely arrive together). */
  function plFlush() {
    if (!client || !currentUser || !navigator.onLine) return Promise.resolve();
    if (plFlushing) return plFlushing;
    var o = plPendGet();
    if (plPendEmpty(o)) return Promise.resolve();
    var chain = Promise.resolve(), blocked = {};
    Object.keys(o.lists).forEach(function (id) {
      if (o.lists[id].op !== 'create') return;
      chain = chain.then(function () {
        var rec = { id: id, name: o.lists[id].name, position: o.lists[id].position }, fatal = false;
        return plRunOp('lists', id, function () { return plPushCreate(rec); },
          function () { fatal = true; plPendPurgeList(id); })   // fatal create → its items can never land
          /* Block on EITHER outcome. Not-left = transient, retry next round. Fatal = the items were
             just purged from storage, but this chain still holds their closures from the snapshot
             taken at the top of plFlush(), so without this they would be attempted anyway. */
          .then(function (left) { if (!left || fatal) blocked[id] = true; });
      });
    });
    Object.keys(o.renames).forEach(function (id) {
      chain = chain.then(function () {
        if (blocked[id]) return false;
        return plRunOp('renames', id, function () { return plPushRename(id, o.renames[id]); });
      });
    });
    Object.keys(o.items).forEach(function (k) {
      var it = o.items[k];
      chain = chain.then(function () {
        /* ⚠ SKIP, DO NOT ATTEMPT, items whose parent create is still queued. A create that failed
           transiently leaves the list absent server-side, so its items would FK-fail — and an FK
           violation is classified FATAL, so attempting them here would silently DELETE the user's
           queued additions on a passing network blip. */
        if (blocked[it.listId]) return false;
        // A malformed 'add' with no payload could only come from a hand-edited or truncated
        // localStorage record; drop it rather than push `undefined` at PostgREST.
        if (it.op === 'add' && !it.payload) { plUnqueue('items', k); return true; }
        return plRunOp('items', k, function () {
          return it.op === 'add' ? plPushItemAdd(it.payload) : plPushItemRemove(it.listId, it.tk, it.num);
        });
      });
    });
    Object.keys(o.lists).forEach(function (id) {
      if (o.lists[id].op !== 'delete') return;
      chain = chain.then(function () { return plRunOp('lists', id, function () { return plPushDelete(id); }); });
    });
    plFlushing = chain.then(function () { plFlushing = null; }, function () { plFlushing = null; });
    return plFlushing;
  }
  /* Overlay unsynced local ops on top of a freshly-fetched server list — the exact role
     applyPendingFlags() plays for flags. Without it a server read that predates the flush would
     silently undo whatever the user just did offline. Mutates and returns `lists`. */
  function applyPendingPlaylistOps(lists) {
    var o = plPendGet();
    if (plPendEmpty(o)) return lists;
    var by = {};
    lists.forEach(function (p) { by[p.id] = p; });
    Object.keys(o.lists).forEach(function (id) {
      var e = o.lists[id];
      if (e.op === 'create' && !by[id]) {
        var p = { id: id, name: e.name, position: e.position || lists.length, items: [] };
        lists.push(p); by[id] = p;
      } else if (e.op === 'delete' && by[id]) {
        lists.splice(lists.indexOf(by[id]), 1); delete by[id];
      }
    });
    Object.keys(o.renames).forEach(function (id) { if (by[id]) by[id].name = o.renames[id]; });
    Object.keys(o.items).forEach(function (k) {
      var it = o.items[k], p = by[it.listId];
      if (!p) return;
      p.items = p.items || [];
      var at = -1, i;
      for (i = 0; i < p.items.length; i++) {
        if (p.items[i].topic_key === it.tk && p.items[i].num === it.num) { at = i; break; }
      }
      if (it.op === 'add') { if (at < 0 && it.payload) p.items.push(it.payload); }
      else if (at >= 0) p.items.splice(at, 1);
    });
    return lists;
  }

  /* ── r145: the notes columns (gloss jsonb, cultural text) — see playlists_gloss_migration.sql ──
     The nugget gained two fields so the playlist player can open a card to its third stage (gloss
     chips + cultural note) exactly like a topic page. They are ADDITIVE and the deploy is not
     ordered against the migration: if this JS reaches a browser before the SQL has been run,
     PostgREST answers a select/insert naming an unknown column with a hard error, which would
     empty every playlist read and break every "add to playlist" write.
     So the first schema error demotes this flag once, for the session, and the call is retried
     without the two fields — old behaviour, no notes, nothing broken. Once the columns exist the
     flag never trips and the retry never runs. Do NOT "simplify" this away before confirming the
     migration has run on production; it is the only thing making the two deploys order-free. */
  var plNotes = true;
  var PL_COLS = 'id,playlist_id,topic_key,num,prefix,tier,thai,translit,english,position';
  // PGRST204 = "column not found in schema cache"; the message text catches the 42703 variants.
  function plSchemaErr(e) {
    if (!e) return false;
    if (e.code === 'PGRST204' || e.code === '42703') return true;
    return /gloss|cultural/.test(String(e.message || '')) && /column|schema/i.test(String(e.message || ''));
  }
  function plItemsQuery(c) {
    var sel = PL_COLS + (plNotes ? ',gloss,cultural' : '');
    return c.from('playlist_items').select(sel).order('position').order('created_at')
      .then(function (r) {
        if (r.error && plNotes && plSchemaErr(r.error)) {
          plNotes = false;
          return c.from('playlist_items').select(PL_COLS).order('position').order('created_at');
        }
        return r;
      });
  }
  window.ThaiEarAuth.playlists = {
    // Resolves [{id, name, position, items:[{topic_key,num,prefix,tier,thai,translit,english,
    //                                        gloss,cultural}]}]   (r145 added the last two)
    load: function (force) {
      if (plCache && !force) { plLoadAuth = false; return Promise.resolve(plCache); }
      if (!client || !currentUser) { plCache = plLocal() || []; plLoadAuth = false; return Promise.resolve(plCache); }
      var seq = plSeq;   // r76: anything that mutates locally while this is in flight wins
      /* ⚠ RACED AGAINST THE LOCAL COPY (2026-08-09). Owner: opening the playlist chooser on a
         topic page in airplane mode took 7-8 SECONDS before the menu appeared.
         This is a cross-origin PostgREST call to auth.thaiear.com, so sw.js never sees it and its
         NET_TIMEOUT_MS fast-path cannot help — and an offline fetch in this WebView hangs for many
         seconds before it finally rejects (the same fact NET_TIMEOUT_MS exists for). Nothing
         bounded the wait, so the UI just sat there.
         raceLocal() is the pattern progress and flags already use; playlists were the one reader
         that never got it. If the server has not answered within OFFLINE_FALLBACK_MS we resolve
         with the cached copy — which is exactly what the catch below would have produced anyway,
         only 6 seconds sooner. The query is NOT cancelled: if it lands later it still refreshes
         plCache and plLoadAuth for the next read.
         ⚠ The fallback must leave plLoadAuth FALSE — a timed-out read is not authoritative, and
         dlReconcileRefs() may only ever run against one that is. */
      var query = client.from('playlists').select('id,name,position').order('position').order('created_at')
        .then(function (r) {
          if (r.error) throw r.error;
          var lists = r.data || [];
          if (plSeq !== seq) { plLoadAuth = false; return plCache; }
          if (!lists.length) { plCache = []; plStore(); plLoadAuth = true; return plCache; }
          return plItemsQuery(client)
            .then(function (ri) {
              if (ri.error) throw ri.error;
              /* Re-check: the items fetch is the SECOND round trip, and it is the wider half of the
                 window. Without this the guard would only cover the first query. */
              if (plSeq !== seq) { plLoadAuth = false; return plCache; }
              var by = {};
              lists.forEach(function (p) { p.items = []; by[p.id] = p; });
              (ri.data || []).forEach(function (it) { if (by[it.playlist_id]) by[it.playlist_id].items.push(it); });
              applyPendingPlaylistOps(lists);   // unsynced offline ops win over the server copy
              plCache = lists; plStore(); plLoadAuth = true; plFlush(); return plCache;
            });
        })
        .catch(function () { plCache = plLocal() || []; plLoadAuth = false; return plCache; });
      return raceLocal(query, function () {
        if (!plCache) plCache = plLocal() || [];   // never clobber a copy we already hold
        plLoadAuth = false;
        return plCache;
      });
    },
    /* True only if the last resolved load() was a real server read that was not superseded by a
       local mutation. Check this before any destructive action derived from the list.
       ⚠ ALSO FALSE WHILE THE OUTBOX IS NON-EMPTY (2026-08-09). dlReconcileRefs() frees download
       claims for playlists that "no longer exist" — and a playlist created offline does not exist
       on the server until the outbox flushes. The reconnect race is real: pl-list.js fires
       load(true) from thaiear:auth/pageshow, which can easily beat the flush, and the reconciler
       would then read a brand-new playlist as a ghost and delete its downloaded audio. Never
       reconcile against a read we already know is incomplete. */
    authoritative: function () {
      /* ⚠ Evaluated BEFORE the && on purpose — do not fold this back into one expression.
         plPendEmpty() → plPendGet() → plPendPrune() is what applies the 30-day age cap, and
         short-circuiting on a false plLoadAuth would skip it exactly when the outbox is most
         likely to be holding something stuck. */
      var outboxClear = plPendEmpty();
      return plLoadAuth && outboxClear;
    },
    get: function () { return plCache; },
    // Read-only view of the localStorage copy — safe to call BEFORE the client/auth resolve
    // and never touches plCache (playlists.html uses it for an instant cache-first paint).
    peek: function () { return plLocal(); },
    /* ── The four mutations, all offline-capable since 2026-08-09 ────────────────────────────
       Uniform shape, taken from pushFlag(): apply to plCache OPTIMISTICALLY, bump plSeq, queue the
       op, then attempt one push that unqueues on success. There is deliberately NO branch on
       navigator.onLine — it reports *online* in airplane mode in this WebView (documented all over
       player.js), so only a failed attempt proves anything. Offline the attempt simply fails and
       the op stays queued for the next `online` event.
       They therefore RESOLVE rather than reject on a lost connection; that is the point. A genuine
       server refusal still drops the op (plOpFatal) and the local copy self-corrects on the next
       authoritative load. */
    create: function (name) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      // ⚠ Client-minted and FINAL — never remapped later. See the outbox header for why.
      var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : plUuidFallback();
      var p = { id: id, name: name, position: (plCache || []).length, items: [] };
      plSeq++;   /* r76: this write must survive any load() already in flight */
      (plCache = plCache || []).push(p); plStore();
      plQueueCreate(id, name, p.position);
      /* ⚠ FIRE AND FORGET — NEVER await the push here (2026-08-09, owner-reported on iPhone PWA:
         create a playlist in airplane mode and select mode never opened).
         This used to return plRunOp(...).then(→ p), so the caller waited for a network attempt.
         Offline in a WebView a fetch does not fail fast — it HANGS for many seconds before
         rejecting — so player.js's dynEnterSelect(p) ran only after that timeout: the dialog
         closed and, to the user, nothing happened.
         It was masked until sw v255. Before that the esm.sh bundle was wiped by every deploy, so
         `client` was usually null offline and plRunOp returned instantly; making the client
         reliably available offline is what started the real fetch attempt.
         Waiting was never right in any case: the outbox IS the delivery guarantee and plCache is
         authoritative the moment it is written, so there is nothing for the caller to learn by
         waiting. Same reasoning as raceLocal() on the read path. */
      return plSettle(plRunOp('lists', id, function () { return plPushCreate(p); },
        function () {   // unsyncable → undo the optimistic insert rather than show a ghost list
          plPendPurgeList(id);
          if (plCache) { plCache = plCache.filter(function (x) { return x.id !== id; }); plStore(); }
        }), p);                           // the id is already real — see the outbox header
    },
    remove: function (id) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      plSeq++;   /* r76 */
      if (plCache) { plCache = plCache.filter(function (p) { return p.id !== id; }); plStore(); }
      var o = plPendGet();
      var neverExisted = !!(o.lists[id] && o.lists[id].op === 'create');
      plQueueDelete(id);
      // Created and deleted before it ever reached the server — nothing to push.
      if (neverExisted) return Promise.resolve();
      return plSettle(plRunOp('lists', id, function () { return plPushDelete(id); }));
    },
    // Metadata only — touches no prefix, claim or manifest, so it can never affect a download.
    rename: function (id, name) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      plSeq++;   /* r76 */
      if (plCache) {
        plCache.forEach(function (p) { if (p.id === id) p.name = name; });
        plStore();
      }
      plQueueRename(id, name);
      var o = plPendGet();
      // Still queued as a create → the new name travels with it; nothing separate to push.
      if (o.lists[id] && o.lists[id].op === 'create') return Promise.resolve();
      return plSettle(plRunOp('renames', id, function () { return plPushRename(id, name); }));
    },
    addItem: function (id, item) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      var p = (plCache || []).filter(function (x) { return x.id === id; })[0];
      var row = {
        playlist_id: id, topic_key: item.topic_key, num: item.num,
        prefix: item.prefix, tier: item.tier || 'free',
        thai: item.thai, translit: item.translit || null, english: item.english,
        position: p ? p.items.length : 0
      };
      // r145: the notes travel with the nugget (see plNotes above for why this is conditional).
      // Always carried in the QUEUED payload; plPushItemAdd() strips them if the columns are absent.
      row.gloss = item.gloss || null; row.cultural = item.cultural || null;
      plSeq++;   /* r76 */
      if (p && !p.items.some(function (i) { return i.topic_key === row.topic_key && i.num === row.num; })) {
        p.items.push(row); plStore();
      }
      plQueueItem('add', id, row.topic_key, row.num, row);
      /* ⚠ FIRE AND FORGET, like create() — see the note there. dynSelDone() chains these
         SEQUENTIALLY ("Saving… 1 of 5"), so awaiting a hanging offline fetch multiplied the delay
         by the number of sentences chosen: the owner's "they add really really slowly - when
         before they were near instant" on Android, same root cause as the iPhone create hang. */
      if (plCreatePending(id)) return Promise.resolve();   // parent not on the server yet — plFlush orders it
      return plSettle(plRunOp('items', plItemKey(id, row.topic_key, row.num),
        function () { return plPushItemAdd(row); }));
    },
    removeItem: function (id, topicKey, num) {
      if (!currentUser) return Promise.reject(new Error('not signed in'));
      plSeq++;   /* r76 */
      var p = (plCache || []).filter(function (x) { return x.id === id; })[0];
      if (p) { p.items = p.items.filter(function (i) { return !(i.topic_key === topicKey && i.num === num); }); plStore(); }
      var key = plItemKey(id, topicKey, num);
      var o = plPendGet();
      // Added and removed before either reached the server — the pair cancels.
      if (o.items[key] && o.items[key].op === 'add') { delete o.items[key]; plPendSet(o); return Promise.resolve(); }
      plQueueItem('remove', id, topicKey, num, null);
      if (plCreatePending(id)) return Promise.resolve();
      return plSettle(plRunOp('items', key, function () { return plPushItemRemove(id, topicKey, num); }));
    },
    // Which playlists contain this sentence? (from cache — call load() first)
    idsFor: function (topicKey, num) {
      return (plCache || []).filter(function (p) {
        return p.items.some(function (i) { return i.topic_key === topicKey && i.num === num; });
      }).map(function (p) { return p.id; });
    }
  };

  // ── Dynamic-player settings sync (public.dyn_prefs — see dyn_prefs_schema.sql) ──
  // One row per user per scope: 'global' = {pf, rp, en}; '<dynKey>' = {excl:[nums]}.
  // Additive and guarded exactly like the playlists API: signed-out or missing table →
  // degrade to the localStorage mirror ('thaiear_dyn_prefs', keyed by scope).
  var dpCache = null;   // { scope: dataObj }
  function dpStore() { try { localStorage.setItem('thaiear_dyn_prefs', JSON.stringify(dpCache)); } catch (_) {} }
  function dpLocal() { try { return JSON.parse(localStorage.getItem('thaiear_dyn_prefs') || 'null'); } catch (_) { return null; } }
  /* A settings change made OFFLINE used to be written locally, attempted, and the failure
     swallowed — so it never reached the server and no other device ever saw it. Nothing
     re-sent it either. Scopes whose upsert failed are now remembered and flushed when the
     connection (or auth) comes back.
     Only ever marked while a user IS signed in: pushing a signed-out device's local settings
     into whatever account signs in next would overwrite that account's real settings. */
  function dpPending() { try { return JSON.parse(localStorage.getItem('thaiear_dyn_prefs_dirty') || '{}'); } catch (_) { return {}; } }
  function dpSetPending(m) { try { localStorage.setItem('thaiear_dyn_prefs_dirty', JSON.stringify(m)); } catch (_) {} }
  function dpMarkDirty(scope) { var m = dpPending(); m[scope] = 1; dpSetPending(m); }
  function dpClearDirty(scope) { var m = dpPending(); delete m[scope]; dpSetPending(m); }
  function dpFlush() {
    if (!client || !currentUser) return Promise.resolve();
    var m = dpPending(), scopes = Object.keys(m);
    if (!scopes.length) return Promise.resolve();
    var cache = dpCache || dpLocal() || {};
    var chain = Promise.resolve();
    scopes.forEach(function (scope) {
      var data = cache[scope];
      if (data === undefined) { dpClearDirty(scope); return; }   // nothing local to send
      chain = chain.then(function () {
        return client.from('dyn_prefs')
          .upsert({ user_id: currentUser.id, scope: scope, data: data, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,scope' })
          .then(function (r) { if (r.error) throw r.error; dpClearDirty(scope); })
          .catch(function () {});                                 // still offline — keep it pending
      });
    });
    return chain;
  }
  window.ThaiEarAuth.dynPrefs = {
    // Resolves { scope: data } for every row the user has.
    load: function (force) {
      if (dpCache && !force) return Promise.resolve(dpCache);
      if (!client || !currentUser) { dpCache = dpLocal() || {}; return Promise.resolve(dpCache); }
      /* Deduped — this was the worst offender, 6 identical queries per page (four of them within
         5 ms). dpCache only fills when the FIRST answer lands, so every caller racing that window
         queried again. `force` deliberately still starts a fresh request (its whole purpose is to
         bypass the cache); it just publishes it as the new in-flight one, so concurrent ordinary
         callers join the fresher read instead of adding yet another. */
      return once('dynPrefs', function () {
        return client.from('dyn_prefs').select('scope,data')
          .then(function (r) {
            if (r.error) throw r.error;
            var map = {};
            (r.data || []).forEach(function (row) { if (row && row.scope) map[row.scope] = row.data || {}; });
            dpCache = map; dpStore();
            return dpCache;
          })
          .catch(function () { dpCache = dpLocal() || {}; return dpCache; });
      }, force);
    },
    get: function (scope) { return dpCache ? dpCache[scope] : null; },
    // Read-only localStorage view — safe before the client/auth resolve; never touches dpCache.
    peek: function () { return dpLocal(); },
    // Optimistic: cache + mirror written synchronously; the upsert follows (and is swallowed
    // on failure — the local copy still holds the value, like the playlists degrade path).
    set: function (scope, data) {
      dpCache = dpCache || dpLocal() || {};
      dpCache[scope] = data;
      dpStore();
      if (!client || !currentUser) return Promise.resolve();      // signed out → local only, as before
      return client.from('dyn_prefs')
        .upsert({ user_id: currentUser.id, scope: scope, data: data, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,scope' })
        .then(function (r) { if (r.error) throw r.error; dpClearDirty(scope); })
        .catch(function () { dpMarkDirty(scope); });               // retried on reconnect
    },
    // Retry anything that failed while offline. Safe to call at any time.
    flush: function () { return dpFlush(); }
  };

  /* ══ OAUTH / MAGIC-LINK FAILURE SURFACING (2026-08-17) ══════════════════════════════════════
     Until today a FAILED sign-in was completely silent. startGoogleSignIn() hands off to Google
     and the return trip is handled by supabase-js's detectSessionInUrl — which only ever looks
     for a SUCCESSFUL callback. When GoTrue redirects back with `error` / `error_description`
     instead, nothing read it, so the user landed on an ordinary LOGGED-OUT page with no message
     and no hint that anything had gone wrong.

     Measured, not theorised. On 2026-08-16 a real visitor (Chaiyaphum, arrived on a Shorts ad)
     spent 6m37s on Google's screens, came back to `400: OAuth state has expired`, saw nothing,
     and only got in because he happened to click sign-in again 10 seconds later. The owner
     reproduced it on 2026-08-17: waited ~12 min, completed sign-in, landed on the logged-out
     homepage. A less determined visitor simply leaves, and we would never know — the auth logs
     are the ONLY place this is visible, and they expire after 7 days.

     ⚠ Read the URL SYNCHRONOUSLY, here, before the supabase-js module import below resolves and
     createClient runs — detectSessionInUrl rewrites location on the success path and we must not
     race it.
     ⚠⚠ AND DO NOT WRITE THE MODULE-IMPORT EXPRESSION LITERALLY ANYWHERE ABOVE THAT LINE, not even
     in a comment. test_auth_dedupe.js stubs it with a STRING .replace(), which hits the FIRST
     occurrence only — an earlier copy in a comment silently redirects the stub and leaves the real
     dynamic import in place, so the whole file dies in the VM. Cost: 17 phantom failures, 2026-08-17.

     ⚠ NOT an auto-retry. Redirecting to Google on page load can loop, and someone who
     deliberately cancelled would be trapped in it. Show the message, offer the button.

     ⚠ The banner lives HERE rather than on each page ON PURPOSE: `redirectTo` is
     `window.location.href`, so the error can land on ANY of the ~93 topic pages or the statics.
     Per-page wiring would leave every page anyone forgot silently broken — which is this bug.
     A page wanting nicer treatment can listen for `thaiear:autherror` and call preventDefault().
     ─────────────────────────────────────────────────────────────────────────────────────────── */

  var authErr = (function readAuthError() {
    var found = null;
    function scan(s) {
      if (!s || found) return;
      try {
        var p = new URLSearchParams(String(s).replace(/^[?#]/, ''));
        var code = p.get('error_code') || p.get('error');
        if (code) found = { code: String(code), desc: p.get('error_description') || '' };
      } catch (_) {}
    }
    // PKCE puts it in the query string, the implicit flow in the fragment. Check both.
    scan(typeof location !== 'undefined' && location.search);
    scan(typeof location !== 'undefined' && location.hash);
    if (found) {
      /* Strip it so a refresh (or a shared URL) does not replay the error. Rebuilt through URL /
         URLSearchParams rather than a regex: a regex over location.search silently leaves a
         fragment-borne error in place, so the implicit flow would replay it on every reload. Only
         the three error keys are removed — any other query the page relies on survives. */
      try {
        var u = new URL(location.href);
        var KEYS = ['error', 'error_code', 'error_description'];
        KEYS.forEach(function (k) { u.searchParams.delete(k); });
        var hp = new URLSearchParams(u.hash.replace(/^#/, ''));
        var touchedHash = false;
        KEYS.forEach(function (k) { if (hp.has(k)) { hp.delete(k); touchedHash = true; } });
        if (touchedHash) { var hs = hp.toString(); u.hash = hs ? '#' + hs : ''; }
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch (_) {}
    }
    return found;
  })();

  function showAuthError(err) {
    if (!err || !document.body || document.getElementById('te-autherr')) return;

    var blob = ((err.code || '') + ' ' + (err.desc || '')).toLowerCase();
    var msg, action, label;
    if (blob.indexOf('otp') !== -1 || blob.indexOf('link') !== -1) {
      msg = 'That sign-in link has already been used or has expired.';
      label = 'Get a new link';
      action = function () { location.href = '/join.html'; };
    } else if (blob.indexOf('access_denied') !== -1 || blob.indexOf('cancel') !== -1) {
      msg = 'Sign-in was cancelled.';
      label = 'Try again';
      action = function () { startGoogleSignIn(); };
    } else {
      // The common one: `bad_oauth_state` / "OAuth state has expired" — they took too long.
      msg = 'That sign-in attempt timed out before it finished.';
      label = 'Try again';
      action = function () { startGoogleSignIn(); };
    }

    if (!document.getElementById('te-autherr-css')) {
      var st = document.createElement('style');
      st.id = 'te-autherr-css';
      /* Conventions copied from consent.js, deliberately — it is the site's other injected bar:
         a PLAIN prefers-color-scheme block (this site has no data-theme attribute), and every
         font-size through calc(… * var(--te-ui, 1)) so OS text scaling caps rather than breaks
         it (TEXT_SCALING.md). ⚠ Padding/gap stay in px on purpose: rem lengths inflate under
         Android's font-size setting and would balloon the bar.
         ⚠ No gold here — #B29234/#F0CC5C are the PREMIUM tier signal (premium-gold-palette);
         a generic auth error must not borrow them. */
      st.textContent =
        '#te-autherr{display:flex;align-items:center;gap:12px;flex-wrap:wrap;' +
        'padding:12px 16px;background:#FDF3D6;color:#4A3A0E;border-bottom:1px solid #E8D08A;' +
        'font-family:Inter,system-ui,sans-serif;font-weight:500;line-height:1.4;' +
        'font-size:calc(.9375rem * var(--te-ui, 1))}' +
        '#te-autherr p{margin:0;flex:1 1 240px;min-width:0}' +
        '#te-autherr button{font:inherit;cursor:pointer;border-radius:8px;padding:7px 14px;' +
        'border:1px solid transparent}' +
        '#te-autherr .te-ae-go{background:#1c1c1e;color:#f2f2f7}' +
        '#te-autherr .te-ae-x{background:transparent;color:inherit;opacity:.65;' +
        'font-size:calc(1.25rem * var(--te-ui, 1));line-height:1;padding:4px 8px}' +
        '@media (prefers-color-scheme:dark){' +
        '#te-autherr{background:#3A2F12;color:#F2E7C4;border-bottom-color:#5A4510}' +
        '#te-autherr .te-ae-go{background:#f2f2f7;color:#1c1c1e}}';
      document.head.appendChild(st);
    }

    var bar = document.createElement('div');
    bar.id = 'te-autherr';
    bar.setAttribute('role', 'alert');
    var p = document.createElement('p');
    p.textContent = msg + ' Nothing was saved — you are still signed out.';
    var go = document.createElement('button');
    go.className = 'te-ae-go'; go.type = 'button'; go.textContent = label;
    go.addEventListener('click', action);
    var x = document.createElement('button');
    x.className = 'te-ae-x'; x.type = 'button'; x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(p); bar.appendChild(go); bar.appendChild(x);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (authErr) {
    console.warn('[auth] sign-in returned an error:', authErr.code, authErr.desc);
    var announce = function () {
      // Let a page opt out and render its own (none do today — see the note above).
      var ev;
      try {
        ev = new CustomEvent('thaiear:autherror', { detail: authErr, cancelable: true });
      } catch (_) { ev = null; }
      if (ev && !window.dispatchEvent(ev)) return;      // a listener called preventDefault()
      showAuthError(authErr);
    };
    if (document.body) announce();
    else document.addEventListener('DOMContentLoaded', announce);
  }

  import(SUPABASE_ESM)
    .then(function (mod) {
      client = mod.createClient(SUPABASE_URL, SUPABASE_KEY);
      // getSession() fires a network token-refresh when the access token is expired, which hangs
      // ~8s offline (and navigator.onLine can't detect that in the WebView). Race it against a short
      // timer that restores the session from localStorage, so the app becomes ready fast offline.
      // Any later refresh / sign-in change still propagates via onAuthStateChange below.
      var gs = client.auth.getSession().then(
        function (res) { return (res && res.data && res.data.session) || null; },
        function () { return readStoredSession() || readIdentity(); }   // ours survives a purge
      );
      var timer = new Promise(function (resolve) {
        setTimeout(function () { resolve(readStoredSession() || readIdentity()); }, OFFLINE_FALLBACK_MS);
      });
      return Promise.race([gs, timer]);
    })
    .then(function (session) {
      // Offline (or supabase already purged its copy): fall back to OUR durable identity, so a
      // long spell without a network can never present as logged out. userFromSession reads
      // .user, which both shapes carry.
      // restoredFromIdentity is load-bearing, not bookkeeping: when we restore this way SUPABASE
      // still has no session, but our record carries an access_token — so a "do we have a token?"
      // test looks satisfied while getAccessToken() is handing /api/audio a STALE one. Gated audio
      // would then 401 on a page that looks perfectly signed in. Track it explicitly and re-seed.
      if (!session || !session.user) {
        var restored = readIdentity();
        if (restored) { session = restored; restoredFromIdentity = true; }
      }
      currentSession = session || null;
      currentUser = userFromSession(currentSession);
      if (currentSession && currentSession.access_token) writeIdentity(currentSession);
      window.ThaiEarAuth.isReady = true;
      notify();
      refreshSubscription(); // async; fires another notify when it resolves
      refreshProfile();      // marketing-consent flag
      refreshDesktopDl();    // desktop MP3 download entitlement (server-derived, not cached to disk)
      dpFlush();             // push any dyn settings changed while offline
      /* ⚠ AND THE PLAYLIST OUTBOX — on AUTH RESOLUTION, not just the 'online' event. That event
         only fires on a TRANSITION, so an app queued-offline, closed, and later reopened while
         already connected would never have replayed: the queue would sit there until the user
         happened to open a playlist surface (load() also flushes). Sync must not depend on the
         user visiting the right screen. */
      plFlush();
      // keep in sync on login / logout / token refresh
      client.auth.onAuthStateChange(function (_event, session) {
        var user = userFromSession(session);
        // Offline, supabase-js can't refresh an expired access token, so ~1h in it fires a null-session
        // change even though the user never signed out. If the persisted session is STILL on disk this
        // is that transient blip — keep the current user (so downloads + offline licence survive and the
        // nav doesn't flip to logged-out). A real signOut() purges the stored session (forceLocal), so
        // readStoredSession() returns null there and we fall through to genuine logout handling.
        // Was readStoredSession() alone — the supabase-owned key, which supabase DELETES when a
        // refresh fails on an already-expired token (see DURABLE OFFLINE IDENTITY above). Once
        // that happened the guard could not fire and the user was logged out for good. anySignedIn()
        // consults our own record first, so only a real signOut() (which clears it and sets the
        // signed-out marker) can now reach the logout path.
        if (!user && anySignedIn()) { return; }
        currentSession = session || null;
        currentUser = user;
        if (session && session.access_token) { writeIdentity(session); }
        currentProgress = null; progressLoaded = false; // re-fetch for the new (or no) user
        currentFlags = null; flagsLoaded = false;
        /* Play counts too. The localStorage record is uid-stamped and plysStore() checks it, but
           the in-memory cache is not re-read once populated, so without this the previous account's
           counters would stay on screen (and worse, plysNote() would append to them) until reload. */
        plysCache = null; plysLoaded = false; plysStats = null;
        /* ⚠ AND ANYTHING STILL IN FLIGHT FOR THE PREVIOUS USER. Without this, a request issued a
           moment before the account changed would still be the published in-flight promise, so the
           next caller would join it and receive the OLD user's rows. Dropping the slots (rather
           than cancelling — fetch has no cancel here) means the next caller starts a fresh request;
           the orphaned promise's own cleanup is identity-checked, so it cannot reclaim a slot that
           has since been reassigned. */
        clearInFlight();
        notify();
        refreshSubscription();
        refreshProfile();
        refreshDesktopDl();
        dpFlush();
      });
      /* Back online → if supabase lost its session while we were away, hand our tokens back so
         the user is silently restored instead of facing a sign-in screen. Also runs once at
         startup for the case where the app is opened online after a long offline spell. */
      /* Losing the network invalidates any live server answer we were holding. Without this,
         loading a page online and then switching on airplane mode kept subFresh true in memory,
         so the app went on believing it had a current verdict and the offline rules never ran —
         the reported "it worked once and then never again". Coming back online, re-ask. */
      window.addEventListener('offline', function () { subFresh = false; });
      window.addEventListener('online', function () {
        refreshSubscription();          // get a real answer again before anything relies on one
        if (restoredFromIdentity || !currentSession || !currentSession.access_token) reseedSession();
      });
      // And immediately, if we booted on our own record while a network is available — otherwise
      // supabase stays sessionless for the whole visit and gated audio 401s behind a signed-in UI.
      if (restoredFromIdentity && navigator.onLine) reseedSession();
      // In the native app, complete Google sign-in when the OAuth deep link returns.
      if (isNative()) {
        var AppPlugin = capPlugin('App');
        if (AppPlugin && AppPlugin.addListener) {
          AppPlugin.addListener('appUrlOpen', function (data) {
            var u = data && data.url;
            handleAuthDeepLink(u);       // Google OAuth callback
            handleCheckoutReturn(u);     // Stripe checkout return
          });
        }
      }
    })
    .catch(function (err) {
      /* ⚠ 2026-08-09 — FALL BACK TO THE DURABLE IDENTITY HERE TOO. This used to just set isReady
         and notify(), with the comment "nav stays in logged-out state" — so ANY failure to load
         supabase-js presented as a full logout on a device that was still perfectly signed in.
         That is the exact promise the success path above makes and this one broke: "a long spell
         without a network can never present as logged out."
         The common trigger was a deploy: the esm.sh bundle was runtime-cached in the version-keyed
         SW cache, so every VERSION bump wiped it and the next OFFLINE open could not import it
         (fixed separately in sw v255 with the never-swept vendor cache). But esm.sh being slow,
         blocked or down does the same thing, which is why the guard belongs here as well.
         Owner, 2026-08-09: "inexplicably i found myself logged out" on iPhone AND the Android app.
         Nothing was ever signed out — clearIdentity() only runs on a real signOut(), so the record
         was intact the whole time and the app simply could not see it.
         Safe by construction: readIdentity() returns null once the signed-out marker is set, so a
         genuine logout cannot be resurrected. restoredFromIdentity is set for the same reason the
         success path sets it — supabase has NO session here, so getAccessToken() may hand out a
         stale token and gated audio must know to re-seed rather than trust it. With client === null
         every data method already degrades to its localStorage mirror, and queued playlist writes
         stay in the outbox until a page loads with a working client. */
      console.error('ThaiEar auth failed to initialise:', err);
      var restored = readIdentity();
      if (restored && restored.user) {
        currentSession = restored;
        currentUser = userFromSession(restored);
        restoredFromIdentity = true;
        console.warn('[auth] running on the durable identity — supabase-js unavailable');
      }
      window.ThaiEarAuth.isReady = true;
      notify();
    });
})();
