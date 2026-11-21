// Dựng theo vùng ở độ phân giải gốc (giống engine.render_roi của PUM máy tính):
// - Xuất ảnh cỡ gốc THEO DẢI: mỗi dải lấy đúng vùng nguồn cần (+ lề đủ bán kính các hiệu ứng), dựng, nắn khung,
//   mã hoá JPEG ngay — không giữ ảnh số thực cỡ gốc trong bộ nhớ.
// - Phóng 1:1 nét: dựng đúng vùng đang xem.
// Chạy trong worker; luồng chính cấp các vùng ảnh nguồn (vẽ từ ImageBitmap) theo yêu cầu.
import * as E from './engine.js';
import { mergeSettings, lensActive } from './settings.js';
import { JpegEncoder } from './jpeg.js';
import { applyRetouch, hasRetouch, retouchNeeds, areaGeom, xvRefDims } from './retouch.js';
import * as XV from './xoa_vat.js';

const cv = E.cv;
const jobs = {};

export function exportJob(m, port) {
  if (m.type === 'export_band' || m.type === 'xv_ai' || m.type === 'xv_got') {
    const j = jobs[m.job], slot = m.type === 'export_band' ? 'wait' : 'waitXv';
    if (j && j[slot]) { const f = j[slot]; j[slot] = null; f(m); }
    return;
  }
  if (m.type === 'export_cancel') { if (jobs[m.job]) jobs[m.job].cancel = true; return; }
  const fn = m.type === 'roi_start' ? runRoi : m.type === 'xv_prepare' ? runXv : run;
  const done = m.type === 'roi_start' ? 'roi_done' : m.type === 'xv_prepare' ? 'xv_done' : 'export_done';
  fn(m, port).catch((e) => { delete jobs[m.job]; port.postMessage({ type: done, job: m.job, error: String(e && e.stack || e) }); });
}

// ------------------------------------------------------------------ Xoá vật thể bằng AI
// Hỏi luồng chính một việc của AI (chạy mô hình / đọc kết quả đã lưu) và chờ trả lời.
function askXv(job, port, msg, transfer) {
  return new Promise((res, rej) => {
    if (jobs[job].cancel) { rej(new Error('đã huỷ')); return; }
    jobs[job].waitXv = res;
    port.postMessage(Object.assign({ job }, msg), transfer || []);
  });
}

// Tính kết quả AI cho mọi vùng xoá vật thể của ảnh (P.s, ảnh gốc P.W x P.H) chưa có trong bộ đệm.
// Như PUM máy tính:
// - ảnh vào mô hình lấy ở độ phân giải tham chiếu (cạnh dài 2000 px);
// - các ô AI được tính trên ảnh đã áp những điểm / vùng retouch đứng TRƯỚC vùng đó.
// Kết quả lưu vào bộ đệm của luồng dựng, gửi cả cho app để lưu bền (IndexedDB) -> mở lại app không phải chạy AI.
async function xvPrepare(job, port, P) {
  const rt = P.s.retouch;
  if (!XV.state.ai || !rt || !(rt.areas || []).some((a) => a.kind === 'remove' && a.pts && a.pts.length && a.enabled !== false)) return 0;
  const W = P.W, H = P.H, [Wr, Hr] = xvRefDims(W, H), kx = W / Wr, ky = H / Hr;
  let n = 0;
  for (let i = 0; i < rt.areas.length; i++) {
    const a = rt.areas[i];
    if (!(a.kind === 'remove' && a.pts && a.pts.length && a.enabled !== false)) continue;
    const key = XV.cacheKey(P.photo, rt, i, Wr, Hr);
    if (!key || XV.cacheHas(key)) continue;
    const got = await askXv(job, port, { type: 'xv_get', key });
    if (got.entry) { XV.cachePut(key, got.entry); XV.state.epoch++; continue; }
    // ảnh trước vùng này ở độ phân giải tham chiếu, phủ đủ khung các ô AI (+ vùng nguồn của retouch trước đó)
    const pre = Object.assign({}, rt, { areas: rt.areas.slice(0, i), skin_amount: 0 });
    const rn = XV.rectNorm(a, Wr, Hr);
    const [x0, y0, x1, y1] = retouchNeeds(pre, Wr, Hr, [Math.floor(rn[0] * Wr), Math.floor(rn[1] * Hr), Math.ceil(rn[2] * Wr), Math.ceil(rn[3] * Hr)], null);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 2 || ch < 2) continue;
    const src = await need(job, port, [x0 * kx, y0 * ky, cw * kx, ch * ky], cw, ch);
    let img = { w: cw, h: ch, c: 3, d: new Float32Array(cw * ch * 3) };
    const u = src.rgba;
    for (let q = 0, j = 0; q < cw * ch; q++, j += 4) { img.d[q * 3] = u[j] / 255; img.d[q * 3 + 1] = u[j + 1] / 255; img.d[q * 3 + 2] = u[j + 2] / 255; }
    const roi = [x0, y0, Wr, Hr];
    if (hasRetouch(pre)) img = applyRetouch(img, pre, { roi, xvPhoto: P.photo, xvRef: [Wr, Hr] });
    const tiles = await XV.removeAsync(img, a, Wr, Hr, x0, y0, areaGeom(a, Wr, Hr, x0, y0), { key }, async (inp, m) => {
      port.postMessage({ type: 'xv_progress', job, area: i });
      const r = await askXv(job, port, { type: 'xv_run', inp, m }, [inp.buffer, m.buffer]);
      if (r.error) throw new Error(r.error);
      return r.L;
    });
    if (tiles) {
      XV.state.epoch++;
      n++;
      port.postMessage({ type: 'xv_put', job, key, entry: { tiles } });
    }
  }
  return n;
}

