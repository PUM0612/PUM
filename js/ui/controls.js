// Thành phần giao diện cảm ứng: thanh trượt + ô số (SliderRow / NumField), nhóm thu gọn (Section), công tắc...
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const fmt = (v, dec) => {
  const s = Number(v).toFixed(dec);
  return (dec ? s : String(Math.round(v))).replace('-0', '0');
};

// SliderRow: nhãn + ô số (gõ được) + nút −/+ + thanh trượt; chạm đúp nhãn / thanh để đặt lại
export class Slider {
  constructor(app, o) {
    this.app = app; this.o = Object.assign({ step: 1, dec: 0, def: 0 }, o);
    const { label, lo, hi, step } = this.o;
    this.num = h('input', { class: 'num', type: 'text', inputmode: 'decimal', enterkeyhint: 'done' });
    this.range = h('input', { type: 'range', min: lo, max: hi, step: step });
    if (o.gradient) this.range.style.setProperty('--trk', `linear-gradient(90deg, ${o.gradient.join(',')})`);
    this.lb = h('span', { class: 'lb' }, label);
    this.why = h('div', { class: 'why' });
    this.el = h('div', { class: 'sl' },
      h('div', { class: 'sl-top' }, this.lb,
        h('button', { class: 'pm', onclick: () => this.nudge(-1) }, '−'), this.num,
        h('button', { class: 'pm', onclick: () => this.nudge(1) }, '+')),
      this.range, this.why);
    let dragging = false;
    this.range.addEventListener('pointerdown', () => { dragging = true; app.begin(label); });
    this.range.addEventListener('input', () => {
      if (!dragging) { dragging = true; app.begin(label); }
      const v = +this.range.value;
      this.num.value = fmt(v, this.o.dec);
      this.o.set(v, true);
      this.mark();
      if (this.o.dep && !this._warned) { const why = this.o.dep(); if (why) { app.toast(why); this._warned = true; } }
    });
    const end = () => { this._warned = false; if (dragging) { dragging = false; app.end(); } };
    this.range.addEventListener('change', end);
    this.range.addEventListener('pointerup', end);
    this.range.addEventListener('pointercancel', end);
    this.num.addEventListener('focus', () => this.num.select());
    this.num.addEventListener('change', () => this.typed());
    this.num.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.num.blur(); });
    let last = 0;
    const dbl = (e) => {
      const t = Date.now();
      if (t - last < 320) { e.preventDefault(); this.reset(); last = 0; } else last = t;
    };
    this.lb.addEventListener('pointerup', dbl);
    this.range.addEventListener('dblclick', () => this.reset());
  }
  typed() {
    let v = parseFloat(String(this.num.value).replace(',', '.'));
    if (!isFinite(v)) { this.sync(); return; }
    v = Math.max(this.o.lo, Math.min(this.o.hi, v));
    this.app.begin(this.o.label); this.o.set(v, false); this.app.end(); this.sync();
  }
  nudge(k) {
    const v = Math.max(this.o.lo, Math.min(this.o.hi, this.o.get() + k * this.o.step));
    this.app.begin(this.o.label); this.o.set(+v.toFixed(4), false); this.app.end(); this.sync();
  }
  reset() { this.app.begin('Đặt lại ' + this.o.label); this.o.set(this.o.def, false); this.app.end(); this.sync(); }
  mark() { this.lb.classList.toggle('ch', Math.abs(+this.range.value - this.o.def) > 1e-9); }
  sync() {
    const v = this.o.get();
    if (document.activeElement !== this.num) this.num.value = fmt(v, this.o.dec);
    this.range.value = v;
    this.mark();
    if (this.o.dep) {
      const why = this.o.dep();
      this.el.classList.toggle('dim', !!why);
      this.why.textContent = why || '';
    }
  }
}

export class Section {
  constructor(app, title, o = {}) {
    this.body = h('div', { class: 'sec-b' });
    const head = h('div', { class: 'sec-h' }, h('span', { class: 't', onclick: () => this.el.classList.toggle('closed') }, title));
    if (o.auto) head.append(h('button', { onclick: (e) => { e.stopPropagation(); o.auto(); } }, 'Auto'));
    if (o.reset) head.append(h('button', { onclick: (e) => { e.stopPropagation(); o.reset(); } }, '↺'));
    this.el = h('div', { class: 'sec' + (o.closed ? ' closed' : '') }, head, this.body);
  }
  add(...els) { for (const e of els) this.body.append(e.el || e); return this; }
}

export function toggle(label, get, set) {
  const inp = h('input', { type: 'checkbox' });
  inp.addEventListener('change', () => set(inp.checked));
  const el = h('div', { class: 'row' }, h('label', { class: 'grow' }, label), h('label', { class: 'sw' }, inp, h('span')));
  return { el, sync: () => { inp.checked = !!get(); } };
}

export function select(label, options, get, set) {
  const sel = h('select', { class: 'grow' }, ...options.map(([v, t]) => h('option', { value: v }, t)));
  sel.addEventListener('change', () => set(sel.value));
  const el = h('div', { class: 'row' }, h('label', {}, label), sel);
  return { el, sel, sync: () => { sel.value = String(get()); } };
}

export const hint = (t) => h('div', { class: 'hint' }, t);
export const btn = (t, fn, cls) => h('button', { class: cls || '', onclick: fn }, t);
