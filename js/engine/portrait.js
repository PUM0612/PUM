// Retouch chân dung tự động — chép theo portrait.py của PUM máy tính (478 điểm khuôn mặt MediaPipe + mặt nạ người).
// Mọi chỉnh sửa làm trên lớp tần số thấp / trung, giữ lớp chi tiết nhỏ (lỗ chân lông) -> da vẫn thật.
// Ảnh vùng: { w, h, c: 3, d }; khi dựng một vùng của ảnh lớn truyền roi = [ox, oy, W, H].
import * as cv from './cv.js';
import { laplaceFill } from './retouch.js';
import { drawStrokes } from './layers.js';

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_IMG_LEFT = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_IMG_RIGHT = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const LOWER_LID_L = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const LOWER_LID_R = [263, 249, 390, 373, 374, 380, 381, 382, 362];
const IRIS_L = [468, [469, 470, 471, 472]], IRIS_R = [473, [474, 475, 476, 477]];
const BROW_L = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
const BROW_R = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
const LIPS_OUT = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_IN = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];
const CHEEKS = [50, 280, 101, 330, 151, 205, 425];
export const TONE_PRESETS = {
  none: null, cool_white: [0.93, 0.86, 0.86], milk_white: [0.96, 0.88, 0.80], pink_white: [0.96, 0.84, 0.82],
  warm_white: [0.96, 0.85, 0.74], tan: [0.80, 0.62, 0.50], brown: [0.55, 0.40, 0.31],
};
const NUM_KEYS = ['blemish', 'dark_circles', 'even', 'even_texture', 'contour', 'shine', 'hair_outer', 'hair_inner', 'hair_dark',
  'teeth_bright', 'teeth_desat', 'iris_l', 'iris_r', 'sclera_l', 'sclera_r', 'lips', 'body_even', 'body_texture', 'tone_uniform',
  'tone_temp', 'tone_tint', 'tone_sat', 'tone_light', 'tone_pref', 'cloth_wrinkle', 'cloth_spots', 'cloth_edges', 'wrinkles',
  'face_slim', 'vline', 'eyes_big', 'nose_slim', 'body_slim', 'blush', 'brows'];

export function portraitActive(p) {
  if (!p || (p.impact ?? 100) <= 0) return false;
  return NUM_KEYS.some((k) => Math.abs(p[k] || 0) > 1e-6) || (p.tone_preset || 'none') !== 'none';
}
export function needsPerson(p) {
  return ['hair_outer', 'hair_dark', 'body_even', 'cloth_wrinkle', 'cloth_spots', 'cloth_edges', 'body_slim'].some((k) => p[k]) ||
    (['all', 'body'].includes(p.tone_target) && (['tone_uniform', 'tone_temp', 'tone_tint', 'tone_sat', 'tone_light', 'tone_pref'].some((k) => p[k]) || (p.tone_preset || 'none') !== 'none'));
}
// Da mặt (bầu mặt trừ mắt, mày, môi), co 3x3 — dùng cho cân bằng trắng / Tự động theo da mặt (engine.face_skin_rgb,
// face_skin_stats của PUM 1.1.2: P = (điểm mốc x cỡ ảnh) lấy phần nguyên, cv2.fillPoly, cv2.erode 3x3).
export function faceSkinMask(w, h, lm) {
  const P = (i) => [Math.trunc(lm[i * 2] * w), Math.trunc(lm[i * 2 + 1] * h)];
  const a = P(234), b = P(454), fw = Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (fw < 20) return { fw, mask: null };
  const o = poly(w, h, OVAL.map(P));
  for (const idx of [EYE_IMG_LEFT, EYE_IMG_RIGHT, BROW_L, BROW_R, LIPS_OUT]) {
    const q = poly(w, h, idx.map(P));
    for (let i = 0; i < o.length; i++) if (q[i]) o[i] = 0;
  }
  const e = new Uint8Array(w * h);                 // cv2.erode 3x3: ngoài viền ảnh không làm co
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!o[y * w + x]) continue;
    let ok = 1;
    for (let dy = -1; dy <= 1 && ok; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (!o[yy * w + xx]) { ok = 0; break; }
      }
    }
    e[y * w + x] = ok;
  }
  return { fw, mask: e };
}

export function faceBoxes(faces) {
  return faces.map((lm) => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const i of OVAL) { x0 = Math.min(x0, lm[i * 2]); x1 = Math.max(x1, lm[i * 2]); y0 = Math.min(y0, lm[i * 2 + 1]); y1 = Math.max(y1, lm[i * 2 + 1]); }
    return [x0, y0, x1, y1];
  });
}

// ---------------------------------------------------------------------------- tiện ích
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function ycc(reg) {
  const n = reg.w * reg.h, o = { w: reg.w, h: reg.h, c: 3, d: new Float32Array(n * 3) }, d = reg.d;
  for (let i = 0; i < n * 3; i += 3) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    o.d[i] = y; o.d[i + 1] = (d[i] - y) * 0.713 + 0.5; o.d[i + 2] = (d[i + 2] - y) * 0.564 + 0.5;
  }
  return o;
}
function rgb(y) {
  const n = y.w * y.h, o = { w: y.w, h: y.h, c: 3, d: new Float32Array(n * 3) }, d = y.d;
  for (let i = 0; i < n * 3; i += 3) {
    const Y = d[i], cr = d[i + 1] - 0.5, cb = d[i + 2] - 0.5;
    o.d[i] = Y + 1.403 * cr; o.d[i + 1] = Y - 0.714 * cr - 0.344 * cb; o.d[i + 2] = Y + 1.773 * cb;
  }
  return o;
}
const ch = (im, k) => { const n = im.w * im.h, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = im.d[i * im.c + k]; return a; };
function blurArr(arr, w, h, c, s) {      // portrait._blur
  s = Math.max(0.4, s);
  const im = { w, h, c, d: arr };
  if (s <= 6) return cv.gaussianBlur(im, s).d;
  const f = s / 3, sw = Math.max(2, Math.round(w / f)), sh = Math.max(2, Math.round(h / f));
  return cv.resizeLinear(cv.gaussianBlur(cv.resizeArea(im, sw, sh), 3), w, h).d;
}
const blur1 = (a, w, h, s) => blurArr(a, w, h, 1, s);
const blur3 = (im, s) => ({ w: im.w, h: im.h, c: 3, d: blurArr(im.d, im.w, im.h, 3, s) });
function soft(m, w, h, s) { const f = Float32Array.from(m); const b = blur1(f, w, h, s); for (let i = 0; i < b.length; i++) b[i] = clamp01(b[i]); return b; }

function poly(w, h, pts) {               // cv2.fillPoly với đỉnh làm tròn
  const m = new Uint8Array(w * h);
  const P = pts.map(([x, y]) => [Math.round(x), Math.round(y)]);
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of P) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  for (let y = Math.max(0, ymin); y <= Math.min(h - 1, ymax); y++) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length];
      if (y0 === y1) continue;
      if ((y >= Math.min(y0, y1)) && (y < Math.max(y0, y1))) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(w - 1, Math.floor(xs[k + 1])); x++) m[y * w + x] = 1;
    // cạnh đáy / ngang: tô cả đường viền cho giống fillPoly
  }
  for (let i = 0; i < P.length; i++) lineInto(m, w, h, P[i], P[(i + 1) % P.length], 1, 1);
  return m;
}
function lineInto(m, w, h, a, b, thick, val) {
  const r = Math.max(0.5, thick / 2);
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0]) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1]) + r + 1));
  const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    let t = L2 ? ((x - a[0]) * vx + (y - a[1]) * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(x - a[0] - t * vx, y - a[1] - t * vy) <= r) m[y * w + x] = val;
  }
}
function circleInto(m, w, h, cx, cy, r, val = 1) {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = val;
}
const f32 = Math.fround;                 // so sánh mảng float32 với số Python như NumPy (số được ép về float32)
// portrait._dil / _ero ĐÚNG như OpenCV: r <= 4 -> cv2.dilate / erode ellipse (2·round(r)+1); lớn hơn ->
// distanceTransform(DIST_L2, 3) (khoảng cách mặt nạ 3x3 0.955 / 1.3693, không phải Euclid đúng)
function dil(m, w, h, r) {
  r = Math.max(1, r);
  const o = new Uint8Array(w * h);
  if (r <= 4) { const d = cv.morphEllipse(m, w, h, 2 * cv.roundEven(r) + 1, true); for (let i = 0; i < o.length; i++) o[i] = d[i] ? 1 : 0; return o; }
  const inv = new Uint8Array(w * h); for (let i = 0; i < inv.length; i++) inv[i] = m[i] ? 0 : 1;
  const d = cv.distL2(inv, w, h), t = f32(r);
  for (let i = 0; i < o.length; i++) o[i] = d[i] <= t ? 1 : 0;
  return o;
}
function ero(m, w, h, r) {
  r = Math.max(1, r);
  const o = new Uint8Array(w * h);
  if (r <= 4) { const d = cv.morphEllipse(m, w, h, 2 * cv.roundEven(r) + 1, false); for (let i = 0; i < o.length; i++) o[i] = d[i] ? 1 : 0; return o; }
  const d = cv.distL2(m, w, h), t = f32(r);
  for (let i = 0; i < o.length; i++) o[i] = d[i] > t ? 1 : 0;
  return o;
}
const and = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] && b[i] ? 1 : 0; return o; };
const or = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] || b[i] ? 1 : 0; return o; };
const not = (a) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ? 0 : 1; return o; };
const any = (a) => { for (let i = 0; i < a.length; i++) if (a[i]) return true; return false; };
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
function pct(vals, q) { return cv.percentile(vals, q); }
const median = (v) => cv.percentile(v, 50);
function vals(a, m) {                     // a[m] (kiểu NumPy)
  let c = 0; for (let i = 0; i < m.length; i++) if (m[i]) c++;
  const o = new Float32Array(c); c = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) o[c++] = a[i];
  return o;
}
const madOf = (v, med) => median(v.map((x) => Math.abs(x - med)));
// khung [y0, y1, x0, x1] (nửa mở) bao các điểm m khác 0; null nếu rỗng
function bboxOf(m, w, h) {
  let y0 = h, y1 = -1, x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0, o = y * w; x < w; x++) if (m[o + x]) { if (y < y0) y0 = y; y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return y1 < 0 ? null : [y0, y1 + 1, x0, x1 + 1];
}
const growB = (b, m, w, h) => [Math.max(0, b[0] - m), Math.min(h, b[1] + m), Math.max(0, b[2] - m), Math.min(w, b[3] + m)];
const unionB = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])]);
const interB = (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3])];
const gRad = (s) => (Math.round(Math.max(0.4, s) * 8 + 1) | 1) >> 1;   // bán kính nhân Gauss của _blur (s <= 6)
const dRad = (r) => Math.ceil(Math.max(1, r) / 0.955) + 1;              // tầm với của _dil / _ero bán kính r
// _blur nhưng chỉ cần đúng trong box: s <= 6 thì lọc trên phần cắt (box + bán kính nhân) -> y hệt lọc cả ảnh;
// s > 6 (_blur thu nhỏ cả ảnh) thì lọc cả ảnh. Ngoài box = 0.
function blurBox(arr, w, h, c, s, box) {
  const out = new Float32Array(w * h * c);
  if (Math.max(0.4, s) > 6) { const b = blurArr(arr, w, h, c, s); out.set(b); return out; }
  const [y0, y1, x0, x1] = growB(box, gRad(s), w, h), cw = x1 - x0, chh = y1 - y0;
  const sub = new Float32Array(cw * chh * c);
  for (let y = 0; y < chh; y++) sub.set(arr.subarray(((y + y0) * w + x0) * c, ((y + y0) * w + x1) * c), y * cw * c);
  const b = cv.gaussianBlur({ w: cw, h: chh, c, d: sub }, Math.max(0.4, s)).d;
  for (let y = box[0]; y < box[1]; y++) for (let x = box[2]; x < box[3]; x++) for (let k = 0; k < c; k++)
    out[(y * w + x) * c + k] = b[((y - y0) * cw + x - x0) * c + k];
  return out;
}

// ĐƯỜNG MẢNH CÓ HƯỚNG (portrait._line_aniso): trung bình bh dọc đoạn thẳng dài L ở nDir hướng (cv2.line trên ảnh
// số thực = đoạn 8-liên thông, chuẩn hoá tổng 1; filter2D BORDER_REFLECT trên ảnh con box), lấy (hướng mạnh nhất -
// trung bình các hướng). box = [y0, y1, x0, x1]; cbox (trong box): chỉ tính ở đó (ngoài = 0, dùng khi biết chắc bh = 0
// quanh đó); mask: chỉ tính ở điểm khác 0. Ngoài box = 0.
function lineAniso(bh, w, h, box, L, nDir = 12, cbox = null, mask = null) {
  const [y0, y1, x0, x1] = box, bw = x1 - x0, bhh = y1 - y0;
  const out = new Float32Array(w * h);
  const [cy0, cy1, cx0, cx1] = cbox ? interB(cbox, box) : box;
  if (bw <= 0 || bhh <= 0 || cy1 <= cy0 || cx1 <= cx0) return out;
  const c = L >> 1, pw = bw + 2 * c, ph = bhh + 2 * c, pad = new Float32Array(pw * ph);
  const xi = new Int32Array(pw); for (let i = 0; i < pw; i++) xi[i] = x0 + cv.borderReflect(i - c, bw);
  for (let j = 0; j < ph; j++) { const sy = (y0 + cv.borderReflect(j - c, bhh)) * w, o = j * pw; for (let i = 0; i < pw; i++) pad[o + i] = bh[sy + xi[i]]; }
  const cw = cx1 - cx0, chh = cy1 - cy0, rmax = new Float32Array(cw * chh).fill(-1e9), rsum = new Float32Array(cw * chh);
  for (let t = 0; t < nDir; t++) {
    const ang = Math.PI * t / nDir, dx = Math.cos(ang) * c, dy = Math.sin(ang) * c;
    const pts = cv.linePoints(cv.roundEven(c - dx), cv.roundEven(c - dy), cv.roundEven(c + dx), cv.roundEven(c + dy));
    const K = pts.length, of = new Int32Array(K), wt = f32(1 / K);
    for (let k = 0; k < K; k++) of[k] = (pts[k][1] - c) * pw + pts[k][0] - c;
    for (let y = cy0; y < cy1; y++) {
      const pb = (y - y0 + c) * pw + c - x0, ob = (y - cy0) * cw - cx0, mo = y * w;
      for (let x = cx0; x < cx1; x++) {
        if (mask && !mask[mo + x]) continue;
        const p = pb + x;
        let s = 0;
        for (let k = 0; k < K; k++) s += pad[p + of[k]];
        s *= wt;
        const q = ob + x;
        if (s > rmax[q]) rmax[q] = s;
        rsum[q] += s;
      }
    }
  }
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) {
    const q = (y - cy0) * cw + x - cx0, i = y * w + x;
    if (!mask || mask[i]) out[i] = rmax[q] - rsum[q] / nDir;
  }
  return out;
}