async function runXv(m, port) {
  const job = m.job;
  jobs[job] = {};
  const P = prep(m);
  const t0 = performance.now();
  const n = await xvPrepare(job, port, P);
  port.postMessage({ type: 'xv_done', job, n, ms: performance.now() - t0 });
  delete jobs[job];
}

function need(job, port, rect, tw, th) {
  return new Promise((res, rej) => {
    if (jobs[job].cancel) { rej(new Error('đã huỷ')); return; }
    jobs[job].wait = res;
    port.postMessage({ type: 'export_src', job, rect, tw, th });
  });
}

function prep(m) {
  const s = mergeSettings(m.settings);
  const W = m.W, H = m.H;
  const G = E.geometryAffine(W, H, s, true);
  return { s, W, H, G, Ai: E.inv3(G.M), lensOn: lensActive(s.lens), sr: Object.assign({}, s), noise: null, skin: m.skin_stats, personFn: m.personFn, faces: m.faces,
    faceInfos: m.faceInfos || null, photo: m.photo || m.id };
}

// dựng vùng ảnh ra [ox0, ox0+nw) x [oy0, oy0+rows) (toạ độ ảnh ra ở tỉ lệ ds) -> ảnh số thực
async function renderRect(job, port, P, ds, ox0, oy0, nw, rows) {
  const { s, W, H, G, Ai, lensOn, sr } = P;
  const n = nw * rows;
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let y = 0; y < rows; y++) {
    const gy = (oy0 + y + 0.5) / ds - 0.5;
    for (let x = 0; x < nw; x++) {
      const gx = (ox0 + x + 0.5) / ds - 0.5, i = y * nw + x;
      px[i] = Ai[0][0] * gx + Ai[0][1] * gy + Ai[0][2];
      py[i] = Ai[1][0] * gx + Ai[1][1] * gy + Ai[1][2];
    }
  }
  const ca = lensOn ? E.lensCoords(s.lens, W, H, px, py) : null;
  const mg = E.roiMargin(s, W) + (ca ? Math.trunc(0.003 * Math.max(W, H)) : 0) + 2;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i] < mnx) mnx = px[i]; if (px[i] > mxx) mxx = px[i];
    if (py[i] < mny) mny = py[i]; if (py[i] > mxy) mxy = py[i];
  }
  let sx0 = Math.max(0, Math.floor(mnx) - mg), sy0 = Math.max(0, Math.floor(mny) - mg);
  let sx1 = Math.min(W, Math.ceil(mxx) + 1 + mg), sy1 = Math.min(H, Math.ceil(mxy) + 1 + mg);
  // retouch: lấy thêm vùng nguồn của heal / clone nằm ngoài vùng
  if (hasRetouch(s.retouch)) [sx0, sy0, sx1, sy1] = retouchNeeds(s.retouch, W, H, [sx0, sy0, sx1, sy1], P.faces);
  let out;
  if (sx1 - sx0 < 2 || sy1 - sy0 < 2) out = cv.img3(nw, rows);
  else {
    const cw = sx1 - sx0, ch = sy1 - sy0;
    const tw = ds < 0.999 ? Math.max(2, Math.round(cw * ds)) : cw, th = ds < 0.999 ? Math.max(2, Math.round(ch * ds)) : ch;
    const src = await need(job, port, [sx0, sy0, cw, ch], tw, th);
    let img = { w: tw, h: th, c: 3, d: new Float32Array(tw * th * 3) };
    const u = src.rgba;
    for (let i = 0, j = 0; i < tw * th; i++, j += 4) { img.d[i * 3] = u[j] / 255; img.d[i * 3 + 1] = u[j + 1] / 255; img.d[i * 3 + 2] = u[j + 2] / 255; }
    const fx = tw / cw, fy = th / ch;
    const roi = [sx0 * fx, sy0 * fy, W * fx, H * fy];
    sr._ref_w = W * fx;
    if (P.skin) sr._skin_stats = P.skin;
    if (hasRetouch(s.retouch)) img = applyRetouch(img, s.retouch, { roi, faces: P.faces, personFn: P.personFn, faceInfos: P.faceInfos, xvPhoto: P.photo, xvRef: xvRefDims(W, H) });
    img = E.adjustA(img, sr, { roi, personFn: P.personFn || null });
    if (s.nr_lum) {
      if (P.noise == null) {
        const Y = cv.img1(img.w, img.h);
        for (let i = 0; i < Y.d.length; i++) Y.d[i] = 0.299 * img.d[i * 3] + 0.587 * img.d[i * 3 + 1] + 0.114 * img.d[i * 3 + 2];
        P.noise = E.noiseSigma(Y);
      }
      sr._noise_sigma = P.noise;
    }
    img = E.adjustB(img, sr, fx, roi);
    const q = (p, s0, f) => (p - s0 + 0.5) * f - 0.5;
    if (ca) {
      const cx = (W - 1) / 2, cy = (H - 1) / 2;
      out = cv.img3(nw, rows);
      [[0, ca[0]], [1, 1], [2, ca[1]]].forEach(([c, f]) => {
        const mx = new Float32Array(n), my = new Float32Array(n);
        for (let i = 0; i < n; i++) { mx[i] = q(cx + (px[i] - cx) * f, sx0, fx); my[i] = q(cy + (py[i] - cy) * f, sy0, fy); }
        const r = cv.remapLinear(img, mx, my, nw, rows, c).d;
        for (let i = 0; i < n; i++) out.d[i * 3 + c] = r[i];
      });
    } else {
      for (let i = 0; i < n; i++) { px[i] = q(px[i], sx0, fx); py[i] = q(py[i], sy0, fy); }
      out = cv.remapLinear(img, px, py, nw, rows);
    }
  }
  // vùng ngoài ảnh khi "cắt ra ngoài"
  if (G.valid) {
    const [vx0, vy0, vx1, vy1] = G.valid;
    for (let y = 0; y < rows; y++) {
      const gy = (oy0 + y + 0.5) / ds - 0.5;
      for (let x = 0; x < nw; x++) {
        const gx = (ox0 + x + 0.5) / ds - 0.5;
        if (!(gx >= vx0 - 0.5 && gx < vx1 - 0.5 && gy >= vy0 - 0.5 && gy < vy1 - 0.5)) { const j = (y * nw + x) * 3; out.d[j] = out.d[j + 1] = out.d[j + 2] = 0; }
      }
    }
  }
  return out;
}

