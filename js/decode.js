// Giải mã ảnh trên iPhone: JPG / PNG / HEIC (Safari tự giải mã, xoay theo EXIF) và RAW (LibRaw WebAssembly,
// cùng cách giải mã như rawpy của PUM máy tính: cân bằng trắng của máy ảnh, nội suy AHD, sRGB).
// Trả về "nguồn ảnh" có region(sx, sy, sw, sh, tw, th) -> RGBA, để không cần canvas cỡ gốc (Safari giới hạn ~16,7 MP).
const RAW_EXT = ['dng', 'arw', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'pef', 'srw', 'srf', 'sr2', '3fr', 'iiq', 'erf', 'kdc', 'mrw', 'crw', 'x3f'];
export const isRawName = (n) => RAW_EXT.includes(String(n || '').split('.').pop().toLowerCase());

function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// nguồn là ImageBitmap (JPG / HEIC / PNG)
class BitmapSource {
  constructor(bmp) { this.bmp = bmp; this.width = bmp.width; this.height = bmp.height; }
  region(sx, sy, sw, sh, tw, th) {
    let src = this.bmp, cx = sx, cy = sy, cw = sw, ch = sh, tmp = null;
    while (cw > tw * 2.2 && ch > th * 2.2) {          // thu nhỏ nhiều bước cho mịn
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      const c = mkCanvas(nw, nh), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, cx, cy, cw, ch, 0, 0, nw, nh);
      if (tmp) { tmp.width = 0; tmp.height = 0; }
      tmp = c; src = c; cx = 0; cy = 0; cw = nw; ch = nh;
    }
    const c = mkCanvas(tw, th), x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, cx, cy, cw, ch, 0, 0, tw, th);
    const d = x.getImageData(0, 0, tw, th).data;
    if (tmp) { tmp.width = 0; tmp.height = 0; }
    c.width = 0; c.height = 0;
    return d;
  }
  close() { if (this.bmp.close) this.bmp.close(); }
}

// nguồn là mảng điểm ảnh (RAW đã giải mã), 8 hoặc 16 bit, 3 kênh
class ArraySource {
  // lut (tuỳ chọn, ảnh 16 bit): 3 x 65536 giá trị 0..255 — đường cong từng kênh (ProRAW khớp theo ảnh Apple nhúng)
  constructor(w, h, data, colors = 3, bits = 8, lut = null) { this.width = w; this.height = h; this.d = data; this.c = colors; this.bits = bits; this.lut = lut; }
  region(sx, sy, sw, sh, tw, th) {
    const out = new Uint8ClampedArray(tw * th * 4), d = this.d, C = this.c, W = this.width, L = this.lut;
    const k = this.bits > 8 ? 255 / 65535 : 1;
    const fx = sw / tw, fy = sh / th;
    for (let y = 0; y < th; y++) {
      const y0 = sy + Math.floor(y * fy), y1 = Math.max(y0 + 1, sy + Math.floor((y + 1) * fy));
      for (let x = 0; x < tw; x++) {
        const x0 = sx + Math.floor(x * fx), x1 = Math.max(x0 + 1, sx + Math.floor((x + 1) * fx));
        let r = 0, g = 0, b = 0, n = 0;
        if (L) {
          // qua đường cong TỪNG điểm rồi mới lấy trung bình (giống bản máy tính: áp đường cong rồi thu nhỏ)
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
            const i = (yy * W + xx) * C; r += L[d[i]]; g += L[65536 + d[i + 1]]; b += L[131072 + d[i + 2]]; n++;
          }
          const o = (y * tw + x) * 4;
          out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;     // Uint8ClampedArray tự làm tròn
          continue;
        }
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const i = (yy * W + xx) * C; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        const o = (y * tw + x) * 4;
        out[o] = r / n * k + 0.5; out[o + 1] = g / n * k + 0.5; out[o + 2] = b / n * k + 0.5; out[o + 3] = 255;
      }
    }
    return out;
  }
  close() { this.d = null; }
}

async function bitmapOf(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* thử cách khác */ }
  try { return await createImageBitmap(blob); } catch (e) { /* thử cách khác */ }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally { URL.revokeObjectURL(url); }
}

