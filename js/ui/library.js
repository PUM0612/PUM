// Thư viện (library.py + dialogs.CullDialog bản máy tính): lưới ảnh, sao 0–5, cờ chọn / loại, nhãn màu, lọc, sắp xếp,
// chọn nhiều, bản sao ảo, so sánh 2–4 ảnh, tự lọc (mờ / nhắm mắt / trùng), áp style / dán chỉnh sửa / xuất hàng loạt.
import { h, btn, hint, Slider, select } from './controls.js';
import { store } from '../store.js';
import * as S from '../engine/settings.js';
import * as cv from '../engine/cv.js';
import { decodeFile } from '../decode.js';
import { runExport, loadOpts, openExportOptions } from './export_ui.js';
import { shareOrDownload } from '../app.js';

const LABELS = [['red', '#e2403a', 'Đỏ'], ['yellow', '#e8c53d', 'Vàng'], ['green', '#3cb04a', 'Lục'], ['blue', '#3d8bfd', 'Lam'], ['purple', '#9a44d4', 'Tím']];

export function openLibrary(app) {
  const st = app.lib || (app.lib = { filter: 'all', sort: 'added', sel: new Set(), multi: false });
  const grid = h('div', { class: 'libgrid' });
  const bar = h('div', { class: 'libbar' });
  const count = h('div', { class: 'hint' });
  const filters = [['all', 'Tất cả'], ['pick', '✓ Chọn'], ['reject', '✕ Loại'], ['none', 'Chưa đánh dấu'], ['r1', '★ ≥1'], ['r3', '★ ≥3'], ['r5', '★★★★★'],
    ['edited', 'Đã chỉnh'], ...LABELS.map(([k, , n]) => ['l_' + k, '● ' + n])];
  const fSel = select('Lọc', filters, () => st.filter, (v) => { st.filter = v; draw(); });
  const sSel = select('Sắp xếp', [['added', 'Ngày nhập'], ['name', 'Tên tệp'], ['rating', 'Số sao']], () => st.sort, (v) => { st.sort = v; draw(); });
  fSel.sync(); sSel.sync();
  const multiBtn = btn('Chọn nhiều', () => { st.multi = !st.multi; if (!st.multi) st.sel.clear(); draw(); });
  const visible = () => {
    let L = app.photos.slice();
    const f = st.filter;
    L = L.filter((p) => f === 'all' || (f === 'pick' && p.flag === 1) || (f === 'reject' && p.flag === -1) || (f === 'none' && !p.flag) ||
      (f === 'r1' && p.rating >= 1) || (f === 'r3' && p.rating >= 3) || (f === 'r5' && p.rating >= 5) ||
      (f === 'edited' && p.settings && !S.isDefault(p.settings)) || (f.startsWith('l_') && p.label === f.slice(2)));
    if (st.sort === 'name') L.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
    else if (st.sort === 'rating') L.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.added - b.added);
    else L.sort((a, b) => a.added - b.added);
    return L;
  };
  const targets = () => (st.sel.size ? app.photos.filter((p) => st.sel.has(p.id)) : (app.cur ? [app.cur] : []));
  const save = async (ps) => { for (const p of ps) await store.putPhoto(p); };
  function draw() {
    grid.replaceChildren();
    const L = visible();
    count.textContent = `${L.length} / ${app.photos.length} ảnh` + (st.sel.size ? ` · đã chọn ${st.sel.size}` : '') + (st.multi ? ' · chạm để chọn / bỏ chọn' : ' · chạm để mở, giữ để chọn nhiều');
    multiBtn.classList.toggle('sel', st.multi);
    for (const p of L) {
      if (p.thumb && !p._url) p._url = URL.createObjectURL(p.thumb);
      const lab = LABELS.find((x) => x[0] === p.label);
      const cell = h('div', { class: 'cell' + (st.sel.has(p.id) ? ' on' : '') + (app.cur && app.cur.id === p.id ? ' cur' : '') },
        h('img', { src: p._url || '', alt: '' }),
        h('div', { class: 'meta' }, h('span', { class: 'stars' }, '★'.repeat(p.rating || 0)),
          p.flag === 1 ? h('span', { class: 'fl pick' }, '✓') : p.flag === -1 ? h('span', { class: 'fl rej' }, '✕') : null,
          lab ? h('span', { class: 'lab', style: `background:${lab[1]}` }) : null),
        p.vc ? h('span', { class: 'vc' }, 'Bản sao') : null,
        p.cullReason && p.flag === -1 ? h('div', { class: 'why' }, p.cullReason) : null,
        h('div', { class: 'nm' }, p.name));
      let t = null, long = false;
      cell.addEventListener('pointerdown', () => { long = false; t = setTimeout(() => { long = true; st.multi = true; st.sel.add(p.id); draw(); }, 450); });
      cell.addEventListener('pointerup', () => {
        clearTimeout(t); if (long) return;
        if (st.multi) { st.sel.has(p.id) ? st.sel.delete(p.id) : st.sel.add(p.id); draw(); }
        else { app.closeSheet(); app.openPhoto(p); }
      });
      cell.addEventListener('pointercancel', () => clearTimeout(t));
      grid.append(cell);
    }
  }
  const act = async (fn, label) => { const ps = targets(); if (!ps.length) return app.toast('Chưa chọn ảnh nào'); fn(ps); await save(ps); draw(); app.renderStrip(); if (label) app.toast(label); };
  const stars = h('div', { class: 'chips' }, ...[0, 1, 2, 3, 4, 5].map((n) => btn(n ? '★'.repeat(n) : '☆ 0', () => act((ps) => ps.forEach((p) => { p.rating = n; }), `Đặt ${n} sao`))));
  const flags = h('div', { class: 'chips' }, btn('✓ Chọn', () => act((ps) => ps.forEach((p) => { p.flag = 1; p.cullReason = ''; }))),
    btn('✕ Loại', () => act((ps) => ps.forEach((p) => { p.flag = -1; }))), btn('Bỏ cờ', () => act((ps) => ps.forEach((p) => { p.flag = 0; p.cullReason = ''; }))),
    ...LABELS.map(([k, c]) => h('button', { style: `background:${c};width:34px;padding:6px 0`, onclick: () => act((ps) => ps.forEach((p) => { p.label = p.label === k ? '' : k; })) }, ' ')));
  const tools = h('div', { class: 'grid2' },
    btn('Chọn tất cả (đang lọc)', () => { st.multi = true; for (const p of visible()) st.sel.add(p.id); draw(); }),
    btn('Bỏ chọn', () => { st.sel.clear(); draw(); }),
    btn('Bản sao ảo', () => act((ps) => virtualCopies(app, ps), 'Đã tạo bản sao ảo')),
    btn('So sánh (1 ảnh: trước / sau)', () => { const ps = targets(); if (!ps.length || ps.length > 4) return app.toast('Chọn 1 ảnh (so trước / sau) hoặc 2 đến 4 ảnh để so sánh'); compare(app, ps); }),
    btn('Áp style cho ảnh chọn', () => styleMany(app, targets(), draw)),
    btn('Dán chỉnh sửa cho ảnh chọn', () => pasteMany(app, targets(), draw)),
    btn('Đặt lại ảnh chọn…', () => { const ps = targets(); if (!ps.length) return app.toast('Chưa chọn ảnh nào'); app.openResetMenu(ps); }),
    btn('Xuất hàng loạt', () => { const ps = targets(); if (!ps.length) return app.toast('Chưa chọn ảnh nào'); batchExport(app, ps); }),
    btn('Gỡ ảnh chọn khỏi app', () => removeMany(app, targets(), draw)),
    btn('Tự lọc: mờ / nhắm mắt / trùng', () => autoCull(app, st.sel.size ? targets() : visible(), draw)));
  bar.append(stars, flags);
  app.openSheet('Thư viện', h('div', {}, h('div', { class: 'row' }, fSel.el, sSel.el), h('div', { class: 'row' }, multiBtn, count), grid,
    h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 't' }, 'Đánh dấu (ảnh chọn, hoặc ảnh đang xem)')), bar),
    h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 't' }, 'Thao tác')), tools,
      hint('Ảnh gốc trong thư viện Ảnh của iPhone không bao giờ bị sửa — PUM chỉ giữ bản chép riêng và thông số chỉnh.'))), true);
  draw();
}

