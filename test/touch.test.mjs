// Tests for the phone and tablet layer's decisions (web/touch/logic.js, docs/WEB.md "Phones and
// tablets"): when it takes over from the TV stage, phone or tablet layout, the bottom tabs, Back at
// the top of a tab, image sizes and a title's quick actions. Also: the TV build never loads it.
//   node --test test/touch.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function logic() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('web/touch/logic.js'), ctx, { filename: 'web/touch/logic.js' });
  return ctx.window.PL.touchLogic;
}
const L = logic();
// values made in the vm's realm compare by structure once copied here
const J = (v) => JSON.parse(JSON.stringify(v));

test('touch: takes over below 1100 px whatever the input, and on touch tablets up to 1400', () => {
  const w = (width, setting = 'auto', detected = 'pointer') => L.wanted({ width, setting, detected });
  assert.equal(w(390), true);
  assert.equal(w(820), true);
  assert.equal(w(1099), true);
  assert.equal(w(1100), false); // a laptop window: the stage (phase 1's layout)
  assert.equal(w(1440), false);
  assert.equal(w(1180, 'auto', 'touch'), true); // iPad landscape
  assert.equal(w(1366, 'auto', 'touch'), true);
  assert.equal(w(1920, 'auto', 'touch'), false); // a touch TV or big touch screen
  assert.equal(w(1180, 'touch', 'pointer'), true); // Controls pinned to Touch
  assert.equal(w(1180, 'pointer', 'touch'), false); // pinned to Mouse & keyboard
  assert.equal(w(390, 'remote', 'touch'), false); // pinned to Remote: the TV layout everywhere
  assert.equal(w(0), false);
  assert.equal(w(undefined), false);
});

test('touch: phone under 600 px, tablet above; short when under 500 px tall', () => {
  assert.deepEqual({ ...L.layout(390, 844) }, { kind: 'phone', short: false });
  assert.deepEqual({ ...L.layout(599, 900) }, { kind: 'phone', short: false });
  assert.deepEqual({ ...L.layout(600, 900) }, { kind: 'tablet', short: false });
  assert.deepEqual({ ...L.layout(852, 393) }, { kind: 'tablet', short: true });
});

test('touch: tabs are the film libraries, the TV libraries, Live TV, Search', () => {
  const secs = [{ key: '2', type: 'show', title: 'TV Shows' }, { key: '1', type: 'movie', title: 'Movies' }, { key: '9', type: 'artist', title: 'Music' }];
  const { tabs, more } = L.tabs(secs, true);
  assert.deepEqual(J(tabs.map((t) => t.id)), ['section.1', 'section.2', 'livetv', 'search']);
  assert.deepEqual(J(tabs.map((t) => t.label)), ['Movies', 'TV Shows', 'Live TV', 'Search']);
  assert.deepEqual(J(tabs.map((t) => t.icon)), ['film', 'tv', 'live', 'search']);
  assert.equal(more.length, 0);
  assert.deepEqual(J(L.tabs(secs, false).tabs.map((t) => t.id)), ['section.1', 'section.2', 'search']);
  // more libraries than fit: the rest are listed elsewhere
  const many = [1, 2, 3, 4, 5].map((k) => ({ key: String(k), type: k % 2 ? 'movie' : 'show', title: 'L' + k }));
  const r = L.tabs(many, true);
  assert.equal(r.tabs.length, 5);
  // the first film and TV libraries always have a tab
  assert.deepEqual(J(r.tabs.map((t) => t.id)), ['section.1', 'section.3', 'section.2', 'livetv', 'search']);
  assert.deepEqual(J(r.more.map((s) => s.key)), ['5', '4']);
  assert.deepEqual(J(L.tabs(null, false).tabs.map((t) => t.id)), ['search']);
});

test('touch: opens on the stage\'s start tab, else the first', () => {
  const { tabs } = L.tabs([{ key: '1', type: 'movie' }, { key: '2', type: 'show' }], true);
  assert.equal(L.startTab(tabs, 'section.2'), 1);
  assert.equal(L.startTab(tabs, 'settings'), 0);
  assert.equal(L.startTab(tabs, null), 0);
});

test('touch: Back pops, then goes to the start tab, then lets the browser leave', () => {
  assert.equal(L.backAction(3, 0, 1), 'pop');
  assert.equal(L.backAction(2, 1, 1), 'pop');
  assert.equal(L.backAction(1, 0, 1), 'start');
  assert.equal(L.backAction(1, 1, 1), 'leave');
});

test('touch: images are asked for at the screen density, at most 2x, in steps of 20', () => {
  assert.equal(L.imageWidth(120, 1), 120);
  assert.equal(L.imageWidth(120, 2), 240);
  assert.equal(L.imageWidth(120, 3), 240);
  assert.equal(L.imageWidth(113, 2.625), 240);
  assert.equal(L.imageWidth(101, 1), 120);
  assert.equal(L.imageWidth(100, 0), 100);
});

test('touch: card width leaves the next card peeking in', () => {
  const w = L.cardWidth(390, 24, 10, 3.3);
  assert.equal(w, 101);
  // three whole cards and part of a fourth are on screen
  assert.ok(24 + 3 * (w + 10) < 390 && 24 + 4 * (w + 10) > 390);
});

test('touch: quick actions follow the TV\'s menu', () => {
  const clock = (ms) => String(ms / 1000);
  const ids = (item, o) => J(L.menuRows(item, Object.assign({ clock }, o)).map((r) => r.id));
  assert.deepEqual(ids({ type: 'movie' }), ['play', 'watched', 'details']);
  assert.deepEqual(ids({ type: 'movie', viewOffset: 5000 }), ['resume', 'restart', 'watched', 'unwatched', 'details']);
  assert.equal(L.menuRows({ type: 'movie', viewOffset: 5000 }, { clock })[0].label, 'Resume from 5');
  assert.deepEqual(ids({ type: 'movie', viewCount: 1 }), ['play', 'unwatched', 'details']);
  assert.deepEqual(ids({ type: 'episode', grandparentRatingKey: '9' }), ['play', 'watched', 'show', 'details']);
  assert.deepEqual(ids({ type: 'show', leafCount: 4, viewedLeafCount: 4 }), ['unwatched', 'details']);
  assert.deepEqual(ids({ type: 'show', leafCount: 4, viewedLeafCount: 1 }), ['watched', 'unwatched', 'details']);
  assert.deepEqual(ids({ type: 'season', parentRatingKey: '3', leafCount: 2 }), ['watched', 'show', 'details']);
  // already on the title's page: no Details row
  assert.deepEqual(ids({ type: 'movie' }, { onDetails: true }), ['play', 'watched']);
  assert.deepEqual(ids({ type: 'person' }), []);
  assert.deepEqual(ids(null), []);
});

test('touch: the TV build never loads web/touch, the web build adds every file its manifest lists', () => {
  assert.doesNotMatch(read('index.html'), /web\/touch/);
  const man = JSON.parse(read('web/touch/manifest.json'));
  assert.ok(man.scripts.length && man.styles.length);
  for (const f of man.scripts.concat(man.styles)) assert.doesNotThrow(() => read('web/touch/' + f), f);
  // every script in web/touch/ is in the manifest (a forgotten one would never load)
  const listed = new Set(man.scripts);
  for (const f of ['logic.js', 'kit.js', 'shell.js', 'sheets.js']) assert.ok(listed.has(f), f);
  // the shell comes after its building blocks
  assert.ok(man.scripts.indexOf('logic.js') < man.scripts.indexOf('kit.js'));
  assert.ok(man.scripts.indexOf('kit.js') < man.scripts.indexOf('shell.js'));
});
