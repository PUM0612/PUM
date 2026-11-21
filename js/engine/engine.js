// Bộ dựng ảnh PUM cho iPhone — chép đúng công thức và thứ tự các bước của engine.py (PUM máy tính).
// Ảnh: { w, h, c: 3, d: Float32Array RGB 0..1 xen kẽ }.
import * as cv from './cv.js';
import { BANDS, SKIN_HUE, mergeSettings, defaultSettings, cropRatio, lensActive, layerActive } from './settings.js';
import { applyRetouch } from './retouch.js';
import { layerMask } from './layers.js';

const clip01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const pmod = (a, n) => ((a % n) + n) % n;
const hueDist = (H, c) => pmod(H - c + 180, 360) - 180;
export { smooth, hueDist };

export function lum(im) {
  const n = im.w * im.h, L = new Float32Array(n), d = im.d;
  for (let i = 0, j = 0; i < n; i++, j += 3) L[i] = d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
  return cv.img1(im.w, im.h, L);
}

// engine._blur: Gaussian, sigma lớn thì thu nhỏ để nhanh
export function blur(x, sigma) {
  if (sigma < 0.3) return x;
  if (sigma > 10) {
    const f = sigma / 5.0;
    const sw = Math.max(1, Math.trunc(x.w / f)), sh = Math.max(1, Math.trunc(x.h / f));
    let small = cv.resizeArea(x, sw, sh);
    small = cv.gaussianBlur(small, sigma / f);
    return cv.resizeLinear(small, x.w, x.h);
  }
  return cv.gaussianBlur(x, sigma);
}

function guided(p, r, eps) {
  r = Math.max(1, Math.trunc(r));
  const n = p.d.length;
  const pp = cv.img1(p.w, p.h); pp.c = p.c; pp.d = new Float32Array(n);
  for (let i = 0; i < n; i++) pp.d[i] = p.d[i] * p.d[i];
  const m = cv.boxBlur(p, r), mm = cv.boxBlur(pp, r);
  const a = { w: p.w, h: p.h, c: p.c, d: new Float32Array(n) }, b = { w: p.w, h: p.h, c: p.c, d: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const v = mm.d[i] - m.d[i] * m.d[i];
    const ai = v / (v + eps);
    a.d[i] = ai; b.d[i] = m.d[i] - ai * m.d[i];
  }
  const ma = cv.boxBlur(a, r), mb = cv.boxBlur(b, r);
  const out = { w: p.w, h: p.h, c: p.c, d: new Float32Array(n) };
  for (let i = 0; i < n; i++) out.d[i] = ma.d[i] * p.d[i] + mb.d[i];
  return out;
}
export { guided };

// ---------------------------------------------------------------------------- đường cong
export function curveLut(points, n = 1024) {
  const pts = points.map(([x, y]) => [+x, +y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const xs = [], ys = [];
  for (const [x, y] of pts) {
    if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-4) { ys[ys.length - 1] = y; continue; }
    xs.push(x); ys.push(y);
  }
  if (xs.length < 2) return null;
  const lut = new Float32Array(n);
  const N = xs.length;
  if (N === 2) {
    if (Math.abs(xs[0]) < 1e-6 && Math.abs(ys[0]) < 1e-6 && Math.abs(xs[1] - 1) < 1e-6 && Math.abs(ys[1] - 1) < 1e-6) return null;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      let y;
      if (x <= xs[0]) y = ys[0]; else if (x >= xs[1]) y = ys[1];
      else y = ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / (xs[1] - xs[0]);
      lut[i] = clip01(y);
    }
    return lut;
  }
  const d = [], m = new Float64Array(N);
  for (let i = 0; i < N - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[N - 1] = d[N - 2];
  for (let i = 1; i < N - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < d.length; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; }
    else {
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
  }
  for (let q = 0; q < n; q++) {
    const x = q / (n - 1);
    // np.searchsorted(xs, x) - 1 (bên trái)
    let lo = 0, hi = N;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
    let idx = Math.min(Math.max(lo - 1, 0), N - 2);
    const h = xs[idx + 1] - xs[idx], t = (x - xs[idx]) / h, t2 = t * t, t3 = t2 * t;
    let y = (2 * t3 - 3 * t2 + 1) * ys[idx] + (t3 - 2 * t2 + t) * h * m[idx] +
      (-2 * t3 + 3 * t2) * ys[idx + 1] + (t3 - t2) * h * m[idx + 1];
    if (x < xs[0]) y = ys[0];
    if (x > xs[N - 1]) y = ys[N - 1];
    lut[q] = clip01(y);
  }
  return lut;
}
function lutAt(lut, x) {
  const n = lut.length;
  let i = Math.trunc(x * (n - 1) + 0.5);
  if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
  return lut[i];
}

// ---------------------------------------------------------------------------- cân bằng trắng, calibration
export function wbFromPixel(rgb) {
  const [r, g, b] = rgb.map((v) => Math.max(1e-4, +v));
  const temp = 200 * Math.log(b / r);
  const tint = -500 * Math.log(Math.sqrt(r * b) / g);
  const c = (v) => Math.max(-100, Math.min(100, v));
  return [c(temp), c(tint)];
}

export function resizeMax(im, maxSide) {
  const m = Math.max(im.w, im.h);
  if (maxSide && m > maxSide) {
    const f = maxSide / m;
    return cv.resizeArea(im, Math.max(1, Math.round(im.w * f)), Math.max(1, Math.round(im.h * f)));
  }
  return im;
}

export function autoWb(img) {
  const small = resizeMax(img, 600);
  const n = small.w * small.h, d = small.d;
  const lab = new Float32Array(3);
  const Ls = new Float32Array(n), chroma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cv.rgb2lab(clip01(d[i * 3]), clip01(d[i * 3 + 1]), clip01(d[i * 3 + 2]), lab);
    Ls[i] = lab[0]; chroma[i] = Math.hypot(lab[1], lab[2]);
  }
  const okIdx = [];
  for (let i = 0; i < n; i++) if (Ls[i] > 22 && Ls[i] < 96) okIdx.push(i);
  const thr = okIdx.length ? Math.min(10, cv.percentile(okIdx.map((i) => chroma[i]), 25)) : 10;
  let keep = okIdx.filter((i) => chroma[i] < Math.max(thr, 4));
  let damp = 1.0;
  if (keep.length < Math.max(50, 0.015 * n)) {
    keep = okIdx.length ? okIdx : Array.from({ length: n }, (_, i) => i);
    damp = 0.35;
  }
  const mean = [0, 0, 0];
  for (const i of keep) { mean[0] += clip01(d[i * 3]); mean[1] += clip01(d[i * 3 + 1]); mean[2] += clip01(d[i * 3 + 2]); }
  for (let c = 0; c < 3; c++) mean[c] /= keep.length;
  const [t, tn] = wbFromPixel(mean);
  return [Math.max(-60, Math.min(60, t * damp)), Math.max(-40, Math.min(40, tn * damp))];
}