function virtualCopies(app, ps) {
  for (const p of ps) {
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const q = Object.assign({}, p, { id, fileId: p.fileId || p.id, vc: true, added: p.added + 0.5, settings: p.settings ? S.deepCopy(p.settings) : null, _url: null });
    app.photos.push(q);
    store.putPhoto(q);
  }
}

async function removeMany(app, ps, draw) {
  if (!ps.length) return app.toast('Chưa chọn ảnh nào');
  if (!confirm(`Gỡ ${ps.length} ảnh khỏi PUM? (Ảnh gốc trong thư viện Ảnh của iPhone không bị ảnh hưởng.)`)) return;
  const ids = new Set(ps.map((p) => p.id));
  for (const p of ps) {
    const fid = p.fileId || p.id;
    const shared = app.photos.some((q) => !ids.has(q.id) && (q.fileId || q.id) === fid);
    await store.delPhotoOnly(p.id);
    if (!shared) await store.delFile(fid);
    app.worker.postMessage({ type: 'drop', id: p.id });
  }
  app.photos = app.photos.filter((p) => !ids.has(p.id));
  app.lib.sel.clear();
  if (app.cur && ids.has(app.cur.id)) { app.cur = null; app.bitmap = null; const nx = app.photos[app.photos.length - 1]; if (nx) app.openPhoto(nx); else location.reload(); }
  app.renderStrip(); draw();
}

