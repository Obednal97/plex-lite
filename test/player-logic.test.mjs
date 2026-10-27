// node --test test/ — the player's pure logic (js/player-logic.js): the segmented seek bar, labels and
// the remote key map. Made-up streams and chapters only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const ctx = { window: {} };
vm.runInContext(readFileSync(here + '../js/player-logic.js', 'utf8'), vm.createContext(ctx));
const L = ctx.window.PL.playerLogic;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('segments: one per chapter, gaps between, ends exactly at the width', () => {
  const ch = [{ start: 0 }, { start: 100 }, { start: 300 }];
  const segs = L.segments(ch, 600, 1000, 6);
  assert.equal(segs.length, 3);
  assert.deepEqual(plain(segs.map((s) => [s.start, s.end])), [[0, 100], [100, 300], [300, 600]]);
  assert.equal(segs[0].left, 0);
  assert.equal(segs[1].left, segs[0].w + 6);
  const last = segs[2];
  assert.equal(last.left + last.w, 1000);
  // widths follow the durations (988 px to share)
  assert.ok(Math.abs(segs[0].w - 988 / 6) <= 1);
  assert.ok(Math.abs(segs[1].w - 988 / 3) <= 1);
});

test('segments: no chapters, one chapter or no duration -> a single bar', () => {
  assert.deepEqual(plain(L.segments([], 600, 1728, 6)), [{ start: 0, end: 600, left: 0, w: 1728 }]);
  assert.equal(L.segments([{ start: 0 }], 600, 1728, 6).length, 1);
  assert.equal(L.segments([{ start: 0 }, { start: 10 }], 0, 1728, 6).length, 1);
});

test('segments: chapters that start late, overlap or sit at the very end are folded in', () => {
  const segs = L.segments([{ start: 5 }, { start: 5.4 }, { start: 200 }, { start: 599.5 }], 600, 1000, 6);
  assert.deepEqual(plain(segs.map((s) => [s.start, s.end])), [[0, 200], [200, 600]]);
});

test('xAt / secAt round-trip and gaps map to the next segment', () => {
  const segs = L.segments([{ start: 0 }, { start: 100 }, { start: 300 }], 600, 1000, 6);
  for (const t of [0, 50, 99, 100, 150, 299, 300, 450, 600]) {
    const x = L.xAt(segs, t);
    assert.ok(Math.abs(L.secAt(segs, x) - t) < 0.75, `t=${t} x=${x} back=${L.secAt(segs, x)}`);
  }
  const gapX = segs[0].w + 3;
  assert.equal(L.secAt(segs, gapX), 100);
  assert.equal(L.secAt(segs, -5), 0);
  assert.equal(L.secAt(segs, 5000), 600);
  assert.equal(L.xAt(segs, 0), 0);
  assert.equal(L.xAt(segs, 600), 1000);
});

test('fill and segmentIndex', () => {
  const segs = L.segments([{ start: 0 }, { start: 100 }], 300, 1000, 6);
  assert.equal(L.segmentIndex(segs, 99), 0);
  assert.equal(L.segmentIndex(segs, 100), 1);
  assert.equal(L.fill(segs[0], 50), 0.5);
  assert.equal(L.fill(segs[0], 250), 1);
  assert.equal(L.fill(segs[1], 50), 0);
  assert.equal(L.fill(segs[1], 200), 0.5);
});

test('scrub line names the chapter it is jumping to, else how far', () => {
  const ch = [{ start: 0, title: 'Chapter 1' }, { start: 300, title: 'The Gate' }];
  assert.equal(L.scrubLine(553, 553, ch), 'Paused at 9:13');
  assert.equal(L.scrubLine(100, 400, ch), 'Paused at 1:40 · jumping to The Gate');
  assert.equal(L.scrubLine(400, 100, ch), 'Paused at 6:40 · jumping to Chapter 1');
  assert.equal(L.scrubLine(100, 190, ch), 'Paused at 1:40 · ahead 1:30');
  assert.equal(L.scrubLine(190, 100, []), 'Paused at 3:10 · back 1:30');
});

