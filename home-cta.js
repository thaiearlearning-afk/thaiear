/* home-cta.js — the home splash's welcome / create-account block.
 * 2026-08-21.
 *
 * PHONES ONLY, AND ONLY WHEN IT GENUINELY FITS.
 * The block sits in the space under "Read Thai". On a desktop there is no such space
 * (owner: "scrap this idea for desktop"), and on a short phone there is not enough of it.
 *
 * ⚠⚠ THE FIT TEST MEASURES THE TALLEST STATE, ALWAYS — never the one about to be shown.
 * Owner's rule: if one state would not fit, NONE of them may appear. Otherwise the block
 * shows a one-line "Create a free account" today and then, the day that visitor signs in and
 * builds a streak, quietly overflows into the Read Thai label. Gating every state on the
 * tallest one means the answer cannot change under the user.
 *
 * ⚠ IT HAS TO BE MEASURED, NOT ASSUMED FROM A BREAKPOINT. Android's textZoom and iOS Dynamic
 * Type inflate the text — and every rem length with it — so a phone that fits at default text
 * does not fit at 2x. No media query can ask "is the text bigger than usual"; only a rendered
 * box can answer. That is the same reason nav.js probes a real element for --te-ui rather than
 * trusting a breakpoint (TEXT_SCALING.md section 2).
 *
 * ⚠ IT IS A SIBLING OF THE THREE REGIONS, NOT A CHILD. The bottom region is a full-page <a>,
 * so a <button> inside that space would be interactive content nested in a link — invalid, and
 * the two tap targets would fight each other.
 *
 * The stage carries `cta-fits` when the block may show. Everything visual keys off that one
 * class, including the Read Thai label's offset, so the label and the block move together and
 * cannot overlap.
 */
