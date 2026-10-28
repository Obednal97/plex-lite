// Tests for the Overseerr plugin's browser path (plugins/overseerr/seerr-web.js, web build only):
// a simulated browser fetch (CORS, preflights, same-site cookies) in front of a fake Overseerr,
// sign-in and the setup diagnosis, per-profile sessions over one cookie, and the same answers as
// the webOS service (service/service.js) for the same server.
//   node --test test/overseerr-web.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ORIGIN = 'https://plexlite.example.com';
const SEERR = 'https://overseerr.example.com';

// ---- A fake Overseerr: (request) -> {status, data, setCookie} -------------------------------------

function fakeSeerr(opts = {}) {
  const seen = [];
  const handler = ({ method, path: url, cookie, body }) => {
    seen.push({ method, url, cookie: cookie || null, body: body || null });
    const send = (status, data, setCookie) => ({ status, data, setCookie });
    if (url === '/api/v1/status') return send(200, { version: '3.4.1' });
    if (opts.csrf && method !== 'GET') return send(403, { message: 'invalid csrf token' });
    if (url === '/api/v1/auth/plex') {
      const tok = JSON.parse(body).authToken;
      if (tok === 'stranger') return send(403, { message: 'Access denied.' });
      const id = tok === 'tok-a' ? 1 : 2;
      return send(200, { id, displayName: 'User' + id, permissions: id === 1 ? 2 : 32 | 4194304, plexToken: 'secret' },
        'connect.sid=s%3Asess' + id + '; Path=/; HttpOnly; SameSite=Lax');
    }
    const sess = /connect\.sid=s%3Asess(\d)/.exec(cookie || '');
    if (!sess) return send(403, { message: 'You do not have permission to access this endpoint. auth' });
    const uid = Number(sess[1]);
    if (url === '/api/v1/auth/logout') return send(200, { status: 'ok' }, 'connect.sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    if (url === '/api/v1/auth/me') return send(200, { id: uid, displayName: 'User' + uid, permissions: uid === 1 ? 2 : 32 | 4194304 });
    if (url.indexOf('/api/v1/media?filter=') === 0) {
      const f = /filter=(\w+)/.exec(url)[1];
      if (f === 'processing') return send(200, { results: [{ id: 10, mediaType: 'movie', tmdbId: 100, status: 3, downloadStatus: [{ title: 'R', status: 'downloading', size: 10, sizeLeft: 5, timeLeft: '00:01:00', downloadId: 'HASH' }] }, { id: 11, mediaType: 'movie', tmdbId: 101, status: 3, downloadStatus: [] }] });
      if (f === 'partial') return send(200, { results: [{ id: 12, mediaType: 'tv', tmdbId: 200, ratingKey: '9', status: 4, downloadStatus: [{ title: 'S', status: 'queued', size: 4, sizeLeft: 4, episode: { seasonNumber: 1, episodeNumber: 2, title: 'Two' } }] }] });
      return send(200, { results: [{ id: 10, mediaType: 'movie', tmdbId: 100, status: 5, downloadStatus: [{ title: 'dup', status: 'downloading', size: 1, sizeLeft: 1 }] }] });
    }
    if (url === '/api/v1/movie/100') return send(200, { title: 'Film', releaseDate: '2020-01-01', posterPath: '/p.jpg', credits: { cast: new Array(50).fill({ name: 'x' }) }, mediaInfo: { id: 10, status: 3, downloadStatus: [], issues: [{ id: 4, status: 1, issueType: 2, problemSeason: 0, problemEpisode: 0, createdAt: '2026-01-01T00:00:00Z' }, { id: 5, status: 2, issueType: 1 }] } });
    if (url === '/api/v1/movie/999') return send(200, null);
    if (url === '/api/v1/tv/200') return send(200, { name: 'Show', firstAirDate: '2019-05-05', posterPath: '/s.jpg' });
    if (url === '/api/v1/request' && method === 'POST') return send(201, { id: 77, requestedBy: { id: uid } });
    if (url === '/api/v1/issue' && method === 'POST') return send(201, { id: 88, createdBy: { id: uid } });
    return send(404, { message: 'nope' });
  };
  return { handler, seen };
}

// ---- A browser in front of it: CORS, preflight, cookie jar ----------------------------------------
// cors: {allowOrigin: origin|'*'|null, credentials: bool, preflight: bool}; sameSite: whether the
// page and Overseerr are the same site (the browser stores and sends the Lax cookie only then).

function browser(handler, opts = {}) {
  const o = Object.assign({ allowOrigin: ORIGIN, credentials: true, preflight: true, sameSite: true, reachable: true }, opts);
  const jar = { cookie: null };
  const log = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    log.push({ method, path: u.pathname + u.search, mode: init.mode || 'cors', credentials: init.credentials || 'same-origin', keepalive: !!init.keepalive });
    if (!o.reachable) throw new TypeError('Failed to fetch');
    const creds = init.credentials === 'include';
    if (init.mode === 'no-cors') return { status: 0, type: 'opaque', text: async () => '' };
    const ct = String(headers['Content-Type'] || '');
    const simple = ['GET', 'HEAD', 'POST'].includes(method) && (!ct || /^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)/.test(ct));
    const corsOk = (withCreds) => !!o.allowOrigin && (o.allowOrigin === '*' ? !withCreds : o.allowOrigin === ORIGIN && (!withCreds || o.credentials));
    if (!simple && (!o.preflight || !corsOk(creds))) { log[log.length - 1].preflightFailed = true; throw new TypeError('Failed to fetch'); }
    const res = handler({ method, path: u.pathname + u.search, cookie: creds && o.sameSite ? jar.cookie : null, body: init.body || null });
    if (!corsOk(creds)) throw new TypeError('Failed to fetch');
    if (creds && o.sameSite && res.setCookie) {
      const m = /^([^=]+=[^;]*)/.exec(res.setCookie);
      jar.cookie = /Expires=Thu, 01 Jan 1970/.test(res.setCookie) ? null : m[1];
    }
    const text = res.data == null ? '' : JSON.stringify(res.data);
    return { status: res.status, type: 'cors', text: async () => text };
  };
  return { fetch, jar, log, opts: o };
}

