// Các phép xử lý ảnh cơ bản, chép đúng cách tính của OpenCV mà PUM máy tính dùng
// (GaussianBlur, blur hộp, resize INTER_AREA / INTER_LINEAR, remap, HSV, YCrCb, Lab).
// Ảnh 3 kênh: Float32Array xen kẽ RGB (w*h*3); ảnh 1 kênh: Float32Array (w*h).

const FLT_EPS = 1.1920929e-7;

export function img3(w, h, d) { return { w, h, c: 3, d: d || new Float32Array(w * h * 3) }; }
export function img1(w, h, d) { return { w, h, c: 1, d: d || new Float32Array(w * h) }; }
export function clone(im) { return { w: im.w, h: im.h, c: im.c, d: new Float32Array(im.d) }; }

// chỉ số phản chiếu kiểu BORDER_REFLECT_101 (mặc định của OpenCV cho lọc)
function r101(i, n) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * n - 2 - i;
  }
  return i;
}
// BORDER_REFLECT (dùng cho remap / warpAffine của PUM)
function rfl(i, n) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i - 1;
    if (i >= n) i = 2 * n - i - 1;
  }
  return i;
}
export { r101 as border101, rfl as borderReflect };

export function gaussKernel(sigma) {
  let ks = Math.round(sigma * 8 + 1) | 1;   // OpenCV: cvRound(sigma*4*2+1)|1 cho ảnh số thực
  if (ks < 1) ks = 1;
  const k = new Float64Array(ks), c = (ks - 1) / 2;
  let s = 0;
  const s2 = -0.5 / (sigma * sigma);
  for (let i = 0; i < ks; i++) { const x = i - c; k[i] = Math.exp(x * x * s2); s += k[i]; }
  for (let i = 0; i < ks; i++) k[i] /= s;
  return k;
}

// lọc tách trục với nhân k cho ảnh nc kênh
function sepFilter(src, w, h, nc, kx, ky) {
  const tmp = new Float32Array(w * h * nc), out = new Float32Array(w * h * nc);
  const rx = (kx.length - 1) >> 1, ry = (ky.length - 1) >> 1;
  // ngang
  const idx = new Int32Array(w + 2 * rx);
  for (let i = -rx; i < w + rx; i++) idx[i + rx] = r101(i, w);
  for (let y = 0; y < h; y++) {
    const row = y * w * nc;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < nc; c++) {
        let s = 0;
        for (let t = 0; t < kx.length; t++) s += kx[t] * src[row + idx[x + t] * nc + c];
        tmp[row + x * nc + c] = s;
      }
    }
  }
  // dọc
  const W = w * nc;
  const acc = new Float64Array(W);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let t = 0; t < ky.length; t++) {
      const yy = r101(y + t - ry, h) * W, kv = ky[t];
      for (let i = 0; i < W; i++) acc[i] += kv * tmp[yy + i];
    }
    const o = y * W;
    for (let i = 0; i < W; i++) out[o + i] = acc[i];
  }
  return out;
}

// FAST = true khi dựng bản nháp lúc đang kéo thanh: Gauss bán kính lớn thay bằng 3 lần lọc hộp (gần đúng, nhanh hơn
// nhiều). Ảnh xem trước khi thả tay và ảnh xuất luôn dùng Gauss chính xác như OpenCV.
export const opts = { FAST: false };
export function gaussianBlur(im, sigma) {
  if (opts.FAST && sigma > 2.5) {
    const wIdeal = Math.sqrt(12 * sigma * sigma / 3 + 1);
    const r = Math.max(1, Math.round((wIdeal - 1) / 2));
    let o = { w: im.w, h: im.h, c: im.c, d: im.d };
    for (let i = 0; i < 3; i++) o = { w: im.w, h: im.h, c: im.c, d: boxSep(o.d, im.w, im.h, im.c, r) };
    return o;
  }
  const k = gaussKernel(sigma);
  return { w: im.w, h: im.h, c: im.c, d: sepFilter(im.d, im.w, im.h, im.c, k, k) };
}

