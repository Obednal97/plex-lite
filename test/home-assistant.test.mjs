// Tests for the Home Assistant plugin (plugins/home-assistant/plugin.js): webhook URL checks, the
// local → remote routes and the remembered route, the form body Home Assistant's webhook trigger
// reads, Movie mode's debounce and content filter, and a run against a fake Home Assistant that
// handles webhooks the way Home Assistant does (form fields → trigger.data, 200 for everything).
//   node --test test/home-assistant.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const J = (v) => JSON.parse(JSON.stringify(v));

function load({ isWeb = false, fetchImpl } = {}) {
  const store = {};
  const warnings = [];
  const toasts = [];
  const timers = [];
  let now = 1000;
  const ctx = {
    console,
    document: { hidden: false },
    setTimeout: (fn, ms) => { const t = { fn, at: now + (ms || 0) }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cancelled = true; },
  };
  if (fetchImpl) ctx.fetch = fetchImpl;
  ctx.window = ctx;
  ctx.PL = {
    isWeb,
    storage: {
      get: (k, d) => (k in store ? JSON.parse(store[k]) : d),
      set: (k, v) => { store[k] = JSON.stringify(v); },
      del: (k) => { delete store[k]; },
    },
    warn: (...a) => warnings.push(a.join(' ')),
    log() {},
    toast: (m) => toasts.push(m),
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/plugins.js'), ctx);
  vm.runInContext(read('plugins/home-assistant/plugin.js'), ctx);
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.done = true;
      due.fn();
    }
    now = until;
  };
  return { ctx, PL: ctx.PL, HA: ctx.PL.homeAssistant, store, warnings, toasts, advance, clock: { get now() { return now; }, set now(v) { now = v; } } };
}

const LOCAL = 'http://homeassistant.local:8123/api/webhook/plexlite-test-hook';
const REMOTE = 'https://hooks.nabu.casa/gAAAAABexampleexampleexample';
const film = (event, extra = {}) => ({ event, at: 1, positionMs: 0, item: { type: 'movie', kind: 'movie', title: 'Sintel', genres: [], isKids: false, ...extra } });
const episode = (event) => ({ event, at: 1, positionMs: 0, item: { type: 'episode', kind: 'series', title: 'Llama Drama', genres: [], isKids: true } });
const live = (event) => ({ event, at: 1, positionMs: null, item: { type: 'live', kind: 'live', title: 'News', channel: 'News 24', liveCategory: 'news', genres: [], isKids: false } });