// Các ảnh JPEG thường (không phải mảnh dữ liệu RAW nén lossless) nhúng trong tệp, kèm cỡ đọc từ khung SOF:
// [{ st, w, h }], lớn trước. ProRAW nén dữ liệu RAW thành nhiều mảnh JPEG lossless (SOF3): bỏ qua.
function embeddedJpegs(buf) {
  const out = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xFF || buf[i + 1] !== 0xD8 || buf[i + 2] !== 0xFF) continue;
    let p = i + 2, info = null;
    for (let guard = 0; guard < 64 && p + 9 < buf.length; guard++) {
      if (buf[p] !== 0xFF) break;
      const mk = buf[p + 1];
      if (mk === 0xD8 || (mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { p += 2; continue; }
      const len = (buf[p + 2] << 8) | buf[p + 3];
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
        if (mk !== 0xC3 && mk !== 0xC7 && mk !== 0xCB && mk !== 0xCF) info = { st: i, h: (buf[p + 5] << 8) | buf[p + 6], w: (buf[p + 7] << 8) | buf[p + 8] };
        break;
      }
      if (len < 2) break;
      p += 2 + len;
    }
    if (info && info.w > 0 && info.h > 0) { out.push(info); i = p; }
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h);
}

// ảnh JPEG lớn nhất nhúng trong tệp RAW (ImageBitmap)
async function rawEmbedded(buf) {
  for (const c of embeddedJpegs(buf).slice(0, 4)) {
    try { return await bitmapOf(new Blob([buf.subarray(c.st)], { type: 'image/jpeg' })); } catch (e) { /* thử ảnh kế */ }
  }
  return rawEmbeddedOld(buf);
}

// Đường cong TỪNG KÊNH để phân bố sáng / màu của ảnh RAW (16 bit) khớp ảnh mẫu (JPEG Apple đã chỉnh, 8 bit) —
// khớp histogram (cùng công thức với engine._match_lut của PUM máy tính).
// src: Uint16Array RGB w x h (lấy mẫu hàng chẵn, cột chẵn); ref: RGBA 8 bit (mọi điểm). Trả Float32Array 3 x 65536 (0..255).
export function matchLut(src, w, h, ref) {
  const lut = new Float32Array(3 * 65536);
  for (let c = 0; c < 3; c++) {
    const hs = new Float64Array(65536), hr = new Float64Array(256);
    let ns = 0, nr = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { hs[src[(y * w + x) * 3 + c]]++; ns++; }
    for (let i = c; i < ref.length; i += 4) { hr[ref[i]]++; nr++; }
    const cr = new Float64Array(256);
    let a = 0;
    for (let j = 0; j < 256; j++) { a += hr[j]; cr[j] = a / nr; }
    let cum = 0, j = 0;
    for (let v = 0; v < 65536; v++) {
      cum += hs[v];
      const p = (cum - hs[v] / 2) / ns;          // phân vị giữa mức v
      while (j < 255 && cr[j] < p) j++;
      const lo = j > 0 ? cr[j - 1] : 0, hi = cr[j];
      const t = hi > lo ? (p - lo) / (hi - lo) : 1;
      lut[c * 65536 + v] = Math.min(255, Math.max(0, j - 1 + Math.min(1, Math.max(0, t))));
    }
  }
  return lut;
}

// dự phòng cũ: ảnh JPEG lớn nhất nhúng trong tệp RAW (thử giải mã từng chỗ bắt đầu JPEG)
async function rawEmbeddedOld(buf) {
  const cands = [];
  for (let i = 0; i < buf.length - 3; i++) if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) { cands.push(i); i += 1000; }
  let best = null;
  let end = -1;
  for (let j = buf.length - 2; j > 0; j--) if (buf[j] === 0xFF && buf[j + 1] === 0xD9) { end = j + 2; break; }
  for (const st of cands.slice(0, 12)) {
    if (end <= st) continue;
    try {
      const bmp = await bitmapOf(new Blob([buf.subarray(st, end)], { type: 'image/jpeg' }));
      if (!best || bmp.width * bmp.height > best.width * best.height) { if (best) best.close(); best = bmp; } else bmp.close();
    } catch (e) { /* không phải JPEG đầy đủ */ }
  }
  if (!best) throw new Error('chưa đọc được tệp RAW này trên iPhone');
  return best;
}

