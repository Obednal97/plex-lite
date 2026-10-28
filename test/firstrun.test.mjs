// Tests for the first-run flow (js/firstrun-logic.js) and the error codes server discovery reports
// for it (js/plex.js): the state machine and Back, PIN rules, the local-network gate, error sheets.
//   node --test test/firstrun.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

function load(platform) {
  const store = {};
  const ctx = {
    window: { PL_PLATFORM: platform, addEventListener() {} },
    console: { log() {}, warn() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i) => Object.keys(store)[i],
    },
    sessionStorage: { clear() {} },
    crypto: globalThis.crypto,
    navigator: { userAgent: 'test' },
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext('var window = this.window; window.localStorage = localStorage;', ctx);
  for (const f of ['js/core.js', 'js/plex.js', 'js/firstrun-logic.js']) vm.runInContext(read(f), ctx, { filename: f });
  const PL = ctx.window.PL;
  PL.plex.init();
  return PL;
}

const L = load('web').firstrunLogic;
const run = (s, ...events) => events.reduce((st, e) => L.next(st, typeof e === 'string' ? { type: e } : e), s);

const HOME = [
  { uuid: 'u-alex', title: 'Alex', admin: true },
  { uuid: 'u-sam', title: 'Sam', protected: true },
  { uuid: 'u-kids', title: 'Kids', restricted: true },
  { uuid: 'u-guest', title: 'Guest' },
];

// ---- the state machine ----------------------------------------------------------------------------

test('web starts on Welcome, the TV on the code', () => {
  assert.equal(L.initial({ platform: 'web' }).view, 'welcome');
  assert.equal(L.initial({ platform: 'tv' }).view, 'code');
});

test('Sign in with Plex: popup opened -> waiting; blocked -> the blocked card; Back returns to Welcome', () => {
  const s = L.initial({ platform: 'web', firstRun: true });
  const waiting = run(s, 'POPUP_OPENED');
  assert.equal(waiting.view, 'waiting');
  assert.equal(run(waiting, 'BACK').view, 'welcome');
  assert.equal(run(waiting, 'CANCEL').view, 'welcome');
  const blocked = run(s, 'POPUP_BLOCKED');
  assert.equal(blocked.view, 'blocked');
  assert.equal(run(blocked, 'USE_CODE').view, 'code');
  assert.equal(run(blocked, 'BACK').view, 'welcome');
});

test('Back from the code: Welcome on the web, nowhere on the TV (the app exits)', () => {
  const web = run(L.initial({ platform: 'web' }), 'USE_CODE');
  assert.equal(run(web, 'BACK').view, 'welcome');
  const tv = L.initial({ platform: 'tv' });
  assert.equal(L.backTarget(tv), null);
  assert.equal(run(tv, 'BACK'), tv, 'no change');
});

test('signed in: the picker only for Plex Home accounts', () => {
  const s = L.initial({ platform: 'web' });
  const home = run(s, { type: 'SIGNED_IN', users: HOME });
  assert.equal(home.view, 'profiles');
  assert.equal(home.hasProfiles, true);
  const solo = run(s, { type: 'SIGNED_IN', users: [HOME[0]] });
  assert.equal(solo.view, 'connecting');
  assert.equal(run(s, { type: 'SIGNED_IN', users: [] }).view, 'connecting');
  // Back at the picker goes nowhere (the way out is "Not you? Sign out")
  assert.equal(L.backTarget(home), null);
});

test('picking a profile: a PIN first when it has one; Back from the PIN returns to the picker', () => {
  const s = run(L.initial({ platform: 'tv' }), { type: 'SIGNED_IN', users: HOME });
  const pin = run(s, { type: 'PICK', user: HOME[1] });
  assert.equal(pin.view, 'pin');
  assert.equal(pin.user.title, 'Sam');
  assert.equal(run(pin, 'BACK').view, 'profiles');
  assert.equal(run(s, { type: 'PICK', user: HOME[2] }).view, 'connecting');
});