export function calibMatrix(cal) {
  const a = 1 / Math.sqrt(3);
  const K = [[0, -a, a], [a, 0, -a], [-a, a, 0]];
  const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  const KK = mul(K, K);
  const cols = [];
  ['red', 'green', 'blue'].forEach((name, i) => {
    const e = [0, 0, 0]; e[i] = 1;
    const th = ((cal[name + '_hue'] || 0) / 100) * 30 * Math.PI / 180;
    const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? 1 : 0) + Math.sin(th) * K[r][c] + (1 - Math.cos(th)) * KK[r][c]));
    const k = Math.max(0, 1 + (cal[name + '_sat'] || 0) / 100 * 0.7);
    const v = [0, 1, 2].map((r) => e[r] - 1 / 3);
    const Rv = [0, 1, 2].map((r) => R[r][0] * v[0] + R[r][1] * v[1] + R[r][2] * v[2]);
    cols.push(Rv.map((x) => 1 / 3 + k * x));
  });
  const M = [0, 1, 2].map((r) => [cols[0][r], cols[1][r], cols[2][r]]);
  for (let r = 0; r < 3; r++) { const s = M[r][0] + M[r][1] + M[r][2]; for (let c = 0; c < 3; c++) M[r][c] += (1 - s) / 3; }
  return M.map((r) => r.map((v) => Math.fround(v)));
}

function calibrate(img, cal) {
  const d = img.d, n = img.w * img.h;
  if (['red', 'green', 'blue'].some((nm) => Math.abs(cal[nm + '_hue'] || 0) > 1e-6 || Math.abs(cal[nm + '_sat'] || 0) > 1e-6)) {
    const M = calibMatrix(cal);
    for (let i = 0; i < n * 3; i += 3) {
      const r = Math.pow(Math.max(d[i], 0), 2.2), g = Math.pow(Math.max(d[i + 1], 0), 2.2), b = Math.pow(Math.max(d[i + 2], 0), 2.2);
      d[i] = Math.pow(Math.max(M[0][0] * r + M[0][1] * g + M[0][2] * b, 0), 1 / 2.2);
      d[i + 1] = Math.pow(Math.max(M[1][0] * r + M[1][1] * g + M[1][2] * b, 0), 1 / 2.2);
      d[i + 2] = Math.pow(Math.max(M[2][0] * r + M[2][1] * g + M[2][2] * b, 0), 1 / 2.2);
    }
  }
  const st = (cal.shadow_tint || 0) / 100;
  if (st) {
    for (let i = 0; i < n * 3; i += 3) {
      const L = clip01(d[i]) * 0.2126 + clip01(d[i + 1]) * 0.7152 + clip01(d[i + 2]) * 0.0722;
      const w = Math.pow(1 - smooth(0, 0.55, L), 2) * st * 0.07;
      d[i] += w * 0.6; d[i + 1] -= w; d[i + 2] += w * 0.6;
    }
  }
}

export function autoTone(img) {
  const L = lum(resizeMax(img, 800)).d;
  const med = cv.median(L);
  const exp = Math.max(-2, Math.min(2, 0.75 * Math.log2(0.40 / Math.max(med, 1e-3))));
  const k = Math.pow(2, exp);
  const Le = new Float32Array(L.length);
  let clip = 0, shad = 0;
  for (let i = 0; i < L.length; i++) {
    Le[i] = Math.min(4, Math.max(0, L[i] * k));
    if (Le[i] > 0.95) clip++;
    if (Le[i] < 0.12) shad++;
  }
  const p99 = cv.percentile(Le, 99.5), p01 = cv.percentile(Le, 0.5);
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const whites = cl((0.97 - p99) / 0.3 * 100, -45, 45);
  const blacks = cl(-(p01 - 0.02) / 0.1 * 100, -40, 40);
  const highlights = cl(-(clip / L.length) * 400, -70, 0);
  const shadows = cl((shad / L.length) * 150, 0, 50);
  return { exposure: Math.round(exp * 100) / 100, whites: Math.round(whites), blacks: Math.round(blacks),
    highlights: Math.round(highlights), shadows: Math.round(shadows) };
}

