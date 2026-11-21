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
  const rowBuf = new Float64Array(dw * c);
  const acc = new Float64Array(dw * c);
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
    for (let t = 0; t < xt.length; t++) {
      const [dx, sxx, alpha] = xt[t];
      const so = ro + sxx * c, dO = dx * c;
      for (let ch = 0; ch < c; ch++) rowBuf[dO + ch] += im.d[so + ch] * alpha;
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

// ---------------------------------------------------------------- thống kê
export function percentile(arr, q) {
  const a = Float64Array.from(arr).sort();
  if (!a.length) return 0;
  const pos = (a.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export function median(arr) { return percentile(arr, 50); }