test('PIN: digits fill the dots, the fourth submits, more are ignored; wrong clears with a shake', () => {
  let s = run(L.initial({ platform: 'web' }), { type: 'SIGNED_IN', users: HOME }, { type: 'PICK', user: HOME[1] });
  s = run(s, { type: 'PIN_KEY', key: '1' }, { type: 'PIN_KEY', key: '2' }, { type: 'PIN_KEY', key: 'del' }, { type: 'PIN_KEY', key: '3' });
  assert.equal(s.pin, '13');
  assert.equal(s.pinBusy, false);
  s = run(s, { type: 'PIN_KEY', key: '5' }, { type: 'PIN_KEY', key: '7' });
  assert.equal(s.pin, '1357');
  assert.equal(s.pinBusy, true, 'the fourth digit submits');
  assert.equal(run(s, { type: 'PIN_KEY', key: '9' }), s, 'keys wait while it is checked');
  const wrong = run(s, 'PIN_WRONG');
  assert.equal(wrong.pin, '');
  assert.equal(wrong.pinError, true);
  assert.equal(wrong.shake, s.shake + 1);
  assert.equal(wrong.view, 'pin');
  // typing again clears the message
  assert.equal(run(wrong, { type: 'PIN_KEY', key: '4' }).pinError, false);
  assert.equal(run(s, 'PIN_FAILED').pinError, 'failed');
  assert.equal(run(s, 'PIN_OK').view, 'connecting');
  // left while it was being checked: picking a PIN profile again starts afresh
  const again = run(s, 'BACK', { type: 'PICK', user: HOME[1] }, { type: 'PIN_KEY', key: '7' });
  assert.equal(again.pinBusy, false);
  assert.equal(again.pin, '7');
  assert.equal(run(s, 'CHOOSE_PROFILE').pinBusy, false);
  assert.equal(run(s, 'SIGN_OUT').pinBusy, false);
});

test('pinStep and digit keys', () => {
  assert.deepEqual(clone(L.pinStep('', '4')), { pin: '4', submit: false });
  assert.deepEqual(clone(L.pinStep('123', '4')), { pin: '1234', submit: true });
  assert.deepEqual(clone(L.pinStep('1234', '5')), { pin: '1234', submit: false });
  assert.deepEqual(clone(L.pinStep('12', 'x')), { pin: '12', submit: false });
  assert.deepEqual(clone(L.pinStep('', 'del')), { pin: '', submit: false });
  assert.equal(L.digitFromKey(48), '0');
  assert.equal(L.digitFromKey(57), '9');
  assert.equal(L.digitFromKey(101), '5', 'numeric keypad');
  assert.equal(L.digitFromKey(65), null);
  assert.equal(L.isWrongPin({ status: 401 }), true);
  assert.equal(L.isWrongPin({ status: 403 }), true);
  assert.equal(L.isWrongPin({ status: 0 }), false);
  assert.equal(L.isWrongPin({ status: 500 }), false);
});

test('connecting: routes update in place; failure shows the error; Try again connects again', () => {
  let s = run(L.initial({ platform: 'web' }), { type: 'SIGNED_IN', users: HOME }, { type: 'PICK', user: HOME[0] });
  s = run(s, { type: 'ROUTE', kind: 'lan', status: 'blocked', server: 'Home Server' }, { type: 'ROUTE', kind: 'remote', status: 'trying' });
  assert.equal(s.view, 'connecting');
  assert.deepEqual(clone(s.routes), { lan: 'blocked', remote: 'trying' });
  assert.equal(s.server, 'Home Server');
  const err = run(s, { type: 'FAILED', error: L.classify({ code: 'UNREACHABLE', server: 'Home Server', routes: { lan: 'timeout' } }) });
  assert.equal(err.view, 'error');
  assert.equal(err.error.sheet, 'unreachable');
  const again = run(err, 'RETRY');
  assert.equal(again.view, 'connecting');
  assert.equal(again.routes, null);
  assert.equal(run(err, 'CHOOSE_PROFILE').view, 'profiles');
  assert.equal(run(run(err, 'CHOOSE_SERVER'), 'BACK').view, 'error');
});

test('Cancel while connecting: the picker, else sign-in (first run), else nothing', () => {
  const home = run(L.initial({ platform: 'web' }), { type: 'SIGNED_IN', users: HOME }, { type: 'PICK', user: HOME[3] });
  assert.equal(L.cancelTarget(home), 'profiles');
  assert.equal(run(home, 'CANCEL').view, 'profiles');
  const solo = run(L.initial({ platform: 'tv' }), { type: 'SIGNED_IN', users: [] });
  assert.equal(L.cancelTarget(solo), 'code');
  const launch = L.initial({ platform: 'web', view: 'connecting' });
  assert.equal(L.cancelTarget(launch), null);
  assert.equal(run(launch, 'CANCEL'), launch);
});

