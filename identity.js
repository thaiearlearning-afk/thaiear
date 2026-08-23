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
    /* ⚠ `display_name` FIRST. It is the name the person chose on the account page, and the only
       one that survives an OAuth sign-in — `full_name` is a Google claim and is overwritten by
       every sign-in (see updateDisplayName() in auth.js). */
    return meta.display_name || meta.full_name || meta.name ||
           ((u && u.email) ? u.email.split('@')[0] : 'Member');
  }

  /* Is that username a real name, or just the front of an email address? A magic-link signup
     gives Google no full_name, and greeting someone as "Welcome back, chris" off their address
     is worse than not greeting them at all. */
  function hasRealName(u) {
    if (!u) return false;
    var prefix = (u.email || '').split('@')[0];
    /* nameParts() first so the SLIM shape is answered too (it has no user_metadata for
       usernameOf() to read); usernameOf() behind it so the raw shape answers exactly as it
       always did, 'Member' fallback included. */
    var n = nameParts(u).full || usernameOf(u);
    return !!n && n !== prefix;
  }

  /* ── WHAT DO WE CALL THIS PERSON? ──────────────────────────────────────────────────────
     TWO SHAPES REACH THIS FILE and normalising them here is the point: guess() returns the RAW
     supabase user (a `user_metadata` bag), while auth.js's userFromSession() publishes a slim
     object carrying `username` + `providerName`. Every caller used to know which one it held —
     home-cta.js literally built a fake `{user_metadata:{full_name:u.username}}` to ask a
     question — and that is the drift this file exists to stop. */
  /* The provider's own copy of the name, for callers that RESHAPE the raw user into the slim
     form (home-cta.js does, to paint before auth answers). Reading `user_metadata.name` in those
     callers would put the rule back in the files this one exists to consolidate — and a slim
     object that loses this field is indistinguishable from an edited name. */
  function providerNameOf(u) {
    var meta = (u && u.user_metadata) || {};
    return meta.name || (u && u.providerName) || '';
  }

  /* The name the person typed on the account page, if any. Same job as providerNameOf(): callers
     that reshape the raw user into the slim form must carry it, or the reshaped object cannot be
     told apart from one that was never edited. */
  function chosenNameOf(u) {
    var meta = (u && u.user_metadata) || {};
    return meta.display_name || (u && u.chosenName) || '';
  }

  function nameParts(u) {
    var meta = (u && u.user_metadata) || {};
    return {
      full: meta.display_name || meta.full_name || meta.name || (u && u.username) || '',
      /* The name the person typed. Its PRESENCE is the whole answer to "did they choose this?" —
         nothing has to be inferred from a comparison any more. */
      chosen: chosenNameOf(u),
      /* The provider's OWN copy of the name, which updateDisplayName never writes to. */
      provider: meta.name || (u && u.providerName) || '',
      email: (u && u.email) || ''
    };
  }

  /* Did this person CHOOSE their name, or is it the one Google handed us at signup?
     ⚠ NO FLAG, NO MIGRATION — the answer is already in the data. updateDisplayName() writes
     `user_metadata.full_name` and leaves `user_metadata.name` exactly as the provider set it,
     so the two fields disagreeing IS the record of an edit, retroactively and on every device.
     Measured across every live account (2026-08-23), counts only: of the Google accounts, all
     but one carried the two fields identical, and the single exception was an account whose name
     had been edited. Zero false positives.
     A magic-link signup carries no provider name at all — nine accounts had no name fields
     whatsoever — so there a full_name can only ever have been typed in. */
  function isCustomName(u) {
    var p = nameParts(u);
    if (!p.full) return false;
    /* The name is sitting in the field only this site writes. Nothing to infer. */
    if (p.chosen) return true;
    /* ⚠ LEGACY PATH, and it is all but dead. Before 2026-08-23 a chosen name went to `full_name`
       alone, and the ONLY record of an edit was that field disagreeing with the provider's `name`.
       Every such name has since been overwritten by an OAuth sign-in, so this can still fire only
       for an account that has not signed in since. Kept because it costs one line and answers
       correctly for such an account; do not build anything new on it. */
    if (p.provider) return p.full !== p.provider;
    /* No provider name at all (a magic-link signup), so a name can only have been typed. */
    return true;
  }

  /* The name to greet someone by: their FIRST name when it is the provider's, the WHOLE name
     when they chose it themselves (owner, 2026-08-23 — a chosen name cut at its first space
     loses the point of choosing it). '' when we have no real name for them, which the greeting
     treats as "no name in the message", not as "no greeting". */
  function greetingName(u) {
    if (!hasRealName(u)) return '';
    var full = nameParts(u).full;
    return isCustomName(u) ? full : String(full).split(' ')[0];
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
    providerNameOf: providerNameOf,
    chosenNameOf: chosenNameOf,
    hasRealName: hasRealName,
    isCustomName: isCustomName,
    greetingName: greetingName
  };
})();