(function () {
  'use strict';

  var stage = document.querySelector('.tri');
  var el = document.getElementById('te-hero-cta');
  if (!stage || !el) return;

  var PHONE = '(max-width: 700px)';
  var forced = null;                  // mock-only override, see __ctaState below

  /* A first name, but ONLY when the account actually has one. auth.js falls back to the email
     prefix when Google gave no full_name — a magic-link signup — and greeting someone by the
     front of their email address is worse than not greeting them at all. */
  function firstName(u) {
    if (!u || !u.username) return '';
    var prefix = (u.email || '').split('@')[0];
    if (u.username === prefix) return '';
    return String(u.username).split(' ')[0];
  }

  /* The listening streak, from sentence_plays via /api/plays. It counts days a sentence was
     actually PLAYED, not days visited, and it is UTC-based — both are deliberate (see
     progress_streak_migration.sql). 1 is not worth announcing. */
  function streakDays() {
    try {
      var a = window.ThaiEarAuth;
      var s = a && a.getPlayStats && a.getPlayStats();
      return (s && s.streak) || 0;
    } catch (e) { return 0; }
  }

  /* ⚠ THE SAME THREE-WAY SYNCHRONOUS GUESS nav.js USES, and for the same reason. auth.js
     resolves a few hundred ms after paint, so rendering from getUser() alone meant a signed-in
     visitor saw the blue "Create a free account" button flash and then be replaced by their
     greeting (owner, on the live site). auth.js mirrors every resolved session into
     `thaiear_identity`, which holds the FULL user object — so both the ANSWER and the NAME are
     available before Supabase replies, and the first render can be the final one.
     ⚠ KEEP IN STEP WITH auth.js readIdentity()/userFromSession(), app-cta.js authGuess() and
     nav.js guessAuth(): same key, same signed-out guard, same username derivation, and the same
     reason for PARSING the supabase key rather than testing that it exists — that key survives
     sign-out with an empty session inside. */
  function guess() {
    try {
      if (localStorage.getItem('thaiear_signed_out') === '1') return { state: 'out' };
      var o = JSON.parse(localStorage.getItem('thaiear_identity') || 'null');
      if (o && o.user && o.user.id) return { state: 'in', user: userish(o.user) };
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
        try {
          var parsed = JSON.parse(localStorage.getItem(k) || 'null');
          var sess = (parsed && parsed.currentSession) ? parsed.currentSession : parsed;
          if (sess && sess.user) return { state: 'in', user: userish(sess.user) };
        } catch (_) {}
      }
      return { state: 'out' };
    } catch (_) { return null; }        // storage unavailable — genuinely unknown
  }
  function userish(u) {
    var meta = u.user_metadata || {};
    return { username: meta.full_name || meta.name || (u.email ? u.email.split('@')[0] : 'Member'),
             email: u.email || '' };
  }

  function html() {
    var a = window.ThaiEarAuth;
    var user;
    if (forced) {
      user = forced === 'out' ? null
           : forced === 'named' ? { username: 'Toby Ralph', email: 'toby@example.com' }
           /* a deliberately punishing name, so the shrink-to-fit can be judged rather than
              assumed — this is the case the owner asked about */
           /* ONE long token on purpose: firstName() takes the text up to the first space, so a
              long FULL name proves nothing — only a long FIRST name reaches the line. */
           : forced === 'long' ? { username: 'Bartholomewicz-Wolfeschlegelstein', email: 'b@example.com' }
           : { username: 'toby', email: 'toby@example.com' };
    } else if (a && a.isReady) {
      user = (a.getUser && a.getUser()) || null;        // authoritative
    } else {
      var g = guess();
      /* ⚠ UNKNOWN RENDERS NOTHING, not the button. The block is absolutely positioned, so an
         empty one costs no layout — the region simply stays plain until we know. Guessing wrong
         here is what produces the flash the owner reported. */
      if (!g) return '';
      user = g.state === 'in' ? g.user : null;
    }
    if (!user) return '<a class="cta-btn" href="join.html?next=%2F">Create a free account</a>';
    var n = firstName(user);
    var d = forced ? 8 : streakDays();
    return '<div class="cta-welcome">Welcome back' + (n ? ', ' + esc(n) : '') + '</div>' +
           (d > 1 ? '<div class="cta-streak">You’re on a ' + d + ' day streak</div>' : '');
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* The tallest the block can ever be: the welcome line PLUS a streak line. Measured from a
     real, laid-out clone rather than guessed, so it stays right when the copy or the type
     changes — and so it includes whatever the OS has done to the text size. */
  function tallestHeight() {
    var probe = el.cloneNode(false);
    probe.id = '';
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;display:block';
    probe.innerHTML = '<div class="cta-welcome">Welcome back, Wwwwwwww</div>' +
                      '<div class="cta-streak">You’re on a 88 day streak</div>';
    stage.appendChild(probe);
    var h = probe.getBoundingClientRect().height;
    var btn = el.cloneNode(false);
    btn.id = '';
    btn.style.cssText = probe.style.cssText;
    btn.innerHTML = '<a class="cta-btn" href="#">Create a free account</a>';
    stage.appendChild(btn);
    h = Math.max(h, btn.getBoundingClientRect().height);
    stage.removeChild(probe); stage.removeChild(btn);
    return h;
  }

  /* Does the tallest state fit under the Read Thai label without crowding it or the mark?
     Everything here is a measured box, so text inflation is already in the numbers. */
  var GAP = 12;          // between the label and the block
  var FLOOR = 14;        // between the block and the bottom edge
  function fits() {
    if (window.matchMedia && !window.matchMedia(PHONE).matches) return false;
    var label = stage.querySelector('.s3 .s-label');
    if (!label) return false;
    var sr = stage.getBoundingClientRect();
    if (!sr.height) return false;
    /* Measure with the block OUT of the layout, so the answer does not depend on whether it
       is currently shown — otherwise showing it makes it fit and hiding it makes it not, and
       the class oscillates. */
    var had = stage.classList.contains('cta-fits');
    stage.classList.remove('cta-fits');
    var lr = label.getBoundingClientRect();
    var mark = stage.querySelector('.medal-disc');
    var markBottom = mark ? mark.getBoundingClientRect().bottom : sr.top;
    var need = tallestHeight() + GAP + FLOOR;
    /* Space below the label, and the label itself must still clear the mark. Both matter: on a
       very short stage the label is already tight under the mark, and stealing more would push
       it into the swirl. */
    var below = sr.bottom - lr.bottom;
    var labelClear = lr.top - markBottom;
    var ok = below >= need && labelClear >= 8;
    if (had) stage.classList.add('cta-fits');
    return ok;
  }

  function apply() {
    var ok = fits();
    stage.classList.toggle('cta-fits', ok);
    if (!ok) { el.innerHTML = ''; return; }
    /* ⚠ THE LABEL'S OFFSET IS THE MEASURED HEIGHT, NOT A CONSTANT. The CSS carries a 52px
       default only so the rule is valid before this runs; at inflated text the block is half
       as tall again, and a fixed offset would let the Read Thai label sit on top of it. Set it
       from the same measurement the fit test used, so the two can never disagree. */
    stage.style.setProperty('--cta-h', Math.ceil(tallestHeight()) + 'px');
    var next = html();
    if (el.innerHTML !== next) el.innerHTML = next;   // never rewrite an identical node
    /* The gold ground belongs to the SIGNED-IN greeting only; the signed-out state is a button,
       which needs no panel behind it. Set here rather than with :has() so the CSS has no
       dependency on selector support at first paint. */
    el.classList.toggle('has-welcome', !!el.querySelector('.cta-welcome'));
    fitName();
  }

  /* ⚠ SHRINK THE GREETING UNTIL A LONG NAME FITS ITS ONE LINE — do not truncate it.
     The line is nowrap (see the CSS note), so without this a long full name would simply run
     out past the box. Stepping the size down keeps the whole name readable, which matters more
     here than a fixed type size: it is the one string on the page that belongs to the reader.
     17px is the design size and almost every name keeps it; 12px is the floor, below which it
     stops looking like a greeting. Measured against the real rendered box, so it accounts for
     the OS text scale as well as the name. */
  function fitName() {
    var line = el.querySelector('.cta-welcome');
    if (!line) return;
    el.style.removeProperty('--cta-fs');
    for (var px = 17; px > 12; px--) {
      if (line.scrollWidth <= el.clientWidth) break;
      el.style.setProperty('--cta-fs', (px - 1) + 'px');
    }
  }

  /* auth.js notifies several times during startup, and the play stats arrive after it — apply()
     is idempotent, so extra calls cost nothing and the block settles on the right state. */
  window.addEventListener('thaiear:auth', apply);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  /* nav.js's uiScale() probe sets --te-ui AFTER this runs, and the cap it applies gives chrome
     back some height — so re-measure once the page has settled rather than committing to the
     pre-probe answer. */
  if (document.readyState === 'complete') setTimeout(apply, 0);
  else window.addEventListener('load', function () { setTimeout(apply, 0); });
  apply();

  // mock-only: the phone harness cycles the states through this.
  window.__ctaState = function (s) { forced = s; apply(); };
})();
