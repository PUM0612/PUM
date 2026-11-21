// PUM cho iPhone — bộ điều khiển chính.
import { store } from './store.js';
import { Panels } from './ui/panels.js';
import { Viewer, drawCropOverlay, dragCrop, rectForRatio } from './ui/viewer.js';
import { h, btn, hint, Slider, toggle, select } from './ui/controls.js';
import * as S from './engine/settings.js';
import * as E from './engine/engine.js';
import { VERSION, BUILD_DATE, NOTES } from './version.js';
import { openExportSheet } from './ui/export_ui.js';
import { decodeFile, decodeQuick, isRawName } from './decode.js';
import { portraitActive, faceBoxes } from './engine/portrait.js';
import { XoaAI, MODEL_BYTES } from './xoa_ai.js';

const PREVIEW_SIDE = 1600, DRAFT_SIDE = 640, THUMB = 240;
const XV_VARIANTS = 4;          // số cách lấp của Xoá vật thể AI (xoa_vat.js VARIANTS)
// Đặt lại nhiều mức (main.py GEOM_KEYS / RESET_KINDS) + khoá của từng tab (panels.reset_tab)
const GEOM_KEYS = ['rotate', 'straighten', 'crop', 'crop_rect', 'flip', 'lens', 'crop_outside'];
const RESET_KINDS = { all: 'Đặt lại toàn bộ', color_tone: 'Đặt lại màu & tông', geometry: 'Đặt lại khung cắt / xoay / ống kính',
  retouch: 'Xoá retouch', portrait: 'Đặt lại chân dung', layers: 'Xoá mọi layer' };
const TAB_KEYS = {
  basic: ['temp', 'tint', 'vibrance', 'saturation', 'exposure', 'contrast', 'brightness', 'highlights', 'shadows', 'whites', 'blacks',
    'texture', 'clarity', 'dehaze'],
  color: ['color', 'color_adv', 'skin', 'calib'], grading: ['grading'], curve: ['curve'],
  detail: ['sharpen', 'sharpen_radius', 'nr_lum', 'nr_lum_detail', 'nr_lum_contrast', 'nr_color', 'nr_color_detail', 'nr_color_smooth',
    'vignette', 'grain', 'grain_size'],
  lens: GEOM_KEYS, layer: ['layers'], retouch: [], portrait: [],
};
const TABS_LABEL = { basic: 'Cơ bản', color: 'Màu', grading: 'Grading', curve: 'Curve', detail: 'Chi tiết', lens: 'Khung', layer: 'Layer',
  retouch: 'Retouch', portrait: 'Chân dung' };
const $ = (id) => document.getElementById(id);
const deep = S.deepCopy;
const J = JSON.stringify;

