// Luồng dựng ảnh (Web Worker): giữ ảnh nền xem trước + bản nháp, dựng theo từng bước có bộ nhớ đệm
// (kéo một thanh chỉ dựng lại từ bước bị ảnh hưởng), Auto từng nhóm, xuất ảnh cỡ gốc theo dải.
import * as E from '../engine/engine.js';
import { mergeSettings } from '../engine/settings.js';
import * as A from '../engine/auto.js';
import { exportJob } from '../engine/export.js';
import { applyRetouch, hasRetouch, findAreaSources } from '../engine/retouch.js';

const cv = E.cv;
const bases = {};          // id -> { full: img, draft: img, fullW, fullH }
let cur = null;

// mặt nạ người (≤1024 px) -> hàm lấy mặt nạ cho một vùng w x h (roi = [x0, y0, W, H] theo cả ảnh),
// nội suy song tuyến như cv2.resize rồi ngưỡng clip((m - 0.3) / 0.4) như library.PersonSegmenter
function makePersonFn(pm) {
  return (w, h, roi) => {
    const [ox, oy, W, H] = roi || [0, 0, w, h];
    const out = new Float32Array(w * h), mw = pm.w, mh = pm.h, d = pm.d;
    const sx = mw / W, sy = mh / H;
    for (let y = 0; y < h; y++) {
      let fy = (y + oy + 0.5) * sy - 0.5, y0 = Math.floor(fy); fy -= y0;
      if (y0 < 0) { y0 = 0; fy = 0; } if (y0 >= mh - 1) { y0 = mh - 1; fy = 0; }
      const y1 = Math.min(mh - 1, y0 + 1);
      for (let x = 0; x < w; x++) {
        let fx = (x + ox + 0.5) * sx - 0.5, x0 = Math.floor(fx); fx -= x0;
        if (x0 < 0) { x0 = 0; fx = 0; } if (x0 >= mw - 1) { x0 = mw - 1; fx = 0; }
        const x1 = Math.min(mw - 1, x0 + 1);
        const v = (d[y0 * mw + x0] * (1 - fx) + d[y0 * mw + x1] * fx) * (1 - fy) + (d[y1 * mw + x0] * (1 - fx) + d[y1 * mw + x1] * fx) * fy;
        const t = (v - 0.3) / 0.4;
        out[y * w + x] = t < 0 ? 0 : t > 1 ? 1 : t;
      }
    }
    return out;
  };
}

