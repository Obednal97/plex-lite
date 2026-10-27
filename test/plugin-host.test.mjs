// Tests for the Phase 2 plugin host: permissions, sanitising, the RPC bridge, end-to-end runs of the
// real SDK + example plugins in one vm context talking to the host in another (as an iframe would),
// and the catalogue/install store (hash checks, install/update/remove).
//   node test/plugin-host.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SDK = read('js/plugin-sdk.js');
const HOST = read('js/plugin-host.js');
const HELLO = read('examples/plugins/hello-shelf/plugin.js');
const PROBE = read('examples/plugins/probe/plugin.js');
const TOKEN = 'SECRET-PLEX-TOKEN-123';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const clone = (v) => JSON.parse(JSON.stringify(v));
// values from another vm context have other prototypes; compare their JSON shape
const eq = (a, b, msg) => assert.deepEqual(clone(a), clone(b), msg);
const TIMERS = { setTimeout, clearTimeout, setImmediate };
const tick = () => new Promise((r) => setImmediate(r));

// ---- host context ------------------------------------------------------------------------------

function makeHost() {
  const store = {};
  const toasts = [];
  const sheets = [];
  const PL = {
    warn() {},
    toast: (m) => toasts.push(m),
    storage: {
      get: (k, d) => (k in store ? clone(store[k]) : d),
      set: (k, v) => { store[k] = clone(v); },
      del: (k) => { delete store[k]; },
    },
  };
  const win = { PL, ...TIMERS };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(HOST, win);
  return { PL, host: PL.pluginHost, I: PL.pluginHost._internals, store, toasts, sheets };
}

// A fake "iframe": the SDK and the plugin run in their own vm context; messages are cloned and async.
function makeFrameFactory(pluginSource, log) {
  return function createFrame(srcdoc, onHostMessage) {
    assert.match(srcdoc, /sandbox|Content-Security-Policy/);
    const listeners = [];
    const parentProxy = {
      postMessage: (msg) => { const m = clone(msg); log && log.push(['toHost', m.t, m.m]); setImmediate(() => onHostMessage(m)); },
    };
    const win = {
      parent: parentProxy,
      top: parentProxy,
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      console,
      ...TIMERS,
    };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(SDK, win);
    vm.runInContext(pluginSource, win);
    return {
      post: (msg) => { const m = clone(msg); setImmediate(() => listeners.forEach((fn) => fn({ source: parentProxy, data: m }))); },
      destroy: () => { listeners.length = 0; },
    };
  };
}

function runtimeFor(h, manifest, source, extra = {}) {
  const I = h.I;
  const grants = new I.Grants(h.PL.storage);
  const plexCalls = [];
  const rt = new I.Runtime({ manifest, source }, {
    grants,
    sdkSource: SDK,
    createFrame: makeFrameFactory(source),
    plex: {
      get: (path, params) => { plexCalls.push([path, params]); return Promise.resolve({ Metadata: [
        { ratingKey: '11', title: 'Alpha', year: 2001, thumb: '/library/metadata/11/thumb/1?X-Plex-Token=' + TOKEN },
        { ratingKey: '12', title: 'Beta', thumb: '/library/metadata/12/thumb/2' },
      ] }); },
      token: () => TOKEN,
    },
    storage: h.PL.storage,
    toast: h.PL.toast,
    http: () => Promise.resolve('ok'),
    sheet: (heading, rows) => h.sheets.push([heading, rows]),
    ...extra,
  });
  return { rt, grants, plexCalls };
}

const HELLO_MANIFEST = { id: 'com.example.plexlite.hello', title: 'Hello Shelf', version: '1.0.0', apiVersion: 1, entry: 'plugin.js', permissions: ['plex:read', 'tabs'], tabs: [{ id: 'hello', title: 'Hello' }] };
const PROBE_MANIFEST = { id: 'com.example.plexlite.probe', title: 'Sandbox Probe', version: '0.1.0', apiVersion: 1, entry: 'plugin.js', permissions: [] };

// ---- permissions & sanitising -------------------------------------------------------------------

test('permissions: known, network origins normalised, unknown rejected', () => {
  const { I } = makeHost();
  const r = I.parsePermissions({ permissions: ['plex:read', 'plex:token', 'network:https://Api.Example.com:443/x', 'network:user', 'root:everything'] });
  eq(r.list.map((p) => p.id), ['plex:read', 'plex:token', 'network:https://api.example.com', 'network:user']);
  assert.equal(r.list.find((p) => p.id === 'plex:token').risk, 'high');
  assert.equal(r.errors.length, 1);
});

