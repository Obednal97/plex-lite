// Test environment for the home server helper plugins (plugins/home-helper, whats-coming, bazarr):
// the real js/plugins.js and plugin files in a vm context, a fake Plex built from the demo library
// (tools/demo/model.mjs), PL.http over fetch, and the fake helper (tools/demo/helper.mjs) on a port.
// Not a test itself; test/home-helper.test.mjs, whats-coming.test.mjs and bazarr.test.mjs use it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { loadLibrary } from '../../tools/demo/model.mjs';
import { startFakeHelper, demoData } from '../../tools/demo/helper.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export const model = loadLibrary(join(ROOT, 'tools/demo/library.json'));
export const ids = (item) => Object.fromEntries((item.Guid || []).map((g) => g.id.split('://')));
export const show = (id) => model.shows.find((s) => s._id === id);
export const movie = (id) => model.movies.find((m) => m._id === id);
export const tick = (n = 3) => new Promise((r) => { let i = 0; const go = () => (++i >= n ? r() : setImmediate(go)); setImmediate(go); });

// A helper on its own port with the demo data (or opts.data), plus the plugins in a vm.
export async function makeEnv(opts = {}) {
  const now = opts.now || new Date();
  const helper = opts.noHelper ? null : await startFakeHelper({
    data: opts.data || demoData(model, now, (kind, id) => `https://img.example.com/${kind}/${id}.jpg`),
    services: opts.services,
    acceptToken: opts.acceptToken,
    plexRefreshed: opts.plexRefreshed,
  });
  const store = {};
  const toasts = [];
  const pushed = [];
  const plexCalls = [];
  const http = [];
  const toastNode = { textContent: '', children: [], classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
    insertBefore(n) { n.parentNode = this; this.children.unshift(n); },
    removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; return n; },
    querySelector(sel) { return sel === '.hh-spin' ? this.children.find((c) => c.cls === 'hh-spin') || null : null; } };
  const plain = (item) => item && clone(Object.fromEntries(Object.entries(item).filter(([k]) => !k.startsWith('_'))));
  const PL = {
    isWeb: !!opts.web,
    storage: {
      get: (k, d) => (k in store ? clone(store[k]) : d),
      set: (k, v) => { store[k] = clone(v); },
      del: (k) => { delete store[k]; },
    },
    log() {}, warn() {},
    el: (tag, cls, text) => ({ tag, cls, text }),
    // (setting textContent drops the children, as in a browser)
    toast: (m) => { toasts.push(m); toastNode.textContent = m; toastNode.children.forEach((c) => { c.parentNode = null; }); toastNode.children = []; toastNode.classList.add('show'); },
    http: (method, url, o = {}) => {
      http.push({ method, url, headers: { ...(o.headers || {}) }, body: o.body ? JSON.parse(o.body) : null });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeout || 15000);
      return fetch(url, { method, headers: { Accept: 'application/json', ...(o.headers || {}) }, body: o.body || undefined, signal: ctrl.signal }).then(async (r) => {
        clearTimeout(timer);
        const text = await r.text();
        if (r.status >= 200 && r.status < 300) {
          if (!text) return null;
          try { return JSON.parse(text); } catch { return text; }
        }
        const e = new Error(`${method} -> HTTP ${r.status}`);
        e.status = r.status;
        throw e;
      }, (err) => {
        clearTimeout(timer);
        const e = new Error(`${method} -> network error`);
        e.status = 0;
        if (err && err.name === 'AbortError') e.timeout = true;
        throw e;
      });
    },
    plex: {
      token: opts.token || 'demo-owner-token',
      server: { uri: 'http://plex.test', token: 'demo-owner-token' },
      image: (p, w, h) => `img:${p}@${w}x${h}`,
      metadata: (rk) => {
        plexCalls.push(['metadata', rk]);
        const it = model.items.get(String(rk));
        return it ? Promise.resolve(plain(it)) : Promise.reject(new Error('no such item'));
      },
      children: (rk) => {
        plexCalls.push(['children', rk]);
        const it = model.items.get(String(rk));
        const kids = !it ? [] : it.type === 'show' ? it._seasons : it.type === 'season' ? it._episodes : [];
        return Promise.resolve(kids.map(plain));
      },
      get: (path, params = {}) => {
        plexCalls.push(['get', path, clone(params)]);
        const m = /^\/library\/sections\/(\d+)\/all$/.exec(path);
        if (!m) return Promise.reject(new Error('fake plex: ' + path));
        const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
        const items = model.filter(model.sectionItems(m[1], q.get('type')), q).map(plain);
        return Promise.resolve({ size: items.length, Metadata: items });
      },
    },
    screens: {
      sheet: (sections, o) => ({ kind: 'sheet', sections, opts: o }),
      textEntry: (title, initial, placeholder, onDone) => ({ kind: 'text', title, initial, placeholder, onDone }),
      details: (item) => ({ kind: 'details', item }),
    },
    app: { push: (s) => pushed.push(s), pop() {}, backdrop: { set() {} } },
    ui: { makeCard: (item, kind) => ({ card: true, item, kind, querySelector: () => ({ appendChild() {} }) }), icon() {}, spinner() {}, fadeInImage() {} },
    KEY: {},
    isBack: () => false,
  };
  const timers = {
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
  };
  const win = { PL, console, Promise, Date, JSON, Math, encodeURIComponent, isNaN, ...timers,
    location: { protocol: opts.pageProtocol || 'http:' },
    document: { querySelector: (sel) => (sel === '.toast' ? toastNode : null) } };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('js/plugins.js'), win, { filename: 'js/plugins.js' });
  // real Overseerr config shape for the migration (plugins/overseerr/seerr.js stores {url, helperUrl?, profiles})
  if (opts.overseerrConfig) PL.storage.set('plugin.overseerr.config', opts.overseerrConfig);
  if (opts.disabled) PL.storage.set('plugins.disabled', opts.disabled);
  if (helper && opts.setUrl !== false) PL.storage.set('plugin.home-helper.url', opts.url || helper.url);
  const defs = {};
  const register = PL.plugins.register;
  PL.plugins.register = (def) => { defs[def.id] = def; return register(def); };
  // opts.overseerr: the Overseerr plugin too, in index.html's order (the helper core first)
  const files = ['plugins/home-helper/helper.js']
    .concat(opts.overseerr ? ['seerr.js', 'report.js', 'downloads.js', 'discover.js', 'screens.js', 'plugin.js'].map((f) => 'plugins/overseerr/' + f) : [])
    .concat(['plugins/home-helper/plugin.js', 'plugins/whats-coming/plugin.js', 'plugins/bazarr/plugin.js']);
  for (const f of files) {
    vm.runInContext(read(f), win, { filename: f });
  }
  const H = PL.homeHelper;
  return {
    PL, H, W: PL.whatsComing, B: PL.bazarr, O: PL.overseerr, helper: helper && helper.helper, url: helper && helper.url, store, toasts, pushed, plexCalls, http, defs, toastNode,
    // a plugin's definition (def.ctx is the ctx js/plugins.js made for it)
    def: (id) => defs[id],
    sheets: () => pushed.filter((s) => s.kind === 'sheet'),
    close: () => (helper ? helper.close() : Promise.resolve()),
  };
}

// Plex-shaped items the details pages pass to plugins (full metadata, with Guids)
export function plexItem(rk) {
  const it = model.items.get(String(rk));
  return clone(Object.fromEntries(Object.entries(it).filter(([k]) => !k.startsWith('_'))));
}
