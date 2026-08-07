# /live/vendor

Third-party code shipped verbatim. Nothing in here is edited — if a version needs changing,
re-fetch the release and replace the file whole, so the licence terms below stay true.

## lame.min.js — lamejs 1.2.1

- Source: `npm pack lamejs@1.2.1` → `package/lame.min.js`, copied unmodified (156 KB).
- Upstream: https://github.com/zhuker/lamejs (a JS port of the LAME MP3 encoder).
- Licence: **LGPL** — `LAME-LICENSE.txt`, copied from the same package.
- Used by: `/mp3-worker.js` (via `importScripts`), which is driven by `/mp3-export.js`.

Loading shape: the file ends in a bare `lamejs()` self-invocation that attaches `Mp3Encoder` to
the global `lamejs` function object. It is a **classic script**, not an ES module — `require()`
in Node will appear to do nothing, because the top-level `function lamejs(){}` lands in the
module scope instead of the global one. Load it with a `<script>` tag or `importScripts`.

**LGPL compliance note.** The library is shipped as a separate, unmodified file, dynamically
loaded at runtime, with its licence text alongside — the arrangement the LGPL is written for.
Keep it that way: do not inline, bundle, minify-with, or hand-patch it. If it ever needs a fix,
prefer working around it in `mp3-export.js`.

Measured throughput (2026-08-07, node/V8): 900 s of mono 44.1 kHz at 64 kbps encodes in 94.0 s
and produces 6.87 MB. That figure is why `mp3-export.js` runs several encode lanes in parallel.
