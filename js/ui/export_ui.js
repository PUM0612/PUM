// Bảng Xuất ảnh: cỡ (gốc / cạnh dài), chất lượng JPEG, watermark chữ / logo, chân ảnh (dải thông tin + logo)
// như dialogs.py bản máy tính. Xuất theo dải trong worker, sau đó "Lưu về Ảnh" (bảng Chia sẻ của iPhone).
import { h, btn, hint, Slider, toggle, select } from './controls.js';
import { store } from '../store.js';
import { drawScaled, shareOrDownload } from '../app.js';

const DEF = {
  long_edge: 0, quality: 92, format: 'JPG',
  watermark: { enabled: false, mode: 'text', text: '© PUM', size: 15, margin: 3, opacity: 70, pos: 'br', color: '#ffffff', logo: null },
  footer: { enabled: false, height: 8, color: '#ffffff', text_color: '#222222', text: '', subtext: '', text_right: '', logo: null },
};
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

export async function loadOpts() {
  const o = (await store.get('export_opts').catch(() => null)) || {};
  return {
    long_edge: o.long_edge ?? DEF.long_edge, quality: o.quality ?? DEF.quality, format: 'JPG',
    watermark: Object.assign({}, DEF.watermark, o.watermark || {}), footer: Object.assign({}, DEF.footer, o.footer || {}),
  };
}

async function imgFromDataUrl(u) {
  if (!u) return null;
  const im = new Image(); im.src = u; await im.decode(); return im;
}
function hexRgb(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m) return [255, 255, 255]; const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; }

// dấu watermark (RGBA đã nhân độ mờ) + vị trí, theo engine.apply_overlays
async function makeWatermark(wm, W, H) {
  if (!wm.enabled) return null;
  const size = W * wm.size / 100, margin = Math.trunc(Math.min(W, H) * wm.margin / 100), op = wm.opacity / 100;
  let c;
  if (wm.mode === 'logo') {
    const im = await imgFromDataUrl(wm.logo);
    if (!im) return null;
    const k = Math.min(1, size / im.width, size / im.height);
    c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
    const x = c.getContext('2d'); x.globalAlpha = op; x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, c.width, c.height);
  } else {
    const text = wm.text || ''; if (!text) return null;
    const fs = Math.max(6, Math.trunc(size / Math.max(4, text.length) * 1.8));
    c = document.createElement('canvas');
    let x = c.getContext('2d'); x.font = `bold ${fs}px ${FONT}`;
    const m = x.measureText(text);
    c.width = Math.ceil(m.width) + 4; c.height = Math.ceil(fs * 1.25) + 4;
    x = c.getContext('2d'); x.font = `bold ${fs}px ${FONT}`; x.textBaseline = 'top';
    x.fillStyle = wm.color || '#ffffff'; x.globalAlpha = op; x.fillText(text, 2, 2);
  }
  const mw = c.width, mh = c.height, pos = wm.pos || 'br';
  const px = { l: margin, c: Math.floor((W - mw) / 2), r: W - mw - margin }[pos.length > 1 ? pos[1] : 'c'];
  const py = { t: margin, c: Math.floor((H - mh) / 2), b: H - mh - margin }[pos[0]];
  return { x: px, y: py, w: mw, h: mh, rgba: c.getContext('2d').getImageData(0, 0, mw, mh).data };
}

async function makeFooter(ft, W, H) {
  if (!ft.enabled) return null;
  const bar = Math.max(10, Math.trunc(H * ft.height / 100));
  const c = document.createElement('canvas'); c.width = W; c.height = bar;
  const x = c.getContext('2d');
  x.fillStyle = ft.color || '#ffffff'; x.fillRect(0, 0, W, bar);
  const pad = Math.trunc(bar * 0.35), tcol = ft.text_color || '#222222';
  let right = W - pad;
  const logo = await imgFromDataUrl(ft.logo);
  if (logo) {
    const k = Math.min(W * 0.4 / logo.width, bar * 0.7 / logo.height, 1e9);
    const lw = Math.round(logo.width * k), lh = Math.round(logo.height * k), lx = W - pad - lw;
    x.imageSmoothingQuality = 'high'; x.drawImage(logo, lx, Math.floor((bar - lh) / 2), lw, lh);
    right = lx - pad;
  }
  x.textBaseline = 'alphabetic';
  if (ft.text) {
    const f1 = Math.max(6, Math.trunc(bar * (ft.subtext ? 0.32 : 0.4)));
    x.font = `bold ${f1}px ${FONT}`; x.fillStyle = tcol;
    if (ft.subtext) {
      const f2 = Math.max(6, Math.trunc(bar * 0.22));
      const total = f1 * 0.75 + f2 * 0.75 + bar * 0.08, ty = (bar - total) / 2;
      x.fillText(ft.text, pad, ty + f1 * 0.75);
      const [r, g, b] = hexRgb(tcol).map((v) => Math.round(v * 0.7 + 255 * 0.3 * (v < 128)));
      x.font = `${f2}px ${FONT}`; x.fillStyle = `rgb(${r},${g},${b})`;
      x.fillText(ft.subtext, pad, ty + f1 * 0.75 + bar * 0.08 + f2 * 0.75);
    } else x.fillText(ft.text, pad, (bar + f1 * 0.7) / 2);
  }
  if (ft.text_right && !logo) {
    const f3 = Math.max(6, Math.trunc(bar * 0.3));
    x.font = `${f3}px ${FONT}`; x.fillStyle = tcol; x.textAlign = 'right';
    x.fillText(ft.text_right, right, (bar + f3 * 0.7) / 2);
  }
  return { w: W, h: bar, rgba: x.getImageData(0, 0, W, bar).data };
}

