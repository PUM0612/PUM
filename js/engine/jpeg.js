// Bộ mã hoá JPEG baseline (4:4:4, giống subsampling=0 của PUM máy tính), mã hoá THEO DẢI để xuất ảnh
// 24–60 MP trên iPhone mà không cần một canvas cỡ gốc (Safari iOS giới hạn canvas ~16,7 MP).
const ZZ = [0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];
const YQT = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CQT = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const DC_L_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_C_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const AC_L_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_VALS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const AC_C_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALS = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

function huff(bits, vals) {
  const code = new Uint16Array(256), len = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) { code[vals[k]] = c; len[vals[k]] = l; c++; k++; }
    c <<= 1;
  }
  return { code, len };
}
const HDC = [huff(DC_L_BITS, DC_VALS), huff(DC_C_BITS, DC_VALS)];
const HAC = [huff(AC_L_BITS, AC_L_VALS), huff(AC_C_BITS, AC_C_VALS)];

// bảng cos cho DCT 8x8 trực chuẩn
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = Math.cos((2 * x + 1) * u * Math.PI / 16) * (u === 0 ? Math.SQRT1_2 : 1) / 2;

export class JpegEncoder {
  constructor(w, h, quality = 92) {
    this.w = w; this.h = h;
    const q = Math.max(1, Math.min(100, quality | 0));
    const sc = q < 50 ? 5000 / q : 200 - q * 2;
    this.qt = [YQT, CQT].map((t) => t.map((v) => Math.max(1, Math.min(255, Math.floor((v * sc + 50) / 100)))));
    this.fq = this.qt.map((t) => Float64Array.from(t, (v) => 1 / v));
    this.dc = [0, 0, 0];
    this.buf = new Uint8Array(1 << 20); this.pos = 0; this.acc = 0; this.nb = 0;
    this.rowsDone = 0;
    this.blk = new Float64Array(64); this.tmp = new Float64Array(64); this.coef = new Int32Array(64);
  }
  _ensure(n) {
    if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf.subarray(0, this.pos)); this.buf = b; }
  }
  _byte(b) { this._ensure(1); this.buf[this.pos++] = b; }
  _word(v) { this._byte(v >> 8); this._byte(v & 255); }
  _bits(code, len) {
    this.acc = (this.acc << len) | code; this.nb += len;
    while (this.nb >= 8) {
      const b = (this.acc >> (this.nb - 8)) & 255;
      this._byte(b); if (b === 255) this._byte(0);
      this.nb -= 8;
    }
    this.acc &= (1 << this.nb) - 1;
  }
  _take() { const out = this.buf.slice(0, this.pos); this.pos = 0; return out; }

  header() {
    this._word(0xFFD8);
    this._word(0xFFE0); this._word(16); [0x4A, 0x46, 0x49, 0x46, 0].forEach((b) => this._byte(b));
    this._byte(1); this._byte(1); this._byte(1); this._word(300); this._word(300); this._byte(0); this._byte(0);
    this._word(0xFFDB); this._word(132);
    for (let t = 0; t < 2; t++) {
      this._byte(t);
      const z = new Array(64);
      for (let i = 0; i < 64; i++) z[ZZ[i]] = this.qt[t][i];
      z.forEach((v) => this._byte(v));
    }
    this._word(0xFFC0); this._word(17); this._byte(8); this._word(this.h); this._word(this.w); this._byte(3);
    [[1, 0x11, 0], [2, 0x11, 1], [3, 0x11, 1]].forEach(([id, s, q]) => { this._byte(id); this._byte(s); this._byte(q); });
    this._word(0xFFC4); this._word(0x01A2);
    const tbl = (cls, bits, vals) => { this._byte(cls); bits.forEach((b) => this._byte(b)); vals.forEach((v) => this._byte(v)); };
    tbl(0x00, DC_L_BITS, DC_VALS); tbl(0x10, AC_L_BITS, AC_L_VALS); tbl(0x01, DC_C_BITS, DC_VALS); tbl(0x11, AC_C_BITS, AC_C_VALS);
    this._word(0xFFDA); this._word(12); this._byte(3);
    [[1, 0x00], [2, 0x11], [3, 0x11]].forEach(([id, t]) => { this._byte(id); this._byte(t); });
    this._byte(0); this._byte(63); this._byte(0);
    return this._take();
  }

  _block(ci, t) {
    const b = this.blk, tmp = this.tmp, q = this.fq[t], co = this.coef;
    // DCT tách trục
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
      let s = 0; for (let x = 0; x < 8; x++) s += b[y * 8 + x] * COS[x * 8 + u]; tmp[y * 8 + u] = s;
    }
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      let s = 0; for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[y * 8 + v];
      const i = v * 8 + u;
      co[ZZ[i]] = Math.round(s * q[i]);
    }
    const hd = HDC[t], ha = HAC[t];
    const diff = co[0] - this.dc[ci]; this.dc[ci] = co[0];
    this._val(diff, hd.code, hd.len, 0);
    let run = 0;
    let last = 63; while (last > 0 && co[last] === 0) last--;
    for (let k = 1; k <= last; k++) {
      const v = co[k];
      if (v === 0) { run++; continue; }
      while (run >= 16) { this._bits(ha.code[0xF0], ha.len[0xF0]); run -= 16; }
      this._val(v, ha.code, ha.len, run);
      run = 0;
    }
    if (last < 63) this._bits(ha.code[0], ha.len[0]);
  }
  _val(v, code, len, run) {
    const a = Math.abs(v);
    let n = 0; while ((1 << n) <= a) n++;
    const sym = (run << 4) | n;
    this._bits(code[sym], len[sym]);
    if (n) this._bits(v < 0 ? (v - 1) & ((1 << n) - 1) : v, n);
  }

  // rgb: Uint8 (w * rows * 3 hoặc 4 nếu stride=4). rows là bội số 8 (trừ dải cuối).
  addRows(rgb, rows, stride = 3) {
    const { w } = this, b = this.blk;
    const Y = new Float64Array(64 * 3);
    for (let by = 0; by < rows; by += 8) {
      for (let bx = 0; bx < w; bx += 8) {
        for (let y = 0; y < 8; y++) {
          const yy = Math.min(by + y, rows - 1);
          for (let x = 0; x < 8; x++) {
            const xx = Math.min(bx + x, w - 1), p = (yy * w + xx) * stride;
            const r = rgb[p], g = rgb[p + 1], bl = rgb[p + 2], i = y * 8 + x;
            Y[i] = 0.299 * r + 0.587 * g + 0.114 * bl - 128;
            Y[64 + i] = -0.168736 * r - 0.331264 * g + 0.5 * bl;
            Y[128 + i] = 0.5 * r - 0.418688 * g - 0.081312 * bl;
          }
        }
        for (let c = 0; c < 3; c++) { for (let i = 0; i < 64; i++) b[i] = Y[c * 64 + i]; this._block(c, c ? 1 : 0); }
      }
    }
    this.rowsDone += rows;
    return this._take();
  }
  finish() {
    if (this.nb > 0) this._bits((1 << (8 - this.nb)) - 1, 8 - this.nb);
    this._word(0xFFD9);
    return this._take();
  }
}
