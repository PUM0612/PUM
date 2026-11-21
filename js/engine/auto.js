// Nút Auto cho từng nhóm chỉnh — chép theo autoadj.py của PUM máy tính.
// autoSection(key, img, s, ctx) -> { up: [[đường dẫn, giá trị], ...], msg }
import * as E from './engine.js';
import { BANDS, SKIN_HUE } from './settings.js';

const cv = E.cv;
const clip = (v, a, b) => Math.max(a, Math.min(b, v));
const c01 = (v) => clip(v, 0, 1);
const TONE_KEYS = ['exposure', 'contrast', 'brightness', 'highlights', 'shadows', 'whites', 'blacks'];
const small = (img, n = 700) => E.resizeMax(img, n);
const zero = (s, keys) => { const s2 = Object.assign({}, s); for (const k of keys) s2[k] = 0; return s2; };
const preColor = (img, s) => E.tone(E.vigCorr(cv.clone(img), s), s);
const preGrading = (img, s) => E.color(preColor(img, s), s);
const final = (img, s) => E.grading(preGrading(img, s), s.grading);
const sgn = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d);
const R = (v) => Math.round(v);

function hsvOf(img) {
  const n = img.w * img.h, H = new Float32Array(n), S = new Float32Array(n), V = new Float32Array(n), t = new Float32Array(3);
  for (let i = 0; i < n; i++) { cv.rgb2hsv(c01(img.d[i * 3]), c01(img.d[i * 3 + 1]), c01(img.d[i * 3 + 2]), t); H[i] = t[0]; S[i] = t[1]; V[i] = t[2]; }
  return { H, S, V, n };
}
function std(a) { let m = 0; for (const v of a) m += v; m /= a.length; let q = 0; for (const v of a) q += (v - m) ** 2; return Math.sqrt(q / a.length); }

function autoColor(img, s) {
  const sm = small(img);
  const [t, tn] = E.autoWb(sm);
  const s2 = zero(Object.assign({}, s, { temp: t, tint: tn }), ['vibrance', 'saturation']);
  const { S, V, n } = hsvOf(preColor(sm, s2));
  let sum = 0, c = 0;
  for (let i = 0; i < n; i++) if (V[i] > 0.12) { sum += S[i]; c++; }
  const m = c ? sum / c : 0.3;
  const vib = clip((0.32 - m) / 0.32 * 70, -15, 35);
  return { up: [[['temp'], Math.round(t * 10) / 10], [['tint'], Math.round(tn * 10) / 10], [['vibrance'], R(vib)], [['saturation'], 0]],
    msg: `Cân bằng trắng ${sgn(t)} / ${sgn(tn)}, Vibrance ${sgn(vib)}` };
}

function autoTone(img, s) {
  const sm = small(img);
  const s0 = zero(s, [...TONE_KEYS, 'clarity', 'dehaze']);
  const d = E.autoTone(preColor(sm, s0));
  const s1 = Object.assign({}, s0, d);
  const st = std(E.lum(preColor(sm, s1)).d);
  d.contrast = R(clip((0.22 - st) / 0.22 * 90, -25, 35));
  d.brightness = 0;
  return { up: Object.entries(d).map(([k, v]) => [[k], v]),
    msg: `Phơi sáng ${sgn(d.exposure, 2)}, tương phản ${sgn(d.contrast)}, sáng ${sgn(d.highlights)}, tối ${sgn(d.shadows)}, trắng ${sgn(d.whites)}, đen ${sgn(d.blacks)}` };
}

function erode(d, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity; for (let k = -r; k <= r; k++) { const xx = Math.min(w - 1, Math.max(0, x + k)); m = Math.min(m, d[y * w + xx]); } t[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity; for (let k = -r; k <= r; k++) { const yy = Math.min(h - 1, Math.max(0, y + k)); m = Math.min(m, t[yy * w + x]); } o[y * w + x] = m;
  }
  return o;
}

