// Tests for the web build's input mode (web/web-input.js, docs/WEB.md "Input modes"): the starting
// mode from the browser's media queries, switching by the last input used, the Settings pin, key
// hints that follow the mode, and the TV's stub (always remote).
//   node --test test/input.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// A page with core.js (and web-input.js on the web). media: the media queries that match.
function page({ platform = 'web', media = [], ua = 'Mozilla/5.0 (Macintosh) Chrome/150.0', stored = {}, pointerEvents = false } = {}) {
  const store = {};
  for (const [k, v] of Object.entries(stored)) store['pl.' + k] = JSON.stringify(v);
  const handlers = {};
  const attrs = {};
  const bodyClasses = new Set();
  const caps = [];
  let clock = 1_000_000;
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] },
    body: { classList: { contains: (c) => bodyClasses.has(c), toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) } },
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    dispatchEvent: (ev) => { (handlers[ev.type] || []).forEach((fn) => fn(ev)); },
    querySelectorAll: () => caps,
    createElement: () => {
      const a = {};
      return { className: '', textContent: '', setAttribute: (k, v) => { a[k] = v; }, getAttribute: (k) => a[k] };
    },
  };
  const window = {
    PointerEvent: pointerEvents ? function PointerEvent() {} : undefined,
    PL_PLATFORM: platform,
    addEventListener() {},
    matchMedia: (q) => ({ matches: media.includes(q) }),
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const ctx = {
    window, document, CustomEvent,
    navigator: { userAgent: ua },
    console: { log() {}, warn() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    Date: { now: () => clock },
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext('var window = this.window;', ctx);
  vm.runInContext(read('js/core.js'), ctx, { filename: 'js/core.js' });
  const PL = ctx.window.PL;
  // js/app.js's body.pointer switch
  PL.app = { pointer: { on: false, set(on) { this.on = on; bodyClasses[on ? 'add' : 'delete']('pointer'); } } };
  if (platform === 'web') vm.runInContext(read('web/web-input.js'), ctx, { filename: 'web/web-input.js' });
  const fire = (type, ev = {}) => (handlers[type] || []).forEach((fn) => fn({ type, target: {}, ...ev }));
  const tick = (ms) => { clock += ms; };
  return { PL, attrs, store, caps, fire, tick, pointerOn: () => PL.app.pointer.on };
}

const MOUSE = ['(hover: hover) and (pointer: fine)'];
const TOUCH = ['(hover: none) and (pointer: coarse)'];
const move = (p, x, y) => p.fire('mousemove', { clientX: x, clientY: y });

test('TV: always remote, nothing set on <html>', () => {
  const p = page({ platform: 'webos', media: MOUSE });
  assert.equal(p.PL.input.mode(), 'remote');
  assert.equal(p.PL.input.hints(), 'remote');
  assert.equal(p.attrs['data-input'], undefined);
  assert.equal(p.PL.keyLabel('OK'), 'OK');
  const cap = p.PL.keycap('Back');
  assert.equal(cap.textContent, 'Back');
  assert.equal(cap.getAttribute('data-key'), 'Back');
});

test('web: the starting mode comes from the media queries, remote when unsure', () => {
  assert.equal(page({ media: MOUSE }).PL.input.mode(), 'pointer');
  assert.equal(page({ media: TOUCH }).PL.input.mode(), 'touch');
  assert.equal(page({ media: [] }).PL.input.mode(), 'remote');
  // a TV's browser is remote whatever its pointer says
  assert.equal(page({ media: MOUSE, ua: 'Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/87' }).PL.input.mode(), 'remote');
  const p = page({ media: MOUSE });
  assert.equal(p.attrs['data-input'], 'pointer');
  assert.equal(p.attrs['data-nav'], 'pointer');
  assert.equal(p.pointerOn(), true);
  const r = page({ media: [] });
  assert.equal(r.attrs['data-nav'], 'keys');
  assert.equal(r.pointerOn(), false);
});

test('web: a touch switches to touch, and the tap\'s emulated mouse events don\'t switch back', () => {
  const p = page({ media: MOUSE });
  const seen = [];
  p.PL.input.on((d) => seen.push(d.mode + '/' + d.nav));
  p.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(p.PL.input.mode(), 'touch');
  assert.equal(p.attrs['data-input'], 'touch');
  p.tick(50);
  move(p, 10, 10);
  move(p, 300, 300);
  p.fire('pointerdown', { pointerType: 'mouse' });
  assert.equal(p.PL.input.mode(), 'touch');
  assert.deepEqual(seen, ['touch/touch']);
});

test('web: a real mouse move switches to pointer; a still cursor does not', () => {
  const p = page({ media: TOUCH });
  move(p, 100, 100);
  move(p, 102, 101); // a few pixels: the page moved under a still cursor
  assert.equal(p.PL.input.mode(), 'touch');
  move(p, 140, 120);
  assert.equal(p.PL.input.mode(), 'pointer');
  assert.equal(p.PL.input.nav(), 'pointer');
});

test('web: arrows and Enter bring up the focus plate and key hints but keep the layout', () => {
  const p = page({ media: MOUSE });
  p.fire('keydown', { keyCode: 39 });
  assert.equal(p.PL.input.mode(), 'pointer');
  assert.equal(p.PL.input.nav(), 'keys');
  assert.equal(p.attrs['data-nav'], 'keys');
  assert.equal(p.pointerOn(), false);
  assert.equal(p.PL.keyLabel('OK'), 'Enter');
  // other keys (Space, letters) and keys typed into a field don't
  const q = page({ media: MOUSE });
  q.fire('keydown', { keyCode: 32 });
  q.fire('keydown', { keyCode: 40, target: { tagName: 'INPUT' } });
  q.fire('keydown', { keyCode: 37, metaKey: true });
  assert.equal(q.PL.input.nav(), 'pointer');
  // the mouse moving again hides the plate
  move(p, 0, 0);
  move(p, 30, 0);
  assert.equal(p.PL.input.nav(), 'pointer');
  assert.equal(p.pointerOn(), true);
  // a touch device with a keyboard: keys bring up focus and hints, the next touch takes them away
  const t = page({ media: TOUCH });
  t.fire('keydown', { keyCode: 13 });
  assert.deepEqual([t.PL.input.mode(), t.PL.input.nav(), t.PL.input.hints()], ['touch', 'keys', 'keys']);
  t.fire('touchstart');
  assert.deepEqual([t.PL.input.mode(), t.PL.input.nav(), t.PL.input.hints()], ['touch', 'touch', 'none']);
});

test('web: Settings -> Controls pins the mode, saved per browser', () => {
  const p = page({ media: MOUSE });
  p.PL.input.set('remote');
  assert.equal(p.PL.input.mode(), 'remote');
  assert.equal(p.store['pl.input'], '"remote"');
  // pinned: a mouse only hides the focus plate (like the Magic Remote); the layout stays
  move(p, 0, 0);
  move(p, 50, 50);
  assert.deepEqual([p.PL.input.mode(), p.PL.input.nav()], ['remote', 'pointer']);
  p.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(p.PL.input.mode(), 'remote');
  assert.equal(page({ media: MOUSE, stored: { input: 'touch' } }).PL.input.mode(), 'touch');
  assert.equal(page({ media: MOUSE, stored: { input: 'bogus' } }).PL.input.setting(), 'auto');
  // back to Automatic: the touch was the last input
  p.PL.input.set('auto');
  assert.equal(p.PL.input.mode(), 'touch');
  assert.equal(page({ media: MOUSE, stored: { input: 'remote' } }).PL.input.set('auto'), undefined);
});

test('web: key hints follow the mode (remote buttons, keycaps, nothing for touch)', () => {
  const p = page({ media: [] });
  const cap = p.PL.keycap('OK');
  p.caps.push(cap);
  assert.equal(p.PL.input.hints(), 'remote');
  assert.equal(cap.textContent, 'OK');
  move(p, 0, 0);
  move(p, 40, 40);
  assert.equal(p.PL.input.hints(), 'keys');
  assert.equal(cap.textContent, 'Enter');
  assert.equal(p.PL.keyLabel('hold OK on'), 'right-click');
  p.fire('keydown', { keyCode: 38 });
  assert.equal(p.PL.keyLabel('hold OK on'), 'Shift+Enter on');
  p.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(p.PL.input.hints(), 'none');
  assert.equal(p.PL.keyLabel('hold OK on'), 'long-press');
  assert.equal(cap.textContent, 'Tap');
});

test('web: change events carry the old and new state', () => {
  const p = page({ media: MOUSE });
  const seen = [];
  const fn = (d) => seen.push(d);
  p.PL.input.on(fn);
  p.fire('keydown', { keyCode: 40 });
  assert.deepEqual({ ...seen[0] }, { mode: 'pointer', nav: 'keys', prevMode: 'pointer', prevNav: 'pointer' });
  p.PL.input.off(fn);
  p.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(seen.length, 1);
});

test('web: a click or the wheel is a mouse at once', () => {
  const p = page({ media: TOUCH });
  p.fire('pointerdown', { pointerType: 'mouse' });
  assert.equal(p.PL.input.mode(), 'pointer');
  const q = page({ media: [] });
  q.fire('wheel', { clientX: 5, clientY: 5 });
  assert.deepEqual([q.PL.input.mode(), q.PL.input.hints()], ['pointer', 'keys']);
});

test('web: on a TV or console browser the cursor only hides the focus plate', () => {
  const p = page({ media: MOUSE, ua: 'Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/87' });
  move(p, 0, 0);
  move(p, 60, 60);
  p.fire('wheel', {});
  assert.deepEqual([p.PL.input.mode(), p.PL.input.nav(), p.PL.input.hints()], ['remote', 'pointer', 'remote']);
  assert.equal(p.pointerOn(), true);
  assert.equal(p.PL.keyLabel('OK'), 'OK');
  p.fire('keydown', { keyCode: 40 });
  assert.equal(p.pointerOn(), false);
});

test('web: back to Automatic picks the last input used', () => {
  const p = page({ media: MOUSE });
  p.fire('pointerdown', { pointerType: 'touch' });
  p.PL.input.set('remote');
  p.PL.input.set('auto');
  assert.equal(p.PL.input.mode(), 'touch');
});

test('web: a pen hovering is not a mouse (pointer events)', () => {
  const p = page({ media: TOUCH, pointerEvents: true });
  p.fire('pointermove', { pointerType: 'pen', clientX: 0, clientY: 0 });
  p.fire('pointermove', { pointerType: 'pen', clientX: 90, clientY: 90 });
  p.fire('mousemove', { clientX: 200, clientY: 200 });
  assert.equal(p.PL.input.mode(), 'touch');
  p.fire('pointermove', { pointerType: 'mouse', clientX: 0, clientY: 0 });
  p.fire('pointermove', { pointerType: 'mouse', clientX: 90, clientY: 90 });
  assert.equal(p.PL.input.mode(), 'pointer');
});

test('TV: the stub has the same methods as the web module', () => {
  const tv = page({ platform: 'webos' }).PL.input;
  const webInput = page({ media: MOUSE }).PL.input;
  for (const k of ['mode', 'nav', 'hints', 'setting', 'detected', 'set', 'label', 'on', 'off']) {
    assert.equal(typeof tv[k], 'function', k);
    assert.equal(typeof webInput[k], 'function', k);
  }
  tv.set('touch');
  assert.equal(tv.mode(), 'remote');
});