test('runtime', () => {
  assert.equal(L.runtime(150000), '3 min');
  assert.equal(L.runtime(20000), '1 min');
  assert.equal(L.runtime(6120000), '1 h 42 min');
  assert.equal(L.runtime(7200000), '2 h');
  assert.equal(L.runtime(0), '');
});

test('subtitle labels drop the codec and keep SDH / Forced', () => {
  assert.equal(L.subtitleLabel({ displayTitle: 'English', extendedDisplayTitle: 'English (SRT)' }), 'English');
  assert.equal(L.subtitleLabel({ displayTitle: 'English', extendedDisplayTitle: 'English [SDH] (SRT)' }), 'English (SDH)');
  assert.equal(L.subtitleLabel({ extendedDisplayTitle: 'Norsk bokmål (norsk bokmål SRT)' }), 'Norsk bokmål');
  assert.equal(L.subtitleLabel({ displayTitle: 'English (PGS)', forced: true }), 'English (Forced)');
  assert.equal(L.subtitleLabel({ displayTitle: 'Français (Forced)', forced: true }), 'Français (Forced)');
  assert.equal(L.subtitleLabel({ index: 4 }), 'Track 4');
  assert.equal(L.isPictureSub({ codec: 'pgs' }), true);
  assert.equal(L.isPictureSub({ codec: 'vobsub' }), true);
  assert.equal(L.isPictureSub({ codec: 'srt' }), false);
  assert.equal(L.isPictureSub({ codec: 'ASS' }), false);
});

test('audio labels: language, channels and codec', () => {
  assert.deepEqual(plain(L.audioLabel({ language: 'English', channels: 6, codec: 'ac3' })), { label: 'English', detail: '5.1 surround · AC3' });
  assert.deepEqual(plain(L.audioLabel({ language: 'English', channels: 6, codec: 'eac3', title: 'Commentary' })), { label: 'English · Commentary', detail: '5.1 surround · E-AC3' });
  assert.deepEqual(plain(L.audioLabel({ language: 'Deutsch', channels: 2, codec: 'aac', title: 'Stereo' })), { label: 'Deutsch', detail: 'Stereo · AAC' });
  assert.equal(L.audioLabel({ language: 'English', channels: 8, codec: 'truehd' }).detail, '7.1 surround · TrueHD');
  assert.equal(L.videoLabel({ videoResolution: '1080', videoCodec: 'h264' }), '1080p · H.264');
  assert.equal(L.videoLabel({ videoResolution: '4k', videoCodec: 'hevc' }), '4K · HEVC');
});

const base = { hidden: false, zone: 'bar', cta: null, live: false, playable: true, paused: false, scrubbing: false, held: false, hasIcons: true, hasTabs: true, hasCards: true };
const act = (over, key) => L.keyAction({ ...base, ...over }, key);

test('keys while watching (controls hidden)', () => {
  const h = { hidden: true };
  assert.equal(act(h, 'left'), 'jump-back');
  assert.equal(act(h, 'right'), 'jump-fwd');
  assert.equal(act(h, 'up'), 'show');
  assert.equal(act(h, 'down'), 'show');
  assert.equal(act(h, 'ok'), 'show');
  assert.equal(act(h, 'back'), 'exit');
  assert.equal(act({ ...h, paused: true }, 'right'), 'scrub-fwd');
  // skip intro / credits
  assert.equal(act({ ...h, cta: 'pill' }, 'ok'), 'cta-press');
  assert.equal(act({ ...h, cta: 'pill' }, 'right'), 'jump-fwd');
  assert.equal(act({ ...h, cta: 'pill' }, 'up'), 'show-cta');
  assert.equal(act({ ...h, cta: 'pill' }, 'back'), 'cta-dismiss');
  // end of episode card
  assert.equal(act({ ...h, cta: 'endcard' }, 'ok'), 'cta-press');
  assert.equal(act({ ...h, cta: 'endcard' }, 'left'), 'cta-prev');
  assert.equal(act({ ...h, cta: 'endcard' }, 'back'), 'cta-dismiss');
  // live TV: no seeking
  assert.equal(act({ ...h, live: true }, 'right'), 'show');
  assert.equal(act({ ...h, playable: false }, 'right'), 'show');
});

