// Tests for plugin answers that arrive late (js/plugins.js, "Late answers"): a sheet, page, screen or
// text entry a plugin opens after waiting goes over the screen the viewer left it on, never over
// something else and never over a player. In a key press, a tap, or a plugin's own action, row or
// shelf choice it opens as before. Also Subtitles and What's coming against the fake helper, and an
// external plugin's late screen (js/plugin-host.js).
//   node --test test/late-answers.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { domEnv, wait } from './fixtures/mini-dom.mjs';
import { makeEnv, plexItem, movie, show } from './fixtures/helper-env.mjs';

function later() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { p, resolve };
}

// The app's screen stack (as js/app.js), the real sheet and text entry (js/screens/common.js)
function stage() {
  const env = domEnv(['js/plugins.js', 'js/screens/common.js']);
  const { PL } = env;
  const store = {};
  PL.storage = { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); }, del: (k) => { delete store[k]; } };
  PL.log = () => {};
  PL.warn = () => {};
  const app = PL.app = {
    stack: [{ name: 'library', el: env.document.createElement('div') }],
    top() { return this.stack[this.stack.length - 1]; },
    push(s) { this.stack.push(s); },
    pop() { if (this.stack.length > 1) this.stack.pop(); },
    backdrop: { set() {}, dim() {} },
  };
  PL.screens.details = (item) => ({ name: 'details', item });
  const names = () => app.stack.map((s) => s.name || (s.overlay ? 'sheet' : s.isPlayer ? 'player' : 'screen'));
  return Object.assign(env, { app, names });
}

const reg = (PL, def) => PL.plugins.register(Object.assign({ name: def.id, version: '1', apiVersion: 1 }, def));

// A plugin whose action looks something up first, then opens a sheet (as Subtitles… does)
function lookupPlugin(PL, id = 'look') {
  const answer = later();
  let ctx = null;
  reg(PL, {
    id,
    actions: (item, c) => { ctx = c; return [{ label: 'Look up ' + id, run: () => { answer.p.then(() => c.sheet([{ heading: 'Found', rows: [{ label: 'OK', action() {} }] }])); } }]; },
  });
  return { answer, run: () => PL.plugins.actions({ type: 'movie' }).find((a) => a.label === 'Look up ' + id).run(), ctx: () => ctx };
}

test('late answers: a sheet after a lookup shows when the viewer is still on that screen', async () => {
  const { PL, names } = stage();
  const p = lookupPlugin(PL);
  p.run();
  await wait(5);
  p.answer.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library', 'sheet']);
});

test('late answers: not over another screen the viewer opened meanwhile, nor after Back', async () => {
  const { PL, app, names } = stage();
  const p = lookupPlugin(PL);
  p.run();
  await wait(5);
  app.push({ name: 'details' }); // the viewer went on to a title
  p.answer.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library', 'details'], 'dropped');
  // the same from a details page, then Back to the library
  const q = lookupPlugin(PL, 'look2');
  q.run();
  await wait(5);
  app.pop();
  q.answer.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library'], 'dropped after Back');
});

test('late answers: never over a player', async () => {
  const { PL, app, names } = stage();
  const p = lookupPlugin(PL);
  p.run();
  await wait(5);
  app.push({ isPlayer: true });
  assert.equal(PL.plugins.playerOpen(), true);
  p.answer.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library', 'player']);
  // and a page (openItem) the same
  let c = null;
  const look = later();
  reg(PL, { id: 'opener', actions: (item, ctx) => { c = ctx; return [{ label: 'Open', run: () => look.p.then(() => c.openItem({ ratingKey: '7' })) }]; } });
  app.pop();
  PL.plugins.actions({ type: 'movie' }).find((a) => a.label === 'Open').run();
  await wait(5);
  app.push({ isPlayer: true });
  look.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library', 'player']);
});

test('late answers: during a key press or tap a plugin opens things as before', async () => {
  const { PL, names, fire } = stage();
  let ctx = null;
  reg(PL, { id: 'keys', settingsRows: (c) => { ctx = c; return []; } });
  PL.plugins.settingsRows();
  fire('keydown', { keyCode: 13 });
  ctx.sheet([{ heading: 'Now', rows: [] }]);
  assert.deepEqual(names(), ['library', 'sheet'], 'in the key press');
  await wait(5);
  PL.app.pop();
  // a plugin never used by the viewer can't put things on screen by itself
  ctx.sheet([{ heading: 'Out of the blue', rows: [] }]);
  assert.deepEqual(names(), ['library']);
});

