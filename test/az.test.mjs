// node --test test/ — the A–Z rail's maths (js/az.js): firstCharacter counts -> offsets, the letter
// at an index, rail steps and phone-keypad multi-tap. Made-up counts only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = readFileSync(here + '../js/az.js', 'utf8');
const PL = { KEY: { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13 } };
vm.runInContext(src, vm.createContext({ PL, setTimeout, clearTimeout }));
const az = PL.az;
const plain = (x) => JSON.parse(JSON.stringify(x));

// Plex's answer shape: '#' comes as key "%23" / title "#"; letters without titles are left out.
const DIRS = [
  { key: '%23', title: '#', size: 3 },
  { key: 'A', title: 'A', size: 5 },
  { key: 'B', title: 'B', size: 2 },
  { key: 'D', title: 'D', size: 4 },
  { key: 'S', title: 'S', size: 7 },
  { key: 'Z', title: 'Z', size: 1 },
];

test('slots: letters, # for digits and symbols, accents fold, other scripts have none', () => {
  assert.equal(az.slotOf('A'), 'A');
  assert.equal(az.slotOf('q'), 'Q');
  assert.equal(az.slotOf('#'), '#');
  assert.equal(az.slotOf('7'), '#');
  assert.equal(az.slotOf("'"), '#');
  assert.equal(az.slotOf('É'), 'E');
  assert.equal(az.slotOf('ö'), 'O');
  assert.equal(az.slotOf('Ж'), null);
  assert.equal(az.slotOf('日'), null);
  assert.equal(az.slotOf(''), null);
  assert.equal(az.slotOf(null), null);
});

test('ascending: each letter starts after the counts before it', () => {
  const m = az.index(DIRS, false);
  assert.equal(m.total, 22);
  assert.deepEqual(plain(m.starts), { '#': 0, A: 3, B: 8, D: 10, S: 14, Z: 21 });
  assert.equal(az.target(m, 'A'), 3);
  assert.equal(az.target(m, 'C'), -1, 'an empty letter has no target');
  assert.equal(az.target(m, 'X'), -1);
  assert.equal(az.target(null, 'A'), -1);
});

test('descending (Z–A): the same groups from the other end', () => {
  const m = az.index(DIRS, true);
  assert.equal(m.total, 22);
  assert.deepEqual(plain(m.starts), { Z: 0, S: 1, D: 8, B: 12, A: 14, '#': 19 });
  assert.equal(az.slotAt(m, 0), 'Z');
  assert.equal(az.slotAt(m, 21), '#');
  assert.deepEqual(plain(az.order(m).slice(0, 3)), ['Z', 'Y', 'X']);
  assert.equal(az.order(m)[26], '#');
});

test('slotAt: the letter of any index, null past the end', () => {
  const m = az.index(DIRS, false);
  const want = '###AAAAABBDDDDSSSSSSSZ';
  for (let i = 0; i < want.length; i++) assert.equal(az.slotAt(m, i), want[i], 'index ' + i);
  assert.equal(az.slotAt(m, 22), null);
  assert.equal(az.slotAt(m, -1), null);
  assert.equal(az.slotAt(az.index([], false), 0), null);
});

test('zero-size groups are ignored; an accented group joins its letter at its first start', () => {
  const m = az.index([
    { title: '#', size: 0 }, { title: 'A', size: 2 }, { title: 'E', size: 3 }, { title: 'É', size: 1 },
    { title: 'Ж', size: 4 }, { title: 'F', size: 2 },
  ], false);
  assert.equal(m.total, 12);
  assert.equal(az.target(m, '#'), -1);
  assert.equal(az.target(m, 'E'), 2);
  assert.equal(az.slotAt(m, 5), 'E', 'the É group still reads as E');
  assert.equal(az.slotAt(m, 6), null, 'a script without a slot');
  assert.equal(az.target(m, 'F'), 10, 'later letters still count the unslotted titles');
});

test('a sum of 1,700+ titles, like a real movie library', () => {
  const dirs = az.LETTERS.map((t, i) => ({ title: t, size: 10 + ((i * 37) % 90) }));
  const m = az.index(dirs, false);
  let at = 0;
  dirs.forEach((d) => { assert.equal(az.target(m, d.title), at); at += d.size; });
  assert.equal(m.total, at);
  assert.equal(az.slotAt(m, at - 1), 'Z');
});

test('rail steps skip empty letters and stop at the ends', () => {
  const m = az.index(DIRS, false);
  const order = az.order(m);
  const pos = (s) => order.indexOf(s);
  assert.equal(az.step(m, order, pos('B'), 1), 'D', 'C is empty');
  assert.equal(az.step(m, order, pos('D'), -1), 'B');
  assert.equal(az.step(m, order, pos('Z'), 1), null);
  assert.equal(az.step(m, order, pos('#'), -1), null);
  assert.equal(az.step(m, order, -1, 1), '#', 'first letter with titles');
});

test('digits: remote number keys and keyboard rows', () => {
  assert.equal(az.digitOf(48), 0);
  assert.equal(az.digitOf(57), 9);
  assert.equal(az.digitOf(98), 2);
  assert.equal(az.digitOf(65), -1);
  assert.equal(az.digitOf(13), -1);
});

test('multi-tap: 2 = A, again = B, again wraps; empty letters skipped; a pause starts over', () => {
  const m = az.index(DIRS, false);
  const tap = { digit: -1, slot: null, at: 0 };
  assert.equal(az.tap(m, tap, 2, 1000), 'A');
  assert.equal(az.tap(m, tap, 2, 1500), 'B');
  assert.equal(az.tap(m, tap, 2, 2000), 'A', 'C is empty, so it wraps');
  assert.equal(az.tap(m, tap, 2, 2000 + az.TAP_MS + 1), 'A', 'too slow: a fresh press');
  assert.equal(az.tap(m, tap, 3, 9000), 'D', 'another key starts at its own first letter');
  assert.equal(az.tap(m, tap, 7, 9100), 'S', 'P, Q and R are empty');
  assert.equal(az.tap(m, tap, 7, 9200), 'S', 'only one live letter: stays');
  assert.equal(az.tap(m, tap, 1, 9300), '#');
  assert.equal(az.tap(m, tap, 0, 9400), '#');
  assert.equal(az.tap(m, tap, 9, 9500), 'Z');
  assert.equal(az.tap(m, tap, 4, 9600), null, 'G, H and I are all empty');
});
