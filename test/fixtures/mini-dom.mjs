// A small fake DOM for tests that run a screen's real code in a vm (js/core.js, js/ui.js and a
// screen file): elements with children, classes, styles, attributes, listeners and simple selectors
// ('.cls', 'tag', '.a.b'). Enough for sheets, button rows and stacks; layout is all zeros. Not a test
// itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('../..', import.meta.url).pathname;

class Node {
  constructor(tag) {
    this.tagName = String(tag || '#text').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.className = '';
    const self = this;
    this.classList = {
      list: () => self.className.split(/\s+/).filter(Boolean),
      add(...c) { const l = this.list(); c.forEach((x) => { if (!l.includes(x)) l.push(x); }); self.className = l.join(' '); },
      remove(...c) { self.className = this.list().filter((x) => !c.includes(x)).join(' '); },
      contains(c) { return this.list().includes(c); },
      toggle(c, on) { const want = on === undefined ? !this.contains(c) : !!on; if (want) this.add(c); else this.remove(c); return want; },
    };
  }
  get children() { return this.childNodes.filter((n) => n.tagName !== '#TEXT'); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get offsetHeight() { return 0; }
  get offsetWidth() { return 0; }
  get textContent() { return this.tagName === '#TEXT' ? this._text : this._text + this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; this._text = String(v); }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...kids) { this.textContent = ''; kids.forEach((k) => this.appendChild(k)); }
  replaceWith(n) { if (this.parentNode) { this.parentNode.insertBefore(n, this); this.parentNode.removeChild(this); } }
  append(...kids) { kids.forEach((k) => this.appendChild(typeof k === 'string' ? Object.assign(new Node('#text'), { _text: k }) : k)); }
  get dataset() { return this._dataset || (this._dataset = {}); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatch(t, ev = {}) { (this.listeners[t] || []).slice().forEach((fn) => fn(Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, ev))); }
  click() { this.dispatch('click'); }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  matches(sel) {
    if (sel.startsWith('.')) return sel.slice(1).split('.').every((c) => this.classList.contains(c));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    const out = [];
    const walk = (n, depth) => n.childNodes.forEach((c) => {
      if (c.tagName === '#TEXT') return;
      if (c.matches(parts[parts.length - 1])) {
        // ancestors for descendant selectors ('.a .b')
        let ok = true;
        let up = c.parentNode;
        for (let i = parts.length - 2; i >= 0 && ok; i--) {
          while (up && up !== this.parentNode && !up.matches(parts[i])) up = up.parentNode;
          if (!up) ok = false; else up = up.parentNode;
        }
        if (ok) out.push(c);
      }
      walk(c, depth + 1);
    });
    walk(this, 0);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  set innerHTML(v) { this.textContent = ''; this._html = v; }
}

// -> {win, PL, document}: a vm context with the fake DOM and the given files loaded (js/core.js and
// js/ui.js first unless opts.files says otherwise). Timers are real; requestAnimationFrame runs the
// callback in a timer.
export function domEnv(files, opts = {}) {
  const body = new Node('body');
  const documentElement = new Node('html');
  documentElement.appendChild(body);
  const document = {
    body, documentElement, hidden: false,
    createElement: (t) => new Node(t),
    createElementNS: (ns, t) => new Node(t),
    createTextNode: (t) => { const n = new Node('#text'); n._text = String(t); return n; },
    createDocumentFragment: () => new Node('#fragment'),
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    getElementById: () => null,
    importNode: (n) => n,
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  const listeners = {};
  const win = {
    document, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, JSON, Math,
    navigator: { userAgent: 'test' },
    location: { protocol: 'file:', search: '', hash: '', href: 'file:///index.html' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatchEvent: (ev) => { (listeners[ev.type] || []).slice().forEach((fn) => fn(ev)); },
    getComputedStyle: () => ({}),
    // (icons parsed from constant SVG strings: an empty <svg> is enough here)
    DOMParser: class { parseFromString() { return { documentElement: new Node('svg') }; } },
    devicePixelRatio: 1,
  };
  win.window = win;
  win.self = win;
  vm.createContext(win);
  const list = opts.bare ? files : ['js/core.js', 'js/icons.js', 'js/ui.js'].concat(files);
  for (const f of list) vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), win, { filename: f });
  return { win, PL: win.PL, document, Node, fire: (t, ev = {}) => win.dispatchEvent(Object.assign({ type: t }, ev)) };
}

export const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