class App {
  constructor() {
    this.photos = [];
    this.cur = null;
    this.s = S.defaultSettings();
    this.histories = new Map();
    this.tool = null;
    this.layerIdx = -1;
    this.brushSize = 3;
    this.radialFeather = 50;
    this.cropOverlay = 'thirds';
    this.cropLock = false;
    this.showMask = false;
    this.styleStrength = 100;
    this.styleApplied = null;
    this.userStyles = [];
    this.wbMode = null;
    this.rtSize = 2; this.rtHard = 60; this.rtOpacity = 100; this.protSize = 3;
    this.selArea = -1; this.selSpot = -1; this.cloneSrc = null; this.cloneOff = null;
    this._depth = 0;
    this.req = 0; this.pending = new Map(); this.jobs = new Map();
    this.worker = new Worker(new URL('./workers/render.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => this.toast('Lỗi luồng dựng ảnh: ' + (e.message || e));
    this.ai = new XoaAI();          // mô hình AI Xoá vật thể (tải khi người dùng đồng ý)
    this.viewer = new Viewer(this);
    this.panels = new Panels(this);
    this.bindUi();
    this.init();
  }

  // ----------------------------------------------------------------- worker
  call(type, data, transfer) {
    const req = ++this.req;
    return new Promise((res, rej) => {
      this.pending.set(req, { res, rej });
      this.worker.postMessage(Object.assign({ type, req }, data), transfer || []);
    });
  }
  onWorker(m) {
    if (m.type === 'xv_run' || m.type === 'xv_get' || m.type === 'xv_put' || m.type === 'xv_progress') { this.xvMsg(m); return; }
    if (m.type && (m.type.startsWith('export_') || m.type === 'roi_done' || m.type === 'xv_done')) { const f = this.jobs.get(m.job); if (f) f(m); return; }
    const p = this.pending.get(m.req);
    if (!p) return;
    this.pending.delete(m.req);
    if (m.error) { console.error(m.error); p.rej(new Error(m.error)); } else p.res(m);
  }

  // ----------------------------------------------------------------- khởi động
  async init() {
    store.persist();
    await this.xvSync();            // có mô hình AI xoá vật thể trên máy chưa (báo cho luồng dựng)
    try {
      this.photos = (await store.photos()) || [];
      this.photos.sort((a, b) => a.added - b.added);
      this.userStyles = (await store.styles()) || [];
      const prefs = (await store.get('prefs')) || {};
      Object.assign(this, { cropOverlay: prefs.cropOverlay || 'thirds' });
    } catch (e) { this.toast('Không mở được bộ nhớ của app: ' + e.message); }
    this.renderStrip();
    const last = await store.get('last').catch(() => null);
    const p = this.photos.find((x) => x.id === last) || this.photos[this.photos.length - 1];
    if (p) this.openPhoto(p);
    else this.refresh();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      const hadController = !!navigator.serviceWorker.controller;     // lần mở đầu tiên: chưa có bản cũ -> không báo
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw && nw.addEventListener('statechange', () => {
            if (hadController && !this._updToast && (nw.state === 'installed' || nw.state === 'activated') && (this._updToast = true)) this.toast('Đã có bản PUM mới — đóng hẳn app rồi mở lại để dùng bản mới.', 6000);
          });
        });
      }).catch(() => {});
    }
  }

  bindUi() {
    $('btnOpen2').onclick = () => $('file').click();
    $('file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; this.importFiles(f); };
    $('btnUndo').onclick = () => this.undo();
    $('btnRedo').onclick = () => this.redo();
    $('btnCompare').onclick = () => { this.viewer.split = !this.viewer.split; $('btnCompare').classList.toggle('on', this.viewer.split); if (this.viewer.split) this.needBefore(); this.viewer.paint(); };
    $('btnExport').onclick = () => this.cur ? openExportSheet(this) : this.toast('Chưa mở ảnh nào');
    $('btnMenu').onclick = () => this.openMenu();
    $('title').onclick = () => this.openLibrary();
    $('sheetClose').onclick = () => this.closeSheet();
    $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') this.closeSheet(); });
    // lưu ngay khi app bị ẩn / đóng (vuốt thoát, chuyển app) — không đợi hẹn giờ lưu
    const flush = () => { clearTimeout(this._sv); this.saveCurrent(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    });
  }

  toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), ms);
  }
  busy(on) { $('busy').classList.toggle('show', !!on); }

  // ----------------------------------------------------------------- nhập ảnh
  async importFiles(files) {
    if (!files.length) return;
    this.busy(true);
    let first = null, n = 0;
    for (const f of files) {
      try {
        const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const dec = isRawName(f.name) ? await decodeQuick(f) : await decodeFile(f);   // RAW: thumbnail từ ảnh nhúng cho nhanh
        const thumb = await this.makeThumb(dec.src);
        const p = { id, name: f.name, size: f.size, type: f.type, added: Date.now(), w: dec.src.width, h: dec.src.height,
          settings: null, thumb, rating: 0, flag: 0, label: '', rawPreview: dec.rawPreview || false };
        dec.src.close && dec.src.close();
        await store.putFile(id, f);
        await store.putPhoto(p);
        this.photos.push(p);
        first = first || p; n++;
        this.renderStrip();
      } catch (e) {
        console.error(e);
        this.toast(`Không mở được ${f.name}: ${(e && e.message) || 'lỗi bộ nhớ'}`, 4000);
      }
    }
    this.busy(false);
    if (first) { this.openPhoto(first); this.toast(`Đã mở ${n} ảnh`); }
  }
  async makeThumb(bmp, srcCanvas) {
    const src = srcCanvas || bmp;
    const k = THUMB / Math.max(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * Math.min(1, k))); c.height = Math.max(1, Math.round(src.height * Math.min(1, k)));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    if (src.region) x.putImageData(new ImageData(src.region(0, 0, src.width, src.height, c.width, c.height), c.width, c.height), 0, 0);
    else x.drawImage(src, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  }

  renderStrip() {
    const st = $('strip');
    st.replaceChildren();
    if (!this.photos.length) return;
    for (const p of this.photos) {
      const im = h('img', { alt: '' });
      if (p.thumb) { if (!p._url) p._url = URL.createObjectURL(p.thumb); im.src = p._url; }
      st.append(h('div', { class: 'th' + (this.cur && this.cur.id === p.id ? ' cur' : ''), onclick: () => this.openPhoto(p) }, im,
        p.settings && !S.isDefault(p.settings) ? h('span', { class: 'ed' }) : null));
    }
    st.append(h('button', { class: 'add', onclick: () => $('file').click() }, '+'));
    const c = st.querySelector('.cur');
    if (c) c.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  // ----------------------------------------------------------------- mở ảnh
  async openPhoto(p) {
    if (this.cur && this.cur.id === p.id && this.bitmap) return;
    await this.saveCurrent();
    const myOpen = (this._open = (this._open || 0) + 1);
    this.busy(true);
    try {
      const t0 = performance.now();
      const blob = await store.getFile(p.fileId || p.id);
      if (!blob) throw new Error('mất tệp ảnh trong bộ nhớ app');
      const dec = await decodeFile(blob, p.name);
      if (myOpen !== this._open) { dec.src.close && dec.src.close(); return; }
      if (this.bitmap && this.bitmap.close) this.bitmap.close();
      this.bitmap = dec.src;
      this.decWay = dec.apple ? 'Apple (Safari) — ảnh ProRAW của iPhone' : dec.libraw ? 'LibRaw (như PUM máy tính)' : dec.rawPreview ? 'ảnh xem trước nhúng trong RAW' : 'Safari';
      this.cur = p;
      this.fullW = dec.src.width; this.fullH = dec.src.height;
      const k = Math.min(1, PREVIEW_SIDE / Math.max(this.fullW, this.fullH));
      const pw = Math.max(1, Math.round(this.fullW * k)), ph = Math.max(1, Math.round(this.fullH * k));
      const rgba = drawScaled(dec.src, 0, 0, this.fullW, this.fullH, pw, ph);
      this.pw = pw; this.ph = ph;
      this.baseRGBA = rgba.slice();           // giữ bản sao cho AI (tách người / khuôn mặt)
      this.personFor = null; this.facesFor = null; this.faces = null;
      await this.call('base', { id: p.id, rgba, w: pw, h: ph, fullW: this.fullW, fullH: this.fullH, draftSide: DRAFT_SIDE, photo: photoKey(p) }, [rgba.buffer]);
      this.openMs = performance.now() - t0;
      this.s = S.mergeSettings(p.settings);
      if (!this.histories.has(p.id)) this.histories.set(p.id, { stack: [{ label: 'Mở ảnh', s: J(this.s) }], idx: 0 });
      this.layerIdx = this.s.layers.length ? 0 : -1;
      this.styleApplied = null; this.wbMode = null;
      this.viewer.before = null;
      this.viewer.fit = true;
      $('title').textContent = p.name + (dec.rawPreview ? ' (ảnh xem trước nhúng trong RAW)' : '');
      if (dec.rawPreview) this.toast('Chưa giải mã được RAW này đầy đủ — đang dùng ảnh xem trước nhúng trong tệp', 5000);
      $('empty').style.display = 'none';
      store.set('last', p.id);
      this.renderStrip();
      this.refresh();
      this.requestRender(false, true);
      if (this.s.layers.some((l) => l.person)) this.ensurePerson();
      if (portraitActive(this.s.retouch.portrait) || this.panels.cur === 'portrait') this.ensureFaces();
    } catch (e) {
      console.error(e);
      this.toast('Không mở được ảnh: ' + e.message, 4000);
    } finally { this.busy(false); }
  }

  async saveCurrent() {
    if (!this.cur) return;
    const p = this.cur;
    const st = S.isDefault(this.s) ? null : deep(this.s);
    if (J(p.settings) === J(st)) return;
    p.settings = st;
    try { await store.putPhoto(p); } catch (e) { this.toast('Không lưu được: ' + e.message); }
  }
  saveSoon() {
    // thông số lưu NGAY (ghi IndexedDB rất nhẹ) — đóng / tải lại app ngay sau khi chỉnh vẫn không mất;
    // chỉ thumbnail + dải ảnh là cập nhật sau một nhịp
    this.saveCurrent();
    clearTimeout(this._sv);
    this._sv = setTimeout(() => { this.updateThumb(); this.renderStrip(); }, 600);
  }
  async updateThumb() {
    if (!this.cur || !this.viewer.img || this.tool === 'crop') return;
    const c = document.createElement('canvas');
    c.width = this.viewer.img.width; c.height = this.viewer.img.height;
    c.getContext('2d').putImageData(this.viewer.img, 0, 0);
    const t = await this.makeThumb(null, c);
    const p = this.cur;
    const old = p._url;
    p.thumb = t; p._url = null;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);     // đợi ảnh cũ trên dải ảnh được thay xong
    store.putPhoto(p).catch(() => {});
  }

  // ----------------------------------------------------------------- thông số
  resolve(path) { return path.map((k) => (typeof k === 'function' ? k() : k)); }
  get(path) {
    let o = this.s;
    for (const k of this.resolve(path)) { if (o == null) return undefined; o = o[k]; }
    return o;
  }
  set(path, v, live) {
    const p = this.resolve(path);
    if (p.some((k) => k == null || k === -1)) return;
    let o = this.s;
    for (let i = 0; i < p.length - 1; i++) { if (o[p[i]] == null) o[p[i]] = {}; o = o[p[i]]; }
    o[p[p.length - 1]] = deep(v);
    if (p[0] === 'temp' || p[0] === 'tint') this.wbMode = 'custom';
    if (!this._depth) { this.pushHistory('Chỉnh'); this.saveSoon(); }
    this.requestRender(!!live);
    if (!live) this.panels.sync();
  }
  begin(label) {
    if (!this._depth) this._began = { label, before: J(this.s) };
    this._depth++;
  }
  end() {
    if (!this._depth) return;
    this._depth--;
    if (this._depth) return;
    const b = this._began; this._began = null;
    if (b && J(this.s) !== b.before) { this.pushHistory(b.label); this.saveSoon(); }
    this.requestRender(false);
    this.panels.sync();
  }
  resetPaths(paths, label) {
    const d = S.defaultSettings();
    this.begin(label || 'Đặt lại');
    for (const path of paths) {
      const p = this.resolve(path);
      if (p[0] === 'layers') { const ly = this.curLayer(); if (!ly) continue; const nl = S.newLayer(); let o = nl; for (const k of p.slice(2)) o = o?.[k]; this.set(path, o ?? 0); continue; }
      let o = d; for (const k of p) o = o?.[k];
      this.set(path, o === undefined ? null : o);
    }
    this.end();
  }
  refresh() { this.panels.sync(); this.updateUndo(); this.drawOverlay(); }
  // Color Editor nâng cao: thêm / xoá dải màu (panels.add_color_range / remove_color_range)
  addColorRange(hue, sat) {
    if (!this.cur) return;
    this.begin('Thêm dải màu');
    const rs = (this.s.color_adv || []).concat([E.newColorRange(hue, sat)]);
    this.set(['color_adv'], rs);
    this.panels.cadv = rs.length - 1;
    this.end();
  }
  removeColorRange() {
    const rs = this.s.color_adv || [], i = this.panels.cadv;
    if (!(i >= 0 && i < rs.length)) return;
    this.begin('Xoá dải màu');
    this.set(['color_adv'], rs.filter((_, k) => k !== i));
    this.panels.cadv = Math.min(i, rs.length - 2);
    this.end();
  }
  // thông số gửi đi dựng: thêm khoá tạm "xem vùng chọn" của dải màu (không lưu vào ảnh)
  renderSettings() {
    const s = deep(this.s), k = this.panels && this.panels.cadvShowIndex();
    if (k !== null && k !== undefined) s._cadv_show = k;
    return s;
  }

  // ----------------------------------------------------------------- lịch sử
  H() { return this.cur ? this.histories.get(this.cur.id) : null; }
  pushHistory(label) {
    const H = this.H(); if (!H) return;
    const s = J(this.s);
    if (H.stack[H.idx] && H.stack[H.idx].s === s) return;
    H.stack.splice(H.idx + 1);
    H.stack.push({ label, s });
    if (H.stack.length > 120) H.stack.shift();
    H.idx = H.stack.length - 1;
    this.updateUndo();
  }
  updateUndo() {
    const H = this.H();
    $('btnUndo').disabled = !H || H.idx <= 0;
    $('btnRedo').disabled = !H || H.idx >= H.stack.length - 1;
  }
  gotoHistory(i) {
    const H = this.H(); if (!H || i < 0 || i >= H.stack.length) return;
    H.idx = i;
    this.s = S.mergeSettings(JSON.parse(H.stack[i].s));
    if (this.layerIdx >= this.s.layers.length) this.layerIdx = this.s.layers.length - 1;
    this.saveSoon(); this.refresh(); this.requestRender(false);
  }
  undo() { const H = this.H(); if (H && H.idx > 0) { this.toast('Hoàn tác: ' + H.stack[H.idx].label, 1400); this.gotoHistory(H.idx - 1); } }
  redo() { const H = this.H(); if (H && H.idx < H.stack.length - 1) { this.gotoHistory(H.idx + 1); this.toast('Làm lại: ' + H.stack[H.idx].label, 1400); } }
  historyList() { const H = this.H(); return H ? H.stack.map((x, i) => ({ label: x.label, i, cur: i === H.idx })) : []; }

  // ----------------------------------------------------------------- dựng
  requestRender(draft, fresh) {
    if (!this.cur) return;
    if ($('hi').style.display !== 'none') this.hideHi();
    this.want = { draft, s: this.renderSettings(), geom: this.tool === 'crop' ? 'nocrop' : true, fresh, mask: this.showMask ? this.layerIdx : -1 };
    this.pump();
  }
  async pump() {
    if (this.inflight || !this.want) return;
    const w = this.want; this.want = null;
    this.inflight = true;
    try {
      // bản nháp tự nhỏ lại khi bước đang kéo dựng chậm (giữ ≥ 20 khung / giây)
      const which = w.draft ? (this._slow ? 'draft2' : 'draft') : 'full';
      const r = await this.call('render', { id: this.cur.id, which, settings: w.s, geom: w.geom, hist: !w.draft, mask: w.mask });
      if (which === 'draft') this._slow = r.ms > 38;
      else if (which === 'draft2' && r.ms < 12) this._slow = false;
      if (r.id === this.cur.id) {
        this.lastMs = r.ms; this.lastWhich = r.which === 'full' ? 'full' : 'draft';
        if (r.hist) this.hist = r.hist;
        this.viewer.show(r.rgba, r.w, r.h);
        if (r.hist && this.panels.cur === 'curve') this.panels.curve.draw();
        if (this.panels.cur === 'scopes' && (r.hist || !this._scT || performance.now() - this._scT > 120)) { this._scT = performance.now(); this.panels.scopes.draw(this.viewer.img); }
        if (!w.draft) this.scheduleHiRes();
        if (!w.draft && r.xvPending) this.xvKick();        // có vùng xoá vật thể chưa có kết quả AI: chạy AI
        else if (!w.draft && this._xvFinish && !this._xvRun) {
          const f = this._xvFinish, sec = Math.round((performance.now() - f.t0) / 1000);
          this.xvBar(false);
          if (f.n) this.toast(`Đã xoá vật thể — AI dựng lại nền trong ${sec} giây`, 2500);
        }
        if (!w.draft && this.panels.cur === 's_auto') setTimeout(() => this.styleThumbs(), 50);
        if (w.fresh) this.viewer.fitView(), this.viewer.apply();
      }
    } catch (e) { this.toast('Lỗi dựng ảnh: ' + e.message, 4000); }
    this.inflight = false;
    if (this.want) this.pump();
  }
  async needBefore() {
    if (!this.cur) return;
    const geo = { rotate: this.s.rotate, flip: this.s.flip, straighten: this.s.straighten, crop: this.s.crop, crop_rect: this.s.crop_rect, crop_outside: this.s.crop_outside, lens: deep(this.s.lens) };
    const key = J([this.cur.id, geo, this.tool === 'crop']);
    if (this._beforeKey === key && this.viewer.before) return;
    this._beforeKey = key;
    const r = await this.call('render', { id: this.cur.id, which: 'before', settings: geo, geom: this.tool === 'crop' ? 'nocrop' : true });
    this.viewer.before = new ImageData(r.rgba, r.w, r.h);
    this.viewer.paint();
  }
  onZoom() { this.drawOverlay(); this.scheduleHiRes(); }

  // ----------------------------------------------------------------- phóng 1:1 nét (dựng vùng đang xem ở cỡ gốc)
  hideHi() { $('hi').style.display = 'none'; this._hiKey = null; }
  scheduleHiRes() { clearTimeout(this._hiT); this._hiT = setTimeout(() => this.hiRes(), 200); }
  async hiRes() {
    const v = this.viewer, hi = $('hi');
    if (!this.cur || !this.bitmap || this.tool === 'crop' || !v.img || this.lastWhich !== 'full' || v.holding || v.split) { this.hideHi(); return; }
    const G = E.geometryAffine(this.fullW, this.fullH, this.s, true);
    const F = G.w / v.cv.width, dpr = window.devicePixelRatio || 1;
    if (F < 1.05 || v.z * dpr < 1.15) { this.hideHi(); return; }
    const r = v.vp.getBoundingClientRect();
    const x0 = Math.max(0, -v.tx / v.z), y0 = Math.max(0, -v.ty / v.z);
    const x1 = Math.min(v.cv.width, (r.width - v.tx) / v.z), y1 = Math.min(v.cv.height, (r.height - v.ty) / v.z);
    if (x1 - x0 < 2 || y1 - y0 < 2) { this.hideHi(); return; }
    let ds = Math.min(1, v.z * dpr / F);
    const area = (x1 - x0) * F * ds * (y1 - y0) * F * ds;
    if (area > 6e6) ds *= Math.sqrt(6e6 / area);
    const sJ = J(this.renderSettings());
    const key = J([sJ, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), ds.toFixed(3)]);
    if (key === this._hiKey && hi.style.display !== 'none') return;
    if (this._hiBusy) { this._hiAgain = true; return; }
    this._hiBusy = true;
    const ver = this._hiVer = (this._hiVer || 0) + 1, job = 'r' + ver + '_' + Date.now().toString(36);
    const res = await new Promise((resolve) => {
      this.jobs.set(job, (m) => {
        if (m.type === 'export_src') {
          const rgba = drawScaled(this.bitmap, ...m.rect, m.tw, m.th);
          this.worker.postMessage({ type: 'export_band', job, rgba }, [rgba.buffer]);
        } else if (m.type === 'roi_done') { this.jobs.delete(job); resolve(m); }
      });
      this.worker.postMessage({ type: 'roi_start', job, id: this.cur.id, settings: JSON.parse(sJ), W: this.fullW, H: this.fullH,
        rect: [x0 * F, y0 * F, x1 * F, y1 * F], ds, photo: photoKey(this.cur) });
    });
    this._hiBusy = false;
    if (!res.error && ver === this._hiVer && J(this.renderSettings()) === sJ && !v.holding && this.lastWhich === 'full') {
      hi.width = res.w; hi.height = res.h;
      hi.getContext('2d').putImageData(new ImageData(res.rgba, res.w, res.h), 0, 0);
      const k = 1 / (res.ds * F);
      hi.style.left = res.ox / F + 'px'; hi.style.top = res.oy / F + 'px';
      hi.style.transform = `scale(${k})`;
      hi.style.display = 'block';
      this._hiKey = key;
      this.hiMs = res.ms;
    } else if (res.error) console.warn(res.error);
    if (this._hiAgain) { this._hiAgain = false; this.scheduleHiRes(); }
  }
  oneToOneZoom() { return (this.fullW / this.pw) / (window.devicePixelRatio || 1) * (this.viewer.cv.width / this.outW(true)); }
  outW() { return E.geometryAffine(this.pw, this.ph, this.s, this.tool !== 'crop').w; }
  outputSize() { if (!this.cur) return null; const g = E.geometryAffine(this.fullW, this.fullH, this.s, true); return [g.w, g.h]; }

  // ----------------------------------------------------------------- công cụ trên ảnh
  setTool(t) {
    const prev = this.tool;
    this.tool = t;
    if (t === 'crop' && !this.s.crop_rect) {
      const g = E.geometryAffine(this.pw, this.ph, this.s, false);
      this.s.crop_rect = rectForRatio(this.s.crop, g.w, g.h);
    }
    if (prev === 'crop' || t === 'crop') { this.requestRender(false); if (prev === 'crop') { this.pushHistory('Cắt khung'); this.saveSoon(); } }
    const msg = { wb: 'Chạm vào vùng trắng / xám trên ảnh để cân bằng trắng', colorpick: 'Chạm lên ảnh để chọn dải màu cần chỉnh',
      cadvpick: 'Chạm lên màu cần sửa trên ảnh để tạo dải màu mới',
      crange: 'Chạm lên ảnh để chọn màu cho Color Range', level: 'Kéo một đường dọc theo chân trời hoặc cạnh lẽ ra phải thẳng',
      kguide: 'Kẻ dọc theo các cạnh lẽ ra thẳng đứng (tường, cột) và / hoặc nằm ngang, rồi bấm Áp dụng',
      lbrush: 'Tô lên ảnh bằng 1 ngón tay (2 ngón để phóng / di chuyển)', lerase: 'Tô để bỏ vùng khỏi mask',
      linear: 'Kéo từ nơi tác động mạnh nhất tới nơi hết tác động', radial: 'Kéo từ tâm ra ngoài để tạo vùng tròn',
      heal: 'Tô lên mụn / vết bẩn / nếp nhăn — app tự chọn vùng nguồn', clone: 'Chạm giữ để đặt điểm nguồn, rồi tô lên vùng cần phủ',
      remove: 'Tô kín vật cần xoá (dây điện, người qua đường, rác...)', dust: 'Chạm lên vết bụi / chấm nhỏ trên nền trơn',
      skin: 'Tô lên vùng da cần làm mịn', erase: 'Tô để bỏ làm mịn (mắt, môi, tóc...)',
      pprotect: 'Tô lên vùng không muốn bị chỉnh (nốt ruồi duyên, hình xăm, trang sức...)', perase: 'Tô để bỏ vùng bảo vệ' }[t];
    if (msg) this.toast(msg, 3000);
    if (t === 'remove') {
      // Xoá vật thể dùng AI như PUM máy tính: chưa có mô hình thì mời tải; có rồi thì nạp sẵn ở nền trong lúc tô
      if (this.ai.state === 'ready') this.xvIsolated().then((ok) => ok && this.ai.warm().catch(() => {}));
      else if (this.ai.state === 'none' && !this._aiAsked) { this._aiAsked = true; this.offerAI(); }
    }
    this.panels.sync();
    this.drawOverlay();
  }

  // ----------------------------------------------------------------- Xoá vật thể bằng AI
  xvReady() { return this.ai.state === 'ready'; }
  // AI cần trang "cô lập" (service worker gắn COOP / COEP). Lần mở đầu tiên service worker mới cài nên trang chưa
  // cô lập: luồng AI tạo lúc đó không nạp được thư viện -> khởi động lại app một lần (thông số đã lưu ngay).
  async xvIsolated() {
    if (self.crossOriginIsolated || !navigator.serviceWorker || !navigator.serviceWorker.controller) return true;
    let done = false;
    try { done = sessionStorage.getItem('pum_coi_reload') === '1'; sessionStorage.setItem('pum_coi_reload', '1'); } catch (e) { done = true; }
    if (done) return true;           // đã thử khởi động lại mà vẫn không cô lập: chạy AI 1 luồng
    this.toast('PUM khởi động lại để bật AI xoá vật thể…', 3000);
    await this.saveCurrent();
    setTimeout(() => location.reload(), 300);
    return false;
  }
  async xvSync() {
    await this.ai.check();
    await this.call('xv_state', { ai: this.ai.state === 'ready' }).catch(() => {});
  }
  // việc AI mà luồng dựng nhờ: chạy mô hình, đọc / lưu kết quả đã tính (IndexedDB, mở lại app không phải chạy lại)
  async xvMsg(m) {
    if (m.type === 'xv_get') {
      let entry = null;
      try { entry = (await store.get('xv:' + m.key)) || null; } catch (e) { /* bỏ qua */ }
      this.worker.postMessage({ type: 'xv_got', job: m.job, entry });
    } else if (m.type === 'xv_put') {
      try {
        await store.set('xv:' + m.key, m.entry);
        const keys = ((await store.get('xv_keys')) || []).filter((k) => k !== m.key);
        keys.push(m.key);
        while (keys.length > 120) await store.del('xv:' + keys.shift());      // giữ ~120 vùng gần nhất (~1,5 MB mỗi ô)
        await store.set('xv_keys', keys);
      } catch (e) { /* hết chỗ: chỉ giữ trong bộ nhớ */ }
    } else if (m.type === 'xv_progress') {
      // bắt đầu ô thứ m.step / m.steps: đo thời gian ô trước (AI + ghép) để ước lượng phần còn lại
      const now = performance.now();
      if (this._xvStep) this._xvStepMs = now - this._xvStepT;
      this._xvStep = m.step; this._xvSteps = m.steps; this._xvStepT = now;
      this.xvBarTick();
    } else if (m.type === 'xv_run') {
      try {
        const L = await this.ai.run(m.inp, m.m);
        this.worker.postMessage({ type: 'xv_ai', job: m.job, L }, [L.buffer]);
      } catch (e) {
        this.worker.postMessage({ type: 'xv_ai', job: m.job, error: e.message });
      }
    }
  }
  // ảnh đang mở có vùng xoá chưa có kết quả AI: chạy AI rồi dựng lại
  async xvKick() {
    if (!this.cur || !this.xvReady()) return;
    const sJ = J(this.s.retouch);
    if (this._xvRun) { this._xvAgain = true; return; }
    if (this._xvFail === sJ) return;           // vừa lỗi với đúng các vùng này: không chạy lặp
    this._xvRun = true;
    if (!(await this.xvIsolated())) { this._xvRun = false; return; }
    const id = this.cur.id, bitmap = this.bitmap, job = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const t0 = performance.now();
    this.xvBar(true);
    let r = null;
    try {
      r = await new Promise((resolve) => {
        this.jobs.set(job, (m) => {
          if (m.type === 'export_src') {
            const rgba = drawScaled(bitmap, ...m.rect, m.tw, m.th);
            this.worker.postMessage({ type: 'export_band', job, rgba }, [rgba.buffer]);
          } else if (m.type === 'xv_done') { this.jobs.delete(job); resolve(m); }
        });
        this.worker.postMessage({ type: 'xv_prepare', job, id, settings: deep(this.s), W: this.fullW, H: this.fullH, photo: photoKey(this.cur) });
      });
    } finally { this._xvRun = false; }
    this.xvMs = performance.now() - t0;
    if (r && r.error) {
      this._xvFail = sJ;
      console.error(r.error);
      this.xvBar(false);
      this.toast('Không xoá được bằng AI: ' + r.error.split('\n')[0], 6000);
    } else {
      // AI xong: còn bước ghép nền vào ảnh (dựng lại) -> thanh tiến độ tắt khi ảnh mới hiện ra (pump)
      this._xvFinish = { n: r ? r.n : 0, t0 };
      this.xvBarTick('Đang ghép nền mới vào ảnh…');
    }
    if (this.cur && this.cur.id === id) { this._hiKey = null; this.requestRender(false); }
    else this.xvBar(false);
    if (this._xvAgain) { this._xvAgain = false; }
  }
  // thanh tiến độ Xoá vật thể trên khung ảnh (không chặn thao tác)
  xvBar(on) {
    let el = document.getElementById('xvbar');
    if (!el) { el = h('div', { id: 'xvbar' }); $('viewer').append(el); }
    clearInterval(this._xvTimer);
    if (!on) { el.style.display = 'none'; this._xvFinish = null; return; }
    this._xvT0 = performance.now(); this._xvStep = 0; this._xvSteps = 0; this._xvStepT = this._xvT0; this._xvStepMs = null; this._xvMsg = null;
    el.style.display = 'flex';
    this.xvBarTick();
    this._xvTimer = setInterval(() => this.xvBarTick(), 1000);
  }
  xvBarTick(msg) {
    const el = document.getElementById('xvbar');
    if (!el || el.style.display === 'none') return;
    if (msg) this._xvMsg = msg;
    const now = performance.now(), s = Math.round((now - this._xvT0) / 1000);
    let txt = this._xvMsg, eta = '';
    if (!txt) {
      if (!this._xvStep) txt = this.ai.info && this.ai.info.loadMs ? 'AI đang chuẩn bị…' : 'Đang nạp AI xoá vật thể…';
      else txt = 'AI đang xoá vật thể' + (this._xvSteps > 1 ? ` · ô ${this._xvStep}/${this._xvSteps}` : '');
      const per = this._xvStepMs || (this.ai.info && this.ai.info.lastMs);
      if (per && this._xvStep) {
        const left = Math.max(0, (this._xvSteps - this._xvStep + 1) * per - (now - this._xvStepT));
        eta = ` · còn ~${Math.max(1, Math.ceil(left / 1000))} giây`;
      }
    }
    el.replaceChildren(h('div', { class: 'spin' }), h('span', {}, `${txt} · ${s} giây${eta}`));
  }
  // mời tải mô hình AI (lần đầu dùng Xoá vật thể)
  offerAI(after) {
    const mb = Math.round(MODEL_BYTES / 1e6);
    const prog = h('div', { class: 'prog' }, h('div')), status = h('div', { class: 'hint' });
    const go = h('button', { class: 'big', style: 'width:100%;margin-top:10px' }, `Tải mô hình AI (${mb} MB)`);
    go.onclick = async () => {
      go.disabled = true; status.textContent = 'Đang tải…';
      try {
        await this.ai.download((d, tot) => { prog.firstChild.style.width = (d / tot * 100).toFixed(1) + '%'; status.textContent = `Đang tải ${(d / 1e6).toFixed(0)} / ${(tot / 1e6).toFixed(0)} MB…`; });
        status.textContent = 'Đã tải xong. Đang nạp AI…';
        await this.xvSync();
        this.closeSheet();
        this.toast('Đã có AI xoá vật thể trên máy — dùng được cả khi không có mạng', 3500);
        if (!(await this.xvIsolated())) return;
        this.ai.warm().catch(() => {});
        this.requestRender(false);
        if (after) after();
      } catch (e) {
        go.disabled = false; go.textContent = 'Thử tải lại (tải tiếp phần còn thiếu)';
        status.textContent = 'Chưa tải xong: ' + e.message;
      }
    };
    this.openSheet('Xoá vật thể bằng AI', h('div', {},
      h('div', {}, 'PUM xoá hẳn vật rồi để AI dựng lại phần nền phía sau (giống PUM máy tính) — không chép mảng ảnh chỗ khác sang.'),
      h('div', { style: 'margin-top:8px' }, `Cần tải mô hình AI một lần (${mb} MB, nên dùng Wi-Fi). Tải xong, mô hình nằm trong bộ nhớ của app và chạy cả khi không có mạng.`),
      go, prog, status,
      btn('Để sau', () => { this.closeSheet(); this.toast('Chưa có mô hình AI: vùng xoá được lấp tạm từ nền xung quanh', 4000); }),
      hint('Xoá mô hình để lấy lại chỗ trống: menu ☰ › Mô hình AI xoá vật thể.')));
  }
  // Kiểm tra vì sao ảnh trông tối hơn app Ảnh. Hiện cạnh nhau, cùng cỡ:
  // A = Safari tự hiện tệp gốc (thẻ <img>); B = PUM giải mã (createImageBitmap -> canvas); C = PUM sau khi dựng.
  // Kèm thông tin tệp: loại, dải màu P3, có lớp HDR (gain map) không, độ sáng trung bình của B / C / A vẽ vào canvas.
  async colorCheck() {
    const p = this.cur;
    if (!p || !this.viewer.img) return this.toast('Mở một ảnh trước');
    const blob = await store.getFile(p.fileId || p.id);
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 6 << 20)).arrayBuffer());
    const has = (s, utf16) => {
      const pat = [];
      for (const ch of s) { if (utf16) pat.push(0); pat.push(ch.charCodeAt(0)); }
      outer: for (let i = 0; i + pat.length <= head.length; i++) {
        for (let k = 0; k < pat.length; k++) if (head[i + k] !== pat[k]) continue outer;
        return true;
      }
      return false;
    };
    const kind = has('ftypheic') || has('ftypheix') || has('ftypmif1') ? 'HEIC' : head[0] === 0xff && head[1] === 0xd8 ? 'JPEG'
      : /\.dng$/i.test(p.name) || /dng/i.test(blob.type) ? 'DNG (RAW)' : isRawName(p.name) ? 'RAW' : (blob.type || 'khác');
    const p3 = has('Display P3') || has('Display P3', true) || has('P3 D65');
    const gain = has('hdrgainmap') || has('HDRGainMap') || has('urn:iso:std:iso:ts:21496') || has('hdrgm');
    const W = 360, k = W / this.viewer.img.width, H = Math.round(this.viewer.img.height * k);
    const lum = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722; return s / (d.length / 4); };
    const cv = (draw) => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.style.cssText = 'width:100%;border-radius:6px'; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; draw(x); return [c, lum(x.getImageData(0, 0, W, H).data)]; };
    const url = URL.createObjectURL(blob);
    const img = new Image(); img.src = url; img.style.cssText = 'width:100%;border-radius:6px;display:block';
    try { await img.decode(); } catch (e) { /* bỏ qua */ }
    let bmp = null;
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* bỏ qua */ }
    const [cA, lA] = cv((x) => x.drawImage(img, 0, 0, W, H));
    const [cB, lB] = bmp ? cv((x) => x.drawImage(bmp, 0, 0, W, H)) : [h('div', {}, 'không giải mã được'), 0];
    const vc = document.createElement('canvas'); vc.width = this.viewer.img.width; vc.height = this.viewer.img.height; vc.getContext('2d').putImageData(this.viewer.img, 0, 0);
    const [cC, lC] = cv((x) => x.drawImage(vc, 0, 0, W, H));
    const cell = (t, el) => h('div', { style: 'margin:6px 0' }, h('div', { style: 'font-size:13px;color:var(--fg2);margin-bottom:3px' }, t), el);
    const r1 = (v) => v.toFixed(1);
    this.openSheet('Kiểm tra độ sáng ảnh', h('div', {},
      h('div', { style: 'font-size:13px;margin-bottom:6px' }, `Tệp: ${kind} · ${(blob.size / 1e6).toFixed(1)} MB · màu ${p3 ? 'Display P3' : 'sRGB / không ghi'} · lớp HDR: ${gain ? 'CÓ' : 'không thấy'}`),
      h('div', { style: 'font-size:13px;margin-bottom:6px' }, `PUM giải mã bằng: ${this.decWay || '?'}`),
      h('div', { style: 'font-size:13px;margin-bottom:6px' }, `Độ sáng TB (0–255): Safari ${r1(lA)} · Safari giải mã ${r1(lB)} · PUM hiển thị ${r1(lC)} · máy: ${navigator.userAgent.match(/OS [\d_]+/) ? navigator.userAgent.match(/OS [\d_]+/)[0].replace(/_/g, '.') : ''}`),
      cell('A. Safari tự hiện tệp gốc', img), cell('B. Safari giải mã (createImageBitmap)', cB), cell('C. PUM hiển thị (sau khi dựng)', cC),
      hint('So 3 ảnh với ảnh đó trong app Ảnh. Chụp màn hình bảng này gửi lại để tìm đúng chỗ làm ảnh tối.')), true);
    this.onSheetClose = () => URL.revokeObjectURL(url);
    if (bmp && bmp.close) bmp.close();
  }
  aiMenu() {
    const ready = this.xvReady(), info = this.ai.info || {};
    this.openSheet('Mô hình AI xoá vật thể', h('div', { class: 'menu' },
      h('div', { style: 'margin-bottom:8px' }, ready ? `Đã có trên máy (${Math.round(MODEL_BYTES / 1e6)} MB).` + (info.loadMs ? ` Nạp ${(info.loadMs / 1000).toFixed(1)} giây, ${info.threads} luồng (máy báo ${info.cores || '?'} nhân, ${info.coi ? 'đã' : 'CHƯA'} cô lập).` : '') + (info.lastMs ? ` Lần chạy gần nhất ${(info.lastMs / 1000).toFixed(1)} giây / ô.` : '') : 'Chưa tải.'),
      ready ? btn('🗑 Xoá mô hình khỏi máy (lấy lại chỗ trống)', async () => {
        if (!confirm('Xoá mô hình AI khỏi PUM? Các vùng xoá vật thể sẽ được lấp tạm từ nền xung quanh cho tới khi tải lại.')) return;
        await this.ai.removeModel(); await this.xvSync(); this.closeSheet(); this.requestRender(false);
      }) : btn(`⬇️ Tải mô hình (${Math.round(MODEL_BYTES / 1e6)} MB)`, () => this.offerAI())));
  }
  // ánh xạ: điểm ảnh hiển thị <-> toạ độ chuẩn hoá trên ảnh nguồn
  geo() {
    const g = E.geometryAffine(this.pw, this.ph, this.s, this.tool !== 'crop');
    const k = this.viewer.cv.width / g.w;
    return { g, k, Ai: E.inv3(g.M) };
  }
  dispToSrc([x, y]) {
    const { g, k, Ai } = this.geo();
    const X = x / k, Y = y / k;
    const xs = new Float32Array([Ai[0][0] * X + Ai[0][1] * Y + Ai[0][2]]), ys = new Float32Array([Ai[1][0] * X + Ai[1][1] * Y + Ai[1][2]]);
    if (S.lensActive(this.s.lens)) E.lensCoords(this.s.lens, this.pw, this.ph, xs, ys);
    return [xs[0] / this.pw, ys[0] / this.ph];
  }
  srcToDisp([u, v]) {
    const { g, k } = this.geo();
    const X = u * this.pw, Y = v * this.ph, M = g.M;
    return [(M[0][0] * X + M[0][1] * Y + M[0][2]) * k, (M[1][0] * X + M[1][1] * Y + M[1][2]) * k];
  }
  curLayer() { return this.s.layers && this.layerIdx >= 0 ? this.s.layers[this.layerIdx] : null; }

  toolDown(p, e) {
    const t = this.tool, vw = this.viewer.cv.width, vh = this.viewer.cv.height;
    if (p[0] < -20 || p[1] < -20 || p[0] > vw + 20 || p[1] > vh + 20) return false;
    if (t === 'wb') {
      const [u, v] = this.dispToSrc(p);
      this.call('pixel', { id: this.cur.id, x: Math.min(1, Math.max(0, u)), y: Math.min(1, Math.max(0, v)) }).then((r) => {
        const [tp, tn] = E.wbFromPixel(r.rgb);
        this.begin('Chấm cân bằng trắng'); this.set(['temp'], Math.round(tp * 10) / 10); this.set(['tint'], Math.round(tn * 10) / 10); this.end();
        this.wbMode = 'custom';
        this.toast(`Cân bằng trắng: nhiệt độ ${tp.toFixed(0)}, tint ${tn.toFixed(0)}`);
      });
      this.setTool(null);
      return true;
    }
    if (t === 'cadvpick') {
      // trung bình ô 7x7 quanh chỗ chạm trên ảnh đang hiển thị (như bản máy tính) -> sắc độ / bão hoà OkLCh
      const im = this.viewer.img, x = Math.round(Math.min(vw - 1, Math.max(0, p[0]))), y = Math.round(Math.min(vh - 1, Math.max(0, p[1])));
      const px = [0, 0, 0]; let cnt = 0;
      for (let yy = Math.max(0, y - 3); yy <= Math.min(im.height - 1, y + 3); yy++)
        for (let xx = Math.max(0, x - 3); xx <= Math.min(im.width - 1, x + 3); xx++) {
          const i = (yy * im.width + xx) * 4;
          px[0] += im.data[i]; px[1] += im.data[i + 1]; px[2] += im.data[i + 2]; cnt++;
        }
      const [hh, cc] = E.oklchOf(px.map((v) => v / cnt / 255));
      this.addColorRange(hh, cc);
      this.setTool(null);
      this.toast(`Đã tạo dải màu mới quanh ${hh.toFixed(0)}° (bão hoà ${cc.toFixed(0)}%) — kéo Sắc độ / Bão hoà / Độ sáng để chỉnh`, 3500);
      return true;
    }
    if (t === 'colorpick' || t === 'crange') {
      const im = this.viewer.img, x = Math.round(Math.min(vw - 1, Math.max(0, p[0]))), y = Math.round(Math.min(vh - 1, Math.max(0, p[1])));
      const i = (y * im.width + x) * 4, o = new Float32Array(3);
      E.cv.rgb2hsv(im.data[i] / 255, im.data[i + 1] / 255, im.data[i + 2] / 255, o);
      if (t === 'colorpick') {
        let best = 'red', bd = 999;
        for (const [k, , c] of S.BANDS) { const d = Math.abs(E.hueDist(o[0], c)); if (d < bd) { bd = d; best = k; } }
        this.panels.band = best; this.panels.sync();
        this.toast('Đã chọn dải ' + S.BANDS.find((b) => b[0] === best)[1]);
      } else {
        this.begin('Color Range'); this.set(['layers', this.layerIdx, 'crange', 0], Math.round(o[0])); this.set(['layers', this.layerIdx, 'crange_on'], true); this.end();
      }
      this.setTool(null);
      return true;
    }
    if (t === 'crop') {
      const r = this.s.crop_rect, tol = 26 / this.viewer.z;
      const [x0, y0, x1, y1] = [r[0] * vw, r[1] * vh, r[2] * vw, r[3] * vh];
      let mode = '';
      if (Math.abs(p[0] - x0) < tol) mode += 'l'; else if (Math.abs(p[0] - x1) < tol) mode += 'r';
      if (Math.abs(p[1] - y0) < tol) mode += 't'; else if (Math.abs(p[1] - y1) < tol) mode += 'b';
      if (!mode) { if (p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1) mode = 'move'; else return false; }
      this._drag = { mode, p, r0: r.slice() };
      return true;
    }
    if (t === 'level' || t === 'kguide') { this._drag = { p, q: p }; return true; }
    if (['heal', 'clone', 'remove', 'dust', 'skin', 'erase'].includes(t)) return this.rtDown(t, this.dispToSrc(p));
    if (t === 'pprotect' || t === 'perase') {
      const u = this.dispToSrc(p);
      this.begin(t === 'pprotect' ? 'Cọ bảo vệ' : 'Bỏ bảo vệ');
      const st = { r: this.protSize / 100, pts: [u.map((v) => +v.toFixed(5))] };
      if (t === 'perase') st.erase = true;
      this.s.retouch.portrait.protect = (this.s.retouch.portrait.protect || []).concat([st]);
      this._drag = { rt: true, skin: st, began: true };
      this.requestRender(true);
      return true;
    }
    if (['lbrush', 'lerase', 'linear', 'radial'].includes(t)) {
      if (!this.curLayer()) this.addLayer();
      const u = this.dispToSrc(p);
      this.begin({ lbrush: 'Tô cọ layer', lerase: 'Tẩy mask', linear: 'Gradient thẳng', radial: 'Gradient tròn' }[t]);
      const ly = this.curLayer();
      if (t === 'lbrush' || t === 'lerase') {
        const st = { r: this.brushSize / 100, pts: [u.map((v) => +v.toFixed(5))] };
        if (t === 'lerase') st.erase = true;
        ly.brush.push(st);
        this._drag = { st };
      } else if (t === 'linear') { const g = { x0: u[0], y0: u[1], x1: u[0], y1: u[1] + 0.001 }; ly.linear.push(g); this._drag = { g, u }; }
      else { const g = { cx: u[0], cy: u[1], rx: 0.01, ry: 0.01, feather: this.radialFeather }; ly.radial.push(g); this._drag = { g, u }; }
      this.requestRender(true);
      return true;
    }
    return false;
  }
  toolMove(p) {
    const d = this._drag; if (!d) return;
    const t = this.tool, vw = this.viewer.cv.width, vh = this.viewer.cv.height;
    if (t === 'crop') {
      const ratio = this.s.crop !== 'orig' ? S.cropRatio(this.s.crop) : (this.cropLock ? (d.r0[2] - d.r0[0]) * vw / ((d.r0[3] - d.r0[1]) * vh) : null);
      this.s.crop_rect = dragCrop(d.r0, d.mode, (p[0] - d.p[0]) / vw, (p[1] - d.p[1]) / vh, ratio, vw, vh).map((v) => +v.toFixed(5));
      this.drawOverlay();
      return;
    }
    if (t === 'level' || t === 'kguide') { d.q = p; this.drawOverlay(); return; }
    const u = this.dispToSrc(p);
    if (d.rt) return this.rtMove(d, u, p);
    if (d.st) { const last = d.st.pts[d.st.pts.length - 1]; if (Math.hypot(u[0] - last[0], u[1] - last[1]) > d.st.r * 0.25) d.st.pts.push(u.map((v) => +v.toFixed(5))); }
    else if (t === 'linear') { d.g.x1 = u[0]; d.g.y1 = u[1]; }
    else if (t === 'radial') {
      const ar = this.pw / this.ph;
      d.g.rx = Math.max(0.005, Math.abs(u[0] - d.u[0])); d.g.ry = Math.max(0.005, Math.abs(u[1] - d.u[1]) / ar);
      if (d.g.rx < 0.02 && d.g.ry > 0.02) d.g.rx = d.g.ry; if (d.g.ry < 0.02 && d.g.rx > 0.02) d.g.ry = d.g.rx;
    }
    this.requestRender(true);
    this.drawOverlay(p);
  }
  toolUp(p) {
    const d = this._drag; this._drag = null;
    const t = this.tool;
    if (t === 'crop') { this.pushHistory('Cắt khung'); this.saveSoon(); this.panels.sync(); this.drawOverlay(); return; }
    if (t === 'level' && d) {
      const dx = d.q[0] - d.p[0], dy = d.q[1] - d.p[1];
      if (Math.hypot(dx, dy) > 10) {
        const corr = straightenFromLine(dx, dy);
        this.begin('Kẻ chân trời'); this.set(['straighten'], Math.max(-45, Math.min(45, +(this.s.straighten + corr).toFixed(2)))); this.end();
        this.toast(`Xoay ${corr >= 0 ? '+' : ''}${corr.toFixed(1)}°`);
      }
      this.setTool(null);
      return;
    }
    if (d && d.rt) return this.rtUp(d);
    if (t === 'kguide' && d) {
      if (Math.hypot(d.q[0] - d.p[0], d.q[1] - d.p[1]) > 12) {
        const a = this.dispToSrc(d.p), b = this.dispToSrc(d.q);
        const o = Math.abs(d.q[1] - d.p[1]) > Math.abs(d.q[0] - d.p[0]) ? 'v' : 'h';
        const g = (this.s.lens.kguides || []).slice();
        g.push({ o, p: [a[0], a[1], b[0], b[1]].map((v) => +v.toFixed(5)) });
        this.begin('Kẻ đường dẫn'); this.set(['lens', 'kguides'], g); this.end();
      }
      this.drawOverlay(); return;
    }
    if (d) this.end();
    this.drawOverlay();
  }
  applyGuides() {
    const g = this.s.lens.kguides || [];
    if (g.length < 2) return this.toast('Kẻ ít nhất 2 đường (2 đường dọc, 2 đường ngang hoặc mỗi loại 1)');
    const M = E.keystoneFromGuides(g, this.pw / this.ph);
    if (!M || M.flat().some((v) => !isFinite(v))) return this.toast('Không tính được phối cảnh từ các đường này');
    this.begin('Áp dụng đường dẫn'); this.set(['lens', 'kmat'], M); this.set(['lens', 'kamount'], 100); this.end();
    if (this.tool === 'kguide') this.setTool(null);
    this.toast('Đã nắn theo đường dẫn — tăng "Phóng to" nếu lộ mép');
  }
  clearGuides() { this.begin('Xoá đường dẫn'); this.set(['lens', 'kguides'], []); this.set(['lens', 'kmat'], null); this.end(); this.drawOverlay(); }
  toolCancel() {
    const d = this._drag;
    if (d && (['lbrush', 'lerase', 'linear', 'radial'].includes(this.tool) || (d.rt && d.began))) this.end();
    if (d && d.timer) clearTimeout(d.timer);
    this._drag = null; this.drawOverlay();
  }

  // ----------------------------------------------------------------- retouch trên ảnh
  rtSel() {
    const rt = this.s.retouch;
    if (this.selArea >= 0 && rt.areas[this.selArea]) {
      const a = rt.areas[this.selArea];
      const extra = a.kind === 'remove' && this.xvReady() ? ` · AI dựng lại nền · cách lấp ${(a.v | 0) + 1}/${XV_VARIANTS}` : '';
      return { kind: 'area', i: this.selArea, o: a, label: ({ heal: 'Heal', clone: 'Clone', remove: 'Xoá vật thể' }[a.kind] || 'Vùng') + ' #' + (this.selArea + 1) + extra };
    }
    if (this.selSpot >= 0 && rt.spots[this.selSpot]) { const s = rt.spots[this.selSpot]; return { kind: 'spot', i: this.selSpot, o: s, label: ({ dust: 'Vết bụi', heal: 'Điểm heal', clone: 'Điểm clone' }[s.type] || 'Điểm') + ' #' + (this.selSpot + 1) }; }
    return null;
  }
  areaDist(a, u, off) {
    const W = this.pw, H = this.ph, ox = off ? off[0] * W : 0, oy = off ? off[1] * H : 0;
    const px = u[0] * W, py = u[1] * H, pts = a.pts.map(([x, y]) => [x * W + ox, y * H + oy]);
    let best = Math.hypot(px - pts[0][0], py - pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy;
      const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / L2));
      best = Math.min(best, Math.hypot(px - x0 - t * vx, py - y0 - t * vy));
    }
    return best - a.r * W;
  }
  rtHit(u) {
    const rt = this.s.retouch, areas = rt.areas || [];
    const sel = this.rtSel();
    const tol = 14 / this.viewer.z / (this.viewer.cv.width / this.outW());
    if (sel && sel.kind === 'area' && sel.o.off && !(sel.o.kind === 'remove' && this.xvReady()) && this.areaDist(sel.o, u, sel.o.off) <= tol) return ['area_src', sel.i];
    for (let i = areas.length - 1; i >= 0; i--) if (areas[i].pts && this.areaDist(areas[i], u) <= 0) return ['area', i];
    for (let i = (rt.spots || []).length - 1; i >= 0; i--) {
      const sp = rt.spots[i];
      if (Math.hypot((sp.x - u[0]) * this.pw, (sp.y - u[1]) * this.ph) <= sp.r * this.pw) return ['spot', i];
    }
    return null;
  }
  rtDown(t, u) {
    const rt = this.s.retouch;
    if (t === 'dust') {
      const hit = this.rtHit(u);
      if (hit && hit[0] === 'spot') { this.selSpot = hit[1]; this.selArea = -1; this.panels.sync(); this.drawOverlay(); return true; }
      this.begin('Xoá bụi');
      rt.spots.push({ type: 'dust', x: +u[0].toFixed(5), y: +u[1].toFixed(5), r: this.rtSize / 100 });
      this.selSpot = rt.spots.length - 1; this.selArea = -1;
      this.end();
      return true;
    }
    if (t === 'skin' || t === 'erase') {
      this.begin(t === 'skin' ? 'Cọ làm mịn da' : 'Tẩy vùng mịn');
      if (t === 'skin' && !rt.skin_amount) { rt.skin_amount = 35; this.toast('Đặt "Độ mịn" 35 — chỉnh thêm ở bảng'); }
      const st = { r: this.rtSize / 100, pts: [u.map((v) => +v.toFixed(5))] };
      if (t === 'erase') st.erase = true;
      rt.skin_strokes.push(st);
      this._drag = { rt: true, skin: st, began: true };
      this.requestRender(true);
      return true;
    }
    // heal / clone / xoá vật thể
    const hit = this.rtHit(u);
    if (hit && hit[0] === 'area_src') {
      const a = rt.areas[hit[1]];
      this.begin('Đổi vùng nguồn');
      this._drag = { rt: true, mode: 'src', a, start: u, off0: a.off.slice(), began: true };
      return true;
    }
    const d = { rt: true, mode: 'paint', hit, pend: { kind: t, pts: [u.slice()], r: this.rtSize / 100, hard: this.rtHard, opacity: this.rtOpacity } };
    if (t === 'clone') d.timer = setTimeout(() => {
      if (this._drag !== d || d.pend.pts.length > 2) return;
      this.cloneSrc = u.slice(); this.cloneOff = null; d.mode = 'none';
      if (navigator.vibrate) navigator.vibrate(20);
      this.toast('Đã đặt điểm nguồn cho Clone. Giờ tô lên vùng cần phủ.');
      this.drawOverlay();
    }, 500);
    this._drag = d;
    this.drawOverlay();
    return true;
  }
  rtMove(d, u, p) {
    if (d.skin) {
      const last = d.skin.pts[d.skin.pts.length - 1];
      if (Math.hypot((u[0] - last[0]) * this.pw, (u[1] - last[1]) * this.ph) > d.skin.r * this.pw * 0.25) { d.skin.pts.push(u.map((v) => +v.toFixed(5))); this.requestRender(true); }
      this.drawOverlay(p); return;
    }
    if (d.mode === 'src') { d.a.off = [d.off0[0] + u[0] - d.start[0], d.off0[1] + u[1] - d.start[1]]; this.requestRender(true); this.drawOverlay(); return; }
    if (d.mode === 'paint') { d.pend.pts.push(u.slice()); this.drawOverlay(p); }
  }
  async rtUp(d) {
    if (d.timer) clearTimeout(d.timer);
    if (d.skin || d.mode === 'src') { this.end(); this.drawOverlay(); return; }
    if (d.mode !== 'paint') return this.drawOverlay();
    const a = d.pend, W = this.pw, H = this.ph, p0 = a.pts[0];
    const moved = Math.max(...a.pts.map((q) => Math.hypot((q[0] - p0[0]) * W, (q[1] - p0[1]) * H)));
    if (d.hit && (d.hit[0] === 'area' || d.hit[0] === 'spot') && moved < a.r * W * 0.8) {
      if (d.hit[0] === 'area') { this.selArea = d.hit[1]; this.selSpot = -1; this.rtOpacity = this.s.retouch.areas[d.hit[1]].opacity ?? 100; }
      else { this.selSpot = d.hit[1]; this.selArea = -1; }
      this.panels.sync(); this.drawOverlay(); return;
    }
    const keep = [a.pts[0]], step = Math.max(1, a.r * W * 0.25);
    for (const q of a.pts.slice(1)) if (Math.hypot((q[0] - keep[keep.length - 1][0]) * W, (q[1] - keep[keep.length - 1][1]) * H) >= step) keep.push(q);
    if (a.pts.length > 1 && keep[keep.length - 1] !== a.pts[a.pts.length - 1]) keep.push(a.pts[a.pts.length - 1]);
    a.pts = keep.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
    if (a.kind === 'clone' && (this.cloneSrc || this.cloneOff)) {
      if (!this.cloneOff) this.cloneOff = [this.cloneSrc[0] - p0[0], this.cloneSrc[1] - p0[1]];
      a.off = this.cloneOff.slice(); a.cands = [a.off.slice()];
    } else if (a.kind === 'remove' && this.xvReady()) {
      // AI xoá hẳn vật rồi dựng lại nền (như PUM máy tính): không có vùng nguồn; v = cách lấp (Thử cách khác)
      a.v = 0;          // tiến độ hiện ở thanh trên khung ảnh (xvBar)
    } else {
      this.busy(true);
      try {
        const r = await this.call('area_sources', { id: this.cur.id, settings: this.s, area: a });
        a.cands = r.cands; a.off = a.cands[0].slice();
      } catch (e) { a.cands = [[a.r * 3, 0]]; a.off = a.cands[0].slice(); }
      this.busy(false);
    }
    if (a.off) a.ci = 0;
    this.begin({ heal: 'Heal', clone: 'Clone', remove: 'Xoá vật thể' }[a.kind]);
    this.s.retouch.areas.push(a);
    this.selArea = this.s.retouch.areas.length - 1; this.selSpot = -1;
    this.end();
    this.drawOverlay();
  }
  setSelOpacity(v) {
    const sel = this.rtSel();
    if (sel && sel.kind === 'area') { this.begin('Độ mờ đục vùng tô'); sel.o.opacity = v; this.end(); }
  }
  async rtNextSource() {
    const sel = this.rtSel();
    if (sel && sel.kind === 'area' && sel.o.kind === 'remove' && this.xvReady()) {
      // xoá vật thể bằng AI: "thử cách khác" = đổi lượng bối cảnh đưa vào AI (4 cách, như phím / của PUM máy tính)
      const a = sel.o;
      this.begin('Thử cách lấp khác');
      a.v = ((a.v | 0) + 1) % XV_VARIANTS;
      delete a.off; delete a.cands; delete a.ci; delete a.fill;
      this.end(); this.drawOverlay();
      this.toast(`Cách lấp ${a.v + 1}/${XV_VARIANTS} — AI đang dựng lại nền…`, 2500);
      return;
    }
    if (sel && sel.kind === 'area' && sel.o.kind === 'remove' && !(sel.o.cands || []).length) return this.offerAI();
    if (!sel || sel.kind !== 'area' || !(sel.o.cands || []).length) return this.toast('Chọn một vùng đã tô trước (chạm vào vùng đó)');
    this.begin('Đổi nguồn');
    sel.o.ci = ((sel.o.ci || 0) + 1) % sel.o.cands.length; sel.o.off = sel.o.cands[sel.o.ci].slice();
    this.end(); this.drawOverlay();
  }
  rtDeleteSel() {
    const sel = this.rtSel();
    if (!sel) return this.toast('Chưa chọn vùng nào');
    this.begin('Xoá vùng retouch');
    this.s.retouch[sel.kind === 'area' ? 'areas' : 'spots'].splice(sel.i, 1);
    this.selArea = this.selSpot = -1;
    this.end(); this.drawOverlay();
  }
  rtClear(kind) {
    this.begin(kind === 'skin' ? 'Xoá vùng làm mịn' : 'Xoá mọi vùng heal / clone');
    if (kind === 'skin') { this.s.retouch.skin_strokes = []; this.s.retouch.skin_auto = false; }
    else { this.s.retouch.areas = []; this.s.retouch.spots = []; this.selArea = this.selSpot = -1; }
    this.end(); this.drawOverlay();
  }
  drawRetouch(c, z, finger) {
    const rt = this.s.retouch, { k } = this.geo(), W = this.pw;
    const path = (pts, off) => {
      c.beginPath();
      pts.forEach((q, i) => { const p = this.srcToDisp([q[0] + (off ? off[0] : 0), q[1] + (off ? off[1] : 0)]); i ? c.lineTo(...p) : c.moveTo(...p); });
      if (pts.length === 1) { const p = this.srcToDisp(pts[0].map((v, i) => v + (off ? off[i] : 0))); c.lineTo(p[0] + 0.01, p[1]); }
    };
    c.lineCap = 'round'; c.lineJoin = 'round';
    // chỉ đánh dấu nhẹ vùng đang chọn (để vẫn nhìn rõ kết quả xoá): viền nét đứt + nguồn nét đứt mờ
    // viền mảnh quanh nét tô (vẽ nét dày rồi khoét lõi) — không che kết quả
    const ring = (pts, off, col) => {
      const rr = (this.s.retouch.areas[this.selArea] || {}).r * W * k * 2;
      c.save(); path(pts, off); c.strokeStyle = col; c.lineWidth = rr + 3 / z; c.stroke();
      c.globalCompositeOperation = 'destination-out'; path(pts, off); c.strokeStyle = '#000'; c.lineWidth = Math.max(0, rr - 0.5 / z); c.stroke(); c.restore();
    };
    const sa = (rt.areas || [])[this.selArea];
    if (sa && sa.pts) { ring(sa.pts, null, 'rgba(255,212,0,.95)'); if (sa.off && !(sa.kind === 'remove' && this.xvReady())) ring(sa.pts, sa.off, 'rgba(255,255,255,.7)'); }
    (rt.spots || []).forEach((sp, i) => {
      const p = this.srcToDisp([sp.x, sp.y]);
      c.strokeStyle = i === this.selSpot ? '#ffd400' : 'rgba(255,255,255,.7)'; c.lineWidth = 1.5 / z;
      c.beginPath(); c.arc(p[0], p[1], sp.r * W * k, 0, 7); c.stroke();
    });
    const d = this._drag;
    if (d && d.rt && d.mode === 'paint') { path(d.pend.pts); c.strokeStyle = 'rgba(255,212,0,.45)'; c.lineWidth = d.pend.r * W * k * 2; c.stroke(); }
    if (this.cloneSrc && this.tool === 'clone') {
      const p = this.srcToDisp(this.cloneSrc); c.strokeStyle = '#fff'; c.lineWidth = 1.5 / z;
      c.beginPath(); c.moveTo(p[0] - 10 / z, p[1]); c.lineTo(p[0] + 10 / z, p[1]); c.moveTo(p[0], p[1] - 10 / z); c.lineTo(p[0], p[1] + 10 / z); c.stroke();
    }
    if (finger) { c.strokeStyle = this.tool === 'erase' ? '#ff6b6b' : '#ffd400'; c.lineWidth = 1.2 / z; c.beginPath(); c.arc(finger[0], finger[1], this.rtSize / 100 * W * k, 0, 7); c.stroke(); }
  }

  drawOverlay(finger) {
    const ov = this.viewer.ov, c = ov.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, ov.width, ov.height);
    if (!this.cur || !this.viewer.img) return;
    const z = this.viewer.z;
    if (this.tool === 'crop' && this.s.crop_rect) drawCropOverlay(c, ov.width, ov.height, this.s.crop_rect, this.cropOverlay, z);
    if ((this.tool === 'level' || this.tool === 'kguide') && this._drag) {
      c.strokeStyle = '#ffd400'; c.lineWidth = 2.5 / z; c.beginPath(); c.moveTo(...this._drag.p); c.lineTo(...this._drag.q); c.stroke();
    }
    if (this.tool === 'kguide' || (this.panels.cur === 'lens' && (this.s.lens.kguides || []).length && !this.s.lens.kmat)) {
      c.lineWidth = 2 / z;
      for (const g of this.s.lens.kguides || []) {
        c.strokeStyle = g.o === 'v' ? '#ffd400' : '#3d8bfd';
        const a = this.srcToDisp([g.p[0], g.p[1]]), b = this.srcToDisp([g.p[2], g.p[3]]);
        c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
      }
    }
    if (this.panels.cur === 'retouch' || this.panels.cur === 's_erase') this.drawRetouch(c, z, finger);
    if ((this.panels.cur === 'portrait' || this.panels.cur === 's_face') && this.faces && this.faces.length) {
      // khung cam đánh số từng khuôn mặt (trái -> phải) + vùng bảo vệ
      c.lineWidth = 2 / z; c.font = `bold ${16 / z}px -apple-system, sans-serif`;
      const boxes = faceBoxes(this.faces).map((b, i) => [b, i]).sort((a, b) => (a[0][0] + a[0][2]) - (b[0][0] + b[0][2]));
      boxes.forEach(([b], k) => {
        const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map((q) => this.srcToDisp(q));
        const sel = this.s.retouch.portrait.who === String(k);
        c.strokeStyle = sel ? '#ffd400' : '#f0a030';
        c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q))); c.closePath(); c.stroke();
        c.fillStyle = sel ? '#ffd400' : '#f0a030'; c.fillText(String(k + 1), pts[0][0] + 4 / z, pts[0][1] - 6 / z);
      });
      const W = this.pw, { k } = this.geo();
      c.strokeStyle = 'rgba(80,200,255,.5)'; c.lineCap = 'round'; c.lineJoin = 'round';
      for (const st of this.s.retouch.portrait.protect || []) {
        c.strokeStyle = st.erase ? 'rgba(255,90,90,.45)' : 'rgba(80,200,255,.45)'; c.lineWidth = st.r * W * k * 2;
        c.beginPath(); st.pts.forEach((q, i) => { const d = this.srcToDisp(q); i ? c.lineTo(...d) : c.moveTo(...d); }); if (st.pts.length === 1) { const d = this.srcToDisp(st.pts[0]); c.lineTo(d[0] + 0.01, d[1]); } c.stroke();
      }
    }
    const ly = this.curLayer();
    if (ly && this.panels.cur === 'layer') {
      c.lineWidth = 1.6 / z;
      for (const g of ly.linear) {
        const a = this.srcToDisp([g.x0, g.y0]), b = this.srcToDisp([g.x1, g.y1]);
        c.strokeStyle = '#fff'; c.setLineDash([6 / z, 4 / z]); c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke(); c.setLineDash([]);
        for (const q of [a, b]) { c.beginPath(); c.arc(q[0], q[1], 5 / z, 0, 7); c.stroke(); }
      }
      for (const g of ly.radial) {
        const cc = this.srcToDisp([g.cx, g.cy]), ex = this.srcToDisp([g.cx + g.rx, g.cy]), ey = this.srcToDisp([g.cx, g.cy + g.ry * this.pw / this.ph]);
        c.strokeStyle = '#fff'; c.beginPath();
        c.ellipse(cc[0], cc[1], Math.max(1, Math.hypot(ex[0] - cc[0], ex[1] - cc[1])), Math.max(1, Math.hypot(ey[0] - cc[0], ey[1] - cc[1])), 0, 0, 7); c.stroke();
        c.beginPath(); c.arc(cc[0], cc[1], 4 / z, 0, 7); c.stroke();
      }
      if (finger && (this.tool === 'lbrush' || this.tool === 'lerase')) {
        const { k } = this.geo();
        c.strokeStyle = this.tool === 'lerase' ? '#ff6b6b' : '#ffd400';
        c.beginPath(); c.arc(finger[0], finger[1], this.brushSize / 100 * this.pw * k, 0, 7); c.stroke();
      }
    }
  }

  // ----------------------------------------------------------------- khung
  setCrop(v) {
    this.begin('Tỉ lệ cắt');
    this.set(['crop'], v);
    if (this.tool === 'crop' || this.s.crop_rect) {
      const g = E.geometryAffine(this.pw, this.ph, this.s, false);
      this.set(['crop_rect'], v === 'orig' && this.tool !== 'crop' ? null : rectForRatio(v, g.w, g.h));
    }
    this.end();
    this.drawOverlay();
  }
  swapCrop() {
    const sw = { '4:5': '5:4', '5:4': '4:5', '3:2': '2:3', '2:3': '3:2', '16:9': '9:16', '9:16': '16:9' };
    if (sw[this.s.crop]) return this.setCrop(sw[this.s.crop]);
    const r = this.s.crop_rect;
    if (!r) return this.toast('Chọn tỉ lệ hoặc cắt tự do trước rồi mới đổi chiều');
    const g = E.geometryAffine(this.pw, this.ph, this.s, false);
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, wpx = (r[2] - r[0]) * g.w, hpx = (r[3] - r[1]) * g.h;
    let nw = hpx / g.w, nh = wpx / g.h;
    const f = Math.min(1, 1 / nw, 1 / nh); nw *= f; nh *= f;
    const x0 = Math.min(Math.max(0, cx - nw / 2), 1 - nw), y0 = Math.min(Math.max(0, cy - nh / 2), 1 - nh);
    this.begin('Đổi chiều khung'); this.set(['crop_rect'], [x0, y0, x0 + nw, y0 + nh]); this.end();
    this.drawOverlay();
  }
  clearCrop() { this.begin('Bỏ cắt'); this.set(['crop'], 'orig'); this.set(['crop_rect'], null); this.set(['crop_outside'], false); this.end(); if (this.tool === 'crop') this.setTool(null); }
  rotate(d) { this.begin(d < 0 ? 'Xoay trái' : 'Xoay phải'); this.set(['rotate'], (((this.s.rotate || 0) + d) % 360 + 360) % 360); this.set(['crop_rect'], null); this.end(); }

  // ----------------------------------------------------------------- Auto
  async auto(key) {
    if (!this.cur) return this.toast('Chưa mở ảnh nào');
    if (key === 'wb') {
      const r = await this.call('auto', { id: this.cur.id, key: 'color', settings: this.s });
      const up = r.res.up.filter(([p]) => p[0] === 'temp' || p[0] === 'tint');
      this.begin('Cân bằng trắng tự động'); for (const [p, v] of up) this.set(p, v); this.end();
      this.wbMode = 'auto'; this.panels.sync();
      return this.toast(`Cân bằng trắng tự động: ${up.map(([, v]) => v).join(' / ')}`);
    }
    this.busy(true);
    try {
      const r = await this.call('auto', { id: this.cur.id, key, settings: this.s, layer: this.layerIdx });
      this.begin('Auto ' + key);
      for (const [p, v] of r.res.up) this.set(p, v);
      this.end();
      this.toast(r.res.msg, 3500);
    } catch (e) { this.toast('Auto lỗi: ' + e.message); }
    this.busy(false);
  }

  // ----------------------------------------------------------------- ảnh không đang mở (xuất hàng loạt, so sánh)
  async preparePhoto(p, side = PREVIEW_SIDE) {
    if (this.cur && p.id === this.cur.id && side === PREVIEW_SIDE && this.bitmap) return { id: p.id, src: this.bitmap, release() {} };
    const blob = await store.getFile(p.fileId || p.id);
    if (!blob) throw new Error('mất tệp ảnh trong bộ nhớ app');
    const dec = await decodeFile(blob, p.name);
    const src = dec.src;
    const k = Math.min(1, side / Math.max(src.width, src.height));
    const pw = Math.max(1, Math.round(src.width * k)), ph = Math.max(1, Math.round(src.height * k));
    const rgba = src.region(0, 0, src.width, src.height, pw, ph), keep = rgba.slice();
    const id = 'x_' + p.id + '_' + side;
    await this.call('base', { id, rgba, w: pw, h: ph, fullW: src.width, fullH: src.height, draftSide: 320, photo: photoKey(p) }, [rgba.buffer]);
    const s = S.mergeSettings(p.settings);
    const ai = await import('./ai.js');
    const { needsPerson } = await import('./engine/portrait.js');
    const pa = portraitActive(s.retouch.portrait);
    if (s.layers.some((l) => l.person) || (pa && needsPerson(s.retouch.portrait))) await this.call('person', { id, mask: await ai.personMask(keep, pw, ph) });
    if (pa) await this.call('faces', { id, faces: await ai.faceLandmarks(keep, pw, ph) });
    return { id, src, release: () => { this.worker.postMessage({ type: 'drop', id }); if (src.close) src.close(); } };
  }
  // dựng nhiều bộ thông số cho CÙNG một ảnh (null = thông số của ảnh), giải mã ảnh một lần — dùng cho So sánh trước / sau
  async renderPhotoVariants(p, side, list) {
    const prep = await this.preparePhoto(p, side);
    try {
      const out = [];
      for (const o of list) {
        const isCur = this.cur && p.id === this.cur.id;
        // ảnh đang mở, thông số hiện tại: dùng luôn ảnh đang hiện (đã dựng xong) -> mở So sánh nhanh hơn
        const v = this.viewer.img;
        if (!o && isCur && side === PREVIEW_SIDE && v && this.lastWhich === 'full' && this.tool !== 'crop' && !this.inflight && !this.want) {
          out.push({ w: v.width, h: v.height, rgba: new Uint8ClampedArray(v.data) });
          continue;
        }
        const s = o ? S.mergeSettings(o) : (isCur ? this.s : S.mergeSettings(p.settings));
        out.push(await this.call('render', { id: prep.id, which: 'full', settings: s, geom: true }));
      }
      return out;
    } finally { if (prep.id !== (this.cur && this.cur.id)) prep.release(); }
  }
  async renderPhotoPreview(p, side, override) {
    const prep = await this.preparePhoto(p, side);
    try {
      const s = override ? S.mergeSettings(override) : (this.cur && p.id === this.cur.id ? this.s : S.mergeSettings(p.settings));
      return await this.call('render', { id: prep.id, which: 'full', settings: s, geom: true });
    } finally { if (prep.id !== (this.cur && this.cur.id)) prep.release(); }
  }

  // ----------------------------------------------------------------- AI
  async ensurePerson() {
    if (!this.cur || this.personFor === this.cur.id) return true;
    const id = this.cur.id;
    this.busy(true); this.toast('Đang tách người bằng AI…', 2000);
    try {
      const { personMask } = await import('./ai.js');
      const t0 = performance.now();
      const m = await personMask(this.baseRGBA, this.pw, this.ph);
      if (!this.cur || this.cur.id !== id) return false;
      await this.call('person', { id, mask: m });
      this.personFor = id; this.personMs = performance.now() - t0;
      if (!m.n) this.toast('AI không thấy người nào trong ảnh');
      this.requestRender(false);
      return true;
    } catch (e) { console.error(e); this.toast('Không chạy được AI tách người: ' + e.message, 4000); return false; }
    finally { this.busy(false); }
  }
  async ensureFaces() {
    if (!this.cur || this.facesFor === this.cur.id) return this.faces || [];
    const id = this.cur.id;
    this.busy(true);
    try {
      const { faceLandmarks } = await import('./ai.js');
      const t0 = performance.now();
      const f = await faceLandmarks(this.baseRGBA, this.pw, this.ph);
      if (!this.cur || this.cur.id !== id) return [];
      await this.call('faces', { id, faces: f });
      this.faces = f; this.facesFor = id; this.facesMs = performance.now() - t0;
      this.requestRender(false); this.drawOverlay();
      return f;
    } catch (e) { console.error(e); this.toast('Không chạy được AI nhận diện khuôn mặt: ' + e.message, 4000); return []; }
    finally { this.busy(false); }
  }

  // ----------------------------------------------------------------- giao diện đơn giản: Tự động một chạm
  async autoSome(keys, label = 'Tự động') {
    if (!this.cur) return this.toast('Chưa mở ảnh nào');
    this.busy(true);
    const msgs = [];
    try {
      this.begin(label);
      for (const key of keys) {                       // lần lượt: nhóm sau đo trên ảnh đã có nhóm trước
        const r = await this.call('auto', { id: this.cur.id, key, settings: this.s, layer: this.layerIdx });
        for (const [p, v] of r.res.up) this.set(p, v);
        msgs.push(r.res.msg);
      }
      this.end();
    } catch (e) { this.end(); this.toast('Auto lỗi: ' + e.message); }
    this.busy(false);
    return msgs;
  }
  async autoAll() {
    const m = await this.autoSome(['color', 'tone', 'presence'], 'Tự động chỉnh ảnh');
    if (m) this.toast('Đã tự cân màu, sáng tối và độ trong', 2500);
  }
  async autoFace() {
    if (!this.cur) return this.toast('Chưa mở ảnh nào');
    const f = await this.ensureFaces();
    if (!f || !f.length) return this.toast('Không thấy khuôn mặt nào trong ảnh');
    await this.autoSome(['portrait:Xoá khuyết điểm', 'portrait:Điều chỉnh da', 'portrait:Tăng cường mắt', 'portrait:Làm đẹp răng'], 'Làm đẹp tự động');
    this.toast(`Đã làm đẹp ${f.length} khuôn mặt — chỉnh thêm bằng các thanh bên dưới`, 3000);
  }
  clearStyle() {
    if (!this._style) return;
    this.begin('Bỏ style');
    this.s = S.mergeSettings(this._styleBase);
    this._style = null; this.styleApplied = null; this.styleStrength = 100;
    this.end();
  }
  // ảnh xem trước nhỏ của từng style trên chính ảnh đang mở
  async styleThumbs() {
    if (!this.cur || this._thumbBusy || this.inflight || this.want) return;
    const base = this._style ? this._styleBase : this.s;
    const key = J([this.cur.id, base, this.allStyles().map((x) => x[0])]);
    if (key === this._thumbKey) return;
    this._thumbBusy = true;
    const id = this.cur.id, out = {};
    try {
      for (const [name, st] of [['Gốc', null], ...this.allStyles()]) {
        const s = st ? S.blendStyle(base, st, 1) : base;
        const r = await this.call('render', { id, which: 'thumb', settings: s, geom: true });
        if (!this.cur || this.cur.id !== id) return;
        out[name] = await createImageBitmap(new ImageData(r.rgba, r.w, r.h));
        this.thumbs = Object.assign({}, this.thumbs || {}, out);
        this.panels.drawStyleGrid();
      }
      this._thumbKey = key;
    } catch (e) { console.warn(e); } finally { this._thumbBusy = false; }
  }

  // ----------------------------------------------------------------- layer
  addLayer() {
    this.begin('Thêm layer');
    const n = this.s.layers.length + 1;
    this.s.layers.push(S.newLayer('Layer ' + n));
    this.layerIdx = this.s.layers.length - 1;
    this.end(); this.panels.sync();
  }
  dupLayer() { const ly = this.curLayer(); if (!ly) return; this.begin('Nhân bản layer'); const c = deep(ly); c.name += ' (bản sao)'; this.s.layers.splice(this.layerIdx + 1, 0, c); this.layerIdx++; this.end(); }
  renameLayer() { const ly = this.curLayer(); if (!ly) return; const n = prompt('Tên layer', ly.name); if (n) { this.begin('Đổi tên layer'); ly.name = n; this.end(); } }
  delLayer() { if (!this.curLayer()) return; this.begin('Xoá layer'); this.s.layers.splice(this.layerIdx, 1); this.layerIdx = Math.min(this.layerIdx, this.s.layers.length - 1); this.end(); }
  clearLayerShapes(kind) {
    const ly = this.curLayer(); if (!ly) return;
    this.begin(kind === 'grad' ? 'Xoá gradient' : 'Xoá nét cọ');
    if (kind === 'grad') { ly.linear = []; ly.radial = []; } else ly.brush = [];
    this.end(); this.drawOverlay();
  }
  setRadialFeather(v, live) {
    this.radialFeather = v;
    const ly = this.curLayer();
    if (ly && ly.radial.length) { for (const g of ly.radial) g.feather = v; this.requestRender(!!live); }
  }

  // ----------------------------------------------------------------- style
  allStyles() { return [...Object.entries(S.BUILTIN_STYLES), ...this.userStyles.map((x) => [x.name, x.style])]; }
  applyStyle(name, st) {
    this.begin('Style ' + name);
    this._styleBase = deep(this.s);
    this._style = st;
    this.styleApplied = name;
    this.styleStrength = 100;
    this.s = S.blendStyle(this._styleBase, st, 1.0);
    this.end();
    this.toast('Đã áp style ' + name);
  }
  setStyleStrength(v, live) {
    this.styleStrength = v;
    if (!this._style) return;
    this.s = S.blendStyle(this._styleBase, this._style, v / 100);
    this.requestRender(!!live);
    if (!live) this.panels.sync();
  }
  async saveStyle() {
    const name = prompt('Tên style mới', 'Style của tôi');
    if (!name) return;
    const st = S.styleFromSettings(this.s);
    await store.putStyle(name, st);
    this.userStyles = await store.styles();
    this.panels.sync(); this.toast('Đã lưu style ' + name);
  }
  async deleteStyle() {
    if (!this.userStyles.length) return this.toast('Chưa có style riêng nào');
    const name = prompt('Gõ tên style riêng cần xoá:\n' + this.userStyles.map((x) => x.name).join(', '));
    if (!name) return;
    await store.delStyle(name); this.userStyles = await store.styles(); this.panels.sync();
  }
  importStyle() {
    const inp = $('fileJson');
    inp.onchange = async () => {
      const files = [...inp.files]; inp.value = '';
      for (const f of files) {
        try {
          const st = JSON.parse(await f.text());
          const name = f.name.replace(/\.json$/i, '');
          await store.putStyle(name, st);
        } catch (e) { this.toast(`Tệp ${f.name} không phải style hợp lệ`); }
      }
      this.userStyles = await store.styles(); this.panels.sync(); this.toast('Đã nhập style');
    };
    inp.click();
  }
  exportStyle() {
    const st = S.styleFromSettings(this.s);
    shareOrDownload(new Blob([JSON.stringify(st, null, 1)], { type: 'application/json' }), (this.styleApplied || 'Style PUM') + '.json', this);
  }
  copySettings() { this.clip = S.styleFromSettings(this.s, true); this.toast('Đã sao chép chỉnh sửa (trừ khung cắt / góc xoay)'); }
  pasteSettings() {
    if (!this.clip) return this.toast('Chưa sao chép chỉnh sửa nào');
    this.begin('Dán chỉnh sửa');
    const keep = { straighten: this.s.straighten, crop_rect: this.s.crop_rect, flip: this.s.flip, crop_outside: this.s.crop_outside, kguides: this.s.lens.kguides, kmat: this.s.lens.kmat };
    this.s = S.mergeSettings(Object.assign(deep(this.clip), { straighten: keep.straighten, crop_rect: keep.crop_rect, flip: keep.flip, crop_outside: keep.crop_outside }));
    this.s.lens.kguides = keep.kguides; this.s.lens.kmat = keep.kmat;
    this.end(); this.toast('Đã dán chỉnh sửa');
  }
  async pasteAll() {
    if (!this.clip) return this.toast('Chưa sao chép chỉnh sửa nào');
    if (!confirm(`Dán chỉnh sửa cho tất cả ${this.photos.length} ảnh?`)) return;
    for (const p of this.photos) {
      if (this.cur && p.id === this.cur.id) continue;
      const cur = S.mergeSettings(p.settings);
      const ns = S.mergeSettings(Object.assign(deep(this.clip), { straighten: cur.straighten, crop_rect: cur.crop_rect, flip: cur.flip, crop_outside: cur.crop_outside }));
      p.settings = ns; await store.putPhoto(p);
    }
    this.pasteSettings();
    this.toast('Đã dán cho mọi ảnh (thumbnail cập nhật khi mở từng ảnh)');
  }
  resetAll() { this.begin('Đặt lại toàn bộ'); this.s = S.defaultSettings(); this.layerIdx = -1; this.end(); }

  // ---------------- đặt lại nhiều mức (MainWindow.reset_settings / reset_images bản máy tính) ----------------
  static resetSettings(old, kind, tab) {
    const d = S.defaultSettings();
    if (kind === 'all') return d;
    const nw = S.mergeSettings(deep(old));
    if (kind === 'color_tone') {           // màu, tông, chi tiết, hiệu ứng; giữ retouch, layer, khung cắt, xoay
      for (const k of Object.keys(d)) if (!GEOM_KEYS.includes(k) && k !== 'retouch' && k !== 'layers') nw[k] = deep(d[k]);
    } else if (kind === 'geometry') {
      for (const k of GEOM_KEYS) nw[k] = deep(d[k]);
    } else if (kind === 'retouch') {       // heal, clone, xoá vật thể, bụi, làm mịn da (giữ chân dung)
      const p = nw.retouch.portrait;
      nw.retouch = deep(d.retouch);
      if (p) nw.retouch.portrait = p;
    } else if (kind === 'portrait') nw.retouch.portrait = deep(d.retouch.portrait);
    else if (kind === 'layers') nw.layers = [];
    else if (kind === 'tab') {
      if (tab === 'retouch') { const p = nw.retouch.portrait; nw.retouch = deep(d.retouch); nw.retouch.portrait = p; }
      else if (tab === 'portrait') nw.retouch.portrait = deep(d.retouch.portrait);
      else for (const k of TAB_KEYS[tab] || []) nw[k] = deep(d[k]);
    }
    return nw;
  }
  // đặt lại `kind` cho các ảnh; ảnh đang mở hoàn tác bằng ↶ như mọi thao tác, ảnh khác: mở ảnh đó rồi ↶
  async resetPhotos(kind, photos, tab) {
    const label = kind === 'tab' ? `Đặt lại tab "${(TABS_LABEL[tab] || tab)}"` : RESET_KINDS[kind];
    if (photos.length > 1 && !confirm(`${label} cho ${photos.length} ảnh?\n\nCó thể lấy lại: mở từng ảnh rồi bấm ↶ Hoàn tác.`)) return;
    await this.saveCurrent();
    let changed = 0;
    for (const p of photos) {
      const isCur = this.cur && p.id === this.cur.id;
      const old = S.mergeSettings(isCur ? this.s : p.settings);
      const nw = App.resetSettings(old, kind, tab);
      if (J(old) === J(S.mergeSettings(nw))) continue;
      changed++;
      if (isCur) {
        this.begin(label); this.s = S.mergeSettings(nw);
        if (this.layerIdx >= this.s.layers.length) this.layerIdx = this.s.layers.length - 1;
        this.end();
        continue;
      }
      const H = this.histories.get(p.id);
      if (H) { H.stack.splice(H.idx + 1); H.stack.push({ label, s: J(S.mergeSettings(nw)) }); H.idx = H.stack.length - 1; }
      else this.histories.set(p.id, { stack: [{ label: 'Trước khi đặt lại', s: J(old) }, { label, s: J(S.mergeSettings(nw)) }], idx: 1 });
      p.settings = S.isDefault(nw) ? null : nw;
      await store.putPhoto(p);
    }
    this.renderStrip();
    this.toast(changed ? `${label}: ${changed} ảnh (↶ để lấy lại)` : `${label} — không có gì để đặt lại`, 3000);
  }
  openResetMenu(photos) {
    const ps = photos || (this.cur ? [this.cur] : []);
    if (!ps.length) return this.toast('Chưa mở ảnh nào');
    const go = (kind, tab) => { this.closeSheet(); this.resetPhotos(kind, ps, tab); };
    const tab = this.panels.cur;
    const body = h('div', { class: 'menu' },
      btn('Đặt lại toàn bộ chỉnh sửa', () => go('all')),
      btn('Chỉ màu & tông (giữ retouch, layer, khung cắt)', () => go('color_tone')),
      btn('Khung cắt, xoay, lật & ống kính', () => go('geometry')),
      btn('Xoá retouch (heal, clone, xoá vật thể, bụi, làm mịn da)', () => go('retouch')),
      btn('Đặt lại chân dung', () => go('portrait')),
      btn('Xoá mọi layer', () => go('layers')),
      !photos && TAB_KEYS[tab] !== undefined ? btn(`Đặt lại tab đang mở ("${TABS_LABEL[tab]}")`, () => go('tab', tab)) : null,
      !photos && this.photos.length > 1 ? btn(`Đặt lại TOÀN BỘ ảnh trong app (${this.photos.length} ảnh)…`, () => { this.closeSheet(); this.resetPhotos('all', this.photos.slice()); }) : null,
      hint(ps.length > 1 ? `Áp cho ${ps.length} ảnh đã chọn. Mỗi ảnh lấy lại được bằng ↶ Hoàn tác khi mở ảnh đó.` : 'Lấy lại được bằng ↶ Hoàn tác.'));
    this.openSheet(ps.length > 1 ? `Đặt lại ${ps.length} ảnh` : 'Đặt lại', body);
  }

  // ----------------------------------------------------------------- menu
  openSheet(title, body, full) {
    $('sheetTitle').textContent = title; $('sheetBody').replaceChildren(body);
    $('sheet').classList.toggle('full', !!full); $('sheet').classList.remove('hidden');
  }
  closeSheet() { $('sheet').classList.add('hidden'); if (this.onSheetClose) { const f = this.onSheetClose; this.onSheetClose = null; f(); } }
  openMenu() {
    const clip = toggle('Cảnh báo cháy sáng / mất chi tiết tối', () => this.viewer.clip, (v) => { this.viewer.clip = v; this.viewer.paint(); });
    clip.sync();
    const p = this.cur;
    const rate = p ? h('div', { class: 'chips', style: 'margin-bottom:8px' }, ...[0, 1, 2, 3, 4, 5].map((n) => h('button', { class: p.rating === n ? 'sel' : '',
      onclick: async () => { p.rating = n; await store.putPhoto(p); this.openMenu(); } }, n ? '★'.repeat(n) : '☆')),
    h('button', { class: p.flag === 1 ? 'sel' : '', onclick: async () => { p.flag = p.flag === 1 ? 0 : 1; await store.putPhoto(p); this.openMenu(); } }, '✓ Chọn'),
    h('button', { class: p.flag === -1 ? 'sel' : '', onclick: async () => { p.flag = p.flag === -1 ? 0 : -1; await store.putPhoto(p); this.openMenu(); } }, '✕ Loại')) : null;
    const simple = this.panels.mode === 'simple';
    const body = h('div', { class: 'menu' }, rate,
      btn(simple ? '🔧 Giao diện đầy đủ (mọi công cụ như PUM máy tính)' : '✨ Giao diện đơn giản (dễ dùng)', () => { this.closeSheet(); this.panels.setMode(simple ? 'full' : 'simple'); }),
      btn('🗂 Thư viện (lọc, đánh sao, so sánh, xuất hàng loạt)', () => this.openLibrary()),
      btn('📂 Mở ảnh từ Ảnh / Tệp', () => { this.closeSheet(); $('file').click(); }),
      p ? btn('↺ Đặt lại… (toàn bộ, màu & tông, khung cắt, retouch, chân dung, layer, tab đang mở)', () => this.openResetMenu()) : null,
      p ? btn('◫ So sánh trước / sau (cùng ảnh, hoặc với bản sao ảo)', async () => { const m = await import('./ui/library.js'); await this.saveCurrent(); m.compare(this, [p]); }) : null,
      clip.el,
      btn('🧽 Mô hình AI xoá vật thể' + (this.xvReady() ? ' (đã có)' : ' (chưa tải)'), () => this.aiMenu()),
      p ? btn('🔎 Kiểm tra độ sáng ảnh (so với Safari)', () => this.colorCheck()) : null,
      btn('🗑 Gỡ ảnh đang xem khỏi app', () => this.removeCurrent()),
      btn('💾 Sao lưu thông số + style ra tệp', () => this.backup()),
      btn('♻️ Khôi phục từ tệp sao lưu', () => this.restore()),
      btn('ℹ️ Giới thiệu PUM iPhone', () => this.about()));
    this.openSheet('PUM', body);
  }
  async openLibrary() { const m = await import('./ui/library.js'); await this.saveCurrent(); m.openLibrary(this); }
  async removeCurrent() {
    if (!this.cur) return;
    if (!confirm(`Gỡ "${this.cur.name}" khỏi PUM? (Ảnh gốc trong thư viện Ảnh của iPhone không bị ảnh hưởng.)`)) return;
    const id = this.cur.id, fid = this.cur.fileId || id;
    await store.delPhotoOnly(id);
    if (!this.photos.some((q) => q.id !== id && (q.fileId || q.id) === fid)) await store.delFile(fid);
    this.worker.postMessage({ type: 'drop', id });
    this.photos = this.photos.filter((p) => p.id !== id);
    this.cur = null; this.bitmap = null;
    this.closeSheet();
    const nx = this.photos[this.photos.length - 1];
    if (nx) this.openPhoto(nx);
    else { $('empty').style.display = ''; this.viewer.img = null; this.viewer.cv.width = 0; $('title').textContent = 'PUM'; this.renderStrip(); }
  }
  async backup() {
    await this.saveCurrent();
    const data = { app: 'PUM iPhone', version: VERSION, date: new Date().toISOString(),
      photos: this.photos.map((p) => ({ name: p.name, size: p.size, settings: p.settings, rating: p.rating, flag: p.flag, label: p.label })),
      styles: this.userStyles, prefs: { export: await store.get('export_opts') } };
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    shareOrDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), `PUM_saoluu_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`, this);
  }
  restore() {
    const inp = $('fileJson');
    inp.onchange = async () => {
      const f = inp.files[0]; inp.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        let n = 0;
        for (const q of data.photos || []) {
          const p = this.photos.find((x) => x.name === q.name && (!q.size || x.size === q.size));
          if (!p) continue;
          Object.assign(p, { settings: q.settings, rating: q.rating || 0, flag: q.flag || 0, label: q.label || '' });
          await store.putPhoto(p); n++;
        }
        for (const st of data.styles || []) await store.putStyle(st.name, st.style);
        if (data.prefs && data.prefs.export) await store.set('export_opts', data.prefs.export);
        this.userStyles = await store.styles();
        if (this.cur) { const c = this.cur; this.cur = null; this.histories.delete(c.id); this.bitmap = null; await this.openPhoto(c); }
        this.toast(`Đã khôi phục thông số cho ${n} ảnh và ${(data.styles || []).length} style`, 4000);
      } catch (e) { this.toast('Tệp sao lưu không hợp lệ: ' + e.message, 4000); }
    };
    inp.click();
  }
  async about() {
    let est = '';
    try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1048576).toFixed(0)} MB / ${(e.quota / 1048576).toFixed(0)} MB`; } catch (e) { est = '—'; }
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    this.openSheet('Giới thiệu', h('div', {},
      h('div', { style: 'font-size:34px;font-weight:800;color:var(--acc);letter-spacing:2px' }, 'PUM'),
      h('div', { class: 'kv' },
        'Phiên bản', h('b', {}, `${VERSION} (${BUILD_DATE})`),
        'Chế độ', h('b', {}, standalone ? 'Đã cài trên màn hình chính' : 'Đang mở trong trình duyệt'),
        'Chạy không cần mạng', h('b', {}, navigator.serviceWorker && navigator.serviceWorker.controller ? 'Có' : 'Chưa (cần mở qua https một lần)'),
        'Ảnh trong app', h('b', {}, String(this.photos.length)),
        'Bộ nhớ đã dùng', h('b', {}, est),
        'Lần mở ảnh gần nhất', h('b', {}, this.openMs ? `${this.openMs.toFixed(0)} ms` : '—'),
        'Lần dựng gần nhất', h('b', {}, this.lastMs ? `${this.lastMs.toFixed(0)} ms (${this.lastWhich === 'draft' ? 'bản nháp' : 'xem trước'})` : '—')),
      hint('Ảnh chỉnh trên iPhone cho màu giống hệt PUM máy tính (cùng công thức). Style .json dùng chung hai bên.'),
      h('div', { style: 'font-weight:600;margin-top:10px' }, `Có gì mới ở bản ${VERSION}`),
      h('ul', { style: 'margin:4px 0 0 18px;padding:0;color:var(--fg2);font-size:13px' }, ...NOTES.map((t) => h('li', { style: 'margin:3px 0' }, t)))));
  }
}

function straightenFromLine(dx, dy) {
  let a = Math.atan2(dy, dx) * 180 / Math.PI;
  if (a <= -90) a += 180;
  if (a > 90) a -= 180;
  if (Math.abs(a) <= 45) return -a;
  return -(a > 0 ? a - 90 : a + 90);
}

// một vùng của nguồn ảnh (decode.js: BitmapSource / ArraySource) ra RGBA ở cỡ (tw, th)
export function drawScaled(src, sx, sy, sw, sh, tw, th) { return src.region(sx, sy, sw, sh, tw, th); }
// mã ảnh dùng làm khoá kết quả AI xoá vật thể (bản sao ảo dùng chung tệp ảnh với ảnh gốc)
export const photoKey = (p) => (p ? p.fileId || p.id : null);

export async function shareOrDownload(blob, name, app) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  app && app.toast('Đã tải xuống ' + name);
  return true;
}

window.PUM = new App();