test('grants: an update adding a permission asks again; code-only update does not', () => {
  const h = makeHost();
  const g = new h.I.Grants(h.PL.storage);
  g.set('x', { version: '1', granted: ['plex:read'], origins: [], denied: false });
  assert.equal(g.missing('x', { permissions: ['plex:read'] }).length, 0);
  eq(g.missing('x', { permissions: ['plex:read', 'plex:token'] }).map((p) => p.id), ['plex:token']);
  g.set('y', { granted: ['plex:read'], denied: true });
  assert.equal(g.missing('y', { permissions: ['plex:read'] }).length, 1, 'denied plugins have nothing granted');
});

test('network: only granted origins (fixed or user-entered)', () => {
  const { I } = makeHost();
  const rec = { granted: ['network:https://api.example.com', 'network:user'], origins: ['https://overseerr.example.com'], denied: false };
  assert.ok(I.originAllowed(rec, 'https://api.example.com/v1/x'));
  assert.ok(I.originAllowed(rec, 'https://overseerr.example.com/api/v1/search'));
  assert.ok(!I.originAllowed(rec, 'https://evil.example.com/'));
  assert.ok(!I.originAllowed(rec, 'http://api.example.com/'), 'scheme is part of the origin');
  assert.ok(!I.originAllowed(rec, 'javascript:alert(1)'));
  assert.ok(!I.originAllowed({ ...rec, denied: true }, 'https://api.example.com/'));
});

test('items given to plugins carry no URLs or tokens', () => {
  const { I } = makeHost();
  const p = I.projectItem({ ratingKey: '5', title: 'T', thumb: '/x?X-Plex-Token=' + TOKEN, Media: [{}], art: '/a', guid: 'plex://movie/1' });
  eq(Object.keys(p).sort(), ['guid', 'ratingKey', 'title']);
});

test('shelves are sanitised: limits, images, keys', () => {
  const { I } = makeHost();
  const rec = { granted: ['network:https://img.example.com'], origins: [], denied: false };
  const items = Array.from({ length: 60 }, (_, i) => ({ title: 'T' + i, image: i % 3 === 0 ? { plex: '/library/metadata/1/thumb' } : i % 3 === 1 ? 'https://img.example.com/a.jpg' : 'https://evil.example.com/b.jpg', ratingKey: i === 0 ? '42' : 'not-a-key' }));
  const s = I.sanitizeShelf({ title: 'x'.repeat(200), kind: 'weird', items }, rec);
  assert.equal(s.items.length, 40);
  assert.equal(s.title.length, 80);
  assert.equal(s.kind, 'poster');
  eq(s.items[0].image, { plex: '/library/metadata/1/thumb' });
  eq(s.items[1].image, { url: 'https://img.example.com/a.jpg' });
  assert.equal(s.items[2].image, null, 'image from an origin the plugin may not contact');
  assert.equal(s.items[0].ratingKey, '42');
  assert.equal(s.items[1].ratingKey, null);
  assert.equal(I.sanitizeImage, undefined);
  assert.equal(I.sanitizeShelf({ items: [{ title: '' }] }, rec), null);
});

test('Plex proxy: read-only allow-list, token param stripped, token scrubbed from results', () => {
  const { I } = makeHost();
  for (const ok of ['/library/sections', '/library/sections/2/all', '/library/metadata/123/children', '/hubs/search', '/hubs/sections/1']) {
    assert.ok(I.plexPathAllowed(ok), ok);
  }
  for (const bad of ['/accounts', '/:/prefs', '/library/sections/../../accounts', '/library/metadata/1/../../x', '/system', '/video/:/transcode/universal/start', 'http://evil/x', '/library/parts/1/file.mkv']) {
    assert.ok(!I.plexPathAllowed(bad), bad);
  }
  eq(I.cleanParams({ 'X-Plex-Token': 'x', 'x-plex-token': 'y', sort: 'titleSort', 'bad key!': 1, obj: { a: 1 } }), { sort: 'titleSort' });
  eq(I.scrubToken({ a: '/t?X-Plex-Token=' + TOKEN }, TOKEN), { a: '/t?X-Plex-Token=' });
});