test('Sign out returns to the start of the flow', () => {
  const err = run(L.initial({ platform: 'web' }), { type: 'SIGNED_IN', users: HOME }, { type: 'PICK', user: HOME[0] }, { type: 'FAILED', error: L.classify({ code: 'NO_SERVER' }) });
  const out = run(err, 'SIGN_OUT');
  assert.equal(out.view, 'welcome');
  assert.equal(out.hasProfiles, false);
  assert.equal(run(L.initial({ platform: 'tv', view: 'error' }), 'SIGN_OUT').view, 'code');
});

test('the explainer view: LNA_ASK shows it, CONNECTING leaves it', () => {
  const s = run(L.initial({ platform: 'web' }), { type: 'SIGNED_IN', users: [] }, 'LNA_ASK');
  assert.equal(s.view, 'lna');
  assert.equal(run(s, 'CONNECTING').view, 'connecting');
});

test('who has the focus first, who needs a switch', () => {
  assert.equal(L.firstFocus(HOME, null), 0);
  assert.equal(L.firstFocus(HOME, 'u-kids'), 2);
  assert.equal(L.firstFocus([HOME[3], HOME[0]], 'gone'), 1, 'the owner when the remembered one is gone');
  assert.equal(L.needsSwitch(HOME[0], 'u-alex'), false, 'the profile the sign-in already belongs to');
  assert.equal(L.needsSwitch(HOME[0], 'u-kids'), true, 'the owner, while another profile is in use');
  assert.equal(L.needsSwitch(HOME[0], null), true, 'not knowing whose sign-in it is');
  assert.equal(L.needsSwitch({ uuid: 'u-alex', admin: true, protected: true }, 'u-alex'), true, 'a PIN always asks');
  assert.equal(L.needsSwitch(HOME[2], 'u-alex'), true);
  assert.equal(L.profileNote(HOME[0]), 'Owner');
  assert.equal(L.profileNote(HOME[1]), 'PIN');
  assert.equal(L.profileNote(HOME[3]), '');
});

// ---- local network ---------------------------------------------------------------------------------

test('local-network gate: ask only when the browser would prompt and the server has a local address', () => {
  const d = (o) => L.lnaDecision(Object.assign({ platform: 'web', hasLocal: true, skipped: false }, o));
  assert.equal(d({ state: 'prompt' }), 'ask');
  assert.equal(d({ state: 'prompt', skipped: true }), 'skip');
  assert.equal(d({ state: 'granted' }), 'allow');
  assert.equal(d({ state: 'denied' }), 'blocked');
  assert.equal(d({ state: null }), 'allow', 'a browser without the permission');
  assert.equal(d({ state: 'prompt', hasLocal: false }), 'allow');
  assert.equal(d({ state: 'prompt', platform: 'tv' }), 'allow', 'the TV never asks');
  assert.deepEqual(clone(L.LNA_NAMES), ['local-network-access', 'local-network']);
});

// ---- errors ----------------------------------------------------------------------------------------

test('error codes pick the sheet', () => {
  assert.equal(L.classify({ code: 'NO_SERVER' }).sheet, 'noServer');
  assert.equal(L.classify({ code: 'UNREACHABLE' }).sheet, 'unreachable');
  assert.equal(L.classify({ code: 'NO_SECURE_ADDRESS' }).sheet, 'unreachable');
  assert.equal(L.classify({ code: 'NO_LIBRARIES', server: 'S' }).sheet, 'noLibraries');
  assert.equal(L.classify({ code: 'NO_ACCESS' }).sheet, 'noLibraries');
  assert.equal(L.classify({ status: 0, plexTv: true }).sheet, 'plexTv');
  assert.equal(L.classify({ status: 403, server: 'S' }).code, 'NO_ACCESS');
  assert.equal(L.classify(new Error('odd')).sheet, 'unreachable');
  assert.equal(L.classify(null).sheet, 'unreachable');
});

