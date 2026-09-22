/* ============================================================
   sw.js — ThaiEar service worker (offline app shell + pages).
   ------------------------------------------------------------
   Makes the site (and the Capacitor app, which loads the live site)
   work offline: the HTML pages, shared JS, images and fonts are cached
   on the device, so the app can cold-start with no internet, browse the
   topic grid, and open any page that's been visited while online.

   AUDIO is deliberately NOT handled here: clips live on the separate
   origin audio.thaiear.com (out of this SW's scope) and the native app's
   download feature owns offline audio. /api/ is never cached (auth,
   audio-signing, checkout must always be live).

   Strategy, THREE paths (see the big notes in the fetch handler):
     • NAVIGATIONS and anything not precached: NETWORK-FIRST, capped by
       NET_TIMEOUT_MS. Online always gets fresh content, so the tandem-update
       model is preserved and the cache is the offline fallback.
     • TOPIC-PAGE NAVIGATIONS (2026-08-12): STALE-WHILE-REVALIDATE out of the
       version-keyed cache ONLY. They were network-first like everything else, so
       the cached copy was never used online and every topic open paid a live,
       never-edge-cached origin round trip whose latency swung from ~0.2 s to
       ~2.4 s — which is why opening a topic felt "sometimes fast, sometimes
       slow". Safe because a VERSION bump empties the topic pages out of the
       cache, so this path can never serve pre-deploy content.
     • PRECACHED SUB-RESOURCES (player.js, auth.js, topics.js, nav.js, the CSS,
       the self-hosted fonts, the icons): CACHE-FIRST. Bumping VERSION is what
       invalidates them, so revalidating per request only cost a round-trip —
       ~350 KB of it on every single page load, which is what made topic pages
       take seconds to open in the iPhone PWA and the Android app.
   The esm.sh Supabase bundle is cached cross-origin in VENDOR_CACHE.

   ⚠ Bump VERSION to invalidate old caches on deploy. With the cache-first path
   this is LOAD-BEARING, not just tidy: change a precached file without bumping
   and clients keep serving the old copy.
   ============================================================ */