// giữ các mảnh liên thông của m có ít nhất `frac` số điểm đạt `ok` (xét cả sợi, không từng điểm)
function compFrac(m, ok, frac, w, h) {
  const { n, lab } = components(m, w, h), o = new Uint8Array(w * h);
  if (n <= 1) return o;
  const tot = new Float64Array(n), good = new Float64Array(n);
  for (let i = 0; i < lab.length; i++) { const l = lab[i]; tot[l]++; if (ok[i]) good[l]++; }
  const keep = new Uint8Array(n), fr = f32(frac);
  for (let i = 1; i < n; i++) keep[i] = good[i] >= f32(fr * Math.max(tot[i], 1)) ? 1 : 0;
  for (let i = 0; i < o.length; i++) o[i] = keep[lab[i]];
  return o;
}

function components(mask, w, h) {        // nhãn 8-liên thông + thống kê [x, y, w, h, area]
  const lab = new Int32Array(w * h), stats = [null];
  const stack = [];
  let n = 1;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    stack.push(i); lab[i] = n;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (mask[q] && !lab[q]) { lab[q] = n; stack.push(q); }
      }
    }
    stats.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1, area]);
    n++;
  }
  return { n, lab, stats };
}

function skinLike(Y, samples) {          // Y: ảnh ycc; samples: [[cr, cb], ...]
  const n = Y.w * Y.h, out = new Float32Array(n);
  let mu = [0, 0];
  let S = samples.length ? samples : [[Y.d[1], Y.d[2]]];
  for (const s of S) { mu[0] += s[0]; mu[1] += s[1]; }
  mu = mu.map((v) => v / S.length);
  let c00 = 4e-4, c01 = 0, c11 = 4e-4;
  if (S.length > 4) {
    c00 = 0; c01 = 0; c11 = 0;
    for (const s of S) { const a = s[0] - mu[0], b = s[1] - mu[1]; c00 += a * a; c01 += a * b; c11 += b * b; }
    c00 = c00 / (S.length - 1) + 2e-5; c01 /= S.length - 1; c11 = c11 / (S.length - 1) + 2e-5;
  }
  const det = c00 * c11 - c01 * c01, i00 = c11 / det, i01 = -c01 / det, i11 = c00 / det;
  for (let i = 0; i < n; i++) {
    const a = Y.d[i * 3 + 1] - mu[0], b = Y.d[i * 3 + 2] - mu[1];
    out[i] = Math.exp(-0.5 * (a * a * i00 + 2 * a * b * i01 + b * b * i11) / 9);
  }
  return out;
}

function sub3(im, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, o = { w, h, c: 3, d: new Float32Array(w * h * 3) };
  for (let y = 0; y < h; y++) o.d.set(im.d.subarray(((y + y0) * im.w + x0) * 3, ((y + y0) * im.w + x1) * 3), y * w * 3);
  return o;
}
function put3(im, part, x0, y0) { for (let y = 0; y < part.h; y++) im.d.set(part.d.subarray(y * part.w * 3, (y + 1) * part.w * 3), ((y + y0) * im.w + x0) * 3); }

// src: chỉ lấy MÀU lấp từ vùng này (VD chỉ nền khi xoá tóc con: không kéo màu tóc tối ra nền)
// srcok (PUM 1.1.2): vết nhỏ cũng chỉ lấy MÀU lấp từ vùng này (sát tóc / áo không kéo màu tối vào da)
// noDarken: mụn / sợi tóc là chỗ TỐI hơn da: chỗ lấp ra tối hơn chỗ cũ là nhận nhầm -> để nguyên
function fillSpots(reg, mask, fw, texShift = true, srcok = null, src = null, noDarken = false) {
  const { w: W, h: H } = reg;
  const { n, lab, stats } = components(mask, W, H);
  if (n <= 1) return reg;
  const out = { w: W, h: H, c: 3, d: Float32Array.from(reg.d) };
  const hp = new Float32Array(reg.d.length);
  if (texShift) { const rb = blur3(reg, Math.max(0.6, fw * 0.0028)); for (let i = 0; i < hp.length; i++) hp[i] = reg.d[i] - rb.d[i]; }
  for (let i = 1; i < n; i++) {
    const [x, y, w, h] = stats[i];
    const mg = Math.trunc(Math.max(3, 0.8 * Math.max(w, h)));
    const xa = Math.max(0, x - mg), ya = Math.max(0, y - mg), xb = Math.min(W, x + w + mg), yb = Math.min(H, y + h + mg);
    const cw = xb - xa, chh = yb - ya;
    const ins = new Uint8Array(cw * chh);
    for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) ins[yy * cw + xx] = lab[(yy + ya) * W + xx + xa] === i ? 1 : 0;
    const crop = sub3(out, xa, ya, xb, yb);
    const dt = cv.distL2(ins, cw, chh);       // độ dày vết: cv2.distanceTransform(DIST_L2, 3)
    let mx = 0; for (let q = 0; q < dt.length; q++) if (ins[q] && dt[q] > mx) mx = dt[q];
    const thick = 2 * mx;
    let fill;
    if (src) {
      // chỉ lấy màu từ vùng cho phép (nền), mở rộng dần tới khi đủ điểm lấy mẫu
      const outm = new Float32Array(cw * chh); let os = 0;
      for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
        const q = yy * cw + xx; if (!ins[q] && src[(yy + ya) * W + xx + xa]) { outm[q] = 1; os++; }
      }
      if (os < 3) continue;                 // quanh vết không có nền để lấy màu: để nguyên
      const num = { w: cw, h: chh, c: 3, d: new Float32Array(cw * chh * 3) };
      for (let q = 0; q < outm.length; q++) if (outm[q]) for (let k = 0; k < 3; k++) num.d[q * 3 + k] = crop.d[q * 3 + k];
      let sg = Math.max(1.5, 0.8 * thick);
      let nb = cv.gaussianBlur(num, sg).d, db = cv.gaussianBlur(cv.img1(cw, chh, outm), sg).d;
      for (let it = 0; it < 3; it++) {
        let mn = Infinity; for (let q = 0; q < db.length; q++) if (ins[q] && db[q] < mn) mn = db[q];
        if (mn > 0.02) break;
        sg *= 2;
        nb = cv.gaussianBlur(num, sg).d; db = cv.gaussianBlur(cv.img1(cw, chh, outm), sg).d;
      }
      const t5 = f32(0.005);
      fill = { w: cw, h: chh, c: 3, d: Float32Array.from(crop.d) };
      for (let q = 0; q < ins.length; q++) {
        if (!ins[q]) continue;
        if (!(db[q] > t5)) { ins[q] = 0; continue; }
        for (let k = 0; k < 3; k++) fill.d[q * 3 + k] = nb[q * 3 + k] / Math.max(db[q], 1e-4);
      }
    } else if (thick <= 40) {
      // vết nhỏ / mảnh (mụn, sợi tóc): trung bình có trọng số từ viền theo ĐỘ DÀY của vết; chỉ lấy màu từ da khi biết
      const okm = new Uint8Array(cw * chh);
      for (let q = 0; q < okm.length; q++) okm[q] = ins[q] ? 0 : 1;
      if (srcok) {
        for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
          const q = yy * cw + xx;
          if (okm[q] && !(srcok[(yy + ya) * W + xx + xa] > 0.5)) okm[q] = 0;
        }
        const ring = and(dil(ins, cw, chh, Math.max(2, 0.5 * thick)), not(ins));
        let rc = 0, rk = 0;
        for (let q = 0; q < ring.length; q++) if (ring[q]) { rc++; if (okm[q]) rk++; }
        if (rc && rk / rc < 0.6) continue;     // quanh vết phần lớn không phải da: để nguyên
      }
      const outm = new Float32Array(cw * chh); for (let q = 0; q < outm.length; q++) outm[q] = okm[q];
      let sg = Math.max(1, 0.6 * thick);
      const num = { w: cw, h: chh, c: 3, d: new Float32Array(cw * chh * 3) };
      for (let q = 0; q < outm.length; q++) for (let k = 0; k < 3; k++) num.d[q * 3 + k] = crop.d[q * 3 + k] * outm[q];
      let nb = cv.gaussianBlur(num, sg).d, db = cv.gaussianBlur(cv.img1(cw, chh, outm), sg).d;
      for (let it = 0; it < 2; it++) {
        let mn = Infinity; for (let q = 0; q < db.length; q++) if (ins[q] && db[q] < mn) mn = db[q];
        if (mn > 0.02) break;
        sg *= 2;
        nb = cv.gaussianBlur(num, sg).d; db = cv.gaussianBlur(cv.img1(cw, chh, outm), sg).d;
      }
      fill = { w: cw, h: chh, c: 3, d: Float32Array.from(crop.d) };
      for (let q = 0; q < outm.length; q++) if (ins[q]) for (let k = 0; k < 3; k++) fill.d[q * 3 + k] = nb[q * 3 + k] / Math.max(db[q], 1e-4);
      // da quanh vết đang chuyển sáng tối (má nghiêng, mép bóng): lấp bằng MẶT NGHIÊNG khớp theo vành quanh vết
      const band = and(dil(ins, cw, chh, Math.max(2, 0.6 * thick + 1)), okm);
      let cnt = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
      const bx = [0, 0, 0], bxx = [0, 0, 0], byy = [0, 0, 0];
      for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
        const q = yy * cw + xx;
        if (!band[q]) continue;
        cnt++; sx += xx; sy += yy; sxx += xx * xx; sxy += xx * yy; syy += yy * yy;
        for (let k = 0; k < 3; k++) { const v = crop.d[q * 3 + k]; bx[k] += v; bxx[k] += xx * v; byy[k] += yy * v; }
      }
      if (cnt >= 12) {
        const Mi = inv3n([[cnt, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]]);
        if (Mi) {
          const coef = [0, 1, 2].map((k) => [0, 1, 2].map((r) => Mi[r][0] * bx[k] + Mi[r][1] * bxx[k] + Mi[r][2] * byy[k]));
          let res = 0;
          for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
            const q = yy * cw + xx;
            if (!band[q]) continue;
            for (let k = 0; k < 3; k++) res += Math.abs(f32(f32(coef[k][0] + f32(coef[k][1] * xx)) + f32(coef[k][2] * yy)) - crop.d[q * 3 + k]);
          }
          if (res / (cnt * 3) < 0.04) {          // vành đủ "phẳng-nghiêng" để mặt nghiêng tin được
            for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
              const q = yy * cw + xx;
              if (ins[q]) for (let k = 0; k < 3; k++) fill.d[q * 3 + k] = coef[k][0] + coef[k][1] * xx + coef[k][2] * yy;
            }
          }
        }
      }
    } else fill = laplaceFill(crop, ins);
    if (noDarken) {
      let fs = 0, cs = 0, nn = 0;
      for (let q = 0; q < ins.length; q++) {
        if (!ins[q]) continue;
        fs += fill.d[q * 3] * 0.299 + fill.d[q * 3 + 1] * 0.587 + fill.d[q * 3 + 2] * 0.114;
        cs += crop.d[q * 3] * 0.299 + crop.d[q * 3 + 1] * 0.587 + crop.d[q * 3 + 2] * 0.114;
        nn++;
      }
      if (nn && fs / nn < cs / nn - 0.012) continue;      // lấp ra tối hơn: không phải mụn / sợi tóc tối -> để nguyên
    }
    if (texShift) {
      const d = Math.trunc(Math.max(w, h) + mg);
      for (const [ox, oy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        const sx = xa + ox, sy = ya + oy;
        if (sx < 0 || sy < 0 || sx + cw > W || sy + chh > H) continue;
        if (srcok) { let s = 0; for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) s += srcok[(sy + yy) * W + sx + xx]; if (s / (cw * chh) < 0.9) continue; }
        for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) for (let k = 0; k < 3; k++)
          fill.d[(yy * cw + xx) * 3 + k] += hp[((sy + yy) * W + sx + xx) * 3 + k] * 0.85;
        break;
      }
    }
    const a = soft(ins, cw, chh, Math.max(0.6, 0.12 * Math.max(w, h)));
    for (let q = 0; q < a.length; q++) {
      const al = Math.max(a[q], ins[q]);
      if (!al) continue;
      const o = ((Math.floor(q / cw) + ya) * W + (q % cw) + xa) * 3;
      for (let k = 0; k < 3; k++) out.d[o + k] = crop.d[q * 3 + k] * (1 - al) + fill.d[q * 3 + k] * al;
    }
  }
  return out;
}

