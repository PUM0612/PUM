// Bánh xe Grading (ColorWheel) và đường cong (CurveWidget) cho màn hình cảm ứng — theo widgets.py bản máy tính.
import { h } from './controls.js';
import { curveLut } from '../engine/engine.js';

const DPR = () => Math.min(3, window.devicePixelRatio || 1);
const hsvCss = (hue, s, v, a = 1) => {
  const f = (n) => { const k = (n + hue / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return `rgba(${Math.round(f(5) * 255)},${Math.round(f(3) * 255)},${Math.round(f(1) * 255)},${a})`;
};

export class ColorWheel {
  // o: { title, get: () => [h, s, l], set: (h, s, l, live), begin, end }
  constructor(o) {
    this.o = o;
    this.cv = h('canvas');
    this.fh = h('input', { type: 'text', inputmode: 'decimal' });
    this.fs = h('input', { type: 'text', inputmode: 'decimal' });
    this.fl = h('input', { type: 'text', inputmode: 'decimal' });
    const typed = () => {
      const [H, S, L] = this.o.get();
      const p = (el, d) => { const v = parseFloat(el.value.replace(',', '.')); return isFinite(v) ? v : d; };
      const nh = ((p(this.fh, H) % 360) + 360) % 360, ns = Math.max(0, Math.min(100, p(this.fs, S))), nl = Math.max(-100, Math.min(100, p(this.fl, L)));
      o.begin(); o.set(nh, ns, nl, false); o.end(); this.sync();
    };
    for (const f of [this.fh, this.fs, this.fl]) { f.addEventListener('change', typed); f.addEventListener('focus', () => f.select()); }
    this.el = h('div', { class: 'wheel' }, h('div', { class: 'wt' }, o.title), this.cv,
      h('div', { class: 'hsl' }, this.fh, this.fs, this.fl));
    this.mode = null;
    let lastTap = 0;
    this.cv.addEventListener('pointerdown', (e) => {
      const t = Date.now();
      if (t - lastTap < 320) { o.begin(); o.set(0, 0, 0, false); o.end(); this.sync(); lastTap = 0; return; }
      lastTap = t;
      this.mode = this.zone(e);
      if (!this.mode) return;
      this.cv.setPointerCapture(e.pointerId);
      o.begin(); this.from(e, true);
    });
    this.cv.addEventListener('pointermove', (e) => { if (this.mode) this.from(e, true); });
    const up = () => { if (this.mode) { this.mode = null; o.end(); } };
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);
  }
  geom() {
    const r = this.cv.getBoundingClientRect(), s = Math.min(r.width, r.height);
    const R = s / 2 - 3, rr = R - 13, ri = rr - Math.max(6, rr * 0.16) - 1;
    return { cx: r.width / 2, cy: r.height / 2, R, rr, ri, rect: r };
  }
  zone(e) {
    const g = this.geom(), x = e.clientX - g.rect.left - g.cx, y = g.cy - (e.clientY - g.rect.top);
    if (Math.hypot(x, y) <= g.rr + 3) return 'wheel';
    return x < 0 ? 'sat' : 'lum';
  }
  from(e, live) {
    const g = this.geom(), dx = e.clientX - g.rect.left - g.cx, dy = g.cy - (e.clientY - g.rect.top);
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    let [H, S, L] = this.o.get();
    if (this.mode === 'wheel') { H = ((ang % 360) + 360) % 360; S = Math.min(100, Math.hypot(dx, dy) / Math.max(1, g.ri) * 100); }
    else if (this.mode === 'sat') {
      let a = ((ang % 360) + 360) % 360;
      a = (a >= 90 && a <= 270) ? Math.min(235, Math.max(125, a)) : (dy > 0 ? 125 : 235);
      S = (235 - a) / 110 * 100;
    } else {
      const a = Math.min(55, Math.max(-55, (ang >= -90 && ang <= 90) ? ang : (dy > 0 ? 55 : -55)));
      L = a / 55 * 100;
    }
    this.o.set(Math.round(H), Math.round(S * 10) / 10, Math.round(L), live);
    this.sync();
  }
  sync() {
    const [H, S, L] = this.o.get();
    const fmt = (v) => String(Math.round(v));
    if (document.activeElement !== this.fh) this.fh.value = fmt(((H % 360) + 360) % 360);
    if (document.activeElement !== this.fs) this.fs.value = fmt(S);
    if (document.activeElement !== this.fl) this.fl.value = fmt(L);
    this.draw();
  }
  draw() {
    const r = this.cv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = DPR(), W = Math.round(r.width * dpr), Hh = Math.round(r.height * dpr);
    if (this.cv.width !== W || this.cv.height !== Hh) { this.cv.width = W; this.cv.height = Hh; }
    const c = this.cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const g = this.geom(), [hue, sat, lum] = this.o.get();
    const pt = (rad, deg) => [g.cx + rad * Math.cos(deg * Math.PI / 180), g.cy - rad * Math.sin(deg * Math.PI / 180)];
    // vòng sắc độ
    for (let a = 0; a < 360; a += 3) {
      c.beginPath(); c.strokeStyle = hsvCss(a, 0.9, 0.95); c.lineWidth = g.rr - g.ri;
      c.arc(g.cx, g.cy, (g.rr + g.ri) / 2, -(a + 3.5) * Math.PI / 180, -a * Math.PI / 180); c.stroke();
    }
    const rg = c.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.ri);
    rg.addColorStop(0, '#2e2e32'); rg.addColorStop(1, '#1c1c1f');
    c.fillStyle = rg; c.beginPath(); c.arc(g.cx, g.cy, g.ri, 0, 7); c.fill();
    if (sat > 0) { c.fillStyle = hsvCss(hue, 0.8, 0.8, Math.min(0.55, sat / 100 * 0.6)); c.beginPath(); c.arc(g.cx, g.cy, g.ri, 0, 7); c.fill(); }
    c.strokeStyle = '#78787d'; c.lineWidth = 1; c.beginPath(); c.arc(g.cx, g.cy, 3.5, 0, 7); c.stroke();
    const arc = (a0, a1, top, bot) => {
      const gr = c.createLinearGradient(0, g.cy - g.R, 0, g.cy + g.R);
      gr.addColorStop(0.15, top); gr.addColorStop(0.85, bot);
      c.strokeStyle = gr; c.lineWidth = 5; c.lineCap = 'round'; c.beginPath();
      c.arc(g.cx, g.cy, g.R, -a1 * Math.PI / 180, -a0 * Math.PI / 180); c.stroke();
    };
    arc(125, 235, hsvCss(hue, 0.95, 0.95), '#e1e1e1');
    arc(-55, 55, '#fafafa', '#46464a');
    const handle = (deg) => {
      const [ax, ay] = pt(g.R - 8, deg), [bx, by] = pt(g.R + 7 > g.R + 2 ? g.R + 2 : g.R + 7, deg);
      c.lineCap = 'round';
      c.strokeStyle = 'rgba(0,0,0,.8)'; c.lineWidth = 5; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
      c.strokeStyle = '#fafafa'; c.lineWidth = 2.6; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
    };
    handle(235 - 110 * sat / 100);
    handle(55 * lum / 100);
    const [px, py] = pt(g.ri * sat / 100, hue);
    if (sat > 0) { c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(g.cx, g.cy); c.lineTo(px, py); c.stroke(); }
    c.strokeStyle = '#000'; c.lineWidth = 3; c.beginPath(); c.arc(px, py, 6, 0, 7); c.stroke();
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.arc(px, py, 6, 0, 7); c.stroke();
  }
}

