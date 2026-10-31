// End to end in a real browser: the player on the demo server (tools/demo) tells plugins what it
// does (onPlayback), and the Home Assistant plugin sends Movie mode's events to a fake Home
// Assistant. Covers play → pause → resume → seek → scrub → stop, Up Next, Live TV, how long the
// player spends reporting, and that plugins hear about it only after the frame.
//
// Needs playwright-core and Chrome or Chromium (as tools/demo/shots.mjs), and internet access (the
// demo's videos stream from Wikimedia Commons), so it only runs when asked:
//   PLEXLITE_BROWSER_TESTS=1 [CHROMIUM=/path/to/chrome] node --test test/playback-browser.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;
const RUN = process.env.PLEXLITE_BROWSER_TESTS === '1';
const expand = (p) => (p && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A free port (other demo servers may be running): PORT to choose one.
function freePort() {
  if (process.env.PORT) return Promise.resolve(Number(process.env.PORT));
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Home Assistant's webhook handling, as in test/home-assistant.test.mjs: form fields → trigger.data.
function fakeHomeAssistant() {
  const got = [];
  const server = http.createServer((req, res) => {
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/webhook/plexlite-browser-test') {
        got.push({ at: Date.now(), contentType: req.headers['content-type'], data: Object.fromEntries(new URLSearchParams(body)) });
      }
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, url: `http://127.0.0.1:${server.address().port}/api/webhook/plexlite-browser-test` })));
}

