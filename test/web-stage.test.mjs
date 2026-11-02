// Tests for the web build's stage size and artwork sizes (web/web-stage.js, docs/WEB.md "The window").
//   node --test test/web-stage.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, 'web/web-stage.js'), 'utf8'), ctx, { filename: 'web/web-stage.js' });
const S = ctx.window.PL.webStage;
const near = (a, b) => Math.abs(a - b) < 1e-6;
// objects from the vm's realm, compared as plain values
const plain = (o) => JSON.parse(JSON.stringify(o));

test('desk: 0.65 CSS px per stage px by default, the stage as big as the window holds, no bars', () => {
  assert.equal(S.DESK, 0.65);
  const laptop = S.size(1440, 900, true);
  assert.deepEqual({ w: laptop.w, h: laptop.h, x: laptop.x, y: laptop.y }, { w: 2215, h: 1384, x: 0, y: 0 });
  assert.ok(Math.abs(laptop.scale - 0.65) < 0.001);
  // a 16:9 desktop gets a wider stage, not bigger text
  const desktop = S.size(1920, 1080, true);
  assert.equal(desktop.w, 2954);
  assert.ok(Math.abs(desktop.scale - 0.65) < 0.001);
  // the stage always fills the window's width exactly
  for (const [w, h] of [[1280, 800], [1512, 982], [1366, 768], [2560, 1440], [3440, 1440], [1440, 520]]) {
    const s = S.size(w, h, true);
    assert.ok(Math.abs(s.w * s.scale - w) < 1e-6, `${w}x${h}`);
    assert.ok(s.h * s.scale >= h - 1, `${w}x${h} fills the height`);
  }
});

test('desk: browser zoom changes the size of everything, not just the bars', () => {
  // a 1440x900 window at 67%, 80%, 100% and 125% zoom: the CSS viewport is window / zoom
  const at = (zoom) => S.size(Math.round(1440 / zoom), Math.round(900 / zoom), true);
  // physical size of a stage px (CSS px x zoom) follows the zoom
  assert.ok(at(0.67).scale * 0.67 < at(0.8).scale * 0.8);
  assert.ok(at(0.8).scale * 0.8 < at(1).scale * 1);
  assert.ok(at(1).scale * 1 < at(1.25).scale * 1.25);
  // and zooming out shows more of the stage
  assert.ok(at(0.67).w > at(0.8).w && at(0.8).w > at(1).w && at(1).w > at(1.25).w);
});

test('desk: never narrower than 1600 or shorter than 900, never past 3840 wide', () => {
  // 1100 (the narrowest before the phone layer) still has the default size
  const narrow = S.size(1100, 800, true);
  assert.equal(narrow.w, 1692);
  assert.ok(Math.abs(narrow.scale - 0.65) < 0.001);
  const narrower = S.size(1100, 800, true, 0.85);
  assert.equal(narrower.w, 1600);
  assert.ok(narrower.scale < 0.85);
  const short = S.size(1440, 480, true);
  assert.equal(short.h, 900);
  assert.ok(Math.abs(short.w * short.scale - 1440) < 1e-6);
  const big = S.size(5120, 2880, true);
  assert.equal(big.w, 3840);
  assert.ok(near(big.scale, 4 / 3));
});

test('10-foot view: as before, 1920 wide scaled to the window, bars only outside 900..1440 tall', () => {
  assert.deepEqual(plain(S.size(1440, 900, false)), { w: 1920, h: 1200, scale: 0.75, x: 0, y: 0 });
  assert.deepEqual(plain(S.size(1920, 1080, false)), { w: 1920, h: 1080, scale: 1, x: 0, y: 0 });
  const ultra = S.size(3440, 1000, false);
  assert.equal(ultra.h, 900);
  assert.ok(ultra.x > 0);
  const tall = S.size(1200, 1800, false);
  assert.equal(tall.h, 1080);
  assert.ok(tall.y > 0);
});