async function run(m, port) {
  const job = m.job;
  jobs[job] = {};
  const P = prep(m);
  await xvPrepare(job, port, P);          // xoá vật thể: có đủ kết quả AI trước khi dựng các dải
  const { s, W, G } = P;
  const OW = G.w, OH = G.h;
  const le = m.opts.long_edge | 0;
  const ds = le && Math.max(OW, OH) > le ? le / Math.max(OW, OH) : 1;
  const nw = Math.max(1, Math.round(OW * ds)), nh = Math.max(1, Math.round(OH * ds));
  port.postMessage({ type: 'export_size', job, w: nw, h: nh });
  // chờ lớp phủ (watermark / chân ảnh) do luồng chính vẽ đúng cỡ
  const ov = await new Promise((res) => { jobs[job].wait = res; });
  const enc = new JpegEncoder(nw, nh + (ov.footer ? ov.footer.h : 0), m.opts.quality || 92);
  port.postMessage({ type: 'export_chunk', job, bytes: enc.header() });
  // dải cao hơn khi lề lớn (đỡ dựng lặp phần chồng mép), nhưng không quá 512 hàng để giữ bộ nhớ thấp
  const BAND = Math.max(256, Math.min(512, Math.ceil(E.roiMargin(s, W) * 1.5 * ds / 8) * 8));
  for (let oy0 = 0; oy0 < nh; oy0 += BAND) {
    const rows = Math.min(BAND, nh - oy0), n = nw * rows;
    const out = await renderRect(job, port, P, ds, 0, oy0, nw, rows);
    const u8 = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) { const v = out.d[i]; u8[i] = Math.floor((v < 0 ? 0 : v > 1 ? 1 : v) * 255 + 0.5); }
    if (ov.wm) blendMark(u8, nw, oy0, rows, ov.wm);
    port.postMessage({ type: 'export_chunk', job, bytes: enc.addRows(u8, rows), progress: (oy0 + rows) / nh });
  }
  if (ov.footer) {
    const f = ov.footer;
    for (let y0 = 0; y0 < f.h; y0 += 64) {
      const rows = Math.min(64, f.h - y0);
      port.postMessage({ type: 'export_chunk', job, bytes: enc.addRows(f.rgba.subarray(y0 * f.w * 4, (y0 + rows) * f.w * 4), rows, 4) });
    }
  }
  port.postMessage({ type: 'export_chunk', job, bytes: enc.finish() });
  port.postMessage({ type: 'export_done', job, w: nw, h: nh + (ov.footer ? ov.footer.h : 0) });
  delete jobs[job];
}

