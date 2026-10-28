// Tests for Live TV on phones and tablets (web/touch/live/logic.js): the guide's geometry, which
// rows and hours it builds while scrolling, cell labels, the chips, "Last watched" and the number
// pad. Plus the helpers it shares with the TV guide in js/livetv-data.js (openingSel, onNow,
// liveSpec). Invented channels only.
//   node --test test/touch-live.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const J = (v) => JSON.parse(JSON.stringify(v));

function logic() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('web/touch/live/logic.js'), ctx, { filename: 'web/touch/live/logic.js' });
  return ctx.window.PL.touchLiveLogic;
}
const X = logic();

test('touch live: geometry for a phone, a phone on its side and a tablet', () => {
  const p = X.geometry('phone', false);
  assert.equal(p.pitch, 68);
  assert.equal(Math.round(p.pps * 1800), 108); // half an hour is 108 px, as drawn on board P4
  assert.equal(X.geometry('phone', true).pitch, 60);
  const t = X.geometry('tablet', false);
  assert.ok(t.pitch > p.pitch && t.pps > p.pps && t.col > p.col);
  assert.equal(X.geometry('tablet', true).pitch, t.pitch); // a tablet is never "short"
  // touch targets: rows are at least 44 px
  Object.values(X.GEOMETRY).forEach((g) => assert.ok(g.cell >= 44));
});

test('touch live: rows built are those in view plus the overscan, clamped to the list', () => {
  assert.deepEqual(J(X.rowRange(0, 680, 68, 600, 6)), { from: 0, to: 16 });
  assert.deepEqual(J(X.rowRange(-300, 680, 68, 600, 6)), { from: 0, to: 12 }); // header still on screen
  assert.deepEqual(J(X.rowRange(68 * 100, 680, 68, 600, 6)), { from: 94, to: 116 });
  assert.deepEqual(J(X.rowRange(68 * 595, 680, 68, 600, 6)), { from: 589, to: 600 });
  assert.deepEqual(J(X.rowRange(0, 680, 68, 0, 6)), { from: 0, to: 0 });
  assert.deepEqual(J(X.rowRange(0, 680, 68, 3, 6)), { from: 0, to: 3 });
});

test('touch live: the hours built change only every hour of scrolling, never before the origin', () => {
  const origin = 1800 * 1000;
  const pps = 3.6 / 60;
  const w0 = X.timeWindow(origin, 0, 300, pps, 3600, 3600);
  assert.equal(w0.from, origin);
  assert.ok(w0.to >= origin + 300 / pps + 3600);
  assert.equal((w0.to - origin) % 1800, 0);
  // a few px sideways: the same window
  assert.deepEqual(J(X.timeWindow(origin, 40, 300, pps, 3600, 3600)), J(w0));
  // two hours on: a later window
  const w2 = X.timeWindow(origin, 7200 * pps, 300, pps, 3600, 3600);
  assert.ok(w2.from > origin && w2.from <= origin + 3600);
});

test('touch live: airingsIn finds the airings overlapping a window', () => {
  const list = [{ b: 0, e: 10 }, { b: 10, e: 20 }, { b: 20, e: 30 }, { b: 30, e: 40 }];
  assert.deepEqual(J(X.airingsIn(list, 15, 25)), { from: 1, to: 3 });
  assert.deepEqual(J(X.airingsIn(list, 10, 20)), { from: 1, to: 2 });
  assert.deepEqual(J(X.airingsIn(list, 40, 50)), { from: 4, to: 4 });
  assert.deepEqual(J(X.airingsIn([], 0, 50)), { from: 0, to: 0 });
});

test('touch live: ticks every half hour from the origin', () => {
  const t = X.ticks(3600, 2, 0.06);
  assert.equal(t.length, 5);
  assert.deepEqual(J(t[1]), { t: 5400, x: 108 });
});

test('touch live: cell labels and states', () => {
  const a = { b: 1000, e: 1000 + 3600 };
  assert.equal(X.left(a, 1000 + 2940), '11m left');
  assert.equal(X.left(a, 1000), '1h left');
  assert.equal(X.left({ b: 0, e: 3900 }, 0), '1h 5m left');
  assert.equal(X.left(a, a.e - 5), '1m left');
  assert.equal(X.left(a, a.e), 'Ended');
  assert.equal(X.when(a, 999), 'later');
  assert.equal(X.when(a, 1000), 'now');
  assert.equal(X.when(a, a.e), 'past');
});

