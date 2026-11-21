// Retouch (engine.apply_retouch) gồm:
// - điểm heal / clone / xoá bụi; vùng tô Heal / Clone (hoà Poisson), tự tìm vùng nguồn;
// - Xoá vật thể bằng AI (xoa_vat.js);
// - làm mịn da giữ kết cấu.
// Chân dung tự động ở portrait.js.
// Mọi toạ độ chuẩn hoá theo CẢ ảnh (W x H); khi dựng một vùng (xuất theo dải) truyền ctx.roi = [ox, oy, W, H].
// Các khoá ctx cho Xoá vật thể:
// - xvPhoto: mã ảnh, dùng làm khoá bộ đệm kết quả AI;
// - xvRef: cỡ ảnh tham chiếu [Wr, Hr];
// - draft: bản nháp, không đòi AI.
// Thiếu kết quả AI thì vùng được lấp tạm và ctx.xvPending = true.
import * as cv from './cv.js';
import { drawStrokes } from './layers.js';
import { portraitActive, applyPortrait, portraitNeeds } from './portrait.js';
import * as XV from './xoa_vat.js';

const smooth = (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

export function hasRetouch(rt) {
  if (!rt) return false;
  const portrait = portraitActive(rt.portrait);
  return !!((rt.spots && rt.spots.length) || (rt.areas && rt.areas.length) || portrait ||
    ((rt.skin_amount || 0) > 0 && ((rt.skin_strokes && rt.skin_strokes.length) || rt.skin_auto)));
}

function blurAuto(x, sigma) {          // engine._blur
  if (sigma < 0.3) return x;
  if (sigma > 10) {
    const f = sigma / 5, sw = Math.max(1, Math.trunc(x.w / f)), sh = Math.max(1, Math.trunc(x.h / f));
    return cv.resizeLinear(cv.gaussianBlur(cv.resizeArea(x, sw, sh), sigma / f), x.w, x.h);
  }
  return cv.gaussianBlur(x, sigma);
}

// ------------------------------------------------------------------ _laplace_fill (đa lưới)
export function laplaceFill(D, inside) {
  // D: {w,h,c,d}, inside: Uint8Array w*h
  const { w, h, c } = D;
  const out = { w, h, c, d: Float32Array.from(D.d) };
  let any = false; for (let i = 0; i < inside.length; i++) if (inside[i]) { any = true; break; }
  if (!any) return out;
  let n;
  if (Math.max(h, w) > 40) {
    const wc = (w + 1) >> 1, hc = (h + 1) >> 1;
    const outm = { w, h, c: 1, d: new Float32Array(w * h) };
    for (let i = 0; i < w * h; i++) outm.d[i] = inside[i] ? 0 : 1;
    const Dm = { w, h, c, d: new Float32Array(w * h * c) };
    for (let i = 0; i < w * h; i++) for (let k = 0; k < c; k++) Dm.d[i * c + k] = out.d[i * c + k] * outm.d[i];
    const wts = cv.resizeArea(outm, wc, hc), Dc = cv.resizeArea(Dm, wc, hc);
    const insc = new Uint8Array(wc * hc);
    for (let i = 0; i < wc * hc; i++) {
      if (wts.d[i] < 1e-3) { insc[i] = 1; for (let k = 0; k < c; k++) Dc.d[i * c + k] = 0; }
      else for (let k = 0; k < c; k++) Dc.d[i * c + k] /= Math.max(wts.d[i], 1e-6);
    }
    const sol = laplaceFill(Dc, insc);
    const init = cv.resizeLinear(sol, w, h);
    for (let i = 0; i < w * h; i++) if (inside[i]) for (let k = 0; k < c; k++) out.d[i * c + k] = init.d[i * c + k];
    n = 36;
  } else {
    const mean = new Float64Array(c); let cnt = 0;
    for (let i = 0; i < w * h; i++) if (!inside[i]) { cnt++; for (let k = 0; k < c; k++) mean[k] += out.d[i * c + k]; }
    for (let i = 0; i < w * h; i++) if (inside[i]) for (let k = 0; k < c; k++) out.d[i * c + k] = cnt ? mean[k] / cnt : 0;
    n = 260;
  }
  // lặp Jacobi trên các điểm bên trong (trừ viền khung)
  const idx = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (inside[y * w + x]) idx.push(y * w + x);
  const tmp = new Float32Array(idx.length * c);
  for (let it = 0; it < n; it++) {
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q];
      for (let k = 0; k < c; k++)
        tmp[q * c + k] = 0.25 * (out.d[(i - w) * c + k] + out.d[(i + w) * c + k] + out.d[(i - 1) * c + k] + out.d[(i + 1) * c + k]);
    }
    for (let q = 0; q < idx.length; q++) for (let k = 0; k < c; k++) out.d[idx[q] * c + k] = tmp[q * c + k];
  }
  return out;
}