// ---------------------------------------------------------------------------- _tone
export function tone(img, s) {
  const d = img.d, n = img.w * img.h, N = n * 3;
  const t = s.temp / 100, tn = s.tint / 100;
  if (t || tn) {
    const mul = [Math.exp(0.25 * t), Math.exp(-0.2 * tn), Math.exp(-0.25 * t)].map(Math.fround);
    const den = mul[0] * 0.2126 + mul[1] * 0.7152 + mul[2] * 0.0722;
    for (let c = 0; c < 3; c++) mul[c] = Math.fround(mul[c] / den);
    for (let i = 0; i < N; i += 3) { d[i] *= mul[0]; d[i + 1] *= mul[1]; d[i + 2] *= mul[2]; }
  }
  const cal = s.calib;
  if (cal && Object.values(cal).some((v) => Math.abs(v) > 1e-6)) calibrate(img, cal);
  if (s.exposure) { const k = Math.pow(2, s.exposure); for (let i = 0; i < N; i++) d[i] *= k; }
  const refW = s._ref_w || img.w;
  const dz = s.dehaze / 100;
  if (dz > 0) {
    const mn = cv.img1(img.w, img.h);
    for (let i = 0, j = 0; i < n; i++, j += 3) mn.d[i] = Math.min(d[j], d[j + 1], d[j + 2]);
    const dark = blur(mn, refW * 0.02).d;
    const k = 0.85 * dz;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const kd = k * dark[i], den = Math.max(1 - kd, 0.2);
      d[j] = (d[j] - kd) / den; d[j + 1] = (d[j + 1] - kd) / den; d[j + 2] = (d[j + 2] - kd) / den;
    }
  } else if (dz < 0) {
    const k = -dz * 0.35;
    for (let i = 0; i < N; i++) d[i] = d[i] + (0.75 - d[i]) * k;
  }
  const hl = s.highlights / 100, sh = s.shadows / 100;
  if (hl || sh) {
    const L = cv.img1(img.w, img.h);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const r = Math.min(4, Math.max(0, d[j])), g = Math.min(4, Math.max(0, d[j + 1])), b = Math.min(4, Math.max(0, d[j + 2]));
      L.d[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
    }
    const Bl = blur(L, refW * 0.012).d;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const lb = Bl[i] * 0.6 + L.d[i] * 0.4;
      let f = 1;
      if (sh) { const m = Math.pow(1 - smooth(0, 0.55, lb), 2); f *= 1 + sh * 1.3 * m; }
      if (hl) { f *= 1 + hl * 0.55 * smooth(0.45, 1.0, lb); }
      d[j] *= f; d[j + 1] *= f; d[j + 2] *= f;
    }
  }
  const wh = s.whites / 100, bl = s.blacks / 100;
  if (wh || bl) {
    const wp = 1 - wh * 0.3, bp = -bl * 0.08, den = Math.max(wp - bp, 0.05);
    for (let i = 0; i < N; i++) d[i] = (d[i] - bp) / den;
  }
  for (let i = 0; i < N; i++) {
    let v = d[i];
    if (v > 0.9) v = 0.9 + 0.1 * Math.tanh((v - 0.9) / 0.1);
    d[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  const c = s.contrast / 100;
  if (c) {
    if (c > 0) { const k = c * 1.4; for (let i = 0; i < N; i++) { const x = d[i]; d[i] = clip01(x + (x * x * (3 - 2 * x) - x) * k); } }
    else { const k = c * 0.6; for (let i = 0; i < N; i++) { const x = d[i]; d[i] = clip01(x + (x - 0.5) * k); } }
  }
  const br = (s.brightness || 0) / 100;
  if (br) {
    const gamma = Math.pow(2, -0.85 * br), lut = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) lut[i] = Math.pow(Math.fround(i / 1023), gamma);
    for (let i = 0; i < N; i++) d[i] = lutAt(lut, d[i]);
  }
  const cl = s.clarity / 100;
  if (cl) {
    const L = lum(img), Bl = blur(L, refW * 0.01).d;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const l = L.d[i], add = (l - Bl[i]) * cl * 1.2 * (0.3 + 0.7 * 4 * l * (1 - l));
      d[j] = clip01(d[j] + add); d[j + 1] = clip01(d[j + 1] + add); d[j + 2] = clip01(d[j + 2] + add);
    }
  }
  const cvs = s.curve || {};
  const lut = curveLut(cvs.rgb || [[0, 0], [1, 1]]);
  if (lut) for (let i = 0; i < N; i++) d[i] = lutAt(lut, d[i]);
  ['r', 'g', 'b'].forEach((ch, ci) => {
    const l2 = curveLut(cvs[ch] || [[0, 0], [1, 1]]);
    if (l2) for (let i = ci; i < N; i += 3) d[i] = lutAt(l2, d[i]);
  });
  return img;
}

// ---------------------------------------------------------------------------- _color
let _bandLuts = null;
export function color(img, s) {
  const col = s.color, skin = s.skin;
  const bandsOn = Object.values(col).some((v) => v.some((x) => Math.abs(x) > 1e-6));
  const skinOn = Object.values(skin).some((v) => Math.abs(v) > 1e-6);
  const vib = s.vibrance / 100;
  const d = img.d, n = img.w * img.h;
  if (bandsOn || skinOn || vib) {
    const H = new Float32Array(n), S = new Float32Array(n), V = new Float32Array(n), CH = new Float32Array(n);
    const t = new Float32Array(3);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      cv.rgb2hsv(clip01(d[j]), clip01(d[j + 1]), clip01(d[j + 2]), t);
      H[i] = t[0]; S[i] = t[1]; V[i] = t[2]; CH[i] = smooth(0.03, 0.2, t[1]);
    }
    const hidx = (h) => { let k = Math.trunc(h * 4); return k < 0 ? 0 : k > 1439 ? 1439 : k; };
    if (bandsOn) {
      const den = new Float32Array(1440), lh = new Float32Array(1440), ls = new Float32Array(1440), ll = new Float32Array(1440);
      for (let q = 0; q < 1440; q++) {
        const hq = q / 4;
        for (const [key, , center] of BANDS) {
          const w = Math.exp(-Math.pow(hueDist(hq, center) / 22, 2));
          den[q] += w; lh[q] += w * col[key][0]; ls[q] += w * col[key][1]; ll[q] += w * col[key][2];
        }
        const dd = Math.max(den[q], 1e-6);
        lh[q] /= dd; ls[q] /= dd; ll[q] /= dd;
      }
      for (let i = 0; i < n; i++) {
        const k = hidx(H[i]), c = CH[i];
        const nh = lh[k] * c, ns = ls[k] * c, nl = ll[k] * c;
        H[i] = pmod(H[i] + nh * 0.3, 360);
        S[i] = S[i] * Math.min(3, Math.max(0, 1 + ns / 100));
        V[i] = V[i] * (1 + nl / 100 * 0.5 * S[i]);
      }
    }
    let SW = null, HD = null;
    if (skinOn || vib) {
      SW = new Float32Array(n); HD = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const q = hidx(H[i]);
        const hd = hueDist(q / 4, SKIN_HUE);
        HD[i] = hd;
        SW[i] = Math.exp(-Math.pow(hd / 18, 2)) * smooth(0.08, 0.2, S[i]) * (1 - smooth(0.75, 0.95, S[i])) * smooth(0.1, 0.25, V[i]);
      }
    }
    if (skinOn) {
      let hc, sc;
      if (s._skin_stats) [hc, sc] = s._skin_stats;
      else {
        let tot = 0, sh = 0, ss = 0;
        for (let i = 0; i < n; i++) { tot += SW[i]; sh += SW[i] * HD[i]; ss += SW[i] * S[i]; }
        if (tot > 1) { hc = SKIN_HUE + sh / tot; sc = ss / tot; } else { hc = SKIN_HUE; sc = 0.4; }
        if (s._skin_stats_out) s._skin_stats_out.push([hc, sc]);
      }
      if (skin.uni_hue) { const k = skin.uni_hue / 100; for (let i = 0; i < n; i++) H[i] = pmod(H[i] + hueDist(hc, H[i]) * k * SW[i], 360); }
      if (skin.uni_sat) { const k = skin.uni_sat / 100; for (let i = 0; i < n; i++) S[i] = S[i] + (sc - S[i]) * k * SW[i]; }
      if (skin.uni_lum) {
        const w = s._ref_w || img.w;
        const Vi = cv.img1(img.w, img.h, V);
        const a = blur(Vi, Math.max(0.8, w * 0.002)).d, b = blur(Vi, w * 0.02).d;
        const k = skin.uni_lum / 100;
        for (let i = 0; i < n; i++) V[i] = V[i] - (a[i] - b[i]) * k * SW[i];
      }
      if (skin.hue) for (let i = 0; i < n; i++) H[i] = pmod(H[i] + skin.hue * 0.2 * SW[i], 360);
      if (skin.sat) for (let i = 0; i < n; i++) S[i] = S[i] * (1 + skin.sat / 100 * SW[i]);
      if (skin.lum) for (let i = 0; i < n; i++) V[i] = V[i] * (1 + skin.lum / 100 * 0.4 * SW[i]);
    }
    if (vib) {
      if (vib > 0) for (let i = 0; i < n; i++) S[i] = S[i] * (1 + vib * (1 - S[i]) * (1 - 0.6 * SW[i]));
      else for (let i = 0; i < n; i++) S[i] = S[i] * (1 + vib * (1 - S[i] * 0.5));
    }
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      cv.hsv2rgb(H[i], Math.fround(clip01(S[i])), Math.fround(clip01(V[i])), t);
      d[j] = t[0]; d[j + 1] = t[1]; d[j + 2] = t[2];
    }
  }
  const sat = s.saturation / 100;
  if (sat) {
    for (let j = 0; j < n * 3; j += 3) {
      const L = d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
      d[j] = L + (d[j] - L) * (1 + sat); d[j + 1] = L + (d[j + 1] - L) * (1 + sat); d[j + 2] = L + (d[j + 2] - L) * (1 + sat);
    }
  }
  for (let i = 0; i < n * 3; i++) d[i] = clip01(d[i]);
  return img;
}

