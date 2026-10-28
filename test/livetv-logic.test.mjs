// node --test test/ — Live TV's pure logic (js/livetv-logic.js): guide parsing, the grid's time maths
// and focus rules, channel-number entry, labels and the live remote map. Made-up channels only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const ctx = { window: {} };
vm.runInContext(readFileSync(here + '../js/livetv-logic.js', 'utf8'), vm.createContext(ctx));
const L = ctx.window.PL.liveLogic;
const plain = (x) => JSON.parse(JSON.stringify(x));

// a local-time timestamp (seconds) for today at hh:mm
const at = (h, m = 0, dayOffset = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return Math.floor(d.getTime() / 1000);
};
const air = (b, e, title = 'x') => ({ b, e, title });

test('clock, day and span labels', () => {
  assert.equal(L.clock(at(9, 5)), '09:05');
  assert.equal(L.clock(at(21, 30)), '21:30');
  assert.equal(L.day(at(23, 0), at(8, 0)), 'Today');
  assert.equal(L.day(at(1, 0, 1), at(23, 0)), 'Tomorrow');
  assert.equal(L.span(45 * 60), '45 min');
  assert.equal(L.span(3600), '1 hr');
  assert.equal(L.span(80 * 60), '1 hr 20 min');
  assert.equal(L.span(10), '1 min');
});

test('status: left, starts in, starts at, ended', () => {
  const a = air(at(21), at(22));
  assert.equal(L.status(a, at(21, 35)), '25 min left');
  assert.equal(L.status(a, at(20, 50)), 'Starts in 10 min');
  assert.equal(L.status(a, at(18, 0)), 'Starts 21:00');
  assert.equal(L.status(air(at(6, 0, 1), at(7, 0, 1)), at(18, 0)), 'Starts Tomorrow 06:00');
  assert.equal(L.status(a, at(22, 0)), 'Ended');
  assert.equal(L.times(a, at(20)), '21:00 – 22:00');
  assert.equal(L.progress(a, at(21, 15)), 0.25);
  assert.equal(L.progress(a, at(23)), 1);
});

test('channel names: number and group prefixes', () => {
  assert.equal(L.stripNumber('1001 UK - News One', '1001'), 'UK - News One');
  assert.equal(L.stripNumber('News One', '1001'), 'News One');
  assert.ok(L.groupsInUse(['UK - A', 'UK - B', 'USA - C', 'Plain']));
  assert.ok(!L.groupsInUse(['A', 'B', 'UK - C']));
  assert.equal(L.channelName('UK - News One', true), 'News One');
  assert.equal(L.channelName('UK - News One', false), 'UK - News One');
  assert.equal(L.channelName('Sci-Fi Shorts', true), 'Sci-Fi Shorts'); // no " - " group
});

test('programme titles: shows, XMLTV placeholders, movies', () => {
  assert.deepEqual(plain(L.programme({ type: 'episode', grandparentTitle: 'Show', title: 'Pilot', parentIndex: 1, index: 2 })), { title: 'Show', sub: 'S1 E2 · Pilot' });
  // dated "seasons" and "Episode 10-27" names from XMLTV say nothing
  assert.deepEqual(plain(L.programme({ type: 'episode', grandparentTitle: 'Show', title: 'Episode 10-27', parentIndex: 2026, index: 3 })), { title: 'Show', sub: '' });
  assert.deepEqual(plain(L.programme({ type: 'movie', title: 'Film', year: 1963 })), { title: 'Film', sub: '1963' });
});

test('parseGrid: channels, several airings per programme, sorted and deduplicated', () => {
  const mc = {
    Metadata: [
      { type: 'movie', title: 'Late Film', key: '/k/2', Genre: [{ tag: 'Drama' }], Media: [
        { channelIdentifier: '102', channelID: 7, channelVcn: '102', channelTitle: '102 Two', beginsAt: 300, endsAt: 400 }] },
      { type: 'episode', grandparentTitle: 'News', title: 'Episode 1-1', parentIndex: 2026, key: '/k/1', Media: [
        { channelIdentifier: '101', channelID: 3, channelVcn: '101', channelTitle: '101 One', channelThumb: '/t', beginsAt: 200, endsAt: 300 },
        { channelIdentifier: '101', channelID: 3, channelVcn: '101', channelTitle: '101 One', beginsAt: 100, endsAt: 200 },
        { channelIdentifier: '101', channelID: 3, channelVcn: '101', channelTitle: '101 One', beginsAt: 100, endsAt: 200 }] },
    ],
  };
  const g = L.parseGrid(mc);
  assert.deepEqual(Object.keys(g.channels).sort(), ['101', '102']);
  assert.deepEqual(plain(g.channels['101']), { identifier: '101', id: 3, vcn: '101', title: 'One', thumb: '/t' });
  assert.deepEqual(plain(g.airings['101'].map((a) => [a.b, a.e, a.title])), [[100, 200, 'News'], [200, 300, 'News']]);
  assert.equal(g.airings['102'][0].genres, 'Drama');
});

