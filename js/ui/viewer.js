// Khung xem ảnh: hiển thị, chụm 2 ngón để phóng, kéo để di chuyển, giữ ngón tay để xem ảnh gốc,
// chia đôi trước / sau, cảnh báo cháy sáng, và các công cụ chạm trên ảnh (ống hút, cắt, kẻ chân trời, cọ, gradient).
import * as E from '../engine/engine.js';
import { cropRatio } from '../engine/settings.js';

export class Viewer {
  constructor(app) {
    this.app = app;
    this.vp = document.getElementById('viewer');
    this.stage = document.getElementById('stage');
    this.cv = document.getElementById('cv');
    this.ov = document.getElementById('ov');
    this.ctx = this.cv.getContext('2d');
    this.z = 1; this.tx = 0; this.ty = 0; this.fit = true;
    this.img = null;          // ImageData đang hiển thị (sau chỉnh)
    this.before = null;       // ImageData ảnh gốc (cùng khung)
    this.split = false; this.holding = false; this.clip = false;
    this.ptrs = new Map();
    this.bind();
    new ResizeObserver(() => { if (this.fit) this.fitView(); this.apply(); }).observe(this.vp);
  }

  show(rgba, w, h) {
    const id = new ImageData(rgba, w, h);
    const sizeChanged = this.cv.width !== w || this.cv.height !== h;
    if (sizeChanged) {
      const oldW = this.cv.width || w;
      this.cv.width = w; this.cv.height = h; this.ov.width = w; this.ov.height = h;
      // giữ nguyên độ phóng khi chuyển giữa bản nháp và bản xem trước
      if (!this.fit && oldW) { this.z *= oldW / w; } else this.fitView();
    }
    this.img = id;
    this.paint();
    this.apply();
  }
  paint() {
    if (!this.img) return;
    const showBefore = this.holding && this.before && this.before.width === this.img.width && this.before.height === this.img.height;
    if (this.holding || this.split) this.app.hideHi(); else this.app.scheduleHiRes();
    this.ctx.putImageData(showBefore ? this.before : this.img, 0, 0);
    if (this.split && this.before && !this.holding && this.before.width === this.img.width && this.before.height === this.img.height) {
      const w = this.img.width >> 1;
      this.ctx.putImageData(this.before, 0, 0, 0, 0, w, this.img.height);
      this.ctx.fillStyle = '#fff'; this.ctx.fillRect(w - 1, 0, 2, this.img.height);
    }
    if (this.clip && !this.holding) this.paintClip();
    const b = document.getElementById('badge');
    b.style.display = this.holding || this.split ? 'block' : 'none';
    b.textContent = this.holding ? 'Ảnh gốc (trước khi chỉnh)' : (this.split ? 'Trái: trước · Phải: sau' : '');
    this.app.drawOverlay();
  }
  paintClip() {
    const d = this.img.data, w = this.img.width, h = this.img.height;
    const o = this.ctx.getImageData(0, 0, w, h), q = o.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] >= 254 || d[i + 1] >= 254 || d[i + 2] >= 254) { q[i] = 255; q[i + 1] = 30; q[i + 2] = 30; }
      else if (d[i] <= 1 && d[i + 1] <= 1 && d[i + 2] <= 1) { q[i] = 40; q[i + 1] = 110; q[i + 2] = 255; }
    }
    this.ctx.putImageData(o, 0, 0);
  }
  fitView() {
    const r = this.vp.getBoundingClientRect(), w = this.cv.width || 1, h = this.cv.height || 1;
    const pad = 6;
    this.z = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h);
    this.tx = (r.width - w * this.z) / 2; this.ty = (r.height - h * this.z) / 2;
    this.fit = true;
  }
  apply() {
    this.stage.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.z})`;
    this.stage.style.width = this.cv.width + 'px'; this.stage.style.height = this.cv.height + 'px';
  }
  // toạ độ màn hình -> điểm ảnh trên ảnh đang hiển thị
  toImg(cx, cy) {
    const r = this.vp.getBoundingClientRect();
    return [(cx - r.left - this.tx) / this.z, (cy - r.top - this.ty) / this.z];
  }

  bind() {
    const vp = this.vp;
    let hold = null, start = null, moved = false, lastTap = 0, pinch = null;
    vp.addEventListener('pointerdown', (e) => {
      vp.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.ptrs.size === 2) {
        clearTimeout(hold); this.holding = false;
        if (this.toolActive) { this.app.toolCancel(); this.toolActive = false; }
        const [a, b] = [...this.ptrs.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, z: this.z, tx: this.tx, ty: this.ty };
        return;
      }
      if (this.ptrs.size > 2) return;
      start = [e.clientX, e.clientY, this.tx, this.ty]; moved = false;
      if (this.app.tool && this.img) {
        const p = this.toImg(e.clientX, e.clientY);
        this.toolActive = this.app.toolDown(p, e) !== false;
        if (this.toolActive) return;
      }
      if (this.img) hold = setTimeout(() => { if (!moved) { this.holding = true; this.app.needBefore(); this.paint(); } }, 380);
    });
    vp.addEventListener('pointermove', (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && this.ptrs.size >= 2) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        const r = vp.getBoundingClientRect();
        const z = Math.max(0.05, Math.min(pinch.z * d / pinch.d, 40));
        // điểm ảnh dưới tâm 2 ngón lúc đầu giữ nguyên dưới tâm hiện tại
        const ix = (pinch.cx - r.left - pinch.tx) / pinch.z, iy = (pinch.cy - r.top - pinch.ty) / pinch.z;
        this.z = z; this.tx = cx - r.left - ix * z; this.ty = cy - r.top - iy * z; this.fit = false;
        this.apply(); this.app.onZoom();
        return;
      }
      if (!start) return;
      const dx = e.clientX - start[0], dy = e.clientY - start[1];
      if (Math.hypot(dx, dy) > 8) { moved = true; clearTimeout(hold); }
      if (this.toolActive) { this.app.toolMove(this.toImg(e.clientX, e.clientY), e); return; }
      if (this.holding) return;
      if (!this.fit && moved) { this.tx = start[2] + dx; this.ty = start[3] + dy; this.apply(); this.app.onZoom(); }
    });
    const up = (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.delete(e.pointerId);
      clearTimeout(hold);
      if (pinch) { if (this.ptrs.size < 2) { pinch = null; start = null; if (this.z <= this.fitZ() * 1.02) { this.fitView(); this.apply(); this.app.onZoom(); } } return; }
      if (this.toolActive) { this.toolActive = false; this.app.toolUp(this.toImg(e.clientX, e.clientY), e); start = null; return; }
      if (this.holding) { this.holding = false; this.paint(); start = null; return; }
      if (!moved && start && this.img) {
        const t = Date.now();
        if (t - lastTap < 300) { this.toggleZoom(e.clientX, e.clientY); lastTap = 0; }
        else lastTap = t;
      }
      start = null;
    };
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect(), k = Math.exp(-e.deltaY * 0.002);
      const ix = (e.clientX - r.left - this.tx) / this.z, iy = (e.clientY - r.top - this.ty) / this.z;
      this.z *= k; this.tx = e.clientX - r.left - ix * this.z; this.ty = e.clientY - r.top - iy * this.z; this.fit = false;
      this.apply(); this.app.onZoom();
    }, { passive: false });
  }
  fitZ() {
    const r = this.vp.getBoundingClientRect();
    return Math.min((r.width - 12) / (this.cv.width || 1), (r.height - 12) / (this.cv.height || 1));
  }
  toggleZoom(cx, cy) {
    if (this.fit) {
      const r = this.vp.getBoundingClientRect();
      const [ix, iy] = this.toImg(cx, cy);
      // phóng tới 1:1 ảnh gốc (hoặc ×3 nếu ảnh xem trước nhỏ)
      const z = Math.max(this.fitZ() * 3, this.app.oneToOneZoom());
      this.z = z; this.tx = cx - r.left - ix * z; this.ty = cy - r.top - iy * z; this.fit = false;
    } else this.fitView();
    this.apply(); this.app.onZoom();
  }
}

// --------------------------------------------------------------------- vẽ lưới / khung cắt
export function drawCropOverlay(c, w, h, rect, kind, z) {
  const [x0, y0, x1, y1] = [rect[0] * w, rect[1] * h, rect[2] * w, rect[3] * h];
  c.save();
  c.fillStyle = 'rgba(0,0,0,.55)';
  c.beginPath(); c.rect(0, 0, w, h); c.rect(x0, y0, x1 - x0, y1 - y0); c.fill('evenodd');
  const lw = 1.2 / z;
  c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = lw;
  const W = x1 - x0, H = y1 - y0;
  const line = (a, b, cc, d) => { c.beginPath(); c.moveTo(a, b); c.lineTo(cc, d); c.stroke(); };
  if (kind === 'thirds' || kind === 'grid') {
    const n = kind === 'thirds' ? 3 : 6;
    for (let i = 1; i < n; i++) { line(x0 + W * i / n, y0, x0 + W * i / n, y1); line(x0, y0 + H * i / n, x1, y0 + H * i / n); }
  } else if (kind === 'golden') {
    const g = 0.382;
    for (const f of [g, 1 - g]) { line(x0 + W * f, y0, x0 + W * f, y1); line(x0, y0 + H * f, x1, y0 + H * f); }
  } else if (kind === 'diagonal') { line(x0, y0, x1, y1); line(x1, y0, x0, y1); }
  else if (kind === 'triangle') {
    const foot = (px, py) => { const vx = x1 - x0, vy = y0 - y1, t = ((px - x0) * vx + (py - y1) * vy) / (vx * vx + vy * vy); return [x0 + t * vx, y1 + t * vy]; };
    line(x0, y1, x1, y0);
    line(x0, y0, ...foot(x0, y0));
    line(x1, y1, ...foot(x1, y1));
  }
  c.strokeStyle = '#fff'; c.lineWidth = 2 / z;
  c.strokeRect(x0, y0, W, H);
  const k = 18 / z;
  c.lineWidth = 4 / z;
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    c.beginPath(); c.moveTo(cx + sx * k, cy); c.lineTo(cx, cy); c.lineTo(cx, cy + sy * k); c.stroke();
  }
  c.restore();
}

// chỉnh khung cắt theo thao tác kéo: mode = 'move' | tổ hợp 'l','r','t','b'
export function dragCrop(r0, mode, dx, dy, ratio, W, H) {
  let [x0, y0, x1, y1] = r0;
  const minS = 0.04;
  if (mode === 'move') {
    const w = x1 - x0, h = y1 - y0;
    x0 = Math.min(Math.max(0, x0 + dx), 1 - w); y0 = Math.min(Math.max(0, y0 + dy), 1 - h);
    return [x0, y0, x0 + w, y0 + h];
  }
  if (mode.includes('l')) x0 = Math.min(x1 - minS, Math.max(0, x0 + dx));
  if (mode.includes('r')) x1 = Math.max(x0 + minS, Math.min(1, x1 + dx));
  if (mode.includes('t')) y0 = Math.min(y1 - minS, Math.max(0, y0 + dy));
  if (mode.includes('b')) y1 = Math.max(y0 + minS, Math.min(1, y1 + dy));
  if (ratio) {
    // giữ tỉ lệ (trong điểm ảnh): ưu tiên chiều đang kéo
    const want = ratio * H / W;          // (x1-x0)/(y1-y0) theo toạ độ chuẩn hoá
    let w = x1 - x0, h = y1 - y0;
    if (mode === 't' || mode === 'b') w = h * want; else h = w / want;
    if (w > 1) { w = 1; h = w / want; }
    if (h > 1) { h = 1; w = h * want; }
    if (mode.includes('l')) x0 = x1 - w; else x1 = x0 + w;
    if (mode.includes('t')) y0 = y1 - h; else y1 = y0 + h;
    if (mode === 't' || mode === 'b') { const c = (r0[0] + r0[2]) / 2; x0 = c - w / 2; x1 = c + w / 2; }
    if (x0 < 0) { x1 -= x0; x0 = 0; } if (x1 > 1) { x0 -= x1 - 1; x1 = 1; }
    if (y0 < 0) { y1 -= y0; y0 = 0; } if (y1 > 1) { y0 -= y1 - 1; y1 = 1; }
  }
  return [x0, y0, x1, y1];
}

// khung cắt mặc định theo tỉ lệ (giữa ảnh, lớn nhất)
export function rectForRatio(name, W, H) {
  const r = cropRatio(name);
  if (!r) return [0, 0, 1, 1];
  if (W / H > r) { const nw = H * r / W; return [(1 - nw) / 2, 0, (1 + nw) / 2, 1]; }
  const nh = W / r / H; return [0, (1 - nh) / 2, 1, (1 + nh) / 2];
}

export { E };
