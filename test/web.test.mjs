// Tests for the web build's platform split (docs/WEB.md): the shared code behaves as on the TV
// unless PL_PLATFORM is 'web', connections are https-only on the web, and web/web-media.js's
// direct-play decision and transcoder profile follow what the browser says it can decode.
//   node --test test/web.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

// A browser-ish context with core.js and plex.js loaded. canPlay: MIME type -> bool (web-media).
function load(platform, files, canPlay) {
  const store = {};
  const window = {
    PL_PLATFORM: platform,
    addEventListener() {},
  };
  const ctx = {
    window,
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
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150.0 Safari/537.36' },
    document: { createElement: () => ({ canPlayType: (t) => (canPlay && canPlay(t) ? 'probably' : '') }) },
    setTimeout, clearTimeout,
  };
  ctx.window.PL = undefined;
  vm.createContext(ctx);
  vm.runInContext('var window = this.window; window.localStorage = localStorage;', ctx);
  for (const f of ['js/core.js', 'js/plex.js'].concat(files || [])) vm.runInContext(read(f), ctx, { filename: f });
  return { PL: ctx.window.PL, store };
}

const RESOURCE = {
  name: 'Home', clientIdentifier: 'abc', httpsRequired: false,
  connections: [
    { local: true, relay: false, address: '192.168.0.10', port: 32400, uri: 'https://192-168-0-10.x.plex.direct:32400' },
    { local: false, relay: false, address: '203.0.113.5', port: 14000, uri: 'https://203-0-113-5.x.plex.direct:14000' },
    { local: false, relay: true, address: '198.51.100.7', port: 8443, uri: 'https://198-51-100-7.x.plex.direct:8443' },
  ],
};

test('TV: PL.isWeb is false and the plain-http LAN address comes first', () => {
  const { PL } = load(undefined);
  assert.equal(PL.isWeb, false);
  assert.deepEqual(clone(PL.plex.candidates(RESOURCE)).map((c) => c.kind), ['lan-http', 'lan', 'remote', 'relay']);
  assert.equal(PL.plex.device.platform, 'webOS');
  assert.equal(PL.keyLabel('OK'), 'OK');
  assert.equal(PL.plex.normalizeUri('192.168.0.10'), 'http://192.168.0.10:32400');
});

test('web: https addresses only, local then remote then relay', () => {
  const { PL } = load('web');
  assert.equal(PL.isWeb, true);
  const c = clone(PL.plex.candidates(RESOURCE));
  assert.deepEqual(c.map((x) => x.kind), ['lan', 'remote', 'relay']);
  assert.ok(c.every((x) => x.uri.startsWith('https://')));
  // a server with secure connections off has nothing a browser can use, and says how to fix it
  const plain = { name: 'Old', connections: [{ local: true, relay: false, address: '10.0.0.2', port: 32400, uri: 'http://10.0.0.2:32400' }] };
  assert.deepEqual(clone(PL.plex.candidates(plain)), []);
  return PL.plex.connect(plain).then(() => assert.fail('connected'), (e) => assert.match(e.message, /Secure connections/));
});

test('web: typed addresses default to https and plain http is refused', () => {
  const { PL } = load('web');
  assert.equal(PL.plex.normalizeUri('plex.example.com:32400'), 'https://plex.example.com:32400');
  return PL.plex.connectUri('http://192.168.0.10:32400', 'manual-local').then(() => assert.fail('accepted'), (e) => {
    assert.match(e.message, /https/);
  });
});

test('web: sign-out clears the browser only when the user chose it', () => {
  const { PL, store } = load('web');
  PL.plex.init();
  PL.storage.set('token', 't');
  PL.storage.set('livetv.favourites', ['x']);
  const id = PL.plex.clientId;
  PL.plex.signOut(); // an expired sign-in: settings stay
  assert.ok('pl.livetv.favourites' in store);
  assert.equal(PL.plex.clientId, id);
  PL.plex.signOut(true);
  assert.deepEqual(Object.keys(store), ['pl.clientId']);
  assert.notEqual(PL.plex.clientId, id);
});

test('web: the PIN sign-in page carries the client id, code and product', () => {
  const { PL } = load('web');
  PL.plex.init();
  const url = PL.plex.authUrl({ code: 'abcd1234' }, 'https://example.test/signed-in.html');
  assert.ok(url.startsWith('https://app.plex.tv/auth#?'));
  const q = new URLSearchParams(url.split('#?')[1]);
  assert.equal(q.get('clientID'), PL.plex.clientId);
  assert.equal(q.get('code'), 'abcd1234');
  assert.equal(q.get('forwardUrl'), 'https://example.test/signed-in.html');
  assert.equal(q.get('context[device][product]'), 'Plex Lite');
});

// Chrome-like: MP4/WebM/MKV, H.264/VP9/AV1, AAC/MP3/Opus/FLAC; no HEVC, AC3 or E-AC3
const chromeLike = (t) => !/hvc1|hev1|ac-3|ec-3|mpegurl/.test(t);
const media = (container, vc, ac, bits) => ({
  container, Part: [{ Stream: [{ streamType: 1, codec: vc, bitDepth: bits || 8 }, { streamType: 2, codec: ac }] }],
});

test('web media: direct play only what the browser decodes', () => {
  const { PL } = load('web', ['web/web-media.js'], chromeLike);
  const M = PL.webMedia;
  assert.equal(M.directPlayProblem(media('mp4', 'h264', 'aac')), null);
  assert.equal(M.directPlayProblem(media('mkv', 'h264', 'eac3')), 'audio eac3');
  assert.equal(M.directPlayProblem(media('mkv', 'hevc', 'aac', 10)), 'video hevc');
  assert.equal(M.directPlayProblem(media('mp4', 'h264', 'aac', 10)), 'video h264 10-bit');
  assert.equal(M.directPlayProblem(media('avi', 'mpeg4', 'mp3')), 'container avi');
});

test('web media: the transcoder profile asks for H.264 + stereo AAC HLS, WebVTT when wanted', () => {
  const { PL } = load('web', ['web/web-media.js'], chromeLike);
  const p = PL.webMedia.profileExtra(false);
  assert.match(p, /add-direct-play-profile\(type=videoProfile&container=mp4,m4v,mov,webm,mkv&videoCodec=h264,vp9,av1&audioCodec=aac,mp3,opus,flac\)/);
  assert.match(p, /add-transcode-target\(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac,mp3\)/);
  assert.match(p, /scope=videoAudioCodec&scopeName=aac&type=upperBound&name=audio.channels&value=2/);
  assert.doesNotMatch(p, /webvtt/);
  assert.match(PL.webMedia.profileExtra(true), /subtitleCodec=webvtt/);
  assert.equal(PL.webMedia.quality({ kind: 'relay' }).maxVideoBitrate, 2000);
  assert.equal(PL.webMedia.quality({ kind: 'lan' }).location, 'lan');
});

test('the TV build never loads web/ modules', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /web\//);
  const ipk = read('tools/build-ipk.py');
  assert.doesNotMatch(ipk, /["']web["']/);
});
