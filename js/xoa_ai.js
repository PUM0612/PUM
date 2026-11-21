// Mô hình AI Xoá vật thể trên iPhone (giống PUM máy tính: LaMa, lama_fp32.onnx 208 MB).
// - Chỉ tải khi người dùng đồng ý (lần đầu dùng Xoá vật thể), 5 phần ~42 MB.
// - Lưu trong Cache Storage tên AI_CACHE. Tên không bắt đầu bằng "pum-" nên service worker không xoá khi app cập nhật.
// - Có rồi thì chạy cả khi không có mạng.
// - Chạy ở luồng riêng js/workers/xoa_ai.worker.js; mỗi lần một ô 512 x 512, xếp hàng lần lượt.
const BASE = new URL('../models/lama/', import.meta.url).href;
const ORT = new URL('../vendor/onnxruntime-web-1.31.1/', import.meta.url).href;
const PARTS = [
  ['lama_fp32.onnx.1', 41608964], ['lama_fp32.onnx.2', 41608964], ['lama_fp32.onnx.3', 41608964],
  ['lama_fp32.onnx.4', 41608964], ['lama_fp32.onnx.5', 41608960],
].map(([n, s]) => [BASE + n, s]);
// thư viện chạy mô hình cũng tải cùng lúc (không nằm trong bộ đệm cài app -> người không dùng Xoá vật thể không phải tải)
const LIB = [['ort.wasm.min.mjs', 53725], ['ort-wasm-simd-threaded.mjs', 24738], ['ort-wasm-simd-threaded.wasm', 14848852]]
  .map(([n, s]) => [ORT + n, s]);
const FILES = [...LIB, ...PARTS];
export const MODEL_BYTES = FILES.reduce((s, p) => s + p[1], 0);          // 222 972 131 (mô hình 208 044 816)
export const AI_CACHE = 'ai-lama-fp32-v1';
const typeOk = (u, r) => !/\.(mjs|wasm)$/.test(u) || /javascript|wasm/.test(r.headers.get('Content-Type') || '');
const urlOf = (u) => u;

export class XoaAI {
  constructor() {
    this.state = 'unknown';          // 'none' (chưa tải) | 'downloading' | 'ready' (đã có trên máy) | 'error'
    this.worker = null;
    this.req = 0;
    this.pend = new Map();
    this.loaded = null;              // Promise nạp mô hình vào luồng AI
    this.chain = Promise.resolve();  // mỗi lần chạy một ô
    this.info = {};
  }

  async check() {
    try {
      const c = await caches.open(AI_CACHE);
      for (const [name, size] of FILES) {
        const r = await c.match(urlOf(name));
        if (!r || Number(r.headers.get('Content-Length') || size) !== size || !typeOk(name, r)) { this.state = 'none'; return false; }
      }
      this.state = 'ready';
      return true;
    } catch (e) { this.state = 'none'; return false; }
  }

  // số byte đã có trên máy (để tải tiếp phần còn thiếu)
  async have() {
    let n = 0;
    try {
      const c = await caches.open(AI_CACHE);
      for (const [name, size] of FILES) if (await c.match(urlOf(name))) n += size;
    } catch (e) { /* bỏ qua */ }
    return n;
  }

  // tải mô hình; onProg(byte đã có, tổng). Phần nào có rồi thì bỏ qua (tải tiếp được khi mất mạng giữa chừng)
  async download(onProg) {
    if (this.state === 'downloading') throw new Error('Đang tải mô hình');
    this.state = 'downloading';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate().catch(() => null);
        if (est && est.quota && est.usage != null && est.quota - est.usage < MODEL_BYTES - (await this.have()) + 20e6)
          throw new Error('iPhone không đủ chỗ trống cho mô hình AI (cần thêm khoảng ' + Math.ceil((MODEL_BYTES - (est.quota - est.usage)) / 1e6 + 20) + ' MB)');
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const c = await caches.open(AI_CACHE);
      let done = 0;
      for (const [name, size] of FILES) {
        const u = urlOf(name);
        const had = await c.match(u);
        if (had && typeOk(u, had)) { done += size; onProg && onProg(done, MODEL_BYTES); continue; }
        const res = await fetch(u, { cache: 'no-store' });
        if (!res.ok) throw new Error('Không tải được ' + name.split('/').pop() + ' (mã ' + res.status + ')');
        const rd = res.body.getReader(), chunks = [];
        let got = 0;
        for (;;) {
          const { done: end, value } = await rd.read();
          if (end) break;
          chunks.push(value); got += value.length;
          onProg && onProg(done + got, MODEL_BYTES);
        }
        if (got !== size) throw new Error('Tệp ' + name.split('/').pop() + ' tải về sai cỡ (' + got + ' / ' + size + ' byte)');
        // kiểu tệp đúng theo đuôi: .mjs phải là JavaScript (không thì không nạp được module), .wasm là application/wasm
        const type = /\.mjs$/.test(u) ? 'text/javascript' : /\.wasm$/.test(u) ? 'application/wasm' : 'application/octet-stream';
        await c.put(u, new Response(new Blob(chunks, { type }), { headers: { 'Content-Type': type, 'Content-Length': String(size) } }));
        done += size;
      }
      this.state = 'ready';
      return true;
    } catch (e) {
      this.state = (await this.have()) === MODEL_BYTES ? 'ready' : 'none';
      throw e;
    }
  }

  async removeModel() {
    this.stop();
    await caches.delete(AI_CACHE).catch(() => {});
    this.state = 'none';
  }

  stop() {
    if (this.worker) this.worker.terminate();
    this.worker = null; this.loaded = null;
    for (const p of this.pend.values()) p.rej(new Error('Đã dừng AI'));
    this.pend.clear();
  }

  call(type, data, transfer) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./workers/xoa_ai.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const m = e.data, p = this.pend.get(m.req);
        if (!p) return;
        this.pend.delete(m.req);
        if (m.error) p.rej(new Error(m.error)); else p.res(m);
      };
      this.worker.onerror = (e) => {
        const err = new Error('Luồng AI lỗi: ' + (e.message || 'không rõ (có thể hết bộ nhớ)'));
        for (const p of this.pend.values()) p.rej(err);
        this.pend.clear(); this.worker = null; this.loaded = null;
      };
    }
    const req = ++this.req;
    return new Promise((res, rej) => {
      this.pend.set(req, { res, rej });
      this.worker.postMessage(Object.assign({ type, req }, data), transfer || []);
    });
  }

  // nạp mô hình vào luồng AI (lần đầu vài giây tới vài chục giây tuỳ máy); gọi sẵn khi chọn công cụ Xoá
  warm() {
    if (this.state !== 'ready') return Promise.reject(new Error('Chưa tải mô hình AI'));
    if (!this.loaded) {
      this.loaded = this.call('load', { cache: AI_CACHE, urls: PARTS.map((p) => p[0]), total: PARTS.reduce((s, p) => s + p[1], 0) })
        .then((r) => { this.info = { loadMs: r.ms, threads: r.threads, coi: r.coi }; return r; })
        .catch((e) => { this.loaded = null; throw e; });
    }
    return this.loaded;
  }

  // inp: Float32Array 512*512*3 (0..1), m: Uint8Array 512*512 -> Float32Array 512*512*3 (0..1)
  run(inp, m) {
    const job = this.chain.then(async () => {
      await this.warm();
      const r = await this.call('run', { inp, m }, [inp.buffer, m.buffer]);
      this.info.lastMs = r.ms;
      return r.L;
    });
    this.chain = job.catch(() => {});
    return job;
  }
}