function styleMany(app, ps, draw) {
  if (!ps.length) return app.toast('Chưa chọn ảnh nào');
  let k = 100, name = null;
  const strength = new Slider({ begin() {}, end() {}, toast() {} }, { label: 'Độ mạnh', lo: 0, hi: 150, def: 100, get: () => k, set: (v) => { k = v; } });
  strength.sync();
  const chips = h('div', { class: 'chips' }, ...app.allStyles().map(([n]) => h('button', { onclick: (e) => { name = n; for (const b of chips.children) b.classList.toggle('sel', b === e.target); } }, n)));
  app.openSheet(`Áp style cho ${ps.length} ảnh`, h('div', {}, chips, strength.el, h('button', { class: 'big', style: 'width:100%;margin-top:10px', onclick: async () => {
    if (!name) return app.toast('Chọn một style');
    const st = app.allStyles().find((x) => x[0] === name)[1];
    await app.saveCurrent();
    for (const p of ps) {
      const ns = S.blendStyle(p.settings, st, k / 100);
      p.settings = S.isDefault(ns) ? null : ns;
      await store.putPhoto(p);
      if (app.cur && p.id === app.cur.id) { app.s = S.mergeSettings(p.settings); app.pushHistory('Style ' + name); app.refresh(); app.requestRender(false); }
    }
    app.toast(`Đã áp style "${name}" cho ${ps.length} ảnh (thumbnail cập nhật khi mở ảnh)`);
    openLibrary(app);
  } }, 'Áp dụng')));
}

async function pasteMany(app, ps, draw) {
  if (!app.clip) return app.toast('Chưa sao chép chỉnh sửa nào (tab Style › Sao chép chỉnh sửa)');
  if (!ps.length) return app.toast('Chưa chọn ảnh nào');
  await app.saveCurrent();
  for (const p of ps) {
    const cur = S.mergeSettings(p.settings);
    const ns = S.mergeSettings(Object.assign(S.deepCopy(app.clip), { straighten: cur.straighten, crop_rect: cur.crop_rect, flip: cur.flip, crop_outside: cur.crop_outside }));
    ns.lens.kguides = cur.lens.kguides; ns.lens.kmat = cur.lens.kmat;
    p.settings = ns; await store.putPhoto(p);
    if (app.cur && p.id === app.cur.id) { app.s = S.mergeSettings(ns); app.pushHistory('Dán chỉnh sửa'); app.refresh(); app.requestRender(false); }
  }
  app.toast(`Đã dán chỉnh sửa cho ${ps.length} ảnh`);
  draw();
}

