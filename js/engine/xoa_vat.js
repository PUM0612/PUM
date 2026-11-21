// Xoá vật thể bằng AI lấp nền (LaMa / big-lama).
// Chép đúng xoa_vat.py của PUM máy tính (bản phát triển, 21/11/2026).
//
// Cách làm: vùng tô bị XOÁ HẲN rồi mô hình dựng lại nền phía sau. Không có vùng nguồn nào bị chép sang.
// - plan(): các ô vuông đưa vào mô hình. Toạ độ chuẩn hoá nên như nhau ở mọi độ phân giải.
// - Kết quả AI giữ trong bộ đệm theo khoá vùng tô (cacheKey). Bản xem trước, phóng 1:1 và ảnh xuất dùng chung:
//   - mỗi ô là 512 x 512 điểm, số thực 16 bit như bản máy tính;
//   - ảnh đưa vào mô hình lấy ở độ phân giải tham chiếu REF_SIDE = 2000 (bằng bản xem trước của PUM máy tính),
//     xem export.js xvPrepare.
// - Ở độ phân giải cao hơn:
//   - hoà mép kiểu Poisson (seamFix);
//   - ghép chi tiết cao tần (hạt, vân) từ những mảnh giống nhất quanh vùng xoá (detail).
// - Mô hình chạy ở js/workers/xoa_ai.worker.js (onnxruntime-web). removeGen "yield" một yêu cầu chạy mô hình
//   { inp, m } và nhận lại nền đã lấp (N x N x 3, 0..1).
import * as cv from './cv.js';

export const N = 512;                 // cỡ vào / ra cố định của mô hình
export const REF_SIDE = 2000;         // cạnh dài độ phân giải tham chiếu (= PREVIEW_SIDE của PUM máy tính)
const MIN_CTX = 320;                  // khung cắt tối thiểu (điểm ảnh tham chiếu)
const CTX_K = 1.7;                    // khung cắt = 1,7 x cạnh lớn của vùng tô + 64 px tham chiếu
export const VARIANTS = [1.0, 1.45, 0.8, 2.0];   // "Thử cách khác": đổi lượng bối cảnh đưa vào mô hình
const PATCH = 6;                      // cỡ mảnh (điểm ảnh của nền AI) khi ghép chi tiết cao tần
const DETAIL_BAND = 6.0;              // chi tiết ghép thêm: chỉ phần mịn hơn chừng này điểm ảnh (hạt, sợi vải)
const DETAIL_MIN = 3.5;               // ... và ít nhất tới cỡ này (nền AI mịn hơn ảnh thật cả ở độ phân giải của nó)
const TILE_MIN_S = 1024, MAX_TILES = 4;
export const KEY_TAG = 'lama3';       // đổi khi đổi thuật toán (giống bản máy tính)
const SEAM_OK = 0.10;                 // chênh màu quanh mép lớn hơn mức này = vật còn sót -> không kéo vào trong
const SEAM_EDGE = 0.25;               // độ dốc (Sobel, lưới thấp) lớn hơn mức này = cạnh thật ở mép -> không dùng để khớp màu
const SEAM_MAX = 0.22;                // bù tối đa (0..1)
const RING_N = 6;                     // mặt nạ đưa vào AI nới thêm chừng này điểm ảnh (của ảnh 512) quanh vùng xoá
// Bản xoa_vat.py đã chép theo: PUM máy tính bản phát triển, sửa lúc 21:29 ngày 21/11/2026 (KEY_TAG 'lama3');
// bản gốc lưu ở tools/goc_xoa_vat/xoa_vat.py.
// Một chỗ cố ý khác: trong 4 mảnh nguồn tốt nhất, bản máy tính lấy theo thứ tự của numpy.argpartition (không sắp
// xếp), bản này lấy theo thứ tự chi phí tăng dần. Cùng cách chọn xoay vòng nên hạt / vân giống nhau về kiểu, chỉ
// khác từng hạt.
const CACHE_MAX = 16;                 // số vùng giữ trong bộ nhớ luồng dựng (bản đầy đủ lưu ở IndexedDB)

const pyRound = cv.roundEven;         // round() của Python (nửa -> chẵn)
const f32 = Math.fround;

// ------------------------------------------------------------------ trạng thái + bộ đệm
// ai = true: mô hình đã có trên máy -> vùng xoá dùng AI. false: như PUM máy tính khi thiếu mô hình
// (vùng có vùng nguồn cũ thì dùng cách cũ, vùng mới thì lấp mượt + chi tiết quanh vùng).
// epoch tăng mỗi khi bộ đệm có kết quả mới -> luồng dựng bỏ ảnh retouch đã lấp tạm.
export const state = { ai: false, epoch: 0 };
const cache = new Map();
export function cacheGet(key) {
  const v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); }
  return v || null;
}
export function cachePut(key, v) {
  cache.delete(key); cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
export const cacheHas = (key) => cache.has(key);
export function cacheClear() { cache.clear(); }

// số thực 16 bit (làm tròn nửa -> chẵn như numpy astype(float16))
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
export function toHalf(v) {
  _f[0] = v;
  const x = _u[0], sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let hv = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (hv & 1))) hv++;
    return sign | hv;
  }
  let hv = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (hv & 1))) hv++;
  return sign | hv;
}
let H2F = null;
function halfTable() {
  if (H2F) return H2F;
  H2F = new Float32Array(65536);
  for (let hv = 0; hv < 65536; hv++) {
    const s = hv & 0x8000 ? -1 : 1, e = (hv >> 10) & 31, m = hv & 1023;
    H2F[hv] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return H2F;
}
export function halfToF32(u16) {
  const t = halfTable(), o = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) o[i] = t[u16[i]];
  return o;
}
export function f32ToHalf(a) {
  const o = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = toHalf(a[i]);
  return o;
}

// ------------------------------------------------------------------ hình học
export function areaBBox(a, w, h) {
  // khung bao (điểm ảnh) của vùng tô, gồm cả phần nới + mép mềm như engine._area_geom
  const r = Math.max(1.0, a.r * w);
  const hard = Math.min(1.0, Math.max(0.0, (a.hard ?? 60) / 100.0));
  const fe = Math.max(0.6, (1.0 - hard) * r * 0.5);
  const ext = r * (a.kind === 'remove' ? 1.125 : 1.0) + 2.5 * fe;
  const xs = a.pts.map((p) => p[0] * w), ys = a.pts.map((p) => p[1] * h);
  return [Math.min(...xs) - ext, Math.min(...ys) - ext, Math.max(...xs) + ext, Math.max(...ys) + ext];
}

// các ô đưa vào mô hình: [{ rect: [x0, y0, x1, y1] chuẩn hoá, band: null | [trục, từ, tới] }]
export function plan(a, w, h) {
  const [bx0, by0, bx1, by1] = areaBBox(a, w, h);
  const k = REF_SIDE / Math.max(w, h);
  const vi = Math.trunc(Number(a.v || 0)) % VARIANTS.length;
  const vr = VARIANTS[vi < 0 ? vi + VARIANTS.length : vi];
  const bw = (bx1 - bx0) * k, bh = (by1 - by0) * k;
  const s_ = Math.min(bw, bh), l_ = Math.max(bw, bh);
  const S1 = Math.max(MIN_CTX, CTX_K * l_ + 64.0) * vr;
  const T = Math.max(MIN_CTX, CTX_K * s_ + 64.0) * vr;
  const cx = (bx0 + bx1) / 2.0, cy = (by0 + by1) / 2.0;
  const sq = (ccx, ccy, sideRef) => {
    const s = sideRef / k;
    const sw = Math.min(s, w), sh = Math.min(s, h);
    const x0 = Math.min(Math.max(ccx - sw / 2.0, 0.0), w - sw);
    const y0 = Math.min(Math.max(ccy - sh / 2.0, 0.0), h - sh);
    return [x0 / w, y0 / h, (x0 + sw) / w, (y0 + sh) / h];
  };
  if (!(S1 > TILE_MIN_S && S1 > 1.5 * T && s_ * N / S1 > 40)) return [{ rect: sq(cx, cy, S1), band: null }];
  const axis = bh >= bw ? 1 : 0;
  const a0 = axis ? by0 : bx0, a1 = axis ? by1 : bx1;
  const m = (T - s_) / 2.0 / k;
  let Tc = T / k;
  const span = (a1 - a0) + 2 * m;
  let n = Math.trunc(Math.ceil(Math.max(0.0, span - Tc) / (0.65 * Tc))) + 1;
  if (n > MAX_TILES) { Tc = span / (1 + 0.65 * (MAX_TILES - 1)); n = MAX_TILES; }
  if (n <= 1) return [{ rect: sq(cx, cy, S1), band: null }];
  const first = a0 - m + Tc / 2, last = a1 + m - Tc / 2;
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(first + (last - first) * i / (n - 1));
  const dim = axis ? h : w;
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const c = cs[i];
    const lo = i === 0 ? -1.0 : (cs[i - 1] + c) / 2 / dim;
    const hi = i === n - 1 ? 2.0 : (c + cs[i + 1]) / 2 / dim;
    tiles.push({ rect: axis ? sq(cx, c, Tc * k) : sq(c, cy, Tc * k), band: [axis, lo, hi] });
  }
  return tiles;
}