test('what was tried, per route, in words', () => {
  const rows = L.triedRows({ lan: 'timeout', remote: 'none', relay: 'fail' });
  assert.deepEqual(clone(rows).map((r) => [r.label, r.value]), [
    ['Home network', 'No answer'], ['Plex Remote Access', 'Not turned on for this server'], ['Plex relay', 'No answer']]);
  assert.deepEqual(clone(L.triedRows({ lan: 'blocked', remote: 'refused' })).map((r) => r.value), ['Blocked in this browser', 'Turned this device away']);
  assert.equal(L.routeResult('remote', 'none', true), 'Turned off', 'the phone board says it shorter');
  assert.equal(L.routeLabel('remote', true), 'Remote Access');
  assert.match(L.triedHint({ remote: 'none' }), /Remote Access/);
  assert.match(L.triedHint({ lan: 'blocked', remote: 'fail' }), /local network/);
  assert.equal(L.triedHint({ lan: 'fail', remote: 'fail' }), '');
});

test('link URL carries the code (plex.tv/link reads ?token=); PIN renewal; plex.tv back-off', () => {
  assert.equal(L.linkUrl('R4TX'), 'https://plex.tv/link/?token=R4TX');
  assert.equal(L.linkUrl(''), 'https://plex.tv/link');
  assert.equal(L.renewIn({ expiresIn: 900 }, 1), 870000);
  assert.equal(L.renewIn({ expiresIn: 30 }, 1234), 1234);
  assert.equal(L.retryIn({ status: 429 }), 30000);
  assert.equal(L.retryIn({ status: 0 }), 5000);
});

test('web layout and zoom follow the window', () => {
  assert.equal(L.webLayout(390, 844), 'stack');
  assert.equal(L.webLayout(820, 1180), 'stack');
  assert.equal(L.webLayout(844, 390), 'short');
  assert.equal(L.webLayout(1440, 900), 'desk');
  assert.equal(L.webLayout(1024, 768), 'desk');
  assert.equal(L.webLayout(2560, 1080), 'desk');
  assert.equal(L.webZoom('desk', 1440, 900), 1);
  assert.equal(L.webZoom('desk', 2560, 1080), 1.2);
  assert.equal(L.webZoom('desk', 800, 500), 0.7, 'never below 0.7');
  assert.equal(L.webZoom('stack', 390, 844), 1);
  assert.equal(L.webZoom('short', 844, 390), 1);
  assert.equal(L.webMargin('desk', 1440, 1), 96);
  assert.equal(Math.round(L.webMargin('desk', 2560, 1.2) * 1.2), 160, 'the ultrawide board');
});

// ---- js/plex.js: discovery reports codes and per-route results -----------------------------------

const RESOURCE = {
  name: 'Home Server', clientIdentifier: 'abc', owned: true, accessToken: 'srv',
  connections: [
    { local: true, relay: false, address: '10.0.0.2', port: 32400, uri: 'https://10-0-0-2.x.plex.direct:32400' },
    { local: false, relay: false, address: '203.0.113.5', port: 14000, uri: 'https://203-0-113-5.x.plex.direct:14000' },
    { local: false, relay: true, address: '198.51.100.7', port: 8443, uri: 'https://198-51-100-7.x.plex.direct:8443' },
  ],
};

// answers: {host-fragment: 'ok' | 'timeout' | 'fail' | 401}
function fakeHttp(PL, answers, calls) {
  PL.http = (method, url) => {
    if (calls) calls.push(url);
    for (const key of Object.keys(answers)) {
      if (url.includes(key)) {
        const a = answers[key];
        if (typeof a === 'function') return a(url);
        if (a === 'ok') return Promise.resolve({ MediaContainer: { machineIdentifier: 'abc' } });
        const err = new Error('x');
        err.status = typeof a === 'number' ? a : 0;
        if (a === 'timeout') err.timeout = true;
        return Promise.reject(err);
      }
    }
    return Promise.reject(Object.assign(new Error('unexpected ' + url), { status: 0 }));
  };
}

test('connect: all routes fail -> UNREACHABLE with a result per route, in order of progress', async () => {
  const PL = load('web');
  fakeHttp(PL, { '10-0-0-2': 'timeout', '203-0-113-5': 401, '198-51-100-7': 'fail' });
  const seen = [];
  await assert.rejects(PL.plex.connect(RESOURCE, { onRoute: (r, st) => seen.push(r + ':' + st) }), (e) => {
    assert.equal(e.code, 'UNREACHABLE');
    assert.equal(e.server, 'Home Server');
    assert.deepEqual(clone(e.routes), { lan: 'timeout', remote: 'refused', relay: 'fail' });
    return true;
  });
  assert.deepEqual(seen.slice(0, 3), ['lan:trying', 'remote:trying', 'relay:trying']);
  assert.ok(seen.includes('lan:timeout') && seen.includes('remote:refused') && seen.includes('relay:fail'));
});

