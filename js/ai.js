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

function canvasOf(rgba, w, h, maxSide) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  if (k >= 1) return c;
  const d = document.createElement('canvas');
  d.width = Math.max(1, Math.round(w * k)); d.height = Math.max(1, Math.round(h * k));
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
  const c = canvasOf(rgba, w, h, 1024);
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
  const res = face.detect(c);
  c.width = 0;
  const out = (res.faceLandmarks || []).map((pts) => {
    const a = new Float32Array(pts.length * 2);
    pts.forEach((q, i) => { a[i * 2] = q.x; a[i * 2 + 1] = q.y; });
    return a;
  });
  const mx = (a) => { let s = 0; for (let i = 0; i < a.length; i += 2) s += a[i]; return s / (a.length / 2); };
  out.sort((p, q) => mx(p) - mx(q));
  return out;
}