// cv2.blur (hộp chuẩn hoá, BORDER_REFLECT_101)
export function boxBlur(im, r) {
  const n = 2 * r + 1;
  const k = new Float64Array(n).fill(1 / n);
  return { w: im.w, h: im.h, c: im.c, d: boxSep(im.d, im.w, im.h, im.c, r) };
}
function boxSep(src, w, h, nc, r) {
  // tổng chạy (nhanh với bán kính lớn), kết quả giống lọc hộp
  const n = 2 * r + 1, inv = 1 / n;
  const tmp = new Float32Array(w * h * nc), out = new Float32Array(w * h * nc);
  const idx = new Int32Array(w + 2 * r + 1);
  for (let i = -r; i <= w + r; i++) idx[i + r] = r101(i, w);
  for (let y = 0; y < h; y++) {
    const row = y * w * nc;
    for (let c = 0; c < nc; c++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += src[row + idx[t + r] * nc + c];
      for (let x = 0; x < w; x++) {
        tmp[row + x * nc + c] = s * inv;
        s += src[row + idx[x + r + 1 + r] * nc + c] - src[row + idx[x - r + r] * nc + c];
      }
    }
  }
  const W = w * nc;
  const yi = new Int32Array(h + 2 * r + 1);
  for (let i = -r; i <= h + r; i++) yi[i + r] = r101(i, h);
  const acc = new Float64Array(W);
  for (let t = -r; t <= r; t++) { const o = yi[t + r] * W; for (let i = 0; i < W; i++) acc[i] += tmp[o + i]; }
  for (let y = 0; y < h; y++) {
    const o = y * W;
    for (let i = 0; i < W; i++) out[o + i] = acc[i] * inv;
    const a = yi[y + r + 1 + r] * W, b = yi[y - r + r] * W;
    for (let i = 0; i < W; i++) acc[i] += tmp[a + i] - tmp[b + i];
  }
  return out;
}

// bảng trọng số INTER_AREA (giống computeResizeAreaTab của OpenCV)
function areaTab(ssize, dsize, scale) {
  const tab = [];
  for (let dx = 0; dx < dsize; dx++) {
    const fsx1 = dx * scale, fsx2 = fsx1 + scale;
    const cellW = Math.min(scale, ssize - fsx1);
    let sx1 = Math.ceil(fsx1), sx2 = Math.floor(fsx2);
    sx2 = Math.min(sx2, ssize - 1); sx1 = Math.min(sx1, sx2);
    if (sx1 - fsx1 > 1e-3) tab.push([dx, sx1 - 1, (sx1 - fsx1) / cellW]);
    for (let sx = sx1; sx < sx2; sx++) tab.push([dx, sx, 1.0 / cellW]);
    if (fsx2 - sx2 > 1e-3) tab.push([dx, sx2, Math.min(Math.min(fsx2 - sx2, 1.0), cellW) / cellW]);
  }
  return tab;
}

export function resizeArea(im, dw, dh) {
  const { w, h, c } = im;
  if (dw === w && dh === h) return clone(im);
  const sx = w / dw, sy = h / dh;
  const out = new Float32Array(dw * dh * c);
  // hệ số nguyên: trung bình ô vuông
  const isx = Math.round(sx), isy = Math.round(sy);
  if (Math.abs(sx - isx) < 1e-9 && Math.abs(sy - isy) < 1e-9 && isx >= 1 && isy >= 1 && dw * isx <= w && dh * isy <= h) {
    const area = 1 / (isx * isy);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) for (let ch = 0; ch < c; ch++) {
      let s = 0;
      for (let j = 0; j < isy; j++) { const o = ((y * isy + j) * w + x * isx) * c + ch; for (let i = 0; i < isx; i++) s += im.d[o + i * c]; }
      out[(y * dw + x) * c + ch] = s * area;
    }
    return { w: dw, h: dh, c, d: out };
  }
  const xt = areaTab(w, dw, sx), yt = areaTab(h, dh, sy);
  const nx = xt.length, XD = new Int32Array(nx), XS = new Int32Array(nx), XA = new Float64Array(nx);
  for (let t = 0; t < nx; t++) { XD[t] = xt[t][0] * c; XS[t] = xt[t][1] * c; XA[t] = xt[t][2]; }
  const rowBuf = new Float64Array(dw * c);
  const acc = new Float64Array(dw * c);
  const src = im.d;
  let cur = 0;
  acc.fill(0);
  for (let k = 0; k < yt.length; k++) {
    const [dy, syy, beta] = yt[k];
    if (dy !== cur) {
      const o = cur * dw * c;
      for (let i = 0; i < dw * c; i++) out[o + i] = acc[i];
      acc.fill(0); cur = dy;
    }
    rowBuf.fill(0);
    const ro = syy * w * c;
    if (c === 1) for (let t = 0; t < nx; t++) rowBuf[XD[t]] += src[ro + XS[t]] * XA[t];
    else for (let t = 0; t < nx; t++) {
      const so = ro + XS[t], dO = XD[t], alpha = XA[t];
      for (let ch = 0; ch < c; ch++) rowBuf[dO + ch] += src[so + ch] * alpha;
    }
    for (let i = 0; i < dw * c; i++) acc[i] += rowBuf[i] * beta;
  }
  { const o = cur * dw * c; for (let i = 0; i < dw * c; i++) out[o + i] = acc[i]; }
  return { w: dw, h: dh, c, d: out };
}