export function openExportOptions(app, back) { return openExportSheet(app, { optionsOnly: true, back }); }

export async function openExportSheet(app, mode = {}) {
  const o = await loadOpts();
  const save = () => store.set('export_opts', JSON.parse(JSON.stringify(o))).catch(() => {});
  const noHist = { begin() {}, end() {} };
  const S = (label, obj, key, lo, hi, def, step = 1) => { const s = new Slider(noHist, { label, lo, hi, def, step, get: () => obj[key], set: (v) => { obj[key] = v; save(); } }); s.sync(); return s; };
  const size = select('Kích thước', [['0', 'Cỡ gốc'], ['4096', 'Cạnh dài 4096 px'], ['3000', 'Cạnh dài 3000 px'], ['2048', 'Cạnh dài 2048 px (mạng xã hội)'], ['1600', 'Cạnh dài 1600 px']],
    () => o.long_edge, (v) => { o.long_edge = +v; save(); info(); });
  size.sync();
  const infoEl = h('div', { class: 'hint' });
  const info = () => {
    const sz = app.outputSize(); if (!sz || mode.optionsOnly) { infoEl.textContent = ''; return; } const [w, hh] = sz;
    const k = o.long_edge && Math.max(w, hh) > o.long_edge ? o.long_edge / Math.max(w, hh) : 1;
    infoEl.textContent = `Ảnh ra: ${Math.round(w * k)} × ${Math.round(hh * k)} px (${(w * k * hh * k / 1e6).toFixed(1)} MP), JPEG`;
  };
  info();
  const wm = o.watermark, ft = o.footer;
  const tg = (label, obj, key) => { const t = toggle(label, () => obj[key], (v) => { obj[key] = v; save(); }); t.sync(); return t; };
  const txt = (label, obj, key, ph) => {
    const i = h('input', { type: 'text', class: 'grow', placeholder: ph || '' }); i.value = obj[key] || '';
    i.addEventListener('change', () => { obj[key] = i.value; save(); });
    return h('div', { class: 'row' }, h('label', {}, label), i);
  };
  const col = (label, obj, key) => {
    const i = h('input', { type: 'color', style: 'width:52px;height:32px;padding:0' }); i.value = obj[key];
    i.addEventListener('input', () => { obj[key] = i.value; save(); });
    return h('div', { class: 'row' }, h('label', { class: 'grow' }, label), i);
  };
  const logoBtn = (obj, label) => {
    const b = btn(obj.logo ? 'Đổi logo ✓' : label, () => {
      const inp = document.getElementById('fileLogo');
      inp.onchange = () => {
        const f = inp.files[0]; inp.value = ''; if (!f) return;
        const r = new FileReader();
        r.onload = () => { obj.logo = r.result; save(); b.textContent = 'Đổi logo ✓'; };
        r.readAsDataURL(f);
      };
      inp.click();
    });
    return b;
  };
  const wmMode = select('Kiểu', [['text', 'Chữ'], ['logo', 'Logo (ảnh PNG)']], () => wm.mode, (v) => { wm.mode = v; save(); }); wmMode.sync();
  const wmPos = select('Vị trí', [['br', 'Dưới phải'], ['bl', 'Dưới trái'], ['bc', 'Dưới giữa'], ['tr', 'Trên phải'], ['tl', 'Trên trái'], ['tc', 'Trên giữa'], ['cc', 'Giữa ảnh']],
    () => wm.pos, (v) => { wm.pos = v; save(); }); wmPos.sync();
  const prog = h('div', { class: 'prog' }, h('div'));
  const status = h('div', { class: 'hint' });
  const go = h('button', { class: 'big', style: 'width:100%;margin-top:10px' }, 'Xuất ảnh');
  const saveBtn = h('button', { class: 'big', style: 'width:100%;margin-top:8px;display:none' }, 'Lưu về Ảnh');
  let result = null;
  saveBtn.onclick = () => result && shareOrDownload(result.blob, result.name, app);
  go.onclick = async () => {
    go.disabled = true; saveBtn.style.display = 'none'; status.textContent = 'Đang xuất…';
    try {
      result = await runExport(app, o, (p) => { prog.firstChild.style.width = (p * 100).toFixed(0) + '%'; });
      status.textContent = `Xong: ${result.w} × ${result.h} px, ${(result.blob.size / 1048576).toFixed(1)} MB, ${(result.ms / 1000).toFixed(1)} giây. Bấm "Lưu về Ảnh" rồi chọn "Lưu hình ảnh".`;
      saveBtn.style.display = '';
    } catch (e) { console.error(e); status.textContent = 'Xuất lỗi: ' + e.message; }
    go.disabled = false;
  };
  const q = S('Chất lượng JPEG', o, 'quality', 50, 100, 92);
  app.openSheet(mode.optionsOnly ? 'Cài đặt xuất' : 'Xuất ảnh', h('div', {},
    size.el, infoEl, q.el,
    h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 't' }, 'Watermark')),
      tg('Thêm watermark', wm, 'enabled').el, wmMode.el, txt('Chữ', wm, 'text', '© Tên của anh/chị'), col('Màu chữ', wm, 'color'),
      h('div', { class: 'row' }, logoBtn(wm, 'Chọn logo PNG')), wmPos.el,
      S('Cỡ (% bề rộng)', wm, 'size', 2, 60, 15).el, S('Độ mờ đục', wm, 'opacity', 5, 100, 70).el, S('Lề (%)', wm, 'margin', 0, 20, 3).el),
    h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 't' }, 'Chân ảnh (dải thông tin + logo)')),
      tg('Thêm chân ảnh', ft, 'enabled').el, txt('Dòng chính', ft, 'text', 'Tên studio / sự kiện'), txt('Dòng phụ', ft, 'subtext', 'SĐT, địa chỉ, ngày...'),
      txt('Chữ bên phải', ft, 'text_right', '(khi không có logo)'), h('div', { class: 'row' }, logoBtn(ft, 'Chọn logo chân ảnh'), btn('Bỏ logo', () => { ft.logo = null; save(); })),
      S('Chiều cao (% ảnh)', ft, 'height', 3, 25, 8).el, col('Màu nền', ft, 'color'), col('Màu chữ', ft, 'text_color')),
    ...(mode.optionsOnly ? [h('button', { class: 'big', style: 'width:100%;margin-top:10px', onclick: () => mode.back && mode.back() }, 'Xong')] : [go, prog, status, saveBtn]),
    hint('Ảnh xuất cỡ gốc được dựng theo từng dải và mã hoá JPEG ngay, nên xuất được ảnh 24–60 MP trên iPhone.')));
}