const VERSION = 'v637';   // v637: the Progress quiz columns are CAPTIONED and sit on the group
                          // label's line, plus three more pages brought into the text-scaling
                          // register. ⚠ THIS IS THE OTHER HALF OF WHAT v636's MESSAGE CLAIMS:
                          // a peer's privacy-policy commit and mine interleaved on the shared
                          // index, so v636 shipped my privacy.html fix under my message with
                          // their sw note, and left these four files behind. Nothing was lost;
                          // the numbering just reads oddly.
                          // (1) Owner, 2026-09-22: "we have V L B S but we dont explain what
                          // those are ... they float a bit above the table whilst 'grammar by
                          // ear' sits flatly on it ... immediately above it a line 'Best quiz
                          // result' ... not too close to the paragraph above." The leading group
                          // label now renders in the head's own (previously empty) name slot, so
                          // label and letters are ONE line and the letters align over their
                          // columns for free. ⚠ The caption is a CHILD of the head: on a phone
                          // the letters take their own line, so a full-width caption would
                          // caption the LABEL. It re-orders -- own line on desktop, beside the
                          // label on a phone. ⚠ The per-cell `title` always named the quizzes,
                          // but a title is a HOVER and this page is mostly read on a phone.
                          // (2) terms +54px and refunds +46px of horizontal page scroll at
                          // 320px/200%, on the 19-character support address in <strong> that
                          // `overflow-wrap: normal` will not break -- the fault §7 fixed on
                          // about and account in August and never brought to the legal pages.
                          // start (the ads landing page) +8px from rem side-gutters. px gutters
                          // + break-word; no-ops at default size. Register: TEXT_SCALING.md §10.
                          // v636:   // v636: ⚖ THE PRIVACY POLICY NAMES QUIZ DATA. Owner, 2026-09-22:
                          // "we need to update the privacy policy just to state we now store
                          // people's quiz scores as a user feature ... as this is legal".
                          // The quiz arm went public today and began storing, against an
                          // account, per-quiz best scores and attempt counts, per-question
                          // seen/correct counts, quiz settings, excluded questions, and the
                          // Thai Builder's REFUSED ANSWERS (the sentence, the word order the
                          // learner built, and a timestamp). UK GDPR Art 13 requires the
                          // notice to say so, and none of it was described.
                          // ⚠ The refused-answer log is named EXPLICITLY rather than folded
                          // into 'results': it stores something the learner composed, with a
                          // time on it, which is the one item here a reader would not expect.
                          // ⚠ 'Last updated' moved to 22 September 2026 — the policy's own
                          // closing line promises that date tracks the latest version.
                          // privacy.html is PRECACHED, so without this bump returning devices
                          // would keep serving the notice that does not mention any of it.
                          //
                          // v635:   // v635: three owner reports, 2026-09-22.
                          // (1) THE DELETE PROMPT ANSWERED ITSELF on the Android app: "i hit
                          // delete, i get the are you sure message, then it reverts to
                          // 'downloaded' automatically before i get a chance to respond."
                          // ⚠⚠ IT IS v624 BITING BACK. confirmDelete() paints by innerHTML, and
                          // renderOfflineBar() re-derives on every thaiear:auth (~25/page). What
                          // used to protect the prompt was an ACCIDENT: data-dlsig still read
                          // "downloaded", so the repaint hit the idempotence guard. v624 cleared
                          // that attribute so KEEP could repaint -- correct -- and removed the
                          // only shield. One fix, two opposite faults. Now an explicit held
                          // state (offBarConfirm), like offBarLock and offBarHoldUntil beside it;
                          // released by BOTH exits, and before Keep's re-derive or the prompt
                          // becomes permanent. Proven both directions in test_offline_bar.js,
                          // which had no coverage of this path at all -- which is how it
                          // regressed into its own opposite inside a day.
                          // (2) THE DOWNLOAD LABEL IS PLAIN AGAIN: "can we revert to the old
                          // 'download for offline' - it is really big and ugly now." Reverted on
                          // BOTH surfaces, not just the playlist he named -- one button, one
                          // label, and the topic wording was the longer of the two. The download
                          // still includes the quiz data, so it under-promises now.
                          // (3) THE SIX PROGRESS BOXES ARE ONE GRID and every row is the height
                          // of the tallest: "all should take the tallest height so uniformity
                          // achieved". ⚠ Needed the two grids merged first -- `1fr` only reaches
                          // rows in its own grid -- and the split was MY mistake in v628: I wrote
                          // that six cells in two columns would sit "alongside days in a row".
                          // They do not; a grid fills in source order, so cells 5-6 are row 3.
                          // v631's 10px seam rule is deleted rather than left as a no-op.
                          // v634:   // v634: the loading ellipsis sits on the BASELINE again. Owner:
                          // "your ellipsis is high - it sits in horizontal alignment with the
                          // top of the 's' in 'playlists'".
                          // ⚠⚠ MY OWN v632 FIX CAUSED IT. Clipping the dots with an
                          // inline-block + overflow:hidden kept the centred line from
                          // reflowing -- and redefined the box's BASELINE to its bottom
                          // margin edge, which is what an inline-block with non-visible
                          // overflow does, so the whole thing floated off the line.
                          // ✅ No clipping now: three dots that are always PRESENT and merely
                          // fade. Each keeps its space so the line still cannot reflow --
                          // which was the whole point -- and with no inline-block and no
                          // overflow there is no baseline left to break. Three keyframe sets
                          // rather than one with delays, because a delayed copy wraps past
                          // the cycle end and lights the dots out of order.
                          // ⚠ v633 is a PEER SESSION's and was uncommitted when this was cut.
                          //
                          // v632:   // v632: ⛔ THE CODE v631's NOTE DESCRIBES SHIPS **HERE**, NOT THERE.
                          // v631 went out carrying that note and NONE of the files it talks
                          // about: two sessions derived v631 from v630 at the same instant,
                          // and an update-index on the SHARED index landed this blob inside a
                          // peer's commit while the quiz.js/playlists.html/ownersim.js edits
                          // stayed dirty on disk. So v631 is SPENT and its note runs one
                          // version early; this is where the loading-screen colour+motion fix
                          // and the "My results" fix actually reach a device.
                          // ⚠⚠ THE LESSON, SINCE IT HAS NOW BITTEN BOTH WAYS IN ONE DAY:
                          // `--only <path>` and `update-index` stop you including files you
                          // did not INTEND; neither protects the INDEX, which is shared. A
                          // peer staging between your stage and your commit silently swaps
                          // your blob, and `git commit` reports success either way. The check
                          // that catches it is `git show --stat HEAD` against what you staged
                          // -- the FILE COUNT and the VERSION -- run before the push, not
                          // after. CLAUDE.md already says to check the file count; the index
                          // is the reason it is not merely belt-and-braces.
                          //
                          // v631: the playlist quiz loading screen is the HOUSE NAVY and its
                          // TEXT NO LONGER MOVES, plus "My results" survives the score pull.
                          // (1) Owner: "as the ellipsis to the right of playlist animates,
                          // playlist actually slides backwards and forwards. the writing
                          // should be static in place". ⚠⚠ v630 animated the WIDTH of the
                          // ellipsis itself and the line is CENTRED, so every width change
                          // re-centred the sentence: correct dots, moving text. Now TWO
                          // boxes -- the outer <i> is a constant 3ch and is all layout ever
                          // sees, the inner span animates and its overflow clips. The
                          // movement is real but invisible to layout, which is the only way
                          // a centred line stays still. Colour #261B65, the arm's own navy.
                          // (2) Owner: "i open 'my results' then it closes and i have to
                          // open it again shortly after entering the quiz menu - seems like
                          // if things are still loading in in background". He had the cause
                          // right: syncScores() repaints the picker when the network score
                          // pull lands, openPicker() rebuilds the panel, and a dropdown
                          // opened in the second before that round trip was destroyed. It is
                          // LATCHED, so it happens exactly once -- as described. ⚠ The
                          // repaint is RIGHT; it is what puts the pulled scores on screen.
                          // What was wrong was rebuilding UI state the learner had set, so
                          // the open state is remembered rather than the repaint suppressed.
                          // ⚠ ownersim.js also changed -- "Sync now" now REPORTS its outcome
                          // (owner: "its doing nothing"); it was silent on empty outbox,
                          // offline, signed out and success alike. It is NOT precached and
                          // needs no bump; only playlists.html and quiz.js do.
                          // ⚠ v629 belongs to a peer session and is still uncommitted.
                          //
                          // v630: FOUR PLAYLIST-QUIZ FIXES, all owner-reported 2026-09-22.
                          // (1) "they are slow to load" -- the ENGINE was loaded STRICTLY
                          // AFTER the side-cars: `return loadEngine()` sat in the .then
                          // following Promise.all(loadUnit), so 164 KB of quiz.js+quiz.css
                          // did not begin downloading until the last side-car landed. It
                          // reads none of that data, so nothing required the ordering. Now
                          // parallel -- and started only once a unit is known to have data,
                          // so the no-quiz branch still spends nothing.
                          // (2) "can we have a loading screen" -- te-quiz-boot hides BOTH
                          // views, so a ?quiz= arrival showed a BLANK page for the whole
                          // wait. The message lives in the same blocking head style as the
                          // class that causes the blank (deciding later can only cover a
                          // blank already seen), and is bound to that one class, so every
                          // unhide() path removes it for free. ⚠ The animated ellipsis is
                          // WIDTH-CLIPPED in ch units, not growing text: a peer measured an
                          // animated "..." breaking over three lines at 200% text when an
                          // inherited overflow-wrap reached it (TEXT_SCALING.md §11).
                          // (3) "my results ... just says 'a playlist'" -- unitLabel() only
                          // resolved the CURRENT playlist via ctx.unitName. The playlists
                          // API has two SYNCHRONOUS readers, so every playlist can be named
                          // with no async and no re-render; peek() first because get() is
                          // empty until load() resolves and is the only one that answers
                          // offline. The generic label remains for a deleted playlist.
                          // (4) "sync error ... permission denied for table quiz_exclusions"
                          // -- a plain .upsert() is INSERT ON CONFLICT DO UPDATE and needs
                          // UPDATE, which quiz_schema.sql deliberately does not grant. The
                          // GRANT IS RIGHT: the primary key is the whole meaningful row, so
                          // the UPDATE branch could never do anything. ignoreDuplicates now
                          // matches quiz_rejections. ⚠ One failing op reports as the whole
                          // outbox failing, which is why it surfaced as a REJECTION-LOG
                          // error although that table was never at fault. NO SQL NEEDED.
                          // auth.js, quiz.js, pl-quiz.js and playlists.html are precached.
                          // ⚠ v629 is a PEER SESSION's, uncommitted at the time of writing.
                          //
                          // v628: ⭐ THE QUIZ ARM AT 200% SYSTEM TEXT, plus two headline quiz
                          // cards on Progress and uniform topic-card heights. Owner, 2026-09-22:
                          // "no mishaping or text overspilling on font size up to 200% ... on
                          // all surfaces within the quizzes, quiz menu and on the quiz results
                          // banner under the topic pills". SEVEN surfaces measured broken at
                          // 320@2.0x and now clean: the entry 2x2 (78px page side-scroll, and
                          // 78px-wide slivers once that was fixed -- it becomes the approved BAR
                          // variant above 1.35x), the picker row, the My-results table (+302px,
                          // the worst), the results percentage (+260px, and already over at
                          // 320@1x), the exclusions header, the card strip, and the Progress
                          // rows. ⛔ The results table is the ONE capped surface in the arm --
                          // it is a six-column grid, not running text. Everything else scales in
                          // full. TEXT_SCALING.md §11 is the register of what has been measured.
                          // ⚠ Also fixed a regression THIS pass introduced: `overflow-wrap:
                          // break-word` on .tq-sheet reached the animated ellipsis, whose box is
                          // `width: 0`, and broke "..." over three lines -- +45px at DEFAULT
                          // size. Caught only by the no-op check.
                          // v627: ⭐ THE QUIZ ARM IS PUBLIC. Owner, 2026-09-22: "remove owner
                          // gate and make live". QUIZ_PUBLIC in topics.js is now true, which is
                          // the ONE switch: quizGate() short-circuits on it, so every surface --
                          // the entry block, ?quiz= urls, the card strip, the playlist 'Enter
                          // quiz' row, the Progress columns -- opens together. ⛔ The owner-hash
                          // path is deliberately NOT deleted: flipping the constant back re-gates
                          // all of it in one edit.
                          // ⭐ AND THE QUIZ'S OWN ENTITLEMENT RULE LANDS WITH IT (owner, same
                          // day): an account is required to enter ANY quiz menu, and premium
                          // is required for a premium topic AND for the whole Grammar by Ear
                          // arm -- including grammar-01/02, whose AUDIO stays free. quiz.js
                          // holds none of this: player.js's quizEntitled() is the one rule,
                          // kept separate from entitledForPage() because tightening THAT
                          // would have put every free topic's audio behind a login.
                          // WHY THE BUMP: topics.js and player.js are PRECACHED and served cache-first, so
                          // without it a returning device keeps the gated copy indefinitely and
                          // the arm stays invisible to exactly the people who already use the
                          // site. The five band pages are re-generated so their STATIC cards
                          // carry the strip rather than waiting for a runtime insert.
                          // ⚠ §2.2 ENTITLEMENT IS NOT A SEPARATE SWITCH AND NEEDED NO CHANGE:
                          // the bridge was built and merely unreachable while gated. Un-gating
                          // activates it -- entitled() delegates to player.js's entitledForPage()
                          // and the gate fires in FRONT of openMenu(), before the settings
                          // screen, per the owner's 2026-09-21 decision. Asserted by
                          // test_quiz_engine.js, which is why un-gating is safe to do in one step.
                          // ⛔ ?quiz= urls are crawlable now but are NOT in sitemap.xml -- owner,
                          // 2026-09-22: "none go on the sitemap". gen_sitemap.js emits none.
                          //
                          // v626: EVERY UNIT NOW HAS QUIZ DATA — quiz-data/index.json
                          // lists all 113 (93 topic + 20 grammar), up from 27. THAT FILE
                          // IS PRECACHED AND SERVED CACHE-FIRST, so without this bump a
                          // returning device keeps the 27-unit manifest indefinitely and
                          // every playlist spanning the other 86 silently believes they
                          // have no quizzes. The unit PAGES are not precached and need no
                          // bump; this is for the manifest alone.
                          // ⚠ v625 is a PEER SESSION's (quiz.css/quiz.js text-scaling).
                          // Agreed split, not a skipped number.
                          //
                          // v624: THE "KEEP" BUTTON ON A DELETE-DOWNLOAD CONFIRM ACTUALLY
                          // BACKS OUT. It did nothing: confirmDelete() repainted the bar's
                          // innerHTML but left BOTH idempotence guards (data-dlsig and
                          // data-sig) still claiming the old state, so the repaint Keep asked
                          // for matched the stale signature and was skipped. Topic, grammar
                          // and playlist pages alike - one function, three surfaces.
                          // Also a 1px bottom-padding kicker on .pl-box-body: WebKit rounds
                          // the overflow:hidden clip to device pixels and was swallowing the
                          // first playlist's sub-pixel Delete border (iPhone PWA only).
                          // v623: THE QUIZ MENU STARTS AT THE TOP, AND THE BLOCK SITS
                          // HIGHER. Two halves. (1) The guard on the corrective scroll
                          // was being tripped by the very restore it exists to undo —
                          // WebKit's restore fires a SCROLL EVENT, so `userScrolled`
                          // went true and the 80ms pass never ran. It now needs a real
                          // gesture, plus one more pass when the mascot image lands.
                          // (2) The first child's auto top margin is dropped on phones,
                          // so the slack goes to the bottom and everything shifts up:
                          // 33px off the space above "Test yourself", measured.
                          // half cut off; the owner named the three gaps (title->Vocab
                          // Trainer, above the tiger, below it). ⚠ THE CAPS HE WAS SEEING
                          // WERE THE TOP-LEVEL 56px/34px — the 30px/10px pair that reads
                          // like the phone answer is inside @media (min-width: 480.02px),
                          // the DESKTOP block, and a 390px phone has never matched it.
                          // Measured in a 390px iframe: 29px off at a tall viewport, and
                          // nothing at a short one, where the flexible gaps had already
                          // shrunk below the cap. quiz.css IS PRECACHED, so without this
                          // bump every returning device keeps the old spacing for ever.
                          // rendering BELOW all five band tiles, ~680px down, because
                          // `.tp-bands { display: grid }` silently defeated the [hidden]
                          // attribute the JS had been setting correctly all along - the same
                          // UA-specificity trap already documented on .topic-fav[hidden] in
                          // the very same stylesheet. Plus the on-screen keyboard now closes
                          // on Enter (blur), so it stops covering the results it was pressed
                          // to reveal. topics-page.css/.js and topics.html are all precached.
                          // v620: A FINE TRIM ON THE QUIZ MENU. "My results" sat half cut
                          // off on a phone; the owner named the three gaps (title->Vocab
                          // Trainer, above the tiger, below it). 31px off in total, all in
                          // the <=481px block. quiz.css IS PRECACHED, so without this bump
                          // every returning device keeps serving the old spacing for ever.
                          // depths and took the lightest navy on every one - the deep pass in
                          // v615 had pushed several below where the artwork wanted to sit.
                          // Body fills now land within a couple of points of --accent L25.
                          // The LOGO is unchanged and stays anchored on #261B65 exactly.
                          // All 11 are precached and cache-first, so the bump is the delivery.
                          // v618: NO MORE iOS TAP FLASH IN THE NAV. Safari and the PWA paint
                          // their own -webkit-tap-highlight-color, a translucent blue-grey that
                          // is not in the palette, and nav.js was the one interactive surface
                          // never suppressing it (eight other files already did). Suppressed AND
                          // replaced with an :active in --accent-light - killing the flash alone
                          // makes a tap feel dead on a control with no hover on touch.
                          // nav.js is precached and cache-first, so the bump is what delivers it.
                          // v617: A STUCK QUIZ OUTBOX NOW SAYS WHY. Owner, 2026-09-22: 5 Thai Builder rejections sat queued and "it wont sync even though im online" -- and there was nothing to act on, because qzFlush() dropped every op's error on the floor and only counted the survivors. The first error of a flush is now kept with the op KIND that produced it (a flush carries scores, prefs, exclusions, stats and rejections together, so which-one-is-failing is half the answer) and the owner panel prints it. auth.js is precached and cache-first, hence the bump; ownersim.js is deliberately not precached, so the panel half would have arrived on its own. ⚠ THE PANEL GOT ITS OWN ESCAPER: the `esc` further down ownersim.js is scoped to the service-worker block, and calling it from the rejection block would have thrown and taken the whole panel down -- caught by reading, not by node --check, which is happy with an undefined name. v616 is spent.   // v616: THE LAST PURPLE SURFACES FOLLOW THE PALETTE. The note panels
                          // (guide, app), the reading quiz's Part B/C + "check by ear" boxes and
                          // its sign-in gate, the Read Thai play pills, and the quiz's GLOSS chips
                          // and "Play the Thai" button all move to #F6F6FD ground / #261B65 ink.
                          // ⛔ ROOT CAUSE, and it was not a colour decision: guide.html and app.html
                          // each had a NESTED `:root {` inside the outer one. Under CSS nesting that
                          // is `:root :root`, which can never match - so --lav-bg / --lav-ink were
                          // never defined and the panels had been painting from the var() FALLBACKS
                          // (#ECEBFA / #3B3488) for weeks. --gold and --radius-* were swallowed too.
                          // read.css, quiz.css, guide.html and app.html are ALL precached and served
                          // cache-first, so without this bump none of it reaches a returning device.
                          // v615: THE BRAND RASTERS GO NAVY. 11 mascots + the whole round-logo
                          // family (favicons, .ico, apple-touch, both app icons, both swirls,
                          // og-image) recoloured from the retired purple onto --accent #261B65.
                          // 17 of them are PRECACHED and served cache-first, so without this a
                          // returning device keeps the purple art indefinitely - on a visit that
                          // would otherwise show the navy CSS around it.
                          // ALSO a PRECACHE key change: khwai.jpg / sakyantelephant.jpg are now
                          // .png, rebuilt from the transparent masters (the JPEGs were a
                          // flattened copy and were speckling the background). Net -187 KB.
                          // v614: THE GRAMMAR ARM GETS ITS QUIZZES. All 20 units are wired and
                          // carry quiz data, so LIVE goes 6 -> 26 of 113. The bump is needed
                          // because quiz-data/index.json is PRECACHED: without it a device keeps
                          // the old manifest and a playlist would go on skipping every grammar
                          // unit as though it still had no data.
                          // v613: ONE bump for six changes, deliberately. I shipped four bumps
                          // in two hours and the owner felt it: the precache is 97 entries and
                          // 4.12 MB, every bump re-fetches all of it, and while install is in
                          // flight the worker has not claimed the page so navigations bypass the
                          // SW to the network. Nothing in the fetch handler changed - measured,
                          // 0 diffs - the cost was purely the release cadence. BATCH THE BUMPS.
                          // In here: the results page gains a Quiz menu button and stops saying
                          // "four" on 3-quiz units; "Back to the topic" no longer reloads the page
                          // it is already on; deleting progress now deletes the quiz records too;
                          // the homepage topics third is flat; the lavender panels take the card
                          // tint.
                          // v612: THE NAVY BRIGHTENS. #1C124E read "almost black ... too somber
                          // and funerial" against the whole site, so the accent moves to #261B65
                          // (A2.5 off a rendered ladder) and the tint to #ECEBFA (T3) -- the tint
                          // being a SEPARATE dial, because at 31% saturation it read grey however
                          // good the accent was. The six band tiles become dark FAMILIES rather
                          // than one navy, the level badges follow them, and the lavender panels
                          // stop being pinned and take the tint. Every precached file changed
                          // colour without changing its URL, so this bump is the delivery.
                          // v611: the quiz mascot (tiger.png) was the ONE mascot never precached,
                          // so the quiz menu rendered white space where it should be; and a new
                          // quiz-data/index.json lets a playlist fetch only the units that have
                          // quiz data instead of one 404 per unbuilt unit. Both owner-reported.
                          // v610: app-cta.js's hover ground was a LITERAL tint of the old accent
                          // (#E7E5FD), so the app card's border went navy on hover and its fill
                          // stayed lilac. Found by find_offpalette.py, which looks at HUE rather
                          // than at a list of remembered hexes -- a list would never have held it.
                          // app-cta.js is precached, hence the bump.
                          // v609: THE PURPLE -> NAVY RECOLOUR. --accent #4B41AD -> #1C124E in the 151
                          // files that declare it, plus the card tier tints, the one-dark quiz strip and
                          // tier pills, and the retirement of the premium GOLD skin (owner A6). Almost
                          // every precached file changed colour without changing its URL, so this bump is
                          // the whole delivery mechanism -- cache-first would otherwise serve the purple
                          // build to every returning device for ever. Register: OWNER_TASK_REGISTER.md A;
                          // what a recolour must reach: COLOR_THEME.md.
                          // v608: ⛔ THE QUIZ STRIP MOVED THE HEART AND THE DOWNLOAD MARK OFF THEIR CENTRE. Owner on the live iPhone, 2026-09-22: downloaded topics 'showing as ticks' when the topic page itself says an update is available, plus a grey tap highlight on the card. Both marks are position:absolute at top:50% OF THE CARD -- deliberately, because he asked for them 'literally just in the middle' (2026-08-22) -- so ~25px of strip below them dragged both down by ~12px, onto the strip, where the update dot read as the wrong state. 'The middle of the card' was written when the card was only content; the marks belong to the CONTENT, so the centring now excludes the strip rather than the rule being abandoned. ⚠ MEASURED, AND THE FIRST NUMBER WAS WRONG: the strip is 36.9px tall but its NEGATIVE bottom margin cancels the card's padding, so the card grows by only 24.9px -- subtracting half of 37 put both marks 6px too HIGH, an estimate wrong by less rather than a fix. Breakpoint-aware, because the padding it cancels differs; both regimes now land within 0.03px of the pre-strip baseline. Tap highlight suppressed on the card and everything in it. v607 is spent.   // v607: topic-27a (travel & places) joins the quiz arm -- 6 units of 113. 27 quiz-1 sets authored to 4.2a, 28 parity violations on the first draft and clean on the second. ⚠ THE PATTERN IN EVERY P2 VIOLATION WAS ONE INSTINCT: writing a distractor that hugs the answer's opening because it feels closer. That IS the 50% giveaway -- the learner drops the two that do not hug it. ⛔ 0-of-3 throughout here, the opposite call from topic-06's 3-of-3, and both follow from the same rule: these are long discursive sentences where P5 is the live risk, so a shared frame would become a premise every remainder has to satisfy; a numbers unit has no such premise because its remainder is a number. 27 vocab words curated from the 83 the unit owns, 16 with a literal explainer. เที่ยว and เดินทาง are glossed apart on purpose -- both are 'to travel' and would have collided as prompts, which is exactly what check_vocab_twins exists to catch. Nine transliterations added across this unit and topic-06, each COMPOSED FROM CORPUS-ATTESTED PARTS with its provenance recorded, never invented. v606 is spent.   // v606: topic-06 (numbers & times) joins the quiz arm -- 5 units of 113. Its 30 quiz-1 distractor sets were authored to 4.2a and the parity checker took two passes: 28 P2 violations on the first draft, then 6, then clean. On a numbers unit 3-of-3 shared openings is usually RIGHT rather than a compromise -- an identical frame varying only the number makes the question turn on exactly what the unit teaches, and P5's premise problem has little grip when the remainder is a number rather than a contradictable claim. The vocab list is 26 words curated from the 78 the unit owns: the arithmetic read-outs are left out as compositional, and what is kept is the Thai CLOCK SYSTEM, which no amount of number knowledge derives -- 14 of them carry a literal explainer, including the drum-beat behind thum and the night-watchman's strikes behind dtii. ALSO: the vocab-twin detector was exploding on clock times (it strips digits, so every 'a.m.'/'p.m.' headed on 'm' and topic-06 produced 15 pairwise flags between prompts nobody could confuse) -- fixed in the DETECTOR rather than with 15 waivers, because a metric that cries wolf stops being read. 15 false flags became 1 real one. Topic pages and side-cars changed. v605 is spent.   // v605: topic-17a and topic-34a go live (4 units with quizzes, was 2) -- and a REAL ANSWER-KEY FAULT found taking them there. gen_quiz_orders.js built the key over the CORPUS chips while quiz.js deals the BUILDER TRAY, and those differ on a DISCONTINUOUS chip: the corpus has one token phaw-ja...mai, the tray has two tiles. So on 17a #697 every stored order was written in tokens no tile could produce and the CANONICAL ITSELF was rejected -- the learner could not enter a correct answer at all. 26 sentences across 19 units are in that shape; 22a passed only because its discontinuous sentences have no alternatives, which is why the pilot never showed it. The key now keys off buildChipsOf(), the same precedence quiz.js uses, so the two are one vocabulary by construction. Hand-judged orders are in corpus tokens and are DROPPED on a split tray rather than translated -- where the second half of a wrapping construction lands once the material between the halves has moved is a judgement about Thai, and guessing it would put an ungrammatical string into the key marked CORRECT. ALSO: regenerating 22a applied the 2026-09-21 drop guards to it for the first time -- 8 accepted orders on #997 down to 4, the four removed being ones that dropped phom where it is a POSSESSOR (khrawpkhrua-phom, 'MY family'). quiz.js, topic pages and the side-cars changed. v604 is spent.   // v604: THREE PLAYLIST NAVIGATION FAULTS, all owner-reported 2026-09-22. (1) "when returning to the topic by hitting 'back to topic' there's also a render flash" -- goBack() compared the origin against location.pathname ALONE. On a topic page the two match and Return simply reveals the page; on a playlist the origin is /playlists?pl=<id> while pathname is /playlists, so they NEVER matched and Return reloaded the page it was already on. The flash was a full navigation. Now compared against pathname + search. (2) "when i swipe back after hitting 'enter quiz' from the playlist menu, i end up on the playlist itself. But I left from the playlist menu" -- a DOUBLE history entry: the anchor navigates (one entry) and the quiz then pushed its own (two), so back cost two swipes to undo one tap. An arrival by url now pushes nothing, because the url already IS the quiz's entry -- the one-entry rule honoured, not excepted. (3) "when i hit enter playlist from the playlist menu there can still be a bit of a flash" -- playlists.html serves two views and the LIST is the one in the markup, so a ?pl= arrival painted the list and then swapped in the player; bootPlayer() hides it one frame too late. A blocking head script now hides it pre-paint, the same cure as ?quiz=. PRE-EXISTING, not from the quiz work. quiz.js and playlists.html are precached. v603 is spent.   // v603: ⛔ v602 SHIPPED quiz.js WITH A SYNTAX ERROR AND THE WHOLE QUIZ ARM WAS DEAD. An edit left comment prose outside its block; the file threw on load, window.ThaiEarQuiz was never assigned, and every quiz surface failed at once -- no entry block on a topic page, and 'Enter quiz' on a playlist just showed the playlist (pl-quiz.js waits for the engine, could not get it, and correctly un-hid the page). ⚠⚠ EVERY HARNESS PASSED: test_quiz_engine.js is source-REGEX by design and a regex matches text inside a file no parser will accept, so 969 assertions went green on a file no browser could run. The harness modelled the source as TEXT when the one property that mattered was that it is CODE. ✅ test_live_syntax.js now parses EVERY shipped script -- 50 of them, including the inline blocks in progress.html and playlists.html, and the Pages Functions as ES modules -- and it was proven by reintroducing the exact v602 fault and watching it go red. ⛔ Run it before every /live push. quiz.js is precached, hence the bump. v602 is spent and was inert.   // v602: FOUR FAULTS THE OWNER FOUND ON THE LIVE GATED BUILD, all reported 2026-09-22. (1) "on topic pages themselves, im not seeing the quiz square at the bottom at all" -- `defer` MEANS "NOT YET": while a deferred script runs, readyState is already 'interactive', so quiz.js's `else boot()` fired at the bottom of its own file with topics.js not yet run; the gate had moved into topics.js that morning, so isOwner() found nothing and failed closed. The first boot now waits for DOMContentLoaded whenever the document is not 'complete'. (2) "quiz square not visible within playlists either" -- playlists.html injects quiz.js, so boot() ran there too, and with no opts mountButton() falls back to <main> then document.body; playlists.html has no <main>, so the block was appended to the end of the body while pl-quiz.js's correctly-placed mount then returned early on the id guard. boot() now defers to the host on playlistMode. (3) "it flashes to the playlist, before going into the quiz" and the tiger flashing -- a blocking head script sets te-quiz-boot BEFORE first paint (anything deciding after it can only cover a flash that has happened), a ?quiz= arrival skips the idle wait, and the tiger is decoded while the side-cars are still in flight. Every exit path clears the class, so the worst case is the playlist appearing late, never a blank page. (4) "the quiz bit of the topic pills actually leaves some whitespace of the topic pill underneath it" -- the phone block overrides the card padding to `14px 16px 13px` and .topic-quiz's negative margin RESTATED the desktop 0.55rem, leaving 5.2px of white; both now come from --card-px/--card-pb so the strip cannot drift from the padding again. MEASURED, not eyeballed: 5.20px on the pre-fix source, 1.00px after, and 1px is the card's own border. quiz.js, player.js, pl-quiz.js and topics-page.css are precached. v601 is spent.   // v601: OFFLINE, A PARTIALLY-DOWNLOADED PLAYLIST NO LONGER OFFERS QUESTIONS IT CANNOT PLAY. Owner, 2026-09-22: "if a playlist is partially available offline - what happens to the quiz? ... just something clean." It was 'whatever fell out': Listening dropped those sentences because their side-car was absent, while Speak still offered one whose clip could not be heard. Now eligibility drops any sentence with no local audio, so the size picker cannot build a run with silent questions in it. ONLY A PLAYLIST CAN PRODUCE ONE -- a topic downloads whole or not at all -- and it goes through player.js's existing sentNoDl(), which trusts a RECORDED fetch failure over navigator.onLine (which lies in a WebView) and returns false whenever we are online. The Builder is excluded too although it needs no audio to ask: a run assembled from "the parts of this playlist you can hear" is coherent, one where the Builder silently has more questions than Listening is not. quiz.js and player.js are precached, hence the bump. v600 is spent.   // v600: THE QUIZ ARM'S GO-LIVE BUILD, STILL OWNER-GATED (QUIZ_GO_LIVE_PLAN.md 2.3-2.10; 2.1/2.2 HELD by the owner). Nothing here is visible to a user: every quiz surface asks ThaiEarTopics.quizGate(), and `var QUIZ_PUBLIC = false` in topics.js is now the ONE switch that turns the arm on. WHY THE BUMP IS LOAD-BEARING: topics.js, topics-page.js/css, quiz.js, quiz.css, player.js, auth.js, progress.html and pl-list.js are all precached and served CACHE-FIRST, so without it every returning device keeps the old copies indefinitely -- and pl-quiz.js is a NEW precache entry that install() has never seeded (93 -> 96 entries incl. the two earlier additions). WHAT LANDS: the topic-card quiz strip (one renderer, ThaiEarTopics.quizStripHtml; decorate() inserts it, since the static band pages deliberately ship without it while gated); four quiz score columns on the Progress page, hidden behind one class; the three-quiz variant for grammar units and playlists (bars on a phone, three squares across at 700px+, with aspect-ratio AND flex-direction overridden -- a column-count change alone stacks three full-width squares); playlists get quizzes DERIVED from their own sentences at load, via per-unit quiz-data/*.json side-cars that gen_quiz_data.js writes in the same pass as the page; an 'Enter quiz' ANCHOR in the playlist pill menu (an anchor, not a button, so it cannot join setList()'s double-handler bug class); the Thai Builder's rejection log now offline-first and synced through the existing quiz outbox with a client-generated uuid PK for replay safety, plus a reader in the owner panel; and 2.2's entitlement bridge built but inert. Vocab: a multi-answer question now works at ANY size -- `need` was capped at 2 with only the first twin offered, so a third valid answer could never appear on its own question -- and two topic-34a prompts gain a QUIZ-ONLY regloss (the bchips/enq pattern) so the approved corpus is untouched. The download copy names the quiz only where that is true, and says 'playlist audio' on a playlist. v599 is spent.   // v599: topic-35d S1312 is RESTORED — Buddhism: Meditation is 10 sentences again. sentence-hints.json and topics.js are precached and cache-first, so this bump delivers them; v598 is spent. The sentence was parked on 2026-09-16 because the Andovar male talent read the first CHO-CHOE as YO-YING (pathom-CHAAN -> pathom-YAAN, the commoner word); the pickup re-record arrived 2026-09-21. ⚠ NOT a text fault — the Thai was always correct and was not edited. ✅ Restored from topic-data/_parked/topic-35d_S1312.json, which held the sentence verbatim, its page line, the voice and the exact restore sequence — nothing was re-authored. ⚠⚠ The chips used are the PEER'S UPDATED ones (ขั้นแรก split to ขั้น + แรก, 15 chips), not the committed 14-chip version: S1312 was parked during the 113-unit chip pass so the pass never saw it, and it was judged separately afterwards. ⚠ Lead-in trimmed 0.911s -> 0.194s to match its neighbours (0.203 / 0.194). TE/ET rebuilt around the existing takes with --only 0 so no Thai was re-synthesised. BOTH audio-versions stamps moved and both --check forms verified, because moving only #c reaches nobody on a legacy baseline.
                          // v556: THE THAI SCRIPT GETS A SECOND FACE -- a "Font" pill next to Reveal all / Transliteration swaps the LEARNER TEXT (pill hint, sentence, gloss-chip Thai) from looped Sarabun to loopless Noto Sans Thai, the style of signs and packaging, on all 93 topic pages, the 20 grammar units and the playlist player. Default stays looped; the choice is per device (localStorage thaiear_thaifont) and is stamped on <html> PRE-PAINT by the ssrify dir: block, so a reader who chose modern never watches the page paint looped and flip. Transliteration, English, the nav wordmark and the whole Read Thai course are deliberately untouched -- that course teaches the looped letterforms it shows. ONE new precache entry (/fonts/notosansthai-thai.woff2, 26.9 KB, one variable file for both weights). Transliteration lost its "kaw-kai -> a" icon and the row lost its duplicate sentence count on pages that have a topic-meta line: at 360px the four items come to 317 of 327px, and an icon on either pill wraps the row. Also: gen_dyncss.js moved the generated dyncss <link> block to just before </head> on 94 pages -- generator and output had drifted since identity.js was inserted after it in v405; no behaviour change, and it ends the drift.
                          // hrefs -- the app card (x2) and "Create a free account" -- were
                          // raw, so every click paid a Cloudflare Pages 308 (127-1315 ms,
                          // cf-cache-status DYNAMIC) before the target began loading. It was
                          // the one link-emitting module with no clean-URL helper. Found in a
                          // GSC coverage drilldown. app-cta.js is precached, hence the bump.
                          // v528: the Android app resumes a dyn reconstruct on the sentence
                          // it was on, instead of restarting at 0:00. The shim that stands in
                          // for <audio> inside the app kept the REPLACED track's currentTime
                          // and duration, so the resume was bounded by the old session's
                          // length, seeked the outgoing item, and then read its own write as
                          // proof it had worked. Web-only fix -- no APK change. player.js is
                          // precached, hence the bump. player.js r219.
                          // v527: about.html - the line introducing the three principles'
                          // implementation no longer opens on "ThaiEar is designed around",
                          // which repeated the "ThaiEar's design follows..." lead-in two
                          // paragraphs above it. Now "Here's how it's implemented:".
                          // about.html is PRECACHED.
                          // v526: the last "real sentences" - the homepage's Organization
                          // JSON-LD, the one copy not visible on any page and the easiest to
                          // leave behind. index.html is PRECACHED.
                          // v525: the count claim reaches the HOMEPAGE meta description, which
                          // had carried none - "2,400+ whole Thai sentences by topic". And "real
                          // sentences" becomes "whole sentences" on /topics and the five band
                          // pages, matching about.html. ⚠ Google's ad-copy autofill reads these
                          // tags, so a stale figure here comes back later as a proposed headline.
                          // index.html, topics.html and the five band pages are all PRECACHED.
                          // v524: about.html - the feature paragraph is the owner's rewrite:
                          // audio leads, the two playback directions are hyphenated
                          // (Thai-to-English), and the reading course joins on an em dash rather
                          // than a trailing clause about producing spoken Thai. Plus the closing
                          // comma the "also known as retrieval practice" appositive was missing.
                          // about.html is PRECACHED.
                          // v523: guide.html - the spaced-repetition paragraph splits after
                          // "over the course of a week or more", so the method and what it buys
                          // you are two paragraphs rather than one long one. guide.html is
                          // PRECACHED.
                          // v522: about.html - the opening claim ends at "word glosses"; the
                          // trailing "and the training of active recall" is dropped, since the
                          // techniques now have their own paragraph and a bullet of their own.
                          // "retrieval practice" bolded in that bullet. about.html is PRECACHED.
                          // v521: about.html says "whole sentences", not "real"/"complete" -
                          // body copy and the meta/og/twitter descriptions, propagated with
                          // gen_static_seo.js. guide.html drops the Thai sign-off and wordmark:
                          // with the Dynamic mp3 Player section moved to the end, a farewell
                          // underneath an interactive mock-up read as an afterthought. Its four
                          // CSS rules went with it - .signoff was the only user of .thai and
                          // .wordmark on that page. Both pages are PRECACHED.
                          // v520: guide.html - the Dynamic mp3 Player section MOVES to the end,
                          // after Spaced repetition, and its intro is replaced by two plain
                          // sentences. The old one carried three links and a lot of scaffolding
                          // in a page that is otherwise continuous prose; the owner's call is
                          // that it read as jarring, and those links live on /about anyway.
                          // about.html gains a (see Guide) after "English-first is a must", so a
                          // reader can reach the shadowing/active-recall section that explains it.
                          // Both pages are PRECACHED.
                          // v519: guide.html gains a "Shadowing and active recall" section,
                          // above Spaced repetition and below the dyn-player mock-up. It names
                          // what each playback direction actually trains and tells the reader
                          // which one to pick - Thai-first to shadow, English-first to retrieve.
                          // Owner's edit to the shadowing sentence. guide.html is PRECACHED.
                          // v518: THE CLEAN-URL SWEEP. Every remaining internal href that still
                          // said .html now goes through a pageHref()/pageLinkHref() helper or is
                          // written extensionless: the 34 hand-written links on the static pages,
                          // both generator footers, and 20 JS navigation targets across nav,
                          // player, auth, read, pl-list and home-cta. Each one was an uncached
                          // 308 at the origin (127-1315 ms) landing BEFORE the worker starts, so
                          // Navigation Preload could not cover it. Precached and changed: index,
                          // about, guide, account, join, privacy, refunds, subscribe, terms,
                          // deleted, topics + the five band pages, nav.js, player.js, auth.js,
                          // pl-list.js, home-cta.js, read.js.
                          // ⛔ sw.js's OWN .html strings are cache keys, not links - leave them.
                          // Also in v518: footer.js routes its links through the same helper
                          // (it is on nearly every page, so it was the most-served copy of
                          // the slow form); the Grammar hub says "20 topics" not
                          // "20 topics · 185 sentences"; and .tp-intro lost its 62ch cap,
                          // which on a 3-column desktop grid stopped the explainer two
                          // columns short and read as a layout fault. topics-page.css,
                          // footer.js and grammar.html are all PRECACHED.
                          // v517: about.html - the listening-resources paragraph splits in two,
                          // and the two playback directions are now named for the techniques they
                          // are: Thai-first is shadowing, English-first is active recall /
                          // retrieval practice. Owner's wording. about.html is PRECACHED.
                          // v516: the Read Thai link in guide.html's blue box is underlined.
                          // The base rule is `a { text-decoration: none }` and the link is bold
                          // on the accent-tinted background, so colour alone was carrying "this
                          // is a link" and was not carrying it. guide.html is PRECACHED.
                          // v515: about.html loses the "ThaiEar works best once you can already
                          // read Thai script" paragraph (owner) - Read Thai is already on the
                          // home splash and named at the top of the guide, and the paragraph
                          // gated the site on a skill transliterations removed the need for.
                          // about.html is PRECACHED. The 48 topic-page gloss fixes in the same
                          // commit are NOT precached and need no bump of their own.
                          // v514: guide.html opening line - ThaiEar takes complete beginners and
                          // experienced learners alike to an advanced level of speaking AND
                          // listening. The old line promised only an intermediate level and
                          // required the reader to know the Thai script already, which stopped
                          // being true when transliterations shipped. guide.html is PRECACHED.
                          // v513: progress.html changed and IS PRECACHED - the Playlists heading
                          // is now the same .prog-band as every other group, in the one list.
                          // Shipped a few minutes behind v512 because the gloss/heading fix went
                          // out without this bump: grammar-*.html are not precached and the eye
                          // stopped there, but progress.html is. Cache-first would have served
                          // every returning device the old page indefinitely.
                          // v512: GRAMMAR BY EAR IS PUBLIC. The hidden-section scaffolding is
                          // gone: grammar-hub.js (the owner-gated card injected after an async
                          // SHA-256 check) is DELETED, the tile and three headings on /topics are
                          // static HTML, a Grammar pill joined the tab row on all six band pages,
                          // and the 21 grammar pages lost their noindex. The Progress page now
                          // lists the 20 units above the topics. Precached and changed:
                          // topics.html, all five band pages, topics-favourites.html,
                          // topics-page.css, topics-page.js, progress.html, index.html — and
                          // /grammar.html is precached for the first time.
                          // v511: a long unit name no longer runs under the favourites
                          // heart. .topic-name and .topic-meta-row shared one 22px gutter
                          // and only the meta-row got the te-dl widening, so on a
                          // download-capable device the name reserved 22px while the heart
                          // sat at 43-61px. Measured: 2/20 cards collided at normal size,
                          // 3/20 at 200% text, te-dl only. topics-page.css is PRECACHED.
                          // v510: the stadium sentence comes out of Dai (it was ordinary
                          // ability dai; the 'up to' reading came from the number beside it),
                          // so 186 -> 185 and Dai holds 14. topics.js, sentence-hints.json,
                          // topic-sentences.json and clip-durations.json all changed and are
                          // ALL PRECACHED.
                          // v509: Grammar by Ear 187 -> 186. The Maa unit was thinned (three
                          // duration examples down to one, two come-from down to one) and gains
                          // four BORROWED sentences from the topic corpus; Dai gains one and
                          // loses the dai-yin one, which is a fossilised word rather than the
                          // pattern. A borrowed copy gets its OWN global number (#2600-2604)
                          // because play counts key on that number ALONE. topics.js,
                          // sentence-hints.json, topic-sentences.json and clip-durations.json
                          // all changed and are ALL PRECACHED.
                          // v508: Grammar by Ear 16 units/157 -> 20/187. Three new units
                          // (Loei, Bpai, Thuuk & doon) plus G15 rebuilt as the five-ender
                          // question unit, so id 15 reclaims its own gap. The hub also gains
                          // a one-line explainer, the only listing page with one. topics.js,
                          // topics-page.css, sentence-hints.json, topic-sentences.json and
                          // clip-durations.json all changed and are ALL PRECACHED.
                          // v507: Grammar by Ear 18 units/174 sentences -> 16/157. Units 15
                          // (Rue bplao & chai mai) and 16 (Nawy & lawk) dropped as vocabulary
                          // rather than structure; 5 example sentences trimmed; the three
                          // khuen-maa sentences moved from unit 2 into 19, which is why three
                          // clips changed bucket. topics.js, sentence-hints.json,
                          // topic-sentences.json and clip-durations.json all changed and are
                          // ALL PRECACHED, which is why this bump exists.
                          // v506: a Favourites pill leads the sliding band row, and the
                          // Favourites TILE loses its heart (owner: "a bit garish"). The
                          // row is now built by ONE tabRow() shared by bandPage and
                          // favPage -- it was two separate maps, neither carrying a
                          // Favourites pill, so the tile led somewhere the row could not
                          // get you back from. topics.html, all five band pages,
                          // topics-favourites.html and topics-page.css are ALL PRECACHED,
                          // which is why this bump exists.
                          // v505: the Grammar arm drops "Serial verbs" -- 19 units to 18.
                          // Serialisation is how Thai works rather than a structure you can
                          // drill, and it is already everywhere in the topic corpus. Only
                          // the two เผลอ sentences moved (to the ดัน/อุตส่าห์ unit, which is
                          // pre-verb attitude words); the other 13 are parked.
                          // sentence-hints.json, topic-sentences.json and clip-durations.json
                          // all shrank -- all three PRECACHED, so without this bump
                          // cache-first keeps serving lookups that still name grammar-08.
                          // v504: the PLAYLISTS loop gets the offline settings-revert too. Two
                          // guards at the top of dynEnsureMainSrc ask whether THIS PAGE's own
                          // playlist has anything playable, and fired before the adopted branch
                          // could run -- so on a playlist page they answered about a playlist
                          // nobody was listening to. They stand down while adopted.
                          // player.js is precached, hence the bump.
                          // v503:   // v503: Grammar by Ear drops 10 more sentences -- an over-example
                          // trim, not a content change. sentence-hints.json,
                          // topic-sentences.json and clip-durations.json all shrank and
                          // all three are PRECACHED, so without this bump cache-first
                          // keeps serving lookups that still name the removed clips.
                          // v502: changing a dyn setting on an ADOPTED unit, offline, had no
                          // fallback -- r18e's revert lives in the local session path and the
                          // adopted branch never had one, so a rebuild that cannot run left the
                          // listener with nothing while a playable session sat in the cache.
                          // player.js is precached, hence the bump.
                          // v501:   // v501: the sign-in fields stop zooming on iPhone. .login-input is
                          // 14px on join.html and account.html, so the EMAIL and CODE boxes
                          // force-zoomed on every tap -- on the signup funnel, which costs more
                          // than a search box. account.html already had an input.no-zoom rule but
                          // it only ever covered #dispname-input.
                          // ⚠ Typed as input.login-input, not a bare class: a bare one TIES with
                          // the base rule and wins only on source order. account.html's own
                          // no-zoom comment records that this was measured, not assumed.
                          // ⛔ Never user-scalable=no -- that kills pinch-zoom sitewide to fix one
                          // field. test_login_code_box.js now asserts all three.
                          // join.html and account.html are precached.
                          // v500:   // v500: the iPhone search-field zoom, ACTUALLY fixed. v496 claimed
                          // this and did not deliver: it set 16px on .topic-search, a class the
                          // search input does not carry. The element is <input id="tp-q"> with no
                          // class at all, styled by #tp-q at 14px -- and an ID beats a class
                          // anyway. .topic-search survives only on app-offline-mock.html, so the
                          // rule read correctly and matched nothing. Caught only because the owner
                          // reported the zoom a second time.
                          // ⚠ A RULE THAT EXISTS IS NOT A RULE THAT APPLIES -- the same miss as
                          // .topic-fav[hidden] earlier today, twice in one day. Check the selector
                          // matches the real node (getComputedStyle on it), not just that the rule
                          // is in the file. topics-page.css is precached.
                          // v499:   // v499: two offline dyn-chain faults. The foreground walk skipped
                          // nothing, so offline it hopped onto a unit with no clips and no
                          // session and stalled; and a FAILED forward navigation (the offline
                          // notice for an uncached page) dropped the adoption on the way back,
                          // because r214 could not tell it from a real one. Both hit all four
                          // loops. player.js is precached, hence the bump. Its OWN bump: v497
                          // is deployed and v498 is claimed by a change still in the tree.
                          // v498: Grammar by Ear is 19 units, not 20. "But & however" was
                          // merged into the concession unit -- its three exx of a plain
                          // but+gaw against one each for everything else -- so
                          // sentence-hints.json, topic-sentences.json and
                          // clip-durations.json all shrank by two sentences and one page.
                          // All three are PRECACHED; without the bump, cache-first keeps
                          // serving lookups that still name grammar-11.
                          // v497: FAVOURITES IS ITS OWN NAVIGATION CIRCUIT. A topic opened from
                          // the Favourites view walks the favourites list with prev/next -- both
                          // arms in view order, wrapping at each end into one circle -- so a
                          // listener can just play their favourites. Offline it narrows to the
                          // units that can actually play, which nextAccessible() already did.
                          // ⚠ ALSO FIXES A LIVE FAULT: player.js derived its dyn chain from a bare
                          // liveSequence(), which defaults to the TOPICS array, while its
                          // pageUnit() guard is section-aware -- so a grammar page passed the
                          // guard and was handed the topic list, dynHomeIdx fell back to 0, and
                          // prev/next on a grammar unit walked into Greetings with the lock-screen
                          // title to match. Live since the structures arm landed. One resolver,
                          // ThaiEarTopics.sequenceFor(), now answers for both the buttons and the
                          // chain, so they cannot disagree.
                          // topics.js, topics-fav.js and player.js are precached.
                          // v496:   // v496: two faults in the favourites heart, both reported by the owner.
                          // (1) IT WAS VISIBLE SIGNED OUT. The markup shipped it hidden, but
                          // .topic-fav sets display:inline-flex and the UA rule [hidden]{display:none}
                          // has the SAME specificity -- an author sheet wins ties, so the attribute
                          // was inert on desktop and mobile web. Favourites are account-backed, so
                          // that was a control nobody signed out could use. .topic-fav[hidden] now
                          // states it explicitly.
                          // (2) IT RESERVED A GUTTER FOR A TICK THAT CANNOT EXIST. Download UI is
                          // app + installed-PWA only, so a plain browser tab was holding 43px at
                          // the card edge for a mark that never appears. The heart now takes the
                          // tick's own slot there, and only shifts left on devices that can
                          // download -- decided ONCE PER PAGE by a te-dl stamp in the head before
                          // first paint, never per card, because a per-card rule would move every
                          // heart the moment the download manifest resolved.
                          // topics-page.css and all seven generated pages changed; precached.
                          // v495:   // v495: the Favourites view keeps its decoration. It rebuilt itself on
                          // EVERY thaiear:auth (~25 per page) and topics-page.js decorates first,
                          // so the listening caption was thrown away microseconds after it landed
                          // and the download tick — which arrives later, with the manifest — never
                          // survived at all. Now it rebuilds only when the favourites set really
                          // changed, and asks topics-page.js (new ThaiEarTopicsPage.decorate) for
                          // the tick/pill/caption rather than re-implementing them, so a
                          // favourites card is byte-identical to a band card. topics-fav.js and
                          // topics-page.js are precached.
                          // ⚠ v494 was SPENT: committed locally (ac3c6b8) and not yet pushed, so
                          // origin still read v493 while disk read v494. On a shared tree the
                          // authority is max(origin, local HEAD) — origin alone would have had me
                          // take v494 twice.
                          // v494:   // v494: the Grammar by Ear arm reaches the activity tracker.
                          // topic-sentences.json (93 -> 113 pages) and clip-durations.json
                          // (2271 -> 2470 clips) now cover its 199 sentences. Both are
                          // PRECACHED, and both feed listenCaptionFor() -- without them a
                          // grammar unit resolved to no sentence numbers and its "Thai
                          // listening time" caption returned '' and never rendered. Silent,
                          // like the Progress page reading 0 min for five days.
                          // v493: Favourites covers the Grammar by Ear arm, and a restored page
                          // no longer paints a stale list. The heart is on the 20 grammar cards,
                          // and topics-fav.js now walks BOTH arrays — a favourited grammar unit
                          // was being dropped by the unknown-page rule and vanishing silently.
                          // Grammar gets its own group pinned above the difficulty bands (every
                          // structure unit is li1, so merging would scatter them through
                          // Lower-intermediate interleaved with topics).
                          // ⚠ Also the iOS back-swipe fix: a bfcache restore re-runs no script,
                          // so the tile count stayed frozen at whatever it last painted. pageshow
                          // (persisted) and visibilitychange now resync from the localStorage
                          // mirror BEFORE repainting — repainting alone would re-render the same
                          // stale in-memory cache. topics-fav.js and auth.js are precached.
                          // Derived from `git log origin/main -1 -- sw.js` (v492), not the disk
                          // constant.
                          // v492:   // v492: the offline-staleness stamp gains a SECOND scheme. The map
                          // now carries a clip-derived "<Prefix>#c" alongside the legacy
                          // combined-file "<Prefix>", and the three readers prefer it while
                          // refusing to read a SCHEME change as an audio change. Inert until
                          // the keys are published -- no #c key exists yet. player.js,
                          // topics.js, topics-page.js and pl-list.js are all precached.
                          // v491: sentence-hints.json now covers the Grammar by Ear arm.
                          // gen_sentence_hints.js filtered /^topic-/ only, so every structure
                          // sentence saved to a playlist would have fallen back to a derived
                          // Thai pill -- silent, not an error. The hints file is PRECACHED,
                          // which is why this bump exists: without it, cache-first (v292)
                          // means clients keep serving the old copy indefinitely.
                          // v490: FAVOURITES. A heart on every topic card, and /topics-favourites
                          // — the favourited units grouped by band, in grid order. New precache
                          // entries: /topics-favourites.html and /topics-fav.js (the latter paints
                          // hearts on EVERY band page, so an un-precached copy would leave every
                          // card's heart missing offline while the rest of the card looked fine).
                          // topics.js, topics-page.css/js and all six band pages changed too — the
                          // topic card is now a <div> wrapper with a stretched inner link so the
                          // heart can be a real <button> rather than interactive content nested
                          // inside an anchor. All precached, hence the bump.
                          // Derived from `git log origin/main -1 -- sw.js` (v489 deployed), not
                          // from the constant on disk — a shared tree makes those different
                          // questions, which is how v483 shipped to nobody earlier today.
                          // v489: a settings change made while the dyn player is on a
                          // NEIGHBOUR now rebuilds that neighbour, under its own namespace and
                          // at the new settings -- it used to ask every question about the
                          // page you were standing on, hand back the session built moments
                          // earlier at the old settings, and leave 'Re-constructing dynamic
                          // mp3' on screen for ever. player.js is precached, hence the bump.
                          // Its OWN bump: v487 is deployed and v488 is claimed by another
                          // change still in the tree.
                          // v488: sentence-hints.json now covers the Grammar by Ear arm
                          // (gen_sentence_hints.js read /^topic-/ only, so every structure
                          // sentence saved to a playlist would have fallen back to a derived
                          // Thai pill -- silent, not an error). The hints file is PRECACHED,
                          // which is the whole reason this bump exists: without it clients
                          // keep serving the old copy indefinitely (cache-first, sw v292).
                          // v487: a dyn unit OWNS its settings, and the session built for a
                          // neighbour is now stored where that neighbour's own page looks for
                          // it -- a topic page namespaces on its PREFIX, not on the bare page
                          // id the chain synthesises, so every adopt-path lookup had been
                          // reading and writing a namespace nobody uses. Also: a bfcache
                          // restore no longer resumes the topic you navigated away to.
                          // player.js is precached, hence the bump.
                          // v486: a foreground prev/next hop now BUILDS the neighbour
                          // instead of playing its prefab combined track, so the hop honours
                          // the listener's dyn settings the way opening the page does. The
                          // prefab survives for LOCK-SCREEN hops, which cannot build.
                          // Topic 1 also gains its audio-versions.json stamp (93/93).
                          // player.js is precached, hence the bump. Its OWN bump, because
                          // v485 is already deployed and a deployed version is SPENT.
                          // v485: DELIVERS the length re-order, which shipped under v484 and so
                          // reached nobody. v484 was already PUSHED (82bc2af, the dyn offline fix)
                          // before the re-order commit landed, so devices had already installed it
                          // and cached the OLD topics.js + band pages under `thaiear-v484`. The
                          // re-order then changed those precached files WITHOUT a version change --
                          // and precached sub-resources are cache-first, so there was nothing to
                          // trigger a reinstall and every returning client kept serving the old
                          // grid indefinitely. Origin was correct throughout; only the cache was
                          // stale. ⚠ THE RULE THIS BROKE: "one bump can cover two changes" holds
                          // ONLY while neither has been pushed. Once a version is DEPLOYED it is
                          // spent -- a later change to any precached file needs its own bump, even
                          // if the constant on disk already looks higher than what you started
                          // from. Check `git log origin/main` for the version, not just the file.
                          // v484: prev/next on a dyn page works OFFLINE. The adopt path
                          // resolved its source with buildUrl() directly -- always a remote
                          // audio.thaiear.com URL, never the downloaded copy -- and a dyn
                          // download deletes the combined track anyway, so a downloaded
                          // neighbour could only ever be built from its clips, which topics
                          // were not allowed to do. player.js is precached, hence the bump.
                          // v483: the 93 units are re-ordered by mean Thai sentence length, both
                          // WITHIN each band and ACROSS them -- 24 units changed band, so 22 cards
                          // moved to a different band PAGE. Free units are still pinned to the top
                          // of their band; Idioms + Tongue twisters are pinned to the END of
                          // Beginner (character count is an inverted difficulty proxy for those
                          // two). topics.js and all six band pages are precached, hence the bump.
                          // v482: Read Thai results -- "Clear my reading progress" is red
                          // again (its rules sat ABOVE .rd-ghost-pill and lost the cascade, so
                          // the button had been rendering as a plain grey ghost pill), and its
                          // confirm is now the site's own modal instead of window.confirm.
                          // read.css + read.js are precached, hence the bump.
                          // v481: replaying a sentence block credits the repetitions you
                          // actually heard again -- the play count was a running max capped
                          // at the repeat setting for the whole VISIT to a block, so back-to-
                          // start (and the loop button) could not push it past that ceiling.
                          // player.js is precached, hence the bump.
                          // v480: a download's first tap survives the auth storm -- renderOfflineBar
                          // re-derives from what is ON DISK and runs on every thaiear:auth (~25 per
                          // page), so it painted "Download for offline" over the progress line of a
                          // download that had just started, on topic pages AND playlists alike.
                          // player.js is precached, hence the bump.
                          // v479: Read Thai results page -- "Clear my reading progress" is red
                          // again (its rules sat above .rd-ghost-pill and lost the cascade), and
                          // its confirm is now the site's own modal, not window.confirm.
                          // read.css + read.js are precached, hence the bump.   // v469: the first individual-sentence tap -- the idle prewarm now
                          // re-arms on thaiear:auth instead of polling every 6s for a token, and a
                          // HEAD pass warms the first 4 clips with no idle wait. Measured before:
                          // first clip not in memory until ~5.0s (topic-08) / ~9.4s (topic-06).   // v468: progress page topic rows show real listening time -- the
                          // sentence-numbers lookup was asked for once, before topics.js
                          // had loaded, so it was never fetched (progress.html)
                          // v467: dyn settings no longer revert -- the account sync must not
                          // clobber a local change that has not been pushed yet (player.js)
                          // v466: playlist tick/update dot sized like a topic card's (pl-list.js)
                          // v465: dyn auto-rebuild must start inside the gesture (double-tap fix)
                          // v454: repeat loops before the end, so a locked screen no longer stops it
                          // before scanning localStorage, and reconciles from identity.js on load if
                          // the `thaiear:auth` event never arrives. Both writes it makes -- the signup
                          // attribution AND the retention ping -- hung off one event plus one storage
                          // read, and two accounts recorded NEITHER. attrib.js is precached, so this
                          // bump is what delivers it. Previous:
                          // v451: the chosen display name moves to profiles, a table the provider cannot touch
                          // (scopedMatch), and nothing upstream of activate()'s sweep can
                          // cost it or the claim. Previous:
                          // v449: terms.html rewritten to match the live access model (audio needs
                          // an account on every tier; the member tier is gone; downloads are
                          // permitted, not forbidden). terms.html is precached, so this bump is
                          // what delivers it.
                          // v448: a chosen display name survives an OAuth sign-in
                          // v446: an edited display name is greeted in full, not cut at the first space
                          // operator are no longer collected, and privacy.html says so.
                          // privacy.html is precached, so this bump is what delivers it.
                          // sentence of a page load and every 30s after, not every 5
                          // minutes. A tally inside the window lives only in memory, so
                          // the window was the amount of listening a bad exit destroys.
                          // attrib.js is precached, so this bump is what delivers it.
                          // 900 ms after sign-in and was cancelling it -- plus the missed
                          // email-typo shapes in all three copies of DOMAIN_TYPOS.
                          // attrib.js is precached, so this bump is what delivers it.
                          // v376:   // v376: attrib.js gains fromUrl() -- the consent-free gclid capture --
                          // and functions/api/attrib.js strips click fields for UK/EEA/CH.
                          // ⚠ privacy.html changed in the SAME release and is PRECACHED, so
                          // this bump is what delivers the new policy wording; without it
                          // returning visitors keep reading the old one. attrib.js is
                          // precached too. Previous note below.
                          // v375: player.js — the individual-sentence play button. A tap that
                          // switched away from a clip in its last ~0.3 s was killed by that
                          // clip's own queued `pause`/`timeupdate`, which reset the button that
                          // had just been lit; the src promise then bailed silently. Topic pages
                          // AND playlists. player.js is precached and cache-first, so without
                          // this bump the fix reaches nobody. Previous note below.
                          // v374: comment-only — GDPR redaction. account.html / join.html /
                          // sw.js described the mistyped-domain guard using the two REAL
                          // addresses it was built from; one carried a family surname. They
                          // now describe the SHAPE of each typo instead, which is what the
                          // guard actually keys on. Standing rule: CLAUDE.md golden rule 0.
                          // v373: comment-only in gtag.js — records that the tag, the GA4
                          // property and the conversion labels are DORMANT, not dead, while
                          // consent.js BANNER_OFF is true, so none of it gets pruned. Also
                          // removes a stale "NOT WIRED UP YET" warning that had been wrong
                          // since v299. Bumped because gtag.js is precached and cache-first.
                          // v372: the cookie banner is suppressed site-wide — consent.js
                          // `BANNER_OFF = true`. Nothing relied on the tag any more (Search
                          // lands on /start, which carries no tag; the video campaigns are
                          // paused), so it was noise in front of every visitor. It suppresses
                          // the ASK only: a new visitor never grants, so nothing non-essential
                          // is written; an earlier accepter keeps the consent they gave.
                          // ⚠ consent.js is PRECACHED and cache-first, so the bump is what
                          // actually delivers this to returning visitors.
                          // v371: confirm.html now sends a magic-link sign-in to the HOME page
                          // instead of /account. Nothing in the codebase passes `next`, so that
                          // default WAS the behaviour, and it dropped people into a small grey
                          // panel with no obvious way out. ⚠ THE BUMP IS LOAD-BEARING, NOT TIDY:
                          // confirm.html is PRECACHED and cache-first, so without it every
                          // returning visitor keeps the old /account copy indefinitely.
                          // (New page /start.html is deliberately NOT precached — ads-only,
                          // noindex, one visit per person.)
                          // v370: privacy.html §1 now says "how many times you have listened to a
                          // sentence" rather than "how many sentences you have listened to in
                          // total". Since v368 `listens` counts REPETITIONS, so ten sentences at
                          // four repeats reads 40 — the old wording implied 10. The privacy
                          // character is identical either way (one integer, no sentence identity,
                          // nothing extra stored) but a notice should be exact about what it
                          // describes. ROPA row 8 and LIA B carry the same wording. privacy.html
                          // is precached and cache-first, so this bump is what delivers it.
                          // v369: terms.html no longer promises "sentence flagging" — the
                          // feature was retired in r196 and the page still listed it as something
                          // a free account enables. terms.html is precached, so this bump is what
                          // delivers the correction. Everything else in this pass is comments and
                          // documentation: the streak migration's header overstated the law (it
                          // said showing an LI-based field would be unlawful — it would not;
                          // transparency strengthens a balancing test, and the DECIDING reason was
                          // always that days_active counts page loads and is simply the wrong
                          // number), a wrong cross-reference, and the `listens` invariant note,
                          // which holds for INCREMENTS and not for absolute totals (live: 122
                          // against a sum of 71, because listens predates v357). v368: TWO COUNTERS, because "a play" was doing two jobs that want
                          // opposite answers. PASSES (`counts`) = one trip through a sentence,
                          // whatever the repeat setting — this is what the pill shows and what the
                          // topic/playlist MINIMUM rolls up, and that roll-up only means "complete
                          // listens" if a playback preference cannot inflate it. REPETITIONS
                          // (`reps`) = how many times the Thai was actually heard — this is what
                          // "sentences listened to" and "Thai listening time" mean, and hearing
                          // something four times is four listens.
                          // They ride in ONE batch under one id, so they cannot drift; the repeat
                          // count comes from the SESSION'S OWN KEY, not the live slider, because a
                          // session built at 4 keeps playing 4 after the slider moves.
                          // user_activity.listens takes the repetitions too, so it stays the sum of
                          // sentence_plays.reps by construction.
                          // Also: Progress page gains a Playlists section under the topics —
                          // listed even at ZERO, which the retired page did not do (a playlist only
                          // appeared once it carried a manual tick). Menu label is "Progress".
                          // v367: the Progress page's time figure is COMPACT — "10 min",
                          // "2h 5min", "1d 3h 6min" — so it sits in the same square as the other
                          // three instead of spanning the row. The spelled-out "0 days, 0 hours,
                          // 10 minutes" read the same every time, which was the point of it, but
                          // it was three times the width and a zero unit carries no information.
                          // Explanation dropped with it; the card is now just "Thai listening
                          // time". v366: restore .page-wrap on progress.html. The page was assembled by
                          // slicing the archived one's <head>, and the slice stopped ONE LINE
                          // SHORT of the rule that gives the site its 640px centred column — so it
                          // shipped rendering flush to the viewport edge. Nothing was missing from
                          // the DOM and every test passed; it simply had no width. Caught by
                          // looking at the live page. test_progress_page.js now pins the column,
                          // the centring and the body palette, so the next assembly slip fails a
                          // test instead of a screenshot. v365: THE PROGRESS PAGE IS BACK, as a read-only report. The one
                          // retired earlier today asked the user to tap "+ Add progress" and
                          // self-report; this one only shows what was measured. Sentences listened
                          // to, time (a FLOOR — it counts the Thai itself, not the pauses, the
                          // English or the repeats), days listened, current and best streak, and
                          // every topic with its Plays: N.
                          // ⚠ In the MAIN menu, not the person icon — that dropdown was collapsed
                          // to a direct link today precisely because it had one item left.
                          // ⚠ Signed out is a FIRST-CLASS STATE: every figure reads 0 and the
                          // heading invites signup. A stranger seeing the shape of the feature is
                          // most of the reason to show it.
                          // ⚠ /progress is NOT in _redirects — it was retired and rebuilt hours
                          // apart, and a leftover redirect would shadow the page completely.
                          // Streak columns live on sentence_plays (contract basis), never on
                          // user_activity: days_active counts any signed-in PAGE LOAD, so it is
                          // simply a different quantity, and that table's LI assessment describes
                          // an invisible record. privacy.html + ROPA updated in this same commit.
                          // v364: the sentence-count line sits LOWER in the same band (its margin
                          // moved from below to above, so it drops without the space growing) and
                          // is 13->14px, because at 13 it read as fine print rather than as
                          // orientation.
                          // ⚠ And the empty progress slot finally collapses. `.progress-controls:
                          // empty` was correct CSS, shipped in the stylesheet, and measurably DID
                          // NOT APPLY on the live page — the slot matched :empty, had zero child
                          // nodes, and still computed margin-bottom: 14.4px. Replaced with an
                          // explicit .te-empty class set by renderProgress() where it already
                          // toggles te-anon and te-rsv-card: the collapse is now decided by the
                          // code that decides what renders, which is deterministic and can be
                          // debugged. v363: spacing, MEASURED on the live page rather than adjusted by eye.
                          // The band between the collapsed intro and the player card was 89.9px,
                          // and 46px of it was pure whitespace in three gaps: 18.9 under "Read
                          // more", 12.8 under the sentence-count line, and 14.4 under an EMPTY
                          // progress slot. A previous pass moved the sentence line down instead of
                          // shrinking the space it sits in, which is not the same thing. Now
                          // ~50px: intro wrap 1.1rem->0.3rem, .topic-meta 0.8rem->0.3rem with
                          // line-height 1.3, and the empty-slot collapse from v362 doing its job.
                          // Index cards: 1px between title / sentence count / play count so they
                          // read as one block, with the air moved ABOVE the title (.topic-card-top
                          // margin-bottom 6px) to separate the tier pill, which is a different
                          // kind of thing. v362: TWO WAYS PLAY COUNTS COULD GO WRONG, both owner-reported.
                          // (1) DROPPED PLAYS — the serious one. `plysCache` is per-page and read
                          // ONCE, but localStorage is shared by every ThaiEar page, so a page
                          // sitting on a stale snapshot wrote it straight over whatever another
                          // page had queued: a classic lost update. plysLoad() persists, so merely
                          // OPENING a topic page could delete a playlist's queued plays. Every
                          // mutation is now a read-modify-write (plysMutate).
                          // (2) A REPLAYED BATCH INFLATED THE LOCAL TOTAL. /api/plays answers
                          // 200 {duplicate:true} for a batch it already applied — a success, but
                          // it added nothing, and the client folded the deltas in regardless. The
                          // owner saw 11 on a topic page settle back to 8. And the replay path is
                          // ORDINARY: the POST is keepalive from pagehide, so it often lands while
                          // the answer never reaches the unloading page. Duplicates now re-read
                          // the server total instead of guessing.
                          // Also: a 'storage' listener so a second tab is not stale; the gap above
                          // the player cut (.topic-meta 1.75rem->0.8rem / 1.25->0.7rem, and an
                          // EMPTY progress slot now always collapses rather than only when
                          // .te-anon was set); tier pills pulled left so their content aligns with
                          // the topic title. v361: two play-counter bugs the harnesses could not see, both found
                          // by the owner on the live site.
                          // (1) PLAYLIST AND TOPIC COUNTS DID NOT LINK. On a playlist `s.num` is a
                          // SYNTHETIC page id (100001 + index, minted in playlists.html) and the
                          // real spreadsheet number is `clipNum` — so every playlist play was
                          // written to key 100001, 100002, ... The unit tests all passed because
                          // they called notePlay() with real numbers; the mapping only exists on a
                          // real page. Now resolved through globalNumOf(), the same clipNum
                          // convention sentFileFor and dynClipKey already use, on the write AND
                          // the read.
                          // (2) ENGLISH-FIRST COUNTED THE ENGLISH. The ET block is [English,
                          // recall gap, Thai...], so the 2s dwell elapsed before a word of Thai.
                          // The map now carries th0 (where the Thai starts; === start in TE) and
                          // the dwell only accumulates past it. A session built before this has no
                          // th0 and falls back to the old behaviour until rebuilt.
                          // Also: "Plays: N" moves to its own line on topic cards and playlist
                          // rows, in the premium-topic green #1F5D3A, with the surrounding lines
                          // tightened so the extra line costs almost no height. v360: the CLS reserve is DROPPED once the real player mounts
                          // (body.te-player-mounted). v358 set #player-root's floor from
                          // measurements taken in desktop-Chrome iframes at narrow widths, and an
                          // iPhone is not a narrow desktop — the PWA showed a large permanent gap
                          // between the player and the first sentence, worse than the shift the
                          // reserve exists to prevent. A floor can only be wrong in two
                          // directions; once the player is really there its own height is
                          // authoritative, so the guess is removed rather than re-tuned. That
                          // makes over-reserving impossible on ANY device, which no amount of
                          // re-measuring could guarantee. v359: the exclude button is the LAST item in the sentence pill again.
                          // The plays chip sat after it, so the chip appearing (or going 1->2
                          // digits) pushed exclude left — a control moving under the user's
                          // finger. Ordered last it is pinned to the right edge; .sent-preview is
                          // the flex:1 item and absorbs the chip's width instead. v358: #player-root's CLS reserve, MEASURED in live Chrome at four
                          // widths. It had been wrong by ~230px since the dyn rollout on
                          // 2026-08-02: the 350/379 figures were measured on 2026-06-24 against
                          // the CLASSIC player, before dyn added its heading, status line, pause
                          // slider, repeats row and playlist buttons — so every topic page has
                          // been shoving its whole sentence list down on load ever since, and the
                          // last Lighthouse run predated the rollout so nothing caught it.
                          // Now 512 / 510 / 528 / 560 across the four bands the controls wrap at.
                          // v357: PER-SENTENCE PLAY COUNTS. Every pill shows how many times you
                          // have heard that sentence; topic cards and playlist rows show the
                          // MINIMUM across their sentences, which is what makes it mean "complete
                          // listens". Counting is a 2s-or-clip-end dwell, so scrubbing the pause
                          // slider and tap-then-stop do not register, and Thai repeats set to 4
                          // are still ONE listen. Offline it queues DELTAS and the server
                          // increments — every other queue on this site is last-write-wins, which
                          // for a counter would silently discard listening (3 offline on one
                          // device + 2 on another must be 5, not 3). Retries carry a client-minted
                          // batch id so a redelivery cannot double-count.
                          // ⚠ `user_activity.listens` now counts SENTENCES, not audio starts: it
                          // fired off the media play event, so a 32-sentence dyn session recorded
                          // 1 and five pause/resumes recorded 6. Both counters now fire from ONE
                          // call in player.js through ONE dwell gate, so listens is the sum of
                          // sentence_plays.counts by construction.
                          // RETIRED in the same release: sentence flags + /sentences.html, and the
                          // "+ Add progress" bar + /progress.html — playlists and the play counter
                          // replace them. The person icon is now a direct link, not a one-item
                          // menu. #player-root's CLS reserve drops 350->282 / 379->284 because the
                          // progress bar was inside it; leaving it would have left ~70-100px of
                          // permanent dead space above the play button, not a shift.
                          // ⚠ privacy.html changed in the SAME release and is precached — this
                          // bump is what delivers the corrected notice. PLAYS_COUNTER.md.
                          // v356: a playlist row opens on the FIRST tap — a skipped re-render   // v356: a playlist row opens on the FIRST tap — a skipped re-render
                          // was hanging a duplicate click handler on the same node.
                          // v355: privacy policy — the "last updated" date was still 12 Aug after
                          // two substantive edits on 19 Aug, and section 4 now discloses that the
                          // desktop-download allow-list keeps an email after account deletion.
                          // ⚠ privacy.html is PRECACHED and served cache-first, so this bump is
                          // what makes the corrected policy reach anyone who has visited before.
                          // v354: the top player is unlocked INSIDE the tap, so a freshly built
                          // dyn mp3 starts on the first press instead of needing a second one.
                          // v352: playlist cards — a reveal no longer wipes the playing-card
                          // highlight, the equaliser cue or the select tick (non-SSR rebuild).
                          // v351: retention — pending plays now FLUSH when the page goes away.
                          // v350 tallied plays in memory and sent them on the next throttled ping,
                          // but a navigation re-executes attrib.js and reset the tally: load a
                          // topic, play three clips, move to the next topic inside five minutes,
                          // and ZERO of them were recorded. That is ordinary behaviour, not an
                          // edge case, so `listens` was close to worthless. Now flushed on
                          // pagehide AND visibilitychange (iOS often skips pagehide when the user
                          // switches apps or locks the phone); `keepalive` was already set, which
                          // is what lets the POST outlive the page. Counting and sending are now
                          // separate so a flush cannot inflate the tally it is flushing.
                          // v350:   // v350: RETENTION MEASUREMENT. Nothing on the site could answer "does
                          // anyone come back": `progress` needs a manual tap, `last_sign_in_at`
                          // only moves on a fresh sign-in, and `updated_at` moves for reasons
                          // unrelated to the user (ten rows share one timestamp from a bulk
                          // event). New user_activity table + /api/seen, pinged once per page
                          // load and, throttled to 5 min, on play — the play ping is what stops
                          // a 40-minute uninterrupted listen looking like a 40-minute ABSENCE
                          // and being counted as a second session. Plays are batched and sent
                          // as a tally, so `listens` counts clips rather than 5-minute windows.
                          // ⚠ NOTHING IS STORED ON THE DEVICE — both guards are in memory and
                          // the server decides day/session boundaries. That is what keeps this
                          // outside PECR reg 6 and consent-free, so it measures the users who
                          // decline cookies too. Do NOT add a sessionStorage flag.
                          // ⚠ The hook lives in attrib.js, NOT auth.js: attrib.js already had
                          // the auth listener, the token helper and the play listener, so the
                          // highest-risk file on the site stays untouched. attrib.js is
                          // precached, so this bump is what delivers it. RETENTION_MEASUREMENT.md.
                          // v349:   // v349: the mistyped-email suggestion gained a DISMISS button.
                          // Mechanically nothing changed — the next press already sent the address
                          // as typed — but with only a "Use this" button the prompt read as a
                          // demand, and since the version that briefly shipped genuinely DID block
                          // (v347), the fear of being stuck is well founded. Dismissing does not
                          // just clear the line either: it says "tap the button again to use
                          // <what you typed>", because a blank status leaves exactly the doubt the
                          // button exists to remove. Labelled "Dismiss", not "Don't use this":
                          // "this" sits next to two addresses and reads either way.
                          // v348:   // v348: LEGIBILITY — gloss chips were the smallest type on the site
                          // (11px on mobile) and some users could not enlarge them at all. Two
                          // changes. (1) Bigger default: 12/11px -> 13/12.5px. The chip's Thai
                          // carries stacked vowels and tone marks in the same nominal size its
                          // English half only needs for x-height, so it was the harsher
                          // constraint. (2) PINCH-ZOOM IS BACK in the app and installed PWA.
                          // nav.js blocked it three ways when only one was ever needed:
                          // touch-action:manipulation alone kills double-tap and leaves pinch
                          // alive, per spec. The viewport user-scalable=no and the gesturestart
                          // preventDefault (the one that actually killed it on WebKit) are gone.
                          // Blocking pinch is a WCAG 1.4.4 failure, and an iPhone PWA user had NO
                          // way to enlarge anything, px web text being immune to Dynamic Type.
                          // Android additionally needs android.zoomEnabled:true in
                          // capacitor.config.json (Capacitor defaults it false) — deferred to the
                          // next app release; Android's system font-size setting already enlarges
                          // chips meanwhile, they being content that does not use --te-ui.
                          // Chips also gained a SPILL GUARD (min-width:0 + overflow-wrap:anywhere).
                          // Measured in headless Chrome on the real topic-08 S198 chip
                          // ("grandfather(pat.)" — 17 chars, no space or hyphen, so no break
                          // opportunity): at 2.0x on a 320px screen it spilled 82px out of its
                          // row. It already spilled 50px at the OLD 11px size, so that was a
                          // latent bug this bump widened rather than created. Guarded by the new
                          // test_gloss_chip.js (the rule is hand-carried in three files).
                          // v347: HOTFIX — the mistyped-email guard shipped half-finished and was
                          // BLOCKING SIGNUPS. It reached production inside another session's
                          // `git add -A`, at an intermediate state with no once-only guard, so a
                          // flagged address could never be sent: press send, get "did you mean",
                          // press again, get it again, forever. And it flagged real domains —
                          // measured against 43 of them, the shipped version wrongly corrected
                          // b.com, bt.com, x.com, gmx.com, mac.com and hey.com.
                          // ⚠ THE FUZZY MATCHER IS GONE ENTIRELY, not tuned. A length-scaled
                          // threshold was tried and still mangled mail.com -> gmail.com,
                          // uol.com -> aol.com, sony.com -> sky.com and mail.ru -> mail.au (.ru
                          // simply was not in the TLD list). Edit distance cannot do this job:
                          // real domains sit 1-2 characters from popular ones constantly. It is
                          // now an explicit table of unambiguous typos, which cannot invent a
                          // correction for a domain it has never seen, and it still catches both
                          // addresses that actually happened (a .comp for .com, a .co.um for .co.uk).
                          // Also: join.html no longer strands a visitor after Google sign-in —
                          // startGoogleSignIn uses redirectTo: window.location.href, so Google
                          // returns them to the join page as a FRESH LOAD, where they landed on
                          // "Create an account", saw a tick, and had to find the ✕ to escape.
                          // v346: PRIVACY — the policy and the code disagreed, and the code was
                          // the one at fault. attrib.js wrote gclid/utm/landing/referrer to
                          // localStorage with NO consent check, while privacy.html told users that
                          // half was consent-gated. localStorage is PECR reg 6 "access to terminal
                          // equipment", and a legitimate-interests basis does NOT substitute for
                          // consent there. Decline advertising cookies now and NOTHING of ours is
                          // stored on your device; granting later still captures; withdrawing
                          // ERASES what we hold. The server-derived geography (country/city/network,
                          // never the IP) touches no device storage, so it stays unconditional under
                          // legitimate interests — and privacy.html now says all of this, plus
                          // MailerSend as a processor, which was never disclosed at all.
                          // v345: /confirm stops sending people down a dead end. An EXPIRED or
                          // already-spent token used to reveal the code box — but the code is the
                          // SAME OTP record, so that was a guaranteed second failure. It now says
                          // the link has expired, turns the button into "Get a new sign-in link",
                          // and states that the code is dead too. Any OTHER failure still offers
                          // the code, because the likeliest of those is a token_hash mangled in
                          // transit, where the record is fine and only the URL is damaged. The
                          // toggle also stopped claiming "link not working?" — the user got to
                          // that page BY the link, so it now reads "Prefer to type the code".
                          // v344: the sign-in CODE is now offered on the page that sent the link,
                          // for returning users as well as new ones, instead of being reachable
                          // only by first clicking the email LINK — the one thing it exists to
                          // work without. The resend button is also visible from the moment a
                          // link is sent, greyed and counting down, rather than materialising at
                          // 60s onto what until then looked like a dead page.
                          // ⚠ THE CODE IS THE SAME OTP RECORD AS THE LINK, so it is NOT a defence
                          // against a scanner that presses the button on /confirm — that spends
                          // the token and kills the code too. It is for the email opening in a
                          // WebView or on another device, for a mangled URL, and as the migration
                          // path to a code-ONLY email. Comments saying otherwise were corrected.
                          // v343: a sentence tap can no longer strand its own button. The play
                          // button lit on tap and was only ever un-lit by ended/error/a rejected
                          // play()/a timer armed inside loadedmetadata - so a media load that
                          // merely HANGS (no error, no metadata, no rejection: the ordinary
                          // failure of a mobile connection) left it lit and silent for ever.
                          // player.js now arms a 5 s deadline when it sets the src, sharing one
                          // recovery path with the error listener. Also: a tap now ABORTS the
                          // idle prewarm's in-flight fetches and holds its queue until the tap
                          // has loaded - WebKit throttles parallel bursts, so a tap arriving
                          // mid-prewarm could queue behind clips nobody is waiting for, which is
                          // why the stalls clustered on a just-opened topic (~3 in 20 taps).
                          // v342: PER-SENTENCE AUDIO LATENCY. A gated clip is ~10 KB but cost
                          // THREE serialised round trips before a byte moved (/api/audio, then TWO
                          // Supabase calls inside it since ENFORCE_SUBSCRIPTION is on, then R2's S3
                          // endpoint, which is never edge-cached) - and its presigned URL changed
                          // every request, so no cache anywhere could ever hit it and every replay
                          // re-paid the lot. player.js now caches the signed URL for 45 min, mints a
                          // whole topic in ONE /api/audio?files= call, and prewarms the clips at
                          // idle; functions/api/audio.js gained the batch route. player.js is
                          // PRECACHED, so this bump is what delivers it. See
                          // SESSION_2026-08-19_SENTENCE_LATENCY.md.
                          // v341: confirm.html — the 6-digit code route was UNREACHABLE. The box was
                          // revealed only after a link verify had already FAILED, so a user wanting
                          // to use the code INSTEAD of the link (its entire purpose) had nowhere to
                          // type it. Now a permanent "Link not working? Use the code" toggle opens
                          // it. Also maxlength 6 -> 10: this project's mailer_otp_length issues
                          // EIGHT digits, and the 6-cap silently truncated a correct code.
                          // ⚠ confirm.html is PRECACHED and cache-first, so editing it without
                          // this bump would have reached nobody.
                          // v340: THE SIGN-IN EMAIL NO LONGER DIES TO A MAIL SCANNER. Both Supabase
                          // templates now point at our own /confirm page, which verifies the OTP on
                          // a CLICK instead of on the GET. Microsoft Defender "Safe Links" was
                          // pre-fetching the single-use link and spending it in its own sandbox
                          // (proved: a confirmed signup from a "Microsoft Limited" IP in Cardiff,
                          // 28s after send) — silently blocking every Office 365 / university /
                          // corporate address. ⚠ THIS FIXES THE TOKEN, NOT DELIVERY: the owner's
                          // report is that the email never reached the inbox AT ALL, which is a
                          // separate MailerSend/Microsoft problem no page of ours can solve.
                          // New precache entry /confirm.html, and auth.js gains
                          // verifyOtpHash/verifyOtpCode, so BOTH need this bump to reach anyone.
                          // Also: account.html + join.html re-arm the send button after 60s as
                          // "Send another link" (there was no resend short of a page refresh;
                          // 60s because gotrue's own resend floor is 1 minute).
                          // ⚠ THIS BUMP ALSO CARRIES player.js r191 (commit b06a0e6, the stale-
                          // markup pill-hint repair), which was committed WITHOUT a VERSION bump
                          // by a parallel session. player.js is precached and cache-first, so
                          // r191 could not have reached a single returning visitor on its own.
                          // v339: ENGLISH-FIRST PILL HINTS. The collapsed pill's hint now follows
                          // the chosen direction (Thai-first -> Thai, English-first -> an authored
                          // English hint, `previewEn`). Both ship in the card and swap by CSS, so
                          // SSR is untouched. New precache entry /sentence-hints.json, which also
                          // fixes playlist pills: they used to DERIVE the hint from the saved Thai
                          // (first 4 words, cut at 20 chars) and so differed from the topic page on
                          // 2,265 of 2,271 sentences, often cutting mid-word.
                          // v338: AD ATTRIBUTION WAS DEAD. auth.js userFromSession() omitted
                          // created_at, so attrib.js:108 returned on its first line for EVERY user
                          // on EVERY path — ad_attribution held 0 rows since it shipped, and the
                          // Google Ads `signup` conversion never fired either (track('signup') sits
                          // below that return). Also: NEW_USER_MS 5min->60min for the magic-link
                          // path, accessToken() falls back to thaiear_identity, the once-guard is
                          // set on SUCCESS (was: before the request, so one failure lost the row
                          // forever), + an inFlight guard because auth.js notify()s 3-4x per load.
                          // ⚠ BOTH FILES ARE PRECACHED (cache-first since v292) — without this bump
                          // the fix reaches nobody. ADS_OPERATIONS.md §4.1, test_attrib_signup.js.
                          // v337: consent buttons are now EQUAL WIDTH by construction (min-width
                          // in em, so it tracks --te-ui) and Accept reads "Yes okay" — prominence
                          // parity no longer depends on picking labels of matching length.
                          // v336: consent banner copy — leads with the benefit instead of arguing
                          // against itself, Accept-first ("Okay" / "No thanks"). Order is not
                          // regulated; PROMINENCE is, and both buttons stay computed-identical.
                          // v335: attrib.js now POSTs on EVERY signup (not only ad-attributed ones)
                          // so /api/attrib can stamp signup geography from request.cf. Shipped as
                          // its own release AFTER the ad_attribution geo_* migration — the reverse
                          // order would have PostgREST 400 on unknown columns and write NO row at
                          // all, losing the attribution that already worked.
                          // v334: auth.js surfaces a FAILED sign-in instead of silently landing the
                          // user on a logged-out page (reproduced 2026-08-17; a real visitor hit
                          // `OAuth state has expired` on 08-16 and nearly bounced).
                          // ⚠ auth.js IS PRECACHED, i.e. served cache-first since v292 — without
                          // this bump the fix would not reach a single returning visitor.
                          // v333: download batch bar slimmed on BOTH surfaces (index Topics + index
                          // Playlists) — an empty #dl-batch-status no longer reserves a blank row
                          // above the "Tap a topic's circle…" hint (:empty collapses it, so its flex
                          // gap goes too), gaps/padding tightened, hint line-height 1.35. The hint
                          // region drops ~48%, the card 133px -> 101px. index.html and pl-list.js are
                          // both precached (cache-first).
                          // v309: consent bar no longer covers the end of every page (body padding) — it was eating taps on prev/next; signup + end-of-topic cards restyled
                          // (dlRefPrefixes, r75's "lock-independent ground truth") instead of
                          // trusting the thaiear_offline_pl RECORD, matching player.js's
                          // dynOwnedPrefixes(). A record outlives evicted clips — an iOS PWA
                          // clears Cache Storage and leaves localStorage — so record-without-files
                          // rendered a tick over a playlist with nothing on the device.
                          // v304: a REMOVED playlist row no longer says "update available" for
                          // ever. dlState()'s D0 looksLikeTopicClaim() fallback is right for a
                          // topic card and wrong for a playlist row — it answers true on a 'topic'
                          // ref, i.e. "that TOPIC is downloaded", so any playlist sharing a prefix
                          // with a downloaded topic inherited its verdict. A playlist's state is
                          // ownership-only now, matching player.js's PLMODE branch. pl-list.js is
                          // precached (cache-first).
                          // v303: playlist clips route off the LIVE tier (topics.js tierForPrefix),
                          // not the tier snapshotted into playlist_items when the sentence was
                          // saved. The 2026-08-10 free/premium reorganisation moved 9 first-parts'
                          // MP3s to the public bucket, so saved rows still saying 'member' asked
                          // /api/audio to sign a PRIVATE-bucket URL for a file that had moved —
                          // a hard 404 that aborted the whole playlist download, retry-proof.
                          // topics.js, player.js and pl-list.js are all precached (cache-first).
                          // v302: "Tone twisters" -> "Tongue twisters" (DISPLAY ONLY — audio handle
                          // ToneTwister_LI1 and page topic-39.html unchanged) + Facebook link on
                          // socials.html. index.html, topics.js and socials.html are all precached.
                          // v301: read.js audio element attached to the DOM so the `activation`
                          // conversion fires on the reading course. It was detached, so attrib.js's
                          // capturing `play` listener never saw it and the whole read arm recorded
                          // ZERO activations. read.js is PRECACHED and served cache-first, so this
                          // bump is what actually delivers the fix — without it nobody gets the new copy.