// ---------------------------------------------------------------------------- _grading
export function hueRgb(hue) {
  // colorsys.hsv_to_rgb((hue%360)/360, 1, 1) rồi trừ độ sáng
  const h = pmod(hue, 360) / 360;
  const i = Math.trunc(h * 6), f = h * 6 - i, q = 1 - f, t = f;
  const tab = [[1, t, 0], [q, 1, 0], [0, 1, t], [0, q, 1], [t, 0, 1], [1, 0, q]][i % 6];
  const c = tab.map(Math.fround);
  const l = Math.fround(c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
  return c.map((v) => v - l);
}

export function grading(img, g) {
  const zones = ['shadows', 'midtones', 'highlights', 'global'];
  if (!zones.some((z) => g[z][1] || g[z][2])) return img;
  const d = img.d, n = img.w * img.h;
  const bal = g.balance / 100, blend = g.blend / 100;
  const ps = 0.3 + bal * 0.2, ph = 0.7 + bal * 0.2, wd = 0.1 + 0.3 * blend;
  const adds = zones.map((z) => {
    const [hue, sat, l] = g[z];
    if (!(sat || l)) return null;
    let add = [0, 0, 0];
    if (sat) add = hueRgb(hue).map((v) => Math.fround(v * (sat / 100) * 0.35));
    return add.map((v) => Math.fround(v + l / 100 * 0.25));
  });
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const L = d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
    const ws = 1 - smooth(ps - wd, ps + wd, L), wh = smooth(ph - wd, ph + wd, L);
    const wm = clip01(1 - ws - wh);
    const wts = [ws, wm, wh, 1];
    let r = d[j], gg = d[j + 1], b = d[j + 2];
    for (let z = 0; z < 4; z++) {
      const a = adds[z]; if (!a) continue;
      const w = wts[z];
      r += w * a[0]; gg += w * a[1]; b += w * a[2];
    }
    d[j] = clip01(r); d[j + 1] = clip01(gg); d[j + 2] = clip01(b);
  }
  return img;
}

// ---------------------------------------------------------------------------- chi tiết
export function noiseSigma(Y) {
  let sm = Y;
  if (Math.max(Y.w, Y.h) > 1600) {
    const w2 = Math.ceil(Y.w / 2), h2 = Math.ceil(Y.h / 2), d = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) d[y * w2 + x] = Y.d[(y * 2) * Y.w + x * 2];
    sm = cv.img1(w2, h2, d);
  }
  const b = cv.gaussianBlur(sm, 1.0).d;
  const hp = new Float32Array(sm.d.length);
  for (let i = 0; i < hp.length; i++) hp[i] = sm.d[i] - b[i];
  const med = cv.median(hp);
  for (let i = 0; i < hp.length; i++) hp[i] = Math.abs(hp[i] - med);
  return Math.max(1e-4, 1.70 * cv.median(hp));
}

function guidedBy(I, p, r, eps) {
  const n = I.d.length;
  const ip = new Float32Array(n), ii = new Float32Array(n);
  for (let i = 0; i < n; i++) { ip[i] = I.d[i] * p.d[i]; ii[i] = I.d[i] * I.d[i]; }
  const mk = (d) => cv.img1(I.w, I.h, d);
  const mI = cv.boxBlur(I, r).d, mp = cv.boxBlur(p, r).d, mIp = cv.boxBlur(mk(ip), r).d, mII = cv.boxBlur(mk(ii), r).d;
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cIp = mIp[i] - mI[i] * mp[i], vI = mII[i] - mI[i] * mI[i];
    a[i] = cIp / (vI + eps); b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = cv.boxBlur(mk(a), r).d, mb = cv.boxBlur(mk(b), r).d;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ma[i] * I.d[i] + mb[i];
  return mk(out);
}