test('srcdoc: CSP blocks all network/images, plugin code cannot close the script tag', () => {
  const { I } = makeHost();
  const doc = I.buildSrcdoc('/*sdk*/', 'var s = "</script><img src=x onerror=alert(1)>";');
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /default-src 'none'/);
  assert.ok(!/<\/script><img/i.test(doc));
});

// ---- RPC ------------------------------------------------------------------------------------------

function rpcPair(I, onCall, opts = {}) {
  let b;
  const a = new I.Rpc({ post: (m) => setImmediate(() => b.receive(clone(m))), onCall: () => Promise.reject(new Error('n/a')), timeoutMs: opts.timeoutMs || 200, maxPending: opts.maxPending });
  b = new I.Rpc({ post: (m) => setImmediate(() => a.receive(clone(m))), onCall });
  return { a, b };
}

test('rpc: round trip, errors, unknown ids and junk ignored', async () => {
  const { I } = makeHost();
  const { a } = rpcPair(I, (m, args) => (m === 'add' ? args[0] + args[1] : Promise.reject(new Error('nope'))));
  assert.equal(await a.call('add', [2, 3]), 5);
  await assert.rejects(a.call('other', []), /nope/);
  assert.equal(a.receive({ pl: 1, t: 'res', id: 999, ok: true }), false);
  assert.equal(a.receive({ hello: 'x' }), false);
  assert.equal(a.receive(null), false);
});

test('rpc: timeout, pending cap, oversized messages', async () => {
  const { I } = makeHost();
  const { a } = rpcPair(I, () => new Promise(() => {}), { timeoutMs: 30, maxPending: 2 });
  const p1 = a.call('slow', []);
  const p2 = a.call('slow', []);
  await assert.rejects(a.call('slow', []), /busy/);
  await assert.rejects(p1, /in time/);
  await assert.rejects(p2, /in time/);
  const big = { pl: 1, t: 'call', id: 1, m: 'x', a: ['y'.repeat(300 * 1024)] };
  assert.equal(a.receive(big), false);
  a.close();
  await assert.rejects(a.call('x', []), /not running/);
});

// ---- end to end: SDK + plugin in a "frame", host capabilities ---------------------------------------

test('e2e: without a grant, the plugin cannot read Plex', async () => {
  const h = makeHost();
  const { rt, plexCalls } = runtimeFor(h, HELLO_MANIFEST, HELLO);
  await assert.rejects(rt.call('shelfRows', [{ key: '1' }]), /permission_denied: plex:read/);
  assert.equal(plexCalls.length, 0);
  rt.stop();
});

test('e2e: with plex:read, the shelf arrives sanitised and token-free (via the Phase 1-shaped definition)', async () => {
  const h = makeHost();
  const { rt, grants, plexCalls } = runtimeFor(h, HELLO_MANIFEST, HELLO);
  grants.set(HELLO_MANIFEST.id, { granted: ['plex:read'], origins: [], denied: false });
  const def = h.I.toDefinition(rt);
  const shelves = await def.shelfRows({ key: '1', type: 'movie', title: 'Movies', secret: TOKEN });
  assert.equal(shelves.length, 1);
  assert.equal(shelves[0].title, 'Hello from a plugin');
  assert.equal(shelves[0].items[0].title, 'Alpha');
  assert.equal(shelves[0].items[0].ratingKey, '11');
  assert.ok(!JSON.stringify(shelves).includes(TOKEN), 'no token anywhere in what the plugin returned');
  assert.equal(plexCalls[0][0], '/library/sections/1/all');
  assert.ok(!('X-Plex-Token' in plexCalls[0][1]));
  rt.stop();
});

test('e2e: actions run inside the plugin with scoped storage and toasts; item is projected', async () => {
  const h = makeHost();
  const { rt, grants } = runtimeFor(h, HELLO_MANIFEST, HELLO);
  grants.set(HELLO_MANIFEST.id, { granted: ['plex:read'], origins: [], denied: false });
  const def = h.I.toDefinition(rt);
  const actions = await def.actions({ ratingKey: '7', title: 'Gamma', thumb: '/t?X-Plex-Token=' + TOKEN });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].label, 'Say hello');
  await actions[0].run();
  await actions[0].run();
  eq(h.toasts, ['Hello, Gamma (#1)', 'Hello, Gamma (#2)']);
  eq(h.store['plugin.com.example.plexlite.hello'], { greetings: 2 }, 'storage is namespaced per plugin');
  rt.stop();
});