const CACHE = 'thaiear-' + VERSION;
/* ⚠ VERSION-INDEPENDENT, NEVER SWEPT ON ACTIVATE (2026-08-09).
   The Supabase ESM bundle used to live in the version-keyed CACHE, so EVERY deploy destroyed it —
   and it is only ever RUNTIME-cached, so nothing put it back until the user next opened the site
   ONLINE. In that window auth.js's `import(SUPABASE_ESM)` could not resolve offline, so the client
   was never created, getUser() stayed null, and every signed-in offline surface fell back to its
   logged-out state: the playlists panel showed "Sign in (via the Menu)…" instead of the playlists
   sitting in localStorage a few lines away. Reported 2026-08-09 as "I see none of my playlists"
   in airplane mode, immediately after two deploys.
   This is the same trap the PRECACHE comment below already warns about for the shell pages —
   "anything only ever runtime-cached vanishes on every deploy" — with the one asset that offline
   AUTH depends on left on the wrong side of it.
   A separate cache, not a PRECACHE entry, because the @2 entry point pulls further chunks from
   esm.sh at import time; a bucket that survives keeps the whole module graph without this file
   needing to know esm.sh's internal layout. */
const VENDOR_CACHE = 'thaiear-vendor';
// Network-first is great online but offline the WebView's fetch can hang for many seconds before it
// rejects, making cached pages crawl in. If the network hasn't answered within this window and we
// have the page cached, serve the cache at once (and let the network refresh it in the background).
const NET_TIMEOUT_MS = 2000;
/* ADAPTIVE OFFLINE HINT (2026-08-09). `navigator.onLine` is useless here — it reports *online* in
   airplane mode in this WebView — so the worker learns from what actually happened instead: once a
   request has failed or blown NET_TIMEOUT_MS, assume the network is down for a short window and
   answer from cache immediately (see the fast path in the fetch handler). Any success clears it.
   Short on purpose: the cost of being wrong is serving a cached copy for a few seconds while the
   background revalidate refreshes it, which is what the timeout path already did anyway. The state
   is in memory, so a terminated worker simply re-learns it — nothing to invalidate. */