test('tidy and merge: overlaps trimmed, inner duplicates dropped', () => {
  const out = L.tidy([air(0, 100, 'a'), air(50, 150, 'b'), air(60, 90, 'c'), air(150, 200, 'd')]);
  assert.deepEqual(plain(out.map((a) => [a.b, a.e, a.title])), [[0, 50, 'a'], [50, 150, 'b'], [150, 200, 'd']]);
  const merged = L.merge([air(0, 100, 'a')], [air(0, 100, 'a'), air(100, 200, 'b')]);
  assert.deepEqual(plain(merged.map((a) => a.title)), ['a', 'b']);
  assert.deepEqual(plain(L.prune([air(0, 10), air(10, 20), air(20, 30)], 15).map((a) => a.b)), [10, 20]);
});

test('indexAt, nowNext and pick', () => {
  const list = [air(0, 100, 'a'), air(100, 200, 'b'), air(300, 400, 'c')];
  assert.equal(L.indexAt(list, 150), 1);
  assert.equal(L.indexAt(list, 250), -1);
  assert.deepEqual([L.nowNext(list, 50).now.title, L.nowNext(list, 50).next.title], ['a', 'b']);
  const gap = L.nowNext(list, 250);
  assert.equal(gap.now, null);
  assert.equal(gap.next.title, 'c');
  assert.deepEqual(plain(L.nowNext([], 5)), { now: null, next: null });
  // pick keeps the time: on at the anchor, else the next after, else the last before
  assert.equal(L.pick(list, 120), 1);
  assert.equal(L.pick(list, 250), 2);
  assert.equal(L.pick(list, 999), 2);
  assert.equal(L.pick([], 10), -1);
});

test('cell geometry: clipped at origin, title shifted into view', () => {
  const pps = 1; // 1 px per second keeps the numbers readable
  // started before the guide's origin: drawn from origin
  assert.deepEqual(plain(L.cell(air(-600, 1200), 0, 0, pps, 4)), { x: 0, w: 1196, shift: 0 });
  // the view has moved on 600 s: the title moves 600 px right to stay visible
  assert.deepEqual(plain(L.cell(air(0, 1800), 0, 600, pps, 4)), { x: 0, w: 1796, shift: 600 });
  // ...but never past the cell's end (keeps 120 px for the text)
  assert.equal(L.cell(air(0, 700), 0, 650, pps, 4).shift, 576);
  assert.deepEqual(plain(L.cell(air(1800, 3600), 0, 0, pps, 4)), { x: 1800, w: 1796, shift: 0 });
});

test('viewStart: scrolls in half-hour steps only when the focus leaves the view', () => {
  const H = 1800;
  const span = 4 * H; // a two-hour view
  // inside: no change
  assert.equal(L.viewStart(0, air(H, 2 * H), 0, span, H), 0);
  // starts in the last half hour of the view: move on until one step is left to its right
  assert.equal(L.viewStart(0, air(3 * H + 60, 4 * H), 0, span, H), H);
  assert.equal(L.viewStart(0, air(5 * H, 6 * H), 0, span, H), 2 * H);
  // back before the view: snap to its half hour
  assert.equal(L.viewStart(3 * H, air(H + 300, 2 * H), 0, span, H), H);
  // never before origin
  assert.equal(L.viewStart(H, air(-500, 100), 0, span, H), 0);
});

test('firstRow keeps the focus two rows down and never leaves a gap at the end', () => {
  assert.equal(L.firstRow(0, 50, 6, 2), 0);
  assert.equal(L.firstRow(2, 50, 6, 2), 0);
  assert.equal(L.firstRow(10, 50, 6, 2), 8);
  assert.equal(L.firstRow(49, 50, 6, 2), 44);
  assert.equal(L.firstRow(3, 4, 6, 2), 0);
});