test('keys on the bar', () => {
  assert.equal(act({}, 'left'), 'jump-back');
  assert.equal(act({}, 'right'), 'jump-fwd');
  assert.equal(act({ held: true }, 'right'), 'scrub-fwd');
  assert.equal(act({ paused: true }, 'left'), 'scrub-back');
  assert.equal(act({ scrubbing: true }, 'right'), 'scrub-fwd');
  assert.equal(act({}, 'ok'), 'pause');
  assert.equal(act({ paused: true }, 'ok'), 'play');
  assert.equal(act({ scrubbing: true, paused: true }, 'ok'), 'commit');
  assert.equal(act({ scrubbing: true }, 'back'), 'cancel');
  assert.equal(act({}, 'back'), 'hide');
  assert.equal(act({}, 'up'), 'zone-icons');
  assert.equal(act({ hasIcons: false, cta: 'pill' }, 'up'), 'zone-cta');
  assert.equal(act({ hasIcons: false }, 'up'), null);
  assert.equal(act({}, 'down'), 'zone-tabs');
  assert.equal(act({ scrubbing: true }, 'up'), null);
  assert.equal(act({ scrubbing: true }, 'down'), null);
  assert.equal(act({ live: true }, 'right'), null);
  assert.equal(act({ live: true }, 'ok'), 'pause');
  assert.equal(act({ live: true }, 'down'), null);
});

test('keys in the icons, menus, tabs, cards and call to action', () => {
  assert.equal(act({ zone: 'icons' }, 'right'), 'icon-next');
  assert.equal(act({ zone: 'icons' }, 'ok'), 'icon-press');
  assert.equal(act({ zone: 'icons' }, 'down'), 'zone-bar');
  assert.equal(act({ zone: 'icons' }, 'up'), null);
  assert.equal(act({ zone: 'icons', cta: 'pill' }, 'up'), 'zone-cta');
  assert.equal(act({ zone: 'menu' }, 'down'), 'menu-down');
  assert.equal(act({ zone: 'menu' }, 'ok'), 'menu-press');
  assert.equal(act({ zone: 'menu' }, 'back'), 'menu-back');
  assert.equal(act({ zone: 'menu' }, 'left'), null);
  assert.equal(act({ zone: 'tabs' }, 'right'), 'tab-next');
  assert.equal(act({ zone: 'tabs' }, 'down'), 'zone-cards');
  assert.equal(act({ zone: 'tabs', hasCards: false }, 'down'), null);
  assert.equal(act({ zone: 'tabs' }, 'up'), 'zone-bar');
  assert.equal(act({ zone: 'tabs' }, 'back'), 'zone-bar');
  assert.equal(act({ zone: 'cards' }, 'ok'), 'card-press');
  assert.equal(act({ zone: 'cards' }, 'up'), 'zone-tabs');
  assert.equal(act({ zone: 'cards' }, 'back'), 'zone-bar');
  assert.equal(act({ zone: 'cta', cta: 'pill' }, 'ok'), 'cta-press');
  assert.equal(act({ zone: 'cta', cta: 'pill' }, 'down'), 'zone-icons');
  assert.equal(act({ zone: 'cta', cta: 'pill', hasIcons: false }, 'down'), 'zone-bar');
  assert.equal(act({ zone: 'cta', cta: 'pill' }, 'right'), null);
  assert.equal(act({ zone: 'cta', cta: 'endcard' }, 'right'), 'cta-next');
});