// Đọc nhanh phần đầu TIFF / DNG:
// - Make (hãng máy);
// - có phải DNG không;
// - cỡ ảnh chính (IFD có NewSubfileType = 0, ưu tiên DefaultCropSize).
export function tiffInfo(buf) {
  const info = { make: '', dng: false, w: 0, h: 0, baselineExposure: 0 };
  if (buf.length < 16) return info;
  const le = buf[0] === 0x49 && buf[1] === 0x49, be = buf[0] === 0x4d && buf[1] === 0x4d;
  if (!le && !be) return info;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) return info;
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const seen = new Set(), queue = [u32(4)];
  while (queue.length && seen.size < 32) {
    const off = queue.shift();
    if (!off || off + 2 > buf.length || seen.has(off)) continue;
    seen.add(off);
    const n = u16(off);
    let sub = null, w = 0, h = 0, cw = 0, ch = 0;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const bytes = (SZ[type] || 1) * cnt, vo = bytes <= 4 ? e + 8 : u32(e + 8);
      const val = (k) => (type === 3 ? u16(vo + 2 * k) : type === 5 ? u32(vo + 8 * k) / Math.max(1, u32(vo + 8 * k + 4))
        : type === 10 ? dv.getInt32(vo + 8 * k, le) / (dv.getInt32(vo + 8 * k + 4, le) || 1) : u32(vo + 4 * k));
      if (vo + bytes > buf.length) continue;
      if (tag === 271 && type === 2) info.make = new TextDecoder().decode(buf.subarray(vo, vo + cnt)).replace(/\0.*$/s, '').trim();
      else if (tag === 50706) info.dng = true;
      else if (tag === 50730 && (type === 5 || type === 10)) info.baselineExposure = val(0);
      else if (tag === 254) sub = val(0);
      else if (tag === 256) w = val(0);
      else if (tag === 257) h = val(0);
      else if (tag === 50720 && cnt >= 2) { cw = val(0); ch = val(1); }
      else if (tag === 330) for (let k = 0; k < cnt; k++) queue.push(val(k));
    }
    if (sub === 0 && (cw || w) * (ch || h) > info.w * info.h) { info.w = Math.round(cw || w); info.h = Math.round(ch || h); }
    const next = off + 2 + n * 12;
    if (next + 4 <= buf.length) queue.push(u32(next));
  }
  return info;
}

// ISO của ảnh (library.read_iso của PUM máy tính): thẻ 0x8827 trong Exif IFD — RAW kiểu TIFF (ARW, NEF, DNG, CR2...)
// hoặc JPEG (APP1 "Exif"). Không đọc được -> null.
export function readIso(buf) {
  try {
    let base = 0;
    if (buf[0] === 0xFF && buf[1] === 0xD8) {          // JPEG: tìm APP1 Exif
      let p = 2;
      base = -1;
      while (p + 4 < buf.length && buf[p] === 0xFF) {
        const mk = buf[p + 1], len = (buf[p + 2] << 8) | buf[p + 3];
        if (mk === 0xE1 && buf[p + 4] === 0x45 && buf[p + 5] === 0x78 && buf[p + 6] === 0x69 && buf[p + 7] === 0x66) { base = p + 10; break; }
        if (mk === 0xDA || len < 2) break;
        p += 2 + len;
      }
      if (base < 0) return null;
    }
    const le = buf[base] === 0x49 && buf[base + 1] === 0x49, be = buf[base] === 0x4d && buf[base + 1] === 0x4d;
    if (!le && !be) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u16 = (o) => dv.getUint16(base + o, le), u32 = (o) => dv.getUint32(base + o, le);
    const ifd = (off) => {
      const out = {};
      if (base + off + 2 > buf.length) return out;
      for (let i = 0, n = u16(off); i < n; i++) {
        const p = off + 2 + 12 * i;
        if (base + p + 12 > buf.length) break;
        out[u16(p)] = [u16(p + 2), p + 8];
      }
      return out;
    };
    const top = ifd(u32(4));
    if (!top[0x8769]) return null;
    const ex = ifd(u32(top[0x8769][1]));
    if (!ex[0x8827]) return null;
    const [typ, p] = ex[0x8827];
    const v = typ === 3 ? u16(p) : u32(p);
    return v || null;
  } catch (e) { return null; }
}