// ---------------------------------------------------------------- so sánh
// Chọn 1 ảnh: so CÙNG MỘT MÃ ẢNH — có bản sao ảo thì so ảnh gốc với các bản sao, không thì trái = trước khi chỉnh
// (thông số mặc định, giữ khung cắt / xoay), phải = sau khi chỉnh (MainWindow.compare_same bản máy tính).
// Chọn 2–4 ảnh: so các ảnh khác nhau.
const GEOM_KEYS = ['rotate', 'straighten', 'crop', 'crop_rect', 'flip', 'lens', 'crop_outside'];
function compareTargets(app, ps) {
  if (ps.length !== 1) return ps.map((p) => ({ p, label: p.name + ' ' + '★'.repeat(p.rating || 0) }));
  const p = ps[0], fid = p.fileId || p.id;
  const same = app.photos.filter((q) => (q.fileId || q.id) === fid).sort((a, b) => (a.added || 0) - (b.added || 0));
  if (same.length > 1)
    return same.slice(0, 4).map((q) => ({ p: q, label: (q.vc ? 'Bản sao ảo' : 'Ảnh gốc') + ' ' + '★'.repeat(q.rating || 0) }));
  const s = S.mergeSettings(app.cur && app.cur.id === p.id ? app.s : p.settings), before = S.defaultSettings();
  for (const k of GEOM_KEYS) before[k] = S.deepCopy(s[k]);
  return [{ p, label: 'Trước khi chỉnh', settings: before }, { p, label: 'Sau khi chỉnh' }];
}
export async function compare(app, ps) {
  const items = compareTargets(app, ps);
  const wrap = h('div', { class: 'cmp' + (items.length > 2 ? ' four' : '') });
  const z = { k: 1, x: 0, y: 0 };            // phóng / kéo ĐỒNG BỘ mọi ô (cùng điểm, cùng mức)
  // vẽ theo khung hình: nhiều lần chạm di chuyển trong một khung chỉ đổi transform một lần (mượt, không trễ dồn)
  let raf = 0, cells = null;
  const apply = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const t = `translate3d(${z.x}px,${z.y}px,0) scale(${z.k})`;
      for (const c of cells || (cells = [...wrap.querySelectorAll('canvas')])) c.style.transform = t;
    });
  };
  let box = null;                            // cỡ ô (không phóng), đo một lần lúc chạm -> không đo lại khi kéo
  const clampZ = () => {
    z.k = Math.min(8, Math.max(1, z.k));
    if (!box) return;
    const w = box.w, hh = box.h;
    z.x = Math.min(0, Math.max(w - w * z.k, z.x)); z.y = Math.min(0, Math.max(hh - hh * z.k, z.y));
  };
  const pts = new Map(); let g0 = null, moved = false, lastTap = 0;
  const gesture = () => {
    const a = [...pts.values()];
    if (a.length === 1) return { cx: a[0].x, cy: a[0].y, d: 0 };
    return { cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
  };
  wrap.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cmpcell'); if (!cell || e.target.closest('button')) return;
    wrap.setPointerCapture(e.pointerId);
    // toạ độ theo khung ô (KHÔNG theo ảnh đã phóng / kéo: ảnh đã dời thì lần kéo sau bị nhảy)
    const r = cell.querySelector('.cmpview').getBoundingClientRect();
    const c = cell.querySelector('canvas');
    box = { w: c.offsetWidth, h: c.offsetHeight };
    pts.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top, r });
    g0 = { ...gesture(), z: { ...z } }; moved = false;
  });
  wrap.addEventListener('pointermove', (e) => {
    const q = pts.get(e.pointerId); if (!q) return;
    q.x = e.clientX - q.r.left; q.y = e.clientY - q.r.top;
    const g = gesture();
    if (Math.hypot(g.cx - g0.cx, g.cy - g0.cy) > 6 || (g.d && Math.abs(g.d - g0.d) > 6)) moved = true;
    if (!moved) return;
    const k = g.d && g0.d ? g0.z.k * g.d / g0.d : g0.z.k;
    // giữ điểm dưới ngón tay đứng yên khi phóng
    const ux = (g0.cx - g0.z.x) / g0.z.k, uy = (g0.cy - g0.z.y) / g0.z.k;
    z.k = k; z.x = g.cx - ux * z.k; z.y = g.cy - uy * z.k;
    clampZ(); apply();
  });
  const up = (e) => {
    const q = pts.get(e.pointerId); if (!q) return;
    pts.delete(e.pointerId);
    if (!moved && !pts.size) {
      const t = Date.now();
      if (t - lastTap < 320) {                // chạm đúp: phóng x3 tại chỗ chạm / về vừa ô
        if (z.k > 1.01) { z.k = 1; z.x = 0; z.y = 0; } else { const ux = (q.x - z.x) / z.k, uy = (q.y - z.y) / z.k; z.k = 3; z.x = q.x - ux * 3; z.y = q.y - uy * 3; }
        clampZ(); apply(); lastTap = 0;
      } else lastTap = t;
    }
    if (pts.size) g0 = { ...gesture(), z: { ...z } };
  };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  for (const it of items) {
    const c = h('canvas', { style: 'transform-origin:0 0' });
    const open = h('button', { class: 'cmpopen', onclick: () => { app.closeSheet(); app.openPhoto(it.p); } }, 'Mở');
    wrap.append(h('div', { class: 'cmpcell' }, h('div', { class: 'cmpview' }, c), h('div', { class: 'nm' }, h('span', {}, it.label), open)));
  }
  app.openSheet(items.length === 2 && items[0].p === items[1].p ? 'So sánh trước / sau' : 'So sánh', h('div', {}, wrap,
    hint('Chụm 2 ngón để phóng, kéo để di chuyển — mọi ảnh phóng và di chuyển cùng nhau. Chạm đúp: phóng ×3 / về vừa ô. Bấm "Mở" để chỉnh ảnh đó.')), true);
  // ảnh giống nhau (trước / sau) chỉ giải mã một lần
  const groups = new Map();
  items.forEach((it, i) => { if (!groups.has(it.p.id)) groups.set(it.p.id, []); groups.get(it.p.id).push(i); });
  for (const idx of groups.values()) {
    try {
      const imgs = await app.renderPhotoVariants(items[idx[0]].p, 1600, idx.map((i) => items[i].settings || null));
      idx.forEach((i, k) => {
        const c = wrap.children[i].querySelector('canvas'), img = imgs[k];
        c.width = img.w; c.height = img.h;
        c.getContext('2d').putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
      });
    } catch (e) { for (const i of idx) wrap.children[i].append(h('div', { class: 'hint' }, 'Lỗi: ' + e.message)); }
  }
}

