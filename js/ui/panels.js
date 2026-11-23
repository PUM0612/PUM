// Bảng chỉnh (theo panels.py bản máy tính): lưới tab, nhóm thu gọn có Auto + Đặt lại, thanh phụ thuộc bị làm mờ.
import { h, Slider, Section, toggle, select, hint, btn } from './controls.js';
import { ColorWheel, CurveEditor } from './widgets.js';
import { Scopes } from './scopes.js';
import { BANDS, CROPS, LAYER_ADJ, BUILTIN_STYLES, defaultSettings, newLayer } from '../engine/settings.js';
import { oklchColor, colorRangeWeight } from '../engine/engine.js';

const CROP_LABELS = { orig: 'Gốc', '1:1': '1:1 vuông', '4:5': '4:5 dọc', '5:4': '5:4 ngang', '3:2': '3:2 ngang', '2:3': '2:3 dọc', '16:9': '16:9 ngang', '9:16': '9:16 dọc' };
export const TABS = [
  ['basic', '☀', 'Cơ bản'], ['color', '◍', 'Màu'], ['grading', '◑', 'Grading'], ['curve', '∿', 'Curve'],
  ['detail', '◎', 'Chi tiết'], ['lens', '⬚', 'Khung'], ['layer', '▤', 'Layer'], ['retouch', '✚', 'Retouch'], ['portrait', '☺', 'Chân dung'],
  ['style', '★', 'Style'], ['scopes', '▦', 'Biểu đồ'],
];

// Giao diện Đơn giản (mặc định cho mọi người): 6 tab, mỗi tab vài thanh chính, Tự động một chạm.
export const SIMPLE_TABS = [
  ['s_auto', '✦', 'Tự động'], ['s_light', '☀', 'Ánh sáng'], ['s_color', '◍', 'Màu'],
  ['s_effect', '◎', 'Hiệu ứng'], ['s_crop', '⬚', 'Cắt'], ['s_erase', '✚', 'Xoá'], ['s_face', '☺', 'Chân dung'],
];
const TO_FULL = { s_auto: 'style', s_light: 'basic', s_color: 'color', s_effect: 'detail', s_crop: 'lens', s_erase: 'retouch', s_face: 'portrait' };
const TO_SIMPLE = { basic: 's_light', color: 's_color', grading: 's_color', curve: 's_light', detail: 's_effect', lens: 's_crop', retouch: 's_erase', portrait: 's_face', style: 's_auto' };