test('e2e: the probe plugin with no permissions is refused every host capability', async () => {
  const h = makeHost();
  const { rt } = runtimeFor(h, PROBE_MANIFEST, PROBE);
  const def = h.I.toDefinition(rt);
  const rows = await def.settingsRows();
  const text = rows.map((r) => r.label).join('\n');
  assert.match(text, /plex\.get without grant: permission_denied/);
  assert.match(text, /plexToken without grant: permission_denied/);
  assert.match(text, /host fetch without grant: permission_denied/);
  assert.ok(!/REACHED/.test(text), 'nothing reachable: ' + text);
  rt.stop();
});

test('e2e: identity mismatch and newer API versions are refused', async () => {
  const h = makeHost();
  const { rt } = runtimeFor(h, { ...HELLO_MANIFEST, id: 'com.example.other' }, HELLO);
  await assert.rejects(rt.call('shelfRows', [{ key: '1' }]), /identity or API version/);
});

test('e2e: a plugin that keeps failing is turned off', async () => {
  const h = makeHost();
  const failing = "PlexLitePlugin.register({id:'com.example.bad', name:'Bad', apiVersion:1, searchRows:function(){ throw new Error('boom'); }});";
  const { rt } = runtimeFor(h, { id: 'com.example.bad', title: 'Bad', apiVersion: 1, entry: 'p.js', permissions: [] }, failing);
  for (let i = 0; i < 5; i++) await assert.rejects(rt.call('searchRows', ['x']));
  assert.equal(rt.disabled, true);
  assert.match(h.toasts.join(), /turned off/);
  await assert.rejects(rt.call('searchRows', ['x']), /disabled/);
});

test('e2e: expired option ids are refused', async () => {
  const h = makeHost();
  const { rt, grants } = runtimeFor(h, HELLO_MANIFEST, HELLO);
  grants.set(HELLO_MANIFEST.id, { granted: ['plex:read'], origins: [], denied: false });
  await assert.rejects(rt.call('invoke', ['f999999']), /expired/);
  rt.stop();
});

// ---- Phase 2 decisions: Sensitive token re-ask, tabs, screen models, revoke -----------------------

test('plex:token is re-asked on any update (version or code hash); other grants carry over', () => {
  const h = makeHost();
  const g = new h.I.Grants(h.PL.storage);
  const m = { version: '1.0.0', permissions: ['plex:read', 'plex:token'] };
  g.set('t', { version: '1.0.0', hash: 'aaa', granted: ['plex:read', 'plex:token'], origins: [], denied: false });
  eq(g.missing('t', m, 'aaa').map((p) => p.id), [], 'same version + hash: nothing to ask');
  eq(g.missing('t', { ...m, version: '1.0.1' }, 'aaa').map((p) => p.id), ['plex:token']);
  eq(g.missing('t', m, 'bbb').map((p) => p.id), ['plex:token'], 'code changed');
  eq(g.missing('r', { version: '2', permissions: ['plex:read'] }, 'x').map((p) => p.id), ['plex:read']);
  g.set('r', { version: '1', hash: 'x', granted: ['plex:read'], denied: false });
  eq(g.missing('r', { version: '2', permissions: ['plex:read'] }, 'y').map((p) => p.id), [], 'non-sensitive grants survive updates');
});

test('screen models are sanitised; options become closures; unknown types refused', async () => {
  const h = makeHost();
  const rec = { granted: ['plex:read'], origins: [], denied: false };
  const rt = { id: 'p', grant: () => rec, call: () => Promise.resolve({ type: 'page', title: 'Next', actions: [] }) };
  assert.equal(h.I.sanitizeModel({ type: 'html', body: '<b>x</b>' }, rec, rt), null);
  const m = h.I.sanitizeModel({ type: 'grid', title: 't'.repeat(200), items: Array.from({ length: 900 }, (_, i) => ({ title: 'T' + i, select: 'f' + i })) }, rec, rt);
  assert.equal(m.title.length, 80);
  assert.equal(m.items.length, 40, 'grid items go through the shelf sanitiser (capped)');
  const next = await m.items[0].onSelect();
  assert.equal(next.type, 'page');
  const page = h.I.sanitizeModel({ type: 'page', title: 'P', summary: 's'.repeat(2000), actions: [{ id: 'f1', label: 'Go' }, { label: 'no id' }], shelves: [{ title: 'S', items: [{ title: 'a' }] }] }, rec, rt);
  assert.equal(page.summary.length, 600);
  assert.equal(page.actions.length, 1);
  assert.equal(page.shelves[0].items[0].title, 'a');
});

