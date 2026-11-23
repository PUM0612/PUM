// Bộ thông số — ĐÚNG cấu trúc JSON của PUM máy tính (engine.default_settings) để style / thông số dùng chung.

export const BANDS = [
  ['red', 'Đỏ', 0, [225, 60, 60]],
  ['orange', 'Cam', 30, [240, 140, 40]],
  ['yellow', 'Vàng', 60, [235, 215, 50]],
  ['green', 'Lục', 120, [70, 190, 70]],
  ['aqua', 'Ngọc', 180, [50, 200, 200]],
  ['blue', 'Lam', 225, [60, 110, 230]],
  ['purple', 'Tím', 270, [150, 80, 220]],
  ['magenta', 'Hồng', 315, [220, 70, 180]],
];
export const CROPS = ['orig', '1:1', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16'];
export const SKIN_HUE = 25.0;
export const LAYER_ADJ = ['exposure', 'contrast', 'brightness', 'highlights', 'shadows', 'whites', 'blacks', 'temp',
  'tint', 'saturation', 'clarity', 'texture', 'dehaze'];

export function defaultPortrait() {
  return {
    impact: 100.0, who: 'all',
    blemish: 0.0, blemish_neck: true,
    dark_circles: 0.0,
    even: 0.0, even_texture: 0.0, even_neck: true,
    contour: 0.0, shine: 0.0,
    hair_outer: 0.0, hair_inner: 0.0, hair_dark: 0.0,
    teeth_bright: 0.0, teeth_desat: 0.0,
    iris_l: 0.0, iris_r: 0.0, sclera_l: 0.0, sclera_r: 0.0,
    lips: 0.0,
    body_even: 0.0, body_texture: 0.0,
    tone_target: 'all', tone_uniform: 0.0, tone_temp: 0.0, tone_tint: 0.0,
    tone_sat: 0.0, tone_light: 0.0, tone_preset: 'none', tone_pref: 0.0,
    cloth_wrinkle: 0.0, cloth_spots: 0.0, cloth_edges: 0.0,
    wrinkles: 0.0,
    face_slim: 0.0, vline: 0.0, eyes_big: 0.0, nose_slim: 0.0, body_slim: 0.0,
    blush: 0.0, brows: 0.0,
    protect: [],
  };
}

export function defaultSettings() {
  const ident = () => [[0.0, 0.0], [1.0, 1.0]];
  const color = {};
  for (const b of BANDS) color[b[0]] = [0.0, 0.0, 0.0];
  return {
    temp: 0.0, tint: 0.0,
    exposure: 0.0, contrast: 0.0, brightness: 0.0,
    highlights: 0.0, shadows: 0.0, whites: 0.0, blacks: 0.0,
    clarity: 0.0, dehaze: 0.0, vibrance: 0.0, saturation: 0.0,
    depth: 0.0,                 // Độ sâu màu: màu đậm thì sẫm + đầm lại (kiểu phim), âm = nhạt phấn
    film_color: 0.0,            // Đỏ đầm (phim): đỏ đậm mà SÁNG sẫm lại về đỉnh gam, giữ độ đậm
    color_ver: 2,               // 2 = dựng màu trong OkLCh (PUM 1.1.2)
    tone_ver: 2,                // 2 = Highlights âm là "vai phim" (PUM 1.1.2)
    curve: { rgb: ident(), r: ident(), g: ident(), b: ident(), luma: ident() },
    color,
    color_adv: [],
    skin: { hue: 0.0, sat: 0.0, lum: 0.0, uni_hue: 0.0, uni_sat: 0.0, uni_lum: 0.0 },
    sharpen: 0.0, sharpen_radius: 1.0,
    nr_lum: 0.0, nr_lum_detail: 50.0, nr_lum_contrast: 0.0,
    nr_color: 0.0, nr_color_detail: 50.0, nr_color_smooth: 50.0,
    texture: 0.0, grain: 0.0, grain_size: 25.0,
    vignette: 0.0,
    grading: {
      shadows: [0.0, 0.0, 0.0], midtones: [0.0, 0.0, 0.0],
      highlights: [0.0, 0.0, 0.0], global: [0.0, 0.0, 0.0],
      blend: 50.0, balance: 0.0,
    },
    lens: {
      distortion: 0.0, ca_red: 0.0, ca_blue: 0.0, vig_corr: 0.0,
      persp_v: 0.0, persp_h: 0.0, skew: 0.0, aspect: 0.0, scale: 100.0,
      kguides: [], kmat: null, kamount: 100.0,
    },
    flip: 'none', crop_outside: false,
    calib: {
      shadow_tint: 0.0, red_hue: 0.0, red_sat: 0.0, green_hue: 0.0, green_sat: 0.0,
      blue_hue: 0.0, blue_sat: 0.0,
    },
    rotate: 0, straighten: 0.0, crop: 'orig', crop_rect: null,
    retouch: {
      spots: [], areas: [], skin_strokes: [], skin_amount: 0.0,
      skin_texture: 50.0, skin_auto: false, portrait: defaultPortrait(),
    },
    layers: [],
  };
}

export function newLayer(name = 'Layer') {
  const adj = {};
  for (const k of LAYER_ADJ) adj[k] = 0.0;
  return {
    name, enabled: true, opacity: 100.0, invert: false,
    brush: [], linear: [], radial: [], person: false,
    luma_on: false, luma: [0.0, 100.0, 15.0],
    crange_on: false, crange: [25.0, 30.0, 20.0],
    adj,
  };
}

export const deepCopy = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepUpdate(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k in dst && isObj(dst[k]) && isObj(v)) deepUpdate(dst[k], v);
    else dst[k] = deepCopy(v);
  }
  return dst;
}