test('connect: the most preferred answering route wins', async () => {
  const PL = load('web');
  fakeHttp(PL, { '10-0-0-2': 'fail', '203-0-113-5': 'ok', '198-51-100-7': 'ok' });
  const s = await PL.plex.connect(RESOURCE);
  assert.equal(s.kind, 'remote');
});

test('connect: the local-network gate holds the local request until it decides', async () => {
  const PL = load('web');
  const calls = [];
  fakeHttp(PL, { '10-0-0-2': 'ok', '203-0-113-5': 'ok', '198-51-100-7': 'ok' }, calls);
  let release;
  PL.plex.lanGate = () => new Promise((r) => { release = r; });
  const seen = [];
  const p = PL.plex.connect(RESOURCE, { onRoute: (r, st) => seen.push(r + ':' + st) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0, 'nothing is requested while the explainer waits');
  release('skip');
  const s = await p;
  assert.equal(s.kind, 'remote');
  assert.ok(!calls.some((u) => u.includes('10-0-0-2')), 'the local address was left alone');
  assert.ok(seen.includes('lan:skipped'));
  // 'blocked' (denied in the browser) reports so; 'allow' probes it
  PL.plex.lanGate = () => Promise.resolve('blocked');
  await assert.rejects(PL.plex.connect({ ...RESOURCE, connections: [RESOURCE.connections[0]] }), (e) => e.routes.lan === 'blocked');
  PL.plex.lanGate = () => Promise.resolve('allow');
  assert.equal((await PL.plex.connect(RESOURCE)).kind, 'lan');
  // allowed after the explainer: the local request waits longer (the browser's prompt is up)
  const timeouts = [];
  fakeHttp(PL, { '10-0-0-2': 'ok', '203-0-113-5': 'ok', '198-51-100-7': 'ok' });
  const http = PL.http;
  PL.http = (m, url, o) => { timeouts.push([url.split('/')[2], o.timeout]); return http(m, url, o); };
  PL.plex.lanGate = () => Promise.resolve('asked');
  assert.equal((await PL.plex.connect(RESOURCE)).kind, 'lan');
  assert.ok(timeouts.some(([h, t]) => h.startsWith('10-0-0-2') && t === 30000));
  assert.ok(timeouts.some(([h, t]) => h.startsWith('203-0-113-5') && t === 4000));
});

test('connect: after the explainer, an unanswered prompt does not hold up Remote Access', async () => {
  const PL = load('web');
  fakeHttp(PL, { '10-0-0-2': () => new Promise(() => {}), '203-0-113-5': 'ok' });
  PL.plex.lanGate = () => Promise.resolve('asked');
  assert.equal((await PL.plex.connect(RESOURCE)).kind, 'remote');
  // and when nothing else answers, it still waits for the local address
  fakeHttp(PL, { '10-0-0-2': () => new Promise((r) => setTimeout(() => r({}), 20)), '203-0-113-5': 'fail', '198-51-100-7': 'fail' });
  assert.equal((await PL.plex.connect(RESOURCE)).kind, 'lan');
});

test('ensureServer: a dropped attempt leaves the server in use alone', async () => {
  const PL = load('web');
  PL.plex.token = 't';
  const before = { machineId: 'old', name: 'Old', uri: 'https://old', token: 'x', kind: 'remote' };
  PL.plex.server = before;
  fakeHttp(PL, { '/api/v2/resources': () => Promise.resolve([{ ...RESOURCE, provides: 'server' }]), 'plex.direct': 'ok' });
  await assert.rejects(PL.plex.ensureServer(true, { isCurrent: () => false }), (e) => e.cancelled === true);
  assert.equal(PL.plex.server, before);
});

test('connect: a dropped attempt never asks (isCurrent is passed to the gate)', async () => {
  const PL = load('web');
  fakeHttp(PL, { '203-0-113-5': 'ok' });
  let got = null;
  PL.plex.lanGate = (r, o) => { got = o; return Promise.resolve(o.isCurrent && !o.isCurrent() ? 'skip' : 'ask'); };
  await PL.plex.connect(RESOURCE, { isCurrent: () => false });
  assert.equal(typeof got.isCurrent, 'function');
  assert.equal(got.isCurrent(), false);
});

test('connect: a background check never stops to ask', async () => {
  const PL = load('web');
  fakeHttp(PL, { '10-0-0-2': 'ok', '203-0-113-5': 'ok' });
  PL.plex.lanGate = (r, o) => Promise.resolve(o.quiet ? 'ask' : 'allow');
  assert.equal((await PL.plex.connect(RESOURCE, { quiet: true })).kind, 'remote', "'ask' when quiet counts as skip");
});

test('connect: no address a browser can use -> NO_SECURE_ADDRESS', async () => {
  const PL = load('web');
  const plain = { name: 'Old', connections: [{ local: true, relay: false, address: '10.0.0.2', port: 32400, uri: 'http://10.0.0.2:32400' }] };
  await assert.rejects(PL.plex.connect(plain), (e) => e.code === 'NO_SECURE_ADDRESS' && /Secure connections/.test(e.message));
});

test('ensureServer: no servers -> NO_SERVER; plex.tv down -> plexTv; another server can be preferred', async () => {
  const PL = load('web');
  PL.plex.token = 't';
  fakeHttp(PL, { '/api/v2/resources': () => Promise.resolve([]) });
  await assert.rejects(PL.plex.ensureServer(true), (e) => e.code === 'NO_SERVER' && e.servers === 0);
  fakeHttp(PL, { '/api/v2/resources': 'fail' });
  await assert.rejects(PL.plex.ensureServer(true), (e) => e.plexTv === true);
  const other = { ...RESOURCE, name: 'Friend', clientIdentifier: 'def', owned: false,
    connections: [{ local: false, relay: false, address: '192.0.2.9', port: 1, uri: 'https://192-0-2-9.x.plex.direct:1' }] };
  fakeHttp(PL, { '/api/v2/resources': () => Promise.resolve([{ ...RESOURCE, provides: 'server' }, { ...other, provides: 'server' }]), 'plex.direct': 'ok' });
  assert.equal((await PL.plex.ensureServer(true)).name, 'Home Server', 'the owned one by default');
  assert.equal((await PL.plex.ensureServer(true, { prefer: 'def' })).name, 'Friend');
  // a failure says how many servers there were (for "Choose another server")
  fakeHttp(PL, { '/api/v2/resources': () => Promise.resolve([{ ...RESOURCE, provides: 'server' }, { ...other, provides: 'server' }]), 'plex.direct': 'fail' });
  await assert.rejects(PL.plex.ensureServer(true), (e) => e.code === 'UNREACHABLE' && e.servers === 2);
});

test('ensureServer: a remembered local address waits for the gate too', async () => {
  const PL = load('web');
  PL.plex.token = 't';
  PL.plex.server = { machineId: 'abc', name: 'Home Server', uri: 'https://10-0-0-2.x.plex.direct:32400', token: 'srv', kind: 'lan' };
  const calls = [];
  fakeHttp(PL, { '/api/v2/resources': () => Promise.resolve([{ ...RESOURCE, provides: 'server' }]), '10-0-0-2': 'ok', '203-0-113-5': 'ok' }, calls);
  PL.plex.lanGate = () => Promise.resolve('skip');
  const s = await PL.plex.ensureServer(false);
  assert.equal(s.kind, 'remote');
  assert.ok(!calls.some((u) => u.includes('10-0-0-2')));
});

test('switchToken: the profile token, or the error that says the PIN was wrong', async () => {
  const PL = load('tv');
  PL.plex.token = 'owner';
  const calls = [];
  fakeHttp(PL, { '/switch': (url) => (url.includes('pin=1234') ? Promise.resolve({ authToken: 'sam' }) : Promise.reject(Object.assign(new Error('x'), { status: 403 }))) }, calls);
  assert.equal(await PL.plex.switchToken({ uuid: 'u-sam', title: 'Sam' }, '1234'), 'sam');
  await assert.rejects(PL.plex.switchToken({ uuid: 'u-sam', title: 'Sam' }, '0000'), (e) => PL.firstrunLogic.isWrongPin(e));
  assert.ok(calls[0].includes('/api/v2/home/users/u-sam/switch'));
});