export function rectNorm(a, w, h) {
  const ts = plan(a, w, h);
  return [Math.min(...ts.map((t) => t.rect[0])), Math.min(...ts.map((t) => t.rect[1])),
    Math.max(...ts.map((t) => t.rect[2])), Math.max(...ts.map((t) => t.rect[3]))];
}
const touch = (r, b) => !(b[2] < r[0] || b[0] > r[2] || b[3] < r[1] || b[1] > r[3]);

// JSON khoá sắp xếp (như json.dumps(sort_keys=True)) + băm 2 x 53 bit
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
// Khoá kết quả AI của vùng thứ i gồm:
// - ảnh (photo);
// - vùng tô, bỏ độ mờ đục / bật tắt và các khoá cũ không ảnh hưởng (fill, cands);
// - các điểm / vùng retouch trước đó chạm khung cắt.
// w, h = cỡ ảnh tham chiếu (luôn giống nhau ở mọi độ phân giải dựng).
export function cacheKey(photo, rt, i, w, h) {
  if (!photo) return null;
  const areas = rt.areas || [], a = areas[i];
  const rn = rectNorm(a, w, h), deps = [];
  for (const sp of rt.spots || []) {
    const rr = sp.r;
    if (touch(rn, [sp.x - rr, sp.y - rr * w / h, sp.x + rr, sp.y + rr * w / h])) deps.push(sp);
  }
  for (const b of areas.slice(0, i)) {
    if (b.pts && b.pts.length && b.enabled !== false) {
      let bb = areaBBox(b, w, h);
      bb = [bb[0] / w, bb[1] / h, bb[2] / w, bb[3] / h];
      if (b.off) bb = [bb[0] + Math.min(0, b.off[0]), bb[1] + Math.min(0, b.off[1]), bb[2] + Math.max(0, b.off[0]), bb[3] + Math.max(0, b.off[1])];
      if (touch(rn, bb)) deps.push(Object.assign({}, b, { fill: undefined, cands: undefined }));
    }
  }
  const me = {};
  for (const k of Object.keys(a)) if (!['opacity', 'enabled', 'fill', 'cands'].includes(k)) me[k] = a[k];
  const s = stable([KEY_TAG, photo, me, deps]);
  return cyrb53(s, 1) + cyrb53(s, 7);
}

// ------------------------------------------------------------------ phép ảnh (giống OpenCV 5 mà bản máy tính dùng)
const img = (w, h, c, d) => ({ w, h, c, d: d || new Float32Array(w * h * c) });
function crop(im, x0, y0, x1, y1) {
  const w = x1 - x0, hh = y1 - y0, c = im.c, o = img(w, hh, c);
  for (let y = 0; y < hh; y++) o.d.set(im.d.subarray(((y + y0) * im.w + x0) * c, ((y + y0) * im.w + x1) * c), y * w * c);
  return o;
}
function cropMask(m, mw, x0, y0, x1, y1) {
  const w = x1 - x0, o = new Uint8Array(w * (y1 - y0));
  for (let y = y0; y < y1; y++) o.set(m.subarray(y * mw + x0, y * mw + x1), (y - y0) * w);
  return o;
}
function paste(dst, src, x0, y0) {
  const c = dst.c;
  for (let y = 0; y < src.h; y++) dst.d.set(src.d.subarray(y * src.w * c, (y + 1) * src.w * c), ((y + y0) * dst.w + x0) * c);
}
function cubicW(t) {
  const A = -0.75;
  const c0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A;
  const c1 = ((A + 2) * t - (A + 3)) * t * t + 1;
  const c2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1;
  return [c0, c1, c2, 1 - c0 - c1 - c2];
}
const reflect = cv.borderReflect;
// bảng nội suy một trục: với mỗi toạ độ ra -> các [chỉ số, trọng số]
function axisTab(n, src, scale, off, cubic, mode) {
  // mode: 'reflect' | 'const' (ngoài ảnh = 0) | 'clamp' (resize)
  const idx = [], wt = [];
  const K = cubic ? 4 : 2, o0 = cubic ? -1 : 0;
  for (let i = 0; i < n; i++) {
    const X = scale * i + off, xi = Math.floor(X), t = X - xi;
    const ws = cubic ? cubicW(t) : [1 - t, t];
    const ii = [], ww = [];
    for (let k = 0; k < K; k++) {
      let j = xi + k + o0;
      if (j < 0 || j >= src) {
        if (mode === 'const') continue;
        j = mode === 'clamp' ? Math.min(src - 1, Math.max(0, j)) : reflect(j, src);
      }
      ii.push(j); ww.push(ws[k]);
    }
    idx.push(ii); wt.push(ww);
  }
  return { idx, wt };
}
function sepApply(src, ow, oh, tx, ty) {
  const { w, c } = src, s = src.d, tmp = new Float64Array(src.h * ow * c);
  for (let y = 0; y < src.h; y++) {
    const r = y * w * c, o = y * ow * c;
    for (let x = 0; x < ow; x++) {
      const ii = tx.idx[x], ww = tx.wt[x];
      for (let k = 0; k < ii.length; k++) {
        const so = r + ii[k] * c, wv = ww[k];
        for (let ch = 0; ch < c; ch++) tmp[o + x * c + ch] += s[so + ch] * wv;
      }
    }
  }
  const out = img(ow, oh, c), W = ow * c;
  for (let y = 0; y < oh; y++) {
    const ii = ty.idx[y], ww = ty.wt[y], o = y * W;
    for (let k = 0; k < ii.length; k++) {
      const so = ii[k] * W, wv = ww[k];
      for (let q = 0; q < W; q++) out.d[o + q] += tmp[so + q] * wv;
    }
  }
  return out;
}
// cv2.warpAffine(src, M, (ow, oh), interp | WARP_INVERSE_MAP) với M chéo [[ax, 0, tx], [0, ay, ty]] (số thực 32 bit)
function warpDiag(src, ax, tx, ay, ty, ow, oh, cubic, constant) {
  const mode = constant ? 'const' : 'reflect';
  return sepApply(src, ow, oh, axisTab(ow, src.w, f32(ax), f32(tx), cubic, mode), axisTab(oh, src.h, f32(ay), f32(ty), cubic, mode));
}
export function resizeCubic(src, dw, dh) {
  return sepApply(src, dw, dh, axisTab(dw, src.w, src.w / dw, 0.5 * src.w / dw - 0.5, true, 'clamp'),
    axisTab(dh, src.h, src.h / dh, 0.5 * src.h / dh - 0.5, true, 'clamp'));
}
function resizeNearestMask(m, w, h, dw, dh) {
  const o = new Uint8Array(dw * dh), fx = w / dw, fy = h / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor(y * fy));
    for (let x = 0; x < dw; x++) o[y * dw + x] = m[sy * w + Math.min(w - 1, Math.floor(x * fx))];
  }
  return o;
}
const maskToImg = (m, w, h) => { const o = img(w, h, 1); for (let i = 0; i < m.length; i++) o.d[i] = m[i]; return o; };
function dilateRect3(m, w, h) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1) && !v; j++)
      for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) if (m[j * w + i]) { v = 1; break; }
    o[y * w + x] = v;
  }
  return o;
}
const dilateEllipse = (m, w, h, k) => cv.morphEllipse(m, w, h, k, true);

// _resample: lấy mẫu khung (sx0, sy0)-(sx1, sy1) (toạ độ GÓC điểm ảnh) ra ảnh ow x oh; thu nhỏ có chống răng cưa
function resample(src, sx0, sy0, sx1, sy1, ow, oh, cubic = false, constant = false) {
  const dx = (sx1 - sx0) / ow, dy = (sy1 - sy0) / oh;
  if (Math.max(dx, dy) > 1.25) {
    const W = src.w, H = src.h;
    const ix0 = Math.max(0, Math.floor(sx0) - 2), iy0 = Math.max(0, Math.floor(sy0) - 2);
    const ix1 = Math.min(W, Math.ceil(sx1) + 2), iy1 = Math.min(H, Math.ceil(sy1) + 2);
    if (ix1 - ix0 >= 2 && iy1 - iy0 >= 2) {
      const tw = Math.max(1, pyRound((ix1 - ix0) / Math.max(1.0, dx)));
      const th = Math.max(1, pyRound((iy1 - iy0) / Math.max(1.0, dy)));
      const sub = cv.resizeArea(crop(src, ix0, iy0, ix1, iy1), tw, th);
      const fx = tw / (ix1 - ix0), fy = th / (iy1 - iy0);
      sx0 = (sx0 - ix0) * fx; sx1 = (sx1 - ix0) * fx;
      sy0 = (sy0 - iy0) * fy; sy1 = (sy1 - iy0) * fy;
      src = sub;
    }
  }
  const ax = (sx1 - sx0) / ow, ay = (sy1 - sy0) / oh;
  return warpDiag(src, ax, sx0 + 0.5 * ax - 0.5, ay, sy0 + 0.5 * ay - 0.5, ow, oh, cubic, constant);
}

