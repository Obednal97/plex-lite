// Tests for the Overseerr plugin's second round: the TV service noticing a session that ended
// elsewhere, Your requests, the discover rows (Recommended and Search), Request seasons, the page's
// rows, the shared helper address, and the host additions in js/plugins.js (async bundled actions,
// searchIdleRows, row placement, item badges). The service runs against the demo's fake Overseerr
// (tools/demo/seerr.mjs) over real HTTP, as on the TV; the browser path against the same fake.
//   node --test test/overseerr-v2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSeerr } from '../tools/demo/seerr.mjs';
import { loadLibrary, demoTmdb } from '../tools/demo/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const model = loadLibrary(path.join(ROOT, 'tools/demo/library.json'));
// (values from the plugin's sandbox are another realm's arrays and objects)
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const byTitle = (title) => model.movies.concat(model.shows).find((x) => x.title === title);

// ---- The service, against a fake Overseerr on localhost -------------------------------------------

async function serviceWithSeerr() {
  const seerr = createSeerr(model);
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(req.method + ' ' + req.url);
      const r = seerr.handle({ method: req.method, path: req.url, cookie: req.headers.cookie, body });
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
  const call = (name, payload) => new Promise((resolve) => handlers[name]({ payload, respond: resolve }));
  return { seerr, seen, base, call, close: () => server.close() };
}

test('service: a session ended in Overseerr\'s own pages (its real 403) is dropped, not passed on', async () => {
  const s = await serviceWithSeerr();
  try {
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    let r = await s.call('request', { key: 'o-1', method: 'GET', path: '/auth/me' });
    assert.equal(r.status, 200);
    s.seerr.kill(1);
    r = await s.call('request', { key: 'o-1', method: 'GET', path: '/movie/910000' });
    eq([r.returnValue, r.errorCode], [false, 'unauthenticated'], 'the app is told to sign in again');
    r = await s.call('request', { key: 'o-1', method: 'GET', path: '/movie/910000' });
    assert.equal(r.errorCode, 'unauthenticated', 'the session is gone from the service too');
    // the compact methods and status say the same
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    s.seerr.kill(1);
    r = await s.call('discover', { key: 'o-1', list: 'trending-movie' });
    assert.equal(r.errorCode, 'unauthenticated');
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    s.seerr.kill(1);
    r = await s.call('status', { key: 'o-1' });
    eq([r.returnValue, r.signedIn], [true, false]);
  } finally { s.close(); }
});

test('service: a missing permission stays a 403 for the caller, the session stays', async () => {
  const s = await serviceWithSeerr();
  try {
    await s.call('login', { url: s.base, plexToken: 'demo-demo-user-1', key: 'p-kid' });
    let r = await s.call('request', { key: 'p-kid', method: 'GET', path: '/settings/main' });
    eq([r.returnValue, r.status], [true, 403]);
    r = await s.call('request', { key: 'p-kid', method: 'GET', path: '/auth/me' });
    assert.equal(r.status, 200, 'still signed in');
  } finally { s.close(); }
});

test('service: requests are the session user\'s own, compact, with titles', async () => {
  const s = await serviceWithSeerr();
  try {
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    s.seen.length = 0;
    const r = await s.call('requests', { key: 'o-1', take: 500, requestedBy: 2 });
    const asked = s.seen.find((x) => x.indexOf('/api/v1/request?') !== -1);
    assert.match(asked, /take=50&skip=0&sort=added&filter=all&requestedBy=1$/, 'capped, newest first, and always this user (not the app\'s requestedBy)');
    eq(r.items.map((i) => i.title), ['Metropolis', 'NASA ScienceCasts', 'The Kid', 'Paper Moons', 'Flatland Stories', 'Spring', 'Detour']);
    assert.ok(JSON.stringify(r).length < 6000, 'compact');
    assert.ok(!JSON.stringify(r).includes('requestedBy'), 'no user records passed on');
    const kid = r.items.find((i) => i.title === 'The Kid');
    assert.equal(kid.downloads[0].size, 4e9);
  } finally { s.close(); }
});