// phóng 1:1: m.rect = [x0, y0, x1, y1] trong ảnh ra cỡ gốc, m.ds = tỉ lệ dựng (≤ 1)
async function runRoi(m, port) {
  const job = m.job;
  jobs[job] = {};
  const P = prep(m);
  await xvPrepare(job, port, P);
  const ds = Math.min(1, m.ds || 1);
  const [x0, y0, x1, y1] = m.rect;
  const ox0 = Math.floor(x0 * ds), oy0 = Math.floor(y0 * ds);
  const nw = Math.max(1, Math.round((x1 - x0) * ds)), rows = Math.max(1, Math.round((y1 - y0) * ds));
  const out = await renderRect(job, port, P, ds, ox0, oy0, nw, rows);
  const n = nw * rows, rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const v = out.d[i * 3 + c]; rgba[i * 4 + c] = Math.floor((v < 0 ? 0 : v > 1 ? 1 : v) * 255 + 0.5); }
    rgba[i * 4 + 3] = 255;
  }
  port.postMessage({ type: 'roi_done', job, rgba, w: nw, h: rows, ox: ox0 / ds, oy: oy0 / ds, ds }, [rgba.buffer]);
  delete jobs[job];
}

// trộn dấu (RGBA, alpha đã gồm độ mờ) vào dải ảnh
function blendMark(u8, w, oy0, rows, wm) {
  for (let y = 0; y < wm.h; y++) {
    const yy = wm.y + y - oy0;
    if (yy < 0 || yy >= rows) continue;
    for (let x = 0; x < wm.w; x++) {
      const xx = wm.x + x;
      if (xx < 0 || xx >= w) continue;
      const s = (y * wm.w + x) * 4, a = wm.rgba[s + 3] / 255;
      if (!a) continue;
      const d = (yy * w + xx) * 3;
      for (let c = 0; c < 3; c++) u8[d + c] = Math.round(u8[d + c] * (1 - a) + wm.rgba[s + c] * a);
    }
  }
}
