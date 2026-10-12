/* gif.js — 手写 GIF89a 编码器（中位切分调色板 + LZW），不依赖任何外部库 */
(function (global) {
  'use strict';

  function Writer(cap) {
    this.buf = new Uint8Array(cap || 1 << 16);
    this.len = 0;
  }
  Writer.prototype._need = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  Writer.prototype.u8 = function (v) { this._need(1); this.buf[this.len++] = v & 0xff; };
  Writer.prototype.u16 = function (v) { this._need(2); this.buf[this.len++] = v & 0xff; this.buf[this.len++] = (v >> 8) & 0xff; };
  Writer.prototype.bytes = function (arr) {
    this._need(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  };
  Writer.prototype.result = function () { return this.buf.slice(0, this.len); };

  /* ---- 中位切分 ---- */
  function makeBox(samples, start, end) {
    var mn = [255, 255, 255], mx = [0, 0, 0];
    for (var i = start; i < end; i++) {
      for (var c = 0; c < 3; c++) {
        var v = samples[i * 3 + c];
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }
    }
    return { start: start, end: end, min: mn, max: mx,
      range: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }

  function medianCut(samples, maxColors) {
    var n = samples.length / 3;
    if (!n) return [[0, 0, 0]];
    var boxes = [makeBox(samples, 0, n)];
    while (boxes.length < maxColors) {
      var bi = -1, bestScore = 0;
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.end - b.start < 2) continue;
        var score = Math.max(b.range[0], b.range[1], b.range[2]);
        if (score > bestScore) { bestScore = score; bi = i; }
      }
      if (bi < 0 || bestScore === 0) break;
      var box = boxes[bi];
      var ch = 0;
      if (box.range[1] >= box.range[ch]) ch = 1;
      if (box.range[2] >= box.range[ch]) ch = 2;
      var len = box.end - box.start;
      var seg = samples.subarray(box.start * 3, box.end * 3);
      var order = new Array(len);
      for (var j = 0; j < len; j++) order[j] = j;
      order.sort(function (p, q) { return seg[p * 3 + ch] - seg[q * 3 + ch]; });
      var sorted = new Uint8Array(len * 3);
      for (var k = 0; k < len; k++) {
        var src = order[k] * 3, dst = k * 3;
        sorted[dst] = seg[src]; sorted[dst + 1] = seg[src + 1]; sorted[dst + 2] = seg[src + 2];
      }
      samples.set(sorted, box.start * 3);
      var mid = len >> 1;
      boxes.splice(bi, 1,
        makeBox(samples, box.start, box.start + mid),
        makeBox(samples, box.start + mid, box.end));
    }
    return boxes.map(function (b) {
      var r = 0, g = 0, bl = 0, c = b.end - b.start;
      for (var i = b.start; i < b.end; i++) {
        r += samples[i * 3]; g += samples[i * 3 + 1]; bl += samples[i * 3 + 2];
      }
      return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)];
    });
  }

  /* ---- Lloyd 迭代细化调色板（绕过缓存直接查找） ---- */
  function directNearest(pr, pg, pb, r, g, b) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < pr.length; i++) {
      var dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function refine(samples, palette, iters) {
    var n = samples.length / 3, c = palette.length;
    var pr = new Float64Array(c), pg = new Float64Array(c), pb = new Float64Array(c);
    for (var i = 0; i < c; i++) { pr[i] = palette[i][0]; pg[i] = palette[i][1]; pb[i] = palette[i][2]; }
    var sr = new Float64Array(c), sg = new Float64Array(c), sb = new Float64Array(c);
    var counts = new Int32Array(c);
    for (var it = 0; it < iters; it++) {
      sr.fill(0); sg.fill(0); sb.fill(0); counts.fill(0);
      for (var p = 0; p < n; p++) {
        var r = samples[p * 3], g = samples[p * 3 + 1], b = samples[p * 3 + 2];
        var k = directNearest(pr, pg, pb, r, g, b);
        sr[k] += r; sg[k] += g; sb[k] += b; counts[k]++;
      }
      for (var q = 0; q < c; q++) {
        if (counts[q]) {
          pr[q] = sr[q] / counts[q]; pg[q] = sg[q] / counts[q]; pb[q] = sb[q] / counts[q];
        }
      }
    }
    for (var m = 0; m < c; m++) {
      palette[m] = [Math.round(pr[m]), Math.round(pg[m]), Math.round(pb[m])];
    }
  }

  /* ---- 最近色查找（5-5-5 缓存） ---- */
  var cache = new Int16Array(32768).fill(-1);
  function nearest(pr, pg, pb, r, g, b) {
    var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    var v = cache[key];
    if (v >= 0) return v;
    var best = 0, bd = Infinity;
    for (var i = 0; i < pr.length; i++) {
      var dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    cache[key] = best;
    return best;
  }

  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function mapFrame(rgba, w, h, pr, pg, pb, tIdx, dither) {
    var out = new Uint8Array(w * h);
    if (!dither) {
      for (var i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = (tIdx >= 0 && rgba[p + 3] < 128) ? tIdx : nearest(pr, pg, pb, rgba[p], rgba[p + 1], rgba[p + 2]);
      }
      return out;
    }
    /* Floyd–Steinberg 抖动 */
    var errA = new Float32Array((w + 2) * 3), errB = new Float32Array((w + 2) * 3);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var q = (y * w + x) * 4, o = y * w + x;
        if (tIdx >= 0 && rgba[q + 3] < 128) { out[o] = tIdx; continue; }
        var e = (x + 1) * 3;
        var r = clamp8(rgba[q] + errA[e]), g = clamp8(rgba[q + 1] + errA[e + 1]), b = clamp8(rgba[q + 2] + errA[e + 2]);
        var idx = nearest(pr, pg, pb, r, g, b);
        out[o] = idx;
        var er = r - pr[idx], eg = g - pg[idx], eb = b - pb[idx];
        errA[e + 3] += er * 7 / 16; errA[e + 4] += eg * 7 / 16; errA[e + 5] += eb * 7 / 16;
        errB[e - 3] += er * 3 / 16; errB[e - 2] += eg * 3 / 16; errB[e - 1] += eb * 3 / 16;
        errB[e] += er * 5 / 16; errB[e + 1] += eg * 5 / 16; errB[e + 2] += eb * 5 / 16;
        errB[e + 3] += er / 16; errB[e + 4] += eg / 16; errB[e + 5] += eb / 16;
      }
      var tmp = errA; errA = errB; errB = tmp;
      errB.fill(0);
    }
    return out;
  }

  /* ---- LZW（写入子块） ---- */
  function lzwWrite(w, indices, minCodeSize) {
    w.u8(minCodeSize);
    var block = new Uint8Array(255), blockLen = 0;
    function flushBlock() { if (blockLen) { w.u8(blockLen); w.bytes(block.subarray(0, blockLen)); blockLen = 0; } }
    function outByte(b) { block[blockLen++] = b; if (blockLen === 255) flushBlock(); }

    var clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
    var codeSize = minCodeSize + 1, nextCode = eoiCode + 1;
    var dict = new Map(), cur = 0, curBits = 0;
    function emit(code) {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) { outByte(cur & 0xff); cur >>= 8; curBits -= 8; }
    }

    emit(clearCode);
    var prefix = indices[0];
    for (var i = 1; i < indices.length; i++) {
      var k = indices[i], key = (prefix << 8) | k;
      var got = dict.get(key);
      if (got !== undefined) { prefix = got; continue; }
      emit(prefix);
      if (nextCode < 4096) {
        dict.set(key, nextCode);
        nextCode++;
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clearCode);
        dict.clear();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (curBits > 0) outByte(cur & 0xff);
    flushBlock();
    w.u8(0); /* 子块结束 */
  }

  /* ---- 总入口 ---- */
  function encodeGIF(frames, width, height, opts) {
    opts = opts || {};
    var transparent = !!opts.transparent;
    var delayCs = opts.delayCs || 10;
    var dither = opts.dither !== false;
    var maxColors = transparent ? 255 : 256;
    var totalPx = frames.length * width * height;

    /* 采样：每隔 step 个像素取一个，总量控制在 5 万左右 */
    var step = Math.max(1, Math.floor(totalPx / 50000));
    var sampleCount = Math.ceil(totalPx / step);
    var samples = new Uint8Array(sampleCount * 3);
    var si = 0;
    for (var f = 0; f < frames.length; f++) {
      var rgba = frames[f];
      for (var p = 0; p < rgba.length; p += 4 * step) {
        if (si >= sampleCount) break;
        samples[si * 3] = rgba[p]; samples[si * 3 + 1] = rgba[p + 1]; samples[si * 3 + 2] = rgba[p + 2];
        si++;
      }
    }
    var sampleView = samples.subarray(0, si * 3);
    var palette = medianCut(sampleView, maxColors);
    refine(sampleView, palette, 3);
    cache.fill(-1); /* 调色板定稿后清缓存 */
    var pr = palette.map(function (c) { return c[0]; });
    var pg = palette.map(function (c) { return c[1]; });
    var pb = palette.map(function (c) { return c[2]; });
    var tIdx = transparent ? palette.length : -1;

    var w = new Writer(1 << 20);
    w.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); /* GIF89a */
    w.u16(width); w.u16(height);
    w.u8(0xF7); /* 全局色表 256 色 */
    w.u8(0); w.u8(0);
    for (var i = 0; i < 256; i++) {
      var c = palette[i] || [0, 0, 0];
      w.u8(c[0]); w.u8(c[1]); w.u8(c[2]);
    }
    /* NETSCAPE 无限循环 */
    w.u8(0x21); w.u8(0xFF); w.u8(0x0B);
    w.bytes([0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30]);
    w.u8(0x03); w.u8(0x01); w.u16(0); w.u8(0);

    var disposal = transparent ? 2 : 1;
    for (var fi = 0; fi < frames.length; fi++) {
      var mapped = mapFrame(frames[fi], width, height, pr, pg, pb, tIdx, dither);
      w.u8(0x21); w.u8(0xF9); w.u8(0x04);
      w.u8((disposal << 2) | (transparent ? 1 : 0));
      w.u16(delayCs);
      w.u8(transparent ? tIdx : 0);
      w.u8(0);
      w.u8(0x2C); w.u16(0); w.u16(0); w.u16(width); w.u16(height); w.u8(0);
      lzwWrite(w, mapped, 8);
    }
    w.u8(0x3B);
    return w.result();
  }

  global.GIF = { encodeGIF: encodeGIF, _medianCut: medianCut, _refine: refine, _lzwWrite: lzwWrite };
})(typeof window !== 'undefined' ? window : globalThis);