test('e2e: a plugin tab needs the "tabs" grant, then renders shelves; an item opens a page whose action runs', async () => {
  const h = makeHost();
  const { rt, grants } = runtimeFor(h, HELLO_MANIFEST, HELLO, {
    plex: {
      get: (path) => Promise.resolve(path === '/library/sections'
        ? { Directory: [{ key: '1', title: 'Movies' }] }
        : { Metadata: [{ ratingKey: '11', title: 'Alpha', year: 2001, thumb: '/library/metadata/11/thumb/1', summary: 'Sum' }] }),
      token: () => TOKEN,
    },
  });
  grants.set(HELLO_MANIFEST.id, { granted: ['plex:read'], origins: [], denied: false });
  const def = h.I.toDefinition(rt);
  eq(def.tabs(), [], 'no tabs without the grant');
  assert.equal(await def.screen('hello'), null);
  grants.set(HELLO_MANIFEST.id, { granted: ['plex:read', 'tabs'], origins: [], denied: false });
  eq(def.tabs(), [{ id: 'hello', title: 'Hello' }]);
  const model = await def.screen('hello');
  assert.equal(model.type, 'shelves');
  assert.equal(model.shelves[0].title, 'Newest in Movies');
  const page = await model.shelves[0].items[0].onSelect();
  assert.equal(page.type, 'page');
  assert.equal(page.title, 'Alpha');
  await page.actions[0].run();
  eq(h.toasts, ['Hello, Alpha']);
  rt.stop();
});

test('registry: dotted external ids, at most 2 plugin tabs overall, unregister', () => {
  const store = {};
  const PL = {
    warn() {}, log() {}, toast() {}, el() {}, http() {},
    storage: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; }, del: (k) => { delete store[k]; } },
    plex: { token: TOKEN },
  };
  const win = { PL, ...TIMERS };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('js/plugins.js'), win);
  const screen = () => Promise.resolve({ type: 'shelves', shelves: [] });
  assert.equal(PL.plugins.register({ id: 'one', name: 'One', version: '1', apiVersion: 1, tabs: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], screen }), true);
  assert.equal(PL.plugins.register({ id: 'com.example.ext', name: 'Ext', version: '1', apiVersion: 1, external: true, tabs: () => [{ id: 'c', title: 'C' }], screen }), true);
  eq(PL.plugins.tabs().map((t) => t.plugin + '/' + t.id), ['one/a', 'one/b'], 'capped at 2');
  PL.plugins.unregister('one');
  eq(PL.plugins.tabs().map((t) => t.plugin + '/' + t.id), ['com.example.ext/c']);
  PL.plugins.setEnabled('com.example.ext', false);
  eq(PL.plugins.tabs(), []);
});

test('revoke: grants removed, definition gone, plugin back to pending; token holders tracked', () => {
  const h = makeHost();
  const host = h.host;
  host.grants = new h.I.Grants(h.PL.storage);
  host.pending = [];
  host.runtimes = { 'com.example.t': { id: 'com.example.t', manifest: { title: 'T', permissions: ['plex:token'] }, stop() {} } };
  host.grants.set('com.example.t', { granted: ['plex:token'], origins: [], denied: false });
  host.definitions['com.example.t'] = {};
  eq(host.tokenHolders(), ['com.example.t']);
  assert.equal(host.list()[0].holdsToken, true);
  host.revoke('com.example.t');
  eq(host.tokenHolders(), []);
  assert.equal(host.grants.get('com.example.t'), null);
  assert.ok(!host.definitions['com.example.t']);
  eq(host.pending, ['com.example.t']);
});

// ---- catalogue, hashes, installs (js/sha256.js + js/plugin-store.js) -----------------------------

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const CATALOG = read('catalog/plugins.json');
const HELLO_ENTRY = JSON.parse(CATALOG).plugins[0];