test('service: discover lists are compact, one kind each, and validated', async () => {
  const s = await serviceWithSeerr();
  try {
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    let r = await s.call('discover', { key: 'o-1', list: 'trending-movie' });
    assert.ok(r.items.length > 3);
    assert.ok(r.items.every((i) => i.mediaType === 'movie'));
    const kid = r.items.find((i) => i.title === 'The Kid');
    eq([kid.status, kid.downloading, kid.requested], [3, 45, true]);
    const bbb = r.items.find((i) => i.title === 'Big Buck Bunny');
    eq([bbb.status, bbb.ratingKey], [5, byTitle('Big Buck Bunny').ratingKey]);
    assert.ok(!('mediaInfo' in bbb));
    r = await s.call('discover', { key: 'o-1', list: 'upcoming-tv' });
    eq(r.items.map((i) => i.title), ['Orbit Station', 'The Glasshouse']);
    r = await s.call('discover', { key: 'o-1', list: '../settings' });
    assert.equal(r.errorCode, 'bad_request');
  } finally { s.close(); }
});

test('service: a show\'s lookup has its seasons, without Specials, with requests', async () => {
  const s = await serviceWithSeerr();
  try {
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    const r = await s.call('lookup', { key: 'o-1', mediaType: 'tv', tmdbId: demoTmdb('sciencecasts') });
    eq(r.seasons.map((x) => [x.season, x.status, x.requested]), [[1, 5, null], [2, 5, null], [3, 1, 'pending'], [4, 1, null], [5, 1, null]]);
    const m = await s.call('lookup', { key: 'o-1', mediaType: 'movie', tmdbId: 910000 });
    assert.ok(!('seasons' in m), 'films have none');
  } finally { s.close(); }
});

// ---- The plugin, in a sandbox like the app's (TV path) ------------------------------------------------

function plugin(opts = {}) {
  const store = {};
  const pushed = [];
  const PL = {
    isWeb: !!opts.web,
    storage: {
      get: (k, d) => (k in store ? JSON.parse(store[k]) : d),
      set: (k, v) => { store[k] = JSON.stringify(v); },
      del: (k) => { delete store[k]; },
    },
    el: () => ({ appendChild() {}, addEventListener() {}, style: {}, classList: { toggle() {}, add() {}, remove() {} } }),
    clear() {}, translate() {}, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)), warn() {}, log() {},
    plex: { onSignOut: [] },
    plugins: { register: (def) => { PL.def = def; } },
  };
  if (opts.homeHelper) PL.homeHelper = opts.homeHelper;
  const sandbox = { PL, window: { location: { origin: 'https://plexlite.example.com' } }, console, setTimeout, clearTimeout, Promise, Date, JSON, Math };
  vm.createContext(sandbox);
  const files = ['seerr.js'].concat(opts.web ? ['seerr-web.js', 'touch.js'] : [], ['report.js', 'downloads.js', 'discover.js', 'screens.js', 'plugin.js']);
  for (const f of files) vm.runInContext(read('plugins/overseerr/' + f), sandbox, { filename: f });
  const O = PL.overseerr;
  const toasts = [];
  const sheets = [];
  const opened = [];
  const calls = [];
  const ctx = {
    profileValue: null,
    token: 'demo-token',
    storage: {
      get: (k, d) => PL.storage.get('plugin.overseerr.' + k, d),
      set: (k, v) => PL.storage.set('plugin.overseerr.' + k, v),
      del: (k) => PL.storage.del('plugin.overseerr.' + k),
    },
    profile() { return ctx.profileValue; },
    plexToken() { return ctx.token; },
    service: (m, p) => { calls.push(m); return opts.service(m, p); },
    http: opts.http || (() => Promise.reject(new Error('no http'))),
    warn() {}, log() {},
    toast: (t) => toasts.push(t),
    sheet: (sections) => sheets.push(sections),
    push: (s) => pushed.push(s),
    openItem: (item) => opened.push(item),
    textEntry() {},
    ui: { makeCard: () => ({ querySelector: () => null }), badge: (n, cls, text) => Object.assign(n, { badge: text }), spinner: () => ({}), KEY: {} },
    plex: {
      metadata: opts.metadata || ((rk) => {
        const it = [...model.items.values()].find((x) => x.ratingKey === String(rk));
        return it ? Promise.resolve(it) : Promise.reject(new Error('not found'));
      }),
    },
  };
  return { PL, O, ctx, toasts, sheets, opened, pushed, calls };
}