export class Panels {
  constructor(app) {
    this.app = app;
    this.widgets = [];
    this.tabsEl = document.getElementById('tabs');
    this.pane = document.getElementById('pane');
    this.pages = {};
    this.band = 'red';
    let m = 'simple';
    try { m = localStorage.getItem('pum_ui_mode') || 'simple'; } catch (e) { /* bỏ qua */ }
    this.mode = m === 'full' ? 'full' : 'simple';
    this.build();
    this.buildSimple();
    this.renderTabs();
    this.show(this.mode === 'simple' ? 's_auto' : 'basic');
  }
  renderTabs() {
    document.getElementById('app').classList.toggle('simple', this.mode === 'simple');
    this.tabsEl.replaceChildren();
    for (const [k, ic, t] of (this.mode === 'simple' ? SIMPLE_TABS : TABS))
      this.tabsEl.append(h('button', { 'data-k': k, onclick: () => this.show(k) }, h('span', { class: 'ic' }, ic), t));
  }
  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    try { localStorage.setItem('pum_ui_mode', m); } catch (e) { /* bỏ qua */ }
    const target = m === 'simple' ? (TO_SIMPLE[this.cur] || 's_auto') : (TO_FULL[this.cur] || 'basic');
    this.renderTabs();
    this.show(target);
    this.app.toast(m === 'simple' ? 'Giao diện đơn giản' : 'Giao diện đầy đủ (mọi công cụ như PUM máy tính)');
  }
  S(label, path, lo, hi, o = {}) {
    const app = this.app;
    const sl = new Slider(app, Object.assign({ label, lo, hi, get: () => +app.get(path) || 0, set: (v, live) => app.set(path, v, live) }, o));
    this.widgets.push(sl);
    return sl;
  }
  W(w) { this.widgets.push(w); return w; }
  sec(title, o) { return new Section(this.app, title, o); }
  page(k, ...secs) { const el = h('div', { class: 'page' }); for (const s of secs) el.append(s.el || s); this.pages[k] = el; }
  show(k) {
    this.cur = k;
    for (const b of this.tabsEl.children) b.classList.toggle('on', b.dataset.k === k);
    this.pane.replaceChildren(this.pages[k]);
    this.pane.scrollTop = 0;
    this.sync();
    if (this.app.tool) this.app.setTool(null);
    if ((k === 'portrait' || k === 's_face') && this.app.cur) this.app.ensureFaces().then(() => this.sync());
    if (k === 's_auto') this.app.styleThumbs();
    if (this.cadvShow && this.app.cur) this.app.requestRender(false);    // "xem vùng chọn" chỉ hiện ở tab Màu
    this.app.drawOverlay();
  }

  // ------------------------------------------------------------------ giao diện Đơn giản
  buildSimple() {
    const app = this.app;
    const more = (k) => h('button', { class: 'more', onclick: () => this.setMode('full') }, 'Công cụ nâng cao ›');
    const big = (t, fn) => h('button', { class: 'bigauto', onclick: fn }, t);
    // nhiều thông số theo một thanh (tỉ lệ cố định), đọc lại theo thông số chính
    const multi = (label, main, parts, o = {}) => this.S(label, ['_m_' + label], o.lo ?? 0, o.hi ?? 100, Object.assign({
      get: () => Math.round((+app.get(main[0]) || 0) / main[1]),
      set: (v, live) => { for (const [p, k] of parts) app.set(p, Math.round(v * k * 10) / 10, live); },
    }, o));
    // ---- Tự động + style
    this.styleGrid = h('div', { class: 'stylegrid' });
    const strength = new Slider(app, { label: 'Độ mạnh style', lo: 0, hi: 150, def: 100, get: () => app.styleStrength,
      set: (v, live) => app.setStyleStrength(v, live), dep: () => (app.styleApplied ? '' : 'Chọn một style trước') });
    this.W(strength);
    this.W({ sync: () => this.drawStyleGrid() });
    this.page('s_auto',
      big('✨ Tự động chỉnh ảnh', () => app.autoAll()),
      h('div', { class: 'hint' }, 'Cân màu theo da / màu trắng và chỉnh sáng tối như "Bảng điều khiển Capture One" (ảnh ISO cao tự khử nhiễu). Muốn màu giống Capture One: chọn thêm style "Gu Capture One (Cơ bản)".'),
      h('div', { class: 'stitle' }, 'Style'), this.styleGrid, strength.el,
      h('div', { class: 'grid2', style: 'margin-top:8px' }, btn('↺ Bỏ mọi chỉnh sửa', () => app.resetAll()), btn('Sao chép / dán…', () => this.setMode('full'))),
      more());
    // ---- Ánh sáng
    this.page('s_light',
      this.S('Phơi sáng', ['exposure'], -5, 5, { step: 0.01, dec: 2 }),
      this.S('Tương phản', ['contrast'], -100, 100),
      this.S('Vùng sáng', ['highlights'], -100, 100),
      this.S('Vùng tối', ['shadows'], -100, 100),
      this.S('Trắng', ['whites'], -100, 100),
      this.S('Đen', ['blacks'], -100, 100),
      h('div', { class: 'grid2' }, btn('Tự động ánh sáng', () => app.auto('tone')), btn('↺ Đặt lại', () => app.resetPaths([['exposure'], ['contrast'], ['highlights'], ['shadows'], ['whites'], ['blacks'], ['brightness']]))),
      more());
    // ---- Màu
    this.page('s_color',
      this.S('Nhiệt độ', ['temp'], -100, 100, { gradient: ['#3d6fd9', '#cccccc', '#e3b23c'] }),
      this.S('Sắc thái', ['tint'], -100, 100, { gradient: ['#3dbb4a', '#cccccc', '#c94fc4'] }),
      this.S('Độ tươi màu', ['vibrance'], -100, 100, { gradient: ['#777777', '#a98bb8', '#d7508e'] }),
      this.S('Bão hoà', ['saturation'], -100, 100, { gradient: ['#777777', '#cf9a52', '#e2403a'] }),
      this.S('Độ sâu màu', ['depth'], -100, 100, { gradient: ['#e8c9c9', '#c0605a', '#6e1410'] }),
      this.S('Đỏ đầm (phim)', ['film_color'], 0, 100, { gradient: ['#f08a80', '#c2302a', '#7a0f0c'] }),
      multi('Da đều màu', [['skin', 'uni_hue'], 1], [[['skin', 'uni_hue'], 1], [['skin', 'uni_sat'], 0.7], [['skin', 'uni_lum'], 0.4]]),
      h('div', { class: 'grid3' }, btn('Tự động màu', () => app.auto('color')), btn('💧 Chấm điểm trắng', () => app.setTool(app.tool === 'wb' ? null : 'wb')),
        btn('↺ Đặt lại', () => app.resetPaths([['temp'], ['tint'], ['vibrance'], ['saturation'], ['depth'], ['film_color'], ['skin']]))),
      more());
    // ---- Hiệu ứng
    this.page('s_effect',
      this.S('Rõ nét', ['clarity'], -100, 100),
      this.S('Khử sương', ['dehaze'], -100, 100),
      this.S('Làm nét', ['sharpen'], 0, 150),
      multi('Khử nhiễu', [['nr_lum'], 1], [[['nr_lum'], 1], [['nr_color'], 0.6]]),
      this.S('Tối góc', ['vignette'], -100, 100),
      this.S('Hạt phim', ['grain'], 0, 100),
      h('div', { class: 'grid2' }, btn('Tự động', () => app.autoSome(['presence', 'sharpen', 'nr'])),
        btn('↺ Đặt lại', () => app.resetPaths([['clarity'], ['dehaze'], ['sharpen'], ['nr_lum'], ['nr_color'], ['vignette'], ['grain'], ['texture']]))),
      more());
    // ---- Cắt & xoay
    const ratios = h('div', { class: 'chips' });
    for (const [k, t] of [['orig', 'Gốc'], ['1:1', '1:1'], ['4:5', '4:5'], ['9:16', '9:16'], ['16:9', '16:9'], ['3:2', '3:2'], ['2:3', '2:3']])
      ratios.append(h('button', { 'data-r': k, onclick: () => app.setCrop(k) }, t));
    const cropBtn = btn('✂ Kéo khung cắt', () => app.setTool(app.tool === 'crop' ? null : 'crop'));
    this.W({ sync: () => {
      for (const b of ratios.children) b.classList.toggle('sel', b.dataset.r === app.get(['crop']) && (b.dataset.r !== 'orig' || !app.get(['crop_rect'])));
      cropBtn.textContent = app.tool === 'crop' ? '✓ Xong cắt' : '✂ Kéo khung cắt'; cropBtn.classList.toggle('sel', app.tool === 'crop');
    } });
    this.page('s_crop',
      h('div', { class: 'stitle' }, 'Tỉ lệ khung'), ratios,
      h('div', { class: 'grid2', style: 'margin-top:8px' }, cropBtn, btn('Bỏ cắt', () => app.clearCrop())),
      this.S('Góc nghiêng', ['straighten'], -45, 45, { step: 0.1, dec: 1 }),
      h('div', { class: 'grid3' }, btn('↺ Xoay trái', () => app.rotate(-90)), btn('↻ Xoay phải', () => app.rotate(90)), btn('Tự cân thẳng', () => app.auto('straighten'))),
      h('div', { class: 'grid2', style: 'margin-top:6px' }, btn('⇋ Lật gương', () => { app.begin('Lật'); app.set(['flip'], app.get(['flip']) === 'h' ? 'none' : 'h'); app.end(); }),
        btn('Kẻ đường chân trời', () => app.setTool(app.tool === 'level' ? null : 'level'))),
      more());
    // ---- Xoá vật thể / mụn / bụi
    const etools = h('div', { class: 'grid3' });
    for (const [k, t] of [['remove', '🧽 Xoá vật thể'], ['heal', '🩹 Xoá mụn, vết'], ['dust', '· Xoá chấm bụi']])
      etools.append(h('button', { 'data-t': k, class: 'tall', onclick: () => app.setTool(app.tool === k ? null : k) }, t));
    const einfo = h('div', { class: 'hint' });
    this.W({ sync: () => {
      for (const b of etools.children) b.classList.toggle('sel', app.tool === b.dataset.t);
      const rt = app.s.retouch, n = (rt.areas || []).length + (rt.spots || []).length, sel = app.rtSel();
      einfo.textContent = (n ? `Đã xoá ${n} chỗ` : 'Chưa xoá gì') + (sel ? ` · đang chọn: ${sel.label}` : '');
    } });
    const ebrush = new Slider({ begin() {}, end() {}, toast: (m) => app.toast(m) }, { label: 'Cỡ cọ', lo: 0.2, hi: 15, def: 2, step: 0.1, dec: 1, get: () => app.rtSize, set: (v) => { app.rtSize = v; } });
    this.W(ebrush);
    this.page('s_erase',
      h('div', { class: 'stitle' }, 'Chọn công cụ rồi tô lên ảnh'), etools, ebrush, einfo,
      h('div', { class: 'grid3', style: 'margin-top:6px' }, btn('Thử cách khác', () => app.rtNextSource()), btn('Bỏ chỗ đang chọn', () => app.rtDeleteSel()), btn('Bỏ hết', () => app.rtClear('areas'))),
      hint('Tô kín vật cần xoá (dây điện, người qua đường, rác…) bằng 1 ngón tay, phủ cả viền / bóng mờ của vật; dùng 2 ngón để phóng / di chuyển ảnh. Xoá vật thể dùng AI như PUM máy tính: xoá hẳn vật rồi dựng lại nền phía sau (không chép mảng ảnh chỗ khác sang). Lần đầu cần tải mô hình AI khoảng 220 MB (menu ☰ › Mô hình AI xoá vật thể). Mỗi lần xoá vài giây tới vài chục giây tuỳ iPhone. Chưa ưng thì bấm "Thử cách khác" (4 cách lấp) hoặc ↶ để làm lại. Vật quá lớn (hơn nửa khung ảnh) thì nền dựng lại có thể nhoè. Chạm vào chỗ đã xoá để chọn nó.'),
      more());
    // ---- Chân dung
    const P = (k) => ['retouch', 'portrait', k];
    const faceInfo = h('div', { class: 'hint', style: 'color:#f0b050' });
    this.W({ sync: () => { const f = app.faces; faceInfo.textContent = !app.cur ? '' : f == null ? 'Đang tìm khuôn mặt…' : f.length ? `Nhận ra ${f.length} khuôn mặt` : 'Không thấy khuôn mặt nào trong ảnh'; } });
    this.page('s_face', faceInfo,
      big('✨ Làm đẹp tự động', () => app.autoFace()),
      multi('Mịn da', [P('even'), 0.7], [[P('blemish'), 0.9], [P('even'), 0.7], [P('shine'), 0.5], [P('dark_circles'), 0.6]]),
      multi('Mắt sáng', [P('iris_l'), 1], [[P('iris_l'), 1], [P('iris_r'), 1], [P('sclera_l'), 0.8], [P('sclera_r'), 0.8]]),
      multi('Răng trắng', [P('teeth_bright'), 1], [[P('teeth_bright'), 1], [P('teeth_desat'), 1]]),
      this.S('Môi hồng', P('lips'), 0, 100),
      this.S('Thon mặt', P('face_slim'), 0, 100),
      this.S('Mắt to', P('eyes_big'), 0, 100),
      h('div', { class: 'grid2' }, btn('↺ Đặt lại chân dung', () => app.resetPaths([P('blemish'), P('even'), P('shine'), P('dark_circles'), P('iris_l'), P('iris_r'), P('sclera_l'), P('sclera_r'), P('teeth_bright'), P('teeth_desat'), P('lips'), P('face_slim'), P('eyes_big')]))),
      more());
  }
  drawStyleGrid() {
    const app = this.app, g = this.styleGrid;
    if (!g) return;
    const items = [['Gốc', null], ...app.allStyles()];
    if (g.children.length !== items.length) {
      g.replaceChildren(...items.map(([name, st]) => {
        const c = h('canvas', { width: 96, height: 96 });
        return h('button', { 'data-n': name, onclick: () => (st ? app.applyStyle(name, st) : app.clearStyle()) }, c, h('span', {}, name));
      }));
    }
    for (const b of g.children) {
      b.classList.toggle('sel', (app.styleApplied || 'Gốc') === b.dataset.n);
      const th = app.thumbs && app.thumbs[b.dataset.n];
      if (th && b.firstChild._src !== th) {
        const c = b.firstChild, x = c.getContext('2d'), s = Math.min(th.width, th.height);
        x.drawImage(th, (th.width - s) / 2, (th.height - s) / 2, s, s, 0, 0, 96, 96);
        c._src = th;
      }
    }
  }
  sync() { for (const w of this.widgets) w.sync(); }

  // ------------------------------------------------------------ Color Editor nâng cao (panels.py _tab_color: cadv)
  cadvRanges() { return (this.app.s && this.app.s.color_adv) || []; }
  cadvCur() { const rs = this.cadvRanges(); return this.cadv >= 0 && this.cadv < rs.length ? rs[this.cadv] : null; }
  // chỉ số dải đang "xem vùng chọn" (null khi tắt) — panels.cadv_show_index
  cadvShowIndex() { return this.cadvShow && this.cur === 'color' && this.cadvCur() ? this.cadv : null; }
  buildCadv() {
    const app = this.app;
    this.cadv = -1;
    this.cadvShow = false;
    const ap = (k) => ['color_adv', () => (this.cadvCur() ? this.cadv : -1), k];
    const needR = () => (this.cadvCur() ? '' : 'Chưa có dải màu — bấm "Chấm màu trên ảnh" hoặc "+"');
    const list = h('div', { class: 'cadv-list' });
    // dải sắc độ 0..360°: vùng sáng = màu đang được chọn; kéo ngang để dời tâm dải (HueRangeBar)
    const bar = h('canvas', { class: 'cadv-bar', width: 360, height: 28 });
    const drawBar = () => {
      const g = bar.getContext('2d'), r = this.cadvCur();
      for (let x = 0; x < 360; x++) {
        const [cr, cg, cb] = oklchColor(x + 0.5);
        const w = r ? colorRangeWeight(x + 0.5, Math.max(r.sat_lo ?? 0, Math.min(r.sat_hi ?? 100, 50)), r) : 1;
        const k = r ? 0.28 + 0.72 * w : 1;
        g.fillStyle = `rgb(${Math.round(cr * k)},${Math.round(cg * k)},${Math.round(cb * k)})`;
        g.fillRect(x, 0, 1, 28);
      }
      if (r) { g.fillStyle = '#fff'; g.fillRect(Math.round(r.hue) - 1, 0, 2, 28); }
    };
    let barDrag = false;
    const barHue = (e) => {
      const r = this.cadvCur(); if (!r) return;
      const b = bar.getBoundingClientRect();
      const hue = Math.min(359.9, Math.max(0, (e.clientX - b.left) / b.width * 360));
      app.set(['color_adv', this.cadv, 'hue'], Math.round(hue * 10) / 10, true);
      drawBar(); hueSl.sync();
    };
    bar.addEventListener('pointerdown', (e) => { if (!this.cadvCur()) return; barDrag = true; bar.setPointerCapture(e.pointerId); app.begin('Dải màu: tâm sắc độ'); barHue(e); });
    bar.addEventListener('pointermove', (e) => { if (barDrag) barHue(e); });
    const barEnd = () => { if (barDrag) { barDrag = false; app.end(); } };
    bar.addEventListener('pointerup', barEnd); bar.addEventListener('pointercancel', barEnd);
    const showT = this.W(toggle('Xem vùng chọn', () => this.cadvShow, (v) => { this.cadvShow = v; app.requestRender(false); }));
    const rainbow = ['#ff4040', '#ffc040', '#80ff40', '#40ffc0', '#4080ff', '#c040ff', '#ff4080'];
    const hueSl = this.S('Tâm sắc độ', ap('hue'), 0, 360, { def: 30, gradient: rainbow, dep: needR });
    const sliders = [hueSl,
      this.S('Độ rộng dải', ap('width'), 1, 90, { def: 18, dep: needR }),
      this.S('Độ mềm (Smoothness)', ap('smooth'), 1, 90, { def: 22, dep: needR }),
      this.S('Bão hoà từ', ap('sat_lo'), 0, 100, { def: 15, dep: needR }),
      this.S('Bão hoà đến', ap('sat_hi'), 0, 100, { def: 100, dep: needR }),
      h('div', { class: 'hint', style: 'text-align:center;color:#ddd;margin-top:6px' }, 'Chỉnh màu của dải'),
      this.S('Sắc độ (Hue)', ap('h'), -100, 100, { dep: needR }),
      this.S('Bão hoà', ap('s'), -100, 100, { gradient: ['#808080', '#e2403a'], dep: needR }),
      this.S('Độ sáng', ap('l'), -100, 100, { gradient: ['#202020', '#f0f0f0'], dep: needR })];
    const text = (i, r) => {
      const parts = [['h', 'H'], ['s', 'S'], ['l', 'L']].filter(([k]) => Math.abs(r[k] || 0) > 0.5).map(([k, n]) => `${n} ${(r[k] > 0 ? '+' : '') + Math.round(r[k])}`);
      return `Dải ${i + 1} · ${Math.round(r.hue || 0)}°` + (parts.length ? ' · ' + parts.join(' ') : ' (chưa chỉnh)');
    };
    this.W({ sync: () => {
      const rs = this.cadvRanges();
      if (!(this.cadv >= 0 && this.cadv < rs.length)) this.cadv = rs.length - 1;
      list.replaceChildren(...rs.map((r, i) => {
        const [cr, cg, cb] = oklchColor(r.hue || 0);
        const chk = h('input', { type: 'checkbox', onclick: (e) => e.stopPropagation(),
          onchange: (e) => { app.begin('Bật/tắt dải màu'); app.set(['color_adv', i, 'on'], e.target.checked); app.end(); } });
        chk.checked = r.on ?? true;
        return h('div', { class: 'cadv-item' + (i === this.cadv ? ' on' : ''), onclick: () => { this.cadv = i; this.sync(); if (this.cadvShow) app.requestRender(false); } },
          chk, h('span', { class: 'sw', style: `background:rgb(${cr},${cg},${cb})` }), h('span', {}, text(i, r)));
      }));
      list.style.display = rs.length ? '' : 'none';
      drawBar();
    } });
    return this.sec('Color Editor nâng cao (Advanced)', { reset: () => { app.begin('Đặt lại Color Editor nâng cao'); app.set(['color_adv'], []); app.end(); } }).add(
      hint('Chấm một màu trên ảnh để tạo dải màu riêng (không giới hạn số dải), chỉnh độ rộng / độ mềm / khoảng bão hoà để chọn đúng màu cần sửa rồi đổi Sắc độ, Bão hoà, Độ sáng. Bật "Xem vùng chọn" để thấy màu nào đang bị chỉnh (phần còn lại thành xám).'),
      h('div', { class: 'row' },
        btn('Chấm màu trên ảnh', () => app.setTool(app.tool === 'cadvpick' ? null : 'cadvpick')),
        btn('+', () => app.addColorRange(30.0, 45.0)),
        btn('Xoá dải', () => app.removeColorRange())),
      list, showT, bar, ...sliders);
  }

  build() {
    const app = this.app;
    const auto = (k) => () => app.auto(k);
    const reset = (...paths) => () => app.resetPaths(paths, 'Đặt lại');
    // ------------------------------------------------------------ Cơ bản
    const wb = select('Cân bằng trắng', [['asshot', 'Như lúc chụp'], ['auto', 'Tự động'], ['custom', 'Tuỳ chỉnh']],
      () => (Math.abs(app.get(['temp'])) < 1e-6 && Math.abs(app.get(['tint'])) < 1e-6 ? 'asshot' : (app.wbMode === 'auto' ? 'auto' : 'custom')),
      (v) => {
        if (v === 'asshot') { app.begin('Cân bằng trắng: như lúc chụp'); app.set(['temp'], 0); app.set(['tint'], 0); app.end(); app.wbMode = null; }
        else if (v === 'auto') app.auto('wb');
        this.sync();
      });
    wb.el.append(btn('💧', () => app.setTool(app.tool === 'wb' ? null : 'wb'), 'pick-wb'));
    this.W(wb);
    this.page('basic',
      // nút Tự động của PUM 1.1.2: phơi sáng theo da mặt + vùng sáng "vai phim" như bảng Capture One (khử nhiễu khi ISO cao)
      h('div', { class: 'grid2' }, btn('✨ Tự động (như Capture One)', () => app.auto('c1')), btn('Cân màu + Tự động', () => app.autoAll())),
      this.sec('Màu (Color)', { auto: auto('color'), reset: reset(['temp'], ['tint'], ['vibrance'], ['saturation'], ['depth'], ['film_color']) }).add(wb,
        this.S('Nhiệt độ', ['temp'], -100, 100, { gradient: ['#3d6fd9', '#cccccc', '#e3b23c'] }),
        this.S('Sắc thái (Tint)', ['tint'], -100, 100, { gradient: ['#3dbb4a', '#cccccc', '#c94fc4'] }),
        this.S('Vibrance', ['vibrance'], -100, 100, { gradient: ['#777777', '#a98bb8', '#d7508e'] }),
        this.S('Bão hoà', ['saturation'], -100, 100, { gradient: ['#777777', '#cf9a52', '#e2403a'] }),
        this.S('Độ sâu màu', ['depth'], -100, 100, { gradient: ['#e8c9c9', '#c0605a', '#6e1410'] }),
        this.S('Đỏ đầm (phim)', ['film_color'], 0, 100, { gradient: ['#f08a80', '#c2302a', '#7a0f0c'] }),
        hint('Độ sâu màu: màu càng đậm càng sẫm và đầm lại kiểu phim (âm = sáng, nhạt phấn). Đỏ đầm: đỏ đậm mà sáng (áo dài, phông đỏ) sẫm lại như Capture One, giữ nếp vải; style "Gu Capture One" đặt 40.')),
      this.sec('Tông sáng', { auto: auto('tone'), reset: reset(['exposure'], ['contrast'], ['brightness'], ['highlights'], ['shadows'], ['whites'], ['blacks']) }).add(
        this.S('Phơi sáng', ['exposure'], -5, 5, { step: 0.01, dec: 2 }),
        this.S('Tương phản', ['contrast'], -100, 100),
        this.S('Brightness', ['brightness'], -100, 100),
        this.S('Vùng sáng', ['highlights'], -100, 100),
        this.S('Vùng tối', ['shadows'], -100, 100),
        this.S('Trắng', ['whites'], -100, 100),
        this.S('Đen', ['blacks'], -100, 100)),
      this.sec('Hiện diện', { auto: auto('presence'), reset: reset(['texture'], ['clarity'], ['dehaze']) }).add(
        this.S('Kết cấu (Texture)', ['texture'], -100, 100),
        this.S('Rõ nét (Clarity)', ['clarity'], -100, 100),
        this.S('Khử sương', ['dehaze'], -100, 100)));

    // ------------------------------------------------------------ Màu
    const bandBtns = h('div', { class: 'bands' });
    const bandLabel = h('div', { class: 'hint' });
    for (const [key, name, , rgb] of BANDS) {
      const light = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150;
      bandBtns.append(h('button', { 'data-b': key, style: `background:rgb(${rgb});color:${light ? '#151515' : '#fff'}`,
        onclick: () => { this.band = key; this.sync(); } }, name));
    }
    this.W({ sync: () => {
      for (const b of bandBtns.children) b.classList.toggle('on', b.dataset.b === this.band);
      const v = app.get(['color', this.band]);
      bandLabel.textContent = `Dải ${BANDS.find((b) => b[0] === this.band)[1]}: sắc độ ${v[0]}, bão hoà ${v[1]}, độ sáng ${v[2]}`;
    } });
    const bp = (i) => ['color', () => this.band, i];
    const calibSec = this.sec('Calibration (hiệu chỉnh màu gốc)', { auto: auto('calib'), reset: reset(['calib']), closed: true }).add(
      hint('Như Calibration của Lightroom: đổi sắc độ / độ bão hoà của 3 màu gốc, ảnh hưởng hài hoà lên toàn bộ màu. Màu xám vẫn trung tính.'),
      this.S('Tint vùng tối', ['calib', 'shadow_tint'], -100, 100, { gradient: ['#3dbb4a', '#999999', '#c94fc4'] }));
    for (const [name, title, hg, sg] of [
      ['red', 'Màu gốc Đỏ', ['#d23c8c', '#e03a3a', '#e0902e'], ['#8a8a8a', '#e03a3a']],
      ['green', 'Màu gốc Lục', ['#c8c032', '#3cb04a', '#2fb0a4'], ['#8a8a8a', '#3cb04a']],
      ['blue', 'Màu gốc Lam', ['#2fb0c8', '#3858e0', '#9a44d4'], ['#8a8a8a', '#3858e0']]]) {
      calibSec.add(h('div', { class: 'hint', style: 'text-align:center;color:#ddd;margin-top:8px' }, title),
        this.S('Sắc độ (Hue)', ['calib', name + '_hue'], -100, 100, { gradient: hg }),
        this.S('Bão hoà (Sat.)', ['calib', name + '_sat'], -100, 100, { gradient: sg }));
    }
    this.page('color',
      this.sec('Color Editor (HSL từng dải màu)', { auto: auto('hsl'), reset: reset(['color']) }).add(bandBtns,
        h('div', { class: 'row' }, btn('Chọn màu từ ảnh', () => app.setTool(app.tool === 'colorpick' ? null : 'colorpick'))), bandLabel,
        this.S('Sắc độ (Hue)', bp(0), -100, 100), this.S('Bão hoà', bp(1), -100, 100), this.S('Độ sáng', bp(2), -100, 100)),
      this.buildCadv(),
      this.sec('Tông da (Skin Tone)', { auto: auto('skin'), reset: reset(['skin']) }).add(
        hint('Kéo "Đồng nhất" để da hết loang lổ, ửng đỏ hoặc vàng không đều.'),
        this.S('Sắc độ da', ['skin', 'hue'], -100, 100), this.S('Bão hoà da', ['skin', 'sat'], -100, 100),
        this.S('Độ sáng da', ['skin', 'lum'], -100, 100), this.S('Đồng nhất sắc độ', ['skin', 'uni_hue'], 0, 100),
        this.S('Đồng nhất bão hoà', ['skin', 'uni_sat'], 0, 100), this.S('Đồng nhất độ sáng', ['skin', 'uni_lum'], 0, 100)),
      calibSec);

    // ------------------------------------------------------------ Grading
    const wheels = h('div', { class: 'wheels' });
    const gradOn = () => ['shadows', 'midtones', 'highlights', 'global'].some((z) => { const v = app.get(['grading', z]); return v[1] || v[2]; });
    for (const [zone, title] of [['shadows', 'Vùng tối'], ['midtones', 'Trung tính'], ['highlights', 'Vùng sáng'], ['global', 'Toàn ảnh']]) {
      const wh = new ColorWheel({ title, get: () => app.get(['grading', zone]),
        set: (hh, s, l, live) => app.set(['grading', zone], [hh, s, l], live),
        begin: () => app.begin('Grading ' + title), end: () => app.end() });
      wheels.append(wh.el);
      this.W(wh);
    }
    this.page('grading',
      this.sec('Color Grading / Color Balance', { auto: auto('grading'), reset: reset(['grading']) }).add(
        hint('Kéo chấm giữa để nhuộm màu · cung trái = độ bão hoà · cung phải = độ sáng. Chạm đúp để bỏ. Gõ số vào ô H / S / L.'),
        wheels,
        this.S('Hoà trộn', ['grading', 'blend'], 0, 100, { def: 50, dep: () => (gradOn() ? '' : 'Chưa có màu nào trên bánh xe — kéo bánh xe trước') }),
        this.S('Cân bằng', ['grading', 'balance'], -100, 100, { dep: () => (gradOn() ? '' : 'Chưa có màu nào trên bánh xe — kéo bánh xe trước') })));

    // ------------------------------------------------------------ Curve
    const curve = new CurveEditor({ get: (ch) => app.get(['curve', ch]), set: (ch, pts, live) => app.set(['curve', ch], pts, live),
      begin: () => app.begin('Đường cong'), end: () => app.end(), hist: () => app.hist });
    this.curve = curve;
    const chBtns = h('div', { class: 'grid4', style: 'grid-template-columns:repeat(5,1fr)' });
    for (const [ch, t] of [['rgb', 'RGB'], ['luma', 'Luma'], ['r', 'Đỏ'], ['g', 'Lục'], ['b', 'Lam']])
      chBtns.append(h('button', { 'data-c': ch, onclick: () => { curve.setChannel(ch); this.sync(); } }, t));
    const gridSel = select('Lưới', [['4', '4×4'], ['8', '8×8'], ['16', '16×16']], () => curve.div, (v) => { curve.div = +v; curve.draw(); });
    this.W({ sync: () => { for (const b of chBtns.children) b.classList.toggle('sel', b.dataset.c === curve.ch); gridSel.sync(); curve.draw(); } });
    this.page('curve',
      this.sec('Đường cong (Curve)', { auto: auto('curve'), reset: reset(['curve']) }).add(chBtns, gridSel.el, curve.el,
        hint('Chạm để thêm điểm, kéo để chỉnh, chạm đúp vào điểm (hoặc kéo ra ngoài khung) để xoá, chạm đúp chỗ trống để đặt lại kênh. Luma (như Capture One): chỉ đổi sáng tối, giữ sắc độ và độ đậm màu — nâng trung tông mà da, vải không bạc màu.')));

    // ------------------------------------------------------------ Chi tiết
    const noNrl = () => (app.get(['nr_lum']) ? '' : 'Tăng "Độ sáng" khử nhiễu trước thì thanh này mới có tác dụng');
    const noNrc = () => (app.get(['nr_color']) ? '' : 'Tăng "Màu" khử nhiễu trước thì thanh này mới có tác dụng');
    this.page('detail',
      this.sec('Làm nét', { auto: auto('sharpen'), reset: reset(['sharpen'], ['sharpen_radius']) }).add(
        this.S('Mức độ', ['sharpen'], 0, 150),
        this.S('Bán kính', ['sharpen_radius'], 0.5, 3, { step: 0.1, dec: 1, def: 1, dep: () => (app.get(['sharpen']) ? '' : 'Tăng "Mức độ" làm nét trước') })),
      this.sec('Khử nhiễu (Noise Reduction)', { auto: auto('nr'), reset: reset(['nr_lum'], ['nr_lum_detail'], ['nr_lum_contrast'], ['nr_color'], ['nr_color_detail'], ['nr_color_smooth']) }).add(
        this.S('Độ sáng', ['nr_lum'], 0, 100),
        this.S('   Chi tiết', ['nr_lum_detail'], 0, 100, { def: 50, dep: noNrl }),
        this.S('   Tương phản', ['nr_lum_contrast'], 0, 100, { dep: noNrl }),
        this.S('Màu', ['nr_color'], 0, 100),
        this.S('   Chi tiết', ['nr_color_detail'], 0, 100, { def: 50, dep: noNrc }),
        this.S('   Độ mượt', ['nr_color_smooth'], 0, 100, { def: 50, dep: noNrc }),
        hint('Khử nhiễu độ sáng trên iPhone dùng bộ lọc giữ cạnh gần tương đương (bản máy tính dùng Non-Local Means).')),
      this.sec('Hiệu ứng', { auto: auto('effects'), reset: reset(['vignette'], ['grain'], ['grain_size']) }).add(
        this.S('Tối góc', ['vignette'], -100, 100),
        this.S('Hạt phim (Grain)', ['grain'], 0, 100),
        this.S('Cỡ hạt', ['grain_size'], 0, 100, { def: 25, dep: () => (app.get(['grain']) ? '' : 'Tăng "Hạt phim" trước') })));

    // ------------------------------------------------------------ Khung (Lens & Crop)
    const cropSel = select('Tỉ lệ', CROPS.map((k) => [k, CROP_LABELS[k] || k]), () => app.get(['crop']), (v) => app.setCrop(v));
    const cropBtn = btn('Công cụ cắt', () => app.setTool(app.tool === 'crop' ? null : 'crop'));
    const lockBtn = btn('🔓 Khoá tỉ lệ', () => { app.cropLock = !app.cropLock; this.sync(); });
    const ovSel = select('Lưới', [['thirds', 'Lưới 1/3'], ['grid', 'Lưới ô'], ['golden', 'Tỉ lệ vàng'], ['diagonal', 'Đường chéo'], ['triangle', 'Tam giác']],
      () => app.cropOverlay, (v) => { app.cropOverlay = v; app.drawOverlay(); });
    const sizeLb = h('div', { class: 'hint' });
    this.W({ sync: () => {
      cropSel.sync(); ovSel.sync();
      cropBtn.classList.toggle('sel', app.tool === 'crop'); cropBtn.textContent = app.tool === 'crop' ? 'Xong cắt ✓' : 'Công cụ cắt';
      lockBtn.textContent = app.cropLock ? '🔒 Khoá tỉ lệ' : '🔓 Khoá tỉ lệ'; lockBtn.classList.toggle('sel', app.cropLock);
      const sz = app.outputSize(); sizeLb.textContent = sz ? `Kích thước ảnh ra: ${sz[0]} × ${sz[1]} px` : '';
    } });
    const outside = this.W(toggle('Cho phép cắt ra ngoài ảnh (phần ngoài để đen)', () => app.get(['crop_outside']), (v) => { app.begin('Cắt ra ngoài'); app.set(['crop_outside'], v); app.end(); }));
    const flipSel = this.W(select('Lật', [['none', 'Không'], ['h', 'Lật ngang (gương)'], ['v', 'Lật dọc'], ['hv', 'Cả hai']],
      () => app.get(['flip']), (v) => { app.begin('Lật'); app.set(['flip'], v); app.end(); }));
    const levelBtn = btn('Kẻ chân trời', () => app.setTool(app.tool === 'level' ? null : 'level'));
    const kgBtn = btn('Kẻ đường', () => app.setTool(app.tool === 'kguide' ? null : 'kguide'));
    const kgInfo = h('div', { class: 'hint' });
    this.W({ sync: () => {
      levelBtn.classList.toggle('sel', app.tool === 'level'); kgBtn.classList.toggle('sel', app.tool === 'kguide');
      const g = app.get(['lens', 'kguides']) || [];
      kgInfo.textContent = g.length ? `${g.filter((x) => x.o === 'v').length} đường dọc, ${g.filter((x) => x.o === 'h').length} đường ngang` + (app.get(['lens', 'kmat']) ? ' — đã áp dụng' : '') : 'Chưa có đường dẫn';
    } });
    this.page('lens',
      this.sec('Cắt khung (Crop)', { reset: () => app.clearCrop() }).add(cropSel.el,
        h('div', { class: 'grid3' }, btn('⇄ Đổi chiều', () => app.swapCrop()), lockBtn, btn('Bỏ cắt', () => app.clearCrop())),
        h('div', { class: 'row' }, cropBtn), ovSel.el, outside.el, sizeLb,
        hint('Khi bật công cụ cắt: kéo góc / cạnh để chỉnh, kéo bên trong để di chuyển khung.')),
      this.sec('Xoay & lật', { auto: auto('straighten'), reset: reset(['straighten'], ['rotate'], ['flip']) }).add(
        this.S('Góc xoay', ['straighten'], -45, 45, { step: 0.1, dec: 1 }),
        h('div', { class: 'grid3' }, btn('↺ Xoay trái', () => app.rotate(-90)), btn('↻ Xoay phải', () => app.rotate(90)), levelBtn),
        flipSel.el),
      this.sec('Phối cảnh (Keystone)', { auto: auto('keystone'), reset: reset(['lens', 'persp_v'], ['lens', 'persp_h'], ['lens', 'skew'], ['lens', 'aspect'], ['lens', 'scale'], ['lens', 'kmat'], ['lens', 'kguides'], ['lens', 'kamount']) }).add(
        this.S('Dọc (Vertical)', ['lens', 'persp_v'], -100, 100),
        this.S('Ngang (Horiz.)', ['lens', 'persp_h'], -100, 100),
        this.S('Xô lệch (Skew)', ['lens', 'skew'], -100, 100),
        this.S('Tỉ lệ (Aspect)', ['lens', 'aspect'], -100, 100),
        this.S('Phóng to', ['lens', 'scale'], 50, 150, { def: 100 }),
        h('div', { class: 'hint', style: 'color:#ddd;margin-top:6px' }, 'Đường dẫn (Guides)'),
        h('div', { class: 'grid3' }, kgBtn, btn('Áp dụng', () => app.applyGuides()), btn('Xoá', () => app.clearGuides())),
        kgInfo,
        this.S('Mức áp dụng', ['lens', 'kamount'], 0, 100, { def: 100, dep: () => (app.get(['lens', 'kmat']) ? '' : 'Chưa áp dụng đường dẫn — kẻ đường rồi bấm Áp dụng') }),
        hint('Đường vàng = lẽ ra thẳng đứng, đường xanh = lẽ ra nằm ngang (tự nhận theo hướng kẻ). Cần ít nhất 2 đường. Tăng "Phóng to" để che mép.')),
      this.sec('Hiệu chỉnh ống kính', { auto: auto('lens'), reset: reset(['lens', 'distortion'], ['lens', 'ca_red'], ['lens', 'ca_blue'], ['lens', 'vig_corr']) }).add(
        this.S('Méo hình', ['lens', 'distortion'], -100, 100),
        this.S('Viền đỏ / xanh', ['lens', 'ca_red'], -100, 100),
        this.S('Viền lam / vàng', ['lens', 'ca_blue'], -100, 100),
        this.S('Bù tối góc ống kính', ['lens', 'vig_corr'], -100, 100)));

    // ------------------------------------------------------------ Layer
    this.buildLayer();
    // ------------------------------------------------------------ Retouch
    this.buildRetouch();
    // ------------------------------------------------------------ Chân dung
    this.buildPortrait();
    // ------------------------------------------------------------ Style
    this.buildStyle();
    // ------------------------------------------------------------ Biểu đồ
    const sc = new Scopes();
    this.scopes = sc;
    const modes = h('div', { class: 'grid4' });
    for (const [k, t] of [['hist', 'Histogram'], ['parade', 'Parade'], ['wave', 'Waveform'], ['vector', 'Vectorscope']])
      modes.append(h('button', { 'data-m': k, onclick: () => { sc.mode = k; this.sync(); } }, t));
    this.W({ sync: () => { for (const b of modes.children) b.classList.toggle('sel', b.dataset.m === sc.mode); if (this.cur === 'scopes') sc.draw(app.viewer.img); } });
    this.page('scopes', this.sec('Biểu đồ (Scopes)').add(modes, sc.el,
      hint('Histogram: phân bố sáng tối · Parade: 3 kênh R G B cạnh nhau · Waveform: độ sáng theo chiều ngang ảnh · Vectorscope: sắc độ / độ bão hoà, đường cam là tông da.')));
  }

  buildPortrait() {
    const app = this.app;
    const P = (k) => ['retouch', 'portrait', k];
    const ps = (label, key, lo = 0, hi = 100, grad = null) => this.S(label, P(key), lo, hi, { def: key === 'impact' ? 100 : 0, gradient: grad });
    const chk = (label, key) => this.W(toggle(label, () => app.get(P(key)) !== false, (v) => { app.begin(label); app.set(P(key), v); app.end(); }));
    const fold = (title, autoKey, keys, closed = true) => this.sec(title, {
      closed, auto: autoKey ? () => app.auto('portrait:' + autoKey) : null,
      reset: () => app.resetPaths(keys.map(P), 'Đặt lại ' + title) });
    const info = h('div', { class: 'hint', style: 'color:#f0b050' }, 'Đang tìm khuôn mặt…');
    const who = select('Áp cho', [['all', 'Tất cả mọi người']], () => app.get(P('who')), (v) => { app.begin('Chọn người'); app.set(P('who'), v); app.end(); });
    this.W({ sync: () => {
      const f = app.faces;
      info.textContent = !app.cur ? '' : f == null ? 'Đang tìm khuôn mặt… (lần đầu cần vài giây)' : f.length ? `Nhận ra ${f.length} khuôn mặt (khung cam đánh số trên ảnh)` : 'Không nhận ra khuôn mặt nào trong ảnh';
      const n = f ? f.length : 0;
      if (who.sel.options.length !== n + 1) {
        who.sel.replaceChildren(h('option', { value: 'all' }, 'Tất cả mọi người'), ...Array.from({ length: n }, (_, i) => h('option', { value: String(i) }, `Người số ${i + 1}`)));
      }
      who.sync();
    } });
    const tones = h('div', { class: 'grid4' });
    for (const [k, nm, col] of [['none', 'Không', null], ['cool_white', 'Trắng lạnh', '#eedcdc'], ['milk_white', 'Trắng sữa', '#f5e0cc'], ['pink_white', 'Trắng hồng', '#f5d6d1'],
      ['warm_white', 'Trắng ấm', '#f5d9bd'], ['tan', 'Màu', '#cc9e80'], ['brown', 'Màu da', '#8c664f']]) {
      const fg = col && !['tan', 'brown'].includes(k) ? '#1a1a1a' : '#fff';
      tones.append(h('button', { 'data-t': k, style: `background:${col || '#4a4a50'};color:${fg};font-size:12px;padding:14px 2px 6px`,
        onclick: () => { app.begin('Tông màu da'); app.set(P('tone_preset'), k); app.end(); } }, nm));
    }
    this.W({ sync: () => { for (const b of tones.children) b.style.outline = app.get(P('tone_preset')) === b.dataset.t ? '2px solid #fff' : 'none'; } });
    const target = select('Vùng da', [['all', 'Toàn bộ da'], ['face', 'Da mặt'], ['body', 'Da thân']], () => app.get(P('tone_target')), (v) => { app.begin('Vùng da'); app.set(P('tone_target'), v); app.end(); });
    this.W(target);
    // mắt: chỉnh cả hai / trái / phải
    this.eyeSide = 'both';
    const sides = h('div', { class: 'grid3' });
    for (const [k, t] of [['both', 'Cả hai'], ['l', 'Mắt trái'], ['r', 'Mắt phải']]) sides.append(h('button', { 'data-s': k, onclick: () => { this.eyeSide = k; this.sync(); } }, t));
    this.W({ sync: () => { for (const b of sides.children) b.classList.toggle('sel', b.dataset.s === this.eyeSide); } });
    const eye = (label, part) => this.S(label, ['_eye_' + part], 0, 100, {
      get: () => +app.get(P(part + '_' + (this.eyeSide === 'both' ? 'l' : this.eyeSide))) || 0,
      set: (v, live) => { for (const s of this.eyeSide === 'both' ? ['l', 'r'] : [this.eyeSide]) app.set(P(part + '_' + s), v, live); } });
    const pb = new Slider({ begin() {}, end() {}, toast: (m) => app.toast(m) }, { label: 'Cỡ cọ bảo vệ', lo: 0.2, hi: 15, def: 3, step: 0.1, dec: 1, get: () => app.protSize, set: (v) => { app.protSize = v; } });
    this.W(pb);
    const ptools = h('div', { class: 'grid3' });
    for (const [k, t] of [['pprotect', 'Cọ bảo vệ vùng'], ['perase', 'Bỏ bảo vệ']]) ptools.append(h('button', { 'data-t': k, onclick: () => app.setTool(app.tool === k ? null : k) }, t));
    ptools.append(btn('Xoá hết', () => { app.begin('Xoá vùng bảo vệ'); app.set(P('protect'), []); app.end(); }));
    this.W({ sync: () => { for (const b of ptools.children) if (b.dataset.t) b.classList.toggle('sel', app.tool === b.dataset.t); } });
    this.page('portrait',
      this.sec('Chân dung tự động').add(info, who.el, ps('Mức tác động', 'impact'),
        hint('App tự nhận diện khuôn mặt bằng AI ngay trên máy. Mọi chỉnh sửa giữ lại kết cấu da thật; vết nhỏ được lấp bằng chính vùng da quanh nó.')),
      fold('Xoá khuyết điểm', 'Xoá khuyết điểm', ['blemish', 'dark_circles'], false).add(ps('Mụn & vết thâm', 'blemish'), chk('Gồm vùng cổ', 'blemish_neck'),
        ps('Quầng thâm mắt', 'dark_circles'), ptools, pb, hint('Cọ bảo vệ: tô lên vùng KHÔNG muốn bị chỉnh (nốt ruồi duyên, hình xăm, trang sức...).')),
      fold('Xoá nếp nhăn', 'Xoá nếp nhăn', ['wrinkles']).add(ps('Nếp nhăn', 'wrinkles')),
      fold('Điều chỉnh da', 'Điều chỉnh da', ['even', 'even_texture', 'shine', 'body_even', 'body_texture', 'tone_preset', 'tone_pref', 'tone_uniform', 'tone_temp', 'tone_tint', 'tone_sat', 'tone_light']).add(
        ps('Đều màu da', 'even'), ps('Kết cấu', 'even_texture', -100, 100), chk('Gồm vùng cổ', 'even_neck'), ps('Giảm bóng nhờn', 'shine'),
        ps('Da toàn thân', 'body_even'), ps('Kết cấu da thân', 'body_texture', -100, 100),
        h('div', { class: 'hint', style: 'color:#ddd;margin-top:6px' }, 'Chọn tông màu da'), tones,
        ps('Sở thích tông da', 'tone_pref', -100, 100, ['#7fc6ff', '#d8d8d8', '#ff9a5c']), target.el,
        ps('Đồng nhất màu da', 'tone_uniform'), ps('Nhiệt độ', 'tone_temp', -100, 100, ['#3d6fd9', '#cccccc', '#e3b23c']),
        ps('Tint', 'tone_tint', -100, 100, ['#3dbb4a', '#cccccc', '#c94fc4']), ps('Bão hoà', 'tone_sat', -100, 100, ['#8a8a8a', '#d9a080']),
        ps('Độ sáng', 'tone_light', -100, 100, ['#333333', '#eeeeee'])),
      fold('Tạo hình cơ thể', 'Tạo hình cơ thể', ['body_slim']).add(ps('Thon người', 'body_slim')),
      fold('Tạo hình lại khuôn mặt', 'Tạo hình lại khuôn mặt', ['face_slim', 'vline', 'eyes_big', 'nose_slim']).add(
        ps('Thon mặt', 'face_slim'), ps('Gọt cằm (V-line)', 'vline'), ps('Mắt to', 'eyes_big'), ps('Thon mũi', 'nose_slim')),
      fold('Làm đẹp răng', 'Làm đẹp răng', ['teeth_bright', 'teeth_desat']).add(ps('Độ sáng răng', 'teeth_bright'), ps('Khử ố vàng', 'teeth_desat')),
      fold('Tăng cường mắt', 'Tăng cường mắt', ['iris_l', 'iris_r', 'sclera_l', 'sclera_r']).add(sides, eye('Tròng mắt (Iris)', 'iris'), eye('Lòng trắng', 'sclera')),
      fold('Điều chỉnh tóc', 'Điều chỉnh tóc', ['hair_outer', 'hair_inner', 'hair_dark']).add(
        ps('Tóc con bay ra ngoài', 'hair_outer'), ps('Sợi tóc trên da', 'hair_inner'), ps('Làm đen tóc', 'hair_dark')),
      fold('Điều chỉnh trang điểm', 'Điều chỉnh trang điểm', ['lips', 'blush', 'brows', 'contour']).add(
        ps('Môi hồng', 'lips'), ps('Má hồng', 'blush'), ps('Kẻ mày', 'brows'), ps('Tạo khối', 'contour')),
      fold('Quần áo', 'Quần áo', ['cloth_wrinkle', 'cloth_spots', 'cloth_edges']).add(
        ps('Xoá nếp nhăn áo', 'cloth_wrinkle'), ps('Xoá khuyết điểm áo', 'cloth_spots'), ps('Làm phẳng viền áo', 'cloth_edges')));
  }

  buildRetouch() {
    const app = this.app;
    const tools = h('div', { class: 'grid2' });
    for (const [k, t] of [['heal', 'Heal (tô vết)'], ['clone', 'Clone (giữ để đặt nguồn)'], ['remove', 'Xoá vật thể'], ['dust', 'Xoá bụi (chạm)'],
      ['skin', 'Cọ làm mịn da'], ['erase', 'Tẩy vùng mịn']])
      tools.append(h('button', { 'data-t': k, onclick: () => app.setTool(app.tool === k ? null : k) }, t));
    const info = h('div', { class: 'hint' });
    this.W({ sync: () => {
      for (const b of tools.children) b.classList.toggle('sel', app.tool === b.dataset.t);
      const rt = app.s.retouch, parts = [];
      const na = (rt.areas || []).length, nd = (rt.spots || []).filter((x) => x.type === 'dust').length, ns = (rt.spots || []).length - nd;
      if (na) parts.push(`${na} vùng tô`); if (ns) parts.push(`${ns} điểm heal/clone`); if (nd) parts.push(`${nd} vết bụi`);
      if ((rt.skin_strokes || []).length) parts.push(`${rt.skin_strokes.length} nét làm mịn`);
      const sel = app.rtSel();
      info.textContent = (parts.length ? 'Đã có: ' + parts.join(', ') : 'Chưa có chỉnh sửa retouch') + (sel ? ` · Đang chọn: ${sel.label}` : '');
    } });
    const mk = (label, lo, hi, def, key, step = 1, dec = 0) => {
      const s = new Slider({ begin() {}, end() {}, toast: (m) => app.toast(m) }, { label, lo, hi, def, step, dec, get: () => app[key], set: (v) => { app[key] = v; if (key === 'rtOpacity') app.setSelOpacity(v); } });
      this.W(s); return s;
    };
    const noSkin = () => (app.get(['retouch', 'skin_amount']) ? '' : 'Tăng "Độ mịn" trước');
    const auto = this.W(toggle('Tự nhận vùng da trên cả ảnh', () => app.get(['retouch', 'skin_auto']), (v) => { app.begin('Tự nhận vùng da'); app.set(['retouch', 'skin_auto'], v); if (v && !app.get(['retouch', 'skin_amount'])) app.set(['retouch', 'skin_amount'], 35); app.end(); }));
    this.page('retouch',
      this.sec('Công cụ retouch (kiểu Capture One)').add(tools,
        mk('Cỡ cọ', 0.2, 15, 2, 'rtSize', 0.1, 1), mk('Độ cứng mép', 0, 100, 60, 'rtHard'), mk('Độ mờ đục', 0, 100, 100, 'rtOpacity'),
        hint('Heal: tô lên mụn / vết bẩn — app tự chọn vùng nguồn đẹp nhất và hoà liền mạch; nét đứt là vùng nguồn, kéo nét đứt để đổi nguồn. Xoá vật thể: AI xoá hẳn vật và dựng lại nền phía sau (như PUM máy tính, cần tải mô hình ~220 MB một lần); chưa ưng thì "Đổi nguồn / thử lại" = thử cách lấp khác. Chạm vào vùng đã tô để chọn. Clone: chạm giữ để đặt điểm nguồn rồi tô.')),
      this.sec('Làm mịn da (giữ lỗ chân lông)', { auto: () => app.auto('skin_smooth'), reset: () => app.resetPaths([['retouch', 'skin_amount'], ['retouch', 'skin_texture'], ['retouch', 'skin_auto']]) }).add(
        this.S('Độ mịn', ['retouch', 'skin_amount'], 0, 100),
        this.S('Giữ kết cấu da', ['retouch', 'skin_texture'], 0, 100, { def: 50, dep: noSkin }), auto),
      this.sec('Quản lý').add(info,
        h('div', { class: 'grid2' }, btn('Đổi nguồn / thử lại', () => app.rtNextSource()), btn('Xoá vùng chọn', () => app.rtDeleteSel()),
          btn('Xoá mọi vùng heal / clone', () => app.rtClear('areas')), btn('Xoá vùng làm mịn', () => app.rtClear('skin')))));
  }

  buildLayer() {
    const app = this.app;
    const list = h('div', { class: 'list' });
    const L = (k) => ['layers', () => app.layerIdx, ...[].concat(k)];
    const hasL = () => app.curLayer() != null;
    const needL = () => (hasL() ? '' : 'Thêm hoặc chọn một layer trước');
    this.W({ sync: () => {
      list.replaceChildren();
      (app.s.layers || []).forEach((ly, i) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = ly.enabled !== false;
        cb.addEventListener('change', () => { app.begin('Bật / tắt layer'); app.set(['layers', i, 'enabled'], cb.checked); app.end(); });
        list.append(h('div', { class: 'it' + (i === app.layerIdx ? ' cur' : ''), onclick: (e) => { if (e.target !== cb) { app.layerIdx = i; this.sync(); app.drawOverlay(); } } },
          cb, h('span', { class: 'n' }, ly.name || 'Layer')));
      });
      if (!(app.s.layers || []).length) list.append(h('div', { class: 'hint' }, 'Chưa có layer. Bấm "+ Thêm".'));
    } });
    const tools = h('div', { class: 'grid2' });
    for (const [k, t] of [['lbrush', 'Cọ'], ['lerase', 'Tẩy mask'], ['linear', 'Gradient thẳng'], ['radial', 'Gradient tròn']])
      tools.append(h('button', { 'data-t': k, onclick: () => { if (!hasL()) app.addLayer(); app.setTool(app.tool === k ? null : k); } }, t));
    this.W({ sync: () => { for (const b of tools.children) b.classList.toggle('sel', app.tool === b.dataset.t); } });
    const brush = new Slider(app, { label: 'Cỡ cọ', lo: 0.2, hi: 20, step: 0.1, dec: 1, def: 3, get: () => app.brushSize, set: (v) => { app.brushSize = v; } });
    brush.app = { begin() {}, end() {} };
    this.W(brush);
    const flag = (label, key) => this.W(toggle(label, () => (app.curLayer() || {})[key], (v) => { if (!hasL()) app.addLayer(); app.begin(label); app.set(L(key), v); app.end(); }));
    const showMask = this.W(toggle('Hiện mask', () => app.showMask, (v) => { app.showMask = v; app.requestRender(false); }));
    const adjSec = this.sec('Điều chỉnh của layer', { auto: () => app.auto('layer'), reset: () => hasL() && app.resetPaths(LAYER_ADJ.map((k) => L(['adj', k])), 'Đặt lại layer') });
    for (const [key, label, lo, hi, st, dec] of [
      ['exposure', 'Phơi sáng', -4, 4, 0.01, 2], ['contrast', 'Tương phản', -100, 100, 1, 0], ['brightness', 'Độ sáng', -100, 100, 1, 0],
      ['highlights', 'Vùng sáng', -100, 100, 1, 0], ['shadows', 'Vùng tối', -100, 100, 1, 0], ['whites', 'Trắng', -100, 100, 1, 0],
      ['blacks', 'Đen', -100, 100, 1, 0], ['temp', 'Nhiệt độ', -100, 100, 1, 0], ['tint', 'Sắc thái', -100, 100, 1, 0],
      ['saturation', 'Bão hoà', -100, 100, 1, 0], ['clarity', 'Rõ nét', -100, 100, 1, 0], ['texture', 'Kết cấu', -100, 100, 1, 0],
      ['dehaze', 'Khử sương', -100, 100, 1, 0]]) {
      const grad = key === 'temp' ? ['#3d6fd9', '#cccccc', '#e3b23c'] : key === 'tint' ? ['#3dbb4a', '#cccccc', '#c94fc4'] : null;
      adjSec.add(this.S(label, L(['adj', key]), lo, hi, { step: st, dec, gradient: grad, dep: needL }));
    }
    const person = this.W(toggle('Chọn người tự động (AI)', () => (app.curLayer() || {}).person, async (v) => {
      if (!hasL()) app.addLayer();
      if (v && !(await app.ensurePerson())) { this.sync(); return; }
      app.begin('Chọn người'); app.set(L('person'), v); app.end();
    }));
    this.page('layer',
      this.sec('Layer (chỉnh cục bộ)').add(list,
        h('div', { class: 'grid4' }, btn('+ Thêm', () => app.addLayer()), btn('Nhân bản', () => app.dupLayer()),
          btn('Đổi tên', () => app.renameLayer()), btn('Xoá', () => app.delLayer()))),
      this.sec('Vẽ mask').add(tools, brush, person, flag('Phủ kín toàn ảnh (Fill mask)', 'fill'), flag('Đảo ngược mask', 'invert'), showMask,
        this.S('Độ mềm gradient tròn', ['_radial_feather'], 1, 100, { def: 50, get: () => app.radialFeather, set: (v, live) => app.setRadialFeather(v, live), dep: needL }),
        h('div', { class: 'grid2' }, btn('Xoá gradient', () => app.clearLayerShapes('grad')), btn('Xoá nét cọ', () => app.clearLayerShapes('brush'))),
        hint('Cọ: tô bằng ngón tay. Gradient thẳng: kéo từ nơi tác động mạnh nhất tới nơi hết tác động. Gradient tròn: kéo từ tâm ra. Dùng 2 ngón để phóng / di chuyển ảnh.')),
      this.sec('Tinh chỉnh mask', { closed: true }).add(
        flag('Lọc theo độ sáng (Luma Range)', 'luma_on'),
        this.S('Tối nhất', L(['luma', 0]), 0, 100, { dep: needL }), this.S('Sáng nhất', L(['luma', 1]), 0, 100, { def: 100, dep: needL }),
        this.S('Độ chuyển', L(['luma', 2]), 0, 50, { def: 15, dep: needL }),
        flag('Lọc theo màu (Color Range)', 'crange_on'),
        h('div', { class: 'row' }, btn('Chọn màu từ ảnh', () => app.setTool('crange'))),
        this.S('Màu (hue)', L(['crange', 0]), 0, 360, { def: 25, gradient: ['#f00', '#ff0', '#0f0', '#0ff', '#00f', '#f0f', '#f00'], dep: needL }),
        this.S('Độ rộng', L(['crange', 1]), 2, 90, { def: 30, dep: needL }), this.S('Độ chuyển', L(['crange', 2]), 1, 60, { def: 20, dep: needL }),
        this.S('Độ đậm layer', L(['opacity']), 0, 100, { def: 100, dep: needL })),
      adjSec);
  }

  buildStyle() {
    const app = this.app;
    const chips = h('div', { class: 'chips' });
    const strength = new Slider(app, { label: 'Độ mạnh', lo: 0, hi: 150, def: 100, get: () => app.styleStrength,
      set: (v, live) => app.setStyleStrength(v, live), dep: () => (app.styleApplied ? '' : 'Chọn một style trước') });
    this.W(strength);
    this.W({ sync: () => {
      chips.replaceChildren();
      for (const [name, st] of app.allStyles())
        chips.append(h('button', { class: app.styleApplied === name ? 'sel' : '', onclick: () => app.applyStyle(name, st) }, name));
    } });
    const hist = h('div', { class: 'list' });
    this.W({ sync: () => {
      hist.replaceChildren();
      const H = app.historyList();
      H.slice(-40).forEach(({ label, i, cur }) => hist.append(h('div', { class: 'it' + (cur ? ' cur' : ''), onclick: () => app.gotoHistory(i) }, h('span', { class: 'n' }, label))));
    } });
    this.page('style',
      this.sec('Style', {}).add(chips, strength,
        h('div', { class: 'grid2' }, btn('Lưu style hiện tại', () => app.saveStyle()), btn('Xoá style riêng', () => app.deleteStyle()),
          btn('Nhập style .json', () => app.importStyle()), btn('Xuất style .json', () => app.exportStyle())),
        hint('Style dùng chung định dạng .json với PUM máy tính (thư mục %APPDATA%\\PUM\\styles).')),
      this.sec('Sao chép chỉnh sửa').add(h('div', { class: 'grid2' },
        btn('Sao chép chỉnh sửa', () => app.copySettings()), btn('Dán chỉnh sửa', () => app.pasteSettings()),
        btn('Dán cho mọi ảnh', () => app.pasteAll()), btn('Đặt lại toàn bộ', () => app.resetAll()))),
      this.sec('Lịch sử chỉnh sửa', { closed: true }).add(hist));
  }
}