function sub(img, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, o = { w, h, c: 3, d: new Float32Array(w * h * 3) };
  for (let y = 0; y < h; y++) o.d.set(img.d.subarray(((y + y0) * img.w + x0) * 3, ((y + y0) * img.w + x1) * 3), y * w * 3);
  return o;
}

// ------------------------------------------------------------------ điểm tròn (spot)
function applySpot(out, sp, W, H, ox, oy) {
  const w = out.w, h = out.h;
  const cx = sp.x * W - ox, cy = sp.y * H - oy;
  const r = Math.max(1.5, sp.r * W);
  const kind = sp.type || 'heal';
  const R = Math.ceil(r * 1.6) + 2;
  let dx = 0, dy = 0;
  if (kind !== 'dust') { dx = Math.round(sp.sx * W - ox - cx); dy = Math.round(sp.sy * H - oy - cy); }
  const x0 = Math.round(cx) - R, y0 = Math.round(cy) - R, x1 = x0 + 2 * R + 1, y1 = y0 + 2 * R + 1;
  const lx0 = Math.max(x0, 0, -dx), ly0 = Math.max(y0, 0, -dy), lx1 = Math.min(x1, w, w - dx), ly1 = Math.min(y1, h, h - dy);
  if (lx0 >= lx1 || ly0 >= ly1) return;
  const bw = lx1 - lx0, bh = ly1 - ly0;
  const dst = sub(out, lx0, ly0, lx1, ly1);
  const inside = new Uint8Array(bw * bh), m = new Float32Array(bw * bh);
  const feather = Math.max(1, r * 0.3);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const d = Math.hypot(x + lx0 - cx, y + ly0 - cy);
    let t = (r - d) / feather; t = t < 0 ? 0 : t > 1 ? 1 : t;
    m[y * bw + x] = t * t * (3 - 2 * t); inside[y * bw + x] = d < r ? 1 : 0;
  }
  let res;
  if (kind === 'dust') res = laplaceFill(dst, inside);
  else {
    const src = sub(out, lx0 + dx, ly0 + dy, lx1 + dx, ly1 + dy);
    if (kind === 'heal') {
      const diff = { w: bw, h: bh, c: 3, d: new Float32Array(bw * bh * 3) };
      for (let i = 0; i < diff.d.length; i++) diff.d[i] = dst.d[i] - src.d[i];
      const f = laplaceFill(diff, inside);
      res = { w: bw, h: bh, c: 3, d: new Float32Array(bw * bh * 3) };
      for (let i = 0; i < res.d.length; i++) res.d[i] = src.d[i] + f.d[i];
    } else res = src;
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const a = m[y * bw + x]; if (!a) continue;
    const o = ((y + ly0) * w + x + lx0) * 3, q = (y * bw + x) * 3;
    for (let k = 0; k < 3; k++) out.d[o + k] = dst.d[q + k] * (1 - a) + res.d[q + k] * a;
  }
}

