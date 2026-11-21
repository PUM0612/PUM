// Mặt nạ layer (engine.layer_mask): cọ, tẩy, gradient thẳng / tròn, phủ kín, người (AI), Luma Range, Color Range.
// roi = [x0, y0, W, H]: chỉ dựng một vùng của ảnh lớn W x H (xuất theo dải) — toạ độ vẫn tính theo cả ảnh.
import * as cv from './cv.js';

const smooth = (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const pmod = (a, n) => ((a % n) + n) % n;
const hueDist = (H, c) => pmod(H - c + 180, 360) - 180;

// vẽ nét cọ (vòng tròn + đoạn thẳng dày 2r, khử răng cưa) — giống cv2.circle / cv2.line LINE_AA
export function drawStrokes(m, strokes, w, h, eraseMap, roi) {
  const [ox, oy, W, H] = roi || [0, 0, w, h];
  for (const st of strokes) {
    const er = !!st.erase;
    const val = er ? 0 : +(st.flow ?? 1);
    const r = Math.max(1, Math.round(st.r * W));
    const pts = st.pts.map(([x, y]) => [Math.round(x * W) - ox, Math.round(y * H) - oy]);
    const targets = [[m, val]];
    if (er && eraseMap) targets.push([eraseMap, 1]);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.max(0, Math.floor(x0 - r - 2)); y0 = Math.max(0, Math.floor(y0 - r - 2));
    x1 = Math.min(w - 1, Math.ceil(x1 + r + 2)); y1 = Math.min(h - 1, Math.ceil(y1 + r + 2));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let dmin = 1e9;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        let d;
        if (i === 0) d = Math.hypot(x - ax, y - ay);
        else {
          const [bx, by] = pts[i - 1], vx = ax - bx, vy = ay - by, l2 = vx * vx + vy * vy;
          let t = l2 > 0 ? ((x - bx) * vx + (y - by) * vy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(x - bx - t * vx, y - by - t * vy);
        }
        if (d < dmin) dmin = d;
      }
      let a = r + 0.5 - dmin;
      if (a <= 0) continue;
      if (a > 1) a = 1;
      const i = y * w + x;
      for (const [tg, v] of targets) tg[i] = tg[i] * (1 - a) + v * a;
    }
  }
}

export function linearMask(g, w, h, roi) {
  const [ox, oy, W, H] = roi || [0, 0, w, h];
  const m = new Float32Array(w * h);
  const x0 = g.x0 * W, y0 = g.y0 * H, vx = g.x1 * W - x0, vy = g.y1 * H - y0, n2 = Math.max(1e-6, vx * vx + vy * vy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = 1 - smooth(0, 1, ((x + ox - x0) * vx + (y + oy - y0) * vy) / n2);
  return m;
}
export function radialMask(g, w, h, roi) {
  const [ox, oy, W, H] = roi || [0, 0, w, h];
  const m = new Float32Array(w * h);
  const rx = Math.max(1e-4, g.rx) * W, ry = Math.max(1e-4, g.ry) * W;
  const f = Math.min(0.99, Math.max(0.01, (g.feather ?? 50) / 100));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.sqrt(((x + ox - g.cx * W) / rx) ** 2 + ((y + oy - g.cy * H) / ry) ** 2);
    const v = 1 - smooth(1 - f, 1, d);
    m[y * w + x] = g.outside ? 1 - v : v;
  }
  return m;
}

export function layerHasShape(ly) {
  return !!(ly.brush.some((s) => !s.erase) || ly.linear.length || ly.radial.length || ly.person || ly.fill);
}

function blur1(d, w, h, sigma) {
  if (sigma < 0.3) return d;
  return cv.gaussianBlur(cv.img1(w, h, d), sigma).d;
}

// Phần mặt nạ hình (cọ / gradient / người), chưa đảo / lọc / độ đậm
export function shapeMask(w, h, ly, ctx, roi) {
  const W = roi ? roi[2] : w;
  let m = new Float32Array(w * h);
  if (ly.fill) m.fill(1);
  const erase = new Float32Array(w * h);
  drawStrokes(m, ly.brush, w, h, erase, roi);
  for (const g of ly.linear) { const a = linearMask(g, w, h, roi); for (let i = 0; i < m.length; i++) if (a[i] > m[i]) m[i] = a[i]; }
  for (const g of ly.radial) { const a = radialMask(g, w, h, roi); for (let i = 0; i < m.length; i++) if (a[i] > m[i]) m[i] = a[i]; }
  if (ly.person && ctx && ctx.personFn) {
    const pm = ctx.personFn(w, h, roi);
    if (pm) for (let i = 0; i < m.length; i++) if (pm[i] > m[i]) m[i] = pm[i];
  }
  if (ly.brush.length) {
    const be = blur1(erase, w, h, Math.max(0.8, W * 0.002));
    for (let i = 0; i < m.length; i++) m[i] *= 1 - be[i];
  }
  return blur1(m, w, h, Math.max(0.6, W * 0.0015));
}

export function layerMask(img, ly, ctx, shape) {
  const { w, h } = img, n = w * h, d = img.d;
  let m;
  if (layerHasShape(ly)) m = shape ? Float32Array.from(shape.d || shape) : shapeMask(w, h, ly, ctx, ctx && ctx.roi);
  else m = new Float32Array(n).fill(ly.luma_on || ly.crange_on ? 1 : 0);
  if (ly.invert) for (let i = 0; i < n; i++) m[i] = 1 - m[i];
  if (ly.luma_on) {
    const [lo, hi, s0] = ly.luma.map((v) => v / 100), soft = Math.max(s0, 0.005);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const L = d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
      m[i] *= smooth(lo - soft, lo, L) * (1 - smooth(hi, hi + soft, L));
    }
  }
  if (ly.crange_on) {
    const [hc, wid, soft] = ly.crange, t = new Float32Array(3);
    const c = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      cv.rgb2hsv(c(d[j]), c(d[j + 1]), c(d[j + 2]), t);
      const dd = Math.abs(hueDist(t[0], hc));
      m[i] *= (1 - smooth(wid, wid + Math.max(1, soft), dd)) * smooth(0.05, 0.18, t[1]);
    }
  }
  const op = ly.opacity / 100;
  for (let i = 0; i < n; i++) { const v = m[i] * op; m[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return cv.img1(w, h, m);
}
