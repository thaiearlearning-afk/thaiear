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

## supabase-js-2.117.3.js — @supabase/supabase-js 2.117.3 (since sw v847, 2026-10-15)

- Built, not copied: `node build_supabase_vendor.js` (tooling repo root) npm-installs the pinned
  version into `_vendor_build/` and bundles it with esbuild (one ESM file, browser, es2017,
  minified). `--check` rebuilds in memory and compares. The banner lists the exact sub-packages.
- Upstream: https://github.com/supabase/supabase-js. Licence: **MIT** (notice in the banner).
- Used by: `/auth.js` (`SUPABASE_ESM`, its one `import()`), replacing esm.sh's ~25-request chain.
  `/sw.js` keeps it in the never-swept `thaiear-vendor` cache (`SUPABASE_BUNDLE`) for offline
  sign-in. `_headers` lets browsers keep it a year (`immutable`): the version is in the name.
- Upgrading is a separate decision: change `VERSION` in the build script, re-run, and move the
  name in `auth.js` and `sw.js` together (`test_supabase_vendor.js` fails until all three agree).
  Never put new bytes under an existing name. Map: `LOADING_SPEED.md` §0 row H, §2.