function autoPresence(img, s) {
  const sm = small(img);
  const s0 = zero(s, ['clarity', 'dehaze', 'texture']);
  const x = preColor(sm, s0);
  const n = x.w * x.h, mn = new Float32Array(n);
  for (let i = 0; i < n; i++) mn[i] = Math.min(c01(x.d[i * 3]), c01(x.d[i * 3 + 1]), c01(x.d[i * 3 + 2]));
  const haze = cv.percentile(erode(mn, x.w, x.h, 4), 50);
  const dehaze = clip((haze - 0.10) * 220, 0, 40);
  const L = E.lum(x);
  const B = cv.gaussianBlur(L, Math.max(2, L.w * 0.01)).d;
  let det = 0; for (let i = 0; i < n; i++) det += Math.abs(L.d[i] - B[i]); det /= n;
  const clarity = clip((0.05 - det) / 0.05 * 40, -10, 30);
  const noise = E.noiseSigma(E.lum(preColor(img, s0)));
  const tex = clip(15 - noise * 255 * 4, -10, 15);
  return { up: [[['dehaze'], R(dehaze)], [['clarity'], R(clarity)], [['texture'], R(tex)]],
    msg: `Khử sương ${sgn(dehaze)}, Clarity ${sgn(clarity)}, Texture ${sgn(tex)}` };
}

function autoHsl(img, s) {
  const sm = small(img);
  const col = {}; for (const k of Object.keys(s.color)) col[k] = [0, 0, 0];
  const { H, S, V, n } = hsvOf(preColor(sm, Object.assign({}, s, { color: col })));
  const up = [], notes = [];
  for (const [key, name, center] of BANDS) {
    let ws = 0, wS = 0, wV = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.exp(-Math.pow(E.hueDist(H[i], center) / 22, 2)) * E.smooth(0.06, 0.2, S[i]) * (V[i] > 0.08 ? 1 : 0);
      ws += w; wS += w * S[i]; wV += w * V[i];
    }
    for (let i = 0; i < 3; i++) up.push([['color', key, i], 0]);
    if (ws / n < 0.02) continue;
    const ms = wS / Math.max(ws, 1e-6), mv = wV / Math.max(ws, 1e-6);
    const ds = key === 'orange' ? clip((0.38 - ms) * 50, -12, 8) : clip((0.45 - ms) / 0.45 * 30, -25, 20);
    up.push([['color', key, 1], R(ds)]);
    if (key === 'blue' && mv > 0.55) up.push([['color', key, 2], -8]);
    if (Math.abs(ds) >= 3) notes.push(`${name} ${sgn(ds)}`);
  }
  return { up, msg: notes.length ? 'Bão hoà theo dải: ' + notes.join(', ') : 'Màu từng dải đã cân, không cần chỉnh' };
}

function autoSkin(img, s) {
  const { H, S, V, n } = hsvOf(preColor(small(img), s));
  let c = 0;
  for (let i = 0; i < n; i++) {
    const sw = Math.exp(-Math.pow(E.hueDist(H[i], SKIN_HUE) / 18, 2)) * E.smooth(0.08, 0.2, S[i]) * (1 - E.smooth(0.75, 0.95, S[i])) * E.smooth(0.1, 0.25, V[i]);
    if (sw > 0.5) c++;
  }
  const keys = ['hue', 'sat', 'lum', 'uni_hue', 'uni_sat', 'uni_lum'];
  const up = keys.map((k) => [['skin', k], 0]);
  if (c / n < 0.005) return { up, msg: 'Không thấy vùng da đủ lớn trong ảnh — giữ nguyên' };
  up.push([['skin', 'uni_hue'], 35], [['skin', 'uni_sat'], 25], [['skin', 'uni_lum'], 15]);
  return { up, msg: 'Đồng nhất màu da: sắc độ 35, bão hoà 25, độ sáng 15' };
}

function autoCalib(img, s) {
  const cal = {}; for (const k of Object.keys(s.calib)) cal[k] = 0;
  const x = preColor(small(img), Object.assign({}, s, { calib: cal }));
  const n = x.w * x.h, lab = new Float32Array(3);
  const up = Object.keys(s.calib).map((k) => [['calib', k], 0]);
  let cnt = 0, r = 0, g = 0, b = 0, wsh = 0;
  for (let i = 0; i < n; i++) {
    const R_ = c01(x.d[i * 3]), G = c01(x.d[i * 3 + 1]), B = c01(x.d[i * 3 + 2]);
    const L = R_ * 0.2126 + G * 0.7152 + B * 0.0722;
    if (!(L > 0.03 && L < 0.3)) continue;
    cv.rgb2lab(R_, G, B, lab);
    if (Math.hypot(lab[1], lab[2]) >= 12) continue;
    cnt++; r += R_; g += G; b += B; wsh += Math.pow(1 - E.smooth(0, 0.55, L), 2);
  }
  if (cnt < 100) return { up, msg: 'Ít vùng tối để đo — đặt Calibration về trung tính' };
  r /= cnt; g /= cnt; b /= cnt; wsh /= cnt;
  const dev = g - (r + b) / 2;
  if (Math.abs(dev) < 0.004) return { up, msg: 'Vùng tối không ám màu đáng kể — Calibration về trung tính' };
  const st = clip(dev / (0.112 * Math.max(wsh, 0.1)) * 100 * 0.6, -25, 25);
  up.push([['calib', 'shadow_tint'], R(st)]);
  return { up, msg: `Tint vùng tối ${sgn(st)} (trung hoà ám xanh lá / hồng ở vùng tối)` };
}