// ---- The plugin, loaded as the web build loads it -------------------------------------------------

function webPlugin(b) {
  const store = {};
  const opened = [];
  const PL = {
    isWeb: true,
    storage: {
      get: (k, d) => (k in store ? JSON.parse(store[k]) : d),
      set: (k, v) => { store[k] = JSON.stringify(v); },
      del: (k) => { delete store[k]; },
    },
    el: () => ({ appendChild() {}, style: {}, classList: { toggle() {}, add() {}, remove() {} } }),
    clear() {}, translate() {}, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    warn() {},
    plex: { onSignOut: [] },
    plugins: { register: (def) => { PL.def = def; } },
  };
  const window = { location: { origin: ORIGIN }, open: (url) => opened.push(url) };
  const sandbox = { PL, window, console, setTimeout, clearTimeout, Promise, Date, JSON, Math };
  vm.createContext(sandbox);
  for (const f of ['seerr.js', 'seerr-web.js', 'report.js', 'downloads.js', 'plugin.js']) {
    vm.runInContext(read('plugins/overseerr/' + f), sandbox, { filename: f });
  }
  const O = PL.overseerr;
  O.web.fetch = b.fetch;
  O.web.origin = () => ORIGIN;
  const toasts = [];
  const sheets = [];
  const ctx = {
    profileValue: null,
    token: 'tok-a',
    storage: {
      get: (k, d) => PL.storage.get('plugin.overseerr.' + k, d),
      set: (k, v) => PL.storage.set('plugin.overseerr.' + k, v),
      del: (k) => PL.storage.del('plugin.overseerr.' + k),
    },
    profile() { return ctx.profileValue; },
    plexToken() { return ctx.token; },
    service() { throw new Error('the web build must not call the webOS service'); },
    http: () => Promise.reject(new Error('no http')),
    warn() {}, log() {},
    toast: (t) => toasts.push(t),
    sheet: (sections) => sheets.push(sections),
    plex: { metadata: () => Promise.reject(new Error('no plex')) },
  };
  return { PL, O, ctx, toasts, sheets, opened, store };
}

const kid = { uuid: 'kid1', title: 'Kid' };

// ---- Sign-in and the happy path -------------------------------------------------------------------