export function resizeLinear(im, dw, dh) {
  const { w, h, c } = im;
  const out = new Float32Array(dw * dh * c);
  const sx = w / dw, sy = h / dh;
  const x0 = new Int32Array(dw), x1 = new Int32Array(dw), fx = new Float32Array(dw);
  for (let x = 0; x < dw; x++) {
    let f = (x + 0.5) * sx - 0.5, i = Math.floor(f); f -= i;
    if (i < 0) { i = 0; f = 0; }
    if (i >= w - 1) { i = w - 1; f = 0; }
    x0[x] = i; x1[x] = Math.min(i + 1, w - 1); fx[x] = f;
  }
  for (let y = 0; y < dh; y++) {
    let f = (y + 0.5) * sy - 0.5, j = Math.floor(f); f -= j;
    if (j < 0) { j = 0; f = 0; }
    if (j >= h - 1) { j = h - 1; f = 0; }
    const j1 = Math.min(j + 1, h - 1);
    const r0 = j * w * c, r1 = j1 * w * c, o = y * dw * c;
    for (let x = 0; x < dw; x++) {
      const a = x0[x] * c, b = x1[x] * c, t = fx[x];
      for (let ch = 0; ch < c; ch++) {
        const top = im.d[r0 + a + ch] * (1 - t) + im.d[r0 + b + ch] * t;
        const bot = im.d[r1 + a + ch] * (1 - t) + im.d[r1 + b + ch] * t;
        out[o + x * c + ch] = top * (1 - f) + bot * f;
      }
    }
  }
  return { w: dw, h: dh, c, d: out };
}

// remap song tuyến, toạ độ lượng tử 1/32 điểm ảnh như OpenCV, viền BORDER_REFLECT
export function remapLinear(im, mapx, mapy, ow, oh, channel) {
  const { w, h, c } = im;
  const one = channel != null;
  const oc = one ? 1 : c;
  const out = new Float32Array(ow * oh * oc);
  const n = ow * oh;
  for (let p = 0; p < n; p++) {
    const X = Math.round(mapx[p] * 32), Y = Math.round(mapy[p] * 32);
    const xi = X >> 5, yi = Y >> 5, ax = (X & 31) / 32, ay = (Y & 31) / 32;
    let xa = xi, xb = xi + 1, ya = yi, yb = yi + 1;
    if (xa < 0 || xb >= w) { xa = rfl(xa, w); xb = rfl(xb, w); }
    if (ya < 0 || yb >= h) { ya = rfl(ya, h); yb = rfl(yb, h); }
    const w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay), w10 = (1 - ax) * ay, w11 = ax * ay;
    const i00 = (ya * w + xa) * c, i01 = (ya * w + xb) * c, i10 = (yb * w + xa) * c, i11 = (yb * w + xb) * c;
    if (one) {
      const ch = channel;
      out[p] = im.d[i00 + ch] * w00 + im.d[i01 + ch] * w01 + im.d[i10 + ch] * w10 + im.d[i11 + ch] * w11;
    } else {
      const o = p * c;
      for (let ch = 0; ch < c; ch++)
        out[o + ch] = im.d[i00 + ch] * w00 + im.d[i01 + ch] * w01 + im.d[i10 + ch] * w10 + im.d[i11 + ch] * w11;
    }
  }
  return { w: ow, h: oh, c: oc, d: out };
}

