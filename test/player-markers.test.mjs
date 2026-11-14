// Tests for Skip Intro / Skip Credits timing (js/screens/player.js checkMarkers): with auto-skip on,
// the pill counts down AUTO_SKIP_SEC of playback before it skips, as Plex does, and auto-skip credits
// never jumps early on an episode without a credits marker.
//   node --test test/player-markers.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const store = {};
const toasts = [];
const ctx = {
  document: {},
  PL: {
    KEY: {},
    playerLogic: {},
    storage: { get: (k, d) => (k in store ? store[k] : d) },
    toast: (t) => toasts.push(t),
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  },
};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, 'js/screens/player.js'), 'utf8'), ctx, { filename: 'js/screens/player.js' });
const Player = ctx.PL.Player;

const INTRO = { start: 220.12, end: 281.12 };

// A player part-way through an episode: only the marker logic is real, the rest records calls.
function player({ autoIntro = false, autoCredits = false, fromMarker = true, next = { ratingKey: '2' } } = {}) {
  store.autoSkipIntro = autoIntro;
  store.autoSkipCredits = autoCredits;
  toasts.length = 0;
  const calls = [];
  const p = Object.create(Player.prototype);
  Object.assign(p, {
    markers: { intros: [INTRO], creditsStart: 2410.27, creditsFromMarker: fromMarker },
    markerState: { introDone: {}, creditsHandled: false, pill: null },
    state: 'playing', osdHidden: true, zone: 'bar', painted: {}, pos: 0,
    pillLabel: {}, pillLine: { style: {} }, pill: { classList: { toggle() {} } }, calls,
  });
  p.position = () => p.pos;
  p.durationSec = () => 2453.6;
  p.paintZone = () => { p.pillVisible = p.pillShown(); };
  p.hideOsd = () => {};
  p.seekTo = (s) => calls.push(['seek', s]);
  p.nextItem = () => next;
  p.playNext = () => calls.push(['next']);
  p.showUpNext = () => calls.push(['upnext']);
  p.finishCredits = () => calls.push(['finish']);
  p.at = (sec) => { p.pos = sec; p.checkMarkers(); return p; };
  return p;
}

test('markers: auto-skip intro shows the pill and counts down 5 s of playback before it skips', () => {
  const p = player({ autoIntro: true });
  p.at(INTRO.start);
  assert.equal(p.markerState.pill.kind, 'intro', 'the Skip Intro pill is up at the marker');
  assert.deepEqual(p.calls, [], 'no jump at the marker itself');
  p.at(INTRO.start + 2.5);
  p.paintCtaLine();
  assert.equal(p.painted['pill-fill'], '50.0% 0', 'the pill is half filled');
  p.at(INTRO.start + 4.9);
  assert.deepEqual(p.calls, [], 'still counting');
  p.at(INTRO.start + 5);
  assert.deepEqual(p.calls, [['seek', INTRO.end]], 'then it skips to the intro end');
  assert.deepEqual(toasts, ['Skipped intro']);
  assert.equal(p.markerState.pill, null);
  p.at(INTRO.start + 6);
  assert.equal(p.calls.length, 1, 'once');
});

test('markers: a new pill paints its first value without the glide (no flash of the last pill\'s fill)', () => {
  const p = player({ autoIntro: true });
  let during;
  p.paintZone = () => { p.pillVisible = p.pillShown(); during = p.pillLine.style.transition; p.paintCtaLine(); };
  p.at(INTRO.start);
  assert.equal(during, 'none', 'no transition while the first value is painted');
  assert.equal(p.painted['pill-fill'], '100.0% 0', 'it starts empty');
  assert.equal(p.pillLine.style.transition, '', 'the glide is back for the countdown');
});

test('markers: joining the intro part-way counts down from there; Back cancels; OK skips at once', () => {
  const mid = player({ autoIntro: true });
  mid.at(240).at(244.9);
  assert.deepEqual(mid.calls, []);
  mid.at(245);
  assert.deepEqual(mid.calls, [['seek', INTRO.end]]);

  const back = player({ autoIntro: true });
  back.at(INTRO.start).at(INTRO.start + 2);
  back.dismissCta();
  back.at(INTRO.start + 5).at(INTRO.start + 30);
  assert.deepEqual(back.calls, [], 'Back keeps the intro playing');

  const past = player({ autoIntro: true });
  past.at(INTRO.start + 1).at(INTRO.end + 20);
  assert.deepEqual(past.calls, [], 'a jump past the intro during the countdown is not pulled back');
  assert.equal(past.markerState.pill, null);

  const landing = player({ autoIntro: true });
  landing.at(INTRO.start);
  landing.jumpTarget = 260;                     // a jump the person pressed, not landed yet
  landing.at(INTRO.start + 5);
  assert.deepEqual(landing.calls, [], 'the countdown waits for a jump that is still landing');
  landing.jumpTarget = null;
  landing.at(260);
  assert.deepEqual(landing.calls, [['seek', INTRO.end]], 'then skips once it has landed in the intro');

  const ok = player({ autoIntro: true });
  ok.at(INTRO.start + 1);
  assert.equal(ok.pressCta(), true);
  assert.deepEqual(ok.calls, [['seek', INTRO.end]]);
});

test('markers: without auto-skip the intro only shows the pill', () => {
  const p = player();
  p.at(INTRO.start).at(INTRO.start + 30);
  assert.equal(p.markerState.pill.kind, 'intro');
  assert.deepEqual(p.calls, []);
});

test('markers: auto-skip credits counts down on the Skip Credits pill, then plays the next episode', () => {
  const p = player({ autoCredits: true });
  p.at(2410.27);
  assert.equal(p.markerState.pill.kind, 'credits');
  p.at(2415.2);
  assert.deepEqual(p.calls, []);
  p.at(2415.27);
  assert.deepEqual(p.calls, [['next']]);

  const last = player({ autoCredits: true, next: null });
  last.at(2410.27).at(2415.27);
  assert.deepEqual(last.calls, [['finish']], 'the last episode finishes after the countdown');
});

test('markers: auto-skip credits waits for the real end when there is no credits marker', () => {
  const p = player({ autoCredits: true, fromMarker: false });
  p.markers.creditsStart = 2423.6; // the 30 s fallback
  p.at(2423.6).at(2440);
  assert.deepEqual(p.calls, [], 'nothing early: onEnded plays the next episode');
  assert.equal(p.markerState.pill, null);
});

test('markers: without auto-skip, the credits bring up Up Next as before', () => {
  const p = player();
  p.at(2410.27);
  assert.deepEqual(p.calls, [['upnext']]);
  const fallback = player({ fromMarker: false });
  fallback.at(2423.6);
  assert.deepEqual(fallback.calls, [['upnext']]);
});