// ma trận 3x3 nghịch đảo (số thực 64 bit); null nếu suy biến
function inv3n(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

const SPOT_CONT_K = 0.8, SPOT_CONT_F = 0.55;   // vết "kéo dài" (bóng gọng kính, dải bóng): hai hướng đối nhau quanh vết vẫn tối
const SPOT_SLOPE = 4.0;                        // vết trên dốc sáng tối: độ dốc > SPOT_SLOPE x độ tối của vết -> bỏ
// portrait._band_like: chỗ tối quanh vết (vành cách 0,5–1,5 cỡ vết) dồn vào hai hướng ĐỐI NHAU -> vết là một đoạn dải bóng
function bandLike(hi, x, y, bw, bh, lab, i, sk, W, H) {
  const r = Math.max(bw, bh), mg = Math.trunc(Math.max(3, 1.6 * r));
  const ya = Math.max(0, y - mg), yb = Math.min(H, y + bh + mg), xa = Math.max(0, x - mg), xb = Math.min(W, x + bw + mg);
  const cw = xb - xa, chh = yb - ya, comp = new Uint8Array(cw * chh);
  let cy = 0, cx = 0, cn = 0;
  for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) if (lab[(yy + ya) * W + xx + xa] === i) { comp[yy * cw + xx] = 1; cy += yy; cx += xx; cn++; }
  cy /= cn; cx /= cn;
  const d1 = dil(comp, cw, chh, Math.max(2, 1.2 * r)), d0 = dil(comp, cw, chh, Math.max(1, 0.4 * r));
  const cnt = new Float64Array(12), s = new Float64Array(12);
  let rn = 0;
  for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
    const q = yy * cw + xx, gi = (yy + ya) * W + xx + xa;
    if (!d1[q] || d0[q] || !sk[gi]) continue;
    rn++;
    const ang = (Math.atan2(yy - cy, xx - cx) + Math.PI) / (2 * Math.PI) * 12;
    const b = Math.min(11, Math.max(0, Math.trunc(ang)));
    cnt[b]++; s[b] += hi[gi];
  }
  if (rn < 12) return false;
  for (let k = 0; k < 12; k++) s[k] /= Math.max(cnt[k], 1);
  let pair = -Infinity;
  for (let k = 0; k < 12; k++) pair = Math.max(pair, Math.min(Math.max(s[k], s[(k + 1) % 12]), Math.max(s[(k + 6) % 12], s[(k + 7) % 12])));
  const so = Array.from(s).sort((p, q) => p - q), med = (so[5] + so[6]) / 2;
  return pair > SPOT_CONT_F && pair > 2.5 * med + 0.05;
}

function spotMask(Y, Cr, skin, w, h, fw, amount, lightToo = false, skinlike = null) {
  const s1 = Math.max(0.6, fw * 0.004), s2 = Math.max(2, fw * 0.025);
  const n = w * h;
  const sk = []; for (let i = 0; i < n; i++) if (skin[i] > 0.5) sk.push(i);
  if (sk.length < 50) return new Uint8Array(n);
  // nền so sánh (làm mờ rộng) CHỈ lấy trên da: sát mép tóc / áo mà lấy cả tóc tối thì da sạch cạnh đó trông như "chấm
  // khác thường" -> nhận nhầm mụn, lấp ra chấm xám (PUM 1.1.2)
  const skm = new Float32Array(n); for (const i of sk) skm[i] = 1;
  const den = blur1(skm, w, h, s2); for (let i = 0; i < n; i++) den[i] = Math.max(den[i], 1e-3);
  const nbF = (a) => { const t = new Float32Array(n); for (let i = 0; i < n; i++) t[i] = a[i] * skm[i]; const b = blur1(t, w, h, s2); for (let i = 0; i < n; i++) b[i] = b[i] / den[i]; return b; };
  const nY = nbF(Y), Yb1 = blur1(Y, w, h, s1), Cb1 = blur1(Cr, w, h, s1), nC = nbF(Cr);
  const Yb2 = skinlike ? blur1(Y, w, h, s2) : null;
  const dark = new Float32Array(n), red = new Float32Array(n);
  for (let i = 0; i < n; i++) { dark[i] = nY[i] - Yb1[i]; red[i] = Cb1[i] - nC[i]; }
  const zf = (a) => { const v = sk.map((i) => a[i]); const med = median(v); const mad = median(v.map((x) => Math.abs(x - med))) * 1.48 + 1e-5; return [med, mad]; };
  const [md, ad] = zf(dark), [mr, ar] = zf(red);
  const thr = 4.2 - 2.4 * amount;
  const m = new Uint8Array(n), hiS = new Float32Array(n), skB = new Uint8Array(n);
  const thrK = f32(SPOT_CONT_K * thr);
  for (let i = 0; i < n; i++) {
    let sc = Math.max((dark[i] - md) / ad, 0.8 * (red[i] - mr) / ar);
    if (lightToo) sc = Math.max(sc, (-dark[i] + md) / ad);
    sc = f32(sc);
    hiS[i] = sc > thrK ? 1 : 0;
    if (!(skin[i] > 0.5)) continue;
    skB[i] = 1;
    if (sc > thr) m[i] = 1;
  }
  const { n: nc, lab, stats } = components(m, w, h);
  // mụn thật nhỏ (<= ~3% bề rộng mặt); mảng tối to hơn thường là bóng (gọng kính, cánh mũi) bị cắt thành cục
  const maxd = fw * (0.02 + 0.025 * amount);
  const keep = new Uint8Array(nc);
  let slope = null;
  if (skinlike) {
    // độ dốc sáng tối của da ở cỡ lớn (chỉ trên da): mép bóng gọng kính / cánh mũi / cằm thì dốc mạnh
    slope = cv.sobelMag(nY, w, h);
    for (let i = 0; i < n; i++) slope[i] = slope[i] / 8.0 * (2.0 * s2);
  }
  for (let i = 1; i < nc; i++) {
    const [x, y, bw, bh, area] = stats[i];
    if (Math.max(bw, bh) > maxd) continue;
    if (skinlike) {
      if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > 2.2 || area / Math.max(1, bw * bh) < 0.35) continue;
      const mg = Math.trunc(Math.max(2, 0.6 * Math.max(bw, bh)));
      const ya = Math.max(0, y - mg), yb = Math.min(h, y + bh + mg), xa = Math.max(0, x - mg), xb = Math.min(w, x + bw + mg);
      const cw = xb - xa, chh = yb - ya, comp = new Uint8Array(cw * chh);
      for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) comp[yy * cw + xx] = lab[(yy + ya) * w + xx + xa] === i ? 1 : 0;
      const ring = and(dil(comp, cw, chh, Math.max(2, 0.4 * Math.max(bw, bh))), not(comp));
      let rs = 0, rk = 0, rn = 0, drop = 0, cn = 0, sl = 0;
      const rv = [];
      for (let q = 0; q < ring.length; q++) {
        const gi = (Math.floor(q / cw) + ya) * w + (q % cw) + xa;
        if (ring[q]) { rs += skinlike[gi]; rk += skin[gi] > 0.5 ? 1 : 0; rn++; rv.push(Yb2[gi]); }
        if (comp[q]) { drop += Yb2[gi] - Y[gi]; sl += slope[gi]; cn++; }
      }
      if (!rn || rs / rn < 0.45) continue;      // không có da bao quanh: trang sức, mép tóc, viền áo...
      if (rk / rn < 0.9) continue;              // nằm sát mép vùng da (mép áo, tóc, khoé mắt)
      const dr = cn ? drop / cn : 0;
      if (dr > 0.22) continue;                  // quá tối: lỗ, mặt dây chuyền, bóng đổ sâu
      // nằm trên MÉP BÓNG (cánh mũi, gọng kính, cằm): vành quanh vết nửa sáng nửa tối -> lấp sẽ ra mảng vỡ
      if (rv.length > 8 && pct(rv, 90) - pct(rv, 10) > Math.max(0.05, 1.6 * Math.max(dr, 0))) continue;
      // bóng gọng kính / dải bóng / nếp: chỗ tối KÉO DÀI ra ngoài vết theo HAI PHÍA ĐỐI NHAU
      if (bandLike(hiS, x, y, bw, bh, lab, i, skB, w, h)) continue;
      const slm = cn ? sl / cn : 0;
      if (slm > SPOT_SLOPE * Math.max(dr, 0.01) && slm > 0.05) continue;   // nằm trên dốc sáng tối (mép bóng)
    }
    keep[i] = 1;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = keep[lab[i]];
  return dil(out, w, h, Math.max(1, fw * 0.005));
}

function elongated(m, w, h, minRatio, minLen) {
  const { n, lab, stats } = components(m, w, h), keep = new Uint8Array(n);
  for (let i = 1; i < n; i++) { const [, , bw, bh, area] = stats[i]; const L = Math.hypot(bw, bh); if (L >= minLen && L * L / Math.max(1, area) >= minRatio * 2) keep[i] = 1; }
  const o = new Uint8Array(w * h); for (let i = 0; i < o.length; i++) o[i] = keep[lab[i]]; return o;
}