function rgbToHue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  let h;
  if (mx === r) h = (g - b) / d; else if (mx === g) h = 2 + (b - r) / d; else h = 4 + (r - g) / d;
  return ((h / 6) % 1 + 1) % 1;
}

function autoGrading(img, s) {
  const g0 = Object.assign({}, s.grading);
  for (const z of ['shadows', 'midtones', 'highlights', 'global']) g0[z] = [0, 0, 0];
  const x = preGrading(small(img), Object.assign({}, s, { grading: g0 }));
  const n = x.w * x.h, up = [], notes = [];
  for (const [z, lo, hi, name] of [['shadows', 0.03, 0.3, 'tối'], ['midtones', 0.3, 0.7, 'trung tính'], ['highlights', 0.7, 0.97, 'sáng']]) {
    up.push([['grading', z, 0], 0], [['grading', z, 1], 0], [['grading', z, 2], 0]);
    let c = 0; const d = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = c01(x.d[i * 3]), g = c01(x.d[i * 3 + 1]), b = c01(x.d[i * 3 + 2]), L = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (L > lo && L < hi) { c++; d[0] += r - L; d[1] += g - L; d[2] += b - L; }
    }
    if (c < 200) continue;
    for (let k = 0; k < 3; k++) d[k] /= c;
    const mag = Math.hypot(...d);
    if (mag < 0.006) continue;
    const opp = d.map((v) => c01(0.5 - v / mag * 0.5));
    const hue = rgbToHue(...opp) * 360;
    const ref = Math.hypot(...E.hueRgb(hue));
    const sat = clip(mag / (0.35 * Math.max(ref, 1e-3)) * 100 * 0.8, 0, 35);
    up.push([['grading', z, 0], R(hue)], [['grading', z, 1], R(sat)]);
    notes.push(`${name}: ${R(hue)}° / ${R(sat)}`);
  }
  up.push([['grading', 'global', 0], 0], [['grading', 'global', 1], 0], [['grading', 'global', 2], 0]);
  return { up, msg: notes.length ? 'Trung hoà ám màu — ' + notes.join(', ') : 'Không thấy ám màu đáng kể' };
}

function autoCurve(img, s) {
  const s0 = Object.assign({}, s, { curve: Object.assign({}, s.curve, { rgb: [[0, 0], [1, 1]] }) });
  const x = final(small(img), s0);
  const L = E.lum(x).d.map(c01);
  let lo = cv.percentile(L, 0.3), hi = cv.percentile(L, 99.7);
  lo = Math.min(Math.max(lo, 0), 0.12); hi = Math.max(Math.min(hi, 1), 0.85);
  const span = hi - lo, r3 = (v) => Math.round(v * 1000) / 1000;
  const pts = [[r3(lo), 0], [r3(lo + span * 0.25), 0.22], [r3(lo + span * 0.75), 0.78], [r3(hi), 1]];
  return { up: [[['curve', 'rgb'], pts]], msg: `Đường cong RGB: điểm đen ${lo.toFixed(2)}, điểm trắng ${hi.toFixed(2)}, thêm chữ S nhẹ` };
}

function autoLayer(img, s, ctx) {
  const i = ctx.layer ?? -1, lys = s.layers || [];
  if (!(i >= 0 && i < lys.length)) return { up: [], msg: 'Chưa chọn layer' };
  const ly = lys[i];
  const pre = final(small(img), s);
  const m = E.layerMaskFor(pre, Object.assign({}, ly, { opacity: 100 }), ctx);
  let ms = 0, lm = 0;
  for (let q = 0; q < m.d.length; q++) {
    ms += m.d[q];
    lm += m.d[q] * (c01(pre.d[q * 3]) * 0.2126 + c01(pre.d[q * 3 + 1]) * 0.7152 + c01(pre.d[q * 3 + 2]) * 0.0722);
  }
  if (ms < 0.002 * m.d.length) return { up: [], msg: 'Layer chưa có vùng tác động — tô cọ / gradient / Phủ kín trước rồi bấm Auto' };
  const exp = clip(Math.log2(0.45 / Math.max(lm / ms, 1e-3)), -2, 2);
  const up = Object.keys(ly.adj).map((k) => [['layers', i, 'adj', k], 0]);
  up.push([['layers', i, 'adj', 'exposure'], Math.round(exp * 100) / 100]);
  return { up, msg: `Layer "${ly.name}": phơi sáng ${sgn(exp, 2)} để vùng chọn về độ sáng trung bình` };
}