// the service's methods, bound to a running service (resolves/rejects like ctx.service)
function viaService(s) {
  return (m, p) => s.call(m, p).then((r) => {
    if (r.returnValue) return r;
    const e = new Error(r.errorText);
    e.code = r.errorCode;
    throw e;
  });
}

async function signedIn(opts = {}) {
  const s = await serviceWithSeerr();
  const env = plugin(Object.assign({ service: viaService(s) }, opts));
  await env.O.signIn(env.ctx, s.base);
  return Object.assign(env, { s });
}

test('the TV path signs in again by itself after a session ended elsewhere', async () => {
  const env = await signedIn();
  try {
    env.s.seerr.kill(1);
    const film = await env.O.api(env.ctx, 'GET', '/movie/910000');
    assert.equal(film.title, 'Metropolis');
    env.s.seerr.kill(1);
    const list = await env.O.discover(env.ctx, 'trending-tv');
    assert.ok(list.length);
    assert.equal(env.calls.filter((c) => c === 'login').length, 3, 'one sign-in each time, no loop');
  } finally { env.s.close(); }
});

test('Your requests: what each request has come to, in words', async () => {
  const env = await signedIn();
  try {
    const res = await env.O.requests(env.ctx);
    const by = {};
    res.list.forEach((e) => { by[e.title] = e; });
    eq([by.Metropolis.label, by.Metropolis.tone], ['Pending approval', 'pending']);
    eq([by['The Kid'].label, by['The Kid'].progress], ['Downloading 45%', 0.45]);
    eq([by['NASA ScienceCasts'].label, by['NASA ScienceCasts'].what], ['Pending approval', 'Season 3']);
    eq([by['Flatland Stories'].label, by['Flatland Stories'].what], ['Partly available', 'Seasons 1 and 2']);
    assert.equal(by['Paper Moons'].label, 'Processing');
    eq([by.Spring.label, by.Spring.ratingKey], ['Available', byTitle('Spring').ratingKey]);
    assert.equal(by.Detour.label, 'Declined');
    assert.equal(by.Metropolis.when, 'today');
    assert.equal(env.O.requestLine(by['Flatland Stories']), 'Seasons 1 and 2 · requested a week ago');
    // cached: the page and the screen share one answer
    await env.O.requests(env.ctx);
    assert.equal(env.calls.filter((c) => c === 'requests').length, 1);
    // OK: a title in Plex opens there, anything else its request sheet
    env.O.openRequestEntry(env.ctx, by.Spring);
    assert.equal(env.opened[0].ratingKey, byTitle('Spring').ratingKey);
    env.O.openRequestEntry(env.ctx, by.Metropolis);
    assert.equal(env.sheets[0][0].rows[0].label, 'Requested on Overseerr');
    env.O.openRequestEntry(env.ctx, by.Detour);
    assert.equal(env.sheets[1][0].rows[0].label, 'Request Detour', 'declined: can be asked for again');
  } finally { env.s.close(); }
});