// Sợi tóc con bay ra ngoài NỀN quanh đầu (portrait._flyaways). Trả [mặt nạ sợi, khối tóc] (null nếu không có).
// - Khối tóc = phần "giống màu tóc" (Lab, so với mẫu tóc) còn lại sau phép MỞ hình thái, nối liền mẫu tóc trên đỉnh
//   đầu, không dính vào mặt -> không cần mặt nạ người chính xác.
// - Chỉ tìm NGOÀI đường bao đầu (bao lồi mặt + khối tóc), trong dải sát quanh khối tóc.
// - Sợi tóc = ĐƯỜNG MẢNH CÓ HƯỚNG (lineAniso); màu phải là hỗn hợp tóc + nền (xét cả sợi); sợi NGƯỢC sáng xét riêng.
// - Phải mọc ra từ khối tóc và vươn ra đủ xa (phần lởm chởm ngắn tự nhiên ở viền tóc giữ nguyên).
function flyaways(reg, Y, solid, above, seed, w, h, fw, amount, oval) {
  const n = w * h;
  if (sum(seed) < 50) return [null, null];
  const faceHull = oval ? cv.hullFill(oval, w, h) : new Uint8Array(n);
  const ring = and(and(dil(solid, w, h, 0.18 * fw), not(dil(solid, w, h, 0.06 * fw))), and(above, not(dil(faceHull, w, h, 0.05 * fw))));
  if (sum(ring) < 50) return [null, null];
  const ys = vals(Y, seed);
  let yh = median(ys);
  const yb = median(vals(Y, ring));
  const dark = yh < yb;
  // mẫu tóc hay lẫn nền (mặt nạ người lấn ra quanh đầu): giữ nửa tối hơn (tóc tối) / sáng hơn (tóc sáng)
  const p50 = f32(pct(ys, 50));
  seed = Uint8Array.from(seed, (s, i) => (s && (dark ? Y[i] <= p50 : Y[i] >= p50) ? 1 : 0));
  yh = median(vals(Y, seed));
  // "độ giống tóc" 0..1 theo cả độ sáng lẫn màu (Lab) so với mẫu tóc
  const lab = new Float32Array(n * 3), t3 = [0, 0, 0], rd = reg.d;
  for (let i = 0; i < n; i++) {
    cv.rgb2labCv(rd[i * 3], rd[i * 3 + 1], rd[i * 3 + 2], t3);       // như cv2 (bảng + nội suy), không phải công thức
    lab[i * 3] = t3[0]; lab[i * 3 + 1] = t3[1]; lab[i * 3 + 2] = t3[2];
  }
  const sl = [], sa = [], sb = [];
  for (let i = 0; i < n; i++) if (seed[i]) { sl.push(lab[i * 3]); sa.push(lab[i * 3 + 1]); sb.push(lab[i * 3 + 2]); }
  const mu = [median(sl), median(sa), median(sb)];
  const sL = Math.max(6, 1.4826 * median(sl.map((v) => Math.abs(v - mu[0]))) * 1.5);
  const sab = Math.max(3, 1.4826 * median(sa.map((v, j) => Math.hypot(v - mu[1], sb[j] - mu[2]))) * 1.5);
  const hairness = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dl = (lab[i * 3] - mu[0]) / sL, da = lab[i * 3 + 1] - mu[1], db = lab[i * 3 + 2] - mu[2];
    hairness[i] = clamp01(1 - Math.sqrt(dl * dl + (da * da + db * db) / (sab * sab)) / 4);
  }
  if (median(vals(hairness, ring)) > 0.45) return [null, null];   // nền quá giống tóc: để nguyên
  const k = Math.max(3, Math.trunc(0.024 * fw) | 1);
  const hop = cv.morphOpen(hairness, w, h, k);
  const massp = new Uint8Array(n); for (let i = 0; i < n; i++) massp[i] = hop[i] > 0.5 ? 1 : 0;   // sợi mảnh biến mất, khối dày còn
  // khối tóc = phần "vẫn là tóc sau khi mở", nối liền mẫu tóc trên đỉnh đầu, KHÔNG dính vào mặt
  let baseM = and(and(massp, dil(solid, w, h, 0.2 * fw)), above);
  if (oval) baseM = and(baseM, not(dil(oval, w, h, 0.01 * fw)));
  const { n: nb, lab: lb } = components(baseM, w, h);
  const ids = new Uint8Array(nb); let anyId = false;
  for (let i = 0; i < n; i++) if (seed[i] && lb[i] > 0) { ids[lb[i]] = 1; anyId = true; }
  if (!anyId) return [null, null];
  const mass = new Uint8Array(n); for (let i = 0; i < n; i++) mass[i] = ids[lb[i]];
  // chỉ NGOÀI đường bao đầu (bao lồi của mặt + khối tóc): chân tóc trên trán / thái dương nằm trong bao
  const headHull = cv.hullFill(oval ? or(mass, oval) : mass, w, h);
  const zone = and(and(and(dil(mass, w, h, 0.14 * fw), not(mass)), and(above, not(massp))), not(dil(headHull, w, h, Math.max(1, 0.004 * fw))));
  if (sum(zone) < 50) return [null, mass];
  const ks = Math.max(3, Math.trunc(0.008 * fw) | 1);
  // nền TẠI CHỖ: độ sáng trung bình phần nền quanh đó, không dùng một mức cho cả ảnh
  const outm = Float32Array.from(dil(mass, w, h, 0.03 * fw), (v) => (v ? 0 : 1));
  const sgb = Math.max(2, 0.08 * fw), yo = new Float32Array(n);
  for (let i = 0; i < n; i++) yo[i] = Y[i] * outm[i];
  const nY = blur1(yo, w, h, sgb), dY = blur1(outm, w, h, sgb);
  const L = Math.max(7, Math.trunc(0.03 * fw) | 1);
  const zb = bboxOf(zone, w, h);
  const box = [Math.max(0, zb[0] - L), Math.min(h, zb[1] + L), Math.max(0, zb[2] - L), Math.min(w, zb[3] + L)];
  // đường mảnh TỐI / SÁNG hơn xung quanh (ô dò nhỏ cỡ bề ngang sợi tóc) — chỉ cần trong box
  const cls = cv.morphClose(Y, w, h, ks, box), opn = cv.morphOpen(Y, w, h, ks, box);
  const bhDark = new Float32Array(n), bhLight = new Float32Array(n), bgness = new Float32Array(n);
  const big = dark ? cv.morphClose(Y, w, h, k, box) : cv.morphOpen(Y, w, h, k, box);
  const t06 = f32(0.06);
  for (let y = box[0]; y < box[1]; y++) for (let x = box[2]; x < box[3]; x++) {
    const i = y * w + x;
    bhDark[i] = cls[i] - Y[i]; bhLight[i] = Y[i] - opn[i];
    const bgY = nY[i] / Math.max(dY[i], 1e-4);
    const span = f32(dark ? bgY - yh : yh - bgY);
    bgness[i] = span > t06 ? (dark ? big[i] - yh : yh - big[i]) / Math.max(span, 1e-3) : 0;   // nền gần bằng tóc: bỏ qua
  }
  const bhl = dark ? bhDark : bhLight;
  // điểm nằm trên một ĐƯỜNG CÓ HƯỚNG rõ và tự nó lệch khỏi nền một chút (ngọn tóc mờ vẫn theo được)
  const strands = (bh, kmad) => {
    const v = vals(bh, zone), med = median(v), mad = madOf(v, med) * 1.48 + 1e-5;
    const an = lineAniso(bh, w, h, box, L);
    const va = vals(an, zone), meda = median(va), mada = madOf(va, meda) * 1.48 + 1e-6;
    const ta = f32(Math.max(0.004, meda + (kmad - 3.0 * amount) * mada)), tb = f32(Math.max(0.006, med + 1.5 * mad));
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = zone[i] && an[i] > ta && bh[i] > tb ? 1 : 0;
    return o;
  };
  let cand = strands(bhl, 7.0);
  const t55 = f32(0.55);
  for (let i = 0; i < n; i++) if (cand[i] && !(bgness[i] > t55)) cand[i] = 0;
  let sec = strands(dark ? bhLight : bhDark, 8.0);           // sợi NGƯỢC chiều sáng
  // màu: hỗn hợp màu tóc + màu nền ngay sau sợi (nền = trung bình các điểm nền quanh đó)
  const hc = [0, 1, 2].map((c) => { const v = []; for (let i = 0; i < n; i++) if (seed[i]) v.push(rd[i * 3 + c]); return median(v); });
  const okb = new Float32Array(n), dl1 = dil(or(cand, sec), w, h, 1);
  for (let i = 0; i < n; i++) okb[i] = zone[i] && !dl1[i] ? 1 : 0;
  const sg = Math.max(1.5, fw * 0.02);
  const den = blurBox(okb, w, h, 1, sg, box);
  for (let i = 0; i < n; i++) den[i] = Math.max(den[i], 1e-4);
  const ro = new Float32Array(n * 3); for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) ro[i * 3 + c] = rd[i * 3 + c] * okb[i];
  const bgl = blurBox(ro, w, h, 3, sg, box);
  // sợi mảnh mờ chỉ tối hơn nền 1–3%: không đòi alpha dương rõ; chỉ loại màu SAI hẳn (nới cho viền quang sai)
  const okc = new Uint8Array(n), ta = f32(-0.015), tb = f32(1.4);
  for (let i = 0; i < n; i++) {
    if (!cand[i]) continue;
    let dd = 0, vd = 0, v2 = 0;
    for (let c = 0; c < 3; c++) { const b = bgl[i * 3 + c] / den[i], d = hc[c] - b, v = rd[i * 3 + c] - b; dd += d * d; vd += v * d; v2 += v * v; }
    dd = Math.max(dd, 1e-6);
    const al = vd / dd, res = Math.sqrt(Math.max(v2 - al * al * dd, 0));
    okc[i] = al > ta && al < tb && res < 0.7 * Math.sqrt(dd) + 0.04 ? 1 : 0;
  }
  cand = compFrac(cand, okc, 0.45, w, h);       // xét theo CẢ SỢI: ngọn mờ / viền màu lẻ tẻ không làm sợi đứt khúc
  cand = elongated(cand, w, h, 2.0, Math.max(4, fw * 0.012));
  // SỢI NGƯỢC SÁNG (tóc được nắng / đèn viền chiếu thành sợi bạc trên phông sẫm, hoặc ngược lại): phải ÍT rực màu
  // hơn nền, dài và mảnh rõ hơn sợi thường
  if (any(sec)) {
    const lo = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) lo[i] = lab[i] * okb[(i / 3) | 0];
    const lbg = blurBox(lo, w, h, 3, sg, box);
    const okc2 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!sec[i]) continue;
      const ca = Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]), cb = Math.hypot(lbg[i * 3 + 1] / den[i], lbg[i * 3 + 2] / den[i]);
      okc2[i] = ca <= cb + 6.0 ? 1 : 0;
    }
    sec = compFrac(and(sec, not(dil(cand, w, h, 1))), okc2, 0.6, w, h);
    sec = elongated(sec, w, h, 3.0, Math.max(6, fw * 0.02));
  }
  cand = or(cand, sec);
  const { n: nc, lab: lc } = components(cand, w, h);
  if (nc <= 1) return [null, mass];
  // mọc ra từ khối tóc (chạm vùng sát tóc, hoặc nối tiếp một sợi đã nhận)
  const keep = new Uint8Array(nc);
  const near = dil(mass, w, h, Math.max(2, 0.035 * fw));
  for (let i = 0; i < n; i++) if (near[i] && cand[i]) keep[lc[i]] = 1;
  keep[0] = 0;
  for (let it = 0; it < 3; it++) {
    const km = new Uint8Array(n); for (let i = 0; i < n; i++) km[i] = keep[lc[i]];
    const g = dil(km, w, h, Math.max(2, 0.03 * fw));
    let grew = false;
    for (let i = 0; i < n; i++) if (g[i] && cand[i] && !keep[lc[i]]) { keep[lc[i]] = 1; grew = true; }
    keep[0] = 0;
    if (!grew) break;
  }
  // chỉ xoá sợi VƯƠN RA khỏi khối tóc đủ xa (phần lởm chởm ngắn tự nhiên ở viền tóc giữ nguyên)
  const dist = cv.distL2(not(mass), w, h), reach = new Float32Array(nc);
  for (let i = 0; i < n; i++) if (dist[i] > reach[lc[i]]) reach[lc[i]] = dist[i];
  const tr = f32(fw * (0.030 - 0.014 * amount));
  for (let l = 1; l < nc; l++) if (!(reach[l] >= tr)) keep[l] = 0;
  keep[0] = 0;
  const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = keep[lc[i]];
  return [out, mass];
}

function edgeAttn(Y, mask, w, h, fw) {
  const g = blur1(Y, w, h, Math.max(0.8, fw * 0.006));
  const mag = new Float32Array(w * h);
  const at = (x, y) => { if (x < 0) x = -x; else if (x >= w) x = 2 * w - 2 - x; if (y < 0) y = -y; else if (y >= h) y = 2 * h - 2 - y; return g[y * w + x]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
    const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
  }
  const v = []; for (let i = 0; i < mag.length; i++) if (mask[i] > 0.5) v.push(mag[i]);
  if (v.length < 50) return new Float32Array(w * h).fill(1);
  const med = median(v), t = med + 4 * median(v.map((x) => Math.abs(x - med))) * 1.48 + 1e-6;
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = 1 - (1 - clamp01((mag[i] - t) / (1.5 * t)) - 0) * 0 - clamp01((mag[i] - t) / (1.5 * t));
  const inv = new Float32Array(w * h); for (let i = 0; i < a.length; i++) inv[i] = 1 - a[i];
  const b = blur1(inv, w, h, Math.max(1, fw * 0.015));
  for (let i = 0; i < a.length; i++) a[i] = clamp01(1 - b[i] * 2);
  return a;
}

function even(reg, mask, fw, amount, texture) {
  if (amount <= 0 && Math.abs(texture) < 1e-6) return reg;
  const y = ycc(reg), { w, h } = reg, n = w * h;
  const f1 = Math.max(0.6, fw * 0.004), f2 = Math.max(2, fw * 0.03), f3 = Math.max(6, fw * 0.12);
  const lo1 = blur3(y, f1).d, lo2 = blur3(y, f2).d, lo3 = blur3(y, f3).d;
  const ea = edgeAttn(ch(y, 0), mask, w, h, fw);
  // PUM 1.1.2 (đo trên ảnh Capture One): da KHÔNG phẳng hơn về sáng tối mà MÀU da đều hơn -> chỉ giảm nhẹ sáng tối
  // (EVEN_Y), loang MÀU (đỏ / vàng / xám từng mảng, lốm đốm nhỏ) thì san mạnh (EVEN_C); kết cấu chỉ ở kênh sáng tối
  const a = amount;
  const cl = Math.min(0.95, EVEN_C[0] * a), cm = Math.min(0.9, EVEN_C[1] * a), chh = Math.min(0.85, EVEN_C[2] * a);
  const kl = [EVEN_Y[0] * a, cl, cl].map(f32), km = [EVEN_Y[1] * a, cm, cm].map(f32), kh = [0, chh, chh].map(f32);
  const tex = [f32(texture * 0.8), 0, 0];
  const nw = { w, h, c: 3, d: new Float32Array(n * 3) };
  for (let i = 0; i < n; i++) {
    const k = mask[i] * ea[i];
    for (let c = 0; c < 3; c++) {
      const j = i * 3 + c, hf = y.d[j] - lo1[j], mid = lo1[j] - lo2[j], low = lo2[j] - lo3[j];
      nw.d[j] = lo3[j] + low * (1 - k * kl[c]) + mid * (1 - k * km[c]) + hf * (1 + k * tex[c] - k * kh[c]);
    }
  }
  return rgb(nw);
}
const EVEN_Y = [0.12, 0.40];       // phần sáng tối bị san ở dải lớn (khối mặt) / dải vừa (mảng, nếp)
const EVEN_C = [1.5, 1.3, 1.6];    // phần MÀU bị san ở dải lớn / vừa / rất nhỏ (lốm đốm, nhiễu màu trên da)