// ------------------------------------------------------------------ vùng tô (_area_geom / _apply_area)
function segDist(px, py, pts) {
  let best = Math.hypot(px - pts[0][0], py - pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy;
    const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / L2));
    best = Math.min(best, Math.hypot(px - x0 - t * vx, py - y0 - t * vy));
  }
  return best;
}
export function areaGeom(a, W, H, ox = 0, oy = 0) {
  const r = Math.max(1, a.r * W);
  const pts = a.pts.map(([x, y]) => [x * W - ox, y * H - oy]);
  const hard = Math.min(1, Math.max(0, (a.hard ?? 60) / 100));
  const fe = Math.max(0.6, (1 - hard) * r * 0.5);
  const pad = Math.ceil(r + 3 * fe) + 3;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)) - pad, y0 = Math.floor(Math.min(...ys)) - pad;
  const x1 = Math.ceil(Math.max(...xs)) + pad + 1, y1 = Math.ceil(Math.max(...ys)) + pad + 1;
  const bw = x1 - x0, bh = y1 - y0;
  const ri = Math.max(1, Math.round(r));
  const ip = pts.map(([px, py]) => [Math.round(px - x0), Math.round(py - y0)]);
  let grow = 0;
  if (a.kind === 'remove') grow = (Math.max(3, Math.trunc(r * 0.25) | 1) - 1) / 2;
  const D = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) D[y * bw + x] = segDist(x, y, ip);
  const soft = new Float32Array(bw * bh);
  const core = ri + grow + 0.25;
  if (fe > 0.7) {
    const k = Math.max(3, Math.round(2 * fe) | 1), gr = core + (k - 1) / 2;
    const g = cv.img1(bw, bh);
    for (let i = 0; i < D.length; i++) g.d[i] = D[i] <= gr ? 1 : 0;
    const b = cv.gaussianBlur(g, fe * 0.6).d;
    for (let i = 0; i < D.length; i++) soft[i] = Math.max(b[i], D[i] <= core ? 1 : 0);
  } else for (let i = 0; i < D.length; i++) soft[i] = D[i] <= core ? 1 : 0;
  const inside = new Uint8Array(bw * bh);
  for (let i = 0; i < D.length; i++) inside[i] = soft[i] > 0.01 ? 1 : 0;
  return { x0, y0, bw, bh, inside, soft };
}

function applyArea(out, a, W, H, ox, oy) {
  const geo = areaGeom(a, W, H, ox, oy);
  if (a.kind === 'remove' && !a.off) {
    // xoá vật thể khi không có mô hình AI (vùng tạo ở bản mới, không có vùng nguồn): lấp mượt + chi tiết quanh
    XV.removeSync(out, a, W, H, ox, oy, geo, { fallback: true });
    return;
  }
  const { x0, y0, bw, bh, inside, soft } = geo;
  const w = out.w, h = out.h;
  const off = a.off || [0, 0];
  const dx = Math.round(off[0] * W), dy = Math.round(off[1] * H);
  const lx0 = Math.max(x0, 0, -dx), ly0 = Math.max(y0, 0, -dy), lx1 = Math.min(x0 + bw, w, w - dx), ly1 = Math.min(y0 + bh, h, h - dy);
  if (lx0 >= lx1 || ly0 >= ly1) return;
  const cw = lx1 - lx0, ch = ly1 - ly0;
  const ins = new Uint8Array(cw * ch), sft = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const q = (y + ly0 - y0) * bw + x + lx0 - x0;
    ins[y * cw + x] = inside[q]; sft[y * cw + x] = soft[q];
  }
  const dst = sub(out, lx0, ly0, lx1, ly1), src = sub(out, lx0 + dx, ly0 + dy, lx1 + dx, ly1 + dy);
  let res = src;
  if ((a.kind || 'heal') !== 'clone') {
    const diff = { w: cw, h: ch, c: 3, d: new Float32Array(cw * ch * 3) };
    for (let i = 0; i < diff.d.length; i++) diff.d[i] = dst.d[i] - src.d[i];
    const f = laplaceFill(diff, ins);
    res = { w: cw, h: ch, c: 3, d: new Float32Array(cw * ch * 3) };
    for (let i = 0; i < res.d.length; i++) res.d[i] = src.d[i] + f.d[i];
  }
  const op = Math.min(1, Math.max(0, (a.opacity ?? 100) / 100));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const al = sft[y * cw + x] * op; if (!al) continue;
    const o = ((y + ly0) * w + x + lx0) * 3, q = (y * cw + x) * 3;
    for (let k = 0; k < 3; k++) out.d[o + k] = dst.d[q + k] * (1 - al) + res.d[q + k] * al;
  }
}

// ------------------------------------------------------------------ tự tìm nguồn cho vùng tô
const lumOf = (im) => { const n = im.w * im.h, L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = im.d[i * 3] * 0.2126 + im.d[i * 3 + 1] * 0.7152 + im.d[i * 3 + 2] * 0.0722; return cv.img1(im.w, im.h, L); };

