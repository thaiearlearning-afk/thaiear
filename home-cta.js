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
    /* "Is this a real name or just an email prefix?" is identity.js's rule, not a second
       opinion held here. Falls back to the same comparison if it is somehow absent. */
    var I = window.ThaiEarIdentity;
    var real = I ? I.hasRealName({ email: u.email, user_metadata: { full_name: u.username } })
                 : u.username !== (u.email || '').split('@')[0];
    if (!real) return '';
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

  /* ⚠ ONE READER FOR THE WHOLE SITE — identity.js, a synchronous head script. This was a
     hand-written third copy of the same rules; see the note in identity.js for why that was a
     bad idea and what it now guarantees. */
  function guess() {
    var I = window.ThaiEarIdentity;
    if (!I) return null;
    var g = I.guess();
    if (!g) return null;
    return g.state === 'in'
      /* created_at comes across too: it is what firstVisit() reads, and this path paints the
         greeting for a whole second before auth.js answers. Without it every returning visitor
         would be greeted correctly and every brand-new one would read "Welcome back" first and
         correct itself, which is the one case the wording exists to get right. */
      ? { state: 'in', user: { username: I.usernameOf(g.user), email: g.user.email || '',
                               created_at: g.user.created_at || '' } }
      : { state: 'out' };
  }

  /* ── "Welcome" on the first day, "Welcome back" ever after ──────────────────────────
     Owner, 2026-08-22: someone who has just created their account has not been anywhere to
     come BACK from, and greeting them as though they had is the one greeting the page can get
     factually wrong.

     ⚠ THE TRIGGER IS THE ACCOUNT'S OWN AGE, NOT A FLAG WE SET. The obvious implementation is a
     localStorage marker written the first time we greet someone — and it is wrong twice: it
     says "Welcome" again on every new device they ever sign in on, and it is one more piece of
     state that can be left behind in a broken position (cleared storage, a private window) with
     no way for the page to tell. `created_at` is a fact about the account that every device
     agrees on, is already in the session object we hold, costs no round trip, and REVERTS BY
     ITSELF — there is nothing to clean up, and no state that can get stuck.

     24 hours = "your first day". Signing up and coming back after lunch is still the first
     visit in every sense the greeting cares about; coming back tomorrow morning is not.
     Anything without a usable created_at (an old account, or storage we could not parse) falls
     through to "Welcome back", which is the safe answer: it is merely unremarkable, where the
     wrong one is a small lie. */
  var FIRST_DAY_MS = 24 * 60 * 60 * 1000;
  function firstVisit(user) {
    var t = user && user.created_at ? Date.parse(user.created_at) : NaN;
    if (!t) return false;
    var age = Date.now() - t;
    /* A clock skewed into the future would otherwise read as a negative age and, being < the
       window, greet every returning user as new. Treat anything not inside the window as not
       new — including impossible values. */
    return age >= 0 && age < FIRST_DAY_MS;
  }

  function html() {
    var a = window.ThaiEarAuth;
    var user;
    if (forced) {
      user = forced === 'out' ? null
           : forced === 'named' ? { username: 'Toby Ralph', email: 'toby@example.com' }
           /* the first-signup wording, for the mock harness */
           : forced === 'new' ? { username: 'Toby Ralph', email: 'toby@example.com',
                                  created_at: new Date().toISOString() }
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
    var d = (forced && forced !== 'new') ? 8 : streakDays();
    var hello = firstVisit(user) ? 'Welcome' : 'Welcome back';
    return '<div class="cta-welcome">' + hello + (n ? ', ' + esc(n) : '') + '</div>' +
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
    /* Same task as the innerHTML above, so the ribbon is already the right shape on the
       frame the greeting first appears — there is no rectangle to see first. */
    shapeBand();
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
      /* Measured against the LINE's own box, not the block's. They are the same thing until
         shapeBand() caps the line to keep the writing out of the banner's taper — after
         which `el.clientWidth` is the wrong question, and would let a long name run into
         the diagonal and be clipped by it. */
      if (line.scrollWidth <= line.clientWidth) break;
      el.style.setProperty('--cta-fs', (px - 1) + 'px');
    }
  }

  /* ── the banner's three measurements ──────────────────────────────────────────────
     The CSS draws the ribbon; these numbers say where its shoulders are.

       --gt-drop   how far each long edge travels VERTICALLY. For a waist 35% of the band's
                   thickness that is (1 − 0.35)/2 = 0.325 of the height.
       --gt-run    how far it travels HORIZONTALLY doing it. drop/run IS the angle, and both
                   are px for that reason — a percentage resolves against the WIDTH, so the
                   shoulders would sit at a different angle on every phone.
       --gt-flat   half the width of the full-height middle: the writing, plus SHOULDER.

     ⚠ THE ANGLE ECHOES THE PAGE'S OWN DIAGONALS, at the size they take on a typical phone.
     45° and 57° were both tried first and 57° read as "far too steep" (owner, 2026-08-22).
     See SHOULDER_DEG below for why it settled on one number rather than tracking the
     divider per device — the reasoning matters more than the value.

     ⚠ CLAMPED, BECAUSE A LONG NAME WOULD OTHERWISE EAT THE BANNER. Left alone, a name wide
     enough pushes the shoulders past the screen edge, the arms disappear and the ribbon is
     a rectangle again — the shape silently degrading into the thing it replaced. So the
     middle is capped to leave both arms alive, and when that cap bites the writing is capped
     with it (--gt-textmax) and re-fitted, so it shrinks rather than getting sliced by the
     diagonal. */
  var WAIST = 0.35;          // the arms' thickness as a fraction of the band's
  var SHOULDER = 18;         // "slightly beyond where the writing is", in px
  var MIN_ARM = 0.12;        // the shortest arm worth drawing, as a fraction of the width
  /* ── THE SHOULDER ANGLE: ONE NUMBER, AND HERE IS WHY IT IS NOT MEASURED ────────────
     It was, for a while. The shoulders read the angle off `.s3`'s own rendered clip-path,
     so they were parallel to the Read Thai divider on every device — which is exactly what
     was asked for, and it is worth writing down why the answer changed.

     Shown three phones side by side, the owner picked the middle one (2026-08-22). The
     catch is that "parallel" is not one look: the diagonals run from the stage's CENTRE to
     its edges, so their angle is a function of the stage's aspect ratio, and the stage is
     whatever the nav and footer leave behind. Measured across real geometries it spans
     29° on a short 375×667 handset to 39° on a tall iPhone in the installed PWA, and 46°
     at 2× Android text. The banner therefore looked materially different phone to phone —
     the shape was consistent with the PAGE but not with ITSELF, and it is the shape people
     will remember, not its relationship to a diagonal they are not looking at.

     36° is the mid-phone divider angle — the one the owner picked — so on a typical modern
     handset the shoulders still land parallel to the page's lines. It simply stops chasing
     them onto phones where that would look like a different design.

     ⚠ SO: 36 IS NOT ARBITRARY AND IS NOT A TASTE VALUE TO NUDGE. It is the measured
     divider angle of a 390×650 stage, which is what a 390×844 phone leaves after the nav
     and footer. If the nav or footer changes height enough to move that stage, this number
     is stale — test_greet_banner.js asserts the relationship so it fails rather than drifts.
     The measured-per-device version is one line (`Math.tan(dividerDeg() …)`) and is in the
     git history at the commit before this one, if it is ever wanted back. */
  var SHOULDER_DEG = 36;
  var CORNER = 6;            // how much of each shoulder corner is curve, in px

  /* ── ROUNDED SHOULDERS ────────────────────────────────────────────────────────────────
     The sharp version read as unfinished (owner, 2026-08-22: "round out the corners so it
     just looks smoother"), and `clip-path` has no corner radius — polygon() is corners by
     definition. So the curve is sampled: each shoulder vertex is replaced by a short
     quadratic Bézier that leaves the incoming edge CORNER px early, uses the old vertex as
     its control point, and rejoins the outgoing edge CORNER px along. Five samples per
     corner is enough that no phone shows a facet, and it costs one string.

     ⚠ THE FOUR VERTICES AT THE SCREEN EDGES ARE LEFT SHARP ON PURPOSE. They are where the
     arms are cut off by the viewport, not corners of the shape — rounding them would draw
     two little tongues at the edges of the screen and turn a ribbon that runs off the page
     into a lozenge floating on it.

     ⚠ 6px, NOT 12. Both were rendered side by side and 12 was wrong — the diagonal is only
     ~34px long at a 62px band, so two 12px corners leave barely 10px of straight edge and
     the taper stops reading as a taper at all: it becomes a soft S, a different shape rather
     than the same one smoothed. 6 softens the corner and leaves the angle legible, which is
     what "round it out a bit" asked for. The 40% cap in step() is the same concern from the
     other direction, for a short greeting.

     ⚠ AND IT EMITS `calc(50% ± Npx)` FOR X AND `calc(100% − Npx)` FOR THE LOWER Y, NOT
     ABSOLUTE PIXELS. The same string clips BOTH the band and its ::before, and the ::before
     is inset 1px — so absolute coordinates would put the rim 1px out of true along the
     whole bottom and right. Percentages resolve against each box in turn, which is what
     keeps the 1px rim even the whole way round. */
  function roundedShape(w, h, flat, run, drop) {
    var EDGE = 1e9;   // marks a vertex pinned to the viewport edge rather than offset from centre
    var V = [
      [-EDGE, drop], [-(flat + run), drop], [-flat, 0],
      [flat, 0], [flat + run, drop], [EDGE, drop],
      [EDGE, h - drop], [flat + run, h - drop], [flat, h],
      [-flat, h], [-(flat + run), h - drop], [-EDGE, h - drop]
    ];
    function xy(p) {
      var x = p[0] <= -EDGE ? '0%' : p[0] >= EDGE ? '100%'
            : 'calc(50% + ' + p[0].toFixed(1) + 'px)';
      var y = p[1] > h / 2 ? 'calc(100% - ' + (h - p[1]).toFixed(1) + 'px)'
                           : p[1].toFixed(1) + 'px';
      return x + ' ' + y;
    }
    var out = [];
    for (var i = 0; i < V.length; i++) {
      var v = V[i];
      if (Math.abs(v[0]) >= EDGE) { out.push(xy(v)); continue; }
      var a = V[(i + V.length - 1) % V.length], c = V[(i + 1) % V.length];
      /* An edge-pinned neighbour is off at ±1e9; take its direction only, so the trim
         length stays governed by CORNER and the real edges rather than by that sentinel. */
      var p0 = step(v, a), p2 = step(v, c), q = [];
      for (var k = 0; k <= 4; k++) {
        var t = k / 4, m = 1 - t;
        q.push([m * m * p0[0] + 2 * m * t * v[0] + t * t * p2[0],
                m * m * p0[1] + 2 * m * t * v[1] + t * t * p2[1]]);
      }
      for (var j = 0; j < q.length; j++) out.push(xy(q[j]));
    }
    return 'polygon(' + out.join(', ') + ')';

    function step(from, to) {
      var dx = to[0] - from[0], dy = to[1] - from[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      /* Never eat more than 40% of an edge: on a very short greeting the middle is narrow,
         and two corners each claiming 12px would meet and pinch the top edge to a point. */
      var t = Math.min(CORNER, len * 0.4);
      return [from[0] + dx / len * t, from[1] + dy / len * t];
    }
  }

  /* ⚠ HOW WIDE IS THE WRITING? NOT `scrollWidth`. Both lines are full-width BLOCKS, so
     their scrollWidth is the block's width — 356 px on a 390 px phone whether the name is
     "Jo" or not. Sizing the banner's middle off that made every shoulder land in the same
     place regardless of the greeting, i.e. exactly the constant the measurement exists to
     avoid, and on a phone it pinned the middle to the clamp so the arms never appeared.
     A Range over the node's contents measures the INLINE content, which is the question
     being asked. Measured: range 171 px vs scrollWidth 356 px for "Welcome back, Toby". */
  function inkWidth(node) {
    try {
      var r = document.createRange();
      r.selectNodeContents(node);
      var w = r.getBoundingClientRect().width;
      if (w) return w;
    } catch (e) {}
    return node.scrollWidth;
  }

  function shapeBand() {
    var line = el.querySelector('.cta-welcome');
    if (!line) { el.style.removeProperty('--gt-textmax'); return; }
    var h = el.getBoundingClientRect().height;
    var w = stage.getBoundingClientRect().width;
    if (!h || !w) return;

    var drop = Math.round(h * (1 - WAIST) / 2);
    var run = Math.max(1, Math.round(drop / Math.tan(SHOULDER_DEG * Math.PI / 180)));
    var maxFlat = Math.max(40, w / 2 - run - Math.max(40, Math.round(w * MIN_ARM)));

    var textW = 0;
    var lines = el.querySelectorAll('.cta-welcome, .cta-streak');
    for (var i = 0; i < lines.length; i++) textW = Math.max(textW, inkWidth(lines[i]));

    var want = Math.ceil(textW / 2) + SHOULDER;
    var flat = Math.min(want, maxFlat);
    el.style.setProperty('--gt-drop', drop + 'px');
    el.style.setProperty('--gt-run', run + 'px');
    el.style.setProperty('--gt-flat', Math.round(flat) + 'px');
    /* Set LAST, and as a whole polygon: the three above are what the CSS fallback is built
       from, and this supersedes it with the same outline plus rounded shoulders. */
    el.style.setProperty('--gt-shape', roundedShape(w, h, Math.round(flat), run, drop));

    /* Only cap the writing when the clamp actually bit — otherwise a cap equal to the text's
       own width is a rounding error away from forcing an ellipsis onto a name that fits. */
    if (flat < want) {
      el.style.setProperty('--gt-textmax', Math.max(0, 2 * flat - 2 * SHOULDER) + 'px');
      fitName();
    } else {
      el.style.removeProperty('--gt-textmax');
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

  /* ── tap the greeting to change its colour ─────────────────────────────────────────
     Seven grounds, cycled on tap, remembered per device. ⚠ THE CHOSEN ONE IS APPLIED BEFORE
     FIRST PAINT by the inline head stamp in index.html, not here — this only handles the
     CHANGE. Doing it here as well would repaint the default and then the saved colour on every
     load, which is the flicker the owner asked to avoid.
     localStorage rather than a Supabase column, deliberately: a cosmetic per-device preference
     the user sets by tapping should work offline, cost no round trip, and not become a stored
     personal record. */
  /* ⚠ THIS LIST AND THE `T` ARRAY IN index.html's PRE-PAINT STAMP MUST MATCH. The stamp only
     honours a saved value it recognises, so a theme added here and not there would be applied
     on the tap that set it and silently fall back to sand on the next load. Both come from
     home-mock.html and gen_home_splash.js copies the stamp verbatim — so edit the MOCK. */
  var THEMES = ['sand', 'olive', 'indigo', 'yellow',   // light ground, dark text
                'purple', 'black'];                      // dark ground, LIGHT text
  el.addEventListener('click', function () {
    if (!el.classList.contains('has-welcome')) return;    // signed out: it is a link, leave it
    var root = document.documentElement;
    var now = root.getAttribute('data-gt') || 'sand';
    var next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
    root.setAttribute('data-gt', next);
    try { localStorage.setItem('thaiear_greet_theme', next); } catch (e) {}
  });

  // mock-only: the phone harness cycles the states through this.
  window.__ctaState = function (s) { forced = s; apply(); };
})();