// ---------------------------------------------------------------------------- từng khuôn mặt
function processFace(out, lm, p, imp, prot, person, W, H, ox, oy) {
  const w = out.w, h = out.h;
  const P = (i) => [lm[i * 2] * W - ox, lm[i * 2 + 1] * H - oy];
  const fw = Math.hypot(P(234)[0] - P(454)[0], P(234)[1] - P(454)[1]);
  if (fw < 24) return null;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const i of OVAL) { const [x, y] = P(i); mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
  const lx = Math.max(0, -ox), ly = Math.max(0, -oy), hx = Math.min(w, W - ox), hy = Math.min(h, H - oy);
  // vùng xử lý phủ hết mái tóc + sợi tóc con bay xa (tóc cao, búi tóc: đỉnh đầu cách đỉnh trán tới ~1 bề rộng mặt)
  const x0 = Math.trunc(Math.max(lx, mnx - 0.6 * fw)), x1 = Math.trunc(Math.min(hx, mxx + 0.6 * fw));
  const y0 = Math.trunc(Math.max(ly, mny - 1.0 * fw)), y1 = Math.trunc(Math.min(hy, mxy + 0.95 * fw));
  if (x1 - x0 < 16 || y1 - y0 < 16) return null;
  let reg = sub3(out, x0, y0, x1, y1);
  const sw = reg.w, sh = reg.h, n = sw * sh;
  const Q = (i) => { const [x, y] = P(i); return [x - x0, y - y0]; };
  const Qs = (idx) => idx.map(Q);
  const oval = poly(sw, sh, Qs(OVAL));
  const eyeL = poly(sw, sh, Qs(EYE_IMG_LEFT)), eyeR = poly(sw, sh, Qs(EYE_IMG_RIGHT));
  const brows = or(poly(sw, sh, Qs(BROW_L)), poly(sw, sh, Qs(BROW_R)));
  const lipsO = poly(sw, sh, Qs(LIPS_OUT)), lipsI = poly(sw, sh, Qs(LIPS_IN));
  const nos = new Uint8Array(n);
  {
    const a98 = Q(98), a327 = Q(327), c = [(a98[0] + a327[0]) / 2, (a98[1] + a327[1]) / 2];
    const ex = Math.trunc(Math.abs(a327[0] - a98[0]) * 0.62) + 1, ey = Math.trunc(0.045 * fw) + 1, ccx = Math.trunc(c[0]), ccy = Math.trunc(c[1] - 0.01 * fw);
    for (let y = Math.max(0, ccy - ey); y <= Math.min(sh - 1, ccy + ey); y++) for (let x = Math.max(0, ccx - ex); x <= Math.min(sw - 1, ccx + ex); x++)
      if (((x - ccx) / ex) ** 2 + ((y - ccy) / ey) ** 2 <= 1) nos[y * sw + x] = 1;
  }
  const eyes = or(eyeL, eyeR);
  const excl = or(or(or(dil(eyes, sw, sh, 0.06 * fw), dil(brows, sw, sh, 0.045 * fw)), dil(lipsO, sw, sh, 0.03 * fw)), nos);
  let Yc = ycc(reg);
  const samp = [];
  for (const i of CHEEKS) {
    const [qx, qy] = Q(i);
    for (let y = Math.max(0, Math.trunc(qy) - 3); y < Math.min(sh, Math.trunc(qy) + 4); y++)
      for (let x = Math.max(0, Math.trunc(qx) - 3); x < Math.min(sw, Math.trunc(qx) + 4); x++) samp.push([Yc.d[(y * sw + x) * 3 + 1], Yc.d[(y * sw + x) * 3 + 2]]);
  }
  const skinlike = skinLike(Yc, samp);
  const pr = new Float32Array(n);
  if (prot) for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) pr[y * sw + x] = prot[(y + y0) * w + x + x0];
  const ovEx = and(oval, not(excl));
  const so = soft(ovEx, sw, sh, 0.012 * fw);
  const faceSkin = new Float32Array(n);
  for (let i = 0; i < n; i++) faceSkin[i] = clamp01(so[i] * skinlike[i] * (1 - pr[i]));
  const jaw = Qs(JAW);
  const neckPoly = [...jaw, ...jaw.map(([x, y]) => [x, y + 0.95 * fw]).reverse()];
  const neck = and(poly(sw, sh, neckPoly), not(oval));
  const pm = new Float32Array(n).fill(1);
  if (person) for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) pm[y * sw + x] = person[(y + y0) * w + x + x0];
  const sn = soft(neck, sw, sh, 0.02 * fw);
  const neckSkin = new Float32Array(n);
  for (let i = 0; i < n; i++) neckSkin[i] = clamp01(sn[i] * skinlike[i] * pm[i] * (1 - pr[i]));
  const maxFN = (useNeck) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(faceSkin[i], useNeck ? neckSkin[i] : 0); return o; };
  const eyesFar = not(dil(eyes, sw, sh, 0.14 * fw));
  const skinOk = () => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(faceSkin[i], neckSkin[i]) > 0.5 ? 1 : 0; return o; };

  // 1) mụn / vết thâm
  const b = (p.blemish || 0) / 100 * imp;
  if (b > 0) {
    const sk = maxFN(p.blemish_neck ?? true); for (let i = 0; i < n; i++) sk[i] *= eyesFar[i];
    const m = spotMask(ch(Yc, 0), ch(Yc, 1), sk, sw, sh, fw, b, false, skinlike);
    reg = fillSpots(reg, m, fw, true, skinOk(), null, true);
  }
  // 2) sợi tóc vương trên da
  const hi = (p.hair_inner || 0) / 100 * imp;
  if (hi > 0) {
    const Y = ch(ycc(reg), 0);
    const k = Math.max(3, Math.trunc(fw * 0.009) | 1);
    const cl = cv.morphClose(Y, sw, sh, k), bh = new Float32Array(n);      // MORPH_BLACKHAT ellipse như OpenCV
    for (let i = 0; i < n; i++) bh[i] = cl[i] - Y[i];
    const folds = new Uint8Array(n);
    for (const [a_, b_] of [[98, 61], [327, 291], [64, 98], [294, 327]]) lineInto(folds, sw, sh, Q(a_).map(Math.trunc), Q(b_).map(Math.trunc), Math.max(2, Math.trunc(0.09 * fw)), 1);
    for (const i of [98, 327, 64, 294, 48, 278, 129, 358]) { const [qx, qy] = Q(i); circleInto(folds, sw, sh, Math.trunc(qx), Math.trunc(qy), Math.trunc(0.07 * fw)); }
    const lipsD = dil(lipsO, sw, sh, 0.05 * fw);
    const sk = new Uint8Array(n); for (let i = 0; i < n; i++) sk[i] = faceSkin[i] > 0.5 && eyesFar[i] && !lipsD[i] && !folds[i] ? 1 : 0;
    const v = []; for (let i = 0; i < n; i++) if (sk[i]) v.push(bh[i]);
    if (v.length > 50) {
      const med = median(v), t = med + (7 - 3.5 * hi) * (median(v.map((x) => Math.abs(x - med))) * 1.48 + 1e-5);
      const cand = new Uint8Array(n); for (let i = 0; i < n; i++) cand[i] = bh[i] > t && sk[i] ? 1 : 0;
      const { n: nc, lab, stats } = components(cand, sw, sh);
      const dist = cv.distL2(cand, sw, sh);      // cv2.distanceTransform(DIST_L2, 3)
      const keep = new Uint8Array(nc);
      for (let i = 1; i < nc; i++) {
        const [x, y, bw2, bh2, area] = stats[i];
        const L_ = Math.hypot(bw2, bh2);
        if (L_ < fw * 0.07) continue;
        let mx = 0; for (let yy = y; yy < y + bh2; yy++) for (let xx = x; xx < x + bw2; xx++) if (lab[yy * sw + xx] === i) mx = Math.max(mx, dist[yy * sw + xx]);
        if (2 * mx > Math.max(2.5, fw * 0.008) || L_ * L_ / Math.max(1, area) < 12) continue;
        keep[i] = 1;
      }
      const km = new Uint8Array(n); for (let i = 0; i < n; i++) km[i] = keep[lab[i]];
      const fsk = new Uint8Array(n); for (let i = 0; i < n; i++) fsk[i] = faceSkin[i] > 0.5 ? 1 : 0;
      reg = fillSpots(reg, dil(km, sw, sh, 1), fw, true, fsk, null, true);
    }
  }
  // 3) đều màu da
  const ev = (p.even || 0) / 100 * imp, tx = (p.even_texture || 0) / 100;
  if (ev > 0 || Math.abs(tx) > 1e-6) reg = even(reg, maxFN(p.even_neck ?? true), fw, ev, tx * (tx < 0 ? imp : 1));
  // 3b) nếp nhăn
  const wk = (p.wrinkles || 0) / 100 * imp;
  if (wk > 0) {
    const y = ycc(reg), Y = ch(y, 0);
    const f1 = Math.max(0.8, fw * 0.005), f2 = Math.max(3, fw * 0.045);
    const a1 = blur1(Y, sw, sh, f1), a2 = blur1(Y, sw, sh, f2);
    const sk = maxFN(p.even_neck ?? true), ea = edgeAttn(Y, sk, sw, sh, fw);
    for (let i = 0; i < n; i++) { const band = a1[i] - a2[i]; y.d[i * 3] -= (Math.min(band, 0) * 0.95 + Math.max(band, 0) * 0.3) * sk[i] * ea[i] * wk; }
    reg = rgb(y);
  }
  // 4) quầng thâm
  const dc = (p.dark_circles || 0) / 100 * imp;
  if (dc > 0) {
    let und = new Uint8Array(n), ref = new Uint8Array(n);
    for (const lid of [LOWER_LID_L, LOWER_LID_R]) {
      const L_ = Qs(lid);
      und = or(und, poly(sw, sh, [...L_, ...L_.map(([x, y]) => [x, y + 0.13 * fw]).reverse()]));
      ref = or(ref, poly(sw, sh, [...L_.map(([x, y]) => [x, y + 0.2 * fw]), ...L_.map(([x, y]) => [x, y + 0.3 * fw]).reverse()]));
    }
    und = and(und, not(dil(eyes, sw, sh, 0.008 * fw)));
    const um = soft(und, sw, sh, 0.025 * fw); for (let i = 0; i < n; i++) um[i] *= skinlike[i] * (1 - pr[i]);
    const lo = blur3(reg, Math.max(2, fw * 0.02)).d;
    const tg = [0, 0, 0]; let cnt = 0;
    for (let i = 0; i < n; i++) if (ref[i] && skinlike[i] > 0.4) { cnt++; for (let c = 0; c < 3; c++) tg[c] += lo[i * 3 + c]; }
    if (cnt > 10) {
      for (let c = 0; c < 3; c++) tg[c] /= cnt;
      for (let i = 0; i < n; i++) if (um[i]) for (let c = 0; c < 3; c++) reg.d[i * 3 + c] += (tg[c] - lo[i * 3 + c]) * um[i] * 0.9 * dc;
    }
  }
  // 5) tạo khối
  const ct = (p.contour || 0) / 100 * imp;
  if (ct > 0) {
    const y = ycc(reg), vl = blur1(ch(y, 0), sw, sh, Math.max(6, fw * 0.1));
    let s = 0, c = 0; for (let i = 0; i < n; i++) if (faceSkin[i] > 0.5) { s += vl[i]; c++; }
    const mean = c ? s / c : vl.reduce((a, v) => a + v, 0) / n;
    for (let i = 0; i < n; i++) y.d[i * 3] += (vl[i] - mean) * faceSkin[i] * ct * 0.7;
    reg = rgb(y);
  }
  // 6) bóng nhờn
  const snn = (p.shine || 0) / 100 * imp;
  if (snn > 0) {
    const y = ycc(reg), lo = blur1(ch(y, 0), sw, sh, Math.max(1.5, fw * 0.012));
    const v = []; for (let i = 0; i < n; i++) if (faceSkin[i] > 0.3) v.push(lo[i]);
    if (v.length) {
      const thr = pct(v, 75);
      for (let i = 0; i < n; i++) y.d[i * 3] -= Math.max(lo[i] - thr, 0) * faceSkin[i] * snn * 0.85;
      reg = rgb(y);
    }
  }
  // 7) răng
  const tb = (p.teeth_bright || 0) / 100 * imp, td = (p.teeth_desat || 0) / 100 * imp;
  if ((tb > 0 || td > 0) && sum(lipsI) > 20) {
    const y = ycc(reg);
    const mouth = and(lipsI, not(dil(not(lipsI), sw, sh, 0.004 * fw)));
    const v = []; for (let i = 0; i < n; i++) if (mouth[i]) v.push(y.d[i * 3]);
    const thr = v.length ? pct(v, 45) : 1;
    const tm = new Uint8Array(n); for (let i = 0; i < n; i++) tm[i] = mouth[i] && y.d[i * 3] > thr ? 1 : 0;
    const teeth = soft(tm, sw, sh, 0.004 * fw);
    for (let i = 0; i < n; i++) {
      const t = teeth[i] * (1 - pr[i]); if (!t) continue;
      const Yv = y.d[i * 3];
      y.d[i * 3] += t * tb * 0.22 * (1 - Yv);
      for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 - t * td * 0.85);
    }
    reg = rgb(y);
  }
  // 8) mắt
  for (const [side, eye, [ci, ring]] of [['l', eyeL, IRIS_L], ['r', eyeR, IRIS_R]]) {
    const ir = (p['iris_' + side] || 0) / 100 * imp, sc = (p['sclera_' + side] || 0) / 100 * imp;
    if ((ir <= 0 && sc <= 0) || lm.length / 2 <= ring[ring.length - 1]) continue;
    const cc = Q(ci);
    const r = ring.reduce((s, j) => s + Math.hypot(Q(j)[0] - cc[0], Q(j)[1] - cc[1]), 0) / ring.length;
    const disc = new Uint8Array(n); circleInto(disc, sw, sh, Math.round(cc[0]), Math.round(cc[1]), Math.max(1, Math.round(r)));
    const iris = and(disc, dil(eye, sw, sh, 0.004 * fw));
    if (ir > 0 && any(iris)) {
      const im = soft(iris, sw, sh, Math.max(0.6, r * 0.12));
      const bl = blur3(reg, Math.max(0.8, r * 0.35)).d;
      const e = { w: sw, h: sh, c: 3, d: new Float32Array(n * 3) };
      for (let i = 0; i < n * 3; i++) e.d[i] = reg.d[i] + (reg.d[i] - bl[i]) * ir * 0.9;
      const y = ycc(e);
      for (let i = 0; i < n; i++) { y.d[i * 3] += ir * 0.05; for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 + ir * 0.35); }
      const rr = rgb(y);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) reg.d[i * 3 + c] = reg.d[i * 3 + c] * (1 - im[i]) + rr.d[i * 3 + c] * im[i];
    }
    if (sc > 0) {
      const scl = and(eye, not(dil(disc, sw, sh, Math.max(1, r * 0.08))));
      if (any(scl)) {
        const smk = soft(scl, sw, sh, Math.max(0.6, r * 0.12));
        const y = ycc(reg);
        for (let i = 0; i < n; i++) {
          const s = smk[i] * (1 - pr[i]); if (!s) continue;
          y.d[i * 3] += s * sc * 0.18 * (1 - y.d[i * 3]);
          for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 - s * sc * 0.75);
        }
        reg = rgb(y);
      }
    }
  }
  // 9) môi
  const lp = (p.lips || 0) / 100 * imp;
  if (lp > 0) {
    const lips = soft(and(lipsO, not(dil(lipsI, sw, sh, 0.006 * fw))), sw, sh, 0.006 * fw);
    const y = ycc(reg);
    for (let i = 0; i < n; i++) {
      const l = lips[i] * (1 - pr[i]); if (!l) continue;
      y.d[i * 3 + 1] += l * lp * 0.045; y.d[i * 3 + 2] += l * lp * 0.012;
      for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 + l * lp * 0.25);
    }
    reg = rgb(y);
  }
  // 9b) má hồng, kẻ mày
  const bl = (p.blush || 0) / 100 * imp;
  if (bl > 0) {
    const cm = new Uint8Array(n);
    for (const i of [50, 280]) { const [qx, qy] = Q(i); circleInto(cm, sw, sh, Math.trunc(qx), Math.trunc(qy), Math.trunc(0.13 * fw)); }
    const m = soft(cm, sw, sh, 0.06 * fw);
    const y = ycc(reg);
    for (let i = 0; i < n; i++) { const t = m[i] * faceSkin[i]; y.d[i * 3 + 1] += t * bl * 0.035; y.d[i * 3 + 2] += t * bl * 0.006; y.d[i * 3] -= t * bl * 0.015; }
    reg = rgb(y);
  }
  const bw = (p.brows || 0) / 100 * imp;
  if (bw > 0) {
    const bm = soft(dil(brows, sw, sh, 0.008 * fw), sw, sh, 0.008 * fw);
    const y = ycc(reg);
    for (let i = 0; i < n; i++) {
      const t = bm[i] * (1 - pr[i]); if (!t) continue;
      y.d[i * 3] *= 1 - t * bw * 0.28;
      for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 - t * bw * 0.3);
    }
    reg = rgb(y);
  }
  // 10) làm đen tóc
  const hd = (p.hair_dark || 0) / 100 * imp;
  if (hd > 0) {
    const top = Math.trunc(Math.max(0, Math.min(Q(105)[1], Q(334)[1])));
    const lim = Math.max(1, Math.trunc((Q(234)[1] + Q(454)[1]) / 2));
    const ovTop = new Uint8Array(n); for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) ovTop[y * sw + x] = oval[y * sw + x] && y > top ? 1 : 0;
    const ovD = dil(ovTop, sw, sh, 0.01 * fw);
    const yv = []; for (let i = 0; i < n; i++) if (oval[i]) yv.push(Yc.d[i * 3]);
    const thr = yv.length ? pct(yv, 55) : Infinity;
    const hair = new Uint8Array(n);
    for (let y = 0; y < Math.min(sh, lim); y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      hair[i] = !ovD[i] && skinlike[i] < 0.25 && Yc.d[i * 3] < thr && (!person || pm[i] > 0.4) ? 1 : 0;
    }
    const hm = soft(hair, sw, sh, 0.01 * fw);
    const y = ycc(reg);
    for (let i = 0; i < n; i++) {
      const t = hm[i] * (1 - pr[i]); if (!t) continue;
      y.d[i * 3] *= 1 - t * hd * 0.35;
      for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 - t * hd * 0.7);
    }
    reg = rgb(y);
  }
  // 11) tóc con bay ra ngoài nền
  const ho = (p.hair_outer || 0) / 100 * imp;
  if (ho > 0 && person) {
    const pm2 = new Uint8Array(n); for (let i = 0; i < n; i++) pm2[i] = pm[i] > 0.5 ? 1 : 0;
    const Y = ch(ycc(reg), 0);
    const above = new Uint8Array(n);
    above.fill(1, 0, Math.min(sh, Math.max(1, Math.trunc(Q(152)[1]))) * sw);        // chỉ quanh đầu (trên cằm)
    let solid = cv.morphOpen(pm2, sw, sh, Math.trunc(0.05 * fw) | 1);
    // Khối tóc THẬT: mặt nạ người thường lọt vào trong mái tóc, nên mép tóc thật bị coi là "tóc con" và bị lấp
    // (thành đốm tối). Lấy thêm phần tối giống tóc sát quanh mặt nạ (tóc tối hơn nền rõ rệt).
    const ringo = and(and(dil(solid, sw, sh, 0.18 * fw), not(dil(solid, sw, sh, 0.06 * fw))), above);
    const browY = Math.trunc(Math.min(Q(105)[1], Q(334)[1]));
    const hairIn = and(solid, above); hairIn.fill(0, Math.max(0, Math.min(sh, browY)) * sw);
    // mẫu màu tóc THUẦN: dải hẹp ngay trên đỉnh trán (mốc 10), giữa đầu — theo vị trí mặt, KHÔNG theo mặt nạ người
    const hairPure = new Uint8Array(n);
    const q10 = Q(10);
    const r0 = Math.trunc(Math.max(0, q10[1] - 0.6 * fw)), r1 = Math.min(sh, Math.trunc(Math.max(1, q10[1] - 0.02 * fw)));
    const c0 = Math.trunc(Math.max(0, q10[0] - 0.3 * fw)), c1 = Math.trunc(Math.min(sw, q10[0] + 0.3 * fw));
    for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) hairPure[y * sw + x] = 1;
    // mẫu tóc phải TỐI hơn da má rõ rệt (da trán bị đèn làm gần trắng / tóc ánh màu phông thì nhận da theo màu sai)
    const Y0 = ch(Yc, 0);
    const ovSk = new Uint8Array(n); for (let i = 0; i < n; i++) ovSk[i] = oval[i] && skinlike[i] > f32(0.6) ? 1 : 0;
    const cheekY = any(ovSk) ? median(vals(Y0, ovSk)) : any(oval) ? median(vals(Y0, oval)) : 1.0;
    const tc = f32(cheekY - 0.08), tc6 = f32(0.6 * cheekY), t3 = f32(0.3);
    for (let i = 0; i < n; i++) if (hairPure[i] && !(Y[i] < tc && (skinlike[i] < t3 || Y[i] < tc6))) hairPure[i] = 0;
    if (sum(hairPure) > 200) {                 // dải tìm có thể lẫn phông (tóc ngắn): lấy 35% điểm tối nhất
      const t35 = f32(pct(vals(Y, hairPure), 35));
      for (let i = 0; i < n; i++) if (hairPure[i] && !(Y[i] <= t35)) hairPure[i] = 0;
    }
    if (sum(ringo) > 50 && sum(hairIn) > 50) {
      const yb_ = median(vals(Y, ringo)), yh_ = median(vals(Y, hairIn));
      if (Math.abs(yb_ - yh_) > 0.12) {
        const th = f32((yb_ + yh_) / 2), near = dil(solid, sw, sh, 0.05 * fw);
        let grow = new Uint8Array(n);
        for (let i = 0; i < n; i++) grow[i] = (yh_ < yb_ ? Y[i] < th : Y[i] > th) && near[i] && above[i] ? 1 : 0;
        grow = cv.morphOpen(grow, sw, sh, Math.trunc(0.03 * fw) | 1);
        solid = or(solid, grow);
      }
    }
    // không có mẫu tóc chắc chắn (hói, đội mũ, tóc sáng màu): để nguyên, không đoán bừa
    const [m, hb] = sum(hairPure) > 200 ? flyaways(reg, Y, solid, above, hairPure, sw, sh, fw, ho, oval) : [null, null];
    if (hb) solid = hb;
    if (m && any(m)) {
      for (let i = 0; i < n; i++) if (!(pr[i] < 0.5)) m[i] = 0;
      // chỉ lấy màu lấp từ NỀN (không phải khối tóc, không phải sợi tóc khác) -> không còn đốm tối
      const md = dil(m, sw, sh, 1);
      const bg = and(not(dil(solid, sw, sh, Math.max(2, 0.012 * fw))), not(md));
      reg = fillSpots(reg, md, fw, false, null, bg);
    }
  }
  put3(out, reg, x0, y0);
  const samples = samp;
  return { fw, chinY: P(152)[1], cx: (P(234)[0] + P(454)[0]) / 2, samples, box: [x0, y0, x1, y1], oval, sw, sh };
}