const noiseFull = (img, s, ctx) => E.noiseSigma(E.lum(preColor(img, s))) * Math.max(1, ctx.k || 1) * 255;

function autoSharpen(img, s, ctx) {
  const n = noiseFull(img, s, ctx);
  const amt = n < 3 ? 45 : n < 6 ? 30 : 18;
  return { up: [[['sharpen'], amt], [['sharpen_radius'], 1.0]], msg: `Làm nét ${amt} (độ nhiễu ảnh ~${n.toFixed(1)})` };
}
function autoNr(img, s, ctx) {
  const n = noiseFull(img, s, ctx);
  const l = clip((n - 1.5) * 7, 0, 60), c = n > 2 ? 25 : 12;
  return { up: [[['nr_lum'], R(l)], [['nr_lum_detail'], 50], [['nr_lum_contrast'], 0], [['nr_color'], c], [['nr_color_detail'], 50], [['nr_color_smooth'], 50]],
    msg: `Khử nhiễu độ sáng ${R(l)}, màu ${c} (độ nhiễu đo được ~${n.toFixed(1)})` };
}

function regionMean(L, x0, y0, x1, y1) {
  let s = 0, c = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += L.d[y * L.w + x]; c++; }
  return c ? s / c : 0;
}
function autoEffects(img, s) {
  const x = final(small(img), s);
  const L = cv.gaussianBlur(cv.img1(x.w, x.h, E.lum(x).d.map(c01)), 6);
  const { w, h } = L, c = regionMean(L, Math.floor(w / 3), Math.floor(h / 3), Math.floor(2 * w / 3), Math.floor(2 * h / 3));
  const k = Math.max(4, Math.floor(Math.min(h, w) / 8));
  const corners = (regionMean(L, 0, 0, k, k) + regionMean(L, w - k, 0, w, k) + regionMean(L, 0, h - k, k, h) + regionMean(L, w - k, h - k, w, h)) / 4;
  const vig = corners > c * 0.85 ? -12 : 0;
  return { up: [[['vignette'], vig], [['grain'], 0]],
    msg: vig ? 'Tối góc nhẹ -12 để dồn mắt vào chủ thể' : 'Góc ảnh đã tối hơn giữa — không thêm tối góc' };
}
function autoLens(img) {
  const sm = small(img, 500);
  const L = cv.gaussianBlur(E.lum(sm), 8);
  const { w, h } = L;
  const c = regionMean(L, Math.floor(2 * w / 5), Math.floor(2 * h / 5), Math.floor(3 * w / 5), Math.floor(3 * h / 5));
  const k = Math.max(4, Math.floor(Math.min(h, w) / 10));
  const cs = [regionMean(L, 0, 0, k, k), regionMean(L, w - k, 0, w, k), regionMean(L, 0, h - k, k, h), regionMean(L, w - k, h - k, w, h)].sort((a, b) => a - b);
  const corners = (cs[1] + cs[2]) / 2;
  const f = corners / Math.max(c, 1e-3);
  const v = f < 0.9 ? clip((1 / Math.max(f, 0.3) - 1) / 0.8 * 100 * 0.5, 0, 60) : 0;
  return { up: [[['lens', 'vig_corr'], R(v)]], msg: v ? `Bù tối góc ống kính ${R(v)}` : 'Không thấy tối góc do ống kính rõ ràng' };
}

