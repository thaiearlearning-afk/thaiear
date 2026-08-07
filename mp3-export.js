/* mp3-export.js — PCM → tagged MP3, for the desktop download (2026-08-07).
   Plain script, no modules, no build step — same IIFE style as dl-core.js. Exposes ThaiEarMp3.

   ─────────────────────────────────────────────────────────────────────────────────────────────
   WHY MP3 AT ALL, when the player already produces a smaller, better file.
   The dyn player encodes sessions as AAC-in-MP4 or Opus-in-Ogg (player.js DYN_ENC_TIERS) — both
   better codecs than MP3 at these bitrates. Neither is the right DELIVERY format for this
   feature. The audience is people without phones, downloading to a PC and often moving the file
   onto whatever hardware they own. MP3 is the only format a cheap USB player, a car head unit or
   a CD player is guaranteed to read; its patents expired in 2017; every OS plays it natively.
   Codec quality is not the constraint here — "does it play on the thing they own" is.

   WHY 44.1 kHz WHEN THE SOURCE IS 24 kHz.
   MP3 at 24 kHz is MPEG-2 Layer III (LSF). Software plays it everywhere, but cheap hardware
   decoders are frequently MPEG-1 only. Resampling up to 44.1 kHz makes the output MPEG-1, the
   most broadly decodable variant there is — and it is FREE in file size, because MP3 size is set
   by bitrate, not sample rate. It costs encode time (1.8× the samples) and nothing else. There
   is no quality gain from the upsample and none is claimed; there is no loss either, since LAME
   lowpasses around 11 kHz at this bitrate and the source has nothing above 12 kHz.

   WHY PARALLEL LANES.
   Measured 2026-08-07: 900 s of 44.1 kHz mono at 64 kbps takes 94 s to encode single-threaded.
   That is too long to sit through once, and unusable for the batch download that is planned
   next. So the PCM is cut into lanes encoded concurrently in workers and concatenated.

   ⚠ THE CUTS ARE NOT ARBITRARY — this is the part to not "simplify". Each lane is an independent
   MP3 stream, so each carries LAME's own encoder delay at its head and frame padding at its tail.
   Concatenating them inserts roughly 20–40 ms of silence at every join. Cutting anywhere inside
   speech would put that gap mid-word. So the caller passes `boundaries` — the sentence-block ends
   from the dyn build's own map, each of which sits at the far end of a 3-second inter-sentence
   gap. A 30 ms lengthening of an existing 3 s pause is inaudible by construction. With no
   boundaries supplied this falls back to a SINGLE lane rather than guessing: slow is acceptable,
   a glitch in the middle of a word is not.
   ───────────────────────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var FRAME = 1152;             // MPEG Layer III granule pair — lanes must start on a multiple
  var OUT_RATE = 44100;         // MPEG-1. See the header note.
  var BITRATE = 64;             // kbps mono. ~480 KB/min; near-transparent for 24 kHz speech.
  var MAX_LANES = 4;

  function supported() {
    return typeof Worker === 'function' &&
           !!(window.OfflineAudioContext || window.webkitOfflineAudioContext);
  }

  // ── resample ────────────────────────────────────────────────────────────────────────────────
  /* OfflineAudioContext is the only resampler in the platform, and it is a good one. Rendering a
     15-minute buffer is ~1 s. Returns the input untouched when the rates already match, so a
     future change to DYN_SR costs nothing here. */
  function resample(pcm, fromRate, toRate) {
    if (fromRate === toRate) return Promise.resolve(pcm);
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var outLen = Math.ceil(pcm.length * toRate / fromRate);
    var ctx = new OAC(1, outLen, toRate);
    var src = ctx.createBufferSource();
    // A buffer may be created at a rate the context does not run at — that mismatch is exactly
    // what makes the graph resample it.
    var buf = ctx.createBuffer(1, pcm.length, fromRate);
    buf.copyToChannel ? buf.copyToChannel(pcm, 0) : buf.getChannelData(0).set(pcm);
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return ctx.startRendering().then(function (rendered) { return rendered.getChannelData(0); });
  }

  function toInt16(f32) {
    var n = f32.length, out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var x = f32[i];
      x = x < -1 ? -1 : (x > 1 ? 1 : x);
      out[i] = x < 0 ? x * 0x8000 : x * 0x7FFF;
    }
    return out;
  }

  // ── lane planning ───────────────────────────────────────────────────────────────────────────
  /* Pick up to `lanes-1` cut points from the SAFE list, choosing the safe point nearest each
     ideal even division. Cuts are snapped down to a frame multiple (a lane that starts mid-frame
     would shift every subsequent frame header). Returns ascending sample offsets, first = 0. */
  function planCuts(total, safe, lanes) {
    if (lanes < 2 || !safe || !safe.length) return [0];
    var cuts = [0], used = {};
    for (var k = 1; k < lanes; k++) {
      var ideal = Math.round(total * k / lanes), best = -1, bestD = Infinity;
      for (var i = 0; i < safe.length; i++) {
        var s = Math.floor(safe[i] / FRAME) * FRAME;
        if (s <= 0 || s >= total || used[s]) continue;
        var d = Math.abs(s - ideal);
        if (d < bestD) { bestD = d; best = s; }
      }
      // Refuse a cut that would leave a runt lane — it buys no wall-clock and adds a join.
      if (best < 0 || bestD > total / lanes) continue;
      used[best] = true; cuts.push(best);
    }
    cuts.sort(function (a, b) { return a - b; });
    return cuts;
  }

  // ── ID3v2.3 ─────────────────────────────────────────────────────────────────────────────────
  /* v2.3 rather than v2.4, and Latin-1 rather than UTF-8, wherever the text allows it: the same
     old-hardware audience that drove MPEG-1 above also tends to predate v2.4. Text that will not
     fit Latin-1 falls back to UTF-16LE with a BOM, which IS valid in v2.3 (UTF-8 is not).
     Prepending a tag to CBR MP3 bytes is safe — decoders skip it — and inflates a duration
     estimated from file size by well under a second on a 7 MB file. */
  function textFrame(id, str) {
    var latin = true, i;
    for (i = 0; i < str.length; i++) if (str.charCodeAt(i) > 255) { latin = false; break; }
    var body;
    if (latin) {
      body = new Uint8Array(1 + str.length + 1);
      body[0] = 0x00;
      for (i = 0; i < str.length; i++) body[1 + i] = str.charCodeAt(i) & 0xFF;
      body[body.length - 1] = 0x00;
    } else {
      body = new Uint8Array(1 + 2 + str.length * 2 + 2);
      body[0] = 0x01; body[1] = 0xFF; body[2] = 0xFE;        // UTF-16LE BOM
      for (i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        body[3 + i * 2] = c & 0xFF; body[4 + i * 2] = (c >> 8) & 0xFF;
      }
    }
    var out = new Uint8Array(10 + body.length);
    for (i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    var n = body.length;                                      // v2.3 frame size: plain big-endian
    out[4] = (n >>> 24) & 0xFF; out[5] = (n >>> 16) & 0xFF; out[6] = (n >>> 8) & 0xFF; out[7] = n & 0xFF;
    out.set(body, 10);
    return out;
  }
  function id3(tags) {
    var frames = [], order = [['TIT2', 'title'], ['TPE1', 'artist'], ['TALB', 'album'],
                              ['TRCK', 'track'], ['TCON', 'genre']];
    order.forEach(function (p) {
      var v = tags && tags[p[1]];
      if (v) frames.push(textFrame(p[0], String(v)));
    });
    var size = 0;
    frames.forEach(function (f) { size += f.length; });
    var head = new Uint8Array(10 + size);
    head[0] = 0x49; head[1] = 0x44; head[2] = 0x33;           // "ID3"
    head[3] = 3; head[4] = 0; head[5] = 0;                    // v2.3.0, no flags
    // Tag size is SYNCHSAFE — 7 significant bits per byte — unlike the frame sizes above.
    head[6] = (size >>> 21) & 0x7F; head[7] = (size >>> 14) & 0x7F;
    head[8] = (size >>> 7) & 0x7F;  head[9] = size & 0x7F;
    var o = 10;
    frames.forEach(function (f) { head.set(f, o); o += f.length; });
    return head;
  }

  // ── the encode ──────────────────────────────────────────────────────────────────────────────
  /* opts: { pcm: Float32Array, sampleRate, boundaries: [seconds…], tags: {…},
             bitrate?, onProgress?(fraction 0..1, phase) }
     Resolves to a Blob. Rejects {code} on failure so callers can message per cause. */
  function encode(opts) {
    opts = opts || {};
    if (!supported()) return Promise.reject({ code: 'unsupported' });
    var pcm = opts.pcm;
    if (!pcm || !pcm.length) return Promise.reject({ code: 'empty' });
    var srcRate = opts.sampleRate || OUT_RATE;
    var bitrate = opts.bitrate || BITRATE;
    var prog = opts.onProgress || function () {};

    prog(0, 'prepare');
    return resample(pcm, srcRate, OUT_RATE).then(function (f32) {
      var samples = toInt16(f32);
      var total = samples.length;

      var hw = (navigator && navigator.hardwareConcurrency) || 2;
      var lanes = Math.max(1, Math.min(MAX_LANES, hw - 1));
      // Boundaries arrive in the SOURCE timebase (seconds) — rescale to output samples.
      var safe = (opts.boundaries || []).map(function (sec) { return Math.round(sec * OUT_RATE); });
      var cuts = planCuts(total, safe, lanes);

      var slices = cuts.map(function (start, i) {
        var end = (i + 1 < cuts.length) ? cuts[i + 1] : total;
        return samples.slice(start, end);       // slice, not subarray: each buffer is transferred
      });

      prog(0, 'encode');
      var doneBy = new Array(slices.length).fill(0);
      var results = new Array(slices.length);
      var settled = 0;

      return new Promise(function (resolve, reject) {
        var workers = [], failed = false;
        function cleanup() { workers.forEach(function (w) { try { w.terminate(); } catch (_) {} }); }

        slices.forEach(function (slice, lane) {
          var w;
          try { w = new Worker('/mp3-worker.js'); }
          catch (err) { failed = true; cleanup(); reject({ code: 'worker', detail: String(err) }); return; }
          workers.push(w);
          w.onerror = function (ev) {
            if (failed) return;
            failed = true; cleanup();
            reject({ code: 'worker', detail: (ev && ev.message) || 'worker error' });
          };
          w.onmessage = function (ev) {
            var d = ev.data || {};
            if (failed) return;
            if (d.error) { failed = true; cleanup(); reject({ code: 'encode', detail: d.error }); return; }
            doneBy[lane] = d.done || 0;
            var sum = 0;
            for (var i = 0; i < doneBy.length; i++) sum += doneBy[i];
            prog(Math.min(0.99, sum / total), 'encode');
            if (!d.mp3) return;
            results[lane] = d.mp3;
            if (++settled !== slices.length) return;
            cleanup();
            var tag = id3(opts.tags);
            var parts = [tag];
            for (var k = 0; k < results.length; k++) parts.push(results[k]);
            prog(1, 'done');
            resolve(new Blob(parts, { type: 'audio/mpeg' }));
          };
          w.postMessage({ lane: lane, pcm: slice, rate: OUT_RATE, bitrate: bitrate }, [slice.buffer]);
        });
      });
    });
  }

  // Hand a Blob to the browser as a file download. Object URL is revoked on a timer rather than
  // immediately: revoking synchronously after click() races the download starting in some
  // browsers and yields a zero-byte file.
  function saveAs(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (_) {}
      URL.revokeObjectURL(url);
    }, 60000);
  }

  window.ThaiEarMp3 = {
    supported: supported,
    encode: encode,
    saveAs: saveAs,
    OUT_RATE: OUT_RATE,
    BITRATE: BITRATE
  };
})();