// ---------------------------------------------------------------- không gian màu (OpenCV, số thực)
export function rgb2hsv(r, g, b, out) {
  const v = Math.max(r, g, b), mn = Math.min(r, g, b);
  let diff = v - mn;
  const s = diff / (Math.abs(v) + FLT_EPS);
  diff = 60 / (diff + FLT_EPS);
  let hh;
  if (v === r) hh = (g - b) * diff;
  else if (v === g) hh = (b - r) * diff + 120;
  else hh = (r - g) * diff + 240;
  if (hh < 0) hh += 360;
  out[0] = hh; out[1] = s; out[2] = v;
}
export function hsv2rgb(hh, s, v, out) {
  if (s === 0) { out[0] = out[1] = out[2] = v; return; }
  let h = hh * (6 / 360);
  if (h < 0) { do h += 6; while (h < 0); } else { while (h >= 6) h -= 6; }
  let sector = Math.floor(h);
  h -= sector;
  if (sector < 0 || sector >= 6) { sector = 0; h = 0; }
  const t0 = v, t1 = v * (1 - s), t2 = v * (1 - s * h), t3 = v * (1 - s * (1 - h));
  let r, g, b;
  switch (sector) {
    case 0: b = t1; g = t3; r = t0; break;
    case 1: b = t1; g = t0; r = t2; break;
    case 2: b = t3; g = t0; r = t1; break;
    case 3: b = t0; g = t2; r = t1; break;
    case 4: b = t0; g = t1; r = t3; break;
    default: b = t2; g = t1; r = t0;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

export function rgb2lab(r, g, b, out) {
  const lin = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  let X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456;
  let Y = 0.212671 * R + 0.715160 * G + 0.072169 * B;
  let Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  out[0] = Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}

// cv2.cvtColor(ảnh RGB số thực, COLOR_RGB2Lab) ĐÚNG như OpenCV: với sRGB, OpenCV không tính công thức mà tra bảng
// 33x33x33 số nguyên (LAB_BASE = 16384) rồi nội suy ba chiều với phần lẻ 1/16 ô (kết quả L bậc 100/16384, a, b bậc 1/64).
// Bảng tính lại bằng số thực double; LAB_FIX = [vị trí, lệch] những ô lệch 1 so với bảng softfloat của OpenCV
// (lấy từ chính cv2 tại các điểm lưới; đã thử 200 000 màu ngẫu nhiên: khớp tuyệt đối).
const LAB_FIX = [593, -1, 1142, 1, 1650, -1, 2343, -1, 4532, -1, 5540, -1, 5691, -1, 6088, -1, 6959, -1, 7031, -1, 7116, -1, 8704, -1,
  9032, -1, 9808, 1, 13083, -1, 13182, -1, 15153, -1, 15257, -1, 15369, 1, 15706, -1, 16145, 1, 18753, -1, 19301, -1, 21870, -1,
  22888, -1, 23538, -1, 24760, 1, 25588, 1, 26236, -1, 26243, 1, 26999, 1, 27523, 1, 28894, -1, 30423, 1, 31055, 1, 32416, -1,
  32451, -1, 34468, 1, 36814, 1, 38460, -1, 39205, -1, 40238, 1, 40611, -1, 40709, -1, 45703, 1, 46849, 1, 48557, 1, 49464, -1,
  49965, -1, 52062, -1, 53709, -1, 53832, -1, 54128, 1, 55237, -1, 57358, -1, 57849, -1, 58075, -1, 62056, -1, 62945, 1, 62949, -1,
  63835, -1, 66724, 1, 67075, 1, 68427, -1, 68446, 1, 68863, -1, 69983, 1, 70423, 1, 77166, -1, 77202, -1, 77662, -1, 78124, -1,
  78427, -1, 79208, 1, 79938, -1, 80116, -1, 80709, -1, 83251, -1, 83534, -1, 86298, -1, 90528, -1, 91394, 1, 91834, 1, 94424, 1,
  94510, 1, 95080, -1, 95467, -1, 100272, -1, 100670, -1, 101669, 1, 101799, 1, 103059, -1, 103295, 1, 104110, -1, 104689, -1,
  107507, 1];
let LAB_LUT = null;
function labLut() {
  if (LAB_LUT) return LAB_LUT;
  const D = 33, lut = new Int32Array(D * D * D * 3);
  const gam = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let bi = 0; bi < D; bi++) for (let gi = 0; gi < D; gi++) for (let ri = 0; ri < D; ri++) {
    const R = gam(ri / 32), G = gam(gi / 32), B = gam(bi / 32);
    const X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456, Y = 0.212671 * R + 0.715160 * G + 0.072169 * B;
    const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
    const FX = f(X), FY = f(Y), FZ = f(Z), o = ((bi * D + gi) * D + ri) * 3;
    lut[o] = roundEven(16384 * (Y > 0.008856 ? 116 * FY - 16 : 903.3 * Y) / 100);
    lut[o + 1] = roundEven(16384 * (500 * (FX - FY) + 128) / 256);
    lut[o + 2] = roundEven(16384 * (200 * (FY - FZ) + 128) / 256);
  }
  for (let i = 0; i < LAB_FIX.length; i += 2) lut[LAB_FIX[i]] += LAB_FIX[i + 1];
  LAB_LUT = lut;
  return lut;
}
export function rgb2labCv(r, g, b, out) {
  const lut = labLut();
  const ir = roundEven(Math.min(1, Math.max(0, r)) * 16384), ig = roundEven(Math.min(1, Math.max(0, g)) * 16384), ib = roundEven(Math.min(1, Math.max(0, b)) * 16384);
  const tr = ir >> 9, tg = ig >> 9, tb = ib >> 9, fr = (ir >> 5) & 15, fg = (ig >> 5) & 15, fb = (ib >> 5) & 15;
  let L = 0, A = 0, B = 0;
  for (let db = 0; db < 2; db++) {
    const wb = db ? fb : 16 - fb; if (!wb) continue;
    for (let dg = 0; dg < 2; dg++) {
      const wg = dg ? fg : 16 - fg; if (!wg) continue;
      for (let dr = 0; dr < 2; dr++) {
        const wr = dr ? fr : 16 - fr; if (!wr) continue;
        const o = (((tb + db) * 33 + tg + dg) * 33 + tr + dr) * 3, wt = wr * wg * wb;
        L += wt * lut[o]; A += wt * lut[o + 1]; B += wt * lut[o + 2];
      }
    }
  }
  out[0] = Math.fround(((L + 2048) >> 12) / 16384 * 100);
  out[1] = ((A + 2048) >> 12) / 64 - 128;
  out[2] = ((B + 2048) >> 12) / 64 - 128;
}

// ---------------------------------------------------------------- làm tròn kiểu Python round() / cvRound (nửa -> chẵn)
export function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ---------------------------------------------------------------- hình thái (giống cv2.erode / cv2.dilate / morphologyEx)
// Phần tử cấu trúc cv2.getStructuringElement(MORPH_ELLIPSE, (k, k)): nửa bề rộng của từng hàng.
export function ellipseRows(k) {
  const r = k >> 1, inv = r ? 1 / (r * r) : 0, hw = new Int32Array(k);
  for (let i = 0; i < k; i++) { const dy = i - r; hw[i] = roundEven(r * Math.sqrt((r * r - dy * dy) * inv)); }
  return hw;
}
// cực trị chạy theo hàng (van Herk / Gil-Werman), cửa sổ [x-hh, x+hh], điểm ngoài ảnh bỏ qua
function runExt(src, off, w, x0, x1, hh, isMax, P, G, S, out) {
  const ow = x1 - x0;
  if (hh === 0) { for (let x = 0; x < ow; x++) out[x] = src[off + x0 + x]; return; }
  const n = ow + 2 * hh, b = 2 * hh + 1, pad = isMax ? -Infinity : Infinity;
  for (let j = 0; j < n; j++) { const x = x0 - hh + j; P[j] = x >= 0 && x < w ? src[off + x] : pad; }
  if (isMax) {
    for (let j = 0, c = 0; j < n; j++, c++) { if (c === b) c = 0; const v = P[j]; G[j] = c === 0 || v > G[j - 1] ? v : G[j - 1]; }
    for (let j = n - 1; j >= 0; j--) { const v = P[j]; S[j] = j === n - 1 || (j + 1) % b === 0 || v > S[j + 1] ? v : S[j + 1]; }
    for (let x = 0; x < ow; x++) { const a = S[x], c = G[x + 2 * hh]; out[x] = a > c ? a : c; }
  } else {
    for (let j = 0, c = 0; j < n; j++, c++) { if (c === b) c = 0; const v = P[j]; G[j] = c === 0 || v < G[j - 1] ? v : G[j - 1]; }
    for (let j = n - 1; j >= 0; j--) { const v = P[j]; S[j] = j === n - 1 || (j + 1) % b === 0 || v < S[j + 1] ? v : S[j + 1]; }
    for (let x = 0; x < ow; x++) { const a = S[x], c = G[x + 2 * hh]; out[x] = a < c ? a : c; }
  }
}
// giãn (isMax) / co với ellipse k x k, viền như OpenCV mặc định (điểm ngoài ảnh không tính).
// box = [y0, y1, x0, x1]: chỉ tính trong khung (đọc điểm quanh đó từ cả ảnh -> trong khung y hệt tính cả ảnh);
// ngoài khung giữ nguyên src. Kết quả cùng kiểu mảng với src.
export function morphEllipse(src, w, h, k, isMax, box) {
  const [y0, y1, x0, x1] = box || [0, h, 0, w];
  const out = new src.constructor(src);
  if (y1 <= y0 || x1 <= x0) return out;
  const r = k >> 1, hw = ellipseRows(k), ow = x1 - x0, oh = y1 - y0;
  let mh = 0; for (const v of hw) mh = Math.max(mh, v);
  const acc = new Float32Array(ow * oh).fill(isMax ? -Infinity : Infinity);
  const tmp = new Float32Array(ow), P = new Float32Array(ow + 2 * mh), G = new Float32Array(ow + 2 * mh), S = new Float32Array(ow + 2 * mh);
  for (const hh of new Set(hw)) {
    const dys = []; for (let i = 0; i < k; i++) if (hw[i] === hh) dys.push(i - r);
    const sy0 = Math.max(0, y0 + Math.min(...dys)), sy1 = Math.min(h, y1 + Math.max(...dys));
    for (let sy = sy0; sy < sy1; sy++) {
      runExt(src, sy * w, w, x0, x1, hh, isMax, P, G, S, tmp);
      for (const dy of dys) {
        const y = sy - dy; if (y < y0 || y >= y1) continue;
        const o = (y - y0) * ow;
        if (isMax) { for (let x = 0; x < ow; x++) if (tmp[x] > acc[o + x]) acc[o + x] = tmp[x]; }
        else { for (let x = 0; x < ow; x++) if (tmp[x] < acc[o + x]) acc[o + x] = tmp[x]; }
      }
    }
  }
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) out[(y + y0) * w + x + x0] = acc[y * ow + x];
  return out;
}
const growBox = (box, m, w, h) => [Math.max(0, box[0] - m), Math.min(h, box[1] + m), Math.max(0, box[2] - m), Math.min(w, box[3] + m)];
// MORPH_OPEN (co rồi giãn) / MORPH_CLOSE (giãn rồi co), ellipse k x k
export function morphOpen(src, w, h, k, box) {
  const b = box || [0, h, 0, w];
  return morphEllipse(morphEllipse(src, w, h, k, false, growBox(b, k >> 1, w, h)), w, h, k, true, b);
}
export function morphClose(src, w, h, k, box) {
  const b = box || [0, h, 0, w];
  return morphEllipse(morphEllipse(src, w, h, k, true, growBox(b, k >> 1, w, h)), w, h, k, false, b);
}