// ------------------------------------------------------------------ chi tiết cao tần
function median(a) {
  const s = Float64Array.from(a).sort(), n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
// độ lệch chuẩn "bền" (không bị vài cạnh sắc kéo lên), tính trên tối đa 200000 mẫu; v: mảng RGB xen kẽ
function rsd(v) {
  let n = v.length / 3, sel = null;
  const M = 200000;
  if (n > M) { sel = new Int32Array(M); const st = (n - 1) / (M - 1); for (let i = 0; i < M; i++) sel[i] = Math.trunc(i * st); n = M; }
  let tot = 0;
  for (let c = 0; c < 3; c++) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = v[(sel ? sel[i] : i) * 3 + c];
    const med = median(a);
    for (let i = 0; i < n; i++) a[i] = Math.abs(a[i] - med);
    tot += median(a);
  }
  return 1.4826 * tot / 3;
}
const hanning = (M) => { const o = new Float64Array(M); if (M === 1) { o[0] = 1; return o; } for (let i = 0; i < M; i++) o[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (M - 1)); return o; };

function holeBox(hole, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

// C: ảnh hiện tại (còn vật), F: nền AI cùng cỡ, hole: vùng xoá; kx, ky: số điểm ảnh hiện tại ứng với một điểm
// ảnh của nền AI. Trả F + chi tiết cao tần (hạt, vân) lấy từ các mảnh quanh vùng xoá giống nền AI nhất
// (so ở độ phân giải của nền AI, ghép phần dư cao tần ở độ phân giải hiện tại).
export function detail(C, F, hole, kx, ky, P = PATCH) {
  const W = C.w, H = C.h;
  const hb = holeBox(hole, W, H);
  if (!hb) return F;
  // nền AI luôn mịn hơn ảnh thật (kể cả khi đủ độ phân giải): luôn ghép hạt / vân; lưới so mảnh >= 1 điểm ảnh
  kx = Math.max(1.0, kx); ky = Math.max(1.0, ky);
  const [hx0, hy0, hx1, hy1] = hb;
  const mg = Math.trunc(Math.max(3 * P * Math.max(kx, ky), 0.45 * Math.min(hy1 - hy0, hx1 - hx0)));
  const Y0 = Math.max(0, hy0 - mg), Y1 = Math.min(H, hy1 + mg), X0 = Math.max(0, hx0 - mg), X1 = Math.min(W, hx1 + mg);
  const Cs = crop(C, X0, Y0, X1, Y1), Fs = crop(F, X0, Y0, X1, Y1), Hs = cropMask(hole, W, X0, Y0, X1, Y1);
  const ch = Y1 - Y0, cw = X1 - X0;
  const nW = Math.max(1, pyRound(cw / kx)), nH = Math.max(1, pyRound(ch / ky));
  if (nW < 3 * P || nH < 3 * P) return F;
  kx = cw / nW; ky = ch / nH;
  // phần ảnh thật mà nền AI không có: dải mịn (hạt, sợi vải, vân nhỏ cỡ DETAIL_MIN..DETAIL_BAND px)
  const kb = Math.min(DETAIL_BAND, Math.max(DETAIL_MIN, Math.max(kx, ky) * 1.5));
  const lw = Math.max(1, pyRound(cw / kb)), lh = Math.max(1, pyRound(ch / kb));
  const low = (im) => resizeCubic(cv.resizeArea(im, lw, lh), cw, ch);
  const lc = low(Cs), R = img(cw, ch, 3), R2 = new Float32Array(cw * ch);
  for (let i = 0; i < R.d.length; i++) R.d[i] = f32(Cs.d[i] - lc.d[i]);
  for (let q = 0; q < cw * ch; q++) R2[q] = f32((R.d[q * 3] * R.d[q * 3] + R.d[q * 3 + 1] * R.d[q * 3 + 1] + R.d[q * 3 + 2] * R.d[q * 3 + 2]) / 3);
  const mix = img(cw, ch, 3);
  for (let i = 0; i < cw * ch; i++) { const s = Hs[i] ? Fs : Cs; mix.d[i * 3] = s.d[i * 3]; mix.d[i * 3 + 1] = s.d[i * 3 + 1]; mix.d[i * 3 + 2] = s.d[i * 3 + 2]; }
  const G = cv.resizeArea(mix, nW, nH);
  const hla = cv.resizeArea(maskToImg(Hs, cw, ch), nW, nH);
  const hl = new Uint8Array(nW * nH);
  let hlSum = 0, ey0 = Infinity, ey1 = -1, ex0 = Infinity, ex1 = -1;
  for (let y = 0; y < nH; y++) for (let x = 0; x < nW; x++) {
    const i = y * nW + x;
    if (hla.d[i] > 0) { hl[i] = 1; hlSum++; if (y < ey0) ey0 = y; if (y > ey1) ey1 = y; if (x < ex0) ex0 = x; if (x > ex1) ex1 = x; }
  }
  if (!hlSum) return F;
  // vùng xoá rất rộng: mảnh to hơn để số mảnh cần ghép <= ~7000
  P = [P, 8, 10, 12, 16].find((p) => p >= P && hlSum / ((p >> 1) ** 2) <= 7000) || 16;
  const bad = dilateRect3(hl, nW, nH);
  const NW1 = nW + 1;
  const integ = (m) => {
    const ii = new Int32Array((nH + 1) * NW1);
    for (let y = 0; y < nH; y++) { let s = 0; for (let x = 0; x < nW; x++) { s += m[y * nW + x]; ii[(y + 1) * NW1 + x + 1] = ii[y * NW1 + x + 1] + s; } }
    return ii;
  };
  const nyw = nH - P + 1, nxw = nW - P + 1;
  const winSum = (ii, y, x) => ii[(y + P) * NW1 + x + P] - ii[y * NW1 + x + P] - ii[(y + P) * NW1 + x] + ii[y * NW1 + x];
  const ib = integ(bad), ih = integ(hl);
  const ok = new Uint8Array(nyw * nxw);
  for (let y = 0; y < nyw; y++) for (let x = 0; x < nxw; x++) ok[y * nxw + x] = winSum(ib, y, x) === 0 ? 1 : 0;
  // chỉ lấy mảnh nguồn SÁT quanh vùng xoá (cùng mặt phẳng: thảm lấy hạt thảm, không lấy vân sọc của phông xa)
  const near = Math.max(4 * P, 0.5 * Math.min(ey1 - ey0 + 1, ex1 - ex0 + 1));
  const nh0 = new Uint8Array(nW * nH);
  for (let i = 0; i < nh0.length; i++) nh0[i] = hl[i] ? 0 : 1;
  const dist = cv.distL2(nh0, nW, nH);
  let nNear = 0;
  for (let y = 0; y < nyw; y++) for (let x = 0; x < nxw; x++) if (ok[y * nxw + x] && dist[y * nW + x] <= near) nNear++;
  if (nNear >= 64) for (let y = 0; y < nyw; y++) for (let x = 0; x < nxw; x++) if (!(dist[y * nW + x] <= near)) ok[y * nxw + x] = 0;
  // bỏ mảnh nguồn nằm trên cạnh sắc (mép áo, mép chữ...): phần dư ở đó là CẠNH chứ không phải hạt -> ghép vào thành
  // vệt sáng / tối và sọc lạ. Năng lượng phần dư mỗi mảnh (tính ở lưới thấp) so với mức chung quanh vùng xoá
  {
    const eR = cv.resizeArea(img(cw, ch, 1, R2), nW, nH).d;
    const ie = new Float64Array((nH + 1) * NW1);
    for (let y = 0; y < nH; y++) { let s = 0; for (let x = 0; x < nW; x++) { s += eR[y * nW + x]; ie[(y + 1) * NW1 + x + 1] = ie[y * NW1 + x + 1] + s; } }
    const pe = new Float32Array(nyw * nxw);
    for (let y = 0; y < nyw; y++) for (let x = 0; x < nxw; x++) pe[y * nxw + x] = winSum(ie, y, x) / (P * P);
    let n0 = 0;
    for (let i = 0; i < ok.length; i++) n0 += ok[i];
    if (n0 >= 64) {
      const vals = new Float64Array(n0);
      for (let i = 0, k = 0; i < ok.length; i++) if (ok[i]) vals[k++] = pe[i];
      const lim = 3.0 * median(vals);
      let n1 = 0;
      for (let i = 0; i < ok.length; i++) if (ok[i] && pe[i] <= lim) n1++;
      if (n1 >= 64) for (let i = 0; i < ok.length; i++) if (!(pe[i] <= lim)) ok[i] = 0;
    }
  }
  let okN = 0;
  for (let i = 0; i < ok.length; i++) okN += ok[i];
  const st = okN ? Math.max(1, Math.trunc(Math.ceil(Math.sqrt(okN / 24000.0)))) : 1;
  const sy = [], sx = [];
  for (let y = 0; y < nyw; y += st) for (let x = 0; x < nxw; x += st) if (ok[y * nxw + x]) { sy.push(y); sx.push(x); }
  if (sy.length < 8) return F;
  const step = Math.max(1, P >> 1);
  const hy = [], hx = [];
  for (let y = 0; y < nyw; y += step) for (let x = 0; x < nxw; x += step) if (winSum(ih, y, x) > 0) { hy.push(y); hx.push(x); }
  if (!hy.length) return F;
  // mảnh = G[y:y+P, x:x+P, :] trải phẳng (hàng, cột, kênh)
  const Dm = P * P * 3, RowL = P * 3;
  const vec = (ys, xs) => {
    const out = new Float32Array(ys.length * Dm);
    for (let i = 0; i < ys.length; i++) for (let dy = 0; dy < P; dy++)
      out.set(G.d.subarray(((ys[i] + dy) * nW + xs[i]) * 3, ((ys[i] + dy) * nW + xs[i] + P) * 3), i * Dm + dy * RowL);
    return out;
  };
  const B = vec(sy, sx), A = vec(hy, hx), nb = sy.length, na = hy.length;
  // giống màu + ưu tiên mảnh ở gần; chọn xoay vòng trong 4 mảnh tốt nhất (theo vị trí, cố định) -> nền AI trơn đều
  // không bị lặp đúng một mảnh hạt khắp nơi. Cách tìm 4 mảnh tốt nhất (cùng kết quả với so hết, nhanh hơn nhiều):
  // - thử trước 4 mảnh tốt nhất của mảnh liền trước;
  // - cận dưới theo màu trung bình 4 góc mảnh: chắc chắn thua mảnh thứ 4 thì bỏ qua;
  // - cộng dồn từng hàng mảnh, vượt mảnh thứ 4 thì dừng.
  const lam = 3 * P * P * 0.03 ** 2 / Math.max(1.0, near) ** 2;
  const KB = Math.min(4, nb);
  const ts0 = performance.now();
  const hp = P >> 1, nq = hp * hp;
  const qmeans = (V, n) => {          // trung bình màu của 4 góc mảnh: [góc][kênh] -> 12 số / mảnh
    const o = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) {
      const vo = i * Dm;
      for (let dy = 0; dy < P; dy++) for (let dx = 0; dx < P; dx++) {
        const q = ((dy >= hp ? 2 : 0) + (dx >= hp ? 1 : 0)) * 3, s = vo + dy * RowL + dx * 3;
        o[i * 12 + q] += V[s]; o[i * 12 + q + 1] += V[s + 1]; o[i * 12 + q + 2] += V[s + 2];
      }
      for (let k = 0; k < 12; k++) o[i * 12 + k] /= nq;
    }
    return o;
  };
  const QA = qmeans(A, na), QB = qmeans(B, nb);
  const best = new Int32Array(na), topD = new Float64Array(KB), topJ = new Int32Array(KB), prevJ = new Int32Array(KB).fill(-1);
  for (let i = 0; i < na; i++) {
    const ao = i * Dm, qa = i * 12, ay = hy[i], ax = hx[i];
    let cnt = 0, lim = Infinity;
    const consider = (j) => {
      const ddy = ay - sy[j], ddx = ax - sx[j];
      let d = lam * (ddy * ddy + ddx * ddx);
      if (d > lim) return;
      const qb = j * 12;
      let lb = d;
      for (let k = 0; k < 12; k++) { const e = QA[qa + k] - QB[qb + k]; lb += nq * e * e; }
      if (lb > lim * (1 + 1e-9) + 1e-12) return;
      const bo = j * Dm;
      for (let r = 0; r < Dm && d <= lim; r += RowL) {
        for (let q = r; q < r + RowL; q++) { const e = A[ao + q] - B[bo + q]; d += e * e; }
      }
      if (d > lim) return;
      // chèn vào danh sách KB mảnh tốt nhất (tăng dần; bằng nhau thì chỉ số nhỏ trước)
      if (cnt === KB && !(d < topD[KB - 1] || (d === topD[KB - 1] && j < topJ[KB - 1]))) return;
      for (let t = 0; t < cnt; t++) if (topJ[t] === j) return;
      let p = cnt < KB ? cnt++ : KB - 1;
      while (p > 0 && (topD[p - 1] > d || (topD[p - 1] === d && topJ[p - 1] > j))) { topD[p] = topD[p - 1]; topJ[p] = topJ[p - 1]; p--; }
      topD[p] = d; topJ[p] = j;
      if (cnt === KB) lim = topD[KB - 1];
    };
    for (let t = 0; t < KB; t++) if (prevJ[t] >= 0) consider(prevJ[t]);
    for (let j = 0; j < nb; j++) consider(j);
    best[i] = topJ[(ay * 7 + ax * 13) % KB];
    for (let t = 0; t < KB; t++) prevJ[t] = topJ[t];
  }
  DBG.ms.search = (DBG.ms.search || 0) + performance.now() - ts0; DBG.n = { na, nb, P, Dm };
  // ghép phần dư cao tần theo mảnh (cửa sổ Hann chồng nhau một nửa -> không lộ đường nối)
  const Pw = Math.trunc(Math.ceil(P * kx)), Ph = Math.trunc(Math.ceil(P * ky));
  const hwy = hanning(Ph + 2).subarray(1, Ph + 1), hwx = hanning(Pw + 2).subarray(1, Pw + 1);
  const win = new Float32Array(Ph * Pw);
  for (let y = 0; y < Ph; y++) for (let x = 0; x < Pw; x++) win[y * Pw + x] = hwy[y] * hwx[x];
  const acc = new Float32Array(cw * ch * 3), acc2 = new Float32Array(cw * ch), ws = new Float32Array(cw * ch);
  for (let i = 0; i < na; i++) {
    const dy = pyRound(hy[i] * ky), dx = pyRound(hx[i] * kx);
    const j = best[i];
    const oy = Math.min(pyRound(sy[j] * ky), ch - Ph), ox = Math.min(pyRound(sx[j] * kx), cw - Pw);
    if (oy < 0 || ox < 0) continue;
    const h1 = Math.min(Ph, ch - dy), w1 = Math.min(Pw, cw - dx);
    if (h1 <= 0 || w1 <= 0) continue;
    for (let y = 0; y < h1; y++) for (let x = 0; x < w1; x++) {
      const wv = win[y * Pw + x], q = (dy + y) * cw + dx + x, sq = (oy + y) * cw + ox + x, s = sq * 3;
      acc[q * 3] += R.d[s] * wv; acc[q * 3 + 1] += R.d[s + 1] * wv; acc[q * 3 + 2] += R.d[s + 2] * wv;
      acc2[q] += R2[sq] * wv;
      ws[q] += wv;
    }
  }
  const D = new Float32Array(cw * ch * 3), et0 = img(cw, ch, 1), ec0 = img(cw, ch, 1);
  for (let q = 0; q < cw * ch; q++) {
    const wsm = Math.max(ws[q], 1e-4);
    D[q * 3] = acc[q * 3] / wsm; D[q * 3 + 1] = acc[q * 3 + 1] / wsm; D[q * 3 + 2] = acc[q * 3 + 2] / wsm;
    et0.d[q] = acc2[q] / wsm;
    ec0.d[q] = (D[q * 3] * D[q * 3] + D[q * 3 + 1] * D[q * 3 + 1] + D[q * 3 + 2] * D[q * 3 + 2]) / 3;
  }
  // chỗ các mảnh chồng nhau: trung bình nhiều mảnh khác nhau làm hạt nhạt đi -> cân lại theo vùng nhỏ (lưới thấp):
  // năng lượng hạt = năng lượng trung bình của các mảnh góp vào
  const et = cv.gaussianBlur(cv.resizeArea(et0, nW, nH), 0.5 * P), ec = cv.gaussianBlur(cv.resizeArea(ec0, nW, nH), 0.5 * P);
  const gl = img(nW, nH, 1);
  for (let i = 0; i < gl.d.length; i++) gl.d[i] = Math.min(1.6, Math.max(1.0, Math.sqrt(et.d[i] / Math.max(ec.d[i], 1e-10))));
  const gmap = cv.resizeLinear(gl, cw, ch).d;
  for (let q = 0; q < cw * ch; q++) {
    if (ws[q] <= 1e-4) { D[q * 3] = D[q * 3 + 1] = D[q * 3 + 2] = 0; continue; }
    const g = gmap[q];
    D[q * 3] *= g; D[q * 3 + 1] *= g; D[q * 3 + 2] *= g;
  }
  // bù biên độ: tổng hạt trong vùng xoá (hạt sẵn có của nền AI + phần ghép) = hạt của ảnh thật sát quanh vùng xoá
  const rl0 = dilateEllipse(hl, nW, nH, 2 * P + 1), rl = new Uint8Array(nW * nH);
  for (let i = 0; i < rl.length; i++) rl[i] = rl0[i] > 0 && !hl[i] ? 1 : 0;
  const ring = resizeNearestMask(rl, nW, nH, cw, ch);
  let nr = 0, nh = 0;
  for (let i = 0; i < ring.length; i++) { if (Hs[i]) { ring[i] = 0; nh++; } else if (ring[i]) nr++; }
  if (nr > 50 && nh > 50) {
    const lf = low(Fs);
    const vr = new Float32Array(nr * 3), vd = new Float32Array(nh * 3), vf = new Float32Array(nh * 3);
    for (let i = 0, a = 0, b = 0; i < ring.length; i++) {
      if (ring[i]) for (let k = 0; k < 3; k++) vr[a++] = R.d[i * 3 + k];
      if (Hs[i]) { for (let k = 0; k < 3; k++) { vd[b] = D[i * 3 + k]; vf[b] = Fs.d[i * 3 + k] - lf.d[i * 3 + k]; b++; } }
    }
    const sdR = rsd(vr), sdD = rsd(vd), sdF = rsd(vf);
    if (sdD > 1e-6) {
      const g = f32(Math.min(1.8, Math.max(0.6, Math.sqrt(Math.max(sdR * sdR - sdF * sdF, 0.0)) / sdD)));
      for (let i = 0; i < D.length; i++) D[i] *= g;
    }
  }
  const out = { w: F.w, h: F.h, c: 3, d: new Float32Array(F.d) };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const q = y * cw + x, o = ((y + Y0) * W + x + X0) * 3;
    out.d[o] = Fs.d[q * 3] + D[q * 3]; out.d[o + 1] = Fs.d[q * 3 + 1] + D[q * 3 + 1]; out.d[o + 2] = Fs.d[q * 3 + 2] + D[q * 3 + 2];
  }
  return out;
}

