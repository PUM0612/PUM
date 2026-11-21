// Luồng chạy mô hình AI Xoá vật thể: LaMa (big-lama, bản ONNX "lama_fp32.onnx" giống PUM máy tính).
// Thư viện onnxruntime-web 1.31.1, cùng phiên bản onnxruntime mà PUM máy tính dùng.
// Mô hình đọc từ Cache Storage (xoa_ai.js đã tải sẵn 5 phần), ghép lại rồi nạp một lần cho cả phiên.
//
// Ảnh vào / ra như xoa_vat.py _run:
// - image = ảnh * (1 - mặt nạ), cỡ [1, 3, 512, 512];
// - mask: cỡ [1, 1, 512, 512];
// - output 0..255 -> chia 255, cắt 0..1.
import * as ort from '../../vendor/onnxruntime-web-1.31.1/ort.wasm.min.mjs';

const VENDOR = new URL('../../vendor/onnxruntime-web-1.31.1/', import.meta.url).href;
ort.env.wasm.wasmPaths = VENDOR;
ort.env.wasm.proxy = false;
// nhiều luồng chỉ khi trang được "cô lập" (service worker gắn COOP / COEP); không thì 1 luồng.
// Dùng đủ số nhân (luồng chính chỉ chờ trong lúc AI chạy), ít nhất 2, nhiều nhất 4. iPhone X: 6 nhân (2 mạnh + 4 tiết
// kiệm điện).
const CORES = navigator.hardwareConcurrency || 0;
const THREADS = self.crossOriginIsolated ? Math.max(2, Math.min(4, CORES || 4)) : 1;
ort.env.wasm.numThreads = THREADS;
ort.env.logLevel = 'error';

const N = 512;
let sess = null, loadMs = 0;

async function readModel(m) {
  const buf = new Uint8Array(m.total);
  let o = 0;
  const cache = await caches.open(m.cache);
  for (const u of m.urls) {
    let r = await cache.match(u);
    if (!r) r = await fetch(u);
    if (!r || !r.ok) throw new Error('Thiếu tệp mô hình ' + u.split('/').pop());
    const b = new Uint8Array(await r.arrayBuffer());
    if (o + b.length > buf.length) throw new Error('Tệp mô hình sai cỡ');
    buf.set(b, o); o += b.length;
  }
  if (o !== buf.length) throw new Error('Tệp mô hình thiếu dữ liệu (' + o + ' / ' + buf.length + ' byte)');
  return buf;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      if (!sess) {
        const t0 = performance.now();
        let buf = await readModel(m);
        sess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        buf = null;
        loadMs = performance.now() - t0;
      }
      self.postMessage({ type: 'load', req: m.req, ms: loadMs, threads: THREADS, cores: CORES, coi: !!self.crossOriginIsolated });
    } else if (m.type === 'run') {
      if (!sess) throw new Error('Mô hình chưa nạp');
      const t0 = performance.now();
      const n = N * N, x = new Float32Array(3 * n), mk = new Float32Array(n), inp = m.inp, mm = m.m;
      for (let i = 0; i < n; i++) {
        const v = mm[i] ? 1 : 0, keep = Math.fround(1 - v);
        mk[i] = v;
        x[i] = Math.fround(inp[i * 3] * keep); x[n + i] = Math.fround(inp[i * 3 + 1] * keep); x[2 * n + i] = Math.fround(inp[i * 3 + 2] * keep);
      }
      const out = await sess.run({ image: new ort.Tensor('float32', x, [1, 3, N, N]), mask: new ort.Tensor('float32', mk, [1, 1, N, N]) });
      const o = out.output.data;
      const L = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
        const v = Math.fround(o[c * n + i] / 255);
        L[i * 3 + c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
      self.postMessage({ type: 'run', req: m.req, L, ms: performance.now() - t0 }, [L.buffer]);
    } else if (m.type === 'unload') {
      if (sess) { try { await sess.release(); } catch (e) { /* bỏ qua */ } }
      sess = null;
      self.postMessage({ type: 'unload', req: m.req });
    }
  } catch (e) {
    self.postMessage({ type: m.type, req: m.req, error: String((e && e.message) || e) });
  }
};
