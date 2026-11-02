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

test('desk: 0.6 CSS px per stage px, the stage as big as the window holds, no bars', () => {
  const laptop = S.size(1440, 900, true);
  assert.deepEqual({ w: laptop.w, h: laptop.h, x: laptop.x, y: laptop.y }, { w: 2400, h: 1500, x: 0, y: 0 });
  assert.ok(near(laptop.scale, 0.6));
  // a 16:9 desktop gets a wider stage, not bigger text
  const desktop = S.size(1920, 1080, true);
  assert.equal(desktop.w, 3200);
  assert.ok(near(desktop.scale, 0.6));
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

test('desk: never narrower than the TV layout or shorter than 900, never past 3840 wide', () => {
  const narrow = S.size(1100, 800, true);
  assert.equal(narrow.w, 1920);
  assert.ok(narrow.scale < 0.6);
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
  // a Retina laptop: 0.6 x 2 = 1.2 -> the 1.25 step
  assert.equal(S.imageScale(250, false, 0.6, 2, 1440), 1.25);
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
