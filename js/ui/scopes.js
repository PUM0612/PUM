// Biểu đồ (scopes.py bản máy tính): Histogram, Parade, Waveform, Vectorscope — tính trên ảnh đang hiển thị.
import { h } from './controls.js';

export class Scopes {
  constructor() {
    this.mode = 'hist';
    this.cv = h('canvas', { style: 'width:100%;height:200px;display:block;border-radius:8px;background:#111113' });
    this.el = h('div', {}, this.cv);
  }
  draw(img) {
    if (!img) return;
    const r = this.cv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    const c = this.cv.getContext('2d');
    c.fillStyle = '#111113'; c.fillRect(0, 0, W, H);
    const d = img.data, iw = img.width, ih = img.height;
    const step = Math.max(1, Math.floor(Math.sqrt(iw * ih / 160000)));
    c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, H * i / 4); c.lineTo(W, H * i / 4); c.stroke(); }
    if (this.mode === 'hist') {
      const hs = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
      for (let y = 0; y < ih; y += step) for (let x = 0; x < iw; x += step) {
        const i = (y * iw + x) * 4;
        hs[0][d[i]]++; hs[1][d[i + 1]]++; hs[2][d[i + 2]]++; hs[3][Math.round(d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722)]++;
      }
      let mx = 1; for (const hh of hs.slice(0, 3)) for (let i = 1; i < 255; i++) mx = Math.max(mx, hh[i]);
      c.globalCompositeOperation = 'lighter';
      ['rgba(255,60,60,.55)', 'rgba(60,220,80,.55)', 'rgba(70,120,255,.6)', 'rgba(200,200,200,.25)'].forEach((col, k) => {
        c.fillStyle = col; c.beginPath(); c.moveTo(0, H);
        for (let i = 0; i < 256; i++) c.lineTo(i / 255 * W, H - Math.min(1, hs[k][i] / mx) * H * 0.95);
        c.lineTo(W, H); c.fill();
      });
      c.globalCompositeOperation = 'source-over';
      const tot = hs[3].reduce((s, v) => s + v, 0);
      c.fillStyle = '#aaa'; c.font = `${11 * dpr}px sans-serif`;
      c.fillText(`Cháy sáng ${(hs[3][255] / tot * 100).toFixed(1)}% · Mất chi tiết tối ${(hs[3][0] / tot * 100).toFixed(1)}%`, 6 * dpr, 14 * dpr);
    } else if (this.mode === 'wave' || this.mode === 'parade') {
      const o = c.createImageData(W, H), q = o.data;
      const par = this.mode === 'parade';
      const acc = new Float32Array(W * H * 3);
      for (let y = 0; y < ih; y += step) for (let x = 0; x < iw; x += step) {
        const i = (y * iw + x) * 4;
        if (par) {
          for (let k = 0; k < 3; k++) {
            const X = Math.min(W - 1, Math.floor((k + x / iw) * W / 3)), Y = H - 1 - Math.floor(d[i + k] / 255 * (H - 1));
            acc[(Y * W + X) * 3 + k] += 1;
          }
        } else {
          const X = Math.min(W - 1, Math.floor(x / iw * W)), L = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
          const Y = H - 1 - Math.floor(L / 255 * (H - 1));
          acc[(Y * W + X) * 3] += 1; acc[(Y * W + X) * 3 + 1] += 1; acc[(Y * W + X) * 3 + 2] += 1;
        }
      }
      const gain = 255 * 0.5 * (W * H) / ((iw / step) * (ih / step)) * (par ? 1 : 0.6);
      for (let p = 0; p < W * H; p++) {
        q[p * 4] = Math.min(255, acc[p * 3] * gain + 17); q[p * 4 + 1] = Math.min(255, acc[p * 3 + 1] * gain + 17); q[p * 4 + 2] = Math.min(255, acc[p * 3 + 2] * gain + 19); q[p * 4 + 3] = 255;
      }
      c.putImageData(o, 0, 0);
    } else {
      // vectorscope: Cb (ngang) / Cr (dọc), đường tông da ~123°
      const S = Math.min(W, H), cx = W / 2, cy = H / 2, R = S / 2 - 6;
      c.strokeStyle = 'rgba(255,255,255,.15)'; c.beginPath(); c.arc(cx, cy, R, 0, 7); c.stroke();
      c.beginPath(); c.arc(cx, cy, R / 2, 0, 7); c.stroke();
      const a = -123 * Math.PI / 180;
      c.strokeStyle = 'rgba(240,170,110,.6)'; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); c.stroke();
      const o = c.getImageData(0, 0, W, H), q = o.data;
      for (let y = 0; y < ih; y += step) for (let x = 0; x < iw; x += step) {
        const i = (y * iw + x) * 4, r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        const Y = 0.299 * r0 + 0.587 * g0 + 0.114 * b0, cb = (b0 - Y) * 0.564, cr = (r0 - Y) * 0.713;
        const X = Math.round(cx + cb / 128 * R * 1.6), Yp = Math.round(cy - cr / 128 * R * 1.6);
        if (X < 0 || Yp < 0 || X >= W || Yp >= H) continue;
        const p = (Yp * W + X) * 4;
        q[p] = Math.min(255, q[p] + r0 * 0.25 + 10); q[p + 1] = Math.min(255, q[p + 1] + g0 * 0.25 + 10); q[p + 2] = Math.min(255, q[p + 2] + b0 * 0.25 + 10);
      }
      c.putImageData(o, 0, 0);
    }
  }
}
