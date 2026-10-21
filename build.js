#!/usr/bin/env node
/* build.js — the Cloudflare Pages build step for thaiear.com (LOADING_SPEED.md §1.6, 2026-10-21).
 *
 *   node build.js             strip the comments from every root-level *.js, IN PLACE (what Pages runs)
 *   node build.js --check     print what each file would shrink to; write nothing
 *   node build.js --out DIR   write the stripped files into DIR instead (local verification)
 *
 * WHY. Two-thirds of what a cold visit downloads is our own prose: player.js is 941 KB raw /
 * 322 KB gzipped on the wire, and 104 KB gzipped once the comments are gone — the ten precached
 * scripts together go from ~715 KB to ~210 KB. The comments are load-bearing for the people who
 * edit these files, so they stay in git; only the DEPLOYED copy loses them. The service worker
 * precaches these files on every install, so the saving lands on every first visit AND on every
 * release's precache refresh.
 *
 * HOW. esbuild's transform with NO minification: comments dropped, `esnext` target so no syntax
 * is rewritten, utf-8 charset so Thai strings stay Thai (the default escapes them to \uXXXX,
 * which is both bigger and unreadable in devtools). Names, strings and statement order are
 * untouched, so the harnesses that slice functions out of these files by name still find them
 * in the deployed copy as well as the source.
 *
 * SAFETY. Any failure exits non-zero, so a bad build ships NOTHING (Pages keeps the previous
 * deployment). Every output is parsed again before it is written, must be smaller than its
 * input, and must still carry the markers a release depends on (sw.js's VERSION, player.js's
 * DYN_BUILD). Idempotent: a file that already carries the header is left alone.
 *
 * esbuild is fetched into the OS temp dir at build time (pinned), never into the repo: a
 * node_modules folder in the repo root would be deployed as site files.
 *
 * ⚠ LOCAL SERVING IS UNSTRIPPED. `python -m http.server 8788` serves the sources; only the
 * deployed site is stripped. The two behave identically — that is what the verification in
 * LOADING_SPEED.md §1.6 established — but byte sizes measured locally are the source's.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const cp = require('child_process');

const ESBUILD = '0.24.2';                       // the version build_supabase_vendor.js is pinned to
const ROOT = __dirname;
const HEADER = '// Deployed copy: comments stripped by build.js. The commented source is in the repository.\n';
const SELF = path.basename(__filename);
// Markers a release depends on: the file must still contain them after the strip. Quote-agnostic:
// esbuild re-prints string literals with double quotes.
const MUST_KEEP = {
  'sw.js': [/const VERSION = ["']v\d+["']/, /const PRECACHE = \[/],
  'player.js': [/var DYN_BUILD = ["']r\d+/],
};

const args = process.argv.slice(2);
const check = args.indexOf('--check') >= 0;
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1] || '') : null;
if (outIdx >= 0 && !outDir) { console.error('--out needs a directory'); process.exit(2); }

function loadEsbuild() {
  const work = path.join(os.tmpdir(), 'thaiear-build-esbuild-' + ESBUILD);
  const mod = path.join(work, 'node_modules', 'esbuild');
  try { const e = require(mod); if (e.version === ESBUILD) return e; } catch (_) {}
  fs.mkdirSync(work, { recursive: true });
  console.log('build.js: installing esbuild@' + ESBUILD + ' into ' + work);
  cp.execSync('npm install --no-audit --no-fund --no-package-lock --prefix "' + work + '" esbuild@' + ESBUILD,
    { stdio: 'inherit', cwd: work });
  const e = require(mod);
  if (e.version !== ESBUILD) throw new Error('esbuild ' + e.version + ' loaded, wanted ' + ESBUILD);
  return e;
}

function gzipSize(s) { return require('zlib').gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).length; }

function stripOne(esbuild, name, src) {
  const res = esbuild.transformSync(src, {
    loader: 'js', target: 'esnext', charset: 'utf8', legalComments: 'none',
    minify: false, sourcemap: false, logLevel: 'error', sourcefile: name,
  });
  const out = HEADER + res.code;
  // It must parse (as a classic script: these files are not modules), and keep its markers.
  new vm.Script(res.code, { filename: name });
  (MUST_KEEP[name] || []).forEach(function (m) {
    if (!m.test(out)) throw new Error(name + ': marker missing after strip: ' + m);
  });
  // A file with nothing to strip (a data file) can come back LARGER from the re-print: keep the source.
  if (out.length >= src.length) return null;
  return out;
}

function writeAtomic(file, text) {
  const tmp = file + '.build-tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function main() {
  const files = fs.readdirSync(ROOT).filter(function (f) {
    return /\.js$/.test(f) && f !== SELF && fs.statSync(path.join(ROOT, f)).isFile();
  }).sort();
  if (!files.length) throw new Error('no *.js files found beside build.js');
  const esbuild = loadEsbuild();
  let rawIn = 0, rawOut = 0, gzIn = 0, gzOut = 0, done = 0, skipped = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  files.forEach(function (name) {
    const file = path.join(ROOT, name);
    const src = fs.readFileSync(file, 'utf8');
    if (src.slice(0, HEADER.length) === HEADER) { skipped++; console.log('  = ' + name + ' (already stripped)'); return; }
    const out = stripOne(esbuild, name, src);
    if (out == null) { skipped++; console.log('  = ' + name + ' (nothing to strip: kept as is)'); if (outDir) writeAtomic(path.join(outDir, name), src); return; }
    const gi = gzipSize(src), go = gzipSize(out);
    rawIn += src.length; rawOut += out.length; gzIn += gi; gzOut += go;
    console.log('  ' + (check ? '? ' : '✓ ') + name.padEnd(26) + String(Math.round(src.length / 1024)).padStart(5) + ' → ' +
      String(Math.round(out.length / 1024)).padStart(4) + ' KB raw   ' + String(Math.round(gi / 1024)).padStart(4) + ' → ' +
      String(Math.round(go / 1024)).padStart(4) + ' KB gzip');
    if (!check) writeAtomic(outDir ? path.join(outDir, name) : file, out);
    done++;
  });
  console.log('build.js: ' + done + ' file(s) ' + (check ? 'measured' : outDir ? 'written to ' + outDir : 'stripped in place') +
    (skipped ? ', ' + skipped + ' left as is' : '') + ' — ' + Math.round(rawIn / 1024) + ' → ' + Math.round(rawOut / 1024) +
    ' KB raw, ' + Math.round(gzIn / 1024) + ' → ' + Math.round(gzOut / 1024) + ' KB gzip');
}

try { main(); }
catch (e) { console.error('build.js FAILED: ' + (e && e.stack || e)); process.exit(1); }