// ---------------------------------------------------------------- cv2.distanceTransform(m, DIST_L2, 3)
// Khoảng cách tới điểm 0 gần nhất cho mọi điểm khác 0, mặt nạ 3x3 (0.955 / 1.3693) cộng dồn số thực 32 bit như bản
// IPP mà OpenCV máy tính dùng; không có điểm 0 nào -> FLT_MAX.
const DT_A = Math.fround(0.955), DT_B = Math.fround(1.3693), FLT_MAX = 3.4028234663852886e38;
export function distL2(mask, w, h) {
  const d = new Float32Array(w * h), f = Math.fround;
  let anyZero = false;
  for (let i = 0; i < d.length; i++) { if (mask[i]) d[i] = Infinity; else anyZero = true; }
  if (!anyZero) return d.fill(FLT_MAX);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      if (!mask[i]) continue;
      let t = d[i];
      if (x > 0) { const v = f(d[i - 1] + DT_A); if (v < t) t = v; }
      if (y > 0) {
        const u = i - w;
        let v = f(d[u] + DT_A); if (v < t) t = v;
        if (x > 0) { v = f(d[u - 1] + DT_B); if (v < t) t = v; }
        if (x < w - 1) { v = f(d[u + 1] + DT_B); if (v < t) t = v; }
      }
      d[i] = t;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const o = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = o + x;
      if (!mask[i]) continue;
      let t = d[i];
      if (x < w - 1) { const v = f(d[i + 1] + DT_A); if (v < t) t = v; }
      if (y < h - 1) {
        const u = i + w;
        let v = f(d[u] + DT_A); if (v < t) t = v;
        if (x > 0) { v = f(d[u - 1] + DT_B); if (v < t) t = v; }
        if (x < w - 1) { v = f(d[u + 1] + DT_B); if (v < t) t = v; }
      }
      d[i] = t;
    }
  }
  return d;
}

