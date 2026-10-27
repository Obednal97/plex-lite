// Tests for the Phase 2 plugin host: permissions, sanitising, the RPC bridge, and end-to-end runs of
// the real SDK + example plugins in one vm context talking to the host in another (as an iframe would).
//   node test/plugin-host.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

const HELLO_MANIFEST = { id: 'com.example.plexlite.hello', title: 'Hello Shelf', version: '1.0.0', apiVersion: 1, entry: 'plugin.js', permissions: ['plex:read'] };
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

// ---- service-side loader (Node 0.12-compatible reference) ----------------------------------------

test('service loader: lists plugin packages, reads entries, rejects traversal', () => {
  const require = createRequire(import.meta.url);
  const loader = require(join(ROOT, 'service-lib/plugin-loader.js'));
  const apps = mkdtempSync(join(tmpdir(), 'pl-apps-'));
  cpSync(join(ROOT, 'examples/plugins/hello-shelf'), join(apps, 'com.example.plexlite.hello'), { recursive: true });
  mkdirSync(join(apps, 'com.example.notaplugin'));
  writeFileSync(join(apps, 'com.example.notaplugin/appinfo.json'), JSON.stringify({ id: 'com.example.notaplugin' }));
  mkdirSync(join(apps, 'com.example.evil'));
  writeFileSync(join(apps, 'com.example.evil/appinfo.json'), JSON.stringify({ id: 'com.example.evil', plexlitePlugin: { entry: '../com.example.plexlite.hello/plugin.js' } }));
  eq(loader.listPlugins(apps), ['com.example.evil', 'com.example.plexlite.hello']);
  const r = loader.readPlugin(apps, 'com.example.plexlite.hello');
  assert.equal(r.appinfo.title, 'Hello Shelf');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => loader.readPlugin(apps, 'com.example.evil'), /Invalid entry path/);
  assert.throws(() => loader.readPlugin(apps, '../etc'), /Invalid plugin id/);
  assert.throws(() => loader.readPlugin(apps, 'com.example.notaplugin'), /Not a Plex Lite plugin/);
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