// ---------------------------------------------------------------------------- toàn thân / tông da / quần áo
function skinTone(img, mask, p, imp, samples, W, H) {
  const u = (p.tone_uniform || 0) / 100 * imp, tt = (p.tone_temp || 0) / 100 * imp, tn = (p.tone_tint || 0) / 100 * imp;
  const sa = (p.tone_sat || 0) / 100 * imp, li = (p.tone_light || 0) / 100 * imp, pref = (p.tone_pref || 0) / 100 * imp;
  const preset = TONE_PRESETS[p.tone_preset || 'none'];
  if (!(u || tt || tn || sa || li || pref || preset)) return img;
  const y = ycc(img), n = img.w * img.h;
  const fw = Math.max(W, H) * 0.15;
  const lo = blur3(y, Math.max(2, fw * 0.03)).d;
  if (u > 0) {
    let tg;
    if (samples.length) tg = [median(samples.map((s) => s[0])), median(samples.map((s) => s[1]))];
    else { tg = [0, 0]; let c = 0; for (let i = 0; i < n; i++) if (mask[i] > 0.5) { tg[0] += lo[i * 3 + 1]; tg[1] += lo[i * 3 + 2]; c++; } tg = tg.map((v) => v / Math.max(1, c)); }
    for (let i = 0; i < n; i++) { const k = mask[i] * 0.85 * u; y.d[i * 3 + 1] += (tg[0] - lo[i * 3 + 1]) * k; y.d[i * 3 + 2] += (tg[1] - lo[i * 3 + 2]) * k; }
  }
  if (preset) {
    const py = 0.299 * preset[0] + 0.587 * preset[1] + 0.114 * preset[2];
    const pc = [py, (preset[0] - py) * 0.713 + 0.5, (preset[2] - py) * 0.564 + 0.5];
    for (let i = 0; i < n; i++) {
      const k = mask[i];
      y.d[i * 3 + 1] += (pc[1] - lo[i * 3 + 1]) * k * 0.6 * imp; y.d[i * 3 + 2] += (pc[2] - lo[i * 3 + 2]) * k * 0.6 * imp;
      const dY = (pc[0] - lo[i * 3]) * 0.35 * imp;
      y.d[i * 3] += Math.max(-0.12, Math.min(0.12, dY)) * k;
    }
  }
  for (let i = 0; i < n; i++) {
    const m = mask[i];
    y.d[i * 3 + 2] -= m * (tt * 0.035 + pref * 0.03);
    y.d[i * 3 + 1] += m * (tt * 0.018 + pref * 0.015 + tn * 0.03);
    if (sa) for (let c = 1; c < 3; c++) y.d[i * 3 + c] = 0.5 + (y.d[i * 3 + c] - 0.5) * (1 + m * sa * 0.6);
    if (li) y.d[i * 3] += m * li * 0.15 * (li > 0 ? 1 - y.d[i * 3] : y.d[i * 3]);
  }
  return rgb(y);
}

// Tính theo độ sáng TƯƠNG ĐỐI (log): nếp nhăn trên áo trắng phơi nắng và trên vest đen cùng một thước đo
// (chênh 0.2 log ~ 20%), viền thật (vest / sơ mi, khăn túi, nút) luôn chênh hơn hẳn.
const WRINKLE_LOG_EPS = 0.10;  // log(Y + eps): vùng tối (vest đen) không bị phóng đại chênh lệch / nhiễu
const WRINKLE_AMP = 0.20;      // nếp nhăn = chênh sáng tương đối NHỎ; chênh lớn hơn (tới 2x thì thôi hẳn) là chi tiết thật
const WRINKLE_EDGE = 0.42;     // chênh tương đối cục bộ từ mức này: đường viền rõ (áo / nền, vest / sơ mi, ve, khăn) -> khoá
const WRINKLE_SC = 0.30;       // lọc song phương: chênh được trộn (lớn hơn nếp nhăn, nhỏ hơn viền áo / khăn / sơ mi)
const WRINKLE_SS = 0.15;       // lọc song phương: bán kính trộn nếp MỀM (theo bề rộng mặt)
const WRINKLE_SS_FINE = 0.03;  // lọc song phương: bán kính trộn nếp NHỎ, SẮC
const WRINKLE_TEX = 0.003;     // dưới cỡ này (theo bề rộng mặt) là kết cấu sợi vải: giữ nguyên
const WRINKLE_FINE = 0.85;     // nếp nhỏ sắc (tối) bớt tới 85% ở mức 100 — gờ sáng bớt ít hơn chút
const WRINKLE_SOFT = 0.60;     // nếp mềm vừa chỉ dịu bớt 60%: áo vẫn có khối, không phẳng như nhựa
const WRINKLE_FACE_PX = 70.0;  // nếp mềm: tính trên ảnh thu nhỏ để mặt ~70 px (chi tiết thô) -> nhanh
const WRINKLE_FACE_PX_FINE = 220.0;   // nếp nhỏ sắc: cần nét hơn (mặt ~220 px)
export const _wrinkleOpts = { full: false };   // kiểm tra: true = tính cả ảnh (không giới hạn khung) để so

function shrinkA(a, w, h, f) {           // cv2.resize INTER_AREA để mặt về cỡ f (tối thiểu 8 điểm)
  if (f >= 1) return { d: a, w, h };
  const nw = Math.max(8, cv.roundEven(w * f)), nh = Math.max(8, cv.roundEven(h * f));
  return { d: cv.resizeArea(cv.img1(w, h, a), nw, nh).d, w: nw, h: nh };
}
// mặt nạ các điểm cách (theo ô vuông) <= r điểm một điểm khác 0 của m
function boxDil(m, w, h, r) {
  const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0, last = -1e9; x < w; x++) { if (m[off + x]) last = x; if (x - last <= r) t[off + x] = 1; }
    for (let x = w - 1, last = 1e9; x >= 0; x--) { if (m[off + x]) last = x; if (last - x <= r) t[off + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0, last = -1e9; y < h; y++) { if (t[y * w + x]) last = y; if (y - last <= r) o[y * w + x] = 1; }
    for (let y = h - 1, last = 1e9; y >= 0; y--) { if (t[y * w + x]) last = y; if (last - y <= r) o[y * w + x] = 1; }
  }
  return o;
}
// điểm của ảnh lớn (w, h) góp vào (qua INTER_AREA) một điểm thuộc mặt nạ ms của ảnh nhỏ (sw, sh)
function upMask(ms, sw, sh, w, h) {
  const d = boxDil(ms, sw, sh, 1), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const qy = Math.min(sh - 1, Math.floor(y * sh / h)) * sw;
    for (let x = 0; x < w; x++) o[y * w + x] = d[qy + Math.min(sw - 1, Math.floor(x * sw / w))];
  }
  return o;
}
// "trong áo, không sát mép mặt nạ người" của _wrinkle_band: msIn, sup = (msIn > 0), need = khung chứa sup
function msInOf(ms, w, h, fws) {
  const n = w * h, msb = new Uint8Array(n);
  for (let i = 0; i < n; i++) msb[i] = ms[i] > 0.5 ? 1 : 0;
  const S = bboxOf(msb, w, h), msIn = new Float32Array(n), sup = new Uint8Array(n);
  if (!S) return { msIn, sup, need: null };
  const s = Math.max(1, fws * 0.01), need = growB(S, gRad(s) + 1, w, h);
  const e = Float32Array.from(ero(msb, w, h, Math.max(1, fws * 0.015)));
  const b = _wrinkleOpts.full ? blur1(e, w, h, s) : blurBox(e, w, h, 1, s, need);
  for (let i = 0; i < n; i++) { msIn[i] = clamp01(b[i]); sup[i] = msIn[i] > 0 ? 1 : 0; }
  return { msIn, sup, need };
}

