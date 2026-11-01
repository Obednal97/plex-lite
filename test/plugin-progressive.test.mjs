// Tests for plugin answers that arrive at different times (js/plugins.js, docs/PLUGINS.md): one
// plugin's slow promise never holds back the others. actions(item, onLate) answers with what is known
// at once and adds late ones; shelfRows(section, onRows) delivers each plugin's rows as they come.
// Then the screens: the TV's hold-OK menu and details pills (js/screens/common.js, details.js) show
// immediate answers at once, add late ones without moving the focus, and drop answers for an older
// load; the TV library puts each plugin's rows in as they come (js/screens/library.js).
//   node --test test/plugin-progressive.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { domEnv, wait } from './fixtures/mini-dom.mjs';

const J = (v) => JSON.parse(JSON.stringify(v));

// A promise and the function that resolves it
function later() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { p, resolve };
}

function host(extraFiles = []) {
  const env = domEnv(['js/plugins.js', 'js/screens/common.js'].concat(extraFiles));
  const { PL } = env;
  const store = {};
  PL.storage = { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); }, del: (k) => { delete store[k]; } };
  PL.warn = () => {};
  PL.log = () => {};
  PL.pushed = [];
  PL.app = { stack: [], push(s) { this.stack.push(s); PL.pushed.push(s); }, pop() { this.stack.pop(); }, top() { return this.stack[this.stack.length - 1]; }, backdrop: { set() {}, dim() {} } };
  return Object.assign(env, { store });
}

const reg = (PL, id, extra) => PL.plugins.register(Object.assign({ id, name: id, version: '1', apiVersion: 1 }, extra));

// ---- The host -----------------------------------------------------------------------------------------

test('host: actions(item, onLate): immediate answers at once, a slow plugin\'s when it comes, in plugin order', async () => {
  const { PL } = host();
  const slow = later();
  reg(PL, 'pa', { actions: () => slow.p });
  reg(PL, 'pb', { actions: () => [{ label: 'Now', run() {} }] });
  reg(PL, 'pc', { actions: () => Promise.resolve([{ label: 'Soon', run() {} }]) });
  const seen = [];
  const now = PL.plugins.actions({ type: 'movie' }, (all) => seen.push(all.map((a) => a.label)));
  assert.ok(Array.isArray(now), 'an array at once');
  assert.deepEqual(J(now.map((a) => a.label)), ['Now'], 'the slow plugin doesn\'t hold back the others');
  await wait(5);
  assert.deepEqual(J(seen), [['Now', 'Soon']]);
  slow.resolve([{ label: 'Later', run() {} }]);
  await wait(5);
  assert.deepEqual(J(seen), [['Now', 'Soon'], ['Later', 'Now', 'Soon']], 'everything so far, in plugin order');
  // without onLate: as before (a promise of everything)
  const all = PL.plugins.actions({ type: 'movie' });
  assert.equal(typeof all.then, 'function');
  assert.deepEqual(J((await all).map((a) => a.label)), ['Later', 'Now', 'Soon']);
});

test('host: shelfRows(section, onRows) delivers each plugin\'s rows as they come', async () => {
  const { PL } = host();
  const slow = later();
  reg(PL, 'sa', { shelfRows: () => slow.p });
  reg(PL, 'sb', { shelfRows: () => Promise.resolve([{ id: 'b', title: 'B', items: [{ ratingKey: 'b1' }] }]) });
  reg(PL, 'sc', { shelfRows: () => [{ id: 'empty', title: 'E', items: [] }] });
  const seen = [];
  const done = PL.plugins.shelfRows({ key: '1', type: 'movie' }, (all, added) => seen.push([all.map((s) => s.id), added.map((s) => s.id)]));
  await wait(5);
  assert.deepEqual(J(seen), [[['sb:b'], ['sb:b']]], 'the fast plugin\'s row before the slow one answers');
  slow.resolve([{ id: 'a', title: 'A', items: [{ ratingKey: 'a1' }] }]);
  const all = await done;
  assert.deepEqual(J(seen[1]), [['sa:a', 'sb:b'], ['sa:a']], 'in plugin order');
  assert.deepEqual(J(all.map((s) => s.id)), ['sa:a', 'sb:b'], 'the promise still has everything');
});

// ---- The TV's hold-OK menu ------------------------------------------------------------------------------

