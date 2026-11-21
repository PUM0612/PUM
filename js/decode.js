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

let LibRawMod = null;
async function decodeRaw(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  try {
    if (!LibRawMod) LibRawMod = (await import('../vendor/libraw-wasm-1.6.0/index.js')).default;
    const raw = new LibRawMod();
    try {
      // giống rawpy.postprocess(use_camera_wb=True) của PUM máy tính
      await raw.open(buf.slice(), { useCameraWb: true, userQual: 3, outputBps: 16, outputColor: 1 });
      const im = await raw.imageData();
      if (!im || !im.data) throw new Error('LibRaw không trả ảnh');
      return { src: new ArraySource(im.width, im.height, im.data, im.colors || 3, im.bits || 16), raw: true };
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
