/* mp3-worker.js — one lamejs encode lane (desktop MP3 export, 2026-08-07).

   Deliberately dumb: it owns no policy. It is handed an Int16 PCM slice, a sample rate and a
   bitrate, and it returns MP3 bytes. Every decision that needs to know what the audio IS —
   where it may be cut, what rate to target, how many lanes to run — lives in mp3-export.js.

   WHY A WORKER AT ALL: lamejs is pure JS and encodes roughly 10× realtime, so a 15-minute
   session is ~90 s of solid CPU. On the main thread that is a frozen page with a progress bar
   that cannot paint. Measured 2026-08-07 (node, same V8): 900 s of 44.1 kHz mono at 64 kbps =
   6.87 MB in 94.0 s.

   WHY importScripts AND NOT A MODULE: lame.min.js ends in a bare `lamejs()` self-invocation that
   attaches Mp3Encoder to the function object as a global. It is a classic script, not an ES
   module, and the rest of this codebase is plain scripts too. Absolute path so the worker
   resolves the same from a clean URL (/topic-05) as from /playlists. */
'use strict';
importScripts('/vendor/lame.min.js');

/* 1152 samples = one MPEG Layer III granule pair, the unit lamejs's encodeBuffer expects.
   Feeding it anything else still works but wastes a copy per call. */
var FRAME = 1152;

self.onmessage = function (e) {
  var d = e.data || {};
  var pcm = d.pcm;                       // Int16Array, transferred (not copied)
  var enc;
  try {
    enc = new self.lamejs.Mp3Encoder(1, d.rate, d.bitrate);
  } catch (err) {
    self.postMessage({ lane: d.lane, error: 'encoder init failed: ' + (err && err.message || err) });
    return;
  }

  var out = [], total = 0, n = pcm.length, i = 0;
  /* Progress is reported per ~2% of this lane rather than per frame: a 15-minute lane is ~34,000
     frames and posting 34,000 messages costs more than the encode saves. */
  var step = Math.max(FRAME, Math.floor(n / 50 / FRAME) * FRAME), nextAt = step;

  try {
    for (; i + FRAME <= n; i += FRAME) {
      var b = enc.encodeBuffer(pcm.subarray(i, i + FRAME));
      if (b.length) { out.push(b); total += b.length; }
      if (i >= nextAt) { nextAt = i + step; self.postMessage({ lane: d.lane, done: i, of: n }); }
    }
    // The ragged tail (< 1152 samples). lamejs pads it internally; dropping it would lose up to
    // 26 ms off the end of every lane, which across lanes is an audible clip of the next onset.
    if (i < n) {
      var t = enc.encodeBuffer(pcm.subarray(i, n));
      if (t.length) { out.push(t); total += t.length; }
    }
    var f = enc.flush();
    if (f.length) { out.push(f); total += f.length; }
  } catch (err2) {
    self.postMessage({ lane: d.lane, error: 'encode failed: ' + (err2 && err2.message || err2) });
    return;
  }

  // Flatten here, in the worker, so the main thread receives ONE transferable buffer per lane
  // instead of a few thousand little Int8Arrays it would have to walk itself.
  var flat = new Uint8Array(total), o = 0;
  for (var k = 0; k < out.length; k++) { flat.set(out[k], o); o += out[k].length; }
  self.postMessage({ lane: d.lane, done: n, of: n, mp3: flat }, [flat.buffer]);
};