// Tự cân thẳng: bản iPhone dò hướng cạnh mạnh (Sobel) thay cho Hough của bản máy tính — cùng nguyên tắc đồng thuận
export function autoStraightenAngle(img) {
  const sm = small(img, 900);
  const L = cv.gaussianBlur(E.lum(sm), 1.0);
  const { w, h, d } = L;
  const bins = new Float64Array(301);          // -15..15 độ, bước 0.1
  let tot = 0;
  const mags = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
    const gy = d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
    mags.push(gx * gx + gy * gy);
  }
  const thr = cv.percentile(mags, 97);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
    const gy = d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
    const m = gx * gx + gy * gy;
    if (m < thr || m < 0.02) continue;
    // hướng cạnh vuông góc với gradient
    let a = Math.atan2(gy, gx) * 180 / Math.PI + 90;      // hướng cạnh
    a = ((a + 90) % 180 + 180) % 180 - 90;                 // -90..90
    let corr;
    if (Math.abs(a) <= 45) corr = -a; else corr = -(a > 0 ? a - 90 : a + 90);
    if (Math.abs(corr) > 15) continue;
    // chỉ tin cạnh thuộc một đường dài: hàng xóm dọc theo cạnh cũng phải mạnh
    bins[Math.round((corr + 15) * 10)] += Math.sqrt(m);
    tot += Math.sqrt(m);
  }
  if (tot <= 0) return null;
  // làm mượt rồi lấy đỉnh
  let best = -1, bi = 150;
  for (let i = 0; i < 301; i++) {
    let v = 0; for (let k = -3; k <= 3; k++) if (i + k >= 0 && i + k < 301) v += bins[i + k];
    if (v > best) { best = v; bi = i; }
  }
  let sup = 0; for (let k = -10; k <= 10; k++) if (bi + k >= 0 && bi + k < 301) sup += bins[bi + k];
  const ang = bi / 10 - 15;
  if (sup / tot < 0.4 || Math.abs(ang) < 0.15) return null;
  return ang;
}
function autoStraighten(img) {
  const a = autoStraightenAngle(img);
  if (a == null) return { up: [], msg: 'Không thấy đường chân trời / cạnh thẳng rõ ràng để tự cân' };
  return { up: [[['straighten'], Math.round(a * 10) / 10]], msg: `Xoay ${sgn(a, 1)}°` };
}

const PORTRAIT_FOLDS = {
  'Xoá khuyết điểm': { blemish: 55, dark_circles: 35 },
  'Xoá nếp nhăn': { wrinkles: 40 },
  'Điều chỉnh da': { even: 40, even_texture: 0, shine: 30, body_even: 20, body_texture: 0 },
  'Tạo hình cơ thể': { body_slim: null },
  'Tạo hình lại khuôn mặt': { face_slim: null, vline: null, eyes_big: null, nose_slim: null },
  'Làm đẹp răng': { teeth_bright: 25, teeth_desat: 35 },
  'Tăng cường mắt': { iris_l: 25, iris_r: 25, sclera_l: 20, sclera_r: 20 },
  'Điều chỉnh tóc': { hair_inner: 35, hair_outer: 30, hair_dark: 0 },
  'Điều chỉnh trang điểm': { lips: 15, blush: 10, brows: 15 },
  'Quần áo': { cloth_wrinkle: 35, cloth_spots: 40, cloth_edges: 0 },
};
export { PORTRAIT_FOLDS };
function autoPortrait(fold, img, s, ctx) {
  const vals = PORTRAIT_FOLDS[fold] || {};
  if (!Object.values(vals).some((v) => v != null)) return { up: [], msg: `"${fold}" không có Auto — thay đổi dáng mặt / người nên để anh/chị tự quyết` };
  if (!ctx.faces && fold !== 'Quần áo') return { up: [], msg: 'Không nhận ra khuôn mặt nào nên chưa áp Auto chân dung' };
  const up = Object.entries(vals).filter(([, v]) => v != null).map(([k, v]) => [['retouch', 'portrait', k], v]);
  if ((s.retouch.portrait.impact ?? 100) <= 0) up.push([['retouch', 'portrait', 'impact'], 100]);
  return { up, msg: `${fold}: ` + Object.entries(vals).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') };
}

const AUTO = {
  color: autoColor, tone: autoTone, presence: autoPresence, hsl: autoHsl, skin: autoSkin, calib: autoCalib,
  grading: autoGrading, curve: autoCurve, layer: autoLayer, sharpen: autoSharpen, nr: autoNr, effects: autoEffects,
  lens: autoLens, straighten: autoStraighten,
  skin_smooth: () => ({ up: [[['retouch', 'skin_auto'], true], [['retouch', 'skin_amount'], 35], [['retouch', 'skin_texture'], 55]],
    msg: 'Làm mịn da 35 trên mọi vùng da tự nhận, giữ kết cấu 55' }),
  keystone: () => ({ up: [], msg: 'Bản iPhone chưa có tự dựng thẳng phối cảnh — kéo thanh "Dọc" / "Ngang" bằng tay' }),
};

export function autoSection(key, img, s, ctx = {}) {
  if (key.startsWith('portrait:')) return autoPortrait(key.slice(9), img, s, ctx);
  const fn = AUTO[key];
  if (!fn) return { up: [], msg: 'Nhóm này không có Auto' };
  return fn(img, s, ctx);
}
