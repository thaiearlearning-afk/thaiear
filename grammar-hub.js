/* grammar-hub.js — RETIRED 2026-08-29. This file is a deliberate no-op TOMBSTONE, not code.

   It used to inject the "Grammar by Ear" tile into #tp-bands on /topics for one account only,
   behind a SHA-256 owner gate, while the section was unlisted. The section went public on
   2026-08-29: the tile is static HTML in gen_topics_pages.js now, which is both what stops the
   page shifting under a late insert and what makes it a crawlable internal link.
   Full account: STRUCTURES_SECTION_PLAN.md §12.

   ⚠⚠ WHY AN EMPTY FILE INSTEAD OF A DELETION — THIS IS THE POINT, DO NOT "TIDY IT AWAY".
   Cloudflare Pages applies adds and edits reliably and DELETIONS UNRELIABLY: `git rm` + push
   deployed fine and the removed path kept returning 200 from the edge, on cache-busted requests
   too (observed 2026-06-27, and again with this very file — it was `git rm`'d in the go-live
   commit and was still being served minutes after the deploy landed). A `_redirects` rule does
   not help either: a ghost static asset takes precedence over redirects. Overwriting the path is
   the move that works, because it is an EDIT.

   So this stub exists to make the old script unreachable in the only way the platform honours.
   Nothing references it — no page emits the tag any more — and it is NOT precached, so it costs
   no sw.js VERSION bump. It can be deleted for real once the edge no longer holds the old copy;
   until someone has checked that, deleting it puts the previous version back in front of every
   visitor. */