function makeStoreEnv({ files = {}, luna } = {}) {
  const store = {};
  const toasts = [];
  const consents = [];
  const PL = {
    VERSION: '0.1.0',
    warn() {}, log() {}, el() {}, http() {},
    toast: (m) => toasts.push(m),
    storage: {
      get: (k, d) => (k in store ? clone(store[k]) : d),
      set: (k, v) => { if (!(store.full && String(k).indexOf('plugins.bundle.') === 0)) store[k] = clone(v); },
      del: (k) => { delete store[k]; },
    },
    plex: { token: TOKEN, get: () => Promise.resolve({ Metadata: [{ ratingKey: '11', title: 'Alpha' }] }) },
  };
  const win = { PL, ...TIMERS };
  win.window = win;
  vm.createContext(win);
  for (const f of ['js/plugins.js', 'js/plugin-host.js', 'js/sha256.js', 'js/plugin-store.js']) vm.runInContext(read(f), win);
  const host = PL.pluginHost;
  host.init({ sdkSource: SDK, createFrame: (srcdoc, onMsg) => makeFrameFactory(srcdoc.indexOf("'1.0.1'") !== -1 ? HELLO_V2 : HELLO)(srcdoc, onMsg) });
  host.consent = (m, perms) => { consents.push([m.id, perms.map((p) => p.id)]); return Promise.resolve(true); };
  const fetched = [];
  const st = PL.pluginStore._create({
    luna,
    fetchText: (url) => { fetched.push(url); return url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('HTTP 404')); },
  });
  return { PL, host, st, store, toasts, consents, fetched, I: PL.pluginStore._internals };
}
const HELLO_V2 = HELLO.replace("version: '1.0.0'", "version: '1.0.1'");
const BUNDLED_HELLO = 'catalog/' + HELLO_ENTRY.bundleUrl;

test('sha256: pure JS matches node crypto (empty, block edges, unicode, 1 MB, the hello bundle)', () => {
  const win = {};
  vm.createContext(win);
  vm.runInContext(read('js/sha256.js'), win);
  for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'Amélie 😀 字', 'x'.repeat(1 << 20), HELLO]) {
    assert.equal(win.PL.sha256(t), sha(t), JSON.stringify(t.slice(0, 12)));
  }
  assert.equal(HELLO_ENTRY.sha256, sha(read(BUNDLED_HELLO)), 'catalogue pins the published bundle');
  assert.equal(read(BUNDLED_HELLO), HELLO, 'published bundle is the example source');
});

test('catalogue: bundled copy parses; URLs resolve against the catalogue; bad entries skipped', () => {
  const { I, PL } = makeStoreEnv();
  const c = I.parseCatalog(CATALOG, 'catalog/plugins.json');
  eq(c.errors, []);
  assert.equal(c.plugins[0].bundleUrl, 'catalog/bundles/com.example.plexlite.hello-1.0.0.js');
  assert.equal(c.plugins[0].bundleSha256, HELLO_ENTRY.sha256);
  assert.equal(c.plugins[0].compatible, true);
  const remote = I.parseCatalog(CATALOG, PL.pluginStore.DEFAULT_URL);
  assert.equal(remote.plugins[0].bundleUrl, 'https://raw.githubusercontent.com/Obednal97/plex-lite/main/catalog/bundles/com.example.plexlite.hello-1.0.0.js');
  const H = '0'.repeat(64);
  const base = { name: 'X', version: '1.0.0', apiVersion: 1, kind: 'web', permissions: [], bundleUrl: 'b.js', sha256: H };
  const svc = { ...base, kind: 'service', permissions: ['service'], ipkUrl: 'https://e.com/x.ipk', bundleSha256: H };
  const bad = I.parseCatalog({ schema: 1, plugins: [
    { ...base, id: 'com.ok.one' },
    { ...base, id: 'com.ok.one' },
    { ...base, id: 'Bad Id' },
    { ...base, id: 'com.bad.hash', sha256: 'abc' },
    { ...base, id: 'com.bad.perm', permissions: ['root'] },
    { ...base, id: 'com.bad.path', bundleUrl: '../../js/app.js' },
    { ...base, id: 'com.bad.scheme', bundleUrl: 'javascript:alert(1)' },
    { ...base, id: 'com.bad.kind', kind: 'native' },
    { ...svc, id: 'com.bad.svcperm', permissions: [] },
    { ...svc, id: 'com.bad.svcid', serviceId: 'com.webos.service.secret' },
    { ...svc, id: 'com.ok.svc' },
    { ...base, id: 'com.ok.newer', minAppVersion: '9.0.0' },
  ] }, 'https://example.com/c/plugins.json', { appVersion: '0.1.0' });
  eq(bad.plugins.map((p) => p.id), ['com.ok.one', 'com.ok.svc', 'com.ok.newer']);
  assert.equal(bad.errors.length, 9);
  assert.equal(bad.plugins[1].serviceId, 'com.ok.svc.service');
  assert.equal(bad.plugins[1].ipkSha256, H);
  assert.equal(bad.plugins[2].compatible, false);
  assert.match(bad.plugins[2].needs, /9\.0\.0/);
  assert.throws(() => I.parseCatalog('{"plugins": {}}', 'x'), /Not a plugin catalogue/);
  assert.throws(() => I.parseCatalog('nope', 'x'));
});

