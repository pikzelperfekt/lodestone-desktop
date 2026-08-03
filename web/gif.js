// A minimal animated-GIF encoder: median-cut palette + LZW, no dependencies.
//
// The Mac's ClipRecorder writes looping GIFs via ImageIO. Electron has no
// equivalent, and shipping a .webm instead would break the thing that makes the
// Mac's choice good: a GIF drops straight into the instance's screenshots
// folder, plays anywhere, and needs no player. So the format is matched rather
// than substituted.
//
// GIF is capped at 256 colours per frame, so the palette is built by MEDIAN CUT
// over pixels sampled from the whole clip — one shared table for every frame, so
// colours don't shimmer between them the way a per-frame palette makes them.
(function () {
  "use strict";

  // ---- median cut -----------------------------------------------------------
  // Repeatedly split the box of colours along its longest axis at the median,
  // until there are `count` boxes; each box's average becomes a palette entry.
  function medianCut(pixels, count) {
    let boxes = [pixels];
    while (boxes.length < count) {
      // Split the box with the widest spread — that's where banding shows most.
      let bestIdx = -1, bestRange = -1, bestAxis = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.length < 2) continue;
        for (let axis = 0; axis < 3; axis++) {
          let lo = 255, hi = 0;
          for (const p of box) { const v = p[axis]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const range = hi - lo;
          if (range > bestRange) { bestRange = range; bestIdx = i; bestAxis = axis; }
        }
      }
      if (bestIdx < 0 || bestRange <= 0) break;   // every box is a single colour
      const box = boxes[bestIdx];
      box.sort((a, b) => a[bestAxis] - b[bestAxis]);
      const mid = box.length >> 1;
      boxes.splice(bestIdx, 1, box.slice(0, mid), box.slice(mid));
    }
    return boxes.filter((b) => b.length).map((box) => {
      let r = 0, g = 0, b2 = 0;
      for (const p of box) { r += p[0]; g += p[1]; b2 += p[2]; }
      return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b2 / box.length)];
    });
  }

  function buildPalette(frames, width, height) {
    const samples = [];
    // Sample rather than read every pixel: a 640x360 clip at 12fps is millions
    // of pixels and the palette barely moves after a few thousand.
    const stride = Math.max(1, Math.floor((width * height) / 4000));
    for (const data of frames) {
      for (let i = 0, px = 0; i < data.length; i += 4, px++) {
        if (px % stride) continue;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    const palette = medianCut(samples, 256);
    while (palette.length < 2) palette.push([0, 0, 0]);   // GIF needs at least 2
    return palette;
  }

  // Nearest palette entry, memoised on a coarse RGB key. Exact nearest-colour
  // for every pixel would dominate the encode time; 5 bits per channel is
  // visually identical here and ~30x faster.
  function makeMapper(palette) {
    const cache = new Map();
    return function (r, g, b) {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) { bestDist = d; best = i; }
      }
      cache.set(key, best);
      return best;
    };
  }

  // ---- byte sink ------------------------------------------------------------
  function Sink() { this.bytes = []; }
  Sink.prototype.byte = function (b) { this.bytes.push(b & 0xff); };
  Sink.prototype.short = function (v) { this.byte(v); this.byte(v >> 8); };   // GIF is little-endian
  Sink.prototype.str = function (s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); };
  Sink.prototype.raw = function (arr) { for (const b of arr) this.byte(b); };

  // ---- LZW ------------------------------------------------------------------
  // GIF's variable-code-width LZW. Codes are packed LSB-first and the output is
  // written as sub-blocks of at most 255 bytes.
  function lzw(indices, minCodeSize) {
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    let dict = new Map();
    let codeSize = minCodeSize + 1;
    let next = eoi + 1;

    const out = [];
    let cur = 0, curBits = 0;
    const emit = (code) => {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
    };

    const reset = () => { dict = new Map(); codeSize = minCodeSize + 1; next = eoi + 1; };

    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 4096 + k;
      const found = dict.get(key);
      if (found !== undefined) { prefix = found; continue; }
      emit(prefix);
      dict.set(key, next);
      // 4095 is the largest code GIF allows; past it the dictionary must reset.
      if (next < 4096) {
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
        next++;
      } else {
        emit(clear);
        reset();
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (curBits > 0) out.push(cur & 0xff);
    return out;
  }

  function writeSubBlocks(sink, data) {
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      sink.byte(chunk.length);
      sink.raw(chunk);
    }
    sink.byte(0);   // block terminator
  }

  /**
   * Encode frames into an animated GIF.
   * @param {Uint8ClampedArray[]} frames RGBA pixel data, one per frame
   * @param {number} width
   * @param {number} height
   * @param {number} delayMs per-frame delay
   * @returns {Uint8Array}
   */
  function encodeGIF(frames, width, height, delayMs) {
    if (!frames.length) throw new Error("No frames to encode.");
    const palette = buildPalette(frames, width, height);
    const map = makeMapper(palette);

    // GIF's colour table must be a power of two, at least 2 entries.
    let bits = 1;
    while ((1 << bits) < palette.length) bits++;
    const tableSize = 1 << bits;

    const s = new Sink();
    s.str("GIF89a");
    s.short(width); s.short(height);
    s.byte(0x80 | ((bits - 1) << 4) | (bits - 1));   // global table present, size
    s.byte(0);   // background colour index
    s.byte(0);   // pixel aspect ratio

    for (let i = 0; i < tableSize; i++) {
      const c = palette[i] || [0, 0, 0];
      s.byte(c[0]); s.byte(c[1]); s.byte(c[2]);
    }

    // Netscape extension — loop forever. Without it the clip plays once.
    s.byte(0x21); s.byte(0xff); s.byte(11);
    s.str("NETSCAPE2.0");
    s.byte(3); s.byte(1); s.short(0); s.byte(0);

    // GIF delays are in hundredths of a second; below 2 most viewers clamp to 10.
    const delay = Math.max(2, Math.round(delayMs / 10));

    for (const data of frames) {
      s.byte(0x21); s.byte(0xf9); s.byte(4);
      s.byte(0);            // no transparency, no disposal
      s.short(delay);
      s.byte(0); s.byte(0);

      s.byte(0x2c);
      s.short(0); s.short(0); s.short(width); s.short(height);
      s.byte(0);            // no local table, not interlaced

      const indices = new Uint8Array(width * height);
      for (let i = 0, px = 0; i < data.length; i += 4, px++) {
        indices[px] = map(data[i], data[i + 1], data[i + 2]);
      }
      const minCodeSize = Math.max(2, bits);
      s.byte(minCodeSize);
      writeSubBlocks(s, lzw(indices, minCodeSize));
    }

    s.byte(0x3b);   // trailer
    return new Uint8Array(s.bytes);
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { encodeGIF, medianCut, lzw };
  if (typeof window !== "undefined") window.LodeGIF = { encodeGIF };
})();
