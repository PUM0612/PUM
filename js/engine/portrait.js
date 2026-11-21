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
// biến đổi khoảng cách Euclid (bình phương) — Felzenszwalb
function edt(mask, w, h, target) {      // khoảng cách tới điểm có mask == target
  const INF = 1e20, f = new Float64Array(Math.max(w, h)), d = new Float64Array(w * h);
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1), out = new Float64Array(Math.max(w, h));
  const pass = (n, get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
    for (let q = 0; q < n; q++) set(q, out[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => (mask[y * w + x] === target ? 0 : INF), (y, val) => { d[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (x) => d[y * w + x], (x, val) => { d[y * w + x] = val; });
  return d;
}
function dil(m, w, h, r) {
  r = Math.max(1, r); const rr = r <= 4 ? Math.round(r) : r;
  const d = edt(m, w, h, 1), o = new Uint8Array(w * h);
  for (let i = 0; i < o.length; i++) o[i] = d[i] <= rr * rr + 1e-9 ? 1 : 0;
  return o;
}
function ero(m, w, h, r) {
  r = Math.max(1, r); const rr = r <= 4 ? Math.round(r) : r;
  const d = edt(m, w, h, 0), o = new Uint8Array(w * h);
  for (let i = 0; i < o.length; i++) o[i] = d[i] > rr * rr + 1e-9 ? 1 : 0;
  return o;
}
const and = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] && b[i] ? 1 : 0; return o; };
const or = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] || b[i] ? 1 : 0; return o; };
const not = (a) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ? 0 : 1; return o; };
const any = (a) => { for (let i = 0; i < a.length; i++) if (a[i]) return true; return false; };
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
function pct(vals, q) { return cv.percentile(vals, q); }
const median = (v) => cv.percentile(v, 50);

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

function fillSpots(reg, mask, fw, texShift = true, srcok = null) {
  const { w: W, h: H } = reg;
  const { n, lab, stats } = components(mask, W, H);
  if (n <= 1) return reg;
  const out = { w: W, h: H, c: 3, d: Float32Array.from(reg.d) };
  const rb = blur3(reg, Math.max(0.6, fw * 0.0028));
  const hp = new Float32Array(reg.d.length); for (let i = 0; i < hp.length; i++) hp[i] = reg.d[i] - rb.d[i];
  for (let i = 1; i < n; i++) {
    const [x, y, w, h] = stats[i];
    const mg = Math.trunc(Math.max(3, 0.8 * Math.max(w, h)));
    const xa = Math.max(0, x - mg), ya = Math.max(0, y - mg), xb = Math.min(W, x + w + mg), yb = Math.min(H, y + h + mg);
    const cw = xb - xa, chh = yb - ya;
    const ins = new Uint8Array(cw * chh);
    for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) ins[yy * cw + xx] = lab[(yy + ya) * W + xx + xa] === i ? 1 : 0;
    const crop = sub3(out, xa, ya, xb, yb);
    const dt = edt(ins, cw, chh, 0);
    let mx = 0; for (let q = 0; q < dt.length; q++) if (ins[q]) mx = Math.max(mx, Math.sqrt(dt[q]));
    const thick = 2 * mx;
    let fill;
    if (thick <= 40) {
      const outm = new Float32Array(cw * chh); for (let q = 0; q < outm.length; q++) outm[q] = ins[q] ? 0 : 1;
      const sg = Math.max(1, 0.6 * thick);
      const num = { w: cw, h: chh, c: 3, d: new Float32Array(cw * chh * 3) };
      for (let q = 0; q < outm.length; q++) for (let k = 0; k < 3; k++) num.d[q * 3 + k] = crop.d[q * 3 + k] * outm[q];
      const nb = cv.gaussianBlur(num, sg).d, db = cv.gaussianBlur(cv.img1(cw, chh, outm), sg).d;
      fill = { w: cw, h: chh, c: 3, d: Float32Array.from(crop.d) };
      for (let q = 0; q < outm.length; q++) if (ins[q]) for (let k = 0; k < 3; k++) fill.d[q * 3 + k] = nb[q * 3 + k] / Math.max(db[q], 1e-4);
    } else fill = laplaceFill(crop, ins);
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

function spotMask(Y, Cr, skin, w, h, fw, amount, lightToo = false, skinlike = null) {
  const s1 = Math.max(0.6, fw * 0.004), s2 = Math.max(2, fw * 0.025);
  const Yb2 = blur1(Y, w, h, s2), Yb1 = blur1(Y, w, h, s1), Cb1 = blur1(Cr, w, h, s1), Cb2 = blur1(Cr, w, h, s2);
  const n = w * h, dark = new Float32Array(n), red = new Float32Array(n);
  for (let i = 0; i < n; i++) { dark[i] = Yb2[i] - Yb1[i]; red[i] = Cb1[i] - Cb2[i]; }
  const sk = []; for (let i = 0; i < n; i++) if (skin[i] > 0.5) sk.push(i);
  if (sk.length < 50) return new Uint8Array(n);
  const zf = (a) => { const v = sk.map((i) => a[i]); const med = median(v); const mad = median(v.map((x) => Math.abs(x - med))) * 1.48 + 1e-5; return [med, mad]; };
  const [md, ad] = zf(dark), [mr, ar] = zf(red);
  const thr = 4.2 - 2.4 * amount;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!(skin[i] > 0.5)) continue;
    let sc = Math.max((dark[i] - md) / ad, 0.8 * (red[i] - mr) / ar);
    if (lightToo) sc = Math.max(sc, (-dark[i] + md) / ad);
    if (sc > thr) m[i] = 1;
  }
  const { n: nc, lab, stats } = components(m, w, h);
  const maxd = fw * (0.03 + 0.05 * amount);
  const keep = new Uint8Array(nc);
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
      let rs = 0, rk = 0, rn = 0, drop = 0, cn = 0;
      for (let q = 0; q < ring.length; q++) {
        const gi = (Math.floor(q / cw) + ya) * w + (q % cw) + xa;
        if (ring[q]) { rs += skinlike[gi]; rk += skin[gi] > 0.5 ? 1 : 0; rn++; }
        if (comp[q]) { drop += Yb2[gi] - Y[gi]; cn++; }
      }
      if (!rn || rs / rn < 0.45) continue;
      if (rk / rn < 0.9) continue;
      if (cn && drop / cn > 0.22) continue;
    }
    keep[i] = 1;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = keep[lab[i]];
  return dil(out, w, h, Math.max(1, fw * 0.005));
}