test('catalogue: remote → cached last good copy → bundled copy', async () => {
  const files = { 'catalog/plugins.json': CATALOG };
  const env = makeStoreEnv({ files });
  let c = await env.st.loadCatalog();
  assert.equal(c.source, 'bundled', 'private repo: remote 404s');
  const newer = JSON.parse(CATALOG);
  newer.updated = '2099-01-01';
  files[env.PL.pluginStore.DEFAULT_URL] = JSON.stringify(newer);
  c = await env.st.loadCatalog();
  assert.equal(c.source, 'remote');
  delete files[env.PL.pluginStore.DEFAULT_URL];
  c = await env.st.loadCatalog();
  assert.equal(c.source, 'cache');
  assert.equal(env.st.setCatalogUrl('file:///etc/passwd'), false);
  assert.equal(env.st.setCatalogUrl('https://example.com/plugins.json'), true);
  c = await env.st.loadCatalog();
  assert.equal(c.source, 'bundled', 'cache belongs to another catalogue URL');
  delete files['catalog/plugins.json'];
  c = await env.st.loadCatalog();
  assert.equal(c.source, 'none');
  eq(c.plugins, []);
});

test('install: a tampered or oversized bundle is refused and nothing is stored', async () => {
  const entry = makeStoreEnv().I.parseCatalog(CATALOG, 'catalog/plugins.json').plugins[0];
  const env = makeStoreEnv({ files: { [BUNDLED_HELLO]: HELLO.replace('Say hello', 'Steal stuff') } });
  await assert.rejects(env.st.install(entry), /does not match the catalogue/);
  eq(env.st.installed(), {});
  assert.ok(!env.host.runtimes[entry.id]);
  assert.ok(!Object.keys(env.store).some((k) => k.indexOf('plugins.bundle.') === 0));
  const big = 'x'.repeat(300 * 1024);
  const env2 = makeStoreEnv({ files: { [BUNDLED_HELLO]: big } });
  await assert.rejects(env2.st.install({ ...entry, bundleSha256: sha(big) }), /too large/);
  const env3 = makeStoreEnv({ files: { [BUNDLED_HELLO]: HELLO } });
  env3.store.full = true; // localStorage quota exceeded
  await assert.rejects(env3.st.install(entry), /Not enough room/);
  eq(env3.st.installed(), {});
});

test('install → connect → update available → update → remove', async () => {
  const files = { [BUNDLED_HELLO]: HELLO, 'catalog/bundles/v2.js': HELLO_V2 };
  const env = makeStoreEnv({ files });
  const { st, host, PL } = env;
  const entry = env.I.parseCatalog(CATALOG, 'catalog/plugins.json').plugins[0];
  assert.equal(st.state(entry).state, 'not-installed');
  const progress = [];
  await st.install(entry, (t) => progress.push(t));
  eq(progress, ['Downloading…']);
  assert.equal(st.state(entry).state, 'installed');
  eq(host.pending, [entry.id], 'waits for consent');
  eq(PL.plugins.tabs(), []);
  assert.equal(await st.connect(entry.id), true);
  eq(env.consents, [[entry.id, ['plex:read', 'tabs']]]);
  assert.equal(st.state(entry).state, 'connected');
  eq(PL.plugins.tabs().map((t) => t.plugin + '/' + t.id), [entry.id + '/hello']);
  const rows = await PL.plugins.shelfRows({ key: '1', type: 'movie' });
  assert.equal(rows[0].items[0].title, 'Alpha');

  // a code-only update (same permissions, no plex:token) keeps the grants and stays connected
  const v2 = { ...entry, version: '1.0.1', bundleUrl: 'catalog/bundles/v2.js', bundleSha256: sha(HELLO_V2) };
  assert.equal(st.state(v2).state, 'update-available');
  await st.update(v2);
  assert.equal(st.state(v2).state, 'connected');
  assert.equal(st.installed()[entry.id].version, '1.0.1');
  assert.equal(env.consents.length, 1, 'no new consent');
  eq((await PL.plugins.shelfRows({ key: '1', type: 'movie' }))[0].items.length, 1);
  eq(st.installedBundles().map((b) => [b.manifest.id, b.hash]), [[entry.id, sha(HELLO_V2)]]);

  await st.remove(entry.id);
  assert.equal(st.state(v2).state, 'not-installed');
  assert.ok(!host.runtimes[entry.id]);
  assert.equal(host.grants.get(entry.id), null);
  eq(PL.plugins.tabs(), []);
  assert.ok(!Object.keys(env.store).some((k) => /^plugins\.bundle\.|^plugin\./.test(k)), 'code and plugin data gone');
});