// Dải nếp nhăn ở một cỡ (portrait._wrinkle_band): lo - (lo lọc song phương). Trả dải, trọng số = cổng biên độ x khoá
// viền x trong áo (mi = msInOf), nền đã lọc. bmask: điểm cần nền lọc đúng (lọc song phương chỉ tính ở đó).
function wrinkleBand(lo, mi, w, h, fws, ss, bmask) {
  const n = w * h, full = _wrinkleOpts.full, sp = Math.max(1.5, fws * ss);
  const bb = bmask && bboxOf(bmask, w, h);
  const base = full ? cv.bilateral(lo, w, h, WRINKLE_SC, sp) : bb ? cv.bilateral(lo, w, h, WRINKLE_SC, sp, bb, bmask) : Float32Array.from(lo);
  const k = Math.max(3, Math.trunc(fws * 0.04) | 1);
  const rl = Math.max(1, fws * 0.02), sl = Math.max(1, fws * 0.015);
  // khoá viền: chênh sáng cục bộ lớn (giãn - co) -> chỉ cần đúng trong khung có trọng số
  const lbox = full ? null : growB(mi.need, gRad(sl) + dRad(rl), w, h);
  const di = cv.morphEllipse(lo, w, h, k, true, lbox), er = cv.morphEllipse(lo, w, h, k, false, lbox);
  const edge = new Uint8Array(n), te = f32(WRINKLE_EDGE);
  for (let i = 0; i < n; i++) edge[i] = f32(di[i] - er[i]) > te ? 1 : 0;
  const ld = Float32Array.from(dil(edge, w, h, rl));
  const lock = full ? blur1(ld, w, h, sl) : blurBox(ld, w, h, 1, sl, mi.need);
  const band = new Float32Array(n), wt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    band[i] = lo[i] - base[i];
    wt[i] = clamp01(2 - Math.abs(band[i]) / WRINKLE_AMP) * (1 - clamp01(lock[i])) * mi.msIn[i];
  }
  return { band, wt, base };
}

// Làm phẳng nếp nhăn áo cho THẬT (portrait._flatten_wrinkles): xử lý theo cỡ như thợ chỉnh ảnh —
// kết cấu sợi vải (rất nhỏ) giữ nguyên; nếp gấp NHỎ, SẮC bớt mạnh (WRINKLE_FINE, tính ở độ nét cao hơn); nếp MỀM vừa chỉ
// dịu bớt (WRINKLE_SOFT); khối sáng tối LỚN giữ nguyên. Mỗi dải: nền mượt = lọc song phương (chỉ trộn điểm CÙNG MÀU);
// chỉ chỉnh chênh sáng nhỏ (<= WRINKLE_AMP); khoá sát chỗ chênh sáng cục bộ lớn (viền) và đường cấu trúc thẳng dài.
// Các phép nặng (lọc song phương, đường có hướng, co / giãn, làm mờ mặt nạ) chỉ tính ở những điểm ảnh hưởng tới kết
// quả trong áo — kết quả y hệt tính cả ảnh.
function flattenWrinkles(Y, cmask, W, H, fw, amount) {
  const N = W * H, full = _wrinkleOpts.full;
  const f1 = Math.min(1, WRINKLE_FACE_PX_FINE / Math.max(1, fw));
  const LY = new Float32Array(N); for (let i = 0; i < N; i++) LY[i] = Math.log(Math.max(Y[i], 0) + WRINKLE_LOG_EPS);
  const s1 = shrinkA(LY, W, H, f1), w1 = s1.w, h1 = s1.h, n1 = w1 * h1, m1 = shrinkA(cmask, W, H, f1).d, fw1 = fw * f1;
  const f2 = Math.min(1, WRINKLE_FACE_PX / Math.max(1, fw)) / f1;
  const fw2 = fw1 * Math.min(1, f2);
  const m2s = shrinkA(m1, w1, h1, f2), w2 = m2s.w, h2 = m2s.h, m2 = m2s.d;
  const A1 = msInOf(m1, w1, h1, fw1);
  let c1 = null, c2 = null;
  if (A1.need) {
    const A2 = msInOf(m2, w2, h2, fw2);
    // nền bước 2 (ảnh nhỏ) cần đúng quanh chỗ trọng số bước 2 khác 0: tầm lọc song phương / co giãn + khoá viền
    const r2 = Math.max(1, cv.roundEven(Math.max(1.5, fw2 * WRINKLE_SS) * 1.5)), k2 = Math.max(3, Math.trunc(fw2 * 0.04) | 1);
    const M2 = Math.max(r2, gRad(Math.max(1, fw2 * 0.015)) + dRad(Math.max(1, fw2 * 0.02)) + (k2 >> 1)) + 1;
    const bm1 = Uint8Array.from(A1.sup);
    if (A2.need) { const u = upMask(boxDil(A2.sup, w2, h2, M2), w2, h2, w1, h1); for (let i = 0; i < n1; i++) bm1[i] |= u[i]; }
    // 1) nếp nhỏ sắc: dải (trên cỡ sợi vải .. cỡ nếp nhỏ), tính ở độ nét cao; nếp TỐI bớt nhiều hơn gờ sáng
    const lo1 = blur1(s1.d, w1, h1, Math.max(0.5, fw1 * WRINKLE_TEX));
    const b1 = wrinkleBand(lo1, A1, w1, h1, fw1, WRINKLE_SS_FINE, bm1);
    // ĐƯỜNG CẤU TRÚC của áo (ve áo, nẹp khuy, đường may, miệng túi): DÀI và THẲNG; nếp nhăn thì cong, ngắn.
    // Không làm phẳng quanh chúng — nếu làm phẳng bóng hai bên mà để lại nét mảnh của ve áo, ve áo trông như nét vẽ.
    const m03 = new Uint8Array(n1), t03 = f32(0.3); for (let i = 0; i < n1; i++) m03[i] = m1[i] > t03 ? 1 : 0;
    const B03 = bboxOf(m03, w1, h1);
    const G = B03 ? cv.sobelMag(lo1, w1, h1, full ? null : B03) : new Float32Array(n1);
    for (let i = 0; i < n1; i++) if (!m03[i]) G[i] = 0;
    const Ls = Math.max(9, Math.trunc(fw1 * 0.12) | 1), rs = Math.max(1, fw1 * 0.012);
    // khoá cấu trúc cần đúng ở chỗ trọng số khác 0 của cả hai bước (bước 2 lấy nó qua thu nhỏ); ngưỡng lấy trên m1 > 0.5
    const sm = Uint8Array.from(A1.sup);
    if (A2.need) { const u = upMask(A2.sup, w2, h2, w1, h1); for (let i = 0; i < n1; i++) sm[i] |= u[i]; }
    const am = boxDil(sm, w1, h1, gRad(rs) + dRad(rs));
    const m05 = new Uint8Array(n1); for (let i = 0; i < n1; i++) { m05[i] = m1[i] > 0.5 ? 1 : 0; if (m05[i]) am[i] = 1; }
    const an = full ? lineAniso(G, w1, h1, [0, h1, 0, w1], Ls) : B03 ? lineAniso(G, w1, h1, [0, h1, 0, w1], Ls, 12, growB(B03, Ls >> 1, w1, h1), am) : new Float32Array(n1);
    const va = vals(an, m05);
    const struct = new Uint8Array(n1);
    if (va.length > 100) {
      const med = median(va), mad = madOf(va, med) * 1.48 + 1e-6, ts = f32(Math.max(0.03, med + 7.0 * mad));
      for (let i = 0; i < n1; i++) struct[i] = an[i] > ts ? 1 : 0;
    }
    const sd = Float32Array.from(dil(struct, w1, h1, rs));
    const slock = full ? blur1(sd, w1, h1, rs) : blurBox(sd, w1, h1, 1, rs, bboxOf(sm, w1, h1));
    for (let i = 0; i < n1; i++) slock[i] = clamp01(slock[i]);
    c1 = new Float32Array(n1);
    for (let i = 0; i < n1; i++) {
      const bd = b1.band[i], wt = b1.wt[i] * (1 - slock[i]);
      c1[i] = -bd * wt * (bd < 0 ? WRINKLE_FINE : WRINKLE_FINE * 0.9);
    }
    // 2) nếp mềm: dải NỐI TIẾP ngay trên (nền của bước 1 .. cỡ khối lớn) -> hai dải không chồng nhau; chỉ dịu bớt
    if (A2.need) {
      const b2in = shrinkA(b1.base, w1, h1, f2).d;
      const b2 = wrinkleBand(b2in, A2, w2, h2, fw2, WRINKLE_SS, A2.sup);
      const sl2 = shrinkA(slock, w1, h1, f2).d;
      c2 = new Float32Array(w2 * h2);
      for (let i = 0; i < c2.length; i++) c2[i] = -b2.band[i] * (b2.wt[i] * (1 - sl2[i])) * WRINKLE_SOFT;
      if (f2 < 1) c2 = cv.resizeLinear(cv.img1(w2, h2, c2), w1, h1).d;
    }
  }
  let corr = new Float32Array(n1);
  if (c1) for (let i = 0; i < n1; i++) corr[i] = (c1[i] + (c2 ? c2[i] : 0)) * amount;
  if (f1 < 1) corr = cv.resizeLinear(cv.img1(w1, h1, corr), W, H).d;
  // sửa theo TỈ LỆ (nhân): kết cấu sợi vải trong nếp tối được nâng cùng độ sáng, không bị bệt
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = corr[i] * clamp01(cmask[i] * 1.5), y = Y[i];
    out[i] = (Math.max(y, 0) + WRINKLE_LOG_EPS) * Math.exp(c) - WRINKLE_LOG_EPS + Math.min(y, 0);
  }
  return out;
}

function clothes(img, cm, fw, p, imp) {
  const wr = (p.cloth_wrinkle || 0) / 100 * imp, spt = (p.cloth_spots || 0) / 100 * imp, edg = (p.cloth_edges || 0) / 100 * imp;
  const { w, h } = img, n = w * h;
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, cm[i]);
  if (mx <= 0) return img;
  let out = img;
  if (spt > 0) {
    const y = ycc(out), Cr = new Float32Array(n).fill(0.5);
    const m = spotMask(ch(y, 0), Cr, cm, w, h, fw * 1.2, spt, true);
    const ok = new Uint8Array(n); for (let i = 0; i < n; i++) ok[i] = cm[i] > 0.5 ? 1 : 0;
    out = fillSpots(out, m, fw * 1.2, true, ok);
  }
  if (wr > 0) {
    const y = ycc(out), Y = flattenWrinkles(ch(y, 0), cm, w, h, fw, Math.min(1, wr));
    for (let i = 0; i < n; i++) y.d[i * 3] = Y[i];
    out = rgb(y);
  }
  if (edg > 0) {
    const cb = new Uint8Array(n); for (let i = 0; i < n; i++) cb[i] = cm[i] > 0.5 ? 1 : 0;
    const ring = and(dil(cb, w, h, Math.max(2, fw * 0.012)), not(ero(cb, w, h, Math.max(2, fw * 0.012))));
    const rm = soft(ring, w, h, Math.max(1, fw * 0.006)), bo = blur3(out, Math.max(1, fw * 0.006)).d;
    const o2 = { w, h, c: 3, d: new Float32Array(n * 3) };
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const k = rm[i] * edg * 0.7; o2.d[i * 3 + c] = out.d[i * 3 + c] * (1 - k) + bo[i * 3 + c] * k; }
    out = o2;
  }
  return out;
}

