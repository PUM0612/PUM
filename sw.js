// Service worker PUM iPhone — tạo tự động bởi tools/phat_hanh.py (đừng sửa tay).
// Đổi phiên bản (js/version.js) rồi chạy lại phat_hanh.py: iPhone tự tải bản mới ở lần mở kế tiếp.
// Gắn COOP / COEP vào mọi trang + tệp (GitHub Pages không cho đặt header): trang "cô lập" -> AI xoá vật thể chạy
// được nhiều luồng. Mô hình AI (models/lama/) không nằm trong bộ đệm này: app tự tải khi người dùng đồng ý và giữ ở
// bộ đệm riêng "ai-lama-..." (không bị xoá khi cập nhật app).
const CACHE = 'pum-1.1.2-6248563d';
const FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "js/ai.js",
  "js/app.js",
  "js/decode.js",
  "js/store.js",
  "js/version.js",
  "js/xoa_ai.js",
  "js/engine/auto.js",
  "js/engine/cv.js",
  "js/engine/engine.js",
  "js/engine/export.js",
  "js/engine/jpeg.js",
  "js/engine/layers.js",
  "js/engine/portrait.js",
  "js/engine/retouch.js",
  "js/engine/settings.js",
  "js/engine/xoa_vat.js",
  "js/ui/controls.js",
  "js/ui/export_ui.js",
  "js/ui/library.js",
  "js/ui/panels.js",
  "js/ui/scopes.js",
  "js/ui/viewer.js",
  "js/ui/widgets.js",
  "js/workers/render.worker.js",
  "js/workers/xoa_ai.worker.js",
  "css/app.css",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512-maskable.png",
  "icons/icon-512.png",
  "vendor/THU_VIEN.txt",
  "vendor/libraw-wasm-1.6.0/index.js",
  "vendor/libraw-wasm-1.6.0/libraw.js",
  "vendor/libraw-wasm-1.6.0/libraw.wasm",
  "vendor/libraw-wasm-1.6.0/package.json",
  "vendor/libraw-wasm-1.6.0/worker.js",
  "vendor/mediapipe-tasks-vision-1.2.3/package.json",
  "vendor/mediapipe-tasks-vision-1.2.3/vision_bundle.mjs",
  "vendor/mediapipe-tasks-vision-1.2.3/wasm/vision_wasm_internal.js",
  "vendor/mediapipe-tasks-vision-1.2.3/wasm/vision_wasm_internal.wasm",
  "models/face_landmarker.task",
  "models/pose_landmarker_full.task"
];
function coi(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('pum-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (new URL(req.url).pathname.includes('/models/lama/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)).then(coi));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
    return res;
  }).catch(() => caches.match('index.html'))).then(coi));
});