let LibRawMod = null;
async function decodeRaw(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const iso = readIso(buf);
  // Ảnh RAW của iPhone (Apple ProRAW, .DNG): LibRaw bỏ qua độ phơi sáng gốc + đường cong tông / bản đồ sáng của Apple
  // nên ảnh ra tối gần một nửa (đo trên iPhone của người dùng: 70 so với 136 của app Ảnh). Cách làm, giống hệt
  // engine._decode_raw của PUM máy tính:
  // - vẫn giải mã RAW bằng LibRaw (đủ cỡ, 16 bit);
  // - rồi qua đường cong TỪNG kênh khớp phân bố sáng / màu của ảnh JPEG Apple đã chỉnh nhúng trong tệp;
  // - không có ảnh nhúng thì bù độ phơi sáng gốc (BaselineExposure).
  // RAW máy ảnh (Sony ARW, DJI DNG...) giải mã bằng LibRaw như cũ.
  const ti = tiffInfo(buf);
  const apple = ti.dng && /^apple/i.test(ti.make);
  let ref = null;
  if (apple) {
    try {
      const bm = await rawEmbedded(buf);
      const c = mkCanvas(bm.width, bm.height), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bm, 0, 0);
      ref = x.getImageData(0, 0, bm.width, bm.height).data;
      bm.close && bm.close(); c.width = 0; c.height = 0;
    } catch (e) { ref = null; }
  }
  try {
    if (!LibRawMod) LibRawMod = (await import('../vendor/libraw-wasm-1.6.0/index.js')).default;
    const raw = new LibRawMod();
    try {
      // giống rawpy.postprocess(use_camera_wb=True) của PUM máy tính; ProRAW không có ảnh nhúng: bù phơi sáng gốc
      // như engine._decode_raw (exp_shift = 2^BaselineExposure, giữ vùng sáng 0,8)
      const opt = { useCameraWb: true, userQual: 3, outputBps: 16, outputColor: 1 };
      if (apple && !ref) Object.assign(opt, { expCorrec: 1, expShift: Math.min(8, Math.max(0.25, 2 ** (ti.baselineExposure || 0))), expPreser: 0.8 });
      await raw.open(buf.slice(), opt);
      const im = await raw.imageData();
      if (!im || !im.data) throw new Error('LibRaw không trả ảnh');
      const lut = ref && (im.bits || 16) > 8 ? matchLut(im.data, im.width, im.height, ref) : null;
      return { src: new ArraySource(im.width, im.height, im.data, im.colors || 3, im.bits || 16, lut), raw: true, libraw: true, apple, appleLut: !!lut, iso };
    } finally { raw.dispose(); }
  } catch (e) {
    console.warn('LibRaw lỗi, dùng ảnh xem trước nhúng:', e);
    return { src: new BitmapSource(await rawEmbedded(buf)), rawPreview: true, iso };
  }
}

// cho bài kiểm tra (kiemtra/doi_chieu_proraw.py)
export const _t = { rawEmbedded, embeddedJpegs, ArraySource, matchLut };

// nhanh (cho thumbnail khi nhập): RAW dùng ảnh JPEG nhúng
export async function decodeQuick(blob, name) {
  name = name || blob.name || '';
  if (isRawName(name)) {
    try { return { src: new BitmapSource(await rawEmbedded(new Uint8Array(await blob.arrayBuffer()))), rawPreview: false }; } catch (e) { return decodeRaw(blob); }
  }
  return decodeFile(blob, name);
}

export async function decodeFile(blob, name) {
  name = name || blob.name || '';
  if (isRawName(name)) return decodeRaw(blob);
  let iso = null;
  try { iso = readIso(new Uint8Array(await blob.slice(0, 1 << 18).arrayBuffer())); } catch (e) { iso = null; }
  try { return { src: new BitmapSource(await bitmapOf(blob)), iso }; } catch (e) {
    if (/heic|heif/i.test(name + blob.type)) throw new Error('trình duyệt này không giải mã được HEIC (Safari trên iPhone giải mã được)');
    throw new Error('định dạng ảnh không hỗ trợ');
  }
}