// Khử nhiễu độ sáng: PUM máy tính dùng Non-Local Means (quá nặng cho iPhone) —
// ở đây dùng lọc dẫn hướng giữ cạnh với cùng mức lọc h tự canh theo độ nhiễu đo được.
function nrLuminance(Y, amount, detail, contrast, sigma) {
  const sig = (sigma || noiseSigma(Y)) * 255;
  const h = Math.max(0.6, Math.min(60, sig * (0.5 + 2.1 * amount) * (1.2 - 0.75 * detail)));
  const eps = Math.pow(h / 255, 2) * 0.55;
  let den = guided(Y, 3, eps);
  if (contrast > 0) {
    const diff = cv.img1(Y.w, Y.h);
    for (let i = 0; i < diff.d.length; i++) diff.d[i] = Y.d[i] - den.d[i];
    const bd = cv.gaussianBlur(diff, 0.9).d;
    for (let i = 0; i < bd.length; i++) den.d[i] += contrast * 0.55 * bd[i];
  }
  const k = Math.min(1, amount * 1.6);
  const out = cv.img1(Y.w, Y.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = Y.d[i] + (den.d[i] - Y.d[i]) * k;
  return out;
}

function nrColor(Y, Cs, amount, detail, sm, w) {
  const r = Math.max(1, Math.round(w * (0.0015 + 0.006 * amount)));
  const eps = 2e-4 + 2e-3 * amount;
  const k = Math.min(1, amount * 2);
  return Cs.map((c) => {
    let cs = guidedBy(Y, c, r, eps);
    for (let i = 0; i < cs.d.length; i++) cs.d[i] = cs.d[i] + (c.d[i] - cs.d[i]) * (detail * 0.45);
    if (sm > 0) {
      const R = Math.max(2, Math.round(w * (0.006 + 0.012 * sm)));
      const big = guidedBy(Y, cs, R, eps * 4);
      const kk = sm * 0.7 * Math.min(1, amount * 2);
      for (let i = 0; i < cs.d.length; i++) cs.d[i] = cs.d[i] + (big.d[i] - cs.d[i]) * kk;
    }
    const out = cv.img1(c.w, c.h);
    for (let i = 0; i < out.d.length; i++) out.d[i] = c.d[i] + (cs.d[i] - c.d[i]) * k;
    return out;
  });
}

export function detail(img, s, scale) {
  const nrl = s.nr_lum / 100, nrc = s.nr_color / 100, shp = s.sharpen / 100;
  if (!(nrl || nrc || shp)) return img;
  const n = img.w * img.h, d = img.d;
  let Y = cv.img1(img.w, img.h), Cr = cv.img1(img.w, img.h), Cb = cv.img1(img.w, img.h);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    Y.d[i] = y; Cr.d[i] = (d[j] - y) * 0.713 + 0.5; Cb.d[i] = (d[j + 2] - y) * 0.564 + 0.5;
  }
  if (nrl) Y = nrLuminance(Y, nrl, (s.nr_lum_detail ?? 50) / 100, (s.nr_lum_contrast ?? 0) / 100, s._noise_sigma);
  if (nrc) [Cr, Cb] = nrColor(Y, [Cr, Cb], nrc, (s.nr_color_detail ?? 50) / 100, (s.nr_color_smooth ?? 50) / 100, s._ref_w || img.w);
  if (shp) {
    const rad = Math.max(0.4, s.sharpen_radius * Math.max(scale, 0.35));
    const b = cv.gaussianBlur(Y, rad).d;
    for (let i = 0; i < n; i++) Y.d[i] = Y.d[i] + (Y.d[i] - b[i]) * shp * 1.5;
  }
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const y = Y.d[i], cr = Cr.d[i] - 0.5, cb = Cb.d[i] - 0.5;
    d[j] = clip01(y + 1.403 * cr); d[j + 1] = clip01(y - 0.714 * cr - 0.344 * cb); d[j + 2] = clip01(y + 1.773 * cb);
  }
  return img;
}

export function texture(img, amount, w) {
  if (!amount) return img;
  const L = lum(img), B = blur(L, Math.max(0.8, w * 0.0015)).d, d = img.d;
  const k = amount / 100 * 1.2;
  for (let i = 0, j = 0; i < L.d.length; i++, j += 3) {
    const a = (L.d[i] - B[i]) * k;
    d[j] = clip01(d[j] + a); d[j + 1] = clip01(d[j + 1] + a); d[j + 2] = clip01(d[j + 2] + a);
  }
  return img;
}

function roiGrid(img, roi) {
  if (roi) return roi;              // [x0, y0, W, H]
  return [0, 0, img.w, img.h];
}

export function vignette(img, s, roi) {
  const v = s.vignette / 100;
  if (!v) return img;
  const [x0, y0, w, h] = roiGrid(img, roi), d = img.d;
  for (let y = 0; y < img.h; y++) {
    const yy = (y + y0 - h / 2) / (h / 2);
    for (let x = 0; x < img.w; x++) {
      const xx = (x + x0 - w / 2) / (w / 2);
      const m = smooth(0.35, 1.05, Math.sqrt(xx * xx + yy * yy) / Math.SQRT2);
      const j = (y * img.w + x) * 3;
      if (v < 0) { const f = 1 + v * 0.85 * m; d[j] *= f; d[j + 1] *= f; d[j + 2] *= f; }
      else { const k = v * 0.7 * m; d[j] += (1 - d[j]) * k; d[j + 1] += (1 - d[j + 1]) * k; d[j + 2] += (1 - d[j + 2]) * k; }
    }
  }
  return img;
}

export function vigCorr(img, s, roi) {
  const v = s.lens.vig_corr / 100;
  if (!v) return img;
  const [x0, y0, w, h] = roiGrid(img, roi), d = img.d;
  const den = (w / 2) ** 2 + (h / 2) ** 2;
  for (let y = 0; y < img.h; y++) {
    const dy = (y + y0 - h / 2) ** 2;
    for (let x = 0; x < img.w; x++) {
      const r2 = Math.fround(((x + x0 - w / 2) ** 2 + dy) / den);
      const f = 1 + v * 0.8 * r2, j = (y * img.w + x) * 3;
      d[j] *= f; d[j + 1] *= f; d[j + 2] *= f;
    }
  }
  return img;
}

// Hạt phim: nhiễu Gauss có hạt giống cố định (không trùng từng hạt với bản máy tính — chỉ cùng thống kê)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; };
}
export function grain(img, s, scale, roi) {
  const g = s.grain / 100;
  if (!g) return img;
  const n = img.w * img.h;
  const rnd = rng(roi ? 12345 + Math.trunc(roi[1]) * 7919 + Math.trunc(roi[0]) : 12345);
  let noise = cv.img1(img.w, img.h);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(rnd(), 1e-12), v = rnd(), r = Math.sqrt(-2 * Math.log(u));
    noise.d[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) noise.d[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  const sig = Math.max(0, (0.4 + s.grain_size / 100 * 2.5) * Math.max(scale, 0.25) - 0.3);
  if (sig > 0.3) {
    noise = cv.gaussianBlur(noise, sig);
    let m = 0, q = 0;
    for (let i = 0; i < n; i++) { m += noise.d[i]; q += noise.d[i] * noise.d[i]; }
    m /= n; const sd = Math.sqrt(Math.max(q / n - m * m, 0));
    for (let i = 0; i < n; i++) noise.d[i] /= Math.max(1e-6, sd);
  }
  const d = img.d;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const L = d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
    const a = noise.d[i] * g * 0.09 * (0.35 + 4 * L * (1 - L));
    d[j] = clip01(d[j] + a); d[j + 1] = clip01(d[j + 1] + a); d[j + 2] = clip01(d[j + 2] + a);
  }
  return img;
}

// ---------------------------------------------------------------------------- hình học
export function perspectiveTransform(src, dst) {
  // giải hệ 8 ẩn (cv2.getPerspectiveTransform)
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); B.push(v);
  }
  const h = solve(A, B);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}