test('sign-in with the Plex token, straight to Overseerr with credentials', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  const user = await O.signIn(ctx, SEERR);
  assert.equal(user.displayName, 'User1');
  assert.equal(O.config(ctx).url, SEERR);
  assert.ok(O.ready(ctx));
  assert.ok(b.log.every((r) => r.credentials === 'include'), 'every call sends credentials');
  assert.deepEqual(b.log.map((r) => r.method + ' ' + r.path), ['POST /api/v1/auth/plex', 'GET /api/v1/auth/me']);
  assert.equal(JSON.parse(s.seen[0].body).authToken, 'tok-a');
  assert.ok(!JSON.stringify(ctx.storage.get('web.owner')).includes('sess'), 'the cookie is never stored by the app');
  assert.ok(!JSON.stringify(O.config(ctx)).includes('secret'), 'Overseerr\'s copy of the Plex token is not kept');
});

test('requests, search and a report go to Overseerr as the signed-in user', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  await O.signIn(ctx, SEERR);
  const me = await O.api(ctx, 'GET', '/auth/me');
  assert.equal(me.id, 1);
  b.log.length = 0;
  const created = await O.api(ctx, 'POST', '/request', { mediaType: 'movie', mediaId: 5 });
  assert.equal(created.id, 77);
  assert.deepEqual(b.log.map((r) => r.method + ' ' + r.path), ['GET /api/v1/auth/me', 'POST /api/v1/request'], 'a change checks who the cookie belongs to first');
  await assert.rejects(O.api(ctx, 'GET', '/../etc'), (e) => e.code === 'bad_request');
  await assert.rejects(O.api(ctx, 'GET', '/nope'), (e) => e.status === 404 && e.message === 'nope');
});

test('the Downloading list, the lookup and their caches', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  await O.signIn(ctx, SEERR);
  const res = await O.downloads(ctx, 0);
  assert.equal(res.source, 'overseerr');
  assert.equal(JSON.stringify(res.list.map((e) => e.id)), '["movie-100","tv-200"]');
  assert.equal(res.list[0].title, 'Film');
  assert.equal(O.progressLine(res.list[0]), '50% · 1 min left');
  const before = b.log.length;
  await O.downloads(ctx, 0);
  assert.equal(b.log.length, before, 'cached for 5 s, as in the service');
  const look = await O.lookup(ctx, 'movie', 100);
  assert.equal(look.media.mediaId, 10);
  assert.equal(look.media.issues.length, 1, 'open issues only');
  await assert.rejects(O.lookup(ctx, 'movie', 999), (e) => e.code === 'network' && /no data/.test(e.message));
});

test('Settings and the actions work without the webOS service', async () => {
  const s = fakeSeerr();
  const { PL, O, ctx } = webPlugin(browser(s.handler));
  assert.equal(PL.def.web, true);
  await O.signIn(ctx, SEERR);
  assert.equal(JSON.stringify(PL.def.actions({ type: 'movie' }, ctx).map((a) => a.label)), '["Report a problem"]');
});

// ---- Per-profile sessions over one browser cookie -------------------------------------------------

test('profiles: a switch signs the profile in again (if it signed in before), changes never go out as someone else', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  await O.signIn(ctx, SEERR); // owner (user 1)
  ctx.profileValue = kid;
  ctx.token = 'tok-b';
  assert.ok(!O.ready(ctx), 'a new profile is not signed in automatically');
  await assert.rejects(O.api(ctx, 'GET', '/auth/me'), (e) => e.code === 'unauthenticated');
  assert.equal(s.seen.filter((r) => r.url === '/api/v1/auth/plex').length, 1, 'no automatic first sign-in');
  await O.signIn(ctx, SEERR); // explicit: kid (user 2)
  assert.equal((await O.api(ctx, 'GET', '/auth/me')).id, 2);

  // back to the owner: the cookie is the kid's, so the owner signs in again, once, and goes on
  ctx.profileValue = null;
  ctx.token = 'tok-a';
  const [a, c] = await Promise.all([O.api(ctx, 'GET', '/auth/me'), O.api(ctx, 'GET', '/auth/me')]);
  assert.equal(a.id, 1);
  assert.equal(c.id, 1);
  assert.equal(s.seen.filter((r) => r.url === '/api/v1/auth/plex').length, 3, 'one sign-in for two calls at once');

  // someone signs in as the kid elsewhere in this browser (another tab, Overseerr's own pages)
  b.jar.cookie = 'connect.sid=s%3Asess2';
  s.seen.length = 0;
  const made = await O.api(ctx, 'POST', '/request', { mediaType: 'movie', mediaId: 1 });
  assert.equal(made.requestedBy.id, 1, 'the request is made as the owner, not the kid');
  assert.deepEqual(s.seen.map((r) => r.method + ' ' + r.url + ' ' + r.cookie), [
    'GET /api/v1/auth/me connect.sid=s%3Asess2',
    'POST /api/v1/auth/plex connect.sid=s%3Asess2',
    'GET /api/v1/auth/me connect.sid=s%3Asess1',
    'GET /api/v1/auth/me connect.sid=s%3Asess1',
    'POST /api/v1/request connect.sid=s%3Asess1',
  ]);

  // status notices the swap too, and the owner's permissions come back from a fresh sign-in
  b.jar.cookie = 'connect.sid=s%3Asess2';
  const u = await O.refreshUser(ctx, true);
  assert.equal(u.id, 1);
});