test('request states without the server (approved, completed, failed, partly)', () => {
  const { O } = plugin({ service: () => Promise.reject(new Error('none')) });
  const st = (r) => O.requestState(Object.assign({ mediaType: 'movie', seasons: [], mediaSeasons: [], downloads: [], mediaStatus: 1 }, r)).label;
  assert.equal(st({ status: 2 }), 'Approved');
  assert.equal(st({ status: 5 }), 'Available');
  assert.equal(st({ status: 4 }), 'Failed');
  assert.equal(st({ status: 2, mediaStatus: 5 }), 'Available');
  assert.equal(st({ status: 2, mediaStatus: 4 }), 'Partly available');
  assert.equal(st({ status: 2, mediaType: 'tv', seasons: [{ season: 3, status: 2 }], mediaSeasons: [{ season: 3, status: 5 }] }), 'Available');
  assert.equal(st({ status: 2, mediaType: 'tv', mediaStatus: 4, seasons: [{ season: 4, status: 2 }] }), 'Approved', 'other seasons being in doesn\'t count');
  assert.equal(O.seasonsLabel([5, 1, 2, 3]), 'Seasons 1–3 and 5');
  assert.equal(O.seasonsLabel([1, 3, 5]), 'Seasons 1, 3 and 5');
  assert.equal(O.seasonsLabel([2]), 'Season 2');
  const now = new Date(2026, 9, 31, 12).getTime();
  assert.equal(O.when(new Date(2026, 9, 30, 23).toISOString(), now), 'yesterday');
  assert.equal(O.when(new Date(2026, 9, 1).toISOString(), now), '1 Oct');
  assert.equal(O.when(new Date(2025, 2, 5).toISOString(), now), '5 Mar 2025');
});

test('discover rows: three per library among Plex\'s own, badged, cached and shared with Search', async () => {
  const env = await signedIn();
  try {
    const { O, ctx, PL } = env;
    const movies = await PL.def.shelfRows({ key: '1', type: 'movie' }, ctx);
    const discover = movies.filter((s) => /^discover-/.test(s.id));
    eq(discover.map((s) => [s.title, s.at]), [['Trending films', 2], ['Popular films', 4], ['Upcoming films', 6]]);
    assert.ok(movies.some((s) => s.id === 'downloading' && s.at == null), 'Downloading stays at the end');
    const trending = discover[0];
    const kid = trending.items.find((i) => i.title === 'The Kid');
    eq([O.badgeText(kid), kid.badge.label, kid.badge.tone], ['Downloading 45%', '45%', 'accent']);
    const met = trending.items.find((i) => i.title === 'Metropolis');
    eq([met.badge.label, met.badge.tone], ['Requested', 'status-2']);
    const bbb = trending.items.find((i) => i.title === 'Big Buck Bunny');
    assert.equal(bbb.badge, null, 'in the library: no badge');
    assert.equal(trending.makeCard(kid, 'poster', {}).badge, 'Downloading 45%');
    const shows = await PL.def.shelfRows({ key: '2', type: 'show' }, ctx);
    eq(shows.filter((s) => /^discover-/.test(s.id)).map((s) => s.title), ['Trending shows', 'Popular shows', 'Upcoming shows']);
    const before = env.calls.filter((c) => c === 'discover').length;
    const idle = await PL.def.searchIdleRows(ctx);
    eq(idle.map((s) => s.title), ['Trending', 'Popular films', 'Popular shows']);
    assert.ok(idle[0].items.some((i) => i.osType === 'movie') && idle[0].items.some((i) => i.osType === 'tv'), 'Trending mixes films and shows');
    assert.equal(env.calls.filter((c) => c === 'discover').length, before, 'Search uses the cached lists');
    await PL.def.shelfRows({ key: '1', type: 'movie' }, ctx);
    assert.equal(env.calls.filter((c) => c === 'discover').length, 6, 'each list asked once');
    // names don't clash with What's coming's rows
    assert.ok(![].concat(movies, shows, idle).some((s) => /this week|arriving soon/i.test(s.title)));
  } finally { env.s.close(); }
});

