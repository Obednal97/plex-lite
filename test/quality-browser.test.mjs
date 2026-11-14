// End to end in a real browser, on the demo server (tools/demo): the web player's quality. Two
// stalls in a minute restart the stream a step lower; the Quality menu's pick restarts it at that
// step and is kept; picking Auto again starts afresh. The demo answers every decision with direct
// play, so this checks what the player asks the server for. The demo serves the TV build, so the
// web build's media layer (web/web-media.js) is added to the page.
//
// Needs playwright-core and Chrome, and internet access (as test/playback-browser.test.mjs):
//   PLEXLITE_BROWSER_TESTS=1 [CHROMIUM=/path/to/chrome] node --test test/quality-browser.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;
const RUN = process.env.PLEXLITE_BROWSER_TESTS === '1';
const expand = (p) => (p && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('browser: stalls lower the quality, the Quality menu picks one', { skip: !RUN && 'set PLEXLITE_BROWSER_TESTS=1', timeout: 180000 }, async () => {
  const require = createRequire(join(expand(process.env.PLAYWRIGHT_DIR || '~/.cache/plexlite-shots-tools'), 'node_modules/'));
  const { chromium } = require('playwright-core');
  const exe = expand(process.env.CHROMIUM) || (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
  const PORT = await freePort();
  const demo = spawn(process.execPath, [join(ROOT, 'tools/demo/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { demo.stdout.once('data', ok); demo.once('exit', (code) => fail(new Error('the demo server stopped: ' + code))); });
  const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('pl.tip.holdOk', 'true');
      localStorage.setItem('pl.autoplayNext', 'false');
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const asked = []; // each stream decision's quality: [maxVideoBitrate, directPlay]
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/transcode/universal/decision')) asked.push([Number(u.searchParams.get('maxVideoBitrate')), Number(u.searchParams.get('directPlay'))]);
    });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => window.PL && PL.app && PL.app.ready, null, { timeout: 30000 });
    // the demo serves the TV build: add the web build's media layer (all the player's quality code asks for)
    await page.evaluate((src) => { PL.isWeb = true; (0, eval)(src); PL.isWeb = false; }, readFileSync(join(ROOT, 'web/web-media.js'), 'utf8'));
    const top = (fn, arg) => page.evaluate(fn, arg);
    const waitPlaying = () => page.waitForFunction(() => { const p = PL.app.top(); return p.video && p.state === 'playing' && p.video.currentTime > 0.5; }, null, { timeout: 90000, polling: 200 });
    const stall = () => top(() => PL.app.top().video.dispatchEvent(new Event('waiting')));
    const asks = async (n, ms = 5000) => { for (let t = 0; asked.length < n && t < ms; t += 100) await page.waitForTimeout(100); assert.equal(asked.length, n, JSON.stringify(asked)); };

    await top(() => PL.plex.get('/library/sections/1/all').then((mc) => PL.app.push(PL.screens.player(mc.Metadata.find((m) => m.title === 'Sintel'), {}))));
    await waitPlaying();
    assert.deepEqual(asked, [[200000, 1]]);
    const bitrate = (await top(() => PL.app.top().full.Media[0].bitrate)) || 20000;

    // one stall alone changes nothing; a second within the minute steps down below the file
    await stall();
    await page.waitForTimeout(300);
    assert.equal(asked.length, 1);
    await stall();
    await asks(2);
    await waitPlaying();
    const step = (await top(() => PL.webMedia.STEPS.map((s) => s.kbps))).find((k) => k && k < bitrate);
    assert.deepEqual(asked[1], [step, 0]);
    const at = await top(() => PL.app.top().position());
    assert.ok(at > 0.5, 'the restart kept the place: ' + at);

    // a long stall (8 s) steps down once more (after the restart's resume seek: stalls within 5 s of
    // a seek don't count)
    await page.waitForTimeout(5200);
    await stall();
    await page.waitForTimeout(7000);
    assert.equal(asked.length, 2);
    await asks(3, 3000);
    await waitPlaying();
    assert.ok(asked[2][0] < step && asked[2][1] === 0, JSON.stringify(asked));

    // the menu: Auto checked and says it was lowered; a pick restarts at that step and is kept
    const rows = await top(() => { const p = PL.app.top(); p.showOsd(); p.openMenu('quality'); return p.menu.rows.map((r) => [r.label, r.sub || '', !!r.checked]); });
    assert.deepEqual(rows[0], ['Auto', 'Now ' + (await top((k) => PL.webMedia.stepLabel(k), asked[2][0])) + ' (lowered)', true]);
    assert.deepEqual(rows.slice(1).map((r) => r[0]), ['Original', '1080p · 8 Mbps', '720p · 4 Mbps', '480p · 2 Mbps', 'Low · 1 Mbps']);
    await top(() => { const p = PL.app.top(); p.menu.index = 3; p.pressMenu(); }); // 720p · 4 Mbps
    await asks(4);
    await waitPlaying();
    assert.deepEqual(asked[3], [4000, 0]);
    assert.equal(await top(() => localStorage.getItem('pl.quality.lan')), '4000');
    // a picked quality doesn't step down
    await stall();
    await stall();
    await page.waitForTimeout(500);
    assert.equal(asked.length, 4);
    // Auto again: the original
    await top(() => { const p = PL.app.top(); p.openMenu('quality'); p.menu.index = 0; p.pressMenu(); });
    await asks(5);
    await waitPlaying();
    assert.deepEqual(asked[4], [200000, 1]);
    assert.equal(await top(() => localStorage.getItem('pl.quality.lan')), null);
    // a cap above the file's bitrate (1080p 8 Mbps over a smaller file) sends the same stream: no restart
    await top(() => { const p = PL.app.top(); p.openMenu('quality'); p.menu.index = 2; p.pressMenu(); });
    await page.waitForTimeout(800);
    assert.equal(asked.length, 5);
    assert.equal(await top(() => localStorage.getItem('pl.quality.lan')), '8000');
    await top(() => { const p = PL.app.top(); p.openMenu('quality'); p.menu.index = 0; p.pressMenu(); });
    await page.waitForTimeout(800);
    assert.equal(asked.length, 5);
    // buffering right after a seek isn't a stall
    await top(() => { const v = PL.app.top().video; v.dispatchEvent(new Event('seeking')); v.dispatchEvent(new Event('seeked')); });
    await stall();
    await stall();
    await page.waitForTimeout(800);
    assert.equal(asked.length, 5);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    demo.kill();
  }
});