// ------------------------------------------------------------------ hoà mép
// màng mượt (phương trình Laplace) cho D bên trong 'inside', khớp giá trị D ở biên; đa lưới
function membrane(D, inside) {
  const { w, h, c } = D;
  const out = { w, h, c, d: new Float32Array(D.d) };
  let any = false;
  for (let i = 0; i < inside.length; i++) if (inside[i]) { any = true; break; }
  if (!any) return out;
  let n;
  if (Math.max(h, w) > 40) {
    const wc = (w + 1) >> 1, hc = (h + 1) >> 1;
    const om = img(w, h, 1), Dm = img(w, h, c);
    for (let i = 0; i < w * h; i++) { const o = inside[i] ? 0 : 1; om.d[i] = o; for (let k = 0; k < c; k++) Dm.d[i * c + k] = out.d[i * c + k] * o; }
    const wts = cv.resizeArea(om, wc, hc), Dc = cv.resizeArea(Dm, wc, hc);
    const insc = new Uint8Array(wc * hc);
    for (let i = 0; i < wc * hc; i++) {
      if (wts.d[i] < 1e-3) { insc[i] = 1; for (let k = 0; k < c; k++) Dc.d[i * c + k] = 0; }
      else for (let k = 0; k < c; k++) Dc.d[i * c + k] /= Math.max(wts.d[i], 1e-6);
    }
    const init = cv.resizeLinear(membrane(Dc, insc), w, h);
    for (let i = 0; i < w * h; i++) if (inside[i]) for (let k = 0; k < c; k++) out.d[i * c + k] = init.d[i * c + k];
    n = 40;
  } else {
    const mean = new Float64Array(c); let cnt = 0;
    for (let i = 0; i < w * h; i++) if (!inside[i]) { cnt++; for (let k = 0; k < c; k++) mean[k] += out.d[i * c + k]; }
    for (let i = 0; i < w * h; i++) if (inside[i]) for (let k = 0; k < c; k++) out.d[i * c + k] = cnt ? mean[k] / cnt : 0;
    n = 260;
  }
  const idx = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (inside[y * w + x]) idx.push(y * w + x);
  const tmp = new Float32Array(idx.length * c), d = out.d;
  for (let it = 0; it < n; it++) {
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q];
      for (let k = 0; k < c; k++) tmp[q * c + k] = 0.25 * (d[(i - w) * c + k] + d[(i + w) * c + k] + d[(i - 1) * c + k] + d[(i + 1) * c + k]);
    }
    for (let q = 0; q < idx.length; q++) for (let k = 0; k < c; k++) d[idx[q] * c + k] = tmp[q * c + k];
  }
  return out;
}