// hình thái với nhân ellipse k x k (blackhat / tophat)
function morph(Y, w, h, k, op) {
  const r = (k - 1) / 2, offs = [];
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if ((i * i + j * j) <= (r + 0.5) ** 2) offs.push(j * w + i, i, j);
  const run = (src, fn, init) => {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = init;
      for (let q = 0; q < offs.length; q += 3) {
        let xx = x + offs[q + 1], yy = y + offs[q + 2];
        if (xx < 0) xx = -xx; else if (xx >= w) xx = 2 * w - 2 - xx;
        if (yy < 0) yy = -yy; else if (yy >= h) yy = 2 * h - 2 - yy;
        v = fn(v, src[yy * w + xx]);
      }
      o[y * w + x] = v;
    }
    return o;
  };
  const er = (s) => run(s, Math.min, Infinity), di = (s) => run(s, Math.max, -Infinity);
  const out = new Float32Array(w * h);
  if (op === 'black') { const c = er(di(Y)); for (let i = 0; i < out.length; i++) out[i] = c[i] - Y[i]; }
  else { const o = di(er(Y)); for (let i = 0; i < out.length; i++) out[i] = Y[i] - o[i]; }
  return out;
}

function elongated(m, w, h, minRatio, minLen) {
  const { n, lab, stats } = components(m, w, h), keep = new Uint8Array(n);
  for (let i = 1; i < n; i++) { const [, , bw, bh, area] = stats[i]; const L = Math.hypot(bw, bh); if (L >= minLen && L * L / Math.max(1, area) >= minRatio * 2) keep[i] = 1; }
  const o = new Uint8Array(w * h); for (let i = 0; i < o.length; i++) o[i] = keep[lab[i]]; return o;
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
  const a = amount, kl = [0.45 * a, 0.9 * a, 0.9 * a], km = [0.55 * a, 0.7 * a, 0.7 * a];
  const nw = { w, h, c: 3, d: new Float32Array(n * 3) };
  for (let i = 0; i < n; i++) {
    const k = mask[i] * ea[i];
    for (let c = 0; c < 3; c++) {
      const j = i * 3 + c, hf = y.d[j] - lo1[j], mid = lo1[j] - lo2[j], low = lo2[j] - lo3[j];
      nw.d[j] = lo3[j] + low * (1 - k * kl[c]) + mid * (1 - k * km[c]) + hf * (1 + k * (texture * 0.8));
    }
  }
  return rgb(nw);
}