// ---------------------------------------------------------------- vẽ (giống cv2.line nét 1 / fillConvexPoly)
// các điểm của đoạn thẳng 8-liên thông (LineIterator, vẽ trái -> phải)
export function linePoints(x0, y0, x1, y1) {
  if (x1 < x0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
  let dx = x1 - x0, dy = y1 - y0, sx = 1, sy = 1;
  if (dy < 0) { dy = -dy; sy = -1; }
  const vert = dy > dx;
  if (vert) { [dx, dy] = [dy, dx]; }
  let err = dx - 2 * dy, x = x0, y = y0;
  const pts = [];
  for (let i = 0; i <= dx; i++) {
    pts.push([x, y]);
    const mask = err < 0;
    err += -2 * dy + (mask ? 2 * dx : 0);
    if (vert) { y += sy; if (mask) x += sx; } else { x += sx; if (mask) y += sy; }
  }
  return pts;
}
// bao lồi (đã tô kín) của mặt nạ: cv2.convexHull(cv2.findNonZero(m)) + cv2.fillConvexPoly
export function hullFill(m, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1;
    for (let x = 0, o = y * w; x < w; x++) if (m[o + x]) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a, y]); if (b !== a) pts.push([b, y]); }
  }
  const out = new Uint8Array(w * h);
  if (pts.length < 3) return out;
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const v = lo.slice(0, -1).concat(up.slice(0, -1));
  if (v.length < 3) {               // mọi điểm thẳng hàng: chỉ còn đường viền
    for (let i = 0; i < v.length; i++) for (const [x, y] of linePoints(...v[i], ...v[(i + 1) % v.length])) out[y * w + x] = 1;
    return out;
  }
  fillConvex(out, w, h, v);
  return out;
}
// FillConvexPoly của OpenCV (shift = 0, LINE_8): vẽ viền bằng Line rồi tô từng hàng theo cạnh số nguyên điểm cố định
function fillConvex(img, w, h, v) {
  const XY_SHIFT = 16, XY_ONE = 65536, half = XY_ONE >> 1, npts = v.length;
  const sh = (a) => Math.floor(a / XY_ONE);
  let imin = 0, ymin = v[0][1], ymax = v[0][1], xmin = v[0][0], xmax = v[0][0];
  let p0 = v[npts - 1];
  for (let i = 0; i < npts; i++) {
    const p = v[i];
    if (p[1] < ymin) { ymin = p[1]; imin = i; }
    ymax = Math.max(ymax, p[1]); xmax = Math.max(xmax, p[0]); xmin = Math.min(xmin, p[0]);
    for (const [x, y] of linePoints(p0[0], p0[1], p[0], p[1])) if (x >= 0 && y >= 0 && x < w && y < h) img[y * w + x] = 1;
    p0 = p;
  }
  if (xmax < 0 || ymax < 0 || xmin >= w || ymin >= h) return;
  ymax = Math.min(ymax, h - 1);
  const edge = [{ idx: imin, di: 1, x: -XY_ONE, dx: 0, ye: ymin }, { idx: imin, di: npts - 1, x: -XY_ONE, dx: 0, ye: ymin }];
  let edges = npts, y = ymin;
  do {
    for (let i = 0; i < 2; i++) {
      const e = edge[i];
      if (y >= e.ye) {
        let idx0 = e.idx, idx = idx0 + e.di;
        if (idx >= npts) idx -= npts;
        for (; edges-- > 0;) {
          const ty = v[idx][1];
          if (ty > y) {
            const xs = v[idx0][0] * XY_ONE, xe = v[idx][0] * XY_ONE;
            e.ye = ty;
            e.dx = Math.trunc(((xe - xs) * 2 + (ty - y)) / (2 * (ty - y)));
            e.x = xs; e.idx = idx;
            break;
          }
          idx0 = idx; idx += e.di;
          if (idx >= npts) idx -= npts;
        }
      }
    }
    if (edges < 0) break;
    if (y >= 0) {
      let l = 0, r = 1;
      if (edge[0].x > edge[1].x) { l = 1; r = 0; }
      let xx1 = sh(edge[l].x + half), xx2 = sh(edge[r].x + half);
      if (xx2 >= 0 && xx1 < w) {
        if (xx1 < 0) xx1 = 0;
        if (xx2 >= w) xx2 = w - 1;
        img.fill(1, y * w + xx1, y * w + xx2 + 1);
      }
    }
    edge[0].x += edge[0].dx; edge[1].x += edge[1].dx;
  } while (++y <= ymax);
}