// độ dốc lớn nhất trong 3 kênh: sqrt(Sobel x² + Sobel y²) (cv2.Sobel ksize 3, viền BORDER_REFLECT_101)
function sobelMax(d, w, h) {
  const o = new Float32Array(w * h), rx = cv.border101;
  for (let y = 0; y < h; y++) {
    const ym = rx(y - 1, h), yp = rx(y + 1, h);
    for (let x = 0; x < w; x++) {
      const xm = rx(x - 1, w), xp = rx(x + 1, w);
      let mx = 0;
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => d[(yy * w + xx) * 3 + c];
        const gx = (p(ym, xp) - p(ym, xm)) + 2 * (p(y, xp) - p(y, xm)) + (p(yp, xp) - p(yp, xm));
        const gy = (p(yp, xm) - p(ym, xm)) + 2 * (p(yp, x) - p(ym, x)) + (p(yp, xp) - p(ym, xp));
        const g = Math.sqrt(f32(gx) * f32(gx) + f32(gy) * f32(gy));
        if (g > mx) mx = g;
      }
      o[y * w + x] = mx;
    }
  }
  return o;
}

// Hoà mép kiểu ghép Poisson:
// - đo độ lệch màu / sáng giữa nền AI và ảnh thật ngay quanh vùng xoá;
// - bù dần vào trong (màng mượt) để nền AI khớp liền với xung quanh.
// tinfo: [[rx0, ry0, rx1, ry1, L, band]] các ô AI, toạ độ trong vùng C.
// ix0, iy0: góc vùng C trong ảnh w x h.
// f: số điểm ảnh hiện tại / điểm lưới thấp; kn: số điểm ảnh hiện tại ứng với một điểm ảnh của mô hình (512).
function seamFix(C, F, hole, tinfo, ix0, iy0, w, h, f, kn) {
  const W = C.w, H = C.h;
  const hb = holeBox(hole, W, H);
  if (!hb) return F;
  const [hx0, hy0, hx1, hy1] = hb;
  const mg = Math.trunc(Math.max(12 * f, 0.08 * Math.max(hy1 - hy0, hx1 - hx0)));
  const Y0 = Math.max(0, hy0 - mg), Y1 = Math.min(H, hy1 + mg), X0 = Math.max(0, hx0 - mg), X1 = Math.min(W, hx1 + mg);
  const Cs = crop(C, X0, Y0, X1, Y1), Hs = cropMask(hole, W, X0, Y0, X1, Y1);
  const ch = Y1 - Y0, cw = X1 - X0;
  f = Math.max(1.0, f);
  const gw = Math.max(8, pyRound(cw / f)), gh = Math.max(8, pyRound(ch / f));
  const fx = cw / gw, fy = ch / gh, same = gw === cw && gh === ch;
  const Cl = same ? { w: cw, h: ch, c: 3, d: new Float32Array(Cs.d) } : cv.resizeArea(Cs, gw, gh);
  let Hl;
  if (same) Hl = Hs.slice();
  else { const t = cv.resizeArea(maskToImg(Hs, cw, ch), gw, gh); Hl = new Uint8Array(gw * gh); for (let i = 0; i < Hl.length; i++) Hl[i] = t.d[i] > 0.02 ? 1 : 0; }
  // nền AI (cả ngoài vùng xoá) trên lưới thấp, mỗi điểm lấy từ ô AI nhận dải chứa nó
  const Pl = { w: gw, h: gh, c: 3, d: new Float32Array(Cl.d) };
  const got = new Uint8Array(gw * gh);
  for (let pas = 0; pas < 2; pas++) {
    for (const [rx0, ry0, rx1, ry1, L, band] of tinfo) {
      const gx0 = Math.max(0, Math.trunc(Math.ceil((rx0 - X0) / fx))), gx1 = Math.min(gw, Math.trunc(Math.floor((rx1 - X0) / fx)));
      const gy0 = Math.max(0, Math.trunc(Math.ceil((ry0 - Y0) / fy))), gy1 = Math.min(gh, Math.trunc(Math.floor((ry1 - Y0) / fy)));
      if (gx1 - gx0 < 1 || gy1 - gy0 < 1) continue;
      const ow = gx1 - gx0, ohh = gy1 - gy0, own = new Uint8Array(ow * ohh);
      let anyOwn = false;
      for (let y = 0; y < ohh; y++) for (let x = 0; x < ow; x++) {
        let o = !got[(y + gy0) * gw + x + gx0];
        if (o && pas === 0 && band) {
          const [axis, lo, hi] = band;
          const cc = axis ? (iy0 + Y0 + (y + gy0 + 0.5) * fy) / h : (ix0 + X0 + (x + gx0 + 0.5) * fx) / w;
          o = cc >= lo && cc < hi;
        }
        if (o) { own[y * ow + x] = 1; anyOwn = true; }
      }
      if (!anyOwn) continue;
      const sx = N / (rx1 - rx0), sy = N / (ry1 - ry0);
      const Lt = resample(L, (X0 + gx0 * fx - rx0) * sx, (Y0 + gy0 * fy - ry0) * sy, (X0 + gx1 * fx - rx0) * sx, (Y0 + gy1 * fy - ry0) * sy, ow, ohh);
      for (let y = 0; y < ohh; y++) for (let x = 0; x < ow; x++) if (own[y * ow + x]) {
        const q = (y + gy0) * gw + x + gx0, s = (y * ow + x) * 3;
        Pl.d[q * 3] = Lt.d[s]; Pl.d[q * 3 + 1] = Lt.d[s + 1]; Pl.d[q * 3 + 2] = Lt.d[s + 2];
        got[q] = 1;
      }
    }
  }
  // vành ngay ngoài vùng xoá mà mô hình cũng LẤP (mặt nạ đưa vào AI nới thêm RING_N điểm): ở đó có cả nền AI
  // "tưởng tượng" lẫn ảnh thật -> độ lệch đúng tại mép
  const rw = Math.max(1, Math.trunc(Math.floor(RING_N * kn / f)) - 1);
  const dl = dilateEllipse(Hl, gw, gh, 2 * rw + 1), ring = new Uint8Array(gw * gh);
  let nRing = 0;
  for (let i = 0; i < ring.length; i++) if (dl[i] > 0 && !Hl[i] && got[i]) { ring[i] = 1; nRing++; }
  if (nRing < 8) return F;
  const bc = cv.gaussianBlur(Cl, 1.0).d, bp = cv.gaussianBlur(Pl, 1.0).d;
  const D = img(gw, gh, 3);
  for (let i = 0; i < D.d.length; i++) D.d[i] = f32(bc[i] - bp[i]);
  // điểm mép lệch quá nhiều (vật còn sót ngay ngoài nét tô) hoặc nằm trên cạnh thật của cảnh (mép áo, chữ...):
  // không kéo vào trong — chỉ khớp phần mặt phẳng liền mạch (tường, thảm, trời)
  const edge = sobelMax(bc, gw, gh);
  const good = new Uint8Array(gw * gh), ins = new Uint8Array(gw * gh);
  const rf = img(gw, gh, 1), Dr = img(gw, gh, 3);
  for (let i = 0; i < gw * gh; i++) {
    const big = Math.max(Math.abs(D.d[i * 3]), Math.abs(D.d[i * 3 + 1]), Math.abs(D.d[i * 3 + 2])) > SEAM_OK || edge[i] > SEAM_EDGE;
    const isBad = ring[i] && big;
    good[i] = ring[i] && !big ? 1 : 0;
    ins[i] = Hl[i] || isBad ? 1 : 0;
    rf.d[i] = good[i];
    for (let k = 0; k < 3; k++) Dr.d[i * 3 + k] = D.d[i * 3 + k] * good[i];
  }
  // làm mượt dọc vành (chỉ lấy thấp tần: bỏ hạt / vân nhỏ)
  const sg = Math.max(1.5, 2.0 * rw);
  const bDs = cv.gaussianBlur(Dr, sg).d, bRf = cv.gaussianBlur(rf, sg).d;
  const Dv = img(gw, gh, 3);
  for (let i = 0; i < gw * gh; i++) if (good[i]) { const q = Math.max(bRf[i], 1e-4); for (let k = 0; k < 3; k++) Dv.d[i * 3 + k] = f32(bDs[i * 3 + k] / q); }
  const corr = membrane(Dv, ins);
  for (let i = 0; i < corr.d.length; i++) corr.d[i] = Math.min(SEAM_MAX, Math.max(-SEAM_MAX, corr.d[i]));
  const cu = same ? corr : resizeCubic(corr, cw, ch);
  const out = { w: F.w, h: F.h, c: 3, d: new Float32Array(F.d) };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const q = y * cw + x;
    if (!Hs[q]) continue;
    const o = ((y + Y0) * W + x + X0) * 3;
    out.d[o] += cu.d[q * 3]; out.d[o + 1] += cu.d[q * 3 + 1]; out.d[o + 2] += cu.d[q * 3 + 2];
  }
  return out;
}