const NET_DOWN_MS = 10000;
/* How long to wait before writing a revalidated TOPIC page back into the cache. We have already
   handed the page the cached Response, and overwriting a cache entry whose body is still streaming
   can abort that read in WebKit (see the probeOnly note in the fetch handler). 3 s is comfortably
   past the point a 75 KB HTML body has been parsed, and the write happens inside waitUntil so the
   worker stays alive for it. */
const REVALIDATE_WRITE_DELAY_MS = 3000;
/* Which NAVIGATIONS take the stale-while-revalidate path in the fetch handler.
   Two families, both answered instantly from the version-keyed cache:

   1. TOPIC PAGES. Matches the clean URL Cloudflare Pages serves (/topic-04a) and the .html form
      (older bookmarks and inbound links still 308 through it). Split parts carry a single letter
      suffix: topic-04a, topic-25d, topic-32b.

   2. PRECACHED SHELL PAGES (added 2026-08-12) — the homepage, the 13 read pages, about, guide,
      account, progress, sentences and the rest. 29 navigable pages were sitting in the version
      cache, seeded at install, and STILL paying a full network round trip on every open. Home is
      the most-opened page on the site and the app's Home -> topic -> Home loop paid it twice.
      ⚠ This family is SAFER than topic pages, not riskier: a precache entry is fetched from the
      network during install, so the cached copy IS the deployed copy for this VERSION, and a
      VERSION bump re-seeds the lot. Topic pages are only runtime-cached, and they were already
      cleared for this treatment.
      Auth-gated shells (account/progress/sentences) are fine — only their SHELL is precached and
      per-user data is fetched by JS on load, which is exactly the existing design.
      Query strings are ignored on lookup (?next=, ?feature=1, ?sub=success): they are read by the
      page's own JS, never by the server, so one cached shell serves them all. */