test('the downloads cache is per profile', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  await O.signIn(ctx, SEERR);
  await O.downloads(ctx, 0);
  ctx.profileValue = kid;
  ctx.token = 'tok-b';
  await O.signIn(ctx, SEERR);
  const n = s.seen.length;
  await O.downloads(ctx, 0);
  assert.ok(s.seen.slice(n).some((r) => r.url.indexOf('/api/v1/media') === 0 && r.cookie === 'connect.sid=s%3Asess2'), 'the kid loads its own list');
});

test('sign out: the cookie\'s profile signs out of Overseerr, others just forget; Plex Sign out ends it too', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { PL, O, ctx } = webPlugin(b);
  await O.signIn(ctx, SEERR);
  ctx.profileValue = kid;
  await O.forget(ctx); // the kid never signed in: nothing to end
  assert.equal(s.seen.filter((r) => r.url === '/api/v1/auth/logout').length, 0);
  ctx.profileValue = null;
  await O.forget(ctx);
  assert.equal(s.seen.filter((r) => r.url === '/api/v1/auth/logout').length, 1);
  assert.equal(b.jar.cookie, null);
  assert.ok(!O.ready(ctx));

  await O.signIn(ctx, SEERR);
  PL.plex.onSignOut.forEach((fn) => fn(false));
  assert.equal(b.log.filter((r) => r.path === '/api/v1/auth/logout').length, 1, 'an expired Plex sign-in keeps it');
  PL.plex.onSignOut.forEach((fn) => fn(true));
  const out = b.log.filter((r) => r.path === '/api/v1/auth/logout');
  assert.equal(out.length, 2);
  assert.equal(out[1].keepalive, true, 'sent with keepalive (the page reloads)');
  assert.equal(ctx.storage.get('web.owner', null), null);
});

// ---- Detect and explain -----------------------------------------------------------------------------

async function signInFails(opts, seerrOpts) {
  const s = fakeSeerr(seerrOpts);
  const b = browser(s.handler, opts);
  const env = webPlugin(b);
  let err = null;
  await env.O.signIn(env.ctx, SEERR).catch((e) => { err = e; });
  return Object.assign(env, { err, b, s });
}