// so sánh sâu kiểu Python (==): số 0 và 0.0 bằng nhau, không tuỳ thứ tự khoá
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEq(a[k], b[k]));
  }
  return false;
}
const TONE_KEYS_V = ['temp', 'tint', 'exposure', 'contrast', 'brightness', 'highlights', 'shadows', 'whites', 'blacks',
  'clarity', 'dehaze', 'vibrance', 'saturation', 'depth', 'curve', 'color', 'color_adv', 'skin', 'grading', 'calib'];

export function mergeSettings(s) {
  const base = defaultSettings();
  if (s && Object.keys(s).length) {
    deepUpdate(base, s);
    base.layers = (base.layers || []).map((ly) => deepUpdate(newLayer(), ly));
    if (!('color_ver' in s)) {
      // ảnh chỉnh từ bản trước (màu dựng theo HSV): đã có chỉnh màu thì giữ cách dựng cũ để ảnh không đổi
      const old = !!(base.vibrance || base.saturation ||
        Object.values(base.color).some((v) => v.some((x) => Math.abs(x) > 1e-6)) ||
        Object.values(base.skin).some((v) => Math.abs(v) > 1e-6));
      base.color_ver = old ? 1 : 2;
    }
    if (!('tone_ver' in s)) {
      // ảnh đã chỉnh tông / màu ở bản trước: giữ cách dựng cũ (Highlights kiểu cũ, cuộn vùng sáng từng kênh)
      const d0 = defaultSettings();
      const old = TONE_KEYS_V.some((k) => !deepEq(base[k], d0[k])) || !!(base.layers && base.layers.length);
      base.tone_ver = old ? 1 : 2;
    }
  }
  return base;
}

export function isDefault(s) {
  return JSON.stringify(mergeSettings(s)) === JSON.stringify(defaultSettings());
}

// Áp style với độ mạnh 0..1 (engine.blend_style)
export function blendStyle(current, style, strength = 1.0, includeRetouch = false) {
  const cur = mergeSettings(current);
  const d = defaultSettings();
  const k = Number(strength);
  const mix = (dv, sv) => dv + (sv - dv) * k;
  for (const [key, sv] of Object.entries(style)) {
    if (key === 'retouch' || key === 'layers') { if (includeRetouch) cur[key] = deepCopy(sv); continue; }
    if (key === 'rotate' || key === 'crop') cur[key] = deepCopy(sv);
    else if (key === 'grading') {
      for (const [zone, v] of Object.entries(sv)) cur.grading[zone] = Array.isArray(v) ? [v[0], v[1] * k, v[2] * k] : v;
    } else if (key === 'lens') {
      for (const [lk, v] of Object.entries(sv))
        if (typeof v === 'number' && typeof d.lens[lk] === 'number') cur.lens[lk] = d.lens[lk] + (v - d.lens[lk]) * k;
    } else if (key === 'curve') {
      for (const [ch, pts] of Object.entries(sv)) cur.curve[ch] = pts.map(([x, y]) => [x, x + (y - x) * k]);
    } else if (key === 'color') {
      for (const [band, vals] of Object.entries(sv)) cur.color[band] = vals.map((v) => v * k);
    } else if (key === 'color_adv') {
      cur.color_adv = (sv || []).map((r) => ({ ...deepCopy(r), h: (r.h || 0) * k, s: (r.s || 0) * k, l: (r.l || 0) * k }));
    } else if (key === 'skin') {
      for (const [sk, v] of Object.entries(sv)) cur.skin[sk] = v * k;
    } else if (key === 'calib') {
      for (const [ck, v] of Object.entries(sv)) cur.calib[ck] = v * k;
    } else if (typeof sv === 'number' && key in d) cur[key] = mix(d[key], sv);
  }
  // style lưu từ bản trước (chưa có tone_ver) mà có kéo Highlights xuống: giữ cách kéo cũ cho đúng ý của style
  if (k > 0 && !('tone_ver' in style) && typeof style.highlights === 'number' && style.highlights < 0) cur.tone_ver = 1;
  return cur;
}