test('number entry: digits, exact and nearest matches, early commit', () => {
  const nums = ['101', '102', '105', '130', '1001', '1003'];
  assert.equal(L.maxDigits(nums), 4);
  assert.equal(L.typeDigit('', 1, 4), '1');
  assert.equal(L.typeDigit('100', 1, 4), '1001');
  assert.equal(L.typeDigit('1001', 7, 4), '7'); // a full entry starts over
  assert.deepEqual(plain(L.matchNumber(nums, '105')), { index: 2, exact: true });
  assert.deepEqual(plain(L.matchNumber(nums, '103')), { index: 2, exact: false }); // nearest higher
  assert.deepEqual(plain(L.matchNumber(nums, '9999')), { index: 5, exact: false }); // the highest
  assert.deepEqual(plain(L.matchNumber(nums, '1001')), { index: 4, exact: true });
  assert.equal(L.matchNumber(nums, ''), null);
  assert.equal(L.matchNumber([], '1'), null);
  // "10" could still become 101, 102, 1001...; "105" can't grow; "13" can still be 130
  assert.equal(L.entryDone(nums, '10', 4), false);
  assert.equal(L.entryDone(nums, '105', 4), true);
  assert.equal(L.entryDone(nums, '13', 4), false);
  assert.equal(L.entryDone(nums, '1003', 4), true);
  assert.equal(L.entryDone(nums, '7', 4), true); // nothing starts with 7: commit (to the nearest)
  // while typing, a prefix shows where the digits are heading
  assert.equal(L.previewNumber(nums, '13').index, 3);
  assert.equal(L.previewNumber(nums, '13').prefix, true);
  assert.equal(L.previewNumber(nums, '105').exact, true);
  assert.deepEqual(plain(L.previewNumber(nums, '7')), { index: 0, exact: false }); // nearest higher: 101
});

test('buffer: none when the TV exposes no range, behind-live maths', () => {
  assert.equal(L.buffer(0, 0, 0), null);
  assert.equal(L.buffer(0, Infinity, 5), null);
  assert.equal(L.buffer(0, 10, 5), null); // too short to seek in
  assert.deepEqual(plain(L.buffer(0, 600, 348)), { start: 0, end: 600, behind: 252 });
  assert.ok(L.isLive(5));
  assert.ok(!L.isLive(30));
  assert.equal(L.behindLabel(252), '−4:12');
  assert.equal(L.behindLabel(3725), '−1:02:05');
  assert.equal(L.behindText(12), '12 sec behind live');
  assert.equal(L.behindText(250), '4 min behind live');
});

test('live remote map', () => {
  const k = (c, key) => L.liveKey(Object.assign({ view: 'none', zone: 'bar', canSeek: false, playing: true, hasIcons: true }, c), key);
  // watching
  assert.equal(k({}, 'back'), 'exit');
  assert.equal(k({}, 'up'), 'guide-open');
  assert.equal(k({}, 'down'), 'guide-open');
  assert.equal(k({}, 'ok'), 'banner');
  assert.equal(k({}, 'left'), 'banner');
  assert.equal(k({ canSeek: true }, 'left'), 'jump-back');
  assert.equal(k({ canSeek: true }, 'right'), 'jump-fwd');
  // the banner
  assert.equal(k({ view: 'banner' }, 'back'), 'hide');
  assert.equal(k({ view: 'banner' }, 'ok'), 'toggle-pause');
  assert.equal(k({ view: 'banner', playing: false }, 'ok'), null);
  assert.equal(k({ view: 'banner' }, 'up'), 'zone-icons');
  assert.equal(k({ view: 'banner', hasIcons: false }, 'up'), null);
  assert.equal(k({ view: 'banner' }, 'down'), 'guide-open');
  assert.equal(k({ view: 'banner' }, 'left'), null);
  assert.equal(k({ view: 'banner', canSeek: true }, 'right'), 'jump-fwd');
  assert.equal(k({ view: 'banner', zone: 'icons' }, 'right'), 'icon-next');
  assert.equal(k({ view: 'banner', zone: 'icons' }, 'ok'), 'icon-press');
  assert.equal(k({ view: 'banner', zone: 'icons' }, 'down'), 'zone-bar');
  assert.equal(k({ view: 'banner', zone: 'icons' }, 'back'), 'hide');
  // the mini guide
  assert.equal(k({ view: 'guide' }, 'up'), 'guide-up');
  assert.equal(k({ view: 'guide' }, 'ok'), 'guide-tune');
  assert.equal(k({ view: 'guide' }, 'back'), 'guide-close');
  assert.equal(k({ view: 'guide' }, 'left'), 'guide-close');
  assert.equal(k({ view: 'guide' }, 'right'), null);
});

test('guide filler is not a programme', () => {
  assert.equal(L.isFiller('..programmes start at 7.00pm'), true);
  assert.equal(L.isFiller('…programmes coming soon'), true);
  assert.equal(L.isFiller('Breakfast'), false);
  assert.equal(L.isFiller(undefined), false);
});