// ---------------------------------------------------------------- tự lọc: mờ / nhắm mắt / trùng (library.analyze_image + decide_culls)
function sharpVar(g, w, h) {
  // cv2.Laplacian ksize=1 (nhân 4 lân cận), viền phản chiếu 101, phương sai
  let s = 0, s2 = 0;
  const at = (x, y) => { if (x < 0) x = -x; else if (x >= w) x = 2 * w - 2 - x; if (y < 0) y = -y; else if (y >= h) y = 2 * h - 2 - y; return g[y * w + x]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * g[y * w + x];
    s += v; s2 += v * v;
  }
  const n = w * h, m = s / n;
  return s2 / n - m * m;
}
function dhash(g, w, h) {
  const sm = cv.resizeArea({ w, h, c: 1, d: g }, 9, 8).d;
  let bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(Math.round(sm[y * 9 + x + 1]) > Math.round(sm[y * 9 + x]) ? 1 : 0);
  return bits;
}
async function analyze(app, p) {
  const blob = await store.getFile(p.fileId || p.id);
  const dec = await decodeFile(blob, p.name);
  const k = Math.min(1, 1280 / Math.max(dec.src.width, dec.src.height));
  const w = Math.max(1, Math.round(dec.src.width * k)), hh = Math.max(1, Math.round(dec.src.height * k));
  const rgba = dec.src.region(0, 0, dec.src.width, dec.src.height, w, hh);
  dec.src.close && dec.src.close();
  const g = new Float32Array(w * hh);
  for (let i = 0; i < w * hh; i++) g[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  const info = { sharp: sharpVar(g, w, hh), hash: dhash(g, w, hh), faces: 0, closed: 0, face_sharp: null };
  try {
    const { faceBlinks } = await import('../ai.js');
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    c.getContext('2d').putImageData(new ImageData(rgba, w, hh), 0, 0);
    const faces = (await faceBlinks(c)).filter((f) => f.size >= 0.04);
    c.width = 0;
    info.faces = faces.length;
    const fs = [];
    for (const f of faces) {
      const [x0, y0, x1, y1] = f.box;
      if (x1 - x0 > 20 && y1 - y0 > 20) {
        const fw = x1 - x0, fh = y1 - y0, sub = new Float32Array(fw * fh);
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) sub[y * fw + x] = g[(y + y0) * w + x + x0];
        fs.push(sharpVar(sub, fw, fh));
      }
      if (f.blink > 0.5) info.closed++;
    }
    if (fs.length) info.face_sharp = Math.max(...fs);
  } catch (e) { console.warn('AI nhắm mắt lỗi', e); }
  return info;
}
export function decideCulls(names, infos, useBlur = true, useEyes = true, useDup = true, blurLevel = 0.35) {
  const reasons = {};
  const sharp = infos.map((i) => (i.face_sharp != null ? i.face_sharp : i.sharp));
  const med = sharp.length ? cv.percentile(sharp, 50) : 0;
  names.forEach((n, k) => {
    const i = infos[k];
    if (useEyes && i.closed > 0) reasons[n] = i.faces === 1 ? 'Nhắm mắt' : `Nhắm mắt (${i.closed}/${i.faces} người)`;
    else if (useBlur && med > 0 && sharp[k] < med * blurLevel) reasons[n] = 'Ảnh mờ / rung';
  });
  if (useDup) {
    let group = [0];
    const close = (g) => {
      if (g.length < 2) return;
      const best = g.reduce((b, k) => { const kb = [!(names[b] in reasons), sharp[b]], kk = [!(names[k] in reasons), sharp[k]]; return (kk[0] > kb[0] || (kk[0] === kb[0] && kk[1] > kb[1])) ? k : b; }, g[0]);
      for (const k of g) if (k !== best && !(names[k] in reasons)) reasons[names[k]] = `Trùng với ${names[best]}`;
    };
    for (let k = 1; k < names.length; k++) {
      const d = infos[k].hash.reduce((s, b, i) => s + (b !== infos[k - 1].hash[i] ? 1 : 0), 0);
      if (d <= 8) group.push(k); else { close(group); group = [k]; }
    }
    close(group);
  }
  return reasons;
}
async function autoCull(app, ps, draw) {
  if (ps.length < 2) return app.toast('Cần ít nhất 2 ảnh để tự lọc');
  const prog = h('div', { class: 'prog' }, h('div')), status = h('div', { class: 'hint' }, 'Đang phân tích…');
  let stop = false;
  app.openSheet('Tự lọc ảnh', h('div', {}, status, prog, btn('Dừng', () => { stop = true; })));
  const list = ps.slice().sort((a, b) => a.added - b.added), infos = [];
  for (let i = 0; i < list.length && !stop; i++) {
    status.textContent = `Đang phân tích ${i + 1}/${list.length}: ${list[i].name}`;
    infos.push(await analyze(app, list[i]));
    prog.firstChild.style.width = ((i + 1) / list.length * 100).toFixed(0) + '%';
  }
  const done = list.slice(0, infos.length);
  const reasons = decideCulls(done.map((p) => p.id), infos);
  let n = 0;
  for (const p of done) {
    if (reasons[p.id]) {
      p.flag = -1; n++;
      p.cullReason = reasons[p.id].replace(/Trùng với (\S+)/, (m, id) => 'Trùng với ' + ((app.photos.find((q) => q.id === id) || {}).name || id));
    }
    await store.putPhoto(p);
  }
  app.lib.filter = 'reject';
  openLibrary(app);
  app.toast(`Tự lọc xong: đánh dấu loại ${n}/${done.length} ảnh (lọc "✕ Loại" để xem, bỏ cờ nếu muốn giữ)`, 5000);
}