test('no CORS on Overseerr\'s proxy: "doesn\'t allow this site", with the docs', async () => {
  const { O, ctx, err, b, sheets, opened } = await signInFails({ allowOrigin: null, preflight: false });
  assert.equal(err.code, 'cors');
  assert.match(err.message, /doesn't allow this site/);
  assert.equal(err.setup, true);
  assert.ok(b.log.some((r) => r.mode === 'no-cors'), 'reachability probed without CORS');
  assert.equal(O.web.problem, err, 'kept for Settings');
  assert.equal(O.web.explain(ctx, err), true);
  const rows = sheets[0][0].rows;
  assert.ok(rows.some((r) => r.sub.includes(ORIGIN)), 'names the origin to allow');
  rows[rows.length - 1].action();
  assert.match(opened[0], /docs\/OVERSEERR\.md#on-the-web$/);
});

test('CORS without credentials, or with *: says what is missing', async () => {
  let r = await signInFails({ credentials: false });
  assert.equal(r.err.code, 'cors');
  assert.match(r.err.message, /not signed in/);
  assert.ok(r.err.explain.rows.some((x) => /Allow-Credentials/.test(x.sub)));
  r = await signInFails({ allowOrigin: '*' });
  assert.match(r.err.message, /not signed in/);
});

test('CORS on responses but no preflight answer', async () => {
  const { err } = await signInFails({ preflight: false });
  assert.equal(err.code, 'cors');
  assert.match(err.message, /preflight/);
  assert.ok(err.explain.rows.some((x) => /OPTIONS/.test(x.label + x.sub)));
});

test('the cookie is not kept on the same site: blocked cookies or a proxy rewriting Set-Cookie', async () => {
  const { err, O, ctx } = await signInFails({ sameSite: false });
  assert.equal(err.code, 'cookie');
  assert.match(err.explain.rows[0].label, /didn't send its cookie back/);
  assert.ok(!O.ready(ctx), 'not signed in');
});

test('different sites are named', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler, { sameSite: false });
  const { O, ctx } = webPlugin(b);
  O.web.origin = () => 'https://plexlite.vercel.app';
  const err = await O.signIn(ctx, SEERR).catch((e) => e);
  assert.equal(err.code, 'cookie');
  assert.equal(err.explain.rows[0].label, 'This page is on plexlite.vercel.app, Overseerr on example.com');
  assert.match(err.explain.rows[1].sub, /subdomain of example\.com/);
});

test('siteOf: registrable domain, near enough for the wording', () => {
  const { O } = webPlugin(browser(() => ({})));
  assert.equal(O.web.siteOf('plexlite.example.com'), 'example.com');
  assert.equal(O.web.siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(O.web.siteOf('plexlite.vercel.app'), 'plexlite.vercel.app');
  assert.equal(O.web.siteOf('home.duckdns.org:443'), 'home.duckdns.org');
  assert.equal(O.web.siteOf('192.0.2.10'), '192.0.2.10');
});

test('CSRF protection on: explained, not "this account can\'t sign in"', async () => {
  const { err } = await signInFails({}, { csrf: true });
  assert.equal(err.code, 'csrf');
  assert.ok(err.explain.rows.some((x) => /Enable CSRF Protection/.test(x.label)));
});

test('unreachable: a plain network error (no setup sheet)', async () => {
  const { err, O, ctx } = await signInFails({ reachable: false });
  assert.equal(err.code, 'network');
  assert.match(err.message, /Could not reach Overseerr at overseerr\.example\.com/);
  assert.equal(O.web.explain(ctx, err), false);
});

test('Overseerr refuses the Plex account: same message as the service', async () => {
  const s = fakeSeerr();
  const { O, ctx } = webPlugin(browser(s.handler));
  ctx.token = 'stranger';
  const err = await O.signIn(ctx, SEERR).catch((e) => e);
  assert.equal(err.code, 'forbidden');
  assert.equal(err.message, 'Overseerr doesn\'t let this Plex account sign in');
});

test('an https page refuses a plain-http Overseerr address', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  const err = await O.signIn(ctx, 'http://overseerr.example.com').catch((e) => e);
  assert.equal(err.code, 'bad_url');
  assert.match(err.message, /https:\/\//);
  assert.equal(b.log.length, 0);
});

test('Settings: sign-in failures open the explanation, and the problem stays listed until a call works', async () => {
  const s = fakeSeerr();
  const b = browser(s.handler, { allowOrigin: null, preflight: false });
  const { PL, O, ctx, sheets, toasts } = webPlugin(b);
  ctx.textEntry = (title, initial, placeholder, done) => { ctx.placeholder = placeholder; done('overseerr.example.com'); };
  ctx.refreshSettings = () => {};
  PL.def.settingsRows(ctx)[0].action();
  sheets[0][0].rows[0].action(); // Set up Overseerr
  assert.equal(ctx.placeholder, 'e.g. https://overseerr.example.com');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sheets[1][0].heading, 'Overseerr doesn\'t allow this site');
  assert.ok(!toasts.some((t) => /allow/.test(t)), 'a sheet, not a toast');
  PL.def.settingsRows(ctx)[0].action();
  assert.equal(sheets[2][0].rows[0].label, 'Overseerr doesn\'t allow this site');
  // fixed on the proxy: the next sign-in works and the row goes
  b.opts.allowOrigin = ORIGIN;
  b.opts.preflight = true;
  await O.signIn(ctx, SEERR);
  assert.equal(O.web.problem, null);
});

test('registry: on the web, a service plugin with its own browser path registers; others stay "TV app only"', () => {
  const store = {};
  const PL = {
    isWeb: true, warn() {}, log() {}, toast() {}, el() {}, http() {},
    storage: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; }, del: (k) => { delete store[k]; } },
    plex: { token: 't' },
  };
  const win = { PL, setTimeout, clearTimeout };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('js/plugins.js'), win);
  assert.equal(PL.plugins.register({ id: 'overseerr', name: 'Overseerr', version: '1', apiVersion: 1, services: ['com.example.svc'], web: true }), true);
  assert.equal(PL.plugins.register({ id: 'tvonly', name: 'TV only', version: '1', apiVersion: 1, services: ['com.example.svc2'] }), false);
  assert.equal(JSON.stringify(PL.plugins.unavailable.map((p) => p.id)), '["tvonly"]');
});

