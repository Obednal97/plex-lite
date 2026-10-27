// Tests for the Overseerr plugin: shared core (profiles, permissions, download grouping, matching),
// the report message, and the webOS service against a fake Overseerr on localhost.
//   node test/overseerr.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; console.log('FAIL', name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + ' (got ' + JSON.stringify(a) + ')'); }

// ---- web side ----------------------------------------------------------------------------------

function webContext() {
  const store = {};
  const PL = {
    storage: {
      get: (k, d) => (k in store ? JSON.parse(store[k]) : d),
      set: (k, v) => { store[k] = JSON.stringify(v); },
      del: (k) => { delete store[k]; },
    },
    el: () => ({ appendChild() {}, style: {}, classList: { toggle() {}, add() {}, remove() {} } }),
    clear() {}, translate() {}, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    plugins: { register: (def) => { PL.def = def; } },
  };
  const sandbox = { PL, console, setTimeout, clearTimeout, Promise, Date, JSON, Math };
  vm.createContext(sandbox);
  for (const f of ['seerr.js', 'report.js', 'downloads.js', 'plugin.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'plugins/overseerr', f), 'utf8'), sandbox, { filename: f });
  }
  return { PL, O: PL.overseerr, store };
}

function makeCtx(PL, opts) {
  const prefix = 'plugin.overseerr.';
  const calls = [];
  const ctx = {
    calls,
    profileValue: opts.profile || null,
    token: opts.token || 'tok-owner',
    storage: {
      get: (k, d) => PL.storage.get(prefix + k, d),
      set: (k, v) => PL.storage.set(prefix + k, v),
      del: (k) => PL.storage.del(prefix + k),
    },
    profile() { return ctx.profileValue; },
    plexToken() { return ctx.token; },
    service(method, params) { calls.push([method, params]); return opts.service(method, params); },
    http: opts.http || (() => Promise.reject(new Error('no http'))),
    warn() {}, log() {}, toast() {},
    plex: { metadata: opts.metadata || (() => Promise.reject(new Error('no plex'))) },
  };
  return ctx;
}

{
  const { PL, O } = webContext();
  // profile keys: owner by token fingerprint, Home profiles by uuid
  const ctx = makeCtx(PL, { service: () => Promise.resolve({}) });
  const ownerKey = O.profileKey(ctx);
  ok(/^o-[0-9a-f]{8}$/.test(ownerKey), 'owner key is a fingerprint');
  ok(ownerKey.indexOf('tok-owner') === -1, 'owner key does not contain the token');
  ctx.profileValue = { uuid: 'ab12cd34', title: 'Kid' };
  eq(O.profileKey(ctx), 'p-ab12cd34', 'profile key');
  ctx.profileValue = { uuid: 'x"; rm', title: 'Odd' };
  eq(O.profileKey(ctx), 'p-xrm', 'profile key is sanitised');
}

{
  // version 1 config migrates to the owner, not to a Home profile
  const { PL, O } = webContext();
  PL.storage.set('plugin.overseerr.config', { url: 'https://seerr.example.com', user: { id: 1, displayName: 'Owner', permissions: 2 } });
  const ctx = makeCtx(PL, { service: () => Promise.resolve({}) });
  ok(O.ready(ctx), 'legacy config: owner is ready');
  ok(O.canReport(ctx), 'admin can report');
  ctx.profileValue = { uuid: 'kid1', title: 'Kid' };
  ok(!O.ready(ctx), 'legacy config: another profile is not signed in');
  ok(!O.canReport(ctx), 'another profile cannot report');
}

{
  const { O } = webContext();
  ok(O.can({ permissions: 4194304 | 32 }, [O.PERM.MANAGE_ISSUES, O.PERM.CREATE_ISSUES]), 'CREATE_ISSUES can report');
  ok(O.can({ permissions: 1048576 }, [O.PERM.MANAGE_ISSUES, O.PERM.CREATE_ISSUES]), 'MANAGE_ISSUES can report');
  ok(!O.can({ permissions: 32 | 8388608 }, [O.PERM.MANAGE_ISSUES, O.PERM.CREATE_ISSUES]), 'REQUEST only cannot report');
  ok(!O.can(null, [O.PERM.CREATE_ISSUES]), 'no user cannot report');
}

await (async () => {
  // re-sign-in once when the service lost the session, only for a profile that signed in before
  const { PL, O } = webContext();
  PL.storage.set('plugin.overseerr.config', { url: 'https://seerr.example.com', profiles: {} });
  let sessions = 0;
  const ctx = makeCtx(PL, {
    service: (m, p) => {
      if (m === 'login') { sessions++; return Promise.resolve({ url: p.url, user: { id: 5, displayName: 'Kid', permissions: 32 } }); }
      if (m === 'request' && sessions === 0) { const e = new Error('Not signed in'); e.code = 'unauthenticated'; return Promise.reject(e); }
      return Promise.resolve({ status: 200, data: { ok: true } });
    },
  });
  ctx.profileValue = { uuid: 'kid1', title: 'Kid' };
  let err = null;
  await O.api(ctx, 'GET', '/x').catch((e) => { err = e; });
  ok(err && err.code === 'unauthenticated' && sessions === 0, 'unknown profile is never signed in automatically');
  await O.signIn(ctx, 'https://seerr.example.com');
  sessions = 0;
  const r = await O.api(ctx, 'GET', '/x');
  ok(r && r.ok, 'known profile signs in again and retries');
  ok(ctx.calls.every(([, p]) => !p || p.key === undefined || p.key === 'p-kid1'), 'every call carries the profile key');
  eq(ctx.calls.filter(([m]) => m === 'login').length, 2, 'two sign-ins (explicit + automatic)');
})();

await (async () => {
  // download grouping and matching
  const { PL, O } = webContext();
  PL.storage.set('plugin.overseerr.config', { url: 'https://seerr.example.com', profiles: {} });
  const ctx = makeCtx(PL, {
    service: (m) => m === 'login' ? Promise.resolve({ url: 'https://seerr.example.com', user: { id: 1, displayName: 'A', permissions: 2 } })
      : Promise.resolve({
        items: [
          { mediaId: 1, mediaType: 'movie', tmdbId: 100, ratingKey: '55', title: 'Film', year: '2020', posterPath: '/p.jpg',
            downloads: [{ title: 'Film.2020.1080p', status: 'downloading', size: 1000, sizeLeft: 250, timeLeft: '00:12:00' }] },
          { mediaId: 2, mediaType: 'tv', tmdbId: 200, tvdbId: 300, ratingKey: null, title: 'Show',
            downloads: [
              { title: 'Show.S01E03', status: 'downloading', size: 100, sizeLeft: 100, timeLeft: '1.02:00:00', season: 1, episode: 3 },
              { title: 'Show.S01E02', status: 'completed', size: 100, sizeLeft: 0, season: 1, episode: 2 },
            ] },
          { mediaId: 3, mediaType: 'movie', tmdbId: 101, title: 'Stuck', downloads: [{ title: 'x', status: 'warning', size: 10, sizeLeft: 10 }] },
        ],
      }),
  });
  await O.signIn(ctx, 'https://seerr.example.com');
  const res = await O.downloads(ctx);
  eq(res.list.map((e) => e.id), ['movie-100', 'tv-200', 'movie-101'], 'sorted: downloading (soonest first), then stalled');
  const film = res.list[0];
  eq([film.progress, film.timeLeft, film.state], [0.75, 720, 'downloading'], 'movie progress');
  eq(O.progressLine(film), '75% · 12 min left', 'progress line');
  const show = res.list[1];
  eq([show.count, show.progress, show.state, O.episodeLabel(show.episodes)], [2, 0.5, 'downloading', 'S1 E2–E3'], 'show grouping');
  eq(show.timeLeft, 93600, 'day.hh:mm:ss time');
  eq(res.list[2].state, 'stalled', 'warning -> stalled');
  ok(O.matchDownload(res.list, { type: 'movie', ratingKey: '55' }) === film, 'match by ratingKey');
  ok(O.matchDownload(res.list, { type: 'tv', tvdb: '300' }) === show, 'match by tvdb');
  ok(O.matchDownload(res.list, { type: 'movie', tmdb: '200' }) === null, 'type must match');
  const again = await O.downloads(ctx);
  eq(ctx.calls.filter(([m]) => m === 'downloads').length, 1, 'cached for 20 s');
  ok(again.list === res.list, 'cache returns the same list');
  // badges
  const badges = await O.badges({ type: 'movie', ratingKey: '55', Guid: [] }, ctx);
  eq(badges, [{ label: 'Downloading 75%', tone: 'accent' }], 'movie badge');
  const epBadge = await O.badges({ type: 'episode', grandparentRatingKey: '9', parentIndex: 1, index: 2 }, ctx);
  // the show has no ratingKey in this list, so the show's Guids are needed and metadata() fails here
  eq(epBadge, [], 'episode badge needs show Guids; none when metadata is unavailable');
})().catch((e) => { failed++; console.log('FAIL downloads', e && e.stack); });

await (async () => {
  // the helper's /queue answer
  const { PL, O } = webContext();
  PL.storage.set('plugin.overseerr.config', { url: 'https://seerr.example.com', helperUrl: 'http://helper.example.com:8787', profiles: {} });
  let asked = null;
  const ctx = makeCtx(PL, {
    service: (m) => m === 'login' ? Promise.resolve({ url: 'https://seerr.example.com', user: { id: 1, displayName: 'A', permissions: 2 } }) : Promise.resolve({ items: [] }),
    http: (method, url) => { asked = url; return Promise.resolve({ version: 1, items: [
      { source: 'sonarr', mediaType: 'tv', tmdbId: 7, tvdbId: 8, title: 'Q Show', season: 2, episode: 1, releaseTitle: 'Q.S02E01', status: 'downloading', size: 200, sizeLeft: 50, timeLeftSeconds: 90 },
      { source: 'sonarr', mediaType: 'tv', tmdbId: 7, tvdbId: 8, title: 'Q Show', season: 2, episode: 2, releaseTitle: 'Q.S02E02', status: 'queued', size: 200, sizeLeft: 200 },
    ] }); },
  });
  await O.signIn(ctx, 'https://seerr.example.com');
  const res = await O.downloads(ctx, 0);
  eq(asked, 'http://helper.example.com:8787/queue', 'helper url');
  eq([res.source, res.list.length, res.list[0].count, res.list[0].progress], ['helper', 1, 2, 0.375], 'helper rows grouped per title');
})().catch((e) => { failed++; console.log('FAIL helper', e && e.stack); });

{
  const { O } = webContext();
  const reason = O.REASONS.filter((r) => r.id === 'audio-language')[0];
  const ep = { ratingKey: '77', Media: [{ Part: [{ file: '/data/tv/Show/Season 01/Show - S01E02.mkv' }] }] };
  const msg = O.message(reason, { season: 1, episode: 2, plexItem: ep }, null, { type: 'episode' });
  eq(msg.split('\n'), ['Wrong audio language', '', 'Reported from Plex Lite (S1 E2).', 'plexlite: reason=audio-language; scope=episode; season=1; episode=2; plex=77; file=Show - S01E02.mkv'], 'report message');
  const other = O.REASONS.filter((r) => r.id === 'other')[0];
  const m2 = O.message(other, { season: 0, episode: 0, plexItem: null }, 'no sound', { type: 'movie' });
  eq(m2.split('\n')[0], 'Something else: no sound', 'note text');
  ok(/scope=movie$/.test(m2), 'movie scope');
  eq(O.REASONS.map((r) => r.type), [1, 2, 2, 1, 4, 3, 4], 'issue types per reason');
}

{
  // actions only for viewers who may report
  const { PL, O } = webContext();
  const def = PL.def;
  PL.storage.set('plugin.overseerr.config', { url: 'https://seerr.example.com', profiles: {} });
  const ctx = makeCtx(PL, { service: () => Promise.resolve({}) });
  eq(def.actions({ type: 'movie' }, ctx).length, 0, 'not signed in: no Report');
  const cfg = PL.storage.get('plugin.overseerr.config');
  cfg.profiles[O.profileKey(ctx)] = { user: { id: 3, displayName: 'B', permissions: 32 } };
  PL.storage.set('plugin.overseerr.config', cfg);
  eq(def.actions({ type: 'movie' }, ctx).length, 0, 'REQUEST only: no Report');
  cfg.profiles[O.profileKey(ctx)].user.permissions = 32 | 4194304;
  PL.storage.set('plugin.overseerr.config', cfg);
  eq(def.actions({ type: 'episode' }, ctx).map((a) => a.label), ['Report a problem'], 'CREATE_ISSUES: Report');
  eq(def.actions({ type: 'person' }, ctx).length, 0, 'not for other types');
}

// ---- service (node, against a fake Overseerr) ----------------------------------------------------

await (async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || null, body });
      const send = (code, data, headers) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(data)); };
      if (req.url === '/api/v1/auth/plex') {
        const tok = JSON.parse(body).authToken;
        if (tok === 'stranger') return send(403, { message: 'Access denied.' });
        const id = tok === 'tok-a' ? 1 : 2;
        return send(200, { id, displayName: 'User' + id, permissions: id === 1 ? 2 : 32, plexToken: 'secret' }, { 'Set-Cookie': 'connect.sid=s%3Asess' + id + '; Path=/; HttpOnly; SameSite=Lax' });
      }
      const sess = /connect\.sid=s%3Asess(\d)/.exec(req.headers.cookie || '');
      if (!sess) return send(403, { message: 'You do not have permission to access this endpoint. auth' });
      if (req.url === '/api/v1/auth/me') return send(200, { id: Number(sess[1]), displayName: 'User' + sess[1], permissions: 4194304 });
      if (req.url.indexOf('/api/v1/media?filter=') === 0) {
        const f = /filter=(\w+)/.exec(req.url)[1];
        if (f === 'processing') return send(200, { results: [{ id: 10, mediaType: 'movie', tmdbId: 100, status: 3, downloadStatus: [{ title: 'R', status: 'downloading', size: 10, sizeLeft: 5, timeLeft: '00:01:00', downloadId: 'HASH' }] }, { id: 11, mediaType: 'movie', tmdbId: 101, status: 3, downloadStatus: [] }] });
        if (f === 'partial') return send(200, { results: [{ id: 12, mediaType: 'tv', tmdbId: 200, ratingKey: '9', status: 4, downloadStatus: [{ title: 'S', status: 'queued', size: 4, sizeLeft: 4, episode: { seasonNumber: 1, episodeNumber: 2, title: 'Two' } }] }] });
        return send(200, { results: [{ id: 10, mediaType: 'movie', tmdbId: 100, status: 5, downloadStatus: [{ title: 'dup', status: 'downloading', size: 1, sizeLeft: 1 }] }] });
      }
      if (req.url === '/api/v1/movie/100') return send(200, { title: 'Film', releaseDate: '2020-01-01', posterPath: '/p.jpg', credits: { cast: new Array(50).fill({ name: 'x' }) }, mediaInfo: { id: 10, status: 3, downloadStatus: [], issues: [{ id: 4, status: 1, issueType: 2, problemSeason: 0, problemEpisode: 0, createdAt: '2026-01-01T00:00:00Z' }, { id: 5, status: 2, issueType: 1 }] } });
      if (req.url === '/api/v1/tv/200') return send(200, { name: 'Show', firstAirDate: '2019-05-05', posterPath: '/s.jpg' });
      return send(404, { message: 'nope' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const stateFile = '/tmp/com.bednal.plexlite.service.json';
  const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  if (backup) fs.unlinkSync(stateFile);
  const handlers = {};
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'webos-service') return function Service() { this.register = (name, fn) => { handlers[name] = fn; }; };
    return origLoad.apply(this, arguments);
  };
  const require = Module.createRequire(import.meta.url);
  require(path.join(ROOT, 'plugins/overseerr/service/service.js'));
  Module._load = origLoad;
  const callSvc = (name, payload) => new Promise((resolve) => handlers[name]({ payload, respond: resolve }));

  try {
    let r = await callSvc('login', { url: base + '/some/path', plexToken: 'tok-a', key: 'o-aaaa' });
    eq([r.returnValue, r.user.displayName, r.url], [true, 'User1', base], 'login A');
    ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('sess'), 'login answer has no token or cookie');
    r = await callSvc('login', { url: base, plexToken: 'tok-b', key: 'p-kid' });
    eq(r.user.permissions, 32, 'login B');
    r = await callSvc('login', { url: base, plexToken: 'stranger', key: 'p-x' });
    eq([r.returnValue, r.errorCode], [false, 'forbidden'], 'Overseerr refuses an unknown Plex user');
    r = await callSvc('login', { url: base, plexToken: 'tok-a', key: 'bad key!' });
    eq(r.errorCode, 'bad_request', 'bad key rejected');

    seen.length = 0;
    await callSvc('request', { key: 'p-kid', method: 'GET', path: '/auth/me' });
    await callSvc('request', { key: 'o-aaaa', method: 'GET', path: '/auth/me' });
    eq(seen.map((s) => s.cookie), ['connect.sid=s%3Asess2', 'connect.sid=s%3Asess1'], 'each profile uses its own cookie');
    r = await callSvc('request', { key: 'p-nobody', method: 'GET', path: '/auth/me' });
    eq(r.errorCode, 'unauthenticated', 'unknown profile has no session');
    r = await callSvc('request', { key: 'o-aaaa', method: 'GET', path: '/../x' });
    eq(r.errorCode, 'bad_request', 'path traversal rejected');
    r = await callSvc('status', { key: 'p-kid' });
    eq([r.signedIn, r.user.permissions], [true, 4194304], 'status refreshes permissions');

    r = await callSvc('downloads', { key: 'o-aaaa' });
    eq(r.items.map((i) => i.mediaId), [10, 12], 'downloads: only items with downloads, de-duplicated');
    eq([r.items[0].title, r.items[0].year, r.items[0].downloads[0].timeLeft], ['Film', '2020', '00:01:00'], 'title lookup + trimmed rows');
    eq([r.items[1].downloads[0].season, r.items[1].downloads[0].episode, r.items[1].ratingKey], [1, 2, '9'], 'episode fields');
    ok(!JSON.stringify(r).includes('HASH'), 'download ids are not passed on');
    const before = seen.length;
    await callSvc('downloads', { key: 'o-aaaa' });
    eq(seen.length, before, 'downloads cached for 5 s');

    r = await callSvc('lookup', { key: 'o-aaaa', mediaType: 'movie', tmdbId: 100 });
    eq([r.media.mediaId, r.media.issues.length, r.media.issues[0].issueType], [10, 1, 2], 'lookup: media id + open issues only');
    ok(JSON.stringify(r).length < 1000, 'lookup answer is compact');
    r = await callSvc('lookup', { key: 'o-aaaa', mediaType: 'movie', tmdbId: '1; DROP' });
    eq(r.errorCode, 'bad_request', 'lookup validates the id');

    r = await callSvc('logout', { key: 'p-kid' });
    r = await callSvc('request', { key: 'p-kid', method: 'GET', path: '/auth/me' });
    eq(r.errorCode, 'unauthenticated', 'logout drops that profile');
    r = await callSvc('request', { key: 'o-aaaa', method: 'GET', path: '/auth/me' });
    eq(r.status, 200, 'other profile still signed in');
    const mode = fs.statSync(stateFile).mode & 0o777;
    eq(mode, 0o600, 'state file is 0600');
  } finally {
    server.close();
    try { fs.unlinkSync(stateFile); } catch (e) { /* none */ }
    if (backup) fs.writeFileSync(stateFile, backup, { mode: 0o600 });
  }
})().catch((e) => { failed++; console.log('FAIL service', e && e.stack); });

console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
