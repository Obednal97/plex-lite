// Tests for the touch player's gestures and timing (web/touch/player-logic.js, docs/WEB.md "The
// touch player"): taps by thirds, the double-tap seek accumulator, the scrub bar's mapping, pans, the
// controls' timer and the tab order. Also: the TV build never loads the touch player.
//   node --test test/touch-player.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(read('js/player-logic.js'), ctx, { filename: 'js/player-logic.js' });
vm.runInContext(read('web/touch/player-logic.js'), ctx, { filename: 'web/touch/player-logic.js' });
const G = ctx.window.PL.touchPlayerLogic;
const PLogic = ctx.window.PL.playerLogic;
const J = (v) => JSON.parse(JSON.stringify(v));

const W = 390;
const LEFT = 40;
const MID = 195;
const RIGHT = 350;

// a run of taps: [[t, x], ...] -> the acts, with settle() run between taps that are far apart
function run(taps) {
  let state = null;
  const acts = [];
  for (const [t, x] of taps) {
    const s = G.settle(state, t);
    if (s.act) acts.push(s.act);
    state = s.state;
    const r = G.tap(state, { t, x, width: W });
    state = r.state;
    acts.push(J(r.act));
  }
  return { acts, state };
}

test('touch player: taps land in thirds', () => {
  assert.equal(G.zoneAt(0, W), 'back');
  assert.equal(G.zoneAt(129, W), 'back');
  assert.equal(G.zoneAt(131, W), 'mid');
  assert.equal(G.zoneAt(259, W), 'mid');
  assert.equal(G.zoneAt(261, W), 'fwd');
  assert.equal(G.zoneAt(W, W), 'fwd');
});

test('touch player: a single tap waits on the sides, toggles at once in the middle', () => {
  assert.deepEqual(run([[0, MID]]).acts, [{ type: 'toggle' }]);
  const side = run([[0, LEFT]]);
  assert.deepEqual(side.acts, [{ type: 'wait', ms: G.DOUBLE_MS }]);
  // nothing came: the timer's settle makes it a single tap
  assert.equal(G.settle(side.state, G.DOUBLE_MS - 1).act, null);
  assert.equal(G.settle(side.state, G.DOUBLE_MS).act, 'toggle');
  assert.equal(G.settle(side.state, G.DOUBLE_MS).state, null);
});

test('touch player: double-tap left is back 10 s, right is ahead 30 s', () => {
  assert.deepEqual(run([[0, LEFT], [180, LEFT + 20]]).acts[1], { type: 'seek', dir: -1, step: 10, count: 1, total: 10 });
  assert.deepEqual(run([[0, RIGHT], [180, RIGHT - 30]]).acts[1], { type: 'seek', dir: 1, step: 30, count: 1, total: 30 });
});

test('touch player: each extra tap adds the same step, and the ripple shows the running total', () => {
  const back = run([[0, LEFT], [150, LEFT], [400, LEFT], [700, LEFT]]);
  assert.deepEqual(back.acts.slice(1).map((a) => [a.step, a.count, a.total]), [[10, 1, 10], [10, 2, 20], [10, 3, 30]]);
  const fwd = run([[0, RIGHT], [150, RIGHT], [600, RIGHT]]);
  assert.deepEqual(fwd.acts.slice(1).map((a) => a.total), [30, 60]);
  assert.equal(G.seekLabel(-1, 30), '−30 s');
  assert.equal(G.seekLabel(1, 90), '+90 s');
  assert.equal(G.seekLabel(1, 120), '+2 min');
});

test('touch player: a streak ends after a pause; a tap after it starts over', () => {
  const r = run([[0, LEFT], [150, LEFT], [150 + G.STREAK_MS + 1, LEFT]]);
  // the third tap came too late: the streak ended ('end') and it is a fresh first tap
  assert.deepEqual(r.acts.slice(2), ['end', { type: 'wait', ms: G.DOUBLE_MS }]);
});

test('touch player: two slow taps are two single taps, not a double', () => {
  const r = run([[0, LEFT], [G.DOUBLE_MS + 50, LEFT]]);
  assert.deepEqual(r.acts, [{ type: 'wait', ms: G.DOUBLE_MS }, 'toggle', { type: 'wait', ms: G.DOUBLE_MS }]);
});

test('touch player: a double tap needs both taps on the same side; the middle never seeks', () => {
  assert.equal(run([[0, LEFT], [150, RIGHT]]).acts[1].type, 'wait');
  assert.deepEqual(run([[0, MID], [150, MID]]).acts, [{ type: 'toggle' }, { type: 'toggle' }]);
});

test('touch player: switching sides mid-streak starts a streak on the other side', () => {
  const r = run([[0, LEFT], [150, LEFT], [400, RIGHT], [600, RIGHT]]);
  assert.deepEqual(r.acts.slice(1).map((a) => [a.dir, a.total]), [[-1, 10], [1, 30], [1, 60]]);
});