test('hold-OK menu: opens at once with what is known, a late plugin\'s rows join before the pages, the focus stays', async () => {
  const { PL } = host();
  PL.screens.player = () => ({});
  PL.screens.details = () => ({});
  const slow = later();
  reg(PL, 'ma', { actions: () => slow.p });
  reg(PL, 'mb', { actions: () => [{ label: 'Report a problem', run() {} }] });
  const item = { type: 'episode', ratingKey: '5', title: 'E', grandparentTitle: 'Show', grandparentRatingKey: '2', parentIndex: 1, index: 2 };
  assert.equal(PL.screens.itemMenu(item), true);
  assert.equal(PL.pushed.length, 1, 'the menu opened without waiting');
  const sheet = PL.pushed[0];
  const labels = () => sheet.el.querySelectorAll('.sheet-row').map((n) => n.childNodes[0].textContent);
  const focused = () => sheet.el.querySelectorAll('.sheet-row').findIndex((n) => n.classList.contains('focused'));
  assert.deepEqual(labels(), ['Play', 'Mark as watched', 'Report a problem', 'Go to episode', 'Go to show']);
  // the viewer moves down to Go to episode
  sheet.key(PL.KEY.DOWN); sheet.key(PL.KEY.DOWN); sheet.key(PL.KEY.DOWN);
  assert.equal(labels()[focused()], 'Go to episode');
  slow.resolve([{ label: 'Subtitles…', run() {} }]);
  await wait(5);
  assert.deepEqual(labels(), ['Play', 'Mark as watched', 'Subtitles…', 'Report a problem', 'Go to episode', 'Go to show']);
  assert.equal(labels()[focused()], 'Go to episode', 'still on the row it was on');
  assert.equal(PL.pushed.length, 1, 'no second menu');
});

// ---- The TV's details page ------------------------------------------------------------------------------

function detailsEnv() {
  const env = host(['js/screens/details.js']);
  const { PL } = env;
  PL.plex = {
    get: () => new Promise(() => {}), // the page's own load never finishes: the test drives it
    image: () => '',
    children: () => new Promise(() => {}),
    onDeck: () => null,
  };
  PL.screens.player = () => ({});
  return env;
}

function episodePage(PL) {
  const f = { type: 'episode', ratingKey: '10', title: 'Pilot', grandparentTitle: 'Show', grandparentRatingKey: '2', parentIndex: 1, index: 1 };
  const d = PL.screens.details({ type: 'episode', ratingKey: '10' });
  d.full = f;
  d.extras = [];
  d.buttonRow = new PL.ui.ButtonRow(d.buttons());
  return { d, f };
}

test('details: plugin pills: immediate ones at once, a slow plugin\'s later, the focus stays on its pill', async () => {
  const { PL } = detailsEnv();
  const slow = later();
  reg(PL, 'da', { actions: () => slow.p });
  reg(PL, 'db', { actions: () => [{ label: 'Report a problem', icon: 'report', run() {} }] });
  const { d, f } = episodePage(PL);
  const labels = () => J(d.buttonRow.buttons.map((b) => b.label));
  d.loadPluginActions(f);
  assert.deepEqual(labels().slice(-2), ['Report a problem', 'Go to show'], 'the quick plugin\'s pill at once');
  d.buttonRow.index = labels().indexOf('Go to show');
  slow.resolve([{ label: 'Subtitles…', icon: 'tracks', run() {} }]);
  await wait(5);
  assert.deepEqual(labels().slice(-3), ['Subtitles…', 'Report a problem', 'Go to show']);
  assert.equal(labels()[d.buttonRow.index], 'Go to show', 'the focus didn\'t jump to the new pill');
});

test('details: actions for an older load of the page are dropped', async () => {
  const { PL } = detailsEnv();
  const slow = later();
  reg(PL, 'dc', { actions: () => slow.p });
  const { d, f } = episodePage(PL);
  d.loadPluginActions(f);
  // the page reloaded (back from the player): a new item object
  d.full = Object.assign({}, f);
  d.buttonRow.setButtons(d.buttons());
  slow.resolve([{ label: 'Stale', run() {} }]);
  await wait(5);
  assert.ok(!d.buttonRow.buttons.some((b) => b.label === 'Stale'));
});

// ---- The TV library's Recommended ---------------------------------------------------------------------------

test('library: each plugin\'s rows go in as they come, in plugin order, without moving the focus or the Plex rows', async () => {
  const env = host(['js/screens/library.js']);
  const { PL } = env;
  PL.app.tabs = { show() {} };
  const hub = (i) => ({ hubIdentifier: 'h' + i, title: 'Hub ' + i, type: 'movie', size: 2, Metadata: [{ ratingKey: String(i * 10 + 1), type: 'movie', title: 'M' + i }] });
  PL.plex = { get: () => Promise.resolve({ Hub: [hub(1), hub(2), hub(3), hub(4)] }), image: () => '', isVideoHub: () => true, hubPage: () => Promise.resolve([]) };
  const slow = later();
  reg(PL, 'lb', { shelfRows: () => slow.p });
  reg(PL, 'la', { shelfRows: () => Promise.resolve([{ id: 'a', title: 'Fast', at: 2, items: [{ ratingKey: 'a1', title: 'A' }] }]) });
  const lib = PL.screens.library({ key: '1', type: 'movie', title: 'Movies' });
  await wait(10);
  const stack = lib.mode.stack;
  const titles = () => stack.zones.map((z) => z.el.querySelector('.shelf-title') ? z.el.querySelector('.shelf-title').textContent : '?');
  assert.deepEqual(titles(), ['Hub 1', 'Hub 2', 'Fast', 'Hub 3', 'Hub 4'], 'the quick plugin\'s row without waiting for the slow one');
  stack.index = 3;
  const focusedZone = stack.zones[3];
  let removed = 0;
  const realRemove = stack.inner.removeChild.bind(stack.inner);
  stack.inner.removeChild = (n) => { removed++; return realRemove(n); };
  slow.resolve([{ id: 'b', title: 'Slow', at: 2, items: [{ ratingKey: 'b1', title: 'B' }] }]);
  await wait(10);
  assert.deepEqual(titles(), ['Hub 1', 'Hub 2', 'Slow', 'Fast', 'Hub 3', 'Hub 4'], 'plugin order kept at the same point');
  assert.equal(stack.zones[stack.index], focusedZone, 'the focus stayed on its row');
  assert.equal(removed, 0, 'the rows already there stay in the DOM');
});