test('home assistant: webhook URLs are checked and cleaned', () => {
  const { HA } = load();
  assert.equal(HA.parseWebhook(' ' + LOCAL + '/ ', 'local'), LOCAL);
  assert.equal(HA.parseWebhook('192.168.0.20:8123/api/webhook/abc_DEF-1', 'local'), 'http://192.168.0.20:8123/api/webhook/abc_DEF-1', 'a bare host gets http://');
  assert.equal(HA.parseWebhook('HTTPS://Home.Example.com/api/webhook/x1', 'remote'), 'https://home.example.com/api/webhook/x1');
  assert.equal(HA.parseWebhook(REMOTE, 'remote'), REMOTE);
  assert.throws(() => HA.parseWebhook('', 'local'), /Enter the webhook URL/);
  assert.throws(() => HA.parseWebhook('http://homeassistant.local:8123', 'local'), /ends in \/api\/webhook\//);
  assert.throws(() => HA.parseWebhook('http://ha.local:8123/api/services/light/turn_on', 'local'), /ends in \/api\/webhook\//);
  assert.throws(() => HA.parseWebhook('http://home.example.com/api/webhook/x', 'remote'), /has to start with https/);
  assert.throws(() => HA.parseWebhook('ftp://ha/api/webhook/x', 'local'), /isn't a web address/);
  assert.throws(() => HA.parseWebhook(REMOTE, 'local'), /Nabu Casa address/);
  assert.throws(() => HA.parseWebhook('https://hooks.nabu.casa/', 'remote'), /whole Nabu Casa/);
  assert.equal(HA.mask(LOCAL), 'homeassistant.local:8123', 'never the id');
  assert.equal(HA.mask(REMOTE), 'hooks.nabu.casa');
});

test('home assistant: routes: local first on the TV, the remembered one for 10 minutes, remote only in a browser', () => {
  const { HA } = load();
  const both = { localUrl: LOCAL, remoteUrl: REMOTE };
  assert.deepEqual(J(HA.routes(both, null, 0, false)), ['local', 'remote']);
  assert.deepEqual(J(HA.routes(both, { route: 'remote', until: 100 }, 50, false)), ['remote', 'local']);
  assert.deepEqual(J(HA.routes(both, { route: 'remote', until: 100 }, 101, false)), ['local', 'remote'], 'forgotten after 10 minutes');
  assert.deepEqual(J(HA.routes({ localUrl: LOCAL }, null, 0, false)), ['local']);
  assert.deepEqual(J(HA.routes(both, null, 0, true)), ['remote']);
  assert.deepEqual(J(HA.routes({ localUrl: LOCAL }, null, 0, true)), []);
  assert.equal(HA.settingsValue({ localUrl: LOCAL, movieMode: true }, true), 'Needs a remote URL');
  assert.equal(HA.settingsValue({ localUrl: LOCAL, movieMode: true }, false), 'Movie mode on');
  assert.equal(HA.settingsValue({}, false), 'Not set up');
});

test('home assistant: deliver: a quick local try, then remote, remembered; one route waits longer', async () => {
  const { HA, clock } = load();
  const calls = [];
  let localUp = false;
  const post = (url, body, timeout) => {
    calls.push([url === LOCAL ? 'local' : 'remote', timeout]);
    return url === LOCAL && !localUp ? Promise.reject(new Error('no answer')) : Promise.resolve();
  };
  const memo = { route: null, until: 0 };
  const deps = { post, isWeb: false, now: () => clock.now };
  const cfg = { localUrl: LOCAL, remoteUrl: REMOTE };
  assert.deepEqual(J(await HA.deliver(cfg, film('play'), memo, deps)), { route: 'remote' });
  assert.deepEqual(calls, [['local', HA.LOCAL_TIMEOUT_MS], ['remote', HA.TIMEOUT_MS]]);
  assert.equal(HA.LOCAL_TIMEOUT_MS, 1500);
  calls.length = 0;
  await HA.deliver(cfg, film('pause'), memo, deps);
  assert.deepEqual(calls, [['remote', HA.TIMEOUT_MS]], 'the route that worked goes first: no 1.5 s wait during playback');
  clock.now += HA.REMEMBER_MS + 1;
  localUp = true;
  calls.length = 0;
  assert.deepEqual(J(await HA.deliver(cfg, film('resume'), memo, deps)), { route: 'local' });
  assert.deepEqual(calls, [['local', HA.LOCAL_TIMEOUT_MS]]);
  calls.length = 0;
  await HA.deliver({ localUrl: LOCAL }, film('stop'), memo, deps);
  assert.deepEqual(calls, [['local', HA.TIMEOUT_MS]], 'nothing to fall back to: the local one gets the full wait');
  localUp = false;
  await assert.rejects(HA.deliver(cfg, film('stop'), { route: null, until: 0 }, { post: () => Promise.reject(new Error('x')), isWeb: false }), /No answer, local or remote/);
  await assert.rejects(HA.deliver({ localUrl: LOCAL }, film('stop'), memo, { post, isWeb: true }), /Add a remote webhook URL to use this in a browser/);
});

test('home assistant: the body is a simple form (no preflight) with the event, the item and the whole event as JSON', () => {
  const { HA } = load();
  const ev = { event: 'play', at: 1700000000000, positionMs: 12000, source: 'plexlite', item: { type: 'episode', kind: 'series', title: 'Llama Drama & Co', showTitle: 'Caminandes', season: 1, episode: 2, genres: ['Animation', 'Comedy'], isKids: true, contentRating: 'TV-G' } };
  const f = new URLSearchParams(HA.formBody(ev));
  assert.equal(f.get('event'), 'play');
  assert.equal(f.get('source'), 'plexlite');
  assert.equal(f.get('kind'), 'series');
  assert.equal(f.get('title'), 'Llama Drama & Co');
  assert.equal(f.get('show_title'), 'Caminandes');
  assert.equal(f.get('season'), '1');
  assert.equal(f.get('genres'), 'Animation, Comedy');
  assert.equal(f.get('is_kids'), 'true');
  assert.equal(f.get('position_ms'), '12000');
  assert.equal(f.get('channel'), null, 'empty fields are left out');
  assert.deepEqual(JSON.parse(f.get('payload')), ev);
});

function movieMode(HA, cfg) {
  const sent = [];
  const timers = [];
  let hidden = false;
  const m = new HA.MovieMode({
    config: () => ({ movieMode: true, trigger: 'films-shows', delaySec: 5, ...cfg }),
    send: (ev) => sent.push(ev.event),
    hidden: () => hidden,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cancelled = true; },
  });
  const fire = () => { const t = timers.filter((x) => !x.cancelled && !x.done).pop(); if (t) { t.done = true; t.fn(); } return t; };
  return { m, sent, fire, timers, setHidden: (v) => { hidden = v; } };
}

test('movie mode: a pause then resume within the delay sends nothing; a longer pause brings the lights back', () => {
  const { HA } = load();
  const { m, sent, fire, timers } = movieMode(HA);
  m.onEvent(film('play'));
  m.onEvent(film('pause'));
  assert.equal(timers[0].ms, 5000);
  m.onEvent(film('resume'));
  assert.deepEqual(sent, ['play']);
  assert.equal(fire(), undefined, 'the wait was cancelled');
  m.onEvent(film('pause'));
  fire();
  assert.deepEqual(sent, ['play', 'pause']);
  m.onEvent(film('resume'));
  m.onEvent(film('stop'));
  fire();
  assert.deepEqual(sent, ['play', 'pause', 'resume', 'stop']);
  m.onEvent(film('stop'));
  assert.deepEqual(sent, ['play', 'pause', 'resume', 'stop'], 'lights already up: nothing more');
});

test('movie mode: the next episode within the delay keeps the lights down; a stop after a pause goes out once', () => {
  const { HA } = load();
  const { m, sent, fire } = movieMode(HA);
  m.onEvent(episode('play'));
  m.onEvent(episode('ended'));
  m.onEvent(episode('play'));
  assert.deepEqual(sent, ['play']);
  m.onEvent(episode('pause'));
  m.onEvent(episode('stop'));
  fire();
  assert.deepEqual(sent, ['play', 'stop']);
});

test('movie mode: which content dims, at once with no delay, and while the app closes', () => {
  const { HA } = load();
  const films = movieMode(HA, { trigger: 'films' });
  films.m.onEvent(episode('play'));
  films.m.onEvent(live('play'));
  films.m.onEvent(film('play', { type: 'clip', kind: null }));
  assert.deepEqual(films.sent, [], 'films only: shows, Live TV and trailers leave the lights alone');
  const shows = movieMode(HA, { trigger: 'films-shows', delaySec: 0 });
  shows.m.onEvent(live('play'));
  shows.m.onEvent(episode('play'));
  shows.m.onEvent(episode('pause'));
  assert.deepEqual(shows.sent, ['play', 'pause'], 'delay 0: at once');
  const all = movieMode(HA, { trigger: 'everything' });
  all.m.onEvent(live('play'));
  all.setHidden(true);
  all.m.onEvent(live('stop'));
  assert.deepEqual(all.sent, ['play', 'stop'], 'the app is leaving: no waiting for a timer that may never run');
  const off = movieMode(HA, { movieMode: false });
  off.m.onEvent(film('play'));
  assert.deepEqual(off.sent, []);
  // switched off while the lights are down: they still come back
  let on = true;
  const sent = [];
  const sw = new HA.MovieMode({ config: () => ({ movieMode: on, trigger: 'films', delaySec: 0 }), send: (ev) => sent.push(ev.event) });
  sw.onEvent(film('play'));
  on = false;
  sw.onEvent(film('stop'));
  assert.deepEqual(sent, ['play', 'stop']);
});

// A stand-in for Home Assistant's webhook handling (homeassistant/components/webhook): POST/PUT
// only, form fields become trigger.data, every call is answered 200 (even an unknown id), and the
// webhook view allows CORS from any origin (aiohttp_cors echoes the Origin, preflights included).
function fakeHomeAssistant(hookId) {
  const got = [];
  const server = http.createServer((req, res) => {
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(200).end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = /^\/api\/webhook\/(.+)$/.exec(req.url);
      if (m && m[1] === hookId && (req.method === 'POST' || req.method === 'PUT')) {
        const ct = req.headers['content-type'] || '';
        got.push(ct.includes('json') ? { json: JSON.parse(body || '{}') } : { data: Object.fromEntries(new URLSearchParams(ct.includes('form-urlencoded') ? body : '')) , contentType: ct });
      }
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })));
}

