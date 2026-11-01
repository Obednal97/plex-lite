// Tests for the Home server helper plugin (plugins/home-helper): PL.homeHelper's address, migration
// from Overseerr's "Download queue address", /healthz, the auth header on actions, error codes, the
// web's mixed-content case and the Settings row. Runs against the fake helper (tools/demo/helper.mjs).
//   node --test test/home-helper.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEnv, plexItem, movie, show, ids, tick } from './fixtures/helper-env.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

test('home helper: addresses get http:// and port 8787 unless typed', async () => {
  const env = await makeEnv({ noHelper: true });
  const n = env.H.normalizeUrl;
  assert.equal(n('homeserver.local'), 'http://homeserver.local:8787');
  assert.equal(n('  HomeServer.Local:9000/ '), 'http://homeserver.local:9000');
  assert.equal(n('https://home.example.com/helper/'), 'https://home.example.com/helper');
  assert.equal(n('http://helper.example.com'), 'http://helper.example.com', 'a typed scheme without a port is kept');
  assert.throws(() => n(''), /Enter/);
  assert.throws(() => n('not an address!'), /doesn't look/);
});

test('home helper: adopts Overseerr\'s download queue address once', async () => {
  const env = await makeEnv({ noHelper: true, overseerrConfig: { url: 'https://seerr.example.com', helperUrl: 'http://helper.example.com:8787', profiles: {} } });
  assert.equal(env.H.url(), 'http://helper.example.com:8787');
  assert.equal(env.store['plugin.home-helper.url'], 'http://helper.example.com:8787');
  assert.equal(env.store['plugin.home-helper.migrated'], true);
  // Overseerr's own copy is deleted once adopted: its plugin reads PL.homeHelper.url() only
  assert.equal(env.store['plugin.overseerr.config'].helperUrl, undefined);
  assert.equal(env.store['plugin.overseerr.config'].url, 'https://seerr.example.com', 'the rest of its config stays');
  // removing the shared address doesn't bring Overseerr's back
  env.H.setUrl(null);
  assert.equal(env.H.url(), null);
});

test('home helper: an address already set wins over Overseerr\'s', async () => {
  const env = await makeEnv({ noHelper: true, overseerrConfig: { url: 'https://seerr.example.com', helperUrl: 'http://old.example.com:8787', profiles: {} } });
  env.H.setUrl('http://new.example.com:8787');
  assert.equal(env.H.url(), 'http://new.example.com:8787');
  const env2 = await makeEnv({ noHelper: true, overseerrConfig: { url: 'https://seerr.example.com', profiles: {} } });
  assert.equal(env2.H.url(), null, 'nothing to adopt');
  assert.equal(env2.store['plugin.home-helper.migrated'], undefined, 'a later Overseerr address can still be adopted');
});

test('home helper: switched off, it has no address and the others hide', async () => {
  const env = await makeEnv({ disabled: ['home-helper'] });
  assert.equal(env.H.url(), null);
  assert.equal(await env.H.health(), null);
  assert.equal(env.http.length, 0, 'no request');
  await env.close();
});

test('home helper: /healthz is cached and shared, and says which services are up', async () => {
  const env = await makeEnv({ services: { bazarr: false } });
  const [a, b] = await Promise.all([env.H.health(), env.H.health()]);
  assert.deepEqual(clone(a.services), { seerr: false, sonarr: true, radarr: true, bazarr: false, plex: true });
  assert.equal(a.dryRun, false);
  assert.equal(a.paused, false);
  assert.equal(a, b);
  await env.H.health();
  assert.equal(env.helper.log.filter((l) => l.path === '/healthz').length, 1, 'one request');
  assert.equal(env.H.has('sonarr'), true);
  assert.equal(env.H.has('bazarr'), false);
  assert.equal(env.H.servicesLine(a), 'Sonarr, Radarr');
  await env.H.health(0);
  assert.equal(env.helper.log.filter((l) => l.path === '/healthz').length, 2, 'maxAge 0 asks again');
  assert.equal(env.helper.log[0].token, null, 'reads carry no token');
  await env.close();
});

test('home helper: unreachable is null, and isn\'t asked again at once', async () => {
  const env = await makeEnv({ noHelper: true });
  env.H.setUrl('http://127.0.0.1:9');
  assert.equal(await env.H.health(), null);
  assert.equal(await env.H.health(), null);
  assert.equal(env.http.length, 1);
  assert.equal(env.H.checked(), true);
  assert.equal(env.H.has('sonarr'), false);
});

test('home helper: actions carry the active profile\'s Plex token, as JSON', async () => {
  const env = await makeEnv();
  const ctx = env.def('whats-coming').ctx;
  const tvdb = Number(ids(show('nasa-explorers')).tvdb);
  const r = await env.H.post('/missing/search', { tvdbId: tvdb }, ctx);
  assert.equal(r.queued, true);
  const call = env.helper.log.find((l) => l.path === '/missing/search' && l.method === 'POST');
  assert.equal(call.token, 'demo-owner-token');
  assert.match(call.contentType, /^application\/json/);
  // a Home profile switch changes the token the next action sends
  env.PL.plex.token = 'demo-kid-token';
  await env.H.post('/missing/search', { tvdbId: tvdb }, ctx);
  assert.equal(env.helper.log.filter((l) => l.method === 'POST').pop().token, 'demo-kid-token');
  await env.close();
});

test('home helper: the contract\'s errors become codes and plain messages', async () => {
  const env = await makeEnv({ services: { bazarr: false } });
  const ctx = env.def('bazarr').ctx;
  env.PL.plex.token = 'not-a-plex-token';
  let err = await env.H.post('/missing/search', { tvdbId: 1 }, ctx).catch((e) => e);
  assert.equal(err.code, 'unauthenticated');
  assert.equal(env.H.errorText(err), 'The helper didn\'t accept your Plex sign-in');
  env.PL.plex.token = 'demo-owner-token';
  err = await env.H.get('/subtitles?type=movie&tmdbId=1').catch((e) => e);
  assert.equal(err.code, 'unavailable');
  assert.equal(env.H.errorText(err, 'Bazarr'), 'Bazarr isn\'t available on the helper right now');
  err = await env.H.get('/missing?tvdbId=1').catch((e) => e);
  assert.equal(err.code, 'not_found');
  // 20 actions per 10 minutes per token, then 429
  const tvdb = Number(ids(show('nasa-explorers')).tvdb);
  for (let i = 0; i < 20; i++) await env.H.post('/missing/search', { tvdbId: tvdb }, ctx).catch(() => {});
  err = await env.H.post('/missing/search', { tvdbId: tvdb }, ctx).catch((e) => e);
  assert.equal(err.code, 'rate_limited');
  assert.match(env.H.errorText(err), /Too many requests/);
  env.PL.plex.token = null;
  err = await env.H.post('/missing/search', { tvdbId: tvdb }, ctx).catch((e) => e);
  assert.equal(err.code, 'unauthenticated', 'no token, no request');
  await env.close();
});

test('home helper: an http helper from an https web page is blocked without a request', async () => {
  const env = await makeEnv({ noHelper: true, web: true, pageProtocol: 'https:' });
  env.H.setUrl('http://homeserver.local:8787');
  assert.equal(env.H.blocked(env.H.url()), 'mixed');
  assert.equal(await env.H.health(), null);
  const err = await env.H.get('/coming').catch((e) => e);
  assert.equal(err.code, 'blocked');
  assert.equal(env.http.length, 0);
  assert.equal(env.H.blocked('https://home.example.com/helper'), null, 'an https helper can be tried');
  // the web build's Content-Security-Policy (connect-src https:, upgrade-insecure-requests) lets no
  // http request out, localhost included
  assert.equal(env.H.blocked('http://localhost:8787'), 'mixed', 'localhost is blocked too');
  assert.equal(env.H.blocked('http://127.0.0.1:8787'), 'mixed');
  const row = env.PL.plugins.settingsRows(() => {}).find((r) => r.label === 'Home server helper');
  assert.equal(row.value, 'Not available in this browser');
});

test('home helper: onChange fires for a new address and for a change in services', async () => {
  const env = await makeEnv();
  const seen = [];
  const off = env.H.onChange((info) => seen.push(info.health ? Object.keys(info.health.services).filter((k) => info.health.services[k]).join(',') : String(info.url)));
  await env.H.health();
  env.helper.services.radarr = false;
  await env.H.health(0);
  await env.H.health(0);
  env.H.setUrl(null);
  off();
  env.H.setUrl(env.url);
  assert.deepEqual(seen, ['sonarr,radarr,bazarr,plex', 'sonarr,bazarr,plex', 'null']);
  await env.close();
});

test('home helper: the Settings row shows the status and edits the address', async () => {
  const env = await makeEnv({ noHelper: true });
  const rows = () => env.PL.plugins.settingsRows(() => {});
  const row = () => rows().find((r) => r.label === 'Home server helper');
  assert.equal(row().value, 'Not set up');
  row().action();
  const sheet = env.sheets().pop();
  assert.equal(sheet.sections[0].rows[0].label, 'Set up the helper');
  sheet.sections[0].rows[0].action();
  const entry = env.pushed.pop();
  assert.equal(entry.kind, 'text');
  assert.equal(entry.onDone('???'), false, 'a bad address keeps the keyboard open');
  await env.close();

  const live = await makeEnv({ setUrl: false });
  const liveRow = () => live.PL.plugins.settingsRows(() => {}).find((r) => r.label === 'Home server helper');
  const text = (() => { liveRow().action(); return live.pushed.pop(); })();
  assert.equal(text.kind, 'sheet');
  text.sections[0].rows[0].action();
  const entry2 = live.pushed.pop();
  assert.equal(entry2.onDone(live.url.replace('http://', '')), true);
  assert.equal(live.H.url(), live.url.replace(/:(\d+)$/, ':$1'), 'typed host:port kept');
  await tick(20);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(liveRow().value, 'Connected · Sonarr, Radarr, Bazarr');
  assert.ok(live.toasts.includes('Connected · Sonarr, Radarr, Bazarr'));
  // a spinner toast was shown while checking
  assert.ok(live.toasts.includes('Checking the helper…'));
  await live.close();
  live.H.setUrl('http://127.0.0.1:9');
  await live.H.health();
  assert.equal(liveRow().value, 'Can\'t reach the helper');
});

test('home helper: titleIds names movies, episodes and seasons as the contract does', async () => {
  const env = await makeEnv({ noHelper: true });
  const ctx = env.def('bazarr').ctx;
  const m = movie('sintel');
  assert.deepEqual(clone(await env.H.titleIds(ctx, plexItem(m.ratingKey))), { type: 'movie', tmdbId: Number(ids(m).tmdb), title: 'Sintel', label: 'Sintel' });
  const s = show('caminandes');
  const ep = s._seasons[0]._episodes[1];
  const got = await env.H.titleIds(ctx, plexItem(ep.ratingKey));
  assert.deepEqual(clone(got), { type: 'episode', tvdbId: Number(ids(s).tvdb), title: 'Caminandes', season: 1, episode: 2, label: 'Caminandes · S1 E2' });
  await env.H.titleIds(ctx, plexItem(s._seasons[0]._episodes[2].ratingKey));
  assert.equal(env.plexCalls.filter((c) => c[0] === 'metadata' && c[1] === s.ratingKey).length, 1, 'the show\'s ids are looked up once');
  const season = await env.H.titleIds(ctx, plexItem(s._seasons[0].ratingKey));
  assert.equal(season.season, 1);
  // a hub card without Guids: the movie is looked up
  const bare = plexItem(m.ratingKey);
  delete bare.Guid;
  assert.equal((await env.H.titleIds(ctx, bare)).tmdbId, Number(ids(m).tmdb));
});

test('home helper: the helper page says when the helper is in dry run', async () => {
  const env = await makeEnv({ setUrl: true });
  env.helper.state.dryRun = true;
  const row = () => env.PL.plugins.settingsRows(() => {}).find((r) => r.label === 'Home server helper');
  row().action();
  await new Promise((r) => setTimeout(r, 60));
  const sheet = env.sheets().pop();
  const labels = sheet.sections[0].rows.map((r) => r.label);
  assert.equal(labels[0], 'Connected');
  assert.ok(labels.includes('Dry run: nothing is changed yet'));
  assert.equal((await env.H.health()).dryRun, true);
  await env.close();
});

// ---- With Overseerr loaded too (index.html's order), as on the TV ------------------------------------

const queueCalls = (env) => env.http.filter((c) => /\/queue$/.test(c.url));

test('home helper + Overseerr: the old Download queue address is adopted, then only the shared one counts', async () => {
  const env = await makeEnv({ overseerr: true, setUrl: false, overseerrConfig: { url: 'https://seerr.example.com', helperUrl: 'http://old.example.com:8787', profiles: {} } });
  const ctx = env.def('overseerr').ctx;
  assert.equal(env.O.helperUrl(ctx), 'http://old.example.com:8787', 'adopted');
  assert.equal(env.store['plugin.overseerr.config'].helperUrl, undefined, 'and deleted from Overseerr');
  // Remove the helper: Overseerr has no helper either
  env.H.setUrl(null);
  assert.equal(env.O.helperUrl(ctx), null);
  await env.O.downloads(ctx, 0).catch(() => null);
  assert.equal(queueCalls(env).length, 0, 'no /queue call');
  await env.close();
});

test('home helper + Overseerr: switching the Home server helper off stops Overseerr calling /queue', async () => {
  const env = await makeEnv({ overseerr: true });
  const ctx = env.def('overseerr').ctx;
  const got = await env.O.downloads(ctx, 0);
  assert.equal(got.source, 'helper');
  assert.equal(queueCalls(env).length, 1, 'the shared address feeds Downloading');
  env.PL.plugins.setEnabled('home-helper', false);
  assert.equal(env.O.helperUrl(ctx), null);
  await env.O.downloads(ctx).catch(() => null);
  assert.equal(queueCalls(env).length, 1, 'no /queue call (nor the helper\'s list from the cache)');
  assert.equal(env.O.downloadsKnown(ctx), null, 'nothing known for "no helper" yet');
  await env.close();
});

test('home helper + Overseerr: an http helper from an https web page is never called', async () => {
  const env = await makeEnv({ overseerr: true, noHelper: true, web: true, pageProtocol: 'https:' });
  const ctx = env.def('overseerr').ctx;
  env.H.setUrl('http://homeserver.local:8787');
  assert.equal(env.O.helperUrl(ctx), null);
  await env.O.downloads(ctx, 0).catch(() => null);
  assert.equal(queueCalls(env).length, 0);
  await env.close();
});

test('home helper: the busy spinner goes with idle() (it would keep spinning in a hidden toast)', async () => {
  const env = await makeEnv({ noHelper: true });
  env.H.busy('Checking subtitles…');
  env.H.busy('Finding English subtitles…');
  assert.equal(env.toastNode.children.filter((c) => c.cls === 'hh-spin').length, 1, 'one spinner');
  env.H.idle();
  assert.equal(env.toastNode.children.length, 0, 'spinner removed');
  assert.ok(!env.toastNode.classList.set.has('show'), 'toast hidden');
  // a plain toast showing now isn't hidden by a late idle()
  env.PL.toast('Saved');
  env.H.idle();
  assert.ok(env.toastNode.classList.set.has('show'));
});