// ---------------------------------------------------------------------------- từng khuôn mặt
function processFace(out, lm, p, imp, prot, person, W, H, ox, oy) {
  const w = out.w, h = out.h;
  const P = (i) => [lm[i * 2] * W - ox, lm[i * 2 + 1] * H - oy];
  const fw = Math.hypot(P(234)[0] - P(454)[0], P(234)[1] - P(454)[1]);
  if (fw < 24) return null;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const i of OVAL) { const [x, y] = P(i); mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
  const lx = Math.max(0, -ox), ly = Math.max(0, -oy), hx = Math.min(w, W - ox), hy = Math.min(h, H - oy);
  const x0 = Math.trunc(Math.max(lx, mnx - 0.45 * fw)), x1 = Math.trunc(Math.min(hx, mxx + 0.45 * fw));
  const y0 = Math.trunc(Math.max(ly, mny - 0.6 * fw)), y1 = Math.trunc(Math.min(hy, mxy + 0.95 * fw));
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
    reg = fillSpots(reg, m, fw, true, skinOk());
  }
  // 2) sợi tóc vương trên da
  const hi = (p.hair_inner || 0) / 100 * imp;
  if (hi > 0) {
    const Y = ch(ycc(reg), 0);
    const k = Math.max(3, Math.trunc(fw * 0.009) | 1);
    const bh = morph(Y, sw, sh, k, 'black');
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
      const dist = edt(cand, sw, sh, 0);
      const keep = new Uint8Array(nc);
      for (let i = 1; i < nc; i++) {
        const [x, y, bw2, bh2, area] = stats[i];
        const L_ = Math.hypot(bw2, bh2);
        if (L_ < fw * 0.07) continue;
        let mx = 0; for (let yy = y; yy < y + bh2; yy++) for (let xx = x; xx < x + bw2; xx++) if (lab[yy * sw + xx] === i) mx = Math.max(mx, Math.sqrt(dist[yy * sw + xx]));
        if (2 * mx > Math.max(2.5, fw * 0.008) || L_ * L_ / Math.max(1, area) < 12) continue;
        keep[i] = 1;
      }
      const km = new Uint8Array(n); for (let i = 0; i < n; i++) km[i] = keep[lab[i]];
      const fsk = new Uint8Array(n); for (let i = 0; i < n; i++) fsk[i] = faceSkin[i] > 0.5 ? 1 : 0;
      reg = fillSpots(reg, dil(km, sw, sh, 1), fw, true, fsk);
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
    const kk = Math.trunc(0.05 * fw) | 1, rk = (kk - 1) / 2;
    const solid = rk >= 1 ? dil(ero(pm2, sw, sh, rk), sw, sh, rk) : pm2;
    const band = and(dil(solid, sw, sh, 0.12 * fw), not(ero(solid, sw, sh, 0.005 * fw)));
    const chinY = Math.trunc(Q(152)[1]);
    for (let y = Math.max(0, chinY); y < sh; y++) for (let x = 0; x < sw; x++) band[y * sw + x] = 0;
    const Y = ch(ycc(reg), 0);
    const k = Math.max(3, Math.trunc(fw * 0.02) | 1);
    const b1 = morph(Y, sw, sh, k, 'black'), t1 = morph(Y, sw, sh, k, 'top');
    const thin = new Float32Array(n); for (let i = 0; i < n; i++) thin[i] = Math.max(b1[i], t1[i]);
    const v = []; for (let i = 0; i < n; i++) if (band[i]) v.push(thin[i]);
    if (v.length > 50) {
      const med = median(v), t = med + (6 - 3.5 * ho) * (median(v.map((x) => Math.abs(x - med))) * 1.48 + 1e-5);
      const c0 = new Uint8Array(n); for (let i = 0; i < n; i++) c0[i] = thin[i] > t && band[i] && !solid[i] ? 1 : 0;
      const m = elongated(c0, sw, sh, 2.5, Math.max(5, fw * 0.02));
      for (let i = 0; i < n; i++) if (pr[i] >= 0.5) m[i] = 0;
      reg = fillSpots(reg, dil(m, sw, sh, 1), fw, false);
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
    const y = ycc(out), Y = ch(y, 0);
    const a = blur1(Y, w, h, Math.max(1, fw * 0.012)), b = blur1(Y, w, h, Math.max(4, fw * 0.09));
    for (let i = 0; i < n; i++) y.d[i * 3] -= (a[i] - b[i]) * cm[i] * wr * 0.8;
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
export function applyPortrait(img, p, faces, personFn, roi) {
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
  if (!infos.length) { for (let i = 0; i < out.d.length; i++) out.d[i] = clamp01(out.d[i]); return out; }
  const fw = Math.max(...infos.map((f) => f.fw));
  const samples = infos.flatMap((f) => f.samples);
  const skin = skinLike(ycc(out), samples);
  let faceM = new Uint8Array(n);
  for (const f of infos) {
    const [x0, y0] = f.box;
    for (let y = 0; y < f.sh; y++) for (let x = 0; x < f.sw; x++) if (f.oval[y * f.sw + x]) faceM[(y + y0) * w + x + x0] = 1;
  }
  const faceSoft = soft(dil(faceM, w, h, fw * 0.25), w, h, fw * 0.05);
  let pm = person;
  if (who !== 'all' && pm) {
    const f = infos[0], cols = new Uint8Array(n);
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
    const chin = Math.trunc(Math.min(...infos.map((f) => f.chinY)) + 0.12 * fw);
    const sk35 = new Uint8Array(n); for (let i = 0; i < n; i++) sk35[i] = skin[i] > 0.35 ? 1 : 0;
    const ss = soft(sk35, w, h, fw * 0.01);
    const cm0 = new Uint8Array(n);
    for (let y = Math.min(h, Math.max(0, chin)); y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; cm0[i] = clamp01(pm[i] * (1 - ss[i]) * protK(i)) > 0.5 ? 1 : 0; }
    const cm = soft(ero(cm0, w, h, fw * 0.01), w, h, fw * 0.01);
    out = clothes(out, cm, fw, p, imp);
  }
  for (const i of sel) out = reshapeFace(out, faces[i], p, imp, W, H, ox, oy);
  const bs = (p.body_slim || 0) / 100 * imp;
  if (bs > 0 && pm) out = slimBody(out, pm, Math.min(...infos.map((f) => f.chinY)), fw, bs, oy);
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
