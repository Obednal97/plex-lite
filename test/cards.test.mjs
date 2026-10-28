// Which shelves play a card when it is chosen instead of opening its page (js/ui.js
// ui.playsOnSelect), on every device: an episode in Continue Watching or Recently Released
// Episodes, a film in Continue Watching. And the hold-OK menu's "Go to episode" / "Go to show".
//   node --test test/cards.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function load() {
  const pushed = [];
  const ctx = { window: { addEventListener() {} }, console: { log() {}, warn() {} }, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext('var window = this.window;', ctx);
  vm.runInContext(read('js/core.js'), ctx, { filename: 'js/core.js' });
  vm.runInContext(read('js/ui.js'), ctx, { filename: 'js/ui.js' });
  vm.runInContext(read('js/screens/common.js'), ctx, { filename: 'js/screens/common.js' });
  const PL = ctx.window.PL;
  PL.app = { push: (s) => pushed.push(s) };
  PL.screens.sheet = (sections) => ({ sections });
  return { PL, pushed };
}

test('cards: Continue Watching and Recently Released episodes play, other shelves open the page', () => {
  const { PL } = load();
  const plays = (hub, type) => PL.ui.playsOnSelect(hub, { type });
  const cw = { hubIdentifier: 'tv.inprogress.2', title: 'Continue Watching' };
  const mcw = { hubIdentifier: 'movie.inprogress.1', title: 'Continue Watching' };
  const rel = { hubIdentifier: 'tv.recentlyaired.2', title: 'Recently Released Episodes' };
  const deck = { hubIdentifier: 'tv.ondeck.2', title: 'On Deck' };
  const added = { hubIdentifier: 'tv.recentlyadded.2', title: 'Recently Added TV' };
  assert.equal(plays(cw, 'episode'), true);
  assert.equal(plays(mcw, 'movie'), true);
  assert.equal(plays(rel, 'episode'), true);
  assert.equal(plays(deck, 'episode'), true);
  assert.equal(plays({ hubIdentifier: 'home.continue', title: 'Continue Watching' }, 'episode'), true);
  // by title when the identifier says nothing
  assert.equal(plays({ title: 'Recently Released Episodes' }, 'episode'), true);
  assert.equal(plays({ title: 'Continue Watching' }, 'movie'), true);
  // shows, seasons and other shelves keep opening details
  assert.equal(plays(cw, 'show'), false);
  assert.equal(plays(cw, 'season'), false);
  assert.equal(plays(rel, 'movie'), false);
  assert.equal(plays(added, 'episode'), false);
  assert.equal(plays({ hubIdentifier: 'movie.recentlyadded.1', title: 'Recently Added' }, 'movie'), false);
  assert.equal(plays(null, 'episode'), false);
  assert.equal(PL.ui.playsOnSelect(cw, null), false);
});

test('cards: an episode\'s hold-OK menu has Go to episode and Go to show; a film keeps Details', () => {
  const { PL, pushed } = load();
  PL.screens.itemMenu({ type: 'episode', ratingKey: '5', grandparentRatingKey: '1', grandparentTitle: 'Show', parentIndex: 1, index: 2, viewOffset: 60000, duration: 120000 });
  const labels = pushed.pop().sections[0].rows.map((r) => r.label);
  assert.deepEqual(JSON.parse(JSON.stringify(labels.slice(-2))), ['Go to episode', 'Go to show']);
  assert.ok(labels[0].indexOf('Resume') === 0);
  PL.screens.itemMenu({ type: 'movie', ratingKey: '6' });
  assert.equal(pushed.pop().sections[0].rows.slice(-1)[0].label, 'Details');
});