test('images: fetched at the size they are drawn on this screen, in steps, never below the TV size', () => {
  // the TV's own size where a stage px is one device pixel or less
  assert.equal(S.imageScale(250, false, 1, 1, 1920), 1);
  assert.equal(S.imageScale(250, false, 0.6, 1, 1920), 1);
  // a Retina laptop: 0.6 x 2 = 1.2 -> the 1.25 step; 0.65 x 2 = 1.3 -> 1.5
  assert.equal(S.imageScale(250, false, 0.6, 2, 1440), 1.25);
  assert.equal(S.imageScale(250, false, 0.65, 2, 1440), 1.5);
  assert.equal(S.imageScale(250, false, 0.75, 2, 1440), 1.5);
  assert.equal(S.imageScale(250, false, 2, 3, 1440), 3);
  // blurred art stays as asked
  assert.equal(S.imageScale(480, true, 0.6, 2, 1440), 1);
  // full-screen art: the window's width in device pixels, stepped
  assert.equal(S.imageScale(1280, false, 0.6, 2, 1440) * 1280, 3200);
  assert.equal(S.imageScale(1280, false, 0.6, 1, 1920) * 1280, 1920);
  assert.equal(S.imageScale(1280, false, 0.6, 1, 1280) * 1280, 1280);
  assert.equal(S.imageScale(1280, false, 0.6, 2, 2560) * 1280, 3840);
  assert.equal(S.imageScale(1920, false, 0.6, 1, 1366), 1);
});

test('size setting: default, bounds, steps and bad stored values', () => {
  assert.equal(S.density(null), 0.65);
  assert.equal(S.density(undefined), 0.65);
  for (const bad of ['', 'big', NaN, Infinity, -Infinity, {}, [], true, '0.7px']) assert.equal(S.density(bad), 0.65, String(bad));
  // clamped to 0.5..0.85 and snapped to 0.05 steps
  assert.equal(S.density(0.2), 0.5);
  assert.equal(S.density(-1), 0.5);
  assert.equal(S.density(3), 0.85);
  assert.equal(S.density(0.72), 0.7);
  assert.equal(S.density(0.73), 0.75);
  assert.equal(S.density('0.8'), 0.8);
  assert.equal(S.density(0.55 + 1e-12), 0.55);
  // stepping stops at the ends
  assert.equal(S.stepDensity(0.65, 1), 0.7);
  assert.equal(S.stepDensity(0.65, -1), 0.6);
  assert.equal(S.stepDensity(0.85, 1), 0.85);
  assert.equal(S.stepDensity(0.5, -1), 0.5);
  assert.equal(S.stepDensity('junk', 1), 0.7);
  // every step from the bottom to the top lands on the grid
  const seen = [];
  for (let v = 0.5, i = 0; i < 10; i++, v = S.stepDensity(v, 1)) seen.push(v);
  assert.deepEqual(seen, [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.85, 0.85]);
  // shown as a percentage of the default
  assert.equal(S.percent(0.65), 100);
  assert.equal(S.percent(0.5), 77);
  assert.equal(S.percent(0.85), 131);
  assert.equal(S.percent('bad'), 100);
});

test('size setting: the stage follows it, and only in the desk view', () => {
  const big = S.size(1440, 900, true, 0.85);
  const small = S.size(1440, 900, true, 0.5);
  assert.ok(Math.abs(big.scale - 0.85) < 0.001 && Math.abs(small.scale - 0.5) < 0.001);
  // the whole range works on a 1440 px laptop window
  assert.equal(big.w, 1694);
  assert.ok(big.w < small.w);
  // a bad stored value is the default
  assert.deepEqual(plain(S.size(1440, 900, true, 'x')), plain(S.size(1440, 900, true)));
  // the 10-foot view ignores it
  assert.deepEqual(plain(S.size(1440, 900, false, 0.85)), plain(S.size(1440, 900, false)));
});