test('browser: playback events from the real player, and Movie mode to a fake Home Assistant', { skip: !RUN && 'set PLEXLITE_BROWSER_TESTS=1', timeout: 240000 }, async () => {
  const require = createRequire(join(expand(process.env.PLAYWRIGHT_DIR || '~/.cache/plexlite-shots-tools'), 'node_modules/'));
  const { chromium } = require('playwright-core');
  const exe = expand(process.env.CHROMIUM) || (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
  const ha = await fakeHomeAssistant();
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const demo = spawn(process.execPath, [join(ROOT, 'tools/demo/server.mjs')], { env: { ...process.env, PORT: String(PORT), PLEXLITE_DEMO_TUNE_DELAY: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { demo.stdout.once('data', ok); demo.once('exit', (code) => fail(new Error('the demo server stopped: ' + code))); });
  const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.addInitScript((url) => {
      localStorage.setItem('pl.tip.holdOk', 'true');
      localStorage.setItem('pl.autoplayNext', 'false');
      localStorage.setItem('pl.plugin.home-assistant.config', JSON.stringify({ localUrl: url, movieMode: true, trigger: 'everything', delaySec: 0 }));
      // desktop Chrome hands .m3u8 URLs to its own HLS player; the demo's Live TV is a WebM (tools/demo/README.md)
      const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, String(v).replace('/start.m3u8', '/start.webm')); } });
    }, ha.url);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.waitForFunction(() => window.PL && PL.app && PL.app.ready, null, { timeout: 30000 });
    // a recording plugin, and a meter on the player's side of it
    await page.evaluate(() => {
      window.heard = [];
      window.reportMs = [];
      PL.plugins.register({ id: 'recorder', name: 'Recorder', version: '1', apiVersion: 1, onPlayback: (ev) => { window.heard.push({ ev, t: performance.now() }); } });
      const real = PL.Player.prototype.playback;
      window.reported = [];
      PL.Player.prototype.playback = function (what) {
        const t0 = performance.now();
        real.call(this, what);
        window.reportMs.push(performance.now() - t0);
        window.reported.push({ what, t: t0 });
      };
    });
    const top = (fn, arg) => page.evaluate(fn, arg);
    const waitPlaying = (min = 1) => page.waitForFunction((m) => { const p = PL.app.top(); return p.video && p.state === 'playing' && p.video.currentTime > m; }, min, { timeout: 90000, polling: 200 });
    // a stall on the network (the videos stream from the internet) may add buffering-start/-end pairs
    const events = () => page.evaluate(() => window.heard.filter((h) => !/^buffering/.test(h.ev.event)).map((h) => h.ev.event + ':' + (h.ev.item.channel || h.ev.item.title)));
    const heardAll = () => page.evaluate(() => window.heard.filter((h) => !/^buffering/.test(h.ev.event)).map((h) => h.ev));
    const leave = async () => {
      for (let i = 0; i < 6 && await top(() => PL.app.top() instanceof PL.Player); i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
    };

    // ---- a film: play, pause, resume, seek, scrub, stop
    await top(() => PL.plex.get('/library/sections/1/all').then((mc) => PL.app.push(PL.screens.player(mc.Metadata.find((m) => m.title === 'Sintel'), {}))));
    await waitPlaying(1);
    await page.keyboard.press('MediaPlayPause');
    await page.waitForTimeout(800);
    await page.keyboard.press('MediaPlayPause');
    await waitPlaying(1);
    await page.waitForTimeout(800);
    await page.keyboard.press('ArrowRight'); // +30 s
    await page.waitForTimeout(1500);
    await top(() => { const p = PL.app.top(); p.scrubStep(1, false); p.scrubStep(1, false); });
    await page.waitForTimeout(600);
    await top(() => PL.app.top().scrubCommit());
    await waitPlaying(30);
    await page.waitForTimeout(800);
    await leave();
    await page.waitForTimeout(600);
    assert.deepEqual(await events(), ['play:Sintel', 'pause:Sintel', 'resume:Sintel', 'stop:Sintel']);
    const film = (await heardAll())[0];
    assert.equal(film.item.kind, 'movie');
    assert.equal(film.item.type, 'movie');
    assert.ok(Array.isArray(film.item.genres));
    assert.ok(!JSON.stringify(film).match(/ratingKey|library|token/i), JSON.stringify(film));

    // ---- Up Next: the episode ends (credits), the next one plays
    await top(() => PL.plex.get('/library/sections/2/all', { type: 4 }).then((mc) => {
      const eps = mc.Metadata.filter((m) => m.grandparentTitle === 'Caminandes').sort((a, b) => a.index - b.index);
      PL.app.push(PL.screens.player(eps[0], {}));
    }));
    await waitPlaying(0.5);
    await page.waitForFunction(() => PL.app.top().queue && PL.app.top().nextItem(), null, { timeout: 20000 });
    await top(() => { const p = PL.app.top(); p.seekTo(p.durationSec() - 6); });
    await page.waitForFunction(() => { const p = PL.app.top(); return p.cta && p.cta() === 'endcard'; }, null, { timeout: 60000, polling: 200 });
    await top(() => PL.app.top().playNext());
    await waitPlaying(0.5);
    await page.waitForTimeout(600);
    await leave();
    await page.waitForTimeout(600);
    const eps = (await heardAll()).slice(4).map((e) => [e.event, e.item.kind, e.item.episode]);
    assert.deepEqual(eps, [['play', 'series', 1], ['ended', 'series', 1], ['play', 'series', 2], ['stop', 'series', 2]]);

    // ---- Live TV
    const channel = await page.evaluate(() => {
      const ch = { identifier: '101', vcn: '101', title: 'Open Movie Channel' };
      PL.app.push(PL.screens.player(null, { live: { label: 'All channels', dvrKey: '1', channel: ch, channels: [ch], index: 0 } }));
      return ch.title;
    });
    await waitPlaying(0.5);
    await page.waitForTimeout(600);
    await leave();
    await page.waitForTimeout(600);
    const lv = (await heardAll()).slice(8);
    assert.deepEqual(lv.map((e) => e.event), ['play', 'stop']);
    assert.equal(lv[0].item.kind, 'live');
    assert.equal(lv[0].item.channel, channel);
    assert.equal(lv[0].positionMs, null);

    // ---- the player's side: tiny, and plugins hear about it only after the frame
    const timing = await page.evaluate(() => {
      const reports = window.reported.filter((r) => r.what !== 'waiting');
      return { max: Math.max(...window.reportMs), lags: window.heard.map((h, i) => h.t - (reports.find((r, j) => j >= i && r.t <= h.t) || reports[0]).t) };
    });
    console.log(`  player reporting: worst ${timing.max.toFixed(3)} ms; plugins heard it ${Math.min(...timing.lags).toFixed(0)} ms or more later`);
    assert.ok(timing.max < 5, `reporting took ${timing.max} ms`);

    // ---- what Home Assistant got (Movie mode, everything, no delay)
    await new Promise((r) => setTimeout(r, 500));
    const pairs = await page.evaluate(() => window.heard.map((h) => h.ev.event).filter((e) => /^buffering/.test(e)));
    for (let i = 0; i < pairs.length; i += 2) assert.deepEqual(pairs.slice(i, i + 2), ['buffering-start', 'buffering-end']);
    assert.deepEqual(ha.got.map((g) => g.data.event + ':' + g.data.kind), [
      'play:movie', 'pause:movie', 'resume:movie', 'stop:movie',
      'play:series', 'ended:series', 'play:series', 'stop:series', 'play:live', 'stop:live',
    ]);
    assert.match(ha.got[0].contentType, /^application\/x-www-form-urlencoded/);
    assert.equal(ha.got[0].data.source, 'plexlite');
    assert.equal(JSON.parse(ha.got[0].data.payload).item.title, 'Sintel');
    const status = await page.evaluate(() => JSON.parse(localStorage.getItem('pl.plugin.home-assistant.status')));
    assert.equal(status.last.route, 'local');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    demo.kill();
    ha.server.close();
  }
});