// ------------------------------------------------------------------ lấp tạm (Telea, như cv2.inpaint INPAINT_TELEA)
const KNOWN = 0, BAND = 1, INSIDE = 2, CHANGE = 3;
class TimeHeap {           // hàng đợi ưu tiên theo T, bằng nhau thì vào trước ra trước (như CvPriorityQueueFloat)
  constructor() { this.a = []; this.n = 0; }
  push(i, j, T) {
    const a = this.a, e = [T, this.n++, i, j];
    a.push(e);
    let k = a.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (lt(a[p], e)) break; a[k] = a[p]; k = p; }
    a[k] = e;
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && lt(a[c + 1], a[c])) c++;
        if (!lt(a[c], last)) break;
        a[k] = a[c]; k = c;
      }
      a[k] = last;
    }
    return top;
  }
}
const lt = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);

function fmSolve(i1, j1, i2, j2, f, t, ew) {
  const a11 = t[i1 * ew + j1], a22 = t[i2 * ew + j2], m12 = Math.min(a11, a22);
  let sol;
  if (f[i1 * ew + j1] !== INSIDE) {
    if (f[i2 * ew + j2] !== INSIDE) sol = Math.abs(a11 - a22) >= 1.0 ? 1 + m12 : (a11 + a22 + Math.sqrt(2 - (a11 - a22) * (a11 - a22))) * 0.5;
    else sol = 1 + a11;
  } else if (f[i2 * ew + j2] !== INSIDE) sol = 1 + a22;
  else sol = 1 + m12;
  return f32(sol);
}
const NB = [[-1, 0], [0, -1], [1, 0], [0, 1]];
function solve4(i, j, f, t, ew) {
  return Math.min(fmSolve(i - 1, j, i, j - 1, f, t, ew), fmSolve(i + 1, j, i, j - 1, f, t, ew),
    fmSolve(i - 1, j, i, j + 1, f, t, ew), fmSolve(i + 1, j, i, j + 1, f, t, ew));
}
// u8: RGB 8 bit w*h*3; mask: Uint8Array (khác 0 = cần lấp); trả RGB 8 bit đã lấp
export function telea(u8, mask, w, h, radius = 5) {
  const range = Math.min(100, Math.max(1, Math.round(radius)));
  const ew = w + 2, eh = h + 2, n = ew * eh;
  const out = new Uint8Array(u8);
  const mk = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) mk[(y + 1) * ew + x + 1] = INSIDE;
  const f = new Uint8Array(n), t = new Float32Array(n).fill(1.0e6);
  // dải hẹp: giãn chữ thập 3x3 trừ vùng lấp
  const band = new Uint8Array(n);
  for (let y = 1; y < eh - 1; y++) for (let x = 1; x < ew - 1; x++) {
    const i = y * ew + x;
    if (mk[i]) continue;
    if (mk[i - 1] || mk[i + 1] || mk[i - ew] || mk[i + ew]) band[i] = INSIDE;
  }
  const heap = new TimeHeap();
  for (let i = 0; i < n; i++) if (band[i]) heap.push((i / ew) | 0, i % ew, 0);
  for (let i = 0; i < n; i++) { if (band[i]) { f[i] = BAND; t[i] = 0; } if (mk[i]) f[i] = INSIDE; }
  // khoảng cách phía ngoài (âm) trong bán kính range
  {
    const outm = new Uint8Array(n);
    for (let y = 1; y < eh - 1; y++) for (let x = 1; x < ew - 1; x++) {
      const i = y * ew + x;
      if (mk[i]) continue;
      let near = false;
      for (let dy = -range; dy <= range && !near; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= eh) continue;
        for (let dx = -range; dx <= range; dx++) { const xx = x + dx; if (xx >= 0 && xx < ew && mk[yy * ew + xx]) { near = true; break; } }
      }
      if (near) outm[i] = INSIDE;
    }
    const fo = new Uint8Array(n);
    const oh = new TimeHeap();
    for (let i = 0; i < n; i++) if (band[i]) oh.push((i / ew) | 0, i % ew, 0);
    for (let i = 0; i < n; i++) fo[i] = outm[i] && !band[i] ? INSIDE : KNOWN;
    for (let x = 0; x < ew; x++) { fo[x] = 0; fo[(eh - 1) * ew + x] = 0; }
    for (let y = 0; y < eh; y++) { fo[y * ew] = 0; fo[y * ew + ew - 1] = 0; }
    let e;
    while ((e = oh.pop())) {
      const ii = e[2], jj = e[3];
      fo[ii * ew + jj] = CHANGE;
      for (const [di, dj] of NB) {
        const i = ii + di, j = jj + dj;
        if (i <= 0 || j <= 0 || i >= eh - 1 || j >= ew - 1) continue;
        if (fo[i * ew + j] === INSIDE) {
          const dist = solve4(i, j, fo, t, ew);
          t[i * ew + j] = dist; fo[i * ew + j] = BAND; oh.push(i, j, dist);
        }
      }
    }
    for (let i = 0; i < n; i++) if (fo[i] === CHANGE && !band[i] && outm[i]) t[i] = -t[i];
  }
  const px = (r, c, k) => out[(r * w + c) * 3 + k];
  let e;
  while ((e = heap.pop())) {
    const ii = e[2], jj = e[3];
    f[ii * ew + jj] = KNOWN;
    for (const [di, dj] of NB) {
      const i = ii + di, j = jj + dj;
      if (i <= 0 || j <= 0 || i > eh - 2 || j > ew - 2) continue;
      if (f[i * ew + j] !== INSIDE) continue;
      const dist = solve4(i, j, f, t, ew);
      t[i * ew + j] = dist;
      const T = (r, c) => t[r * ew + c], Fv = (r, c) => f[r * ew + c];
      let gtx, gty;
      if (Fv(i, j + 1) !== INSIDE) gtx = Fv(i, j - 1) !== INSIDE ? (T(i, j + 1) - T(i, j - 1)) * 0.5 : T(i, j + 1) - T(i, j);
      else gtx = Fv(i, j - 1) !== INSIDE ? T(i, j) - T(i, j - 1) : 0;
      if (Fv(i + 1, j) !== INSIDE) gty = Fv(i - 1, j) !== INSIDE ? (T(i + 1, j) - T(i - 1, j)) * 0.5 : T(i + 1, j) - T(i, j);
      else gty = Fv(i - 1, j) !== INSIDE ? T(i, j) - T(i - 1, j) : 0;
      for (let color = 0; color < 3; color++) {
        let Ia = 0, Jx = 0, Jy = 0, s = 1.0e-20;
        for (let k = i - range; k <= i + range; k++) {
          const km = k - 1 + (k === 1 ? 1 : 0), kp = k - 1 - (k === eh - 2 ? 1 : 0);
          for (let l = j - range; l <= j + range; l++) {
            const lm = l - 1 + (l === 1 ? 1 : 0), lp = l - 1 - (l === ew - 2 ? 1 : 0);
            if (!(k > 0 && l > 0 && k < eh - 1 && l < ew - 1)) continue;
            if (Fv(k, l) === INSIDE || (l - j) * (l - j) + (k - i) * (k - i) > range * range) continue;
            const ry = i - k, rx = j - l, len = Math.sqrt(rx * rx + ry * ry);
            const dst = f32(1 / (len * Math.sqrt(len)));
            const lev = f32(1 / (1 + Math.abs(T(k, l) - T(i, j))));
            let dir = rx * gtx + ry * gty;
            if (Math.abs(dir) <= 0.01) dir = 0.000001;
            const wv = f32(Math.abs(dst * lev * dir));
            let gix, giy;
            if (Fv(k, l + 1) !== INSIDE) gix = Fv(k, l - 1) !== INSIDE ? (px(km, lp + 1, color) - px(km, lm - 1, color)) * 2.0 : px(km, lp + 1, color) - px(km, lm, color);
            else gix = Fv(k, l - 1) !== INSIDE ? px(km, lp, color) - px(km, lm - 1, color) : 0;
            if (Fv(k + 1, l) !== INSIDE) giy = Fv(k - 1, l) !== INSIDE ? (px(kp + 1, lm, color) - px(km - 1, lm, color)) * 2.0 : px(kp + 1, lm, color) - px(km, lm, color);
            else giy = Fv(k - 1, l) !== INSIDE ? px(kp, lm, color) - px(km - 1, lm, color) : 0;
            Ia += wv * px(km, lm, color);
            Jx -= wv * (gix * rx);
            Jy -= wv * (giy * ry);
            s += wv;
          }
        }
        const sat = Ia / s + (Jx + Jy) / (Math.sqrt(Jx * Jx + Jy * Jy) + 1.0e-20) + 0.5;
        out[((i - 1) * w + j - 1) * 3 + color] = Math.max(0, Math.min(255, pyRound(f32(sat))));   // saturate_cast<uchar>
      }
      f[i * ew + j] = BAND;
      heap.push(i, j, dist);
    }
  }
  return out;
}