test('touch live: chips are Favourites, All, On now and the categories; a family gets its own while chosen', () => {
  const entries = [
    { key: 'fav', kind: 'pick', label: 'Favourites' }, { key: 'all', kind: 'pick', label: 'All channels' },
    { key: 'now', kind: 'pick', label: 'On now' }, { key: 'h:categories', kind: 'head' },
    { key: 'c:sport', kind: 'pick', label: 'Sport' }, { key: 'c:news', kind: 'pick', label: 'News' },
    { key: 'h:families', kind: 'head' }, { key: 'f:ORBIT', kind: 'pick', label: 'Orbit' },
  ];
  const ids = (base) => X.chips(entries, base, (k) => (k === 'f:ORBIT' ? 'Orbit' : k)).map((c) => c.id);
  assert.deepEqual(J(ids('all')), ['fav', 'all', 'now', 'c:sport', 'c:news']);
  assert.deepEqual(J(ids('f:ORBIT')), ['f:ORBIT', 'fav', 'all', 'now', 'c:sport', 'c:news']);
  assert.equal(X.chips(entries, 'f:ORBIT', () => 'Orbit')[0].label, 'Orbit');
  // no favourites yet: the chip is still there (it says how to add some)
  assert.deepEqual(J(X.chips([{ key: 'all', kind: 'pick', label: 'All channels' }], 'all', String).map((c) => c.id)), ['fav', 'all']);
});

test('touch live: last watched keeps the newest first, no repeats, at most six', () => {
  let l = [];
  ['1', '2', '3', '2'].forEach((id) => { l = X.noteRecent(l, id, 6); });
  assert.deepEqual(J(l), ['2', '3', '1']);
  for (let i = 10; i < 20; i++) l = X.noteRecent(l, String(i), 6);
  assert.equal(l.length, 6);
  assert.equal(l[0], '19');
  assert.deepEqual(J(X.noteRecent(null, 7)), ['7']);
});

test('touch live: the number pad types, deletes and starts over when full', () => {
  assert.equal(X.padKey('', '1', 3), '1');
  assert.equal(X.padKey('10', '5', 3), '105');
  assert.equal(X.padKey('105', '2', 3), '2');
  assert.equal(X.padKey('105', 'del', 3), '10');
  assert.equal(X.padKey('', 'del', 3), '');
  assert.equal(X.padKey('1', 'x', 3), '1');
});

// ---- js/livetv-data.js helpers shared with the TV guide ------------------------------------------

function guide() {
  const store = {};
  const PL = {
    log() {}, warn() {},
    storage: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    plex: { server: { machineId: 'A' }, get: () => new Promise(() => {}) },
  };
  const ctx = vm.createContext({ window: { PL }, PL, setTimeout, clearTimeout, Promise, Date, Math, console });
  for (const f of ['js/livetv-logic.js', 'js/livetv-browse.js', 'js/livetv-data.js']) vm.runInContext(read(f), ctx);
  return { G: PL.liveGuide, store };
}

test('live data: a guide opens on Favourites when there are some, else on the last choice', () => {
  const { G } = guide();
  G.setBrowse({ base: 'c:news' });
  assert.deepEqual(J(G.openingSel()), { base: 'c:news', refine: null });
  G.toggleFavourite('7');
  assert.deepEqual(J(G.openingSel()), { base: 'fav', refine: null });
});

test('live data: onNow lists what is on, skipping guide filler; liveSpec is what the player takes', () => {
  const { G } = guide();
  const t = 10000;
  G.channels = [
    { identifier: '1', id: 11, vcn: '101', title: 'One', name: 'One', thumb: '/a' },
    { identifier: '2', id: 12, vcn: '102', title: 'Two', name: 'Two', thumb: null },
    { identifier: '3', id: 13, vcn: '103', title: 'Three', name: 'Three', thumb: null },
  ];
  G.airings = {
    1: [{ b: t - 60, e: t + 60, title: 'News', genres: 'News' }],
    2: [{ b: t - 60, e: t + 60, title: '..programmes start at 7.00pm' }],
    3: [{ b: t + 60, e: t + 120, title: 'Later' }],
  };
  const on = G.onNow(t);
  assert.equal(on.length, 1);
  assert.equal(on[0].channel.identifier, '1');
  assert.equal(on[0].cat, 'news');
  G.src = { dvrKey: '9', provider: 'p' };
  const spec = G.liveSpec(G.channels, 1, 'Sport');
  assert.deepEqual(J(spec), {
    label: 'Sport', dvrKey: '9', index: 1,
    channel: { identifier: '2', id: 12, vcn: '102', title: 'Two', thumb: null },
    channels: G.channels.map((c) => ({ identifier: c.identifier, id: c.id, vcn: c.vcn, title: c.name, thumb: c.thumb })),
  });
  assert.equal(G.liveSpec(G.channels, 0).label, 'All channels');
});

test('touch live: the TV build never loads web/touch/live', () => {
  assert.ok(!/web\/touch/.test(read('index.html')));
  const man = JSON.parse(read('web/touch/manifest.json'));
  ['live/logic.js', 'live/parts.js', 'live/grid.js', 'live/onnow.js', 'live/search.js', 'live/guide.js'].forEach((f) => assert.ok(man.scripts.includes(f), f));
  assert.ok(man.styles.includes('live/live.css'));
  // logic before the pieces that use it, the page last
  assert.ok(man.scripts.indexOf('live/logic.js') < man.scripts.indexOf('live/parts.js'));
  assert.ok(man.scripts.indexOf('live/parts.js') < man.scripts.indexOf('live/guide.js'));
});