export function solve(A, B) {
  const n = B.length, M = A.map((r, i) => [...r, B[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / pv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
export function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
export const mul3 = (A, B) => A.map((r, i) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));

// toạ độ nguồn cho các điểm (xs, ys) sau bước ống kính (engine._lens_coords); sửa tại chỗ
export function lensCoords(L, w, h, xs, ys) {
  const dist = L.distortion / 100, car = L.ca_red / 100, cab = L.ca_blue / 100;
  const pv = L.persp_v / 100, ph = L.persp_h / 100, sc = L.scale / 100;
  const sk = (L.skew || 0) / 100, asp = (L.aspect || 0) / 100;
  const kmat = L.kmat, kam = (L.kamount ?? 100) / 100;
  const cx = (w - 1) / 2, cy = (h - 1) / 2, n = xs.length;
  for (let i = 0; i < n; i++) { xs[i] = cx + (xs[i] - cx) / sc; ys[i] = cy + (ys[i] - cy) / sc; }
  if (pv || ph || sk || asp) {
    const a = Math.abs(pv) * 0.3 * w, b = Math.abs(ph) * 0.3 * h;
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const q = src.map((p) => p.slice());
    if (pv > 0) { q[0][0] += a; q[1][0] -= a; } else if (pv < 0) { q[3][0] += a; q[2][0] -= a; }
    if (ph > 0) { q[1][1] += b; q[2][1] -= b; } else if (ph < 0) { q[0][1] += b; q[3][1] -= b; }
    if (sk) { const s_ = sk * 0.15 * w; q[0][0] += s_; q[1][0] += s_; q[2][0] -= s_; q[3][0] -= s_; }
    if (asp > 0) for (const p of q) p[1] = cy + (p[1] - cy) * (1 - 0.25 * asp);
    else if (asp < 0) for (const p of q) p[0] = cx + (p[0] - cx) * (1 + 0.25 * asp);
    const M = perspectiveTransform(src, q).map((r) => r.map(Math.fround));
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i], den = M[2][0] * x + M[2][1] * y + M[2][2];
      xs[i] = (M[0][0] * x + M[0][1] * y + M[0][2]) / den; ys[i] = (M[1][0] * x + M[1][1] * y + M[1][2]) / den;
    }
  }
  if (kmat && kam) {
    const A = w / h;
    const Hb = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? 1 : 0) + kam * (kmat[r][c] - (r === c ? 1 : 0))));
    for (let i = 0; i < n; i++) {
      const u = xs[i] / w * A, v = ys[i] / h, den = Hb[2][0] * u + Hb[2][1] * v + Hb[2][2];
      xs[i] = (Hb[0][0] * u + Hb[0][1] * v + Hb[0][2]) / den / A * w; ys[i] = (Hb[1][0] * u + Hb[1][1] * v + Hb[1][2]) / den * h;
    }
  }
  if (dist) {
    const R = Math.hypot(cx, cy);
    for (let i = 0; i < n; i++) {
      const dx = (xs[i] - cx) / R, dy = (ys[i] - cy) / R, f = 1 - dist * 0.25 * (dx * dx + dy * dy);
      xs[i] = cx + dx * f * R; ys[i] = cy + dy * f * R;
    }
  }
  return (car || cab) ? [1 + car * 0.004, 1 + cab * 0.004] : null;
}

function lens(img, L) {
  if (!lensActive(L)) return img;
  const { w, h } = img, n = w * h;
  const xs = new Float32Array(n), ys = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { xs[y * w + x] = x; ys[y * w + x] = y; }
  const ca = lensCoords(L, w, h, xs, ys);
  if (ca) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2, out = cv.img3(w, h);
    [[0, ca[0]], [1, 1.0], [2, ca[1]]].forEach(([ch, f]) => {
      const mx = new Float32Array(n), my = new Float32Array(n);
      for (let i = 0; i < n; i++) { mx[i] = cx + (xs[i] - cx) * f; my[i] = cy + (ys[i] - cy) * f; }
      const r = cv.remapLinear(img, mx, my, w, h, ch).d;
      for (let i = 0; i < n; i++) out.d[i * 3 + ch] = r[i];
    });
    return out;
  }
  return cv.remapLinear(img, xs, ys, w, h);
}

function rot90cw(img, k) {
  let im = img;
  for (let t = 0; t < k; t++) {
    const { w, h, d } = im, out = cv.img3(h, w);
    for (let y = 0; y < w; y++) for (let x = 0; x < h; x++) {
      const s = ((h - 1 - x) * w + y) * 3, o = (y * h + x) * 3;
      out.d[o] = d[s]; out.d[o + 1] = d[s + 1]; out.d[o + 2] = d[s + 2];
    }
    im = out;
  }
  return im;
}
function flip(img, fl) {
  const { w, h, d } = img, out = cv.img3(w, h);
  const fh = fl === 'h' || fl === 'hv', fv = fl === 'v' || fl === 'hv';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((fv ? h - 1 - y : y) * w + (fh ? w - 1 - x : x)) * 3, o = (y * w + x) * 3;
    out.d[o] = d[s]; out.d[o + 1] = d[s + 1]; out.d[o + 2] = d[s + 2];
  }
  return out;
}
export function rotMatrix(cx, cy, angDeg) {   // cv2.getRotationMatrix2D(center, angle, 1)
  const a = angDeg * Math.PI / 180, al = Math.cos(a), be = Math.sin(a);
  return [[al, be, (1 - al) * cx - be * cy], [-be, al, be * cx + (1 - al) * cy], [0, 0, 1]];
}
function crop(img, x0, y0, cw, ch) {
  const out = cv.img3(cw, ch);
  for (let y = 0; y < ch; y++) out.d.set(img.d.subarray(((y + y0) * img.w + x0) * 3, ((y + y0) * img.w + x0 + cw) * 3), y * cw * 3);
  return out;
}