export function findAreaSources(img, a, k = 6) {
  const H = img.h, W = img.w;
  const sc = Math.min(1, 900 / Math.max(H, W));
  const g = lumOf(sc < 1 ? cv.resizeArea(img, Math.max(8, Math.trunc(W * sc)), Math.max(8, Math.trunc(H * sc))) : img);
  const gw = g.w, gh = g.h;
  const { x0, y0, bw, bh, inside } = areaGeom(a, gw, gh);
  const rr = Math.max(2, Math.trunc(a.r * gw * 0.7) + 2);
  // vòng quanh vùng (giãn bằng đĩa bán kính rr, trừ bên trong)
  const ring = new Uint8Array(bw * bh);
  const insPts = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (inside[y * bw + x]) insPts.push([x, y]);
  {
    const dil = new Uint8Array(bw * bh);
    for (const [x, y] of insPts) {
      if (x > 0 && x < bw - 1 && y > 0 && y < bh - 1 && inside[y * bw + x - 1] && inside[y * bw + x + 1] && inside[(y - 1) * bw + x] && inside[(y + 1) * bw + x]) continue;
      for (let j = -rr; j <= rr; j++) for (let i = -rr; i <= rr; i++) {
        if (i * i + j * j > rr * rr) continue;
        const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) dil[yy * bw + xx] = 1;
      }
    }
    for (let i = 0; i < ring.length; i++) ring[i] = dil[i] && !inside[i] ? 1 : 0;
  }
  const hpB = cv.gaussianBlur(g, 1.5).d, hp = new Float32Array(g.d.length);
  for (let i = 0; i < hp.length; i++) hp[i] = g.d[i] - hpB[i];
  const win = (arr, ox, oy) => {
    const xa = x0 + ox, ya = y0 + oy;
    if (xa < 0 || ya < 0 || xa + bw > gw || ya + bh > gh) return null;
    return (x, y) => arr[(ya + y) * gw + xa + x];
  };
  let dwin = win(g.d, 0, 0);
  if (!dwin) {
    const rf = (i, n) => { while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; } return i; };
    dwin = (x, y) => g.d[rf(y0 + y, gh) * gw + rf(x0 + x, gw)];
  }
  const ringIdx = [], insIdx = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { if (ring[y * bw + x]) ringIdx.push([x, y]); if (inside[y * bw + x]) insIdx.push([x, y]); }
  if (ringIdx.length < 4) return [[2 * a.r, 0]];
  const dRing = ringIdx.map(([x, y]) => dwin(x, y));
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const sd = (v, m) => Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  const ringMean = mean(dRing), ringStd = sd(dRing, ringMean);
  const dh = win(hp, 0, 0);
  const dTex = dh ? mean(ringIdx.map(([x, y]) => Math.abs(dh(x, y)))) : 0;
  const size = Math.max(Math.max(bw, bh) - 2 * rr, 6);
  const cands = [];
  for (const f of [1.05, 1.35, 1.8, 2.4, 3.2]) {
    const dist = f * size + rr, n = 32;
    for (let i = 0; i < n; i++) {
      const ang = 2 * Math.PI * (i + 0.5 * (f > 1.5 ? 1 : 0)) / n;
      const ox = Math.round(dist * Math.cos(ang)), oy = Math.round(dist * Math.sin(ang));
      const sw = win(g.d, ox, oy);
      if (!sw) continue;
      if (Math.abs(ox) < bw - 2 * rr && Math.abs(oy) < bh - 2 * rr) {
        let ov = false;
        for (const [x, y] of insIdx) { const xx = x + ox, yy = y + oy; if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && inside[yy * bw + xx]) { ov = true; break; } }
        if (ov) continue;
      }
      let cRing = 0; for (let q = 0; q < ringIdx.length; q++) cRing += (sw(...ringIdx[q]) - dRing[q]) ** 2; cRing /= ringIdx.length;
      const sIn = insIdx.map(([x, y]) => sw(x, y)), mIn = mean(sIn);
      const cIn = (mIn - ringMean) ** 2 + (sd(sIn, mIn) - ringStd) ** 2;
      const sh = win(hp, ox, oy);
      const tIn = sh ? mean(insIdx.map(([x, y]) => Math.abs(sh(x, y)))) : 0;
      let cost = cRing + 1.2 * cIn + 4.0 * (sh ? (tIn - dTex) ** 2 : 0) + 2e-6 * dist;
      if (a.kind === 'remove' && sh) cost += 0.6 * tIn * tIn;
      cands.push([cost, ox, oy]);
    }
  }
  if (!cands.length) return [[1.6 * a.r * 2, 0]];
  cands.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [, ox, oy] of cands) {
    if (out.every((p) => Math.hypot(ox - p[0], oy - p[1]) > size * 0.45)) out.push([ox, oy]);
    if (out.length >= k) break;
  }
  return out.map(([ox, oy]) => [+(ox / gw).toFixed(5), +(oy / gh).toFixed(5)]);
}

