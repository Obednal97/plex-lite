// Tests for Settings on phones and tablets (web/touch/screens/settings.js, PL.touchSettingsLogic): how
// the server connection is worded, the Controls choices and which of them hand over to the TV layout,
// plugin and catalogue states, the profiles list, the text field's keyboard, the sheet above the
// on-screen keyboard and Overseerr's same-site check.
//   node --test test/touch-settings.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// the logic is defined before the file checks for the web build, so it loads without a page
function load() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('web/touch/logic.js'), ctx, { filename: 'web/touch/logic.js' });
  vm.runInContext(read('web/touch/screens/settings.js'), ctx, { filename: 'web/touch/screens/settings.js' });
  return { S: ctx.window.PL.touchSettingsLogic, L: ctx.window.PL.touchLogic };
}
const { S, L } = load();
const J = (v) => JSON.parse(JSON.stringify(v));

// seerr-web.js's W.siteOf, near enough for these tests
const siteOf = (host) => String(host).replace(/:\d+$/, '').split('.').slice(-2).join('.');

test('touch settings: the connection in words', () => {
  assert.equal(S.connection('lan'), 'Local network');
  assert.equal(S.connection('lan-http'), 'Local network');
  assert.equal(S.connection('remote'), 'Remote Access');
  assert.equal(S.connection('relay'), 'Plex relay');
  assert.equal(S.connection('manual-remote'), 'Your server address');
  assert.equal(S.connection(undefined), 'Unknown');
  assert.match(S.connectionLine('relay'), /relay/);
  assert.equal(S.connectionLine(null), 'Not connected');
});

test('touch settings: Controls value and choices, and which switch to the TV layout', () => {
  assert.equal(S.controlsValue('auto', 'touch'), 'Automatic (Touch)');
  assert.equal(S.controlsValue('auto', 'pointer'), 'Automatic (Mouse & keyboard)');
  assert.equal(S.controlsValue('remote', 'remote'), 'Remote');
  // a phone: only Remote leaves this layout
  const phone = J(S.controls('auto', { width: 390, detected: 'touch', wanted: L.wanted }));
  assert.deepEqual(phone.map((c) => c.id), ['auto', 'touch', 'pointer', 'remote']);
  assert.deepEqual(phone.map((c) => c.tv), [false, false, false, true]);
  assert.equal(phone[0].checked, true);
  assert.match(phone[3].sub, /TV layout/);
  // an iPad on its side (1180): a mouse and keyboard there is the TV layout too
  const ipad = J(S.controls('touch', { width: 1180, detected: 'touch', wanted: L.wanted }));
  assert.deepEqual(ipad.map((c) => c.tv), [false, false, true, true]);
  assert.equal(ipad[1].checked, true);
  // without the shell's rule: Remote only
  assert.deepEqual(J(S.controls('auto')).map((c) => c.tv), [false, false, false, true]);
});

test('touch settings: an installed plugin\'s state, as the TV words it', () => {
  assert.equal(S.externalValue({ disabled: true }, true, true), 'Error');
  assert.equal(S.externalValue({ active: false }, true, true), 'Needs permission');
  assert.equal(S.externalValue({ active: false }, true, false), 'Off');
  assert.equal(S.externalValue({ active: true }, true, true), 'On');
  assert.equal(S.externalValue({ active: true, holdsToken: true }, true, true), 'On · Plex sign-in');
  assert.equal(S.externalValue({ active: true }, false, true), 'Off');
});