export function geometry(img, s, doCrop = true) {
  img = lens(img, s.lens);
  const k = pmod(Math.trunc((s.rotate || 0) / 90), 4);
  if (k) img = rot90cw(img, k);
  const fl = s.flip || 'none';
  if (fl !== 'none') img = flip(img, fl);
  const ang = +(s.straighten || 0);
  if (Math.abs(ang) > 0.01) {
    const { w, h } = img;
    const M = inv3(rotMatrix(w / 2, h / 2, -ang));
    const th = Math.abs(ang) * Math.PI / 180;
    const sc = Math.min(w / (w * Math.cos(th) + h * Math.sin(th)), h / (w * Math.sin(th) + h * Math.cos(th)));
    const cw = Math.trunc(w * sc), ch = Math.trunc(h * sc);
    const x0 = Math.floor((w - cw) / 2), y0 = Math.floor((h - ch) / 2);
    const n = cw * ch, mx = new Float32Array(n), my = new Float32Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const X = x + x0, Y = y + y0, i = y * cw + x;
      mx[i] = M[0][0] * X + M[0][1] * Y + M[0][2]; my[i] = M[1][0] * X + M[1][1] * Y + M[1][2];
    }
    img = cv.remapLinear(img, mx, my, cw, ch);
  }
  if (!doCrop) return img;
  const cr = s.crop_rect, ratio = cropRatio(s.crop || 'orig');
  if (cr) {
    const { w, h } = img;
    const x0 = Math.round(cr[0] * w), y0 = Math.round(cr[1] * h), x1 = Math.round(cr[2] * w), y1 = Math.round(cr[3] * h);
    if (x1 - x0 > 4 && y1 - y0 > 4) {
      if (s.crop_outside && (x0 < 0 || y0 < 0 || x1 > w || y1 > h)) {
        const out = cv.img3(x1 - x0, y1 - y0);
        const sx0 = Math.max(0, x0), sy0 = Math.max(0, y0), sx1 = Math.min(w, x1), sy1 = Math.min(h, y1);
        for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
          const o = ((y - y0) * (x1 - x0) + (x - x0)) * 3, si = (y * w + x) * 3;
          out.d[o] = img.d[si]; out.d[o + 1] = img.d[si + 1]; out.d[o + 2] = img.d[si + 2];
        }
        img = out;
      } else {
        const a = Math.max(0, x0), b = Math.max(0, y0);
        img = crop(img, a, b, Math.min(w, x1) - a, Math.min(h, y1) - b);
      }
    }
  } else if (ratio) {
    const { w, h } = img;
    if (w / h > ratio) { const nw = Math.trunc(h * ratio); img = crop(img, Math.floor((w - nw) / 2), 0, nw, h); }
    else { const nh = Math.trunc(w / ratio); img = crop(img, 0, Math.floor((h - nh) / 2), w, nh); }
  }
  return img;
}

// engine.geometry_affine: ma trận toạ độ nguồn (w x h) -> ảnh ra của _geometry, kích thước ra, vùng hợp lệ
export function geometryAffine(w, h, s, doCrop = true) {
  let M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let cw = w, ch = h, valid = null;
  const k = pmod(Math.trunc((s.rotate || 0) / 90), 4);
  if (k === 1) { M = mul3([[0, -1, h - 1], [1, 0, 0], [0, 0, 1]], M); cw = h; ch = w; }
  else if (k === 2) M = mul3([[-1, 0, w - 1], [0, -1, h - 1], [0, 0, 1]], M);
  else if (k === 3) { M = mul3([[0, 1, 0], [-1, 0, w - 1], [0, 0, 1]], M); cw = h; ch = w; }
  const fl = s.flip || 'none';
  if (fl === 'h' || fl === 'hv') M = mul3([[-1, 0, cw - 1], [0, 1, 0], [0, 0, 1]], M);
  if (fl === 'v' || fl === 'hv') M = mul3([[1, 0, 0], [0, -1, ch - 1], [0, 0, 1]], M);
  const ang = +(s.straighten || 0);
  if (Math.abs(ang) > 0.01) {
    const Rm = rotMatrix(cw / 2, ch / 2, -ang);
    const th = Math.abs(ang) * Math.PI / 180;
    const sc = Math.min(cw / (cw * Math.cos(th) + ch * Math.sin(th)), ch / (cw * Math.sin(th) + ch * Math.cos(th)));
    const nw = Math.trunc(cw * sc), nh = Math.trunc(ch * sc);
    const x0 = Math.floor((Math.trunc(cw) - nw) / 2), y0 = Math.floor((Math.trunc(ch) - nh) / 2);
    M = mul3(mul3([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], Rm), M);
    cw = nw; ch = nh;
  }
  if (doCrop) {
    cw = Math.trunc(cw); ch = Math.trunc(ch);
    const cr = s.crop_rect, ratio = cropRatio(s.crop || 'orig');
    if (cr) {
      let x0 = Math.round(cr[0] * cw), y0 = Math.round(cr[1] * ch), x1 = Math.round(cr[2] * cw), y1 = Math.round(cr[3] * ch);
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        if (s.crop_outside && (x0 < 0 || y0 < 0 || x1 > cw || y1 > ch))
          valid = [Math.max(0, x0) - x0, Math.max(0, y0) - y0, Math.min(cw, x1) - x0, Math.min(ch, y1) - y0];
        else { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(cw, x1); y1 = Math.min(ch, y1); }
        M = mul3([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], M);
        cw = x1 - x0; ch = y1 - y0;
      }
    } else if (ratio) {
      if (cw / ch > ratio) { const nw = Math.trunc(ch * ratio); M = mul3([[1, 0, -Math.floor((cw - nw) / 2)], [0, 1, 0], [0, 0, 1]], M); cw = nw; }
      else { const nh = Math.trunc(cw / ratio); M = mul3([[1, 0, 0], [0, 1, -Math.floor((ch - nh) / 2)], [0, 0, 1]], M); ch = nh; }
    }
  }
  return { M, w: Math.trunc(cw), h: Math.trunc(ch), valid };
}

// engine.keystone_from_guides: từ các đường lẽ ra thẳng đứng ('v') / nằm ngang ('h') tính ma trận NGHỊCH
// (toạ độ ra -> toạ độ nguồn) trong hệ (x*A, y); A = rộng / cao. Trả null nếu chưa đủ 4 điểm.
export function keystoneFromGuides(guides, A) {
  const src = [], dst = [];
  for (const g of guides) {
    const [x0, y0, x1, y1] = g.p;
    const P0 = [x0 * A, y0], P1 = [x1 * A, y1];
    if (g.o === 'v') { const xm = (P0[0] + P1[0]) / 2; dst.push([xm, P0[1]], [xm, P1[1]]); }
    else { const ym = (P0[1] + P1[1]) / 2; dst.push([P0[0], ym], [P1[0], ym]); }
    src.push(P0, P1);
  }
  if (src.length < 4) return null;
  let H;
  if (src.length === 4) H = perspectiveTransform(src, dst);
  else {
    // bình phương tối thiểu (DLT, h33 = 1)
    const N = Array.from({ length: 8 }, () => new Array(8).fill(0)), b = new Array(8).fill(0);
    for (let i = 0; i < src.length; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -x * u, -y * u], u], [[0, 0, 0, x, y, 1, -x * v, -y * v], v]]) {
        for (let r = 0; r < 8; r++) { b[r] += row[r] * rhs; for (let c = 0; c < 8; c++) N[r][c] += row[r] * row[c]; }
      }
    }
    let h = solve(N, b);
    // tinh chỉnh theo sai số chiếu lại (Levenberg–Marquardt) như cv2.findHomography
    const resid = (hh) => {
      const r = [];
      for (let i = 0; i < src.length; i++) {
        const [x, y] = src[i], w = hh[6] * x + hh[7] * y + 1;
        r.push((hh[0] * x + hh[1] * y + hh[2]) / w - dst[i][0], (hh[3] * x + hh[4] * y + hh[5]) / w - dst[i][1]);
      }
      return r;
    };
    const cost = (r) => r.reduce((s, v) => s + v * v, 0);
    let lam = 1e-3, r0 = resid(h), c0 = cost(r0);
    for (let it = 0; it < 60; it++) {
      const Jt = [];
      for (let k = 0; k < 8; k++) {
        const e = Math.max(1e-8, Math.abs(h[k]) * 1e-6), hp = h.slice(); hp[k] += e;
        const rp = resid(hp); Jt.push(rp.map((v, i) => (v - r0[i]) / e));
      }
      const A2 = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => Jt[i].reduce((s, v, q) => s + v * Jt[j][q], 0) * (i === j ? 1 + lam : 1)));
      const g = Jt.map((row) => -row.reduce((s, v, q) => s + v * r0[q], 0));
      const dh = solve(A2, g), hn = h.map((v, i) => v + dh[i]);
      const rn = resid(hn), cn = cost(rn);
      if (cn < c0) { h = hn; r0 = rn; lam *= 0.3; if (c0 - cn < 1e-16) { c0 = cn; break; } c0 = cn; } else lam *= 10;
    }
    H = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  }
  const c = [A / 2, 0.5, 1];
  const hc = [0, 1, 2].map((r) => H[r][0] * c[0] + H[r][1] * c[1] + H[r][2] * c[2]);
  const T = [[1, 0, c[0] - hc[0] / hc[2]], [0, 1, c[1] - hc[1] / hc[2]], [0, 0, 1]];
  const Hi = inv3(mul3(T, H));
  return Hi.map((r) => r.map((v) => v / Hi[2][2]));
}

