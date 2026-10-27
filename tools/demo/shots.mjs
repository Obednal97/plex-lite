#!/usr/bin/env node
// Captures the README screenshots (docs/screenshots/) from the demo server in headless Chromium at
// 1920x1080, driving the app with remote-style key presses.
//
//   node tools/demo/shots.mjs [out-dir] [shot ...]
//
// Needs playwright-core and a Chromium, kept outside the repo:
//   npm i --prefix ~/.cache/plexlite-shots-tools playwright-core
//   PLAYWRIGHT_DIR=~/.cache/plexlite-shots-tools CHROMIUM=/path/to/chrome-headless-shell node tools/demo/shots.mjs
// Starts tools/demo/server.mjs itself (PORT, default 8931) and writes JPEGs via ImageMagick when
// `magick` is installed, PNGs otherwise. Desktop Chromium draws slightly differently from the TV's
// Chrome 53; that's fine for documentation.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const PORT = Number(process.env.PORT || 8931);
const BASE = `http://127.0.0.1:${PORT}`;
const [outArg, ...only] = process.argv.slice(2);
const OUT = resolve(outArg || join(ROOT, 'docs/screenshots'));
const expand = (p) => (p && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const require = createRequire(join(expand(process.env.PLAYWRIGHT_DIR || '~/.cache/plexlite-shots-tools'), 'node_modules/'));
const { chromium } = require('playwright-core');
const hasMagick = (() => { try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const K = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape' };

// ---- helpers ---------------------------------------------------------------------------------------

async function press(page, ...keys) {
  for (const k of keys.flat()) {
    await page.keyboard.press(K[k] || k);
    await page.waitForTimeout(260);
  }
}

// Every image on screen has loaded (or failed over to its fallback) and nothing is still fading in.
async function settle(page, extra = 900) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.images).filter((i) => i.getAttribute('src') && i.offsetParent !== null);
    const pending = imgs.filter((i) => !i.complete || i.classList.contains('img-wait'));
    const spin = Array.from(document.querySelectorAll('.loading, .player-status')).some((n) => n.offsetParent && !n.classList.contains('player-status-hidden') && getComputedStyle(n).display !== 'none' && getComputedStyle(n).opacity !== '0');
    return pending.length === 0 && !spin;
  }, null, { timeout: 30000, polling: 200 }).catch(() => console.warn('  (timed out waiting for images)'));
  await page.waitForTimeout(extra);
}

async function broken(page) {
  return page.evaluate(() => Array.from(document.images)
    .filter((i) => i.offsetParent && i.getAttribute('src') && i.complete && !i.naturalWidth && i.style.visibility !== 'hidden')
    .map((i) => i.src.slice(0, 120)));
}

async function snap(page, name) {
  const png = join(OUT, `${name}.png`);
  await page.screenshot({ path: png });
  const bad = await broken(page);
  if (bad.length) console.warn(`  ${name}: ${bad.length} broken image(s)`, bad);
  if (hasMagick) {
    const jpg = join(OUT, `${name}.jpg`);
    execFileSync('magick', [png, '-strip', '-sampling-factor', '4:2:0', '-quality', '84', '-interlace', 'JPEG', jpg]);
    unlinkSync(png);
    console.log(`  ${jpg}`);
  } else {
    console.log(`  ${png}`);
  }
}