test('discover rows: none when off, not signed in, or for another profile', async () => {
  const env = await signedIn();
  try {
    const { O, ctx, PL } = env;
    O.setDiscover(ctx, false);
    eq((await PL.def.shelfRows({ key: '1', type: 'movie' }, ctx)).filter((s) => /^discover-/.test(s.id)), []);
    assert.equal(PL.def.searchIdleRows(ctx), null);
    O.setDiscover(ctx, true);
    ctx.profileValue = { uuid: 'kid1', title: 'Kids' };
    eq(await O.discoverShelves({ type: 'movie' }, ctx), [], 'a profile that hasn\'t signed in gets nothing');
    eq(await O.discoverShelves({ type: 'artist' }, ctx), []);
  } finally { env.s.close(); }
});

test('OK on a discover card: in the library opens Plex, else the request sheet; requesting updates the caches', async () => {
  const env = await signedIn();
  try {
    const { O, ctx } = env;
    const list = await O.discover(ctx, 'trending-movie');
    O.selectDiscover(list.find((i) => i.title === 'Big Buck Bunny'), ctx);
    await tick(10);
    assert.equal(env.opened[0].ratingKey, byTitle('Big Buck Bunny').ratingKey);
    const lodger = (await O.discover(ctx, 'popular-movie')).find((i) => i.title === 'The Lodger');
    O.selectDiscover(lodger, ctx);
    assert.equal(env.sheets[0][0].rows[0].label, 'Request The Lodger');
    await O.requests(ctx);
    env.sheets[0][0].rows[0].action();
    await tick(50);
    assert.equal(env.toasts[env.toasts.length - 1], 'Requested The Lodger');
    assert.equal(lodger.status, 2);
    const mine = await O.requests(ctx);
    assert.equal(mine.list[0].title, 'The Lodger', 'Your requests asks again after a request');
  } finally { env.s.close(); }
});

test('Request seasons: on a show missing aired seasons, from the season sheet', async () => {
  const env = await signedIn();
  try {
    const { O, ctx, PL } = env;
    const explorers = await ctx.plex.metadata(byTitle('NASA Explorers').ratingKey);
    const got = PL.def.actions(explorers, ctx);
    assert.equal(typeof got.then, 'function', 'not cached yet: a promise');
    const list = await got;
    eq(list.map((a) => a.label), ['Request seasons', 'Report a problem']);
    const again = PL.def.actions(explorers, ctx);
    assert.ok(Array.isArray(again), 'then answered at once from the cache');
    again[0].run();
    await tick(20);
    const rows = env.sheets[0][0].rows;
    assert.equal(rows[0].label, 'Request Seasons 1–4');
    eq(rows.slice(1).map((r) => r.sub), ['5 episodes', '6 episodes', '7 episodes', '8 episodes', 'Available']);
    rows[0].action();
    await tick(50);
    assert.match(env.toasts[env.toasts.length - 1], /Requested NASA Explorers · Seasons 1–4/);
    // asked for: nothing missing any more
    const after = await PL.def.actions(explorers, ctx);
    eq(after.map((a) => a.label), ['Report a problem']);
    // a show with every season in, and a season page of a show that is missing some
    const cam = await ctx.plex.metadata(byTitle('Caminandes').ratingKey);
    eq((await PL.def.actions(cam, ctx)).map((a) => a.label), ['Report a problem']);
    const sc = byTitle('NASA ScienceCasts');
    const season = { type: 'season', ratingKey: sc._seasons[0].ratingKey, parentRatingKey: sc.ratingKey, Guid: [] };
    const seasonActions = await PL.def.actions(season, ctx);
    assert.equal(seasonActions[0].label, 'Request seasons', 'Season 4 is missing (3 is requested, 5 not aired)');
    seasonActions[0].run();
    await tick(20);
    const s2 = env.sheets[env.sheets.length - 1][0].rows;
    assert.equal(s2[0].label, 'Request Seasons 4 and 5');
    assert.equal(s2[5].sub, 'Starts ' + s2[5].sub.slice(7), 'an unaired season says when it starts');
    assert.match(s2[5].sub, /^Starts \d+ \w{3} \d{4}$/);
    assert.equal(s2[3].sub, 'Requested · waiting for approval');
    // films and episodes never ask
    assert.ok(Array.isArray(PL.def.actions({ type: 'movie' }, ctx)));
  } finally { env.s.close(); }
});