function u8ToImg(u8, w, h) {
  const n = w * h, d = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) { d[i * 3] = u8[j] / 255; d[i * 3 + 1] = u8[j + 1] / 255; d[i * 3 + 2] = u8[j + 2] / 255; }
  return { w, h, c: 3, d };
}
function toRGBA(img) {
  const n = img.w * img.h, out = new Uint8ClampedArray(n * 4), d = img.d;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    out[i * 4] = Math.floor(Math.min(1, Math.max(0, d[j])) * 255 + 0.5);
    out[i * 4 + 1] = Math.floor(Math.min(1, Math.max(0, d[j + 1])) * 255 + 0.5);
    out[i * 4 + 2] = Math.floor(Math.min(1, Math.max(0, d[j + 2])) * 255 + 0.5);
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ------------------------------------------------------------- các bước dựng + khoá bộ nhớ đệm
const J = JSON.stringify;
const pick = (s, keys) => keys.map((k) => s[k]);
const STAGES = [
  { name: 'retouch', key: (s) => J(s.retouch), run: (img, s, c) => applyRetouch(img, s.retouch, c) },
  { name: 'tone', key: (s) => J([s.lens.vig_corr, s.calib, s.curve, pick(s, ['temp', 'tint', 'exposure', 'dehaze', 'highlights', 'shadows', 'whites', 'blacks', 'contrast', 'brightness', 'clarity'])]),
    run: (img, s, c) => E.tone(E.vigCorr(img, s, c.roi), s) },
  { name: 'color', key: (s) => J([s.color, s.skin, s.vibrance, s.saturation]), run: (img, s) => E.color(img, s) },
  { name: 'grading', key: (s) => J(s.grading), run: (img, s) => E.grading(img, s.grading) },
  { name: 'layers', key: (s) => J(s.layers), run: (img, s, c) => E.applyLayers(img, s, c) },
  { name: 'detail', key: (s) => J(pick(s, ['nr_lum', 'nr_lum_detail', 'nr_lum_contrast', 'nr_color', 'nr_color_detail', 'nr_color_smooth', 'sharpen', 'sharpen_radius'])),
    run: (img, s, c) => E.detail(img, s, c.scale) },
  { name: 'texture', key: (s) => J(s.texture), run: (img, s) => E.texture(img, s.texture, s._ref_w || img.w) },
  { name: 'vignette', key: (s) => J(s.vignette), run: (img, s, c) => E.vignette(img, s, c.roi) },
  { name: 'grain', key: (s) => J([s.grain, s.grain_size]), run: (img, s, c) => { img = E.grain(img, s, c.scale, c.roi); for (let i = 0; i < img.d.length; i++) img.d[i] = img.d[i] < 0 ? 0 : img.d[i] > 1 ? 1 : img.d[i]; return img; } },
];
// bước nào được giữ lại trong bộ nhớ (ảnh nháp: mọi bước; ảnh xem trước lớn: vài mốc để tiết kiệm bộ nhớ)
const KEEP_FULL = new Set(['tone', 'grading', 'layers', 'grain']);

function makeCache() { return { keys: [], imgs: [] }; }

function runStages(base, s, ctx, cache, keepAll) {
  let img = base, i0 = 0;
  const keys = STAGES.map((st) => st.key(s));
  // tìm bước sâu nhất còn dùng lại được
  let reuse = -1;
  for (let i = 0; i < STAGES.length; i++) {
    if (cache.keys[i] !== keys[i]) break;
    if (cache.imgs[i]) reuse = i;
  }
  // mọi bước trước reuse phải khớp khoá
  if (reuse >= 0) { img = cache.imgs[reuse]; i0 = reuse + 1; }
  for (let i = i0; i < STAGES.length; i++) {
    const st = STAGES[i];
    const active = isActive(st.name, s);
    if (active) img = st.run(cv.clone(img), s, ctx);
    cache.keys[i] = keys[i];
    cache.imgs[i] = (keepAll === 'all' || (keepAll === 'some' && KEEP_FULL.has(st.name))) ? img : null;
  }
  cache.keys.length = STAGES.length;
  return img;
}
function isActive(name, s) {
  switch (name) {
    case 'retouch': return hasRetouch(s.retouch);
    case 'layers': return (s.layers || []).length > 0;
    case 'detail': return !!(s.nr_lum || s.nr_color || s.sharpen);
    case 'texture': return !!s.texture;
    case 'vignette': return !!s.vignette;
    case 'grain': return !!s.grain;
    default: return true;
  }
}

function renderBase(b, which, settings, geom) {
  const s = mergeSettings(settings);
  const base = which === 'draft' ? b.draft : which === 'draft2' ? b.draft2 : b.full;
  const scale = base.w / b.fullW;
  const ctx = { scale, personFn: b.personFn || null, faces: b.faces || null };
  const cacheKey = which;
  b.cache = b.cache || {};
  b.cache[cacheKey] = b.cache[cacheKey] || makeCache();
  let img = runStages(base, s, ctx, b.cache[cacheKey], which.startsWith('draft') ? 'all' : which === 'full' ? 'some' : 'none');
  if (geom) img = E.geometry(img, s, geom === true);
  return img;
}

// tô đỏ vùng mask của layer đang chọn (Hiện mask)
function maskOverlay(b, which, settings, geom, idx, img) {
  const s = mergeSettings(settings);
  const ly = s.layers[idx];
  if (!ly) return img;
  const base = which === 'draft' ? b.draft : which === 'draft2' ? b.draft2 : b.full;
  const m = E.layerMaskFor(base, Object.assign({}, ly, { enabled: true }), { personFn: b.personFn || null });
  const mi = cv.img3(base.w, base.h);
  for (let i = 0; i < m.d.length; i++) mi.d[i * 3] = mi.d[i * 3 + 1] = mi.d[i * 3 + 2] = m.d[i];
  const g = geom ? E.geometry(mi, s, geom === true) : mi;
  for (let i = 0; i < g.d.length; i += 3) {
    const a = g.d[i] * 0.6;
    img.d[i] = img.d[i] * (1 - a) + a; img.d[i + 1] *= 1 - a; img.d[i + 2] *= 1 - a;
  }
  return img;
}

function skinStats(b, settings) {
  const s = mergeSettings(settings);
  if (!Object.values(s.skin).some((v) => Math.abs(v) > 1e-6)) return null;
  const t = Object.assign({}, s, { _skin_stats_out: [] });
  E.color(E.tone(E.vigCorr(cv.clone(b.full), s), s), t);
  return t._skin_stats_out[0] || null;
}

function histo(img) {
  const h = new Uint32Array(256 * 4), d = img.d, n = img.w * img.h;
  const step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) {
    const j = i * 3, r = d[j], g = d[j + 1], b = d[j + 2];
    const q = (v) => Math.min(255, Math.max(0, Math.floor(v * 255 + 0.5)));
    h[q(r)]++; h[256 + q(g)]++; h[512 + q(b)]++; h[768 + q(r * 0.2126 + g * 0.7152 + b * 0.0722)]++;
  }
  return h;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'base') {
      // m.rgba: Uint8ClampedArray xem trước (w x h), m.fullW/fullH: cỡ gốc
      const full = u8ToImg(m.rgba, m.w, m.h);
      const k = Math.min(1, m.draftSide / Math.max(m.w, m.h));
      const draft = k < 1 ? cv.resizeArea(full, Math.max(1, Math.round(m.w * k)), Math.max(1, Math.round(m.h * k))) : full;
      const draft2 = cv.resizeArea(draft, Math.max(1, Math.round(draft.w * 0.62)), Math.max(1, Math.round(draft.h * 0.62)));
      bases[m.id] = { full, draft, draft2, fullW: m.fullW, fullH: m.fullH };
      cur = m.id;
      self.postMessage({ type: 'base_ok', id: m.id, req: m.req });
    } else if (m.type === 'person') {
      const b = bases[m.id];
      if (b) { b.person = m.mask; b.personFn = makePersonFn(m.mask); b.cache = {}; }
      self.postMessage({ type: 'person', req: m.req });
    } else if (m.type === 'faces') {
      const b = bases[m.id];
      if (b) { b.faces = m.faces; b.cache = {}; }
      self.postMessage({ type: 'faces', req: m.req });
    } else if (m.type === 'drop') {
      delete bases[m.id];
    } else if (m.type === 'render') {
      const b = bases[m.id];
      if (!b) { self.postMessage({ type: 'render', req: m.req, error: 'chưa có ảnh' }); return; }
      const t0 = performance.now();
      cv.opts.FAST = m.which.startsWith('draft');
      let img;
      try { img = renderBase(b, m.which, m.settings, m.geom); } finally { cv.opts.FAST = false; }
      if (m.mask >= 0 && m.which !== 'before') img = maskOverlay(b, m.which, m.settings, m.geom, m.mask, cv.clone(img));
      const rgba = toRGBA(img);
      const out = { type: 'render', req: m.req, id: m.id, which: m.which, w: img.w, h: img.h, rgba, ms: performance.now() - t0 };
      if (m.hist) out.hist = histo(img);
      self.postMessage(out, [rgba.buffer]);
    } else if (m.type === 'auto') {
      const b = bases[m.id];
      const s = mergeSettings(m.settings);
      const res = A.autoSection(m.key, b.full, s, { k: b.fullW / b.full.w, layer: m.layer, personFn: b.personFn, faces: b.faces });
      self.postMessage({ type: 'auto', req: m.req, res });
    } else if (m.type === 'area_sources') {
      // tự tìm nguồn cho vùng tô mới, trên ảnh đã áp các retouch trước đó
      const b = bases[m.id];
      const s = mergeSettings(m.settings);
      const img = applyRetouch(cv.clone(b.full), s.retouch, {});
      self.postMessage({ type: 'area_sources', req: m.req, cands: findAreaSources(img, m.area) });
    } else if (m.type === 'pixel') {
      // điểm ảnh của ảnh nền (chưa chỉnh) tại toạ độ chuẩn hoá — dùng cho ống hút cân bằng trắng
      const b = bases[m.id], im = b.full;
      const r = Math.max(1, Math.round(im.w * 0.004));
      const cx = Math.round(m.x * (im.w - 1)), cy = Math.round(m.y * (im.h - 1));
      const acc = [0, 0, 0]; let c = 0;
      for (let y = Math.max(0, cy - r); y <= Math.min(im.h - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(im.w - 1, cx + r); x++) {
          const j = (y * im.w + x) * 3; acc[0] += im.d[j]; acc[1] += im.d[j + 1]; acc[2] += im.d[j + 2]; c++;
        }
      self.postMessage({ type: 'pixel', req: m.req, rgb: acc.map((v) => v / c) });
    } else if (m.type === 'export_start' || m.type === 'roi_start') {
      const b = bases[m.id];
      if (b && !m.skin_stats) m.skin_stats = skinStats(b, m.settings);
      if (b) { m.personFn = b.personFn || null; m.faces = b.faces || null; }
      exportJob(m, self);
    } else if (m.type === 'export_band' || m.type === 'export_cancel') {
      exportJob(m, self);
    }
  } catch (e) {
    self.postMessage({ type: m.type, req: m.req, error: String(e && e.stack || e) });
  }
};