function isTopicNav(req, url) {
  return req.mode === 'navigate' && /^\/topic-\d{1,3}[a-z]?(\.html)?$/i.test(url.pathname);
}
function isPrecachedNav(req, url) {
  if (req.mode !== 'navigate') return false;
  var p = url.pathname;
  // Try the path as-is, then the .html <-> clean variant, since Pages serves /about for /about.html.
  return PRECACHE_PATHS.has(p) ||
         PRECACHE_PATHS.has(p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html');
}
function isInstantNav(req, url) { return isTopicNav(req, url) || isPrecachedNav(req, url); }
var netDownUntil = 0;
function netLooksDown() { return Date.now() < netDownUntil; }
function noteNetDown() { netDownUntil = Date.now() + NET_DOWN_MS; }
function noteNetUp() { netDownUntil = 0; }

// Topic pages (topic-NN.html) 308-redirect to clean URLs (/topic-NN). A *redirected* Response
// can't be used for a navigation (the browser throws net::ERR_FAILED), so rebuild a clean,
// non-redirected copy before caching/serving any such response.
function cleanRedirect(res) {
  if (!res || !res.redirected) return Promise.resolve(res);
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

// Friendly fallback for an uncached page requested offline (instead of the webview's blank error).
function offlinePage() {
  var html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · ThaiEar</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#FAFAF8;color:#1A1A1A;text-align:center}' +
    '.b{padding:2rem;max-width:23rem}h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}' +
    'p{color:#5A5A5A;line-height:1.6;margin:.25rem 0 1.4rem}' +
    'button{display:inline-block;background:#261B65;color:#fff;border:none;font:inherit;font-weight:500;padding:10px 18px;border-radius:8px;cursor:pointer}' +
    '.alt{margin:1rem 0 0}.alt a{color:#261B65;text-decoration:none;font-weight:500;font-size:.9rem}' +
    '</style></head><body><div class="b"><h1>You’re offline</h1>' +
    '<p>This page isn’t available without a connection.</p>' +
    '<button onclick="if(history.length>1){history.back()}else{location.href=&#39;/index.html&#39;}">Go back</button>' +
    '<p class="alt"><a href="/index.html">Home</a></p></div></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ⚠⚠ THE CACHES A FALLBACK IS ALLOWED TO ANSWER FROM, IN PRIORITY ORDER (2026-08-23).
   The two helpers below used to call the bare caches.match(), which searches EVERY cache on this
   origin in CREATION ORDER — OLDEST FIRST. That is the 2026-08-12 `thaiear-dl` shadowing bug one
   level up: while a leftover thaiear-v<N> exists (an activate() that never reached its sweep, see
   SW_ACTIVATE_FIX_PLAN.md), it is consulted BEFORE the current version cache on every fallback
   path — any navigation slower than NET_TIMEOUT_MS, anything at all while netLooksDown(), and any
   failed fetch of a precached asset. A stale build then surfaces in exactly the conditions nobody
   can reproduce, which is why a lingering cache is NOT merely wasted storage today.
   Naming the caches makes a leftover unreachable, so it costs storage and nothing else.
   ⚠ ORDER IS LOAD-BEARING: CACHE first, so the current version always beats a downloaded copy of
   the same page (`thaiear-dl` holds topic pages under their clean /topic-NN key and is never
   version-wiped). Today's creation-order search gets this backwards on a device that downloaded a
   topic before the current release.
   ⚠ THE TRADE, MADE DELIBERATELY (owner-approved 2026-08-23): on a device whose current cache has
   HOLES, a file that exists only in a leftover becomes a clean miss offline instead of a stale hit.
   Online is unaffected — a miss just goes to the network — and migrateGaps() exists to fill those
   holes during activation.
   ⚠ Keep in step with the keep-list in activate() below, minus VENDOR_CACHE: that one is
   cross-origin (esm.sh) and is served by its own branch at the top of the fetch handler, so it
   never reaches these helpers. */
const FALLBACK_CACHES = [CACHE, 'thaiear-dl', 'thaiear-audio-dl'];

/* caches.match() over a NAMED list rather than every cache. Sequential and short-circuiting, so a
   hit in CACHE — the overwhelmingly common case — costs one lookup.
   ⚠ Never opens a cache that does not exist: caches.open() CREATES one, which would leave empty
   thaiear-dl / thaiear-audio-dl entries on devices that have never downloaded anything and make
   the owner panel's cache list harder to read — our only readout on the iPhone PWA.
   Any failure resolves to null; a fallback lookup must never reject. */
function scopedMatch(what, opts) {
  return caches.keys().then(function (names) {
    var list = FALLBACK_CACHES.filter(function (n) { return names.indexOf(n) !== -1; });
    function step(i) {
      if (i >= list.length) return null;
      return caches.open(list[i])
        .then(function (c) { return c.match(what, opts); })
        .catch(function () { return null; })
        .then(function (hit) { return hit || step(i + 1); });
    }
    return step(0);
  }).catch(function () { return null; });
}

// Positive cache lookup (returns a Response or null — NEVER the offline page), used by the timeout
// fast-path so we only short-circuit to cache when we genuinely have the resource. Ignores the query
// string (member links carry ?next/?feature) and tries the .html<->clean variant for downloaded
// topic pages (persisted under their clean /topic-NN key).
function positiveCacheMatch(req, url) {
  return scopedMatch(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    if (req.mode === 'navigate') {
      var p = url.pathname;
      var alt = p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html';
      return scopedMatch(alt, { ignoreSearch: true });
    }
    return null;
  });
}

// Thorough offline fallback, used when the network actually fails: exact match, then the home-grid
// and pathname/.html<->clean variants, finally the friendly offline page.
function cacheFallback(req, url) {
  return scopedMatch(req).then(function (hit) {
    if (hit) return cleanRedirect(hit);   // never hand the browser a redirected response for a nav
    if (req.mode === 'navigate') {
      // Home/index: serve the cached grid from either key so the logo/Home link always works.
      var p = url.pathname;
      if (p === '/' || p === '/index.html' || p === '/index') {
        return scopedMatch('/index.html').then(function (i) {
          return i ? cleanRedirect(i) : scopedMatch('/').then(function (r) { return r ? cleanRedirect(r) : offlinePage(); });
        });
      }
      // Match by PATHNAME, ignoring any query string (?next=, ?feature=1, ?sub=success…), then the
      // .html<->clean variant (downloaded topic pages live under their clean /topic-NN key).
      var alt = p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html';
      return scopedMatch(p, { ignoreSearch: true }).then(function (h1) {
        if (h1) return cleanRedirect(h1);
        return scopedMatch(alt, { ignoreSearch: true }).then(function (h2) {
          return h2 ? cleanRedirect(h2) : offlinePage();
        });
      });
    }
    return Response.error();
  });
}

// Best-effort precache so a brand-new install has the shell even before each
// asset is individually visited. Missing entries are ignored (never fail install).
const PRECACHE = [
  '/', '/index.html',
  // Navigable non-topic "shell" pages — precached so they open offline (each renders its own
  // logged-out/offline state) instead of falling through to the generic offline notice. Topic pages
  // are intentionally NOT here (cached on visit / via the download feature).
  '/account.html', '/subscribe.html', '/join.html', '/about.html', '/guide.html', '/socials.html', '/app.html',
  '/progress.html',
  '/privacy.html', '/terms.html', '/refunds.html', '/deleted.html',
  /* The /topics landing + its five difficulty bands (2026-08-21). They are the navigation
     spine of the redesigned site — every route to a topic page runs through one of them —
     so they must open offline like the rest of the shell. Their cards are static HTML, so
     an offline visitor sees the whole catalogue and can open anything downloaded. */
  '/topics.html',
  '/topics-beginner.html', '/topics-beginner-to-lower-intermediate.html',
  '/topics-lower-intermediate-to-intermediate.html',
  '/topics-intermediate-to-upper-intermediate.html',
  '/topics-upper-intermediate-to-advanced.html',
  /* Favourites (2026-08-27). The PAGE is precached like the five bands — it is a navigation
     route in the same family, and offline it must render its own empty/prompt state rather
     than the generic offline notice. Its CONTENTS are per-user and come from the account, so
     offline it shows whatever the local mirror holds; that is correct, not a gap.
     ⚠ topics-fav.js is precached because it paints the hearts on EVERY band page, not just
     this one — an un-precached copy would leave every card's heart unrendered offline while
     the rest of the card looked fine, which reads as "favourites are broken" rather than
     "you are offline". */
  '/topics-favourites.html',
  '/topics-fav.js',
  /* The Grammar by Ear hub (2026-08-29, at go-live). Precached for the same reason as /topics
     and the five bands: it is the catalogue for its arm and the only route to the 20 unit pages,
     and its cards are static HTML, so offline it renders in full.
     ⛔ THE 20 UNIT PAGES STAY OUT, exactly like the 93 topic pages — too heavy to seed on
     install, and already cached two ways (network-first on first online visit, and the durable
     thaiear-dl cache for a downloaded unit). CLAUDE.md states the topic-page exception; this arm
     is the same shape and inherits it. */
  '/grammar.html',
  /* The one identity reader. Blocking in every page's head, so it must be on disk. */
  '/identity.js',
  '/topics-page.css', '/topics-page.js',
  /* The home splash's welcome / create-account block. Precached with the rest of the shell:
     the home page is the route to every downloaded topic, and it must render completely
     offline, not partly. */
  '/home-cta.js',
  /* The sign-in interstitial the email links to (v340). It is where a user lands from their
     inbox, i.e. often on a device that has never opened the site, so it must not depend on a
     lucky network moment — and it is the ONLY route back in for anyone whose magic link was
     detonated by a mail scanner. See ADS_OPERATIONS.md §4.2 / §5.6. */
  '/confirm.html',
  // Read Thai section (learn-to-read on-ramp, 2026-07-22): hub + 13 sub-pages + its
  // shared assets. Audio is NOT precached (208 clips on the CDN — cached on play).
  '/read.html', '/read-mid.html', '/read-high.html', '/read-low1.html', '/read-low2.html',
  '/read-vowels-long.html', '/read-vowels-short.html', '/read-vowels-special.html',
  '/read-finals.html', '/read-sounds.html', '/read-tones.html', '/read-clusters.html',
  '/read-quiz.html', '/read-results.html',
  '/read.js', '/read-data.js', '/read.css', '/betta.png',
  '/nav.js', '/topics.js', '/player.js', '/auth.js', '/footer.js',
  '/quiz.js', '/quiz.css',   // Phase 4 quizzes. Loaded by the two pilot topic pages and
                   // owner-gated at runtime, but PRECACHED because a topic page opened offline
                   // must not fire two failed requests -- and because a downloaded topic's
                   // quizzes are meant to work offline (decision 24), which needs the engine
                   // on the device, not just the page.
  '/pl-list.js',   // r130: shared playlist-list module (index panel + playlists.html legacy embed)
  /* ✅ THE SIDE-CAR MANIFEST — a few hundred bytes that stop a playlist paying for 404s.
     It lists which units actually HAVE quiz data, so pl-quiz.js fetches only those instead of
     one request per source unit, most of which 404 while the corpus is being built. Precached
     because the decision has to be available OFFLINE too: without it a downloaded playlist
     falls back to asking the network for files it cannot reach.
     ⚠ GENERATED by gen_quiz_data.js from the directory listing, so it cannot drift — and it
     is precached, so BUILDING A UNIT'S QUIZ DATA NEEDS A VERSION BUMP to reach anybody. */
  '/quiz-data/index.json',
  '/pl-quiz.js',   // §2.7b: the quizzes at the foot of a playlist. Same reasoning as quiz.js above
                   // — a downloaded playlist's quizzes must work offline, which needs the module
                   // on the device. ⛔ The per-unit quiz-data/*.json side-cars are deliberately
                   // NOT here: there are 113 of them and a playlist needs only the handful its own
                   // sentences come from, so they are fetched at runtime and copied into the
                   // DURABLE thaiear-audio-dl cache when a playlist is downloaded. Seeding all 113
                   // would be ~3 MB paid by every device on every VERSION bump.
  '/dl-core.js',   // r121: shared download engine (§D.1) — real product code, consumed by playlists.html (and the index from P2b)
  /* The "Study ThaiEar offline" app card. It never RENDERS in the app or an installed PWA — it is
     the plain-browser-tab counterpart to the download controls — but every topic page, read.html
     and index.html now carry its <script> tag, so an un-precached copy would mean a failed request
     on every offline page open in the very contexts that never use it. Cheap to seed, so seed it. */
  '/app-cta.js',
  /* The authored pill hints, {globalNum: [thai, english]} — generated by gen_sentence_hints.js.
     playlists.html reads it so a playlist row shows the SAME hint as the topic page instead of a
     mid-word cut of the saved Thai. Offline playlists are a shipped feature, so it has to be here:
     without it every offline playlist would silently fall back to the old derivation. ~100 KB. */
  '/sentence-hints.json',
  '/topic-sentences.json',
  '/clip-durations.json',
  /* Advertising measurement, r166. All three are on all 122 landable pages, so an un-precached
     copy means three failed requests on every offline page open. They are also the wrong thing to
     let a network fetch decide: consent.js carries the visitor's stored cookie choice and MUST be
     available to run before any tag can, offline included.
     NOTE gtag.js does not fetch googletagmanager unless consent was granted — and in the app and
     installed PWA it never does at all — so seeding these costs three small files and no requests. */
  '/consent.js', '/attrib.js', '/gtag.js',
  // Playlists + the owner entitlement simulator. PRECACHED because the offline behaviour is
  // exactly what they exist to test, and runtime caching couldn't guarantee it: bumping VERSION
  // creates a NEW cache and drops the old one, so anything only ever runtime-cached vanishes on
  // every deploy until it is visited online again. That is why the toggles were missing in
  // airplane mode. (Both disappear at rollout — playlists.html becomes a normal shell page.)
  '/playlists.html',
  /* ⚠ THE TEST SPACE ITSELF MUST BE PRECACHED, FOR EXACTLY THE REASON GIVEN ABOVE — and these were
     missed (2026-07-31). Runtime caching cannot hold them: bumping VERSION creates a NEW cache and
     drops the old one, so a topic-test page only ever runtime-cached VANISHES on every deploy until
     it is visited online again. Fifteen VERSION bumps in one day therefore wiped the owner's
     offline test pages fifteen times, and every airplane-mode test on iPhone silently fell back to
     the SW's offline page: no sim.js, so no test-space strip, no boot trace, no dyn player — which
     is why three captures in a row contained no topic-page lines at all, why the strip kept
     disappearing, and why the owner had to route back in via the live homepage.
     The offline behaviour of these pages IS the thing under test, so they cannot be left to a cache
     that a deploy destroys. They go with the rest of the scaffolding at rollout (§E). */
  '/player-dyn.css',   // the whole dyn player chrome — REAL product code (r127)
  /* r138 — GENERATED (gen_dyncss.js) from player.js's DYN_STYLES so topic pages can link the dyn
     control styles + the r28 body.te-v2 restyle in <head> and have them apply at FIRST PAINT.
     ⚠ MUST STAY PRECACHED alongside player-dyn.css: both are now render-blocking <link>s on every
     topic page, so an un-precached copy would mean a network round trip before a downloaded topic
     could paint offline — exactly the case the offline download exists to serve. */
  '/player-dyn-mount.css',
  // PWA install vehicle. The MANIFEST is precached; its three icons are NOT.
  /* ⚠ DO NOT PUT icon-512.png / icon-512-maskable.png BACK (removed 2026-08-22, measured).
     They are 433 KB and 286 KB — together 25% of everything install() downloads — and NO PAGE
     EVER REQUESTS THEM. Their only referrer is manifest.json, i.e. the OS reads them once, at
     "Add to Home Screen" time, which cannot happen offline anyway; after that the launcher owns
     the icon and never asks us again. index.html mentions icon-512.png only in a comment saying
     explicitly NOT to use it (the home mark is /home-swirl.png, a right-sized copy). So the old
     comment here — "so the installed app has its launch icon available offline" — described a
     need that does not exist, and the cost was 719 KB re-downloaded on EVERY version bump.
     favicon-192.png stays: it is a manifest icon too, but it is 65 KB, and small enough not to
     be worth reasoning about twice. */
  '/manifest.json',
  /* The home page's centrepiece — a right-sized copy of the swirl, not the 433 KB PWA icon. */
  '/home-swirl.png',
  /* ⚠ /favicon.png was here and is REFERENCED BY NOTHING — not one page, not manifest.json, not
     nav.js. 100 KB re-fetched on every bump for a file no client ever asks for. Removed
     2026-08-22; the real favicons are the .ico/.svg/-16/-32/-192 set below, which pages do link. */
  '/logo-hero.png', '/nav-swirl-2x.png', '/favicon.ico',
  '/favicon-16.png', '/favicon-32.png', '/favicon-192.png', '/apple-touch-icon.png',
  '/khwai.png', '/meditator.png', '/muaythai.png', '/sakyantelephant.png', '/gecko.png', '/hornbill.png', '/yak.png', '/phi.png',
  /* ⛔ THE QUIZ MASCOT, AND IT WAS THE ONLY ONE MISSING. Owner, 2026-09-22: "i got into the
     quiz menu but the tiger image was absent, (white space), only the css writing below was
     visible." Every other mascot on the site is on the line above; tiger.png was never added
     when the quiz arm was built, so its first render is a cold network fetch and offline it
     never arrives at all -- which is precisely CLAUDE.md's "a precached page with an
     un-precached image shows broken art offline".
     ⚠ 34.6 KB, the SMALLEST of the nine, so the per-bump cost is the least of any of them. */
  '/tiger.png',
  // Self-hosted fonts (replaced Google Fonts 2026-06-24): precache the full used set so a
  // freshly-downloaded topic renders Sarabun (Thai) + Inter offline, not the system fallback.
  '/fonts/inter-latin-300.woff2', '/fonts/inter-latin-400.woff2',
  '/fonts/inter-latin-500.woff2', '/fonts/inter-latin-600.woff2',
  '/fonts/sarabun-thai-300.woff2', '/fonts/sarabun-thai-400.woff2',
  '/fonts/sarabun-thai-500.woff2', '/fonts/sarabun-thai-600.woff2',
  '/fonts/sarabun-latin-300.woff2', '/fonts/sarabun-latin-400.woff2',
  '/fonts/sarabun-latin-500.woff2', '/fonts/sarabun-latin-600.woff2',
  /* The loopless Thai of the "Font" toggle (2026-09-19). Precached on purpose even though most
     visitors never turn it on: the one who does uses it on every page, including offline in the
     app, and a reading aid that silently reverts to looped when the network drops is worse than
     useless to the reader practising signage script. 26.9 KB — ONE variable file (wght 100–900)
     covers both weights, where Sarabun needs four statics. */
  '/fonts/notosansthai-thai.woff2'
];

/* Fast lookup for the cache-first path in the fetch handler below. */
const PRECACHE_PATHS = new Set(PRECACHE);

/* Add a list of URLs a few at a time. ~150 simultaneous fetches on a phone is exactly how the
   install below used to end up half-finished: the burst is throttled or the radio drops, entries
   fail, and .catch() swallows it. Small batches are far more likely to complete. */
/* ── THE PENDING-GAP RECORD (2026-09-19) ─────────────────────────────────────────────────────
   WHY THIS EXISTS. install() races the precache against INSTALL_BUDGET_MS and activates whatever
   landed; activate() then fills the holes from the OUTGOING cache (migrateGaps — old bytes, no
   network) and fires one opportunistic re-fetch of exactly those holes. That re-fetch is
   deliberately not awaited, and **nothing has ever retried it**. So when it fails — a slow or
   intermittent link is all it takes — the device ends up on the NEW VERSION holding OLD FILES,
   and cache-first never re-checks a precached sub-resource. The note above migrateGaps says a
   stale entry "can survive only until the next successful fetch, never permanently": true in
   letter, misleading in practice, because within a version there was no later attempt. The next
   attempt was the next deploy.
   Observed live 2026-09-19: the owner's Android app reported v563 while player.js in that cache
   was still r222, across repeated force-closes. Navigations are network-first, so the sharp edge
   is not "old features" — it is NEW HTML meeting OLD JS.
   THE FIX: write the hole list down, and re-try it on later navigations until each one lands.
   ⚠ IT DELETES NOTHING but its own record — which is the whole reason it is safe to run on the
   fetch path where SW_ACTIVATE_FIX_PLAN.md §12's cache sweep was deferred. That one was deferred
   because a wrong keep-list is silent loss of thaiear-dl / thaiear-audio-dl; this one has no
   keep-list and removes no cache.
   ⚠ c.add() fetches from INSIDE the worker, which does NOT pass through our own fetch handler, so
   there is no cache-first copy to defeat and no cache-busting is needed. (A PAGE-side fetch does
   need it — ownersim.js's re-download button was a silent no-op for exactly that reason.) */
/* ⚠⚠ THE RECORD LIVES IN ITS OWN CACHE, NOT IN THE VERSION CACHE — AND THE FIRST ATTEMPT PUT IT
   THERE AND WAS CAUGHT BY THE HARNESS. A synthetic entry alongside the precache makes the version
   cache hold 94 of 93 files, which breaks two things that are not decoration: test_sw_precache's
   "no holes left" count, and the owner panel's PER-CACHE ENTRY COUNT — the decisive measurement
   in SW_ACTIVATE_FIX_PLAN.md §11 for telling "install completed then the chain rejected" from
   "the 8 s budget expired". A diagnostic that reads 94/93 is worse than no diagnostic.
   Its own cache is invisible to both: the panel lists only /^thaiear-v\d+$/, and nothing serves
   from it (it is not in FALLBACK_CACHES, so a fetch can never resolve against it).
   ⚠ activate()'s sweep DELETES it, because it is not in the keep-list — deliberately left that
   way rather than adding an entry to a keep-list SW_ACTIVATE_FIX_PLAN.md §12 warns about at
   length. The record is per-version state, and activate rewrites it AFTER the sweep in the same
   chain, so the deletion is correct rather than tolerated. */
const GAPS_CACHE = 'thaiear-gaps';
const GAPS_KEY = '/__te_gaps';   // synthetic: never in PRECACHE, never requested by a page
/* Module scope, so it resets when the worker is torn down and re-booted — which is how the retry
   gets more than one chance without costing anything on a healthy device. */
let gapsRetriedThisBoot = false;
function putPendingGaps(gaps) {
  return caches.open(GAPS_CACHE).then(function (gc) {
    if (!gaps || !gaps.length) return gc.delete(GAPS_KEY);
    return gc.put(GAPS_KEY, new Response(JSON.stringify(gaps),
      { headers: { 'Content-Type': 'application/json' } }));
  }).catch(function () {});
}
function readPendingGaps() {
  return caches.open(GAPS_CACHE)
    .then(function (gc) { return gc.match(GAPS_KEY); })
    .then(function (r) { return r ? r.json() : []; })
    .then(function (a) { return Array.isArray(a) ? a : []; })
    .catch(function () { return []; });
}
/* Re-fetch outstanding gaps, tick off the ones that land, and persist what is left. Replaces the
   fire-and-forget addBatched() on the activate path so that a failure is REMEMBERED rather than
   dropped. Same batching, same per-item swallow — the only new behaviour is the bookkeeping. */
function retryGaps(c, gaps, width) {
  if (!gaps || !gaps.length) return putPendingGaps([]);
  var left = gaps.slice(), i = 0;
  function lane() {
    if (i >= gaps.length) return Promise.resolve();
    var u = gaps[i++];
    return c.add(u).then(function () {
      var at = left.indexOf(u);
      if (at > -1) left.splice(at, 1);
    }).catch(function () {}).then(lane);
  }
  var lanes = [];
  for (var n = 0; n < Math.min(width || 6, gaps.length); n++) lanes.push(lane());
  return Promise.all(lanes).then(function () { return putPendingGaps(left); });
}
function addBatched(c, urls, width) {
  var i = 0;
  function lane() {
    if (i >= urls.length) return Promise.resolve();
    var u = urls[i++];
    return c.add(u).catch(function () {}).then(lane);
  }
  var lanes = [];
  for (var n = 0; n < Math.min(width || 6, urls.length); n++) lanes.push(lane());
  return Promise.all(lanes);
}

/* ⚠ PRECACHE REPAIR (2026-08-09) — WHY A DEPLOY MUST NOT BE ABLE TO BREAK OFFLINE.
   install() fires one c.add() per PRECACHE entry and swallows every failure, and skipWaiting()
   activates the new worker whether or not they landed. activate() then DELETES the previous
   version's cache — which still held all of them. So one flaky install left permanent holes, and
   the device came out of the deploy WORSE offline than it went in, with nothing ever retrying.
   Reported 2026-08-09 after five VERSION bumps in a day: the Read hub rendered as unstyled plain
   text (read.css missing), lessons fell through to the offline page (read-*.html missing), and
   meditator.png had vanished from the playlists panel — all of them precache entries.
   Two-stage repair, in this order, because the first stage needs NO network and therefore works
   even when the new worker is picked up offline:
     1. fill any gap from the OUTGOING cache before deleting it — a deploy can then never lose
        content the device already had;
     2. re-fetch just those gaps once the old caches are gone, so a migrated (possibly stale) copy
        is replaced by the current one whenever there IS a connection.
   Only ever fills gaps — an entry the install DID land is never overwritten by an older copy. */
function precacheGaps(c) {
  var gaps = [];
  return Promise.all(PRECACHE.map(function (u) {
    return c.match(u).then(function (hit) { if (!hit) gaps.push(u); }).catch(function () { gaps.push(u); });
  })).then(function () { return gaps; });
}
function migrateGaps(c, gaps, olds) {
  if (!gaps.length || !olds.length) return Promise.resolve(gaps);
  return Promise.all(gaps.map(function (u) {
    return (function tryOld(i) {
      if (i >= olds.length) return Promise.resolve();
      return caches.open(olds[i])
        .then(function (oc) { return oc.match(u); })
        .then(function (hit) { return hit ? c.put(u, hit.clone()) : tryOld(i + 1); })
        .catch(function () { return tryOld(i + 1); });
    })(0);
  })).then(function () { return gaps; });
}

/* ⚠⚠ INSTALL MUST NOT BE ABLE TO FAIL, AND MUST NOT WAIT FOR THE WHOLE PRECACHE (2026-08-22).
   Until now skipWaiting() was chained BEHIND the full precache, so activation — the only thing
   that makes a new VERSION real — was gated on ~90 files completing. Two ways that leaves a
   device stranded on an old version with no way out, both reported live:

     1. THE INSTALL IS INTERRUPTED. On iOS the worker only runs while the PWA is foregrounded, so
        force-quitting mid-install aborts it. The owner force-closed ~15 times trying to force an
        update and was, each time, killing the very thing that would have delivered it.
     2. THE INSTALL REJECTS. `caches.open()` or a `c.add()` can fail outright — a storage quota
        hit is the obvious one, and this origin also holds `thaiear-dl` and `thaiear-audio-dl`,
        which are never version-wiped and grow with every offline download. A rejected waitUntil
        FAILS the install: the worker is discarded and retried only on the next update check, and
        it will fail again the same way. That state is invisible from the device and no amount of
        waiting or relaunching escapes it.

   So: race the precache against a budget, swallow everything, and skipWaiting() unconditionally.
   The precache is NOT cancelled when the budget wins — c.add() keeps filling the cache behind us.

   ⚠ THIS IS ONLY SAFE BECAUSE activate() ALREADY REPAIRS A HALF-FINISHED INSTALL (v258, see the
   PRECACHE REPAIR note above). It fills every gap from the OUTGOING cache with NO network, then
   deletes the old caches, then re-fetches those gaps opportunistically. That machinery was built
   for exactly this shape and until now could barely ever run, because install could only finish
   or be killed. Do not weaken activate() on the grounds that install "usually" completes.

   ⚠ The one ordering hazard, and why it is benign: activate() computes its gap list, so a file
   the racing precache lands a moment LATER can be overwritten by migrateGaps() with the older
   copy. Stage 3 then re-fetches precisely that gap list from the network, so it converges on the
   fresh copy. A stale entry can survive only until the next successful fetch, never permanently.

   8s is chosen to be longer than a healthy install on wifi and far shorter than a user's patience.
   It is a CEILING on time-to-activate, not a target. */
const INSTALL_BUDGET_MS = 8000;

self.addEventListener('install', function (e) {
  e.waitUntil(
    Promise.race([
      caches.open(CACHE).then(function (c) { return addBatched(c, PRECACHE, 6); }),
      new Promise(function (res) { setTimeout(res, INSTALL_BUDGET_MS); })
    ])
      // ⚠ Swallow EVERYTHING. A rejection here used to mean the version could never install.
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      // Keep the current shell cache, the persistent downloaded-PAGES cache ('thaiear-dl'), and the
      // downloaded-AUDIO cache ('thaiear-audio-dl', the web/PWA offline-audio store) — neither
      // downloads cache is ever version-wiped, so offline content survives an SW update.
      .then(function (keys) {
        var doomed = keys.filter(function (k) {
          return k !== CACHE && k !== VENDOR_CACHE && k !== 'thaiear-dl' && k !== 'thaiear-audio-dl';
        });
        return caches.open(CACHE).then(function (c) {
          return precacheGaps(c)
            // 1. rescue what the install missed from the cache we are about to delete (no network)
            .then(function (gaps) { return migrateGaps(c, gaps, doomed); })
            /* ⚠ THE RESCUE MUST NEVER GATE THE SWEEP (2026-08-23). precacheGaps/migrateGaps sit
               UPSTREAM of the deletes in one chain, so a rejection in either skipped every delete
               below AND everything after this block. Resolve to an empty gap list instead: a
               rescue that failed is worth nothing, while a sweep that never runs leaves a leftover
               cache that only the NEXT deploy can clear — days or weeks on a real user's cadence.
               ⚠ This does NOT address the other suspect, a worker TERMINATED mid-copy: nothing
               rejects there, execution simply stops. See SW_ACTIVATE_FIX_PLAN.md §6. */
            .catch(function () { return []; })
            // 2. only now is it safe to drop the old versions
            .then(function (gaps) {
              /* ⚠ PER-ITEM catch (2026-08-22). This was a bare Promise.all, so ONE rejecting
                 caches.delete() rejected the whole thing — and everything downstream of it is in
                 the same chain: the thaiear-dl poison repair, navigationPreload.enable(), and
                 clients.claim(). A single stubborn cache could therefore leave the new worker
                 controlling NOTHING, which is the same class of failure as the install that could
                 not activate (v411). A delete that fails is worth nothing; a claim that never
                 happens costs the whole release. Swallow per entry. */
              return Promise.all(doomed.map(function (k) {
                return caches.delete(k).catch(function () {});
              }))
                .then(function () {
                  /* 3. refresh the rescued copies — ⚠ DELIBERATELY NOT RETURNED, so activation
                     does NOT wait for it. Returning it (v258) was a serious regression: OFFLINE
                     every gap is a fetch that HANGS for many seconds, and with ~73 gaps after a
                     failed install that kept waitUntil pending for minutes — during which
                     clients.claim() below had not run, so the new worker controlled nothing and
                     every request bypassed the SW straight into a dead network. That is what the
                     owner saw on 2026-08-09: downloaded topics taking 5-6s to open, a totally
                     white screen, auth flickering signed-out-then-back-in, and playlist writes
                     failing because currentUser was still null.
                     The content is already correct at this point — stage 1 migrated it out of the
                     outgoing cache with no network — so this is purely an opportunistic
                     freshening and must never gate activation.
                     ⚠ 2026-09-19 — AND IT IS NO LONGER THE ONLY ATTEMPT. The list is written down
                     FIRST, so a worker killed mid-refresh still leaves the record behind; whatever
                     does not land here is retried on a later navigation (see the fetch handler).
                     Still not returned, still opportunistic — the change is that a failure is now
                     remembered instead of dropped. */
                  putPendingGaps(gaps)
                    .then(function () { return retryGaps(c, gaps, 6); })
                    /* ⚠ A TRAILING CATCH, THOUGH NOTHING HERE IS AWAITED. This chain is
                       fire-and-forget, so a rejection has no one to handle it and would surface
                       as an unhandled rejection inside the worker — noise at best, and on some
                       engines a reason to consider the worker unhealthy. */
                    .catch(function () {});
                });
            });
        });
      })
      /* ⚠ NOTHING UPSTREAM MAY COST THE CLAIM (2026-08-23). v425 added a per-item catch to
         caches.delete() for exactly this reason, but left the same hole one step higher: a
         rejection from caches.keys() or caches.open(CACHE) still skipped the sweep, the thaiear-dl
         poison repair, navigationPreload.enable() AND clients.claim() below.
         ⚠ A rejected activate waitUntil still marks the worker ACTIVATED, so that failure presents
         as the exact state observed on 2026-08-22: newest version active and controlling, nothing
         deleted. Swallow it — every step downstream is independent of this one. */
      .catch(function () {})
      /* ⚠ REPAIR THE POISONED `thaiear-dl` (2026-08-12). See the long note in the fetch handler:
         cachePage() used to copy the shared SCRIPTS into this never-version-wiped cache, where
         they then shadowed every fresh copy forever. Fixing the lookup stops the bleeding for new
         installs; this evicts the copies already sitting on people's devices, which is what
         actually repairs the owner's broken index.
         ⚠ ONLY evicts an entry once the CURRENT version cache is confirmed to hold that file, so
         this can never take away an offline fallback — worst case it does nothing. Pages (the
         reason this cache exists) and audio-versions.json are untouched: only the shared scripts,
         which are all PRECACHE entries and therefore guaranteed present in CACHE. Deliberately not
         returned into waitUntil's chain would be wrong here — it is cache-only work with no
         network, so it is safe to await and we want it done before clients.claim(). */
      .then(function () {
        var POISONED = ['/topics.js', '/player.js', '/nav.js', '/auth.js', '/footer.js'];
        return caches.open('thaiear-dl').then(function (dl) {
          return caches.open(CACHE).then(function (c) {
            return Promise.all(POISONED.map(function (u) {
              return c.match(u).then(function (fresh) {
                return fresh ? dl.delete(u) : null;   // never evict what CACHE cannot replace
              }).catch(function () {});
            }));
          });
        }).catch(function () {});
      })
      /* NAVIGATION PRELOAD (2026-08-11) — the fix for "a topic I have NOT opened before takes a
         few seconds in the app/PWA, but is instant in the phone browser".
         With a controlling worker, a navigation cannot start until the worker is RUNNING, and in a
         standalone PWA / Capacitor WebView the worker is usually terminated between visits. So the
         cost was serialised: boot sw.js, THEN begin the network request. A browser tab with no
         controlling worker just issues the request, which is exactly why it felt fast there.
         Preload tells the browser to start the navigation request IN PARALLEL with booting the
         worker, so the cost becomes max(boot, network) instead of boot + network. Nothing else
         changes — the fetch handler simply uses e.preloadResponse when it is there.
         Local registration setting, NOT a network call, so it cannot violate the
         "nothing in activate may await the network" rule above. Guarded because iOS Safari only
         gained support in 17; where it is absent, preloadResponse is undefined and the handler
         falls back to its own fetch(). */
      .then(function () {
        if (self.registration && self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable().catch(function () {});
        }
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ══ "WHICH VERSION ARE YOU?" ══════════════════════════════════════════════════════════════
   The page cannot work this out on its own, and that gap has cost real time twice.
   navigator.serviceWorker.getRegistration() hands back .installing/.waiting/.active, but every
   one of them has the same scriptURL ('/sw.js') — the VERSION lives only in here. And listing
   caches.keys() from the page, which the owner panel used to do alone, answers a DIFFERENT
   question: it shows every thaiear-vN cache present, active and orphaned alike, with no way to
   tell them apart. That is why "my PWA is showing four versions at once" was unanswerable.

   ⚠ AN ORPHANED CACHE IS NORMAL AT A FAST RELEASE CADENCE, and that is the thing the panel now
   makes visible rather than alarming. caches.open(CACHE) CREATES thaiear-vN before a single file
   is fetched, and only activate() ever deletes old caches. So a worker that is superseded before
   it activates — install v417, discover v418 mid-install, v417 goes redundant — leaves its cache
   behind with nothing to collect it. Ship four versions in an afternoon and several can pile up
   without anything being wrong. What WOULD be wrong is the active version lagging the newest
   installed one, which is exactly what this reply lets the panel say out loud.

   Deliberately tiny and side-effect free: it reads two constants and replies. */
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d) return;
  if (d === 'te-version' || d.type === 'te-version') {
    /* Reply down the SAME port the page opened where there is one (MessageChannel), else to the
       client that asked. The port form is what lets the page await a single answer instead of
       listening globally and hoping. */
    var payload = { te: 'version', version: VERSION, cache: CACHE };
    if (e.ports && e.ports[0]) { e.ports[0].postMessage(payload); return; }
    if (e.source && e.source.postMessage) e.source.postMessage(payload);
    return;
  }
  /* Let the owner panel promote a waiting worker without a reload dance. Only ever reachable from
     our own page, and skipWaiting() is what install() already calls unconditionally — this just
     lets a human trigger it on demand while testing. */
  if (d === 'te-skip-waiting' || d.type === 'te-skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Cross-origin: cache the Supabase ESM bundle (esm.sh) cache-first, so auth works offline (the
  // import is pinned to @2, so a stable cached copy is fine); leave audio & the rest alone.
  // (Fonts used to be Google-hosted and cached here; they're self-hosted now — handled same-origin.)
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'esm.sh') {
      /* Stale-while-revalidate out of the SURVIVING vendor cache (see VENDOR_CACHE above).
         Cache-first so offline auth works instantly; the background refresh keeps the pinned @2
         copy current without there ever being a moment when it is absent. The revalidate must
         swallow its own failure — offline it always rejects, and an uncaught rejection here would
         surface as an SW error on every page load. */
      e.respondWith(
        caches.open(VENDOR_CACHE).then(function (c) {
          return c.match(req).then(function (hit) {
            var net = fetch(req).then(function (res) {
              if (res && res.ok) { try { c.put(req, res.clone()); } catch (_) {} }
              return res;
            }).catch(function () { return null; });
            if (hit) return hit;                     // serve at once, refresh behind it
            return net.then(function (res) { return res || Response.error(); });
          });
        })
      );
    }
    return;
  }

  if (url.pathname.indexOf('/api/') === 0) return;  // never cache API calls
  if (/\.apk$/i.test(url.pathname)) return;         // don't intercept/cache the APK download

  /* ⚠ PRECACHED SUB-RESOURCES ARE CACHE-FIRST (2026-08-11). Do not "restore" them to network-first.
     These are the version-keyed shell files — player.js, auth.js, topics.js, nav.js, the CSS, the
     fonts, the icons. Bumping VERSION is what invalidates them: activate() re-seeds the new cache
     from the network, which is the entire point of a version-keyed precache. Revalidating them on
     every request bought nothing and cost a network round-trip each.

     What it cost, measured on a topic page in a real browser: player.js reported transferSize 0 —
     a worker response — yet a duration of 3534 ms, because the worker was fetching all 457 KB from
     the network before answering. Roughly 350 KB of precached JS behaved that way on EVERY
     navigation, serialised behind the HTML, so scripts did not begin until ~3 s and load landed at
     8.2 s on DESKTOP. The owner reported topic pages taking "a few seconds" to open specifically in
     the iPhone PWA and the Android app, and fine in desktop Edge — the same work on a phone CPU and
     a WebView fetch.

     NAVIGATIONS ARE DELIBERATELY EXCLUDED. Pages stay network-first so the tandem-update model
     holds and an online visitor always gets fresh content. This only changes sub-resources whose
     freshness is already governed by VERSION.

     THE DEPENDENCY THIS CREATES: if you change a precached file you MUST bump VERSION, or clients
     keep the old copy. That was already the standing rule (see the PRECACHE note above); this makes
     it load-bearing rather than merely tidy. */
  /* ⚠⚠ LOOK IN `CACHE` ONLY — NEVER `caches.match()` (fixed 2026-08-12, and this was a REAL BUG
     that shipped with v292, not a theoretical one).
     `caches.match(req)` with no cacheName searches EVERY cache in CREATION ORDER, and
     `thaiear-dl` is never version-wiped by design. player.js's cachePage() used to copy
     `/topics.js`, `/player.js`, `/nav.js`, `/auth.js` and `/footer.js` into it, so on any device
     that had ever downloaded a topic, `thaiear-dl` was created BEFORE the current version cache
     and therefore WON every lookup. Those five files were frozen at whenever cachePage() last
     ran, and no VERSION bump could ever dislodge them — the entire point of a version-keyed
     precache, silently defeated for exactly the users who use the app most.
     It could not even self-heal: cachePage()'s `c.add('/topics.js')` fetches THROUGH this handler,
     which served the stale thaiear-dl copy straight back into thaiear-dl.
     Symptom it produced (owner, 2026-08-12): a stale topics.js against fresh CSS on the index —
     retired "coming soon" topics reappearing at the bottom of the grid and comically oversized
     padlock SVGs. Anything that depends on a shared script matching the page it ships with can
     surface this way, so treat "impossible" staleness on ONE device as this first.
     `thaiear-dl`'s correct role is OFFLINE FALLBACK — it is still searched by cacheFallback() and
     positiveCacheMatch() when the network actually fails. It must never shadow a live lookup. */
  if (req.mode !== 'navigate' && PRECACHE_PATHS.has(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then(function (c) { return c.match(req); }).then(function (hit) {
        if (hit) return hit;
        // Not seeded yet (install still running, or a partial install): fetch and store it.
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          noteNetUp();
          return res;
        }).catch(function () { noteNetDown(); return cacheFallback(req, url); });
      })
    );
    return;
  }

  /* ── RETRY THE PRECACHE HOLES A PREVIOUS ACTIVATE COULD NOT FILL (2026-09-19) ──────────────
     ONCE PER WORKER BOOT, ON A NAVIGATION, AND ONLY IF A RECORD EXISTS. In a PWA or the app the
     worker is terminated between visits, so "once per boot" is in practice "every so often, while
     someone is using the site" — which is exactly the cadence wanted: frequent enough to catch the
     next moment of decent signal, rare enough to cost nothing.
     ⚠ waitUntil, NEVER the response path (SW_ACTIVATE_FIX_PLAN.md §12 requirement 2): it starts
     after respondWith has been handed its promise, so a throw here cannot affect a page load, and
     the whole thing is wrapped besides.
     ⚠ THE COMMON CASE MUST BE FREE. A healthy device has no record, so this costs exactly one
     cache.match that misses, once per boot, and never touches the network.
     ⚠ Narrower width than activate's: a navigation is a moment the user is waiting on something
     else, and there is no hurry — anything not taken this time is still on the list. */
  if (req.mode === 'navigate' && !gapsRetriedThisBoot) {
    gapsRetriedThisBoot = true;
    try {
      e.waitUntil(readPendingGaps().then(function (g) {
        if (!g.length) return null;                       // the healthy case: one miss, no network
        return caches.open(CACHE).then(function (c) { return retryGaps(c, g, 3); });
      }).catch(function () {}));
    } catch (_) {}
  }

  // Same-origin pages + assets: network-first for freshness (preserves the tandem-update model),
  // but capped by NET_TIMEOUT_MS. Offline, the WebView's fetch can hang for many seconds before it
  // rejects — which made cached pages slow to appear. So if the network hasn't answered in time AND
  // we have the resource cached, serve the cache immediately while the network keeps running in the
  // background to refresh it (stale-while-revalidate). On a real network failure, fall back fully.
  e.respondWith((function () {
    /* probeOnly: report recovery but DO NOT touch the cache. Used by the offline fast path below,
       which has already handed the CACHED response to the page. Writing the same entry while its
       body is still streaming can abort that read in WebKit — surfacing as a blob error page on
       navigation (owner saw one once, tapping the logo in airplane mode just after an update).
       The next request that goes through the normal path caches as usual, so nothing goes stale;
       this only removes a write that was racing a read for no benefit. */
    function fromNetwork(probeOnly) {
      /* Use the navigation-preload response when the browser has one in flight (see the note in
         activate). It was started in parallel with booting this worker, so it is already ahead of
         anything fetch() could begin now. Resolves to undefined when preload is unsupported or
         this is not a navigation — then we issue the request ourselves exactly as before.
         ⚠ It must be consumed or the browser warns about an unused preload response. */
      var started = (req.mode === 'navigate' && e.preloadResponse)
        ? e.preloadResponse.then(function (pre) { return pre || fetch(req); }, function () { return fetch(req); })
        : fetch(req);
      return started.then(function (res) {
        noteNetUp();
        if (!probeOnly && res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          cleanRedirect(copy).then(function (clean) { caches.open(CACHE).then(function (c) { c.put(req, clean); }); });
        }
        /* ⚠ THE BROWSER NEEDS THE CLEANED RESPONSE TOO, NOT JUST THE CACHE.
           Until 2026-08-21 cleanRedirect() was applied only to the COPY being stored, so a
           navigation that went down this path was handed the redirected Response itself — and a
           redirected Response cannot be used for a navigation request. WebKit shows it as a blob
           error page (the same symptom the probeOnly flag was added for, further down).
           It bit on the PWA the moment the home page moved: the nav logo pointed at
           /index.html, Cloudflare Pages 308s that to /, and any navigation that missed the cache
           — a fresh worker after a VERSION bump, say — died instead of loading. Every redirected
           navigation was exposed, not just this one; the cache hit path simply hid it most of the
           time. cleanRedirect() returns the response untouched when it was not redirected, so
           this costs nothing in the normal case. */
        return (req.mode === 'navigate') ? cleanRedirect(res) : res;
      }, function (err) { noteNetDown(); throw err; });
    }
    /* ⚠ FAST PATH — the network is already known to be down, so do NOT pay NET_TIMEOUT_MS again.
       This is what made every offline page load slow (owner, 2026-08-09: a downloaded topic taking
       "5 or 6 seconds to open", and "issues each time airplane mode is on" rather than once after a
       deploy). Each same-origin request waited the full 2 s before falling back to cache, and a page
       is many requests in waves, so the cost stacked on EVERY load — the worker re-discovered the
       outage per resource instead of remembering it.
       Cache-first here, with the network still fired in the background so recovery is noticed and
       the copy refreshes. Falls through to the normal path on a cache miss, so nothing that is not
       cached is answered any less correctly. */
    if (netLooksDown()) {
      return positiveCacheMatch(req, url).then(function (hit) {
        if (!hit) return fromNetwork().catch(function () { return cacheFallback(req, url); });
        fromNetwork(true).catch(function () {});   // recovery PROBE only — never writes the entry we are serving
        return cleanRedirect(hit);
      });
    }

    /* ⚠⚠ STALE-WHILE-REVALIDATE FOR TOPIC PAGES + THE PRECACHED SHELL (2026-08-12) — why opening
       a topic was "intermittently slow, sometimes fast", and why Home was never instant either.
       Navigations were network-first with no exception, so the SW's own cached copy was NEVER used
       while online. Measured on the live site with the page sitting in thaiear-v293 and the worker
       already warm (workerStart 6 ms): TTFB 1569 ms, load 2950 ms. The cache was right there and
       was skipped. Every topic open therefore paid a live origin round trip — and Cloudflare
       returns `cf-cache-status: DYNAMIC` for HTML, so it is never edge-cached and its latency
       swings (219 ms → 2409 ms measured on one machine in one minute). Above NET_TIMEOUT_MS the
       worker gave up and served the cache INSTANTLY, so the same page alternated between instant
       and ~2 s purely on network jitter. That oscillation was the reported symptom.

       ⚠ THE SAFETY PROPERTY IS THAT WE LOOK IN `CACHE` ONLY — the version-keyed cache — and NOT
       via caches.match(), which would also search `thaiear-dl`. Topic pages are deliberately not
       precached, and activate() deletes every non-current cache, so a VERSION bump leaves CACHE
       with NO topic pages in it: the first visit to each topic after a deploy is always a network
       fetch. That makes it impossible for this path to serve pre-deploy content, which is what
       keeps the tandem text/audio model intact. `thaiear-dl` survives deploys BY DESIGN, so it
       must stay out of the instant path — it keeps its existing role as the offline fallback
       reached through cacheFallback().

       The PRECACHED SHELL pages (Home, the 13 read pages, about/guide/account/…) join this path
       for the same reason and with a stronger guarantee — see isInstantNav() above. 29 navigable
       pages were sitting in this very cache and still paying a network round trip on every open. */
    if (isInstantNav(req, url)) {
      return caches.open(CACHE)
        .then(function (c) {
          /* ⚠ TRY THE .html <-> CLEAN VARIANT TOO, or this path silently does nothing for the
             pages it was added for. Cloudflare Pages serves /about, but PRECACHE (and therefore
             the cache KEY) is '/about.html' — so matching the request URL alone missed on every
             real navigation, fell through to the network, and looked exactly like success.
             Same reasoning as positiveCacheMatch(); this one is scoped to CACHE on purpose. */
          return c.match(req, { ignoreSearch: true }).then(function (hit) {
            if (hit) return hit;
            var p = url.pathname;
            var alt = p.slice(-5) === '.html' ? p.slice(0, -5) : p + '.html';
            return c.match(alt, { ignoreSearch: true });
          });
        })
        .then(function (hit) {
          if (!hit) return networkFirstWithTimeout();   // first visit this VERSION → normal path
          /* ⚠ THE REVALIDATE WRITE IS DELAYED, AND THAT IS NOT COSMETIC. We have just handed the
             page this cached Response; overwriting the same cache entry while its body is still
             streaming can abort that read in WebKit — the exact bug the probeOnly flag above was
             added for (it surfaced as a blob error page on navigation). fromNetwork(true) fetches
             WITHOUT writing (and consumes e.preloadResponse, so no "unused preload response"
             warning), then we write once the body has certainly been consumed. */
          try {
            e.waitUntil(fromNetwork(true).then(function (res) {
              if (!res || !res.ok || res.type !== 'basic') return;
              return cleanRedirect(res.clone()).then(function (clean) {
                return new Promise(function (done) {
                  setTimeout(function () {
                    caches.open(CACHE)
                      .then(function (c) { return c.put(req, clean); })
                      .catch(function () {})
                      .then(done, done);
                  }, REVALIDATE_WRITE_DELAY_MS);
                });
              });
            }).catch(function () {}));
          } catch (_) {}
          return cleanRedirect(hit);
        });
    }

    return networkFirstWithTimeout();

    function networkFirstWithTimeout() {
      var network = fromNetwork();
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          /* Did not answer in time — remember that, so the NEXT request skips the wait entirely.
             Deliberately also on a TIMEOUT, not just a rejection: offline in this WebView a fetch
             usually hangs rather than failing, so waiting for the rejection would never teach us
             anything in the case that matters most. */
          noteNetDown();
          positiveCacheMatch(req, url).then(function (hit) {
            if (hit && !settled) { settled = true; resolve(cleanRedirect(hit)); }
          });
        }, NET_TIMEOUT_MS);
        network.then(
          function (res) { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } },
          function () { if (!settled) { settled = true; clearTimeout(timer); resolve(cacheFallback(req, url)); } }
        );
      });
    }
  })());
});