test('Request seasons: a lookup that failed for now (network, an ended session) is asked again next visit', async () => {
  const env = await signedIn();
  try {
    const { PL, ctx } = env;
    const real = ctx.service;
    let fail = 'network';
    ctx.service = (m, p) => (m === 'lookup' && fail ? Promise.reject(Object.assign(new Error('Could not reach Overseerr'), { code: fail })) : real(m, p));
    const explorers = await ctx.plex.metadata(byTitle('NASA Explorers').ratingKey);
    eq((await PL.def.actions(explorers, ctx)).map((a) => a.label), ['Report a problem']);
    fail = 'forbidden';
    eq((await PL.def.actions(explorers, ctx)).map((a) => a.label), ['Report a problem'], 'still failing: asked again, nothing offered');
    fail = null;
    const again = PL.def.actions(explorers, ctx);
    assert.equal(typeof again.then, 'function', 'not cached as "nothing to request"');
    eq((await again).map((a) => a.label), ['Request seasons', 'Report a problem']);
    // a show Overseerr can't match is kept as "nothing to request" (not asked on every visit)
    const nomatch = { type: 'show', ratingKey: '99999', title: 'Nothing', Guid: [] };
    eq((await PL.def.actions(nomatch, ctx)).map((a) => a.label), ['Report a problem']);
    assert.ok(Array.isArray(PL.def.actions(nomatch, ctx)), 'answered from the cache');
  } finally { env.s.close(); }
});

test('Request seasons: a list item (hold-OK menu) gets an answer within 450 ms', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const env = await signedIn({
    metadata: (rk) => slow.then(() => [...model.items.values()].find((x) => x.ratingKey === String(rk))),
  });
  try {
    const { PL, ctx } = env;
    const item = { type: 'show', ratingKey: byTitle('NASA Explorers').ratingKey, title: 'NASA Explorers' };
    const t0 = Date.now();
    const list = await PL.def.actions(item, ctx);
    assert.ok(Date.now() - t0 < 600, 'in time for the menu');
    eq(list.map((a) => a.label), ['Report a problem']);
    release();
    await tick(80);
    eq(PL.def.actions(item, ctx).map((a) => a.label), ['Request seasons', 'Report a problem'], 'the lookup finished into the cache');
  } finally { env.s.close(); }
});

test('the plugin\'s small caches keep their 100 most recently used entries', async () => {
  const { O, ctx } = plugin({ service: () => Promise.reject(new Error('none')) });
  for (let i = 0; i < 150; i++) await O.cached(ctx, 'show', i, 1e9, () => Promise.resolve({ n: i }));
  assert.equal(O.cachedSize('show'), 100);
  assert.equal(O.peek(ctx, 'show', 0), undefined, 'the oldest went first');
  eq(O.peek(ctx, 'show', 149), { n: 149 });
  // a hit counts as a use
  await O.cached(ctx, 'show', 50, 1e9, () => Promise.resolve({ n: -1 }));
  await O.cached(ctx, 'show', 'new', 1e9, () => Promise.resolve({ n: 'new' }));
  eq(O.peek(ctx, 'show', 50), { n: 50 });
  assert.equal(O.peek(ctx, 'show', 51), undefined);
});