// Fresh page per shot so one flow can't leak into the next.
async function open(browser, path = '/') {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  // the one-time "hold OK" tip would cover the screenshots
  await ctx.addInitScript(() => { try { localStorage.setItem('pl.tip.holdOk', 'true'); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('  page error:', e.message));
  await page.goto(BASE + path);
  if (path === '/') await page.waitForFunction(() => window.PL && PL.app && PL.app.ready, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  return page;
}

// Moves the focus to the tab bar and opens the named tab (Left/Right along the bar, then OK).
async function tab(page, label) {
  await page.evaluate(() => PL.app.focusTabs());
  await page.waitForTimeout(200);
  const { from, to } = await page.evaluate((l) => ({ from: PL.app.tabs.index, to: PL.app.tabs.tabs.map((t) => t.label).indexOf(l) }), label);
  if (to < 0) throw new Error(`no tab ${label}`);
  await press(page, Array(Math.abs(to - from)).fill(to > from ? 'right' : 'left'), 'ok');
  await page.waitForTimeout(500);
}

// From a library tab's content: up to the sub-nav, across to the mode, down into it.
async function libraryMode(page, mode) {
  await press(page, 'up');
  const { from, to } = await page.evaluate((m) => {
    const s = PL.app.top();
    return { from: s.subnav.index, to: ['Recommended', 'Library', 'Collections'].indexOf(m) };
  }, mode);
  await press(page, Array(Math.abs(to - from)).fill(to > from ? 'right' : 'left'), 'down');
}

// Arrow presses that move a grid's focus to the item with this title.
async function gridTo(page, title) {
  const at = await page.evaluate((t) => {
    const s = PL.app.top();
    const grid = (s.mode && s.mode.grid) || s.grid;
    return grid.items.map((i) => i && i.title).indexOf(t);
  }, title);
  if (at < 0) throw new Error(`${title} is not in the grid`);
  await press(page, Array(Math.floor(at / 6)).fill('down'), Array(at % 6).fill('right'));
}

// Arrow presses along the focused shelf to the item with this title.
async function shelfTo(page, title) {
  const { at, from } = await page.evaluate((t) => {
    const z = PL.app.top().stack ? PL.app.top().stack.current() : PL.app.top().mode.stack.current();
    return { at: z.items.map((i) => i && (i.title || i.name || i.tag)).indexOf(t), from: z.index };
  }, title);
  if (at < 0) throw new Error(`${title} is not on the shelf`);
  await press(page, Array(Math.abs(at - from)).fill(at > from ? 'right' : 'left'));
}

async function search(page, query) {
  await tab(page, 'Search');
  for (const ch of query) {
    await page.keyboard.press(ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`);
    await page.waitForTimeout(140);
  }
}

// Opens a title's page through Search (type, Right into the results, OK).
async function openTitle(page, query, title) {
  await search(page, query);
  await page.waitForTimeout(900);
  // Right along the key row until the focus leaves the keyboard for the results
  for (let i = 0; i < 8 && await page.evaluate(() => PL.app.top().area === 'keys'); i++) await press(page, 'right');
  await shelfTo(page, title);
  await press(page, 'ok');
  await page.waitForFunction(() => PL.app.top().full, null, { timeout: 15000 });
}

// Waits until the player is showing video at a sensible point, then pauses it.
async function playAndPause(page, minSec) {
  await page.waitForFunction((m) => {
    const p = PL.app.top();
    return p.video && p.state === 'playing' && p.video.currentTime > m && p.video.readyState >= 3;
  }, minSec, { timeout: 90000, polling: 250 });
  await press(page, 'MediaPlayPause');
  await page.waitForTimeout(1200);
}

// ---- the shots --------------------------------------------------------------------------------------

// which titles each shot uses: library.json "shots"
const C = JSON.parse(readFileSync(join(HERE, 'library.json'), 'utf8')).shots || {};

const SHOTS = {
  // launch screen: TV Shows → Recommended with the hero
  'tv-recommended': async (page) => {
    await settle(page, 1800);
  },
  'movies-recommended': async (page) => {
    await tab(page, 'Movies');
    if (C.moviesHero) await shelfTo(page, C.moviesHero);
    await settle(page, 1800);
  },
  'movies-library': async (page) => {
    await tab(page, 'Movies');
    await libraryMode(page, 'Library');
    await press(page, 'down');
    if (C.libraryFocus) await gridTo(page, C.libraryFocus);
    await settle(page, 1200);
  },
  'movies-sort-sheet': async (page) => {
    await tab(page, 'Movies');
    await libraryMode(page, 'Library');
    await settle(page, 300);
    await press(page, 'ok');
    await settle(page, 800);
  },
  'movies-genre-sheet': async (page) => {
    await tab(page, 'Movies');
    await libraryMode(page, 'Library');
    await settle(page, 300);
    await press(page, 'right', 'ok');
    await page.waitForTimeout(800);
    await press(page, 'down', 'down');
    await settle(page, 800);
  },
  'movies-collections': async (page) => {
    await tab(page, 'Movies');
    await libraryMode(page, 'Collections');
    await settle(page, 1200);
  },
  // Surprise Me (the pill after the mode chips): the full-screen reveal mid-countdown
  surprise: async (page) => {
    await tab(page, C.surpriseTab || 'Movies');
    await press(page, 'up');
    for (let i = 0; i < 4 && await page.evaluate(() => PL.app.top().area !== 'surprise'); i++) await press(page, 'right');
    await press(page, 'ok');
    await page.waitForFunction(() => { const s = PL.app.top(); return s.pick && !s.spinning; }, null, { timeout: 20000 });
    await settle(page, 1800);
  },
  'movie-details': async (page) => {
    await openTitle(page, C.movieQuery, C.movie);
    await settle(page, 1800);
  },
  'movie-details-cast': async (page) => {
    await openTitle(page, C.movieQuery, C.movie);
    await settle(page, 600);
    // down past More Like This and Extras to Cast & Crew
    await press(page, 'down', 'down', 'down');
    await settle(page, 1500);
  },
  'show-details': async (page) => {
    await openTitle(page, C.showQuery, C.show);
    await settle(page, 600);
    await press(page, 'down', 'down');
    await settle(page, 1500);
  },
  person: async (page) => {
    await openTitle(page, C.personQuery, C.personFrom);
    await settle(page, 300);
    // down to the Cast & Crew row
    for (let i = 0; i < 6; i++) {
      const isCast = await page.evaluate(() => { const z = PL.app.top().stack.current(); return z && z.kind === 'person'; });
      if (isCast) break;
      await press(page, 'down');
    }
    await shelfTo(page, C.person);
    await press(page, 'ok');
    await page.waitForTimeout(800);
    await settle(page, 1500);
  },
  search: async (page) => {
    await search(page, C.searchQuery);
    await page.waitForTimeout(1500);
    await settle(page, 1200);
  },
  'quick-actions': async (page) => {
    await tab(page, 'Movies');
    if (C.quickActions) await shelfTo(page, C.quickActions);
    await settle(page, 1200);
    await page.keyboard.down('Enter');
    await page.waitForTimeout(1300);
    await settle(page, 400);
  },
  player: async (page) => {
    await openTitle(page, C.playerQuery, C.player);
    await settle(page, 400);
    await press(page, 'ok');
    await playAndPause(page, (C.playerAt || 60) - 1);
    await page.waitForTimeout(600);
  },
  // scrubbing while paused: Right taps move the target; the preview and its time ride above it
  'player-scrub': async (page) => {
    await openTitle(page, C.playerQuery, C.player);
    await settle(page, 400);
    await press(page, 'ok');
    await playAndPause(page, (C.playerAt || 60) - 1);
    await press(page, 'right', 'right', 'right', 'right');
    await page.waitForTimeout(300);
  },
  // Up from the bar to the Subtitles icon, OK: its menu opens above it
  'player-subtitles': async (page) => {
    await openTitle(page, C.playerQuery, C.player);
    await settle(page, 400);
    await press(page, 'ok');
    await playAndPause(page, (C.playerAt || 60) - 1);
    await press(page, 'up', 'ok');
    await page.waitForTimeout(600);
  },
  // Down from the bar: the tabs; Right to Chapters, Down into its cards
  'player-chapters': async (page) => {
    await openTitle(page, C.playerQuery, C.player);
    await settle(page, 400);
    await press(page, 'ok');
    await playAndPause(page, (C.playerAt || 60) - 1);
    await press(page, 'down', 'right', 'down');
    await page.waitForTimeout(900);
  },
  // Skip Intro, a few seconds into an episode with an intro marker
  'skip-intro': async (page) => {
    await page.evaluate((t) => PL.plex.get('/library/sections/2/all', { type: 4 }).then((mc) => {
      const ep = mc.Metadata.find((m) => m.title === t);
      PL.app.push(PL.screens.player(ep, {}));
    }), C.skipIntroEpisode);
    await page.waitForFunction(() => PL.app.top().pillVisible, null, { timeout: 90000, polling: 200 });
    await page.evaluate(() => PL.app.top().hideOsd());
    await page.waitForTimeout(900);
  },
  'up-next': async (page) => {
    await openTitle(page, C.upNextQuery, C.upNextShow);
    await settle(page, 400);
    // resume the in-progress episode; its credits marker brings up Up Next a few seconds in
    await press(page, 'ok');
    await page.waitForFunction(() => { const p = PL.app.top(); return p.cta && p.cta() === 'endcard'; }, null, { timeout: 90000 });
    await page.waitForTimeout(2500);
  },
  'live-tv': async (page) => {
    await tab(page, 'Live TV');
    await page.waitForSelector('.lg-cell.focused');
    await press(page, 'down', 'down');
    await settle(page, 2500);
  },
  settings: async (page) => {
    await tab(page, 'Settings');
    await settle(page, 800);
  },
  'settings-profiles': async (page) => {
    await tab(page, 'Settings');
    await press(page, 'ok');
    await settle(page, 1000);
  },
  signin: async (page) => {
    await page.waitForSelector('.code-tile');
    await page.waitForTimeout(1200);
  },
};

// ---- run ----------------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [join(HERE, 'server.mjs')], { env: { PLEXLITE_DEMO_SEED: String(C.seed || 7), ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.once('data', ok));
const exe = expand(process.env.CHROMIUM);
const browser = await chromium.launch({ executablePath: exe && existsSync(exe) ? exe : undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
try {
  for (const name of only.length ? only : Object.keys(SHOTS)) {
    console.log(name);
    const page = await open(browser, name === 'signin' ? '/?signin' : '/');
    try {
      await SHOTS[name](page);
      await snap(page, name);
    } catch (e) {
      failed++;
      console.error(`  ${name} failed: ${e.message.split('\n')[0]}`);
      await page.screenshot({ path: join(OUT, `${name}.failed.png`) }).catch(() => {});
    } finally {
      await page.context().close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