// ---------------------------------------------------------------- xuất hàng loạt (lần lượt, không giữ nhiều ảnh lớn cùng lúc)
async function batchExport(app, ps) {
  const opts = await loadOpts();
  const rows = ps.map((p) => h('div', { class: 'it' }, h('span', { class: 'n' }, p.name), h('span', { class: 'st' }, 'chờ')));
  const prog = h('div', { class: 'prog' }, h('div')), status = h('div', { class: 'hint' });
  const saveBox = h('div', { class: 'grid2' });
  let stop = false;
  const results = [];
  const goBtn = h('button', { class: 'big', style: 'width:100%;margin-top:8px' }, 'Bắt đầu xuất');
  app.openSheet(`Xuất hàng loạt ${ps.length} ảnh`, h('div', {},
    hint(`Dùng cài đặt xuất hiện tại: ${opts.long_edge ? 'cạnh dài ' + opts.long_edge + ' px' : 'cỡ gốc'}, JPEG ${opts.quality}` +
      (opts.watermark.enabled ? ', có watermark' : '') + (opts.footer.enabled ? ', có chân ảnh' : '') + '.'),
    btn('Đổi cài đặt xuất…', () => openExportOptions(app, () => batchExport(app, ps))),
    goBtn, btn('Dừng', () => { stop = true; }), prog, status, h('div', { class: 'list' }, ...rows), saveBox));
  goBtn.onclick = async () => {
    goBtn.disabled = true;
    await app.saveCurrent();
    const t0 = performance.now();
    for (let i = 0; i < ps.length && !stop; i++) {
      const p = ps[i], stEl = rows[i].querySelector('.st');
      stEl.textContent = 'đang xuất…';
      try {
        const prep = await app.preparePhoto(p);
        const r = await runExport(app, opts, (q) => { prog.firstChild.style.width = ((i + q) / ps.length * 100).toFixed(0) + '%'; },
          { id: prep.id, name: p.name, settings: S.mergeSettings(p.settings), bitmap: prep.src, W: prep.src.width, H: prep.src.height, photo: p.fileId || p.id });
        prep.release();
        results.push(r);
        stEl.textContent = `✓ ${(r.blob.size / 1048576).toFixed(1)} MB`;
      } catch (e) { console.error(e); stEl.textContent = 'lỗi: ' + e.message; }
      status.textContent = `${results.length}/${ps.length} ảnh · ${((performance.now() - t0) / 1000).toFixed(0)} giây`;
    }
    prog.firstChild.style.width = '100%';
    saveBox.replaceChildren();
    for (let k = 0; k < results.length; k += 10) {
      const grp = results.slice(k, k + 10);
      saveBox.append(btn(`Lưu về Ảnh ${k + 1}–${k + grp.length}`, () => shareFiles(app, grp)));
    }
    status.textContent += ' — xong. Bấm "Lưu về Ảnh" rồi chọn "Lưu hình ảnh".';
  };
}
async function shareFiles(app, rs) {
  const files = rs.map((r) => new File([r.blob], r.name, { type: 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const r of rs) await shareOrDownload(r.blob, r.name, app);
}
