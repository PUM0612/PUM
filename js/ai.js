// AI chạy ngay trên iPhone, không cần mạng (MediaPipe Tasks Vision bản web, chép trong vendor/):
// - Tách người (PoseLandmarker + mặt nạ) cho Layer "Chọn người" — như library.PersonSegmenter.
// - 478 điểm khuôn mặt (FaceLandmarker) cho chân dung — như library.FaceMesh.
const BASE = new URL('../vendor/mediapipe-tasks-vision-1.2.3/', import.meta.url).href;
const MODELS = new URL('../models/', import.meta.url).href;
let vision = null, fileset = null, pose = null, face = null;

async function lib() {
  if (!vision) vision = await import(BASE + 'vision_bundle.mjs');
  if (!fileset) fileset = await vision.FilesetResolver.forVisionTasks(BASE + 'wasm');
  return vision;
}

function canvasOf(rgba, w, h, maxSide, align = 1) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  // align: cỡ ảnh đưa vào AI là bội số của `align` (mặt nạ tách người với bề ngang lẻ làm MediaPipe web dừng hẳn:
  // "Check failed: 1 == ChannelSize()" — gặp với ảnh dọc 1067x1600 -> 683x1024)
  const tw = Math.max(align, Math.round(w * k / align) * align), th = Math.max(align, Math.round(h * k / align) * align);
  if (k >= 1 && tw === w && th === h) return c;
  const d = document.createElement('canvas');
  d.width = tw; d.height = th;
  const x = d.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, d.width, d.height);
  c.width = 0;
  return d;
}

// mặt nạ người 0..1 (độ phân giải ≤ 1024), chưa qua ngưỡng
export async function personMask(rgba, w, h) {
  const v = await lib();
  if (!pose) pose = await v.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODELS + 'pose_landmarker_full.task', delegate: 'CPU' },
    runningMode: 'IMAGE', numPoses: 6, outputSegmentationMasks: true });
  const c = canvasOf(rgba, w, h, 1024, 4);
  const res = pose.detect(c);
  const mw = c.width, mh = c.height, m = new Float32Array(mw * mh);
  for (const sm of res.segmentationMasks || []) {
    const a = sm.getAsFloat32Array();
    for (let i = 0; i < m.length; i++) if (a[i] > m[i]) m[i] = a[i];
    sm.close();
  }
  c.width = 0;
  return { w: mw, h: mh, d: m, n: (res.landmarks || []).length };
}

// tự lọc: khuôn mặt + độ nhắm mắt (blendshapes), như library.FaceAnalyzer
let blinkLm = null;
export async function faceBlinks(canvas) {
  const v = await lib();
  if (!blinkLm) blinkLm = await v.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODELS + 'face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE', numFaces: 10, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5 });
  const res = blinkLm.detect(canvas), W = canvas.width, H = canvas.height, out = [];
  (res.faceLandmarks || []).forEach((pts, i) => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const q of pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const sc = {};
    for (const c of ((res.faceBlendshapes || [])[i] || { categories: [] }).categories) sc[c.categoryName] = c.score;
    const bx = [Math.max(0, Math.trunc(x0 * W)), Math.max(0, Math.trunc(y0 * H)), Math.min(W, Math.trunc(x1 * W)), Math.min(H, Math.trunc(y1 * H))];
    out.push({ box: bx, size: Math.max(bx[2] - bx[0], bx[3] - bx[1]) / Math.max(W, H), blink: Math.min(sc.eyeBlinkLeft || 0, sc.eyeBlinkRight || 0) });
  });
  return out;
}

// danh sách khuôn mặt: mỗi mặt Float32Array(478*2) toạ độ chuẩn hoá, xếp trái -> phải
export async function faceLandmarks(rgba, w, h) {
  const v = await lib();
  if (!face) face = await v.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODELS + 'face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE', numFaces: 12, minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.45 });
  const c = canvasOf(rgba, w, h, 1800);
  const W = c.width, H = c.height;
  const found = detectTile(c, 0, 0, W, H, W, H, false);
  // Bộ dò mặt của mediapipe thu cả ảnh về 128 px: mặt nhỏ (ảnh đứng toàn thân, ảnh nhóm) bị bỏ sót.
  // Dò thêm trên các ô chồng nhau (mỗi ô ~1/2 rồi ~1/3 cạnh ngắn) để mặt trong ô đủ lớn (library.FaceMesh.landmarks).
  for (const frac of [0.5, 0.3]) {
    const s = Math.trunc(Math.min(H, W) * frac);
    if (s < 160) continue;
    const step = Math.max(1, Math.trunc(s / 2));
    const xs = [], ys = [];
    for (let x = 0; x <= Math.max(1, W - s); x += step) xs.push(x);
    for (let y = 0; y <= Math.max(1, H - s); y += step) ys.push(y);
    if (xs[xs.length - 1] + s < W) xs.push(W - s);
    if (ys[ys.length - 1] + s < H) ys.push(H - s);
    if (frac < 0.5 && xs.length * ys.length > 40) continue;
    for (const y0 of ys) for (const x0 of xs)
      for (const m of detectTile(c, x0, y0, s, s, W, H, true))
        if (!found.some((o) => sameFace(m, o))) found.push(m);
    if (found.length && frac === 0.5) break;          // ô 1/2 đã thấy mặt: khỏi dò ô nhỏ hơn (nhanh)
  }
  c.width = 0;
  const mx = (a) => { let s = 0; for (let i = 0; i < a.length; i += 2) s += a[i]; return s / (a.length / 2); };
  found.sort((p, q) => mx(p) - mx(q));
  return found;
}

// dò mặt trong ô (x0, y0, w, h) của canvas c; trả toạ độ chuẩn hoá theo CẢ ảnh (library.FaceMesh._detect)
function detectTile(c, x0, y0, w, h, W, H, edge) {
  let src = c;
  if (x0 || y0 || w !== W || h !== H) {
    src = document.createElement('canvas');
    src.width = w; src.height = h;
    src.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
  }
  let res;
  try { res = face.detect(src); } catch (e) { return []; } finally { if (src !== c) src.width = 0; }
  const out = [];
  for (const pts of res.faceLandmarks || []) {
    let mx0 = 1, my0 = 1, mx1 = 0, my1 = 0;
    for (const q of pts) { mx0 = Math.min(mx0, q.x); mx1 = Math.max(mx1, q.x); my0 = Math.min(my0, q.y); my1 = Math.max(my1, q.y); }
    // mặt bị mép ô cắt ngang (không phải mép ảnh): bỏ, ô kề bên sẽ thấy trọn
    if (edge && ((mx0 < 0.01 && x0 > 0) || (my0 < 0.01 && y0 > 0) || (mx1 > 0.99 && x0 + w < W) || (my1 > 0.99 && y0 + h < H))) continue;
    const a = new Float32Array(pts.length * 2);
    pts.forEach((q, i) => { a[i * 2] = (q.x * w + x0) / W; a[i * 2 + 1] = (q.y * h + y0) / H; });
    out.push(a);
  }
  return out;
}

function sameFace(m, o) {
  const st = (a) => { let sx = 0, sy = 0, lo = 1e9, hi = -1e9; const n = a.length / 2;
    for (let i = 0; i < a.length; i += 2) { sx += a[i]; sy += a[i + 1]; lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
    return [sx / n, sy / n, hi - lo]; };
  const [ax, ay, aw] = st(m), [bx, by, bw] = st(o);
  const r = Math.max(aw, bw, 1e-4);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by)) < 0.5 * r;
}