test('plugin: playback events reach a fake Home Assistant as trigger.data, through PL.plugins', async () => {
  const ha = await fakeHomeAssistant('plexlite-test-hook');
  // node's fetch, minus the browser-only mode
  const fetchImpl = (url, opts) => fetch(url, { method: opts.method, headers: opts.headers, body: opts.body });
  const env = load({ fetchImpl });
  const { PL, store } = env;
  const local = `http://127.0.0.1:${ha.port}/api/webhook/plexlite-test-hook`;
  PL.storage.set('plugin.home-assistant.config', { localUrl: local, movieMode: true, trigger: 'films-shows', delaySec: 5 });
  const rows = PL.plugins.settingsRows(() => {});
  assert.equal(rows[0].label, 'Home Assistant');
  assert.equal(rows[0].value, 'Movie mode on');
  const s = PL.plugins.playbackSession();
  const wait = () => new Promise((r) => setTimeout(r, 120));
  s.playing('901', { type: 'movie', title: 'Sintel', year: 2010, duration: 888000, Genre: [{ tag: 'Animation' }], contentRating: 'PG-13' }, false, 0);
  env.advance(200);
  await wait();
  s.paused(4000);
  env.advance(200);
  env.advance(3000);
  s.playing('901', { type: 'movie', title: 'Sintel' }, false, 4000); // resumed within 5 s: nothing
  env.advance(200);
  s.stopped(9000);
  env.advance(200);
  env.advance(5000);
  await wait();
  assert.deepEqual(ha.got.map((g) => g.data.event), ['play', 'stop']);
  assert.match(ha.got[0].contentType, /application\/x-www-form-urlencoded/);
  assert.deepEqual([ha.got[0].data.kind, ha.got[0].data.title, ha.got[0].data.genres, ha.got[0].data.source], ['movie', 'Sintel', 'Animation', 'plexlite']);
  assert.equal(JSON.parse(ha.got[1].data.payload).positionMs, 9000);
  const st = JSON.parse(store['plugin.home-assistant.status']);
  assert.equal(st.last.event, 'stop');
  assert.equal(st.last.route, 'local');
  assert.match(env.HA.lastSentLine(st), /^stop · \d\d:\d\d · local$/);
  ha.server.close();
});

test('plugin: during playback a failure is only logged and kept for the settings page', async () => {
  const env = load({ fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
  const { PL, store, toasts, warnings } = env;
  PL.storage.set('plugin.home-assistant.config', { localUrl: LOCAL, movieMode: true, delaySec: 0 });
  PL.plugins.settingsRows(() => {});
  const s = PL.plugins.playbackSession();
  s.playing('901', { type: 'movie', title: 'Sintel' }, false, 0);
  env.advance(200);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(toasts, [], 'nothing over the picture');
  assert.ok(warnings.some((w) => /could not send play: No answer from Home Assistant/.test(w)));
  assert.ok(!warnings.some((w) => w.includes('plexlite-test-hook')), 'the webhook id is never logged');
  const st = JSON.parse(store['plugin.home-assistant.status']);
  assert.equal(st.error.message, 'No answer from Home Assistant');
});