test('update: a plugin holding the Plex sign-in must be asked again', async () => {
  const files = { [BUNDLED_HELLO]: HELLO, 'catalog/bundles/v2.js': HELLO_V2 };
  const env = makeStoreEnv({ files });
  const entry = { ...env.I.parseCatalog(CATALOG, 'catalog/plugins.json').plugins[0], permissions: ['plex:read', 'plex:token'] };
  await env.st.install(entry);
  await env.st.connect(entry.id);
  eq(env.host.tokenHolders(), [entry.id]);
  await env.st.update({ ...entry, version: '1.0.1', bundleUrl: 'catalog/bundles/v2.js', bundleSha256: sha(HELLO_V2) });
  assert.equal(env.st.state(entry).state, 'installed', 'not connected until re-consent');
  eq(env.host.pending, [entry.id]);
  await env.st.connect(entry.id);
  eq(env.consents.map((c) => c[1]), [['plex:read', 'plex:token'], ['plex:token']]);
  assert.equal(env.st.state(entry).state, 'connected');
});

test('service plugin: Homebrew Channel install (hash, progress, finished) and uninstall', async () => {
  const calls = [];
  let fail = false;
  const luna = (uri, params, ms, onUpdate) => {
    calls.push([uri, params]);
    if (fail) return Promise.reject(new Error('Invalid hash'));
    if (!onUpdate) return Promise.resolve({ returnValue: true });
    for (const r of [{ statusText: 'Downloading…', progress: 50 }, { statusText: 'Verifying…' }, { statusText: 'Finished.', finished: true }]) {
      if (onUpdate(r)) return Promise.resolve(r);
    }
    return Promise.reject(new Error('never finished'));
  };
  const H = sha(HELLO);
  const env = makeStoreEnv({ files: { 'https://example.com/hello.js': HELLO }, luna });
  const [entry] = env.I.parseCatalog({ schema: 1, plugins: [{
    id: 'com.example.plexlite.hello', name: 'Hello', version: '1.0.0', apiVersion: 1, kind: 'service',
    permissions: ['plex:read', 'service'], ipkUrl: 'https://example.com/hello.ipk', sha256: 'a'.repeat(64),
    bundleUrl: 'https://example.com/hello.js', bundleSha256: H,
  }] }, 'https://example.com/plugins.json').plugins;
  const progress = [];
  await env.st.install(entry, (t) => progress.push(t));
  eq(calls[0], ['luna://org.webosbrew.hbchannel.service/install', { ipkUrl: 'https://example.com/hello.ipk', ipkHash: 'a'.repeat(64), subscribe: true }]);
  eq(progress, ['Downloading…', 'Installing service…', 'Downloading…', 'Verifying…', 'Finished.']);
  assert.equal(env.st.installed()[entry.id].serviceId, 'com.example.plexlite.hello.service');
  assert.equal(env.host.runtimes[entry.id].manifest.service, 'com.example.plexlite.hello.service');
  assert.equal(await env.st.remove(entry.id), true);
  eq(calls[1], ['luna://org.webosbrew.hbchannel.service/uninstall', { id: entry.id }]);
  fail = true;
  await assert.rejects(env.st.install(entry), /Invalid hash/);
  eq(env.st.installed(), {}, 'nothing kept when the service fails to install');
});

for (const [name, fn] of tests) {
  if (process.env.TRACE) console.log('…', name);
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out')), 15000).unref())]);
    passed++;
  } catch (e) {
    console.error('FAIL', name, '\n ', e.message);
    process.exitCode = 1;
  }
  await tick();
}
console.log(`${passed}/${tests.length} plugin host tests passed`);
// runtimes keep idle-unload timers; the tests are done, so don't wait for them
process.exit(process.exitCode || 0);
