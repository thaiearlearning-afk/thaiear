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

  function html() {
    var a = window.ThaiEarAuth;
    var user = forced === 'out' ? null
             : forced === 'named' ? { username: 'Toby Ralph', email: 'toby@example.com' }
             : forced === 'anon' ? { username: 'toby', email: 'toby@example.com' }
             : (a && a.getUser && a.getUser());
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