test('touch settings: catalogue rows and what an entry offers', () => {
  const web = { id: 'a', name: 'A', version: '1.1.0', kind: 'web', compatible: true };
  const st = (state, extra) => Object.assign({ state, installed: state === 'not-installed' ? null : { version: '1.0.0' }, busy: false }, extra);
  assert.deepEqual(J(S.catalogueRow({ kind: 'service' }, st('not-installed'), true)), { tvOnly: true, sub: 'TV app only' });
  assert.equal(S.catalogueRow({ kind: 'service', compatible: true }, st('not-installed'), false).tvOnly, false);
  assert.equal(S.catalogueRow(web, st('not-installed'), true).sub, 'Not installed');
  assert.equal(S.catalogueRow(web, st('update-available'), true).sub, 'Update to 1.1.0');
  assert.equal(S.catalogueRow(web, st('connected'), true).sub, 'Connected');
  assert.equal(S.catalogueRow(web, st('installed', { busy: true }), true).sub, 'Installing…');
  assert.equal(S.catalogueRow({ kind: 'web', compatible: false, needs: 'Needs Plex Lite 0.3.0' }, st('not-installed'), true).sub, 'Needs Plex Lite 0.3.0');

  const ids = (e, s) => S.entryActions(e, s).map((a) => a.id).join(',');
  assert.equal(ids(web, st('not-installed')), 'install');
  assert.equal(ids(web, st('update-available')), 'update,remove');
  assert.equal(ids(web, st('installed')), 'connect,remove');
  assert.equal(ids(web, st('connected')), 'manage,remove');
  assert.equal(ids(web, st('installed', { busy: true })), 'busy');
  assert.equal(ids({ compatible: false, needs: 'Needs a newer Plex Lite' }, st('not-installed')), 'needs');
  assert.match(S.entryActions({ kind: 'service', compatible: true }, st('not-installed'))[0].sub, /background service/);
  assert.equal(S.entryLine(web, st('update-available')), '1.0.0 → 1.1.0');
  assert.equal(S.entryLine(Object.assign({ author: 'Ann' }, web), st('not-installed')), '1.1.0 · Ann');
});

test('touch settings: Plex Home profiles (PIN-protected ones are not supported)', () => {
  const users = [
    { uuid: 'a', title: 'Owner', admin: true },
    { uuid: 'b', title: 'Kids', restricted: true },
    { uuid: 'c', title: 'Guest', protected: true },
  ];
  const owner = J(S.profiles(users, null));
  assert.deepEqual(owner.map((p) => p.checked), [true, false, false]);
  assert.deepEqual(owner.map((p) => p.sub), ['Owner', 'Managed', 'PIN · not supported yet']);
  assert.deepEqual(owner.map((p) => p.locked), [false, false, true]);
  assert.deepEqual(J(S.profiles(users, 'b')).map((p) => p.checked), [false, true, false]);
  assert.deepEqual(J(S.profiles(null, null)), []);
});

test('touch settings: the keyboard for a text field', () => {
  assert.equal(S.inputType('Overseerr address', 'e.g. https://overseerr.example.com', ''), 'url');
  assert.equal(S.inputType('Catalogue address', 'Leave empty for the default', ''), 'url');
  assert.equal(S.inputType('Something', '', 'https://x.example'), 'url');
  // Overseerr's Report a problem: words, with a space bar
  assert.equal(S.inputType('What\'s wrong?', 'A few words, e.g. "no sound after 20 minutes"', ''), 'text');
});

test('touch settings: a text sheet sits above the on-screen keyboard', () => {
  // no keyboard (or a browser that resizes the page for it)
  assert.equal(S.keyboardFit({ layoutH: 852, vvH: 852, vvTop: 0, tablet: false }), null);
  assert.equal(S.keyboardFit({ layoutH: 852, vvH: 800, vvTop: 0, tablet: false }), null);
  // iPhone: a 336 px keyboard, the visual viewport not scrolled
  assert.deepEqual(J(S.keyboardFit({ layoutH: 852, vvH: 516, vvTop: 0, tablet: false })), { bottom: 336, maxHeight: 500 });
  // ... and scrolled 100 px to show the field
  assert.deepEqual(J(S.keyboardFit({ layoutH: 852, vvH: 516, vvTop: 100, tablet: false })), { bottom: 236, maxHeight: 500 });
  // iPad: the card is centred in what is left
  assert.deepEqual(J(S.keyboardFit({ layoutH: 1180, vvH: 780, vvTop: 0, tablet: true })), { top: 390, maxHeight: 764 });
});

test('touch settings: Overseerr on the web needs the same site', () => {
  assert.deepEqual(J(S.sameSite('plexlite.example.com', 'https://overseerr.example.com:443', siteOf)), { mine: 'example.com', theirs: 'example.com', same: true });
  assert.deepEqual(J(S.sameSite('plexlite.vercel.app', 'https://overseerr.example.com', siteOf)).same, false);
  assert.deepEqual(J(S.sameSite('plexlite.example.com', '', siteOf)), { mine: 'example.com', theirs: null, same: false });
});

test('touch settings: the file loads without a page and adds no screen there', () => {
  const ctx = { window: { PL: { isWeb: false } } };
  vm.createContext(ctx);
  vm.runInContext(read('web/touch/screens/settings.js'), ctx);
  assert.equal(typeof ctx.window.PL.touchSettingsLogic.connection, 'function');
  assert.equal(ctx.window.PL.touch, undefined);
});