// ---------------------------------------------------------------- lọc
// cv2.Sobel 3x3 (CV_32F, BORDER_REFLECT_101): độ lớn gradient sqrt(gx² + gy²), chỉ trong box (ngoài = 0)
export function sobelMag(src, w, h, box) {
  const [y0, y1, x0, x1] = box || [0, h, 0, w];
  const out = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) {
    const ym = r101(y - 1, h) * w, yc = y * w, yp = r101(y + 1, h) * w;
    for (let x = x0; x < x1; x++) {
      const xm = r101(x - 1, w), xp = r101(x + 1, w);
      const gx = src[ym + xp] + 2 * src[yc + xp] + src[yp + xp] - src[ym + xm] - 2 * src[yc + xm] - src[yp + xm];
      const gy = src[yp + xm] + 2 * src[yp + x] + src[yp + xp] - src[ym + xm] - 2 * src[ym + x] - src[ym + xp];
      out[yc + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

// cv2.bilateralFilter(src, d=0, sigmaColor, sigmaSpace) cho ảnh 1 kênh số thực: bán kính cvRound(1.5·sigmaSpace),
// cửa sổ tròn, BORDER_REFLECT_101, trọng số màu từ bảng exp 4096 ô theo khoảng min..max CỦA CẢ ẢNH (như OpenCV).
// box: chỉ tính trong khung (ngoài khung giữ nguyên src) — trong khung y hệt tính cả ảnh; mask: chỉ tính ở điểm khác 0.
export function bilateral(src, w, h, sigmaColor, sigmaSpace, box, mask) {
  const [y0, y1, x0, x1] = box || [0, h, 0, w];
  const out = Float32Array.from(src);
  if (y1 <= y0 || x1 <= x0) return out;
  const sc = sigmaColor > 0 ? sigmaColor : 1, ss = sigmaSpace > 0 ? sigmaSpace : 1;
  const radius = Math.max(1, roundEven(ss * 1.5));
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < src.length; i++) { const v = src[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (Math.abs(mn - mx) < FLT_EPS) return out;
  const nb = 4096, len = Math.fround(mx - mn), scale = Math.fround(nb / len), gc = -0.5 / (sc * sc), gs = -0.5 / (ss * ss);
  const lut = new Float32Array(nb + 2), dl = new Float64Array(nb + 1);
  for (let i = 0, last = 1; i < nb + 2; i++) {
    if (last > 0) { const v = Math.fround(i / scale); lut[i] = Math.exp(v * v * gc); last = lut[i]; } else lut[i] = 0;
  }
  for (let i = 0; i <= nb; i++) dl[i] = lut[i + 1] - lut[i];
  // ảnh đệm quanh khung (phản chiếu theo viền ẢNH), đã nhân sẵn scale (chỉ số bảng = |chênh|)
  const pw = x1 - x0 + 2 * radius, ph = y1 - y0 + 2 * radius, pad = new Float64Array(pw * ph);
  const xi = new Int32Array(pw); for (let j = 0; j < pw; j++) xi[j] = r101(x0 - radius + j, w);
  for (let j = 0; j < ph; j++) { const sy = r101(y0 - radius + j, h) * w, o = j * pw; for (let i = 0; i < pw; i++) pad[o + i] = src[sy + xi[i]] * scale; }
  const ofs = [], sw = [];
  for (let i = -radius; i <= radius; i++) for (let j = -radius; j <= radius; j++) {
    const r = Math.sqrt(i * i + j * j);
    if (r > radius || (i === 0 && j === 0)) continue;
    ofs.push(i * pw + j); sw.push(Math.fround(Math.exp(r * r * gs)));
  }
  const K = ofs.length, OF = Int32Array.from(ofs), SW = Float64Array.from(sw), LU = Float64Array.from(lut);
  for (let y = y0; y < y1; y++) {
    const po = (y - y0 + radius) * pw + radius, oo = y * w;
    for (let x = x0; x < x1; x++) {
      if (mask && !mask[oo + x]) continue;
      const c = po + x - x0, v0 = pad[c];
      let s = 0, ws = 0;
      for (let k = 0; k < K; k++) {
        const v = pad[c + OF[k]];
        let a = v > v0 ? v - v0 : v0 - v;
        const id = a | 0; a -= id;
        const wt = SW[k] * (LU[id] + a * dl[id]);
        ws += wt; s += v * wt;
      }
      out[oo + x] = (s / scale + src[y * w + x]) / (ws + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- thống kê
export function percentile(arr, q) {
  const a = Float64Array.from(arr).sort();
  if (!a.length) return 0;
  const pos = (a.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export function median(arr) { return percentile(arr, 50); }
