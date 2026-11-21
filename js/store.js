// Lưu trữ trên iPhone (IndexedDB): ảnh gốc (bản chép), thông số chỉnh, thumbnail, style riêng, cài đặt xuất.
// Dữ liệu nằm trong bộ nhớ riêng của web app — cập nhật app KHÔNG làm mất. Có sao lưu / khôi phục ra tệp .json.
const DB = 'pum-iphone', VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('styles')) db.createObjectStore('styles', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
// Blob được lưu dạng ArrayBuffer (WebKit không cho lưu Blob vào IndexedDB ở một số chế độ — riêng tư, WebView)
const toRec = async (b) => (b ? { buf: await b.arrayBuffer(), type: b.type || '' } : null);
const toBlob = (r) => (r && r.buf ? new Blob([r.buf], { type: r.type }) : r || null);
const fixPhoto = (p) => {
  if (p && p.thumb && p.thumb.buf) { const rec = p.thumb; p.thumb = toBlob(rec); p._thumbRec = { blob: p.thumb, rec }; }
  return p;
};
export const store = {
  photos: async () => ((await tx('photos', 'readonly', (s) => s.getAll())) || []).map(fixPhoto),
  putPhoto: async (p) => {
    const rec = Object.assign({}, p);
    delete rec._url; delete rec._thumbRec;
    // thumbnail đổi sang ArrayBuffer một lần rồi giữ lại -> các lần lưu thông số sau ghi ngay, không phải chờ
    if (rec.thumb instanceof Blob) {
      if (!(p._thumbRec && p._thumbRec.blob === rec.thumb)) p._thumbRec = { blob: rec.thumb, rec: await toRec(rec.thumb) };
      rec.thumb = p._thumbRec.rec;
    }
    return tx('photos', 'readwrite', (s) => s.put(rec));
  },
  delPhotoOnly: (id) => tx('photos', 'readwrite', (s) => s.delete(id)),
  delFile: (id) => tx('files', 'readwrite', (s) => s.delete(id)),
  delPhoto: async (id) => { await tx('photos', 'readwrite', (s) => s.delete(id)); await tx('files', 'readwrite', (s) => s.delete(id)); },
  putFile: async (id, blob) => { const r = await toRec(blob); return tx('files', 'readwrite', (s) => s.put(r, id)); },
  getFile: async (id) => toBlob(await tx('files', 'readonly', (s) => s.get(id))),
  styles: () => tx('styles', 'readonly', (s) => s.getAll()),
  putStyle: (name, style) => tx('styles', 'readwrite', (s) => s.put({ name, style })),
  delStyle: (name) => tx('styles', 'readwrite', (s) => s.delete(name)),
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  async persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* bỏ qua */ } return false; },
};