// ---- Phones and tablets: a title's menu -----------------------------------------------------------------------

test('touch menu: opens at once, a late plugin\'s rows join before Details, the rows already there stay', async () => {
  const env = host(['web/touch/logic.js']);
  const { PL, win, document } = env;
  PL.isWeb = true;
  PL.app.tabsFocused = false;
  PL.input = { nav: () => 'keys' };
  for (const f of ['web/touch/kit.js', 'web/touch/sheets.js']) vm.runInContext(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), win, { filename: f });
  const T = PL.touch;
  T.layer = document.createElement('div');
  const slow = later();
  reg(PL, 'ta', { actions: () => slow.p });
  reg(PL, 'tb', { actions: () => [{ label: 'Report a problem', run() {} }] });
  assert.equal(T.menu({ type: 'movie', ratingKey: '1', title: 'M' }), true);
  const rows = () => T.layer.querySelectorAll('.t-sheet-row');
  const labels = () => rows().map((n) => n.textContent);
  assert.deepEqual(labels(), ['Play', 'Mark as watched', 'Report a problem', 'Details'], 'without waiting for the slow plugin');
  const before = rows();
  slow.resolve([{ label: 'Subtitles…', run() {} }]);
  await wait(5);
  assert.deepEqual(labels(), ['Play', 'Mark as watched', 'Subtitles…', 'Report a problem', 'Details']);
  assert.equal(T.layer.querySelectorAll('.t-sheet').length, 1, 'the same sheet');
  assert.ok(before.every((n) => rows().includes(n)), 'the buttons already shown are kept (a keyboard\'s focus stays)');
});

test('touch library: each plugin\'s rows go in as they come, in plugin order', async () => {
  const env = host(['web/touch/logic.js']);
  const { PL, win } = env;
  PL.isWeb = true;
  PL.input = { nav: () => 'touch', mode: () => 'touch' };
  win.scrollTo = () => {};
  win.scrollY = 0;
  vm.runInContext(readFileSync(new URL('../web/touch/kit.js', import.meta.url), 'utf8'), win, { filename: 'web/touch/kit.js' });
  const T = PL.touch;
  // the bits of web/touch/shell.js the page uses
  Object.assign(T, { page: (cls, o) => Object.assign({ el: T.ui.h('div.t-page') }, o || {}), top: () => null, onProfile: () => () => {}, profile: { title: '' }, openSettings() {} });
  vm.runInContext(readFileSync(new URL('../web/touch/screens/library.js', import.meta.url), 'utf8'), win, { filename: 'web/touch/screens/library.js' });
  const hub = (i) => ({ hubIdentifier: 'h' + i, title: 'Hub ' + i, type: 'movie', size: 1, Metadata: [{ ratingKey: String(i * 10 + 1), type: 'movie', title: 'M' + i }] });
  PL.plex = { get: () => Promise.resolve({ Hub: [hub(1), hub(2), hub(3)] }), image: () => '', isVideoHub: () => true, hubPage: () => Promise.resolve([]) };
  const slow = later();
  reg(PL, 'ua', { shelfRows: () => slow.p });
  reg(PL, 'ub', { shelfRows: () => Promise.resolve([{ id: 'b', title: 'Fast', at: 1, items: [{ ratingKey: 'b1', title: 'B' }] }]) });
  const page = T.screens.library({ key: '1', type: 'movie', title: 'Movies' });
  await wait(10);
  const titles = () => page.el.querySelectorAll('.t-shelf-title').map((n) => n.textContent);
  assert.deepEqual(titles(), ['Hub 1', 'Fast', 'Hub 2', 'Hub 3'], 'without waiting for the slow plugin');
  slow.resolve([{ id: 'a', title: 'Slow', at: 1, items: [{ ratingKey: 'a1', title: 'A' }] }]);
  await wait(10);
  assert.deepEqual(titles(), ['Hub 1', 'Slow', 'Fast', 'Hub 2', 'Hub 3'], 'plugin order kept at the same point');
});