// ------------------------------------------------------------------ làm mịn da
function detectSkin(img, W) {
  const n = img.w * img.h, m = cv.img1(img.w, img.h);
  for (let i = 0; i < n; i++) {
    const r = Math.floor(Math.min(1, Math.max(0, img.d[i * 3])) * 255 + 0.5), g = Math.floor(Math.min(1, Math.max(0, img.d[i * 3 + 1])) * 255 + 0.5), b = Math.floor(Math.min(1, Math.max(0, img.d[i * 3 + 2])) * 255 + 0.5);
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const cr = Math.min(255, Math.max(0, Math.round((r - y) * 0.713 + 128))), cb = Math.min(255, Math.max(0, Math.round((b - y) * 0.564 + 128)));
    m.d[i] = smooth(128, 138, cr) * (1 - smooth(170, 180, cr)) * smooth(72, 82, cb) * (1 - smooth(125, 135, cb)) * smooth(35, 60, y);
  }
  // mở hình thái (co rồi giãn) với nhân tròn
  const k = Math.max(3, Math.trunc(W * 0.004) | 1), rad = (k - 1) / 2;
  const offs = [];
  for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) if ((i * i) / ((rad + 0.5) ** 2) + (j * j) / ((rad + 0.5) ** 2) <= 1) offs.push([i, j]);
  const morph = (src, fn, init) => {
    const o = new Float32Array(src.length), w = img.w, h = img.h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = init;
      for (const [i, j] of offs) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; v = fn(v, src[yy * w + xx]); }
      o[y * w + x] = v;
    }
    return o;
  };
  m.d = morph(morph(m.d, Math.min, Infinity), Math.max, -Infinity);
  return m;
}

function skinMask(img, rt, W, H, ox, oy) {
  let m = rt.skin_auto ? detectSkin(img, W).d : new Float32Array(img.w * img.h);
  drawStrokes(m, rt.skin_strokes || [], img.w, img.h, null, [ox, oy, W, H]);
  return blurAuto(cv.img1(img.w, img.h, m), Math.max(0.8, W * 0.003)).d;
}

function guided3(p, r, eps) {
  r = Math.max(1, Math.trunc(r));
  const n = p.d.length, pp = { w: p.w, h: p.h, c: p.c, d: new Float32Array(n) };
  for (let i = 0; i < n; i++) pp.d[i] = p.d[i] * p.d[i];
  const m = cv.boxBlur(p, r).d, mm = cv.boxBlur(pp, r).d;
  const a = { w: p.w, h: p.h, c: p.c, d: new Float32Array(n) }, b = { w: p.w, h: p.h, c: p.c, d: new Float32Array(n) };
  for (let i = 0; i < n; i++) { const v = mm[i] - m[i] * m[i], ai = v / (v + eps); a.d[i] = ai; b.d[i] = m[i] - ai * m[i]; }
  const ma = cv.boxBlur(a, r).d, mb = cv.boxBlur(b, r).d, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ma[i] * p.d[i] + mb[i];
  return out;
}

function smoothSkin(img, mask, amount, texture, W) {
  const a = amount / 100;
  const sm = guided3(img, Math.max(2, W * 0.006), 0.0015 + 0.006 * a);
  const bl = blurAuto(img, Math.max(0.6, W * 0.0008)).d;
  const d = img.d, t = texture / 100;
  for (let i = 0, q = 0; q < mask.length; q++, i += 3) {
    const k = mask[q] * a; if (!k) continue;
    for (let c = 0; c < 3; c++) { const tg = sm[i + c] + (d[i + c] - bl[i + c]) * t; d[i + c] += (tg - d[i + c]) * k; }
  }
}

