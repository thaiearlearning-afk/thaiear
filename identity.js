/* identity.js — WHO IS THIS, SYNCHRONOUSLY, BEFORE SUPABASE ANSWERS.
 * 2026-08-21.
 *
 * ONE implementation of a question four files were answering separately.
 *
 * auth.js mirrors every resolved session into localStorage (`thaiear_identity`) — its durable
 * offline identity — so the site can know who you are before the network replies, and offline
 * indefinitely. Painting the first frame from getUser() alone means a signed-in visitor is
 * briefly treated as signed out: the nav's right-hand group jumps sideways as the username
 * lands, and the home page flashes a blue "Create a free account" button before the greeting.
 *
 * ⚠ WHY THIS IS A FILE AND NOT A FUNCTION IN auth.js. The answer has to be available with NO
 * other module loaded and NO await: nav.js mounts before auth.js has even been appended (it is
 * nav.js that appends it), so anything that has to wait for auth.js is too late by definition.
 * A ~1 KB synchronous script in the head is available to everything that follows it.
 *
 * ⚠ THE RULES BELOW ARE THE ONLY COPY. They were previously written out in app-cta.js
 * authGuess(), nav.js guessAuth() and home-cta.js guess(), which is three chances to drift on a
 * question where drift is not cosmetic — the nav painting one name while auth resolves to
 * another, or a signed-out visitor greeted by name. Those three now delegate here. auth.js keeps
 * its own readIdentity() because it is the WRITER and must not depend on load order; that pair is
 * what test_identity_readers.js checks.
 *
 * ⚠ PARSE THE SUPABASE KEY, NEVER JUST TEST THAT IT EXISTS. supabase leaves
 * `sb-<ref>-auth-token` in place after a sign-out with a null/empty session inside, so an
 * existence check answers "signed in" for someone who has signed out. That shipped once already
 * — the signed-out flash of 2026-08-15.
 */
(function () {
  'use strict';

  var ID_KEY = 'thaiear_identity';
  var SIGNED_OUT_KEY = 'thaiear_signed_out';

  /* The username auth.js's userFromSession() would produce for this user. Kept identical to it
     on purpose: whatever the nav paints before auth resolves must be what auth resolves TO, or
     the fix trades a jump for a wrong name. */
  function usernameOf(u) {
    var meta = (u && u.user_metadata) || {};
    return meta.full_name || meta.name ||
           ((u && u.email) ? u.email.split('@')[0] : 'Member');
  }

  /* Is that username a real name, or just the front of an email address? A magic-link signup
     gives Google no full_name, and greeting someone as "Welcome back, chris" off their address
     is worse than not greeting them at all. */
  function hasRealName(u) {
    if (!u) return false;
    var prefix = (u.email || '').split('@')[0];
    return usernameOf(u) !== prefix;
  }

  /* 'in' with a user, 'out', or null when storage itself is unavailable and we genuinely cannot
     tell. Callers must treat null as "do not paint either state yet" — guessing is what produced
     the flashes this file exists to remove. */
  function guess() {
    try {
      if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return { state: 'out' };

      var o = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      if (o && o.user && o.user.id) return { state: 'in', user: o.user };

      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
        try {
          var parsed = JSON.parse(localStorage.getItem(k) || 'null');
          var sess = (parsed && parsed.currentSession) ? parsed.currentSession : parsed;
          if (sess && sess.user) return { state: 'in', user: sess.user };
        } catch (_) {}
      }
      // No marker, no identity, no session: a first-time visitor really is signed out.
      return { state: 'out' };
    } catch (_) {
      return null;
    }
  }

  /* The state alone, as a string — the shape app-cta.js's authGuess() has always returned, so
     its existing callers need no change. A real answer from auth.js beats the guess. */
  function state(authState) {
    if (authState && authState !== 'pending') return authState;
    var g = guess();
    return g ? g.state : 'out';
  }

  window.ThaiEarIdentity = {
    guess: guess,
    state: state,
    usernameOf: usernameOf,
    hasRealName: hasRealName
  };
})();