test('the TV build never loads the browser path', () => {
  assert.ok(!read('index.html').includes('seerr-web.js'), 'index.html (TV) does not list it');
  assert.match(read('tools/build-web.mjs'), /seerr-web\.js/);
});

// ---- Same answers as the webOS service for the same Overseerr --------------------------------------

test('parity with service/service.js: login, status, downloads, lookup, errors', async () => {
  const s = fakeSeerr();
  // the service, against the fake over real HTTP
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = s.handler({ method: req.method, path: req.url, cookie: req.headers.cookie, body });
      const headers = { 'Content-Type': 'application/json' };
      if (r.setCookie) headers['Set-Cookie'] = r.setCookie;
      res.writeHead(r.status, headers);
      res.end(r.data == null ? '' : JSON.stringify(r.data));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const handlers = {};
  const origLoad = Module._load;
  // no state file: the service's own test owns /tmp/com.bednal.plexlite.service.json
  const memFs = { readFileSync() { throw new Error('none'); }, writeFileSync() {} };
  Module._load = function (req) {
    if (req === 'webos-service') return function Service() { this.register = (name, fn) => { handlers[name] = fn; }; };
    if (req === 'fs') return memFs;
    return origLoad.apply(this, arguments);
  };
  const require = Module.createRequire(import.meta.url);
  const svcPath = path.join(ROOT, 'plugins/overseerr/service/service.js');
  delete require.cache[svcPath];
  try { require(svcPath); } finally { Module._load = origLoad; }
  const svc = (name, payload) => new Promise((resolve) => handlers[name]({ payload, respond: resolve }));

  // the browser path, against the same fake through the simulated browser
  const b = browser(s.handler);
  const { O, ctx } = webPlugin(b);
  const web = (name, payload) => O.web.call(ctx, name, payload).then((r) => r, (e) => ({ returnValue: false, errorCode: e.code, errorText: e.message }));
  const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.at; delete c.url; return c; };

  try {
    const a = await svc('login', { url: base, plexToken: 'tok-a', key: 'o-aaaa' });
    const w = await web('login', { url: SEERR, plexToken: 'tok-a', key: 'o-aaaa' });
    assert.deepEqual(strip(w), strip(a), 'login');
    for (const [name, payload] of [
      ['status', { key: 'o-aaaa' }],
      ['status', { key: 'p-nobody' }],
      ['downloads', { key: 'o-aaaa' }],
      ['lookup', { key: 'o-aaaa', mediaType: 'movie', tmdbId: 100 }],
      ['lookup', { key: 'o-aaaa', mediaType: 'movie', tmdbId: 999 }],
      ['lookup', { key: 'o-aaaa', mediaType: 'movie', tmdbId: '1; DROP' }],
      ['request', { key: 'o-aaaa', method: 'GET', path: '/auth/me' }],
      ['request', { key: 'o-aaaa', method: 'GET', path: '/../x' }],
      ['request', { key: 'o-aaaa', method: 'PATCH', path: '/x' }],
      ['request', { key: 'p-nobody', method: 'GET', path: '/auth/me' }],
      ['request', { key: 'o-aaaa', method: 'POST', path: '/issue', body: { issueType: 1, message: 'x', mediaId: 10 } }],
    ]) {
      const sa = strip(await svc(name, payload));
      const wa = strip(await web(name, payload));
      if (sa.returnValue === false) assert.deepEqual([wa.returnValue, wa.errorCode], [false, sa.errorCode], name + ' ' + JSON.stringify(payload));
      else assert.deepEqual(wa, sa, name + ' ' + JSON.stringify(payload));
    }
    const sf = await svc('login', { url: base, plexToken: 'stranger', key: 'p-x' });
    const wf = await web('login', { url: SEERR, plexToken: 'stranger', key: 'p-x' });
    assert.deepEqual([wf.errorCode, wf.errorText], [sf.errorCode, sf.errorText], 'refused sign-in');
  } finally {
    server.close();
  }
});