test('the Overseerr page\'s rows', async () => {
  const env = await signedIn();
  try {
    const { O, ctx } = env;
    let m = O.pageModel(ctx);
    eq(m.groups.map((g) => g.heading), ['Requests', 'Discover', 'Account', 'Server']);
    assert.match(m.intro, /^Signed in as Demo · can report problems$/);
    eq(m.groups[3].rows.map((r) => r.label), ['Overseerr address', 'Download queue address']);
    await new Promise((r) => O.warmPage(ctx, r));
    m = O.pageModel(ctx);
    assert.equal(m.groups[0].rows[0].value, '7 · 2 waiting');
    const discover = m.groups[1].rows[0];
    assert.equal(discover.toggle, true);
    discover.action();
    assert.equal(O.pageModel(ctx).groups[1].rows[0].value, 'Off');
    m.groups[0].rows[0].action();
    assert.equal(env.pushed.length, 1, 'Your requests opens');
    // signing out leaves the sign-in row
    O.pageModel(ctx).groups[2].rows[2].action();
    await tick(30);
    eq(O.pageModel(ctx).groups.map((g) => g.heading), ['Account', 'Server']);
    assert.match(O.pageModel(ctx).groups[0].rows[0].label, /^Sign in as Account owner$/);
  } finally { env.s.close(); }
});

test('the shared home server helper: its address replaces the old row and feeds Downloading', async () => {
  const asked = [];
  const env = await signedIn({
    homeHelper: { url: () => 'http://helper.example.com:8787/' },
    http: (method, url) => { asked.push(url); return Promise.resolve({ version: 1, items: [] }); },
  });
  try {
    const { O, ctx } = env;
    eq(O.pageModel(ctx).groups[3].rows.map((r) => r.label), ['Overseerr address']);
    await O.downloads(ctx, 0);
    eq(asked, ['http://helper.example.com:8787/queue']);
  } finally { env.s.close(); }
});

// ---- The browser path: the same answers for the new methods ---------------------------------------------

test('web: requests, discover and a show\'s lookup answer as the service does', async () => {
  const s = await serviceWithSeerr();
  const seerr = s.seerr;
  const jar = { cookie: null };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const r = seerr.handle({ method: init.method || 'GET', path: u.pathname + u.search, cookie: jar.cookie, body: init.body || null });
    if (r.setCookie) jar.cookie = /Expires=Thu, 01 Jan 1970/.test(r.setCookie) ? null : /^([^;]*)/.exec(r.setCookie)[1];
    const text = r.data == null ? '' : JSON.stringify(r.data);
    return { status: r.status, text: async () => text };
  };
  const env = plugin({ web: true, service: () => { throw new Error('no service on the web'); } });
  env.O.web.fetch = fetch;
  env.O.web.origin = () => 'https://plexlite.example.com';
  const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.at; return c; };
  try {
    await s.call('login', { url: s.base, plexToken: 'demo-token', key: 'o-1' });
    await env.O.web.call(env.ctx, 'login', { url: 'https://overseerr.example.com', plexToken: 'demo-token', key: 'o-1' });
    for (const [name, payload] of [
      ['requests', { key: 'o-1', take: 20 }],
      ['discover', { key: 'o-1', list: 'trending-tv' }],
      ['discover', { key: 'o-1', list: 'upcoming-movie' }],
      ['lookup', { key: 'o-1', mediaType: 'tv', tmdbId: demoTmdb('sciencecasts') }],
    ]) {
      eq(strip(await env.O.web.call(env.ctx, name, payload)), strip(await s.call(name, payload)), name);
    }
    const bad = await env.O.web.call(env.ctx, 'discover', { key: 'o-1', list: 'x' }).catch((e) => e);
    assert.equal(bad.code, 'bad_request');
  } finally { s.close(); }
});

// ---- The host: js/plugins.js ---------------------------------------------------------------------------

function host() {
  const store = {};
  const PL = {
    warn() {}, log() {}, toast() {}, el() {}, http() {},
    storage: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; }, del: (k) => { delete store[k]; } },
    plex: { token: 't' },
    app: { push: (s) => { PL.pushed = s; } },
    screens: { details: (item) => ({ details: item }) },
  };
  const win = { PL, setTimeout, clearTimeout, Promise };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('js/plugins.js'), win);
  return PL;
}