test('late answers: a plugin\'s own screen, and a sheet opened after its text entry closed (Home Assistant\'s reopen)', async () => {
  const { PL, app, names, fire } = stage();
  let ctx = null;
  const look = later();
  reg(PL, { id: 'own', settingsRows: (c) => { ctx = c; return [{ label: 'Own', action: () => c.push({ name: 'own', key() { return true; } }) }]; } });
  PL.plugins.settingsRows()[0].action();
  await wait(5);
  assert.deepEqual(names(), ['library', 'own']);
  // OK on a row of its own screen (the plugin's code, no host wrapper) starts a lookup
  fire('keydown', { keyCode: 13 });
  ctx.storage.get('x'); // any ctx call: the plugin is in use
  look.p.then(() => ctx.sheet([{ heading: 'Result', rows: [] }]));
  await wait(5);
  look.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library', 'own', 'sheet'], 'over its own screen');
  app.pop();
  app.pop();
  // a text entry's answer reopens the plugin's sheet a moment after the entry closed
  ctx.textEntry('Address', '', '', () => { setTimeout(() => ctx.sheet([{ heading: 'Again', rows: [] }]), 0); return true; });
  // (opened outside a user task: refused, the plugin's last screen is gone)
  assert.deepEqual(names(), ['library']);
  fire('click');
  ctx.textEntry('Address', '', '', () => { setTimeout(() => ctx.sheet([{ heading: 'Again', rows: [] }]), 0); return true; });
  await wait(5);
  const entry = app.top();
  assert.equal(typeof entry.key, 'function');
  entry.key(PL.KEY.ENTER); // OK: onDone, then the entry closes
  await wait(10);
  assert.deepEqual(names(), ['library', 'sheet']);
});

test('late answers: a sheet\'s rows are the viewer acting (a row that looks something up shows its answer)', async () => {
  const { PL, names } = stage();
  let ctx = null;
  const look = later();
  reg(PL, { id: 'rows', settingsRows: (c) => { ctx = c; return [{ label: 'Rows', action: () => c.sheet([{ heading: 'Pick', rows: [{ label: 'Find', action: () => look.p.then(() => c.sheet([{ heading: 'Found', rows: [] }])) }] }]) }]; } });
  PL.plugins.settingsRows()[0].action();
  await wait(5);
  const sheet = PL.app.top();
  sheet.key(PL.KEY.ENTER); // closes, then the row's action
  await wait(5);
  look.resolve();
  await wait(5);
  assert.deepEqual(names(), ['library', 'sheet']);
  assert.ok(ctx);
});

// ---- The bundled plugins built on the helper -------------------------------------------------------------

function withStack(env) {
  const app = env.PL.app;
  app.stack = [{ name: 'details' }];
  app.top = function () { return this.stack[this.stack.length - 1]; };
  const push = app.push;
  app.push = (s) => { app.stack.push(s); push(s); };
  return app;
}

test('late answers: Subtitles… doesn\'t open its sheet over a player started meanwhile', async () => {
  const env = await makeEnv();
  await env.H.health();
  const app = withStack(env);
  const sintel = plexItem(movie('sintel').ratingKey);
  env.PL.plugins.actions(sintel).find((a) => a.label === 'Subtitles…').run();
  await wait(1);
  app.stack.push({ isPlayer: true }); // Play pressed while the helper was asked
  await wait(60);
  assert.equal(env.sheets().length, 0, 'no sheet');
  // the same without the player: the sheet
  app.stack.pop();
  env.PL.plugins.actions(sintel).find((a) => a.label === 'Subtitles…').run();
  await wait(60);
  assert.equal(env.sheets().length, 1);
  await env.close();
});

test('late answers: What\'s coming opens the episode only if the library is still showing', async () => {
  const env = await makeEnv();
  const app = withStack(env);
  const shelf = (await env.PL.plugins.shelfRows({ key: '2', type: 'show', title: 'TV Shows' })).find((s) => s.id === 'whats-coming:episodes');
  // Plex takes a moment to answer, as on a real network
  const children = env.PL.plex.children;
  env.PL.plex.children = (rk) => wait(5).then(() => children(rk));
  shelf.onSelect(shelf.items[0]); // has a file: looks the episode up first
  await wait(1);
  app.stack.push({ name: 'search' }); // the viewer moved on (a later key press)
  await wait(20);
  assert.ok(!env.pushed.some((s) => s.kind === 'details'), 'no page pushed over Search');
  app.stack.pop();
  shelf.onSelect(shelf.items[0]);
  await wait(20);
  assert.ok(env.pushed.some((s) => s.kind === 'details' && s.item.ratingKey), 'opened when still there');
  await env.close();
});