export const layerMaskFor =(img, ly, ctx) => layerMask(img, ly, ctx, null);

// Kích thước ảnh ra sau khung (để vẽ khung cắt trên ảnh chưa cắt)
export function geometrySize(w, h, s, doCrop = true) {
  let cw = w, ch = h;
  const k = pmod(Math.trunc((s.rotate || 0) / 90), 4);
  if (k % 2) [cw, ch] = [ch, cw];
  const ang = +(s.straighten || 0);
  if (Math.abs(ang) > 0.01) {
    const th = Math.abs(ang) * Math.PI / 180;
    const sc = Math.min(cw / (cw * Math.cos(th) + ch * Math.sin(th)), ch / (cw * Math.sin(th) + ch * Math.cos(th)));
    cw = Math.trunc(cw * sc); ch = Math.trunc(ch * sc);
  }
  return [cw, ch];
}

// ---------------------------------------------------------------------------- layer
export function applyLayers(img, s, ctx) {
  const refW = s._ref_w || img.w;
  (s.layers || []).forEach((ly, i) => {
    if (!layerActive(ly)) return;
    const m = layerMask(img, ly, ctx, ctx && ctx.layer_shapes ? ctx.layer_shapes[i] : null, refW);
    let mx = 0;
    for (let q = 0; q < m.d.length; q++) if (m.d[q] > mx) { mx = m.d[q]; break; }
    if (mx <= 0) return;
    const ls = defaultSettings();
    for (const [k, v] of Object.entries(ly.adj)) ls[k] = v;
    ls._ref_w = refW;
    let adj = tone(cv.clone(img), ls);
    if (ls.saturation) adj = color(adj, ls);
    adj = texture(adj, ls.texture, refW);
    const d = img.d, a = adj.d;
    for (let q = 0, j = 0; q < m.d.length; q++, j += 3) {
      const t = m.d[q];
      if (!t) continue;
      d[j] += (a[j] - d[j]) * t; d[j + 1] += (a[j + 1] - d[j + 1]) * t; d[j + 2] += (a[j + 2] - d[j + 2]) * t;
    }
  });
  return img;
}

// ---------------------------------------------------------------------------- dựng
export function adjustA(img, s, ctx) {
  const roi = ctx && ctx.roi;
  img = vigCorr(img, s, roi);
  img = tone(img, s);
  img = color(img, s);
  img = grading(img, s.grading);
  return applyLayers(img, s, ctx);
}
export function adjustB(img, s, scale, roi) {
  img = detail(img, s, scale);
  img = texture(img, s.texture, s._ref_w || img.w);
  img = vignette(img, s, roi);
  img = grain(img, s, scale, roi);
  const d = img.d;
  for (let i = 0; i < d.length; i++) d[i] = clip01(d[i]);
  return img;
}

// render_adjust; img bị sửa tại chỗ (truyền bản sao nếu cần giữ)
export function renderAdjust(img, s, scale = 1.0, geom = true, ctx = null) {
  if (ctx && ctx.roi) { s = Object.assign({}, s, { _ref_w: ctx.roi[2] }); if (ctx.skin_stats) s._skin_stats = ctx.skin_stats; }
  img = adjustA(img, s, ctx);
  img = adjustB(img, s, scale, ctx && ctx.roi);
  if (geom) img = geometry(img, s, geom === true);
  return img;
}

export function render(base, settings, scale = 1.0, geom = true, ctx = null) {
  const s = mergeSettings(settings);
  let img = applyRetouch(cv.clone(base), s.retouch, ctx);
  return renderAdjust(img, s, scale, geom, ctx);
}

// lề cần dựng thêm khi dựng theo dải (engine.roi_margin)
export function roiMargin(s, W, stage) {
  let sig = 3.0;
  if (!stage || stage === 'a') {
    const adjs = [s, ...(s.layers || []).filter(layerActive).map((l) => l.adj)];
    for (const d of adjs) {
      if ((d.dehaze || 0) > 0) sig = Math.max(sig, 0.02 * W);
      if (d.highlights || d.shadows) sig = Math.max(sig, 0.012 * W);
      if (d.clarity) sig = Math.max(sig, 0.01 * W);
      if (d.texture) sig = Math.max(sig, 0.0015 * W);
    }
    if (s.skin && s.skin.uni_lum) sig = Math.max(sig, 0.02 * W);
  }
  if (!stage || stage === 'b') {
    if (s.nr_color) {
      const a = s.nr_color / 100, sm = (s.nr_color_smooth ?? 50) / 100;
      sig = Math.max(sig, W * (0.0015 + 0.006 * a), sm > 0 ? W * (0.006 + 0.012 * sm) : 0);
    }
    if (s.nr_lum) sig = Math.max(sig, 6.0);
    if (s.sharpen) sig = Math.max(sig, 3 * (s.sharpen_radius || 1));
    if (s.texture) sig = Math.max(sig, 0.0015 * W);
    if (s.grain) sig = Math.max(sig, 4.0);
  }
  return Math.trunc(Math.min(2.5 * sig, 0.06 * W)) + 6;
}

export { cv };