// ---------------------------------------------------------------------------- tạo hình (làm SAU CÙNG)
function reshapeFace(out, lm, p, imp, W, H, ox, oy) {
  const P = (i) => [lm[i * 2] * W - ox, lm[i * 2 + 1] * H - oy];
  const fw = Math.hypot(P(234)[0] - P(454)[0], P(234)[1] - P(454)[1]);
  const sl = (p.face_slim || 0) / 100 * imp, vl = (p.vline || 0) / 100 * imp, ns = (p.nose_slim || 0) / 100 * imp, eb = (p.eyes_big || 0) / 100 * imp;
  if (fw < 40 || !(sl || vl || ns || eb)) return out;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const i of OVAL) { const [x, y] = P(i); mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
  const lx = Math.max(0, -ox), ly = Math.max(0, -oy), hx = Math.min(out.w, W - ox), hy = Math.min(out.h, H - oy);
  const x0 = Math.trunc(Math.max(lx, mnx - 0.4 * fw)), x1 = Math.trunc(Math.min(hx, mxx + 0.4 * fw));
  const y0 = Math.trunc(Math.max(ly, mny - 0.3 * fw)), y1 = Math.trunc(Math.min(hy, mxy + 0.35 * fw));
  if (x1 - x0 < 4 || y1 - y0 < 4) return out;
  let reg = sub3(out, x0, y0, x1, y1);
  const w = reg.w, h = reg.h, n = w * h;
  const Q = (i) => { const [x, y] = P(i); return [x - x0, y - y0]; };
  const cx = (Q(234)[0] + Q(454)[0]) / 2;
  const ctrl = [], vecs = [];
  if (sl) for (const i of [234, 93, 132, 58, 172, 136, 454, 323, 361, 288, 397, 365]) { ctrl.push(Q(i)); vecs.push([(cx - Q(i)[0]) * 0.085 * sl, 0]); }
  if (vl) {
    const chin = Q(152);
    for (const i of [172, 136, 150, 149, 176, 148, 377, 400, 378, 379, 365, 397]) { ctrl.push(Q(i)); vecs.push([(chin[0] - Q(i)[0]) * 0.07 * vl, (chin[1] - Q(i)[1]) * 0.05 * vl]); }
    ctrl.push(chin); vecs.push([0, 0.02 * fw * vl]);
  }
  let dx = null, dy = null;
  const field = (cs, vs, sigma) => {
    const fx = new Float32Array(n), fy = new Float32Array(n), s2 = 2 * sigma * sigma;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let ax = 0, ay = 0;
      for (let k = 0; k < cs.length; k++) { const g = Math.exp(-((x - cs[k][0]) ** 2 + (y - cs[k][1]) ** 2) / s2); ax += g * vs[k][0]; ay += g * vs[k][1]; }
      fx[y * w + x] = ax; fy[y * w + x] = ay;
    }
    return [fx, fy];
  };
  if (ctrl.length) [dx, dy] = field(ctrl, vecs, 0.11 * fw);
  if (ns) {
    const nc = [(Q(98)[0] + Q(327)[0]) / 2, (Q(98)[1] + Q(327)[1]) / 2];
    const c2 = [], v2 = [];
    for (const i of [98, 327, 64, 294, 48, 278]) { c2.push(Q(i)); v2.push([(nc[0] - Q(i)[0]) * 0.22 * ns, 0]); }
    const [ax, ay] = field(c2, v2, 0.05 * fw);
    if (dx) for (let i = 0; i < n; i++) { dx[i] += ax[i]; dy[i] += ay[i]; } else { dx = ax; dy = ay; }
  }
  if (dx) {
    const mx = new Float32Array(n), my = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; mx[i] = x - dx[i]; my[i] = y - dy[i]; }
    reg = cv.remapLinear(reg, mx, my, w, h);
  }
  if (eb) {
    const mx = new Float32Array(n), my = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { mx[y * w + x] = x; my[y * w + x] = y; }
    for (const [ci, lid] of [[468, EYE_IMG_LEFT], [473, EYE_IMG_RIGHT]]) {
      if (lm.length / 2 <= ci) continue;
      const c = Q(ci);
      const xs = lid.map((i) => Q(i)[0]), R = (Math.max(...xs) - Math.min(...xs)) * 0.95;
      for (let y = Math.max(0, Math.floor(c[1] - R)); y <= Math.min(h - 1, Math.ceil(c[1] + R)); y++)
        for (let x = Math.max(0, Math.floor(c[0] - R)); x <= Math.min(w - 1, Math.ceil(c[0] + R)); x++) {
          const d = Math.hypot(x - c[0], y - c[1]);
          if (d >= R) continue;
          const k = 1 - eb * 0.14 * (1 - (d / R) ** 2);
          mx[y * w + x] = c[0] + (x - c[0]) * k; my[y * w + x] = c[1] + (y - c[1]) * k;
        }
    }
    reg = cv.remapLinear(reg, mx, my, w, h);
  }
  put3(out, reg, x0, y0);
  return out;
}

function slimBody(out, person, chinY, fw, amount, oy) {
  const { w: W, h: H } = out;
  const cen = new Float64Array(H), cnt = new Float64Array(H);
  for (let y = 0; y < H; y++) { let s = 0, c = 0; for (let x = 0; x < W; x++) if (person[y * W + x] > 0.5) { s += x; c++; } cnt[y] = c; cen[y] = c ? s / c : NaN; }
  const valid = []; for (let y = 0; y < H; y++) if (!isNaN(cen[y])) valid.push(y);
  if (!valid.length) return out;
  for (let y = 0; y < H; y++) if (isNaN(cen[y])) {     // np.interp (giữ hằng ngoài mép)
    let a = -1, b = -1;
    for (const v of valid) { if (v < y) a = v; else { b = v; break; } }
    cen[y] = a < 0 ? cen[b] : b < 0 ? cen[a] : cen[a] + (cen[b] - cen[a]) * (y - a) / (b - a);
  }
  const hw = new Float64Array(H); for (let y = 0; y < H; y++) hw[y] = Math.max(cnt[y] / 2, fw * 0.5);
  const k = Math.max(5, Math.trunc(fw * 0.5) | 1);
  const sig = 0.3 * ((k - 1) * 0.5 - 1) + 0.8;           // OpenCV: sigma từ ksize khi sigma = 0
  const ker = []; let ks = 0;
  for (let i = 0; i < k; i++) { const v = Math.exp(-((i - (k - 1) / 2) ** 2) / (2 * sig * sig)); ker.push(v); ks += v; }
  const sm = (a) => { const o = new Float64Array(H); for (let y = 0; y < H; y++) { let s = 0; for (let i = 0; i < k; i++) { let yy = y + i - (k - 1) / 2; if (yy < 0) yy = -yy; if (yy >= H) yy = 2 * H - 2 - yy; s += a[Math.max(0, Math.min(H - 1, yy))] * ker[i]; } o[y] = s / ks; } return o; };
  const c2 = sm(cen), h2 = sm(hw);
  const mx = new Float32Array(W * H), my = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const wy = clamp01((y - chinY) / Math.max(1, fw * 0.6));
    for (let x = 0; x < W; x++) {
      const rel = (x - c2[y]) / h2[y];
      let f = clamp01((1.7 - Math.abs(rel)) / 0.7); f = f * f * (3 - 2 * f);
      const s = amount * 0.09 * wy * f;
      mx[y * W + x] = x + (x - c2[y]) * s; my[y * W + x] = y;
    }
  }
  return cv.remapLinear(out, mx, my, W, H);
}

// ---------------------------------------------------------------------------- điểm vào
// img: ảnh vùng; faces: [Float32Array(478*2)] toạ độ chuẩn hoá; personFn(w, h, roi) -> mặt nạ; roi = [ox, oy, W, H]
// opt.infosOut: mảng nhận thông tin từng mặt đã xử lý (chuẩn hoá theo cả ảnh) — lấy từ bản xem trước;
// opt.faceInfos: thông tin đó dùng cho các bước toàn thân (da thân, tông da, quần áo, thon người) khi dựng THEO DẢI
// (xuất cỡ gốc, phóng 1:1): dải nằm xa mặt vẫn có bề rộng mặt / cằm / mẫu màu da như khi dựng cả ảnh (bản máy tính
// chạy chân dung trên cả ảnh), nên áo phía dưới vẫn được xoá nếp nhăn và mọi dải dùng cùng một mẫu da.
export function applyPortrait(img, p, faces, personFn, roi, opt = {}) {
  if (!portraitActive(p) || !faces || !faces.length) return img;
  const [ox, oy, W, H] = roi || [0, 0, img.w, img.h];
  let out = { w: img.w, h: img.h, c: 3, d: Float32Array.from(img.d) };
  const w = out.w, h = out.h, n = w * h;
  const imp = (p.impact ?? 100) / 100;
  let prot = null;
  if (p.protect && p.protect.length) {
    const pm = new Float32Array(n);
    drawStrokes(pm, p.protect.map((s) => Object.assign({}, s, { flow: 1 })), w, h, null, [ox, oy, W, H]);
    const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = pm[i] > 0.5 ? 1 : 0;
    prot = soft(b, w, h, Math.max(1, W * 0.002));
  }
  const person = needsPerson(p) && personFn ? personFn(w, h, [ox, oy, W, H]) : null;
  const ovalMean = (lm) => OVAL.reduce((s, i) => s + lm[i * 2], 0) / OVAL.length;
  const order = faces.map((_, i) => i).sort((a, b) => ovalMean(faces[a]) - ovalMean(faces[b]));
  const who = p.who ?? 'all';
  const sel = who === 'all' ? order : (/^\d+$/.test(String(who)) && +who < order.length ? [order[+who]] : []);
  const infos = [];
  for (const i of sel) { const inf = processFace(out, faces[i], p, imp, prot, person, W, H, ox, oy); if (inf) infos.push(inf); }
  if (opt.infosOut) for (const f of infos) opt.infosOut.push({ fw: f.fw / W, chin: (f.chinY + oy) / H, cx: (f.cx + ox) / W, samples: f.samples });
  const G = opt.faceInfos && opt.faceInfos.length ? opt.faceInfos : null;
  if (!infos.length && !G) { for (let i = 0; i < out.d.length; i++) out.d[i] = clamp01(out.d[i]); return out; }
  // thông số toàn thân: theo cả ảnh (G) nếu có, không thì theo các mặt trong vùng này
  const body = G ? G.map((g) => ({ fw: g.fw * W, chinY: g.chin * H - oy, cx: g.cx * W - ox, samples: g.samples })) : infos;
  const fw = Math.max(...body.map((f) => f.fw));
  const samples = body.flatMap((f) => f.samples);
  const skin = skinLike(ycc(out), samples);
  let faceM = new Uint8Array(n);
  for (const f of infos) {
    const [x0, y0] = f.box;
    for (let y = 0; y < f.sh; y++) for (let x = 0; x < f.sw; x++) if (f.oval[y * f.sw + x]) faceM[(y + y0) * w + x + x0] = 1;
  }
  const faceSoft = soft(dil(faceM, w, h, fw * 0.25), w, h, fw * 0.05);
  let pm = person;
  if (who !== 'all' && pm) {
    const f = body[0], cols = new Uint8Array(n);
    const a = Math.trunc(Math.max(0, f.cx - 1.6 * f.fw)), b2 = Math.trunc(Math.min(w, f.cx + 1.6 * f.fw));
    for (let y = 0; y < h; y++) for (let x = a; x < b2; x++) cols[y * w + x] = 1;
    const cs = soft(cols, w, h, f.fw * 0.1);
    pm = Float32Array.from(pm, (v, i) => v * cs[i]);
  }
  const protK = (i) => (prot ? 1 - prot[i] : 1);
  let bodySkin = null;
  if (pm) { bodySkin = new Float32Array(n); for (let i = 0; i < n; i++) bodySkin[i] = skin[i] * pm[i] * (1 - faceSoft[i]) * protK(i); }
  const be = (p.body_even || 0) / 100 * imp, bt = (p.body_texture || 0) / 100;
  if (bodySkin && (be > 0 || Math.abs(bt) > 1e-6)) out = even(out, bodySkin.map(clamp01), fw * 1.2, be, bt);
  const tgt = p.tone_target || 'all';
  const faceAll = new Float32Array(n); for (let i = 0; i < n; i++) faceAll[i] = skin[i] * faceSoft[i] * protK(i);
  let tm;
  if (tgt === 'face') tm = faceAll;
  else if (tgt === 'body') tm = bodySkin || new Float32Array(n);
  else tm = bodySkin ? faceAll.map((v, i) => Math.max(v, bodySkin[i])) : faceAll;
  out = skinTone(out, tm.map(clamp01), p, imp, samples, W, H);
  if (pm && ['cloth_wrinkle', 'cloth_spots', 'cloth_edges'].some((k) => p[k])) {
    const chin = Math.trunc(Math.min(...body.map((f) => f.chinY)) + 0.12 * fw);
    const sk35 = new Uint8Array(n); for (let i = 0; i < n; i++) sk35[i] = skin[i] > 0.35 ? 1 : 0;
    const ss = soft(sk35, w, h, fw * 0.01);
    const cm0 = new Uint8Array(n);
    for (let y = Math.min(h, Math.max(0, chin)); y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; cm0[i] = clamp01(pm[i] * (1 - ss[i]) * protK(i)) > 0.5 ? 1 : 0; }
    const cm = soft(ero(cm0, w, h, fw * 0.01), w, h, fw * 0.01);
    out = clothes(out, cm, fw, p, imp);
  }
  for (const i of sel) out = reshapeFace(out, faces[i], p, imp, W, H, ox, oy);
  const bs = (p.body_slim || 0) / 100 * imp;
  if (bs > 0 && pm) out = slimBody(out, pm, Math.min(...body.map((f) => f.chinY)), fw, bs, oy);
  for (let i = 0; i < out.d.length; i++) out.d[i] = clamp01(out.d[i]);
  return out;
}

// vùng nguồn (điểm ảnh gốc) cần thêm để chân dung đúng khi dựng theo dải: cả chiều ngang, các mặt chạm dải
export function portraitNeeds(p, faces, W, H, rect) {
  if (!portraitActive(p) || !faces || !faces.length) return rect;
  let [x0, y0, x1, y1] = rect;
  x0 = 0; x1 = W;
  for (const [a, b, c, d] of faceBoxes(faces)) {
    const fw = (c - a) * W;
    const fy0 = b * H - 0.9 * fw, fy1 = d * H + 1.6 * fw;
    if (fy1 < y0 - fw || fy0 > y1 + fw) continue;
    y0 = Math.min(y0, fy0); y1 = Math.max(y1, fy1);
  }
  const fwMax = Math.max(...faceBoxes(faces).map((bx) => (bx[2] - bx[0]) * W));
  return [0, Math.max(0, Math.floor(y0 - fwMax * 0.5)), W, Math.min(H, Math.ceil(y1 + fwMax * 0.5))];
}