const CH_COL = { rgb: '#e6e6e6', r: '#ff5a50', g: '#4ccf5a', b: '#4f8dff' };
const CH_BG = { rgb: ['#151517', '#2a2a2e'], r: ['#1c1213', '#3a1f1f'], g: ['#121a13', '#1f3522'], b: ['#12151c', '#1f2a40'] };

export class CurveEditor {
  // o: { get: (ch) => pts, set: (ch, pts, live), begin, end, hist: () => Uint32Array(1024) | null }
  constructor(o) {
    this.o = o; this.ch = 'rgb'; this.div = 8; this.drag = -1;
    this.cv = h('canvas');
    this.el = h('div', { class: 'curvebox' }, this.cv);
    let lastTap = 0, lastPt = -1;
    const pos = (e) => { const r = this.cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
    this.cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      const pts = this.pts();
      const r = this.cv.getBoundingClientRect(), tol = 22 / r.width;
      let best = -1, bd = 1e9;
      pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
      const t = Date.now(), dbl = t - lastTap < 330;
      lastTap = t;
      if (dbl && best >= 0 && bd < tol && best === lastPt && best > 0 && best < pts.length - 1) {
        // chạm đúp vào điểm: xoá điểm
        o.begin(); pts.splice(best, 1); o.set(this.ch, pts, false); o.end(); this.draw(); return;
      }
      if (dbl && (best < 0 || bd >= tol)) { o.begin(); o.set(this.ch, [[0, 0], [1, 1]], false); o.end(); this.draw(); return; }
      o.begin();
      if (best >= 0 && bd < tol) this.drag = best;
      else {
        pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
        pts.sort((a, b) => a[0] - b[0]);
        this.drag = pts.findIndex((p) => p[0] === Math.min(1, Math.max(0, x)));
        o.set(this.ch, pts, true);
      }
      lastPt = this.drag;
      this.cv.setPointerCapture(e.pointerId);
      this.draw();
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (this.drag < 0) return;
      let [x, y] = pos(e);
      const pts = this.pts(), i = this.drag;
      // kéo điểm giữa ra ngoài khung để xoá
      if (i > 0 && i < pts.length - 1 && (y < -0.12 || y > 1.12)) { pts.splice(i, 1); this.drag = -1; o.set(this.ch, pts, true); this.draw(); return; }
      const lo = i > 0 ? pts[i - 1][0] + 0.01 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
      x = Math.min(hi, Math.max(lo, x)); y = Math.min(1, Math.max(0, y));
      pts[i] = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
      o.set(this.ch, pts, true); this.draw();
    });
    const up = () => { if (this.drag >= 0 || true) { this.drag = -1; o.end(); this.draw(); } };
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);
  }
  pts() { return JSON.parse(JSON.stringify(this.o.get(this.ch))).sort((a, b) => a[0] - b[0]); }
  setChannel(ch) { this.ch = ch; this.draw(); }
  draw() {
    const r = this.cv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = DPR(), W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    const c = this.cv.getContext('2d'), w = r.width, hh = r.height;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = c.createLinearGradient(0, hh, w, 0);
    bg.addColorStop(0, CH_BG[this.ch][0]); bg.addColorStop(1, CH_BG[this.ch][1]);
    c.fillStyle = bg; c.fillRect(0, 0, w, hh);
    const hist = this.o.hist && this.o.hist();
    if (hist) {
      const off = { rgb: 768, r: 0, g: 256, b: 512 }[this.ch];
      let mx = 1; for (let i = 0; i < 256; i++) mx = Math.max(mx, hist[off + i]);
      c.fillStyle = 'rgba(255,255,255,.10)'; c.beginPath(); c.moveTo(0, hh);
      for (let i = 0; i < 256; i++) c.lineTo(i / 255 * w, hh - Math.sqrt(hist[off + i] / mx) * hh * 0.9);
      c.lineTo(w, hh); c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,.09)'; c.lineWidth = 1;
    for (let i = 1; i < this.div; i++) {
      const x = Math.round(i / this.div * w) + 0.5, y = Math.round(i / this.div * hh) + 0.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, hh); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,.18)'; c.beginPath(); c.moveTo(0, hh); c.lineTo(w, 0); c.stroke();
    const pts = this.pts();
    const lut = curveLut(pts, 256);
    c.strokeStyle = CH_COL[this.ch]; c.lineWidth = 2; c.beginPath();
    for (let i = 0; i < 256; i++) { const y = lut ? lut[i] : i / 255; const X = i / 255 * w, Y = hh - y * hh; i ? c.lineTo(X, Y) : c.moveTo(X, Y); }
    c.stroke();
    pts.forEach(([x, y], i) => {
      c.fillStyle = i === this.drag ? CH_COL[this.ch] : '#1b1b1d';
      c.strokeStyle = CH_COL[this.ch]; c.lineWidth = 2;
      c.beginPath(); c.arc(x * w, hh - y * hh, 6, 0, 7); c.fill(); c.stroke();
    });
  }
}