test('touch player: the bar maps the finger to a time through the chapter segments', () => {
  const chapters = [{ start: 0 }, { start: 100 }, { start: 400 }];
  const segs = PLogic.segments(chapters, 600, 342, 4);
  // the ends, off the ends and the middle of a segment
  assert.equal(G.scrubSec(PLogic, segs, 0, 342, 600), 0);
  assert.equal(G.scrubSec(PLogic, segs, -40, 342, 600), 0);
  assert.equal(G.scrubSec(PLogic, segs, 342, 342, 600), 595); // 5 s short of the end
  assert.equal(G.scrubSec(PLogic, segs, 900, 342, 600), 595);
  const s1 = segs[1];
  assert.ok(Math.abs(G.scrubSec(PLogic, segs, s1.left + s1.w / 2, 342, 600) - 250) < 1);
  // a gap counts as the start of the segment after it
  assert.equal(G.scrubSec(PLogic, segs, s1.left - 2, 342, 600), 100);
  // and back: the head sits where the finger is
  const x = PLogic.xAt(segs, 250);
  assert.ok(Math.abs(x - (s1.left + s1.w / 2)) < 0.5);
  // nothing known yet
  assert.equal(G.scrubSec(PLogic, segs, 100, 342, 0), 0);
});

test('touch player: the time label follows the finger and stays over the bar', () => {
  assert.equal(G.labelLeft(171, 80, 342), 131);
  assert.equal(G.labelLeft(10, 80, 342), 0);
  assert.equal(G.labelLeft(340, 80, 342), 262);
  assert.equal(G.labelLeft(10, 80, 342, 12), -12);
  assert.equal(G.labelLeft(340, 80, 342, 12), 274);
});

test('touch player: a sideways drag on the picture scrubs finely', () => {
  // the whole bar's width is a quarter of the film
  assert.equal(G.fineScrub(100, 342, 342, 4000), 1100);
  assert.equal(G.fineScrub(100, -342, 342, 4000), 0);
  assert.equal(G.fineScrub(3900, 342, 342, 4000), 3995);
  assert.equal(G.fineScrub(100, 50, 342, 0), 100);
});

test('touch player: pans are read once the finger has moved', () => {
  assert.equal(G.panKind(3, 6, true), null);
  assert.equal(G.panKind(4, 30, false), 'down');
  assert.equal(G.panKind(4, -30, true), 'none'); // up does nothing
  assert.equal(G.panKind(30, 6, true), 'side');
  assert.equal(G.panKind(30, 6, false), 'none'); // sideways only scrubs with the controls up
  assert.equal(G.closes(G.CLOSE_PX, 0), true);
  assert.equal(G.closes(60, 0.2), false);
  assert.equal(G.closes(60, 0.9), true); // a flick
  assert.equal(G.closes(20, 2), false);
});

test('touch player: the controls hide by themselves only while playing with nothing open', () => {
  const play = { playing: true };
  assert.equal(G.mayHide(play), true);
  assert.equal(G.mayHide({ playing: false }), false);
  for (const k of ['scrubbing', 'sheet', 'pane', 'endcard', 'error']) assert.equal(G.mayHide({ playing: true, [k]: true }), false, k);
});

test('touch player: the controls timer hides after 4 s, re-arms on a touch, stops when paused', () => {
  assert.equal(G.HIDE_MS, 4000);
  const timers = new Map();
  let next = 1;
  let hidden = 0;
  let state = { playing: true };
  const t = G.hideTimer({
    schedule: (fn, ms) => { timers.set(next, { fn, ms }); return next++; },
    cancel: (id) => timers.delete(id),
    hide: () => { hidden++; },
    check: () => state,
  });
  assert.equal(t.poke(state), true);
  assert.equal([...timers.values()][0].ms, 4000);
  // a touch re-arms it: one timer at a time
  t.poke(state);
  assert.equal(timers.size, 1);
  // paused: no timer
  state = { playing: false };
  assert.equal(t.poke(state), false);
  assert.equal(timers.size, 0);
  assert.equal(t.armed(), false);
  // playing again; it fires
  state = { playing: true };
  t.poke(state);
  [...timers.values()][0].fn();
  assert.equal(hidden, 1);
  // it fires after a sheet opened meanwhile: it looks again and stays up
  t.poke(state);
  state = { playing: true, sheet: true };
  [...timers.values()].pop().fn();
  assert.equal(hidden, 1);
});

test('touch player: tabs follow the boards (portrait rows first, landscape Info first)', () => {
  const ids = ['info', 'cast', 'chapters'];
  assert.deepEqual(J(G.tabOrder(ids, false)), ['chapters', 'cast', 'info']);
  assert.deepEqual(J(G.tabOrder(ids, true)), ['info', 'cast', 'chapters']);
  assert.deepEqual(J(G.tabOrder(['info', 'episodes'], false)), ['episodes', 'info']);
  assert.equal(G.landscape(844, 390), true);
  assert.equal(G.landscape(390, 844), false);
});

test('touch player: web only (the TV never loads it), listed in the touch manifest after the shell', () => {
  const tvIndex = read('index.html');
  assert.ok(!/web\/touch/.test(tvIndex));
  const man = JSON.parse(read('web/touch/manifest.json'));
  const at = (f) => man.scripts.indexOf(f);
  assert.ok(at('player-logic.js') >= 0 && at('player.js') > at('shell.js') && at('player.js') > at('sheets.js'));
  assert.ok(man.styles.indexOf('player.css') >= 0);
  // the TV player is reused, not copied: the touch player extends it
  assert.match(read('web/touch/player.js'), /const Player = PL\.Player;[\s\S]*Object\.create\(base\)/);
  assert.match(read('js/screens/player.js'), /PL\.Player = Player/);
});