// lấp mượt kiểu Telea (bản nháp khi chưa có kết quả AI, hoặc khi không có mô hình).
// Vùng lớn: làm ở ảnh thu nhỏ cho nhanh. Trả [ảnh đã lấp, số điểm ảnh hiện tại ứng với một điểm ảnh đã lấp].
function placeholder(C, hole) {
  const f = Math.min(1.0, Math.sqrt(1.2e6 / Math.max(1, C.w * C.h)));
  let Cs = C, Hs = hole, sw = C.w, sh = C.h;
  if (f < 1.0) {
    sw = Math.max(2, Math.trunc(C.w * f)); sh = Math.max(2, Math.trunc(C.h * f));
    Cs = cv.resizeArea(C, sw, sh);
    const t = cv.resizeArea(maskToImg(hole, C.w, C.h), sw, sh);
    Hs = new Uint8Array(sw * sh); for (let i = 0; i < Hs.length; i++) Hs[i] = t.d[i] > 0 ? 1 : 0;
  }
  const u8 = new Uint8Array(sw * sh * 3);
  for (let i = 0; i < u8.length; i++) u8[i] = Math.trunc(Math.min(1, Math.max(0, Cs.d[i])) * 255 + 0.5);
  const r8 = telea(u8, Hs, sw, sh, 5);
  let r = img(sw, sh, 3);
  for (let i = 0; i < r8.length; i++) r.d[i] = r8[i] / 255.0;
  if (f < 1.0) r = resizeCubic(r, C.w, C.h);
  return [r, 1.0 / f];
}

function bandRows(t, iy0, ix0, y0, y1, x0, x1, w, h) {
  // mặt nạ hàng / cột (theo toạ độ ảnh) các điểm của ô t thuộc dải ô đó nhận; null = cả ô
  if (!t.band) return null;
  const [axis, lo, hi] = t.band;
  const n = axis ? y1 - y0 : x1 - x0, o = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const c = ((axis ? y0 : x0) + i + (axis ? iy0 : ix0) + 0.5) / (axis ? h : w); o[i] = c >= lo && c < hi ? 1 : 0; }
  return { axis, o };
}