export function runExport(app, opts, onProg, photoArg) {
  const job = 'j' + Date.now().toString(36);
  const t0 = performance.now();
  const p = photoArg || { id: app.cur.id, name: app.cur.name, settings: app.s, bitmap: app.bitmap, W: app.fullW, H: app.fullH };
  return new Promise((res, rej) => {
    const chunks = [];
    let outW = 0, outH = 0;
    const done = () => app.jobs.delete(job);
    app.jobs.set(job, async (m) => {
      try {
        if (m.type === 'export_size') {
          outW = m.w; outH = m.h;
          const wm = await makeWatermark(opts.watermark, m.w, m.h);
          const footer = await makeFooter(opts.footer, m.w, m.h);
          app.worker.postMessage({ type: 'export_band', job, wm, footer });
        } else if (m.type === 'export_src') {
          const [sx, sy, sw, sh] = m.rect;
          const rgba = drawScaled(p.bitmap, sx, sy, sw, sh, m.tw, m.th);
          app.worker.postMessage({ type: 'export_band', job, rgba }, [rgba.buffer]);
        } else if (m.type === 'export_chunk') {
          chunks.push(m.bytes);
          if (m.progress != null && onProg) onProg(m.progress);
        } else if (m.type === 'export_done') {
          done();
          if (m.error) return rej(new Error(m.error));
          const blob = new Blob(chunks, { type: 'image/jpeg' });
          const name = p.name.replace(/\.[^.]+$/, '') + '_PUM.jpg';
          res({ blob, name, w: m.w, h: m.h, ms: performance.now() - t0 });
        }
      } catch (e) { done(); rej(e); }
    });
    app.worker.postMessage({ type: 'export_start', job, id: p.id, settings: JSON.parse(JSON.stringify(p.settings)), W: p.W, H: p.H,
      opts: { long_edge: opts.long_edge, quality: opts.quality } });
  });
}