// ------------------------------------------------------------------ áp retouch
export function applyRetouch(img, rt, ctx) {
  if (!hasRetouch(rt)) return img;
  const roi = ctx && ctx.roi;
  const W = roi ? roi[2] : img.w, H = roi ? roi[3] : img.h, ox = roi ? roi[0] : 0, oy = roi ? roi[1] : 0;
  const skinOn = (rt.skin_amount || 0) > 0 && ((rt.skin_strokes && rt.skin_strokes.length) || rt.skin_auto);
  if ((rt.spots && rt.spots.length) || (rt.areas && rt.areas.length) || skinOn) {
    for (const sp of rt.spots || []) applySpot(img, sp, W, H, ox, oy);
    const areas = rt.areas || [];
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i];
      if (!(a.pts && a.pts.length && a.enabled !== false)) continue;
      if (a.kind === 'remove' && XV.state.ai) {
        // Xoá vật thể: AI xoá hẳn rồi dựng lại nền phía sau (không chép vùng nguồn nào)
        const geo = areaGeom(a, W, H, ox, oy);
        const ref = (ctx && ctx.xvRef) || xvRefDims(W, H);
        const key = ctx && ctx.xvPhoto ? XV.cacheKey(ctx.xvPhoto, rt, i, ref[0], ref[1]) : null;
        const draft = !!(ctx && ctx.draft);
        if (!XV.removeSync(img, a, W, H, ox, oy, geo, { key, draft })) {
          XV.removeSync(img, a, W, H, ox, oy, geo, { key, draft: true });     // chưa có kết quả AI: lấp tạm
          if (ctx) ctx.xvPending = true;
        }
      } else applyArea(img, a, W, H, ox, oy);
    }
    if (skinOn) smoothSkin(img, skinMask(img, rt, W, H, ox, oy), rt.skin_amount, rt.skin_texture ?? 50, W);
  }
  if (ctx && ctx.faces && portraitActive(rt.portrait))
    img = applyPortrait(img, rt.portrait, ctx.faces, ctx.personFn || null, roi, { faceInfos: ctx.faceInfos, infosOut: ctx.infosOut });
  return img;
}

// cỡ ảnh tham chiếu cho khoá kết quả AI (= bản xem trước 2000 px của PUM máy tính)
export function xvRefDims(W, H) {
  const k = Math.min(1, XV.REF_SIDE / Math.max(W, H));
  return [Math.max(1, cv.roundEven(W * k)), Math.max(1, cv.roundEven(H * k))];
}

// vùng ảnh nguồn (toạ độ điểm ảnh gốc) mà một vùng [x0,y0,x1,y1] cần để retouch đúng (gồm vùng nguồn của heal / clone)
export function retouchNeeds(rt, W, H, rect, faces) {
  let [x0, y0, x1, y1] = rect;
  const boxes = [];
  for (const sp of rt.spots || []) {
    const r = Math.max(1.5, sp.r * W) * 1.6 + 4;
    const b = [[sp.x * W - r, sp.y * H - r, sp.x * W + r, sp.y * H + r]];
    if (sp.type !== 'dust') b.push([sp.sx * W - r, sp.sy * H - r, sp.sx * W + r, sp.sy * H + r]);
    boxes.push(b);
  }
  for (const a of rt.areas || []) {
    if (!a.pts || !a.pts.length) continue;
    const pad = a.r * W * 2.5 + 6, xs = a.pts.map((p) => p[0] * W), ys = a.pts.map((p) => p[1] * H);
    const bb = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    if (a.kind === 'remove' && (XV.state.ai || !a.off)) {
      // xoá vật thể: cần cả khung các ô đưa vào AI (bối cảnh quanh vật) + khung hoà mép / ghép chi tiết
      const r = XV.rectNorm(a, W, H);
      boxes.push([bb, [Math.floor(r[0] * W) - 2, Math.floor(r[1] * H) - 2, Math.ceil(r[2] * W) + 2, Math.ceil(r[3] * H) + 2]]);
      continue;
    }
    const off = a.off || [0, 0];
    boxes.push([bb, [bb[0] + off[0] * W, bb[1] + off[1] * H, bb[2] + off[0] * W, bb[3] + off[1] * H]]);
  }
  for (let it = 0; it < 6; it++) {
    let grew = false;
    for (const b of boxes) {
      const d = b[0];
      if (d[2] < x0 || d[0] > x1 || d[3] < y0 || d[1] > y1) continue;
      for (const q of b) {
        const n0 = Math.min(x0, q[0]), n1 = Math.min(y0, q[1]), n2 = Math.max(x1, q[2]), n3 = Math.max(y1, q[3]);
        if (n0 < x0 || n1 < y0 || n2 > x1 || n3 > y1) { x0 = n0; y0 = n1; x1 = n2; y1 = n3; grew = true; }
      }
    }
    if (!grew) break;
  }
  const extra = (rt.skin_amount || 0) > 0 ? Math.ceil(W * 0.02) : 0;
  const r = [Math.max(0, Math.floor(x0 - extra)), Math.max(0, Math.floor(y0 - extra)), Math.min(W, Math.ceil(x1 + extra)), Math.min(H, Math.ceil(y1 + extra))];
  return faces ? portraitNeeds(rt.portrait, faces, W, H, r) : r;
}