test('hold speed grows, row start keeps the focus visible', () => {
  assert.equal(L.holdSpeed(500, 3600), 20);
  assert.equal(L.holdSpeed(2000, 3600), 60);
  assert.equal(L.holdSpeed(4000, 3600), 120);
  assert.equal(L.holdSpeed(6000, 7200), 480);
  assert.equal(L.rowStart(0, 3, 10, 5), 0);
  assert.equal(L.rowStart(0, 5, 10, 5), 1);
  assert.equal(L.rowStart(4, 2, 10, 5), 2);
  assert.equal(L.rowStart(0, 9, 10, 5), 5);
  assert.equal(L.rowStart(3, 1, 3, 5), 0);
});

const role = (id, tag, r, thumb) => ({ id, tag, role: r, thumb });

test('cast: a movie lists its roles, one per person, no nameless entries', () => {
  const movie = { type: 'movie', Role: [role(1, 'Ann Lee', 'Mia', '/p/1'), role(2, 'Bo Dahl', 'Kurt'), role(1, 'Ann Lee', 'Mia (voice)'), role(3, '', 'X')] };
  assert.deepEqual(plain(L.castList(movie)), [
    { id: 1, name: 'Ann Lee', role: 'Mia', thumb: '/p/1', guest: false },
    { id: 2, name: 'Bo Dahl', role: 'Kurt', thumb: null, guest: false },
  ]);
  assert.deepEqual(plain(L.castList({ type: 'movie' })), []);
});

test('cast: episode guests first, then the show cast in billing order, de-duplicated', () => {
  const show = { Role: [role(1, 'Lead One', 'Ray'), role(2, 'Lead Two', ''), role(3, 'Third', 'Sam')] };
  const ep = { type: 'episode', Role: [role(9, 'Guest Nine', 'Officer'), role(2, 'Lead Two', 'Dot'), role(8, 'Guest Eight', 'Nurse')] };
  const list = plain(L.castList(ep, show));
  assert.deepEqual(list.map((p) => [p.name, p.role, p.guest]), [
    ['Guest Nine', 'Officer', true], ['Guest Eight', 'Nurse', true],
    ['Lead One', 'Ray', false], ['Lead Two', 'Dot', false], ['Third', 'Sam', false],
  ]);
});

test('cast: leads Plex copies onto the episode are not guests; unknown show cast marks nobody', () => {
  const show = { Role: [role(1, 'Lead One', 'Ray'), role(2, 'Lead Two', 'Dot')] };
  const ep = { type: 'episode', Role: [role(1, 'Lead One', 'Ray'), role(2, 'Lead Two', 'Dot')] };
  assert.deepEqual(plain(L.castList(ep, show)).map((p) => p.guest), [false, false]);
  const solo = plain(L.castList({ type: 'episode', Role: [role(5, 'Someone', 'Clerk')] }, null));
  assert.deepEqual(solo.map((p) => [p.name, p.guest]), [['Someone', false]]);
  // billed far down the show's long cumulative list still counts as a guest here
  const long = { Role: Array.from({ length: 30 }, (_, i) => role(100 + i, 'P' + i, 'R' + i)) };
  const guest = plain(L.castList({ type: 'episode', Role: [role(125, 'P25', 'R25')] }, long));
  assert.equal(guest[0].name, 'P25');
  assert.equal(guest[0].guest, true);
  assert.equal(guest.filter((p) => p.name === 'P25').length, 1);
});

test('cast: people without ids de-duplicate by name, and the list is capped', () => {
  const ep = { type: 'movie', Role: [{ tag: 'No Id', role: 'A' }, { tag: 'no id ', role: 'B' }] };
  assert.equal(L.castList(ep).length, 1);
  const many = { type: 'movie', Role: Array.from({ length: 60 }, (_, i) => role(i, 'N' + i, '')) };
  assert.equal(L.castList(many).length, 40);
});