// ------------------------------------------------------------------ xoá
// Xoá vùng tô a trên ảnh out (sửa tại chỗ). out ứng với vùng [ox, ox + out.w) x [oy, oy + out.h) của ảnh W x H.
// geo = retouch.areaGeom(a, W, H, ox, oy).
// opt:
// - key: khoá bộ đệm (cacheKey);
// - draft: bản nháp / thumbnail, CHỈ dùng kết quả AI đã có, chưa có thì lấp tạm;
// - fallback: không có mô hình, lấp mượt + chi tiết từ xung quanh.
// Cần chạy mô hình thì yield { inp, m } và nhận nền đã lấp (N*N*3, 0..1). Trả danh sách ô (gồm L) hoặc null.
export function* removeGen(out, a, W, H, ox, oy, geo, opt = {}) {
  const key = opt.key || null;
  const ent = key ? cacheGet(key) : null;
  const tiles = ent ? ent.tiles : plan(a, W, H);
  // khung các ô (toạ độ trong out); bộ đệm phải phủ đủ khung (retouchNeeds đã nới)
  const bx0 = Math.max(0, Math.floor(Math.min(...tiles.map((t) => t.rect[0])) * W - ox));
  const by0 = Math.max(0, Math.floor(Math.min(...tiles.map((t) => t.rect[1])) * H - oy));
  const bx1 = Math.min(out.w, Math.ceil(Math.max(...tiles.map((t) => t.rect[2])) * W - ox));
  const by1 = Math.min(out.h, Math.ceil(Math.max(...tiles.map((t) => t.rect[3])) * H - oy));
  if (bx1 - bx0 < 2 || by1 - by0 < 2) return null;
  const { x0, y0, bw, bh, inside, soft } = geo;
  const o0x = Math.max(bx0, x0), o0y = Math.max(by0, y0), o1x = Math.min(bx1, x0 + bw), o1y = Math.min(by1, y0 + bh);
  if (o0x >= o1x || o0y >= o1y) return null;
  const RW = bx1 - bx0, RH = by1 - by0;
  const hole = new Uint8Array(RW * RH), al = new Float32Array(RW * RH);
  const op = Math.min(1.0, Math.max(0.0, (a.opacity ?? 100) / 100.0));
  let anyHole = false;
  for (let y = o0y; y < o1y; y++) for (let x = o0x; x < o1x; x++) {
    const q = (y - by0) * RW + x - bx0, s = (y - y0) * bw + x - x0;
    hole[q] = inside[s]; al[q] = f32(soft[s] * op);
    if (inside[s]) anyHole = true;
  }
  if (!anyHole) return null;
  const C0 = crop(out, bx0, by0, bx1, by1);
  const ix0 = bx0 + ox, iy0 = by0 + oy;        // góc khung trong ảnh W x H
  const k = Math.min(1.0, REF_SIDE / Math.max(W, H));
  let F, newTiles = null;
  if (!ent && (opt.fallback || opt.draft)) {
    const hb = holeBox(hole, RW, RH);
    const mg = Math.trunc(0.3 * Math.max(hb[3] - 1 - hb[1], hb[2] - 1 - hb[0])) + 8;
    const sy0 = Math.max(0, hb[1] - mg), sy1 = Math.min(RH, hb[3] + mg), sx0 = Math.max(0, hb[0] - mg), sx1 = Math.min(RW, hb[2] + mg);
    F = { w: RW, h: RH, c: 3, d: new Float32Array(C0.d) };
    const [Fp, kf] = placeholder(crop(C0, sx0, sy0, sx1, sy1), cropMask(hole, RW, sx0, sy0, sx1, sy1));
    paste(F, Fp, sx0, sy0);
    if (opt.fallback) F = detail(C0, F, hole, Math.max(kf, 3.0), Math.max(kf, 3.0));
  } else {
    F = { w: RW, h: RH, c: 3, d: new Float32Array(C0.d) };
    const done = new Uint8Array(RW * RH);
    const fills = [], tinfo = [];
    let kxy = null;
    newTiles = [];
    for (let t of tiles) {
      const rx0 = t.rect[0] * W - ix0, ry0 = t.rect[1] * H - iy0, rx1 = t.rect[2] * W - ix0, ry1 = t.rect[3] * H - iy0;
      const sw = rx1 - rx0, sh = ry1 - ry0;
      const nw = Math.max(8, pyRound(Math.min(N, sw * k))), nh = Math.max(8, pyRound(Math.min(N, sh * k)));
      if (!kxy) kxy = [sw / nw, sh / nh];
      const ly0 = Math.max(0, Math.floor(ry0)), ly1 = Math.min(RH, Math.ceil(ry1));
      const lx0 = Math.max(0, Math.floor(rx0)), lx1 = Math.min(RW, Math.ceil(rx1));
      const tw = lx1 - lx0, th = ly1 - ly0;
      let L;
      if (!t.L) {
        const cur = img(tw, th, 3), need = img(tw, th, 1);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
          const q = (y + ly0) * RW + x + lx0, s = done[q] ? F : C0, o = y * tw + x;
          cur.d[o * 3] = s.d[q * 3]; cur.d[o * 3 + 1] = s.d[q * 3 + 1]; cur.d[o * 3 + 2] = s.d[q * 3 + 2];
          need.d[o] = hole[q] && !done[q] ? 1 : 0;
        }
        const ax0 = rx0 - lx0, ay0 = ry0 - ly0;
        let inp = resample(cur, ax0, ay0, ax0 + sw, ay0 + sh, nw, nh);
        if (nw !== N || nh !== N) inp = resizeCubic(inp, N, N);
        for (let i = 0; i < inp.d.length; i++) inp.d[i] = Math.min(1, Math.max(0, inp.d[i]));
        const mf = resample(need, ax0, ay0, ax0 + sw, ay0 + sh, N, N, false, true);
        const m0 = new Uint8Array(N * N);
        for (let i = 0; i < m0.length; i++) m0[i] = mf.d[i] > 0.02 ? 1 : 0;
        // nới mặt nạ RING_N điểm: phủ cả viền mờ của vật + có vành để đo lệch màu ở mép (seamFix)
        const m = dilateEllipse(m0, N, N, 2 * RING_N + 1);
        const L32 = yield { inp: Float32Array.from(inp.d), m };
        t = Object.assign({}, t, { L: f32ToHalf(L32) });
      }
      newTiles.push(t);
      L = { w: N, h: N, c: 3, d: halfToF32(t.L) };
      tinfo.push([rx0, ry0, rx1, ry1, L, t.band]);
      const Lt = resample(L, (lx0 - rx0) * N / sw, (ly0 - ry0) * N / sh, (lx1 - rx0) * N / sw, (ly1 - ry0) * N / sh, tw, th, true);
      const band = bandRows(t, iy0, ix0, ly0, ly1, lx0, lx1, W, H);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const q = (y + ly0) * RW + x + lx0;
        if (!hole[q] || done[q]) continue;
        if (band && !band.o[band.axis ? y : x]) continue;
        const s = (y * tw + x) * 3;
        F.d[q * 3] = Lt.d[s]; F.d[q * 3 + 1] = Lt.d[s + 1]; F.d[q * 3 + 2] = Lt.d[s + 2];
        done[q] = 1;
      }
      if (tiles.length > 1) fills.push([lx0, ly0, lx1, ly1, Lt]);
    }
    // điểm vùng xoá lọt ngoài mọi dải (ô bị dời vào trong ảnh)
    for (const [lx0, ly0, lx1, ly1, Lt] of fills) {
      const tw = lx1 - lx0;
      for (let y = ly0; y < ly1; y++) for (let x = lx0; x < lx1; x++) {
        const q = y * RW + x;
        if (!hole[q] || done[q]) continue;
        const s = ((y - ly0) * tw + x - lx0) * 3;
        F.d[q * 3] = Lt.d[s]; F.d[q * 3 + 1] = Lt.d[s + 1]; F.d[q * 3 + 2] = Lt.d[s + 2];
        done[q] = 1;
      }
    }
    if (!ent && key) cachePut(key, { tiles: newTiles });
    let tq = performance.now();
    if (DBG.seam) F = seamFix(C0, F, hole, tinfo, ix0, iy0, W, H, Math.max(kxy[0], kxy[1]), Math.min(kxy[0], kxy[1]));
    DBG.ms.seam = (DBG.ms.seam || 0) + performance.now() - tq; tq = performance.now();
    if (DBG.detail) F = detail(C0, F, hole, kxy[0], kxy[1]);
    DBG.ms.detail = (DBG.ms.detail || 0) + performance.now() - tq;
  }
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const q = y * RW + x, av = al[q];
    if (!av) continue;
    const o = ((y + by0) * out.w + x + bx0) * 3;
    for (let c = 0; c < 3; c++) out.d[o + c] = C0.d[q * 3 + c] * (1 - av) + F.d[q * 3 + c] * av;
  }
  return newTiles;
}

// cho bài kiểm tra (kiemtra/doi_chieu_xoa_ai.*)
const DBG = { seam: true, detail: true, ms: {} };
export const _t = { resample, seamFix, detail, membrane, placeholder, resizeCubic, DBG };

// chạy không chờ: true = xong; false = cần chạy mô hình (chưa có kết quả), out chưa bị sửa
export function removeSync(out, a, W, H, ox, oy, geo, opt) {
  const g = removeGen(out, a, W, H, ox, oy, geo, opt);
  const r = g.next();
  if (!r.done) { g.return(null); return false; }
  return true;
}
// chạy có chờ mô hình: runModel(inp, m) -> Promise<Float32Array N*N*3>
export async function removeAsync(out, a, W, H, ox, oy, geo, opt, runModel) {
  const g = removeGen(out, a, W, H, ox, oy, geo, opt);
  let r = g.next();
  while (!r.done) r = g.next(await runModel(r.value.inp, r.value.m));
  return r.value;
}