test('host: a bundled plugin\'s actions may come as a promise, in plugin order', async () => {
  const PL = host();
  PL.plugins.register({ id: 'pa', name: 'A', version: '1', apiVersion: 1, actions: () => Promise.resolve([{ label: 'Later', run() {} }]) });
  PL.plugins.register({ id: 'pb', name: 'B', version: '1', apiVersion: 1, actions: () => [{ label: 'Now', run() {} }, { label: '' }] });
  const got = PL.plugins.actions({ type: 'show' });
  assert.equal(typeof got.then, 'function');
  eq((await got).map((a) => a.label), ['Later', 'Now']);
  PL.plugins.unregister('pa');
  eq(PL.plugins.actions({}).map((a) => a.label), ['Now'], 'all answered at once: no promise');
  PL.plugins.register({ id: 'pc', name: 'C', version: '1', apiVersion: 1, actions: () => Promise.reject(new Error('down')) });
  eq((await PL.plugins.actions({})).map((a) => a.label), ['Now'], 'a failure only drops its own');
});

test('host: searchIdleRows, placement and badges are passed through, cleaned', async () => {
  const PL = host();
  assert.equal(PL.plugins.hasSearchIdle(), false);
  PL.plugins.register({
    id: 'pp', name: 'P', version: '1', apiVersion: 1,
    searchIdleRows: () => Promise.resolve([{ id: 'x', title: 'X', at: 2.7, items: [{ ratingKey: 'p1', title: 'One', badge: { label: 'Requested', tone: 'status-2' } }, { ratingKey: 'p2', title: 'Two', badge: { label: 'B', tone: '<script>' } }] }, { id: 'y', title: 'Y', items: [] }]),
    shelfRows: () => [{ id: 's', title: 'S', at: -1, items: [{ ratingKey: 's1' }] }],
  });
  assert.equal(PL.plugins.hasSearchIdle(), true);
  const rows = await PL.plugins.searchIdleRows();
  eq(rows.map((r) => [r.id, r.at]), [['pp:x', 2]], 'empty rows go; at is a whole number');
  eq(rows[0].items.map((i) => i.badge), [{ label: 'Requested', tone: 'status-2' }, { label: 'B', tone: '' }]);
  assert.equal((await PL.plugins.shelfRows({ type: 'movie' }))[0].at, null, 'a bad at means the end');
  PL.plugins.setEnabled('pp', false);
  eq(await PL.plugins.searchIdleRows(), [], 'off: not asked');
});

test('host: placeRows puts plugin rows after that many of the screen\'s own', () => {
  const PL = host();
  const place = (extra) => PL.plugins.placeRows(['A', 'B', 'C', 'D', 'E'], extra).join('');
  assert.equal(place([{ at: 2, row: 'x' }, { at: 4, row: 'y' }, { row: 'z' }]), 'ABxCDyEz');
  assert.equal(place([{ at: 2, row: 'x' }, { at: 2, row: 'y' }, { at: 0, row: 'w' }]), 'wABxyCDE');
  assert.equal(place([{ at: 9, row: 'x' }, { row: 'y' }]), 'ABCDExy');
  assert.equal(PL.plugins.placeRows(['A'], [{ at: 6, row: 'x' }]).join(''), 'Ax', 'a short library: at the end');
});

test('host: openItem opens the touch layer\'s page while it shows', () => {
  const PL = host();
  PL.plugins.register({ id: 'pq', name: 'Q', version: '1', apiVersion: 1 });
  let open = null;
  PL.plugins.register({ id: 'pr', name: 'R', version: '1', apiVersion: 1, settingsRows: (c) => [{ label: 'Open', action: () => c.openItem(open) }] });
  // (from the viewer's choice: a late answer has rules of its own, test/late-answers.test.mjs)
  const row = () => PL.plugins.settingsRows()[0];
  open = { ratingKey: '5' };
  row().action();
  eq(PL.pushed, { details: { ratingKey: '5' } });
  const shown = [];
  PL.touch = { visible: true, open: (i) => shown.push(i) };
  open = { ratingKey: '6' };
  row().action();
  eq(shown, [{ ratingKey: '6' }]);
});
