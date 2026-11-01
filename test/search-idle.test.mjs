// TV Search's plugin rows before anything is typed (js/screens/search.js, loadIdle/hide): an answer
// that comes while Search is hidden (another tab, a page on top) is dropped, not drawn, and asked for
// again when Search shows. The two methods run on their own against a stand-in for the screen.
//   node --test test/search-idle.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const src = readFileSync(new URL('../js/screens/search.js', import.meta.url), 'utf8');

function method(name) {
  const start = src.indexOf('  SearchScreen.prototype.' + name + ' = function');
  const end = src.indexOf('\n  };\n', start);
  assert.ok(start > 0 && end > start, 'found ' + name);
  return src.slice(start, end + 5);
}

function screen() {
  const answers = [];
  const ctx = {
    SearchScreen: function () {},
    IDLE_STALE_MS: 60000,
    Date, setTimeout, clearTimeout,
    PL: { plugins: { hasSearchIdle: () => true, searchIdleRows: () => new Promise((resolve) => answers.push(resolve)) } },
  };
  ctx.SearchScreen.prototype = {};
  vm.createContext(ctx);
  vm.runInContext(method('loadIdle') + '\n' + method('hide'), ctx);
  const noop = { cancel() {} };
  const s = Object.assign(Object.create(ctx.SearchScreen.prototype), {
    alive: true, visible: true, query: '', idleRows: [], idleAt: 0, idleSeq: 0, renders: 0,
    render() { this.renders++; },
    ambient: noop, runServer: noop, runPlugins: noop, abortServer() {}, paintKeys() {},
    stack: { focus() {} }, shadow: { hide() {} }, serverDone: true,
  });
  return { s, answers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('search: idle rows that arrive while Search is hidden are not drawn, and are asked for again', async () => {
  const { s, answers } = screen();
  s.loadIdle();
  assert.equal(answers.length, 1);
  s.hide();
  answers[0]([{ id: 'x', items: [{}] }]);
  await tick();
  assert.equal(s.renders, 0, 'nothing drawn while hidden');
  assert.equal(s.idleRows.length, 0);
  // shown again: asked again at once (not "fresh for a minute")
  s.visible = true;
  s.loadIdle();
  assert.equal(answers.length, 2);
  answers[1]([{ id: 'x', items: [{}] }]);
  await tick();
  assert.equal(s.renders, 1);
  // a load that finished before hiding stays fresh
  s.hide();
  s.loadIdle();
  assert.equal(answers.length, 2, 'kept a minute');
});