export function styleFromSettings(s, includeRetouch = false) {
  const st = mergeSettings(s);
  for (const k of ['straighten', 'crop_rect', 'flip', 'crop_outside']) delete st[k];
  delete st.lens.kguides; delete st.lens.kmat;
  if (!includeRetouch) { delete st.retouch; delete st.layers; }
  return st;
}

// style có sẵn (library.BUILTIN_STYLES)
export const BUILTIN_STYLES = {
  'Trong trẻo': { contrast: 15, clarity: 15, vibrance: 20, highlights: -20, shadows: 15, whites: 8 },
  'Ấm áp': { temp: 18, tint: 4, vibrance: 10, contrast: 8,
    skin: { uni_hue: 20, uni_sat: 15, hue: 0, sat: 0, lum: 5, uni_lum: 0 } },
  'Phim cổ điển': { contrast: -10, saturation: -15, temp: 10,
    curve: { rgb: [[0, 0.07], [0.25, 0.24], [0.75, 0.8], [1, 0.95]],
      b: [[0, 0.06], [1, 0.94]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]] } },
  'Đen trắng tương phản': { saturation: -100, contrast: 35, clarity: 20,
    curve: { rgb: [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } },
  'Da chân dung': { skin: { uni_hue: 45, uni_sat: 35, uni_lum: 30, lum: 8, hue: 0, sat: -5 }, clarity: -5, vibrance: 8 },
  'Xanh mát': { temp: -15, tint: -3, contrast: 10, vibrance: 15, color: { blue: [-10, 20, -5], aqua: [0, 15, 0] } },
  // PUM 1.1.2 (library.BUILTIN_STYLES, bản 5): học từ 85 ảnh "Bảng điều khiển Capture One"; dùng sau Cân bằng trắng
  // Tự động + Tự động. Đường cong Luma (vùng tối đen sâu như C1), Bão hoà +6, da giữ độ đậm và bớt vàng, Đỏ đầm 40.
  'Gu Capture One (Cơ bản)': {
    color_ver: 2, clarity: 10, film_color: 40, saturation: 6.0,
    curve: {
      rgb: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]],
      r: [[0, 0], [0.5, 0.509], [1, 1]], b: [[0, 0], [0.5, 0.483], [1, 1]],
      luma: [[0.0, 0.0], [0.03125, 0.027], [0.0625, 0.054], [0.09375, 0.0775], [0.125, 0.0938],
        [0.15625, 0.1614], [0.1875, 0.2248], [0.21875, 0.2727], [0.25, 0.317], [0.3125, 0.4032],
        [0.375, 0.4832], [0.4375, 0.5557], [0.5, 0.6221], [0.5625, 0.6848], [0.625, 0.7429],
        [0.6875, 0.7924], [0.75, 0.833], [0.8125, 0.8674], [0.875, 0.9014], [0.9375, 0.9519], [1.0, 1.0]] },
    color: { red: [1, 12, -7], orange: [-26, -37, 0], yellow: [3, 18, -3], green: [5, 11, -2],
      aqua: [8, 2, -8], blue: [8, 40, 17], purple: [0, 5, 40], magenta: [1, 1, 12] },
    skin: { hue: -4.0, sat: -5.0 } },   // chỉ 2 khoá này: không xoá "đều màu da" người dùng đã đặt
};

export function cropRatio(name) {
  if (name === 'orig' || !String(name).includes(':')) return null;
  const [a, b] = String(name).split(':');
  return parseFloat(a) / parseFloat(b);
}

export function lensActive(L) {
  return !!(L.distortion || L.ca_red || L.ca_blue || L.persp_v || L.persp_h || L.skew || L.aspect ||
    (L.kmat && (L.kamount ?? 100)) || Math.abs((L.scale ?? 100) / 100 - 1) > 1e-4);
}
export function layerActive(ly) {
  return (ly.enabled ?? true) && Object.values(ly.adj).some((v) => Math.abs(v) > 1e-6);
}
