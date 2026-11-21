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
  constructor(w, h, data, colors = 3, bits = 8) { this.width = w; this.height = h; this.d = data; this.c = colors; this.bits = bits; }
  region(sx, sy, sw, sh, tw, th) {
    const out = new Uint8ClampedArray(tw * th * 4), d = this.d, C = this.c, W = this.width;
    const k = this.bits > 8 ? 255 / 65535 : 1;
    const fx = sw / tw, fy = sh / th;
    for (let y = 0; y < th; y++) {
      const y0 = sy + Math.floor(y * fy), y1 = Math.max(y0 + 1, sy + Math.floor((y + 1) * fy));
      for (let x = 0; x < tw; x++) {
        const x0 = sx + Math.floor(x * fx), x1 = Math.max(x0 + 1, sx + Math.floor((x + 1) * fx));
        let r = 0, g = 0, b = 0, n = 0;
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

// dự phòng: ảnh JPEG lớn nhất nhúng trong tệp RAW
async function rawEmbedded(buf) {
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
  const info = { make: '', dng: false, w: 0, h: 0 };
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
      const val = (k) => (type === 3 ? u16(vo + 2 * k) : type === 5 ? u32(vo + 8 * k) / Math.max(1, u32(vo + 8 * k + 4)) : u32(vo + 4 * k));
      if (vo + bytes > buf.length) continue;
      if (tag === 271 && type === 2) info.make = new TextDecoder().decode(buf.subarray(vo, vo + cnt)).replace(/\0.*$/s, '').trim();
      else if (tag === 50706) info.dng = true;
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

let LibRawMod = null;
async function decodeRaw(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  // Ảnh RAW của iPhone (Apple ProRAW, .DNG): dùng bộ giải mã của Apple (Safari), như app Ảnh.
  // - ProRAW ghi kèm độ phơi sáng gốc + đường cong tông / bản đồ sáng của Apple.
  // - LibRaw bỏ qua phần đó nên ảnh ra tối gần một nửa (người dùng đo trên iPhone: 70 so với 136).
  // - RAW máy ảnh (Sony ARW...) vẫn giải mã bằng LibRaw như PUM máy tính.
  // - Safari chỉ trả ảnh nhỏ (không đủ cỡ) thì cũng dùng LibRaw.
  const ti = tiffInfo(buf);
  if (ti.dng && /^apple/i.test(ti.make)) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const want = Math.max(ti.w, ti.h);
      if (!want || Math.max(bmp.width, bmp.height) >= 0.9 * want) return { src: new BitmapSource(bmp), raw: true, apple: true };
      bmp.close();
    } catch (e) { /* Safari không giải mã được: dùng LibRaw */ }
  }
  try {
    if (!LibRawMod) LibRawMod = (await import('../vendor/libraw-wasm-1.6.0/index.js')).default;
    const raw = new LibRawMod();
    try {
      // giống rawpy.postprocess(use_camera_wb=True) của PUM máy tính
      await raw.open(buf.slice(), { useCameraWb: true, userQual: 3, outputBps: 16, outputColor: 1 });
      const im = await raw.imageData();
      if (!im || !im.data) throw new Error('LibRaw không trả ảnh');
      return { src: new ArraySource(im.width, im.height, im.data, im.colors || 3, im.bits || 16), raw: true, libraw: true };
    } finally { raw.dispose(); }
  } catch (e) {
    console.warn('LibRaw lỗi, dùng ảnh xem trước nhúng:', e);
    return { src: new BitmapSource(await rawEmbedded(buf)), rawPreview: true };
  }
}

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
  try { return { src: new BitmapSource(await bitmapOf(blob)) }; } catch (e) {
    if (/heic|heif/i.test(name + blob.type)) throw new Error('trình duyệt này không giải mã được HEIC (Safari trên iPhone giải mã được)');
    throw new Error('định dạng ảnh không hỗ trợ');
  }
}
