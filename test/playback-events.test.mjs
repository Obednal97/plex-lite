// Tests for the onPlayback hook (js/plugins.js, docs/PLUGINS.md "onPlayback"): the session tracker's
// event order (play → pause → resume → seek → stop, Up Next, Live TV, buffering), what an item tells
// plugins, the deferred and isolated delivery, and that the player's side stays cheap.
//   node --test test/playback-events.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const J = (v) => JSON.parse(JSON.stringify(v));

// A page with js/plugins.js (and the Live TV category rules), fake timers and a fake document.
function load() {
  const timers = [];
  let now = 0;
  const store = {};
  const warnings = [];
  const doc = { hidden: false };
  const ctx = {
    document: doc,
    setTimeout: (fn, ms) => { const t = { fn, at: now + (ms || 0), id: timers.length + 1 }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cancelled = true; },
    console,
  };
  ctx.window = ctx;
  ctx.PL = {
    storage: {
      get: (k, d) => (k in store ? JSON.parse(store[k]) : d),
      set: (k, v) => { store[k] = JSON.stringify(v); },
      del: (k) => { delete store[k]; },
    },
    warn: (...a) => warnings.push(a.join(' ')),
    log() {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/livetv-browse.js'), ctx, { filename: 'js/livetv-browse.js' });
  vm.runInContext(read('js/plugins.js'), ctx, { filename: 'js/plugins.js' });
  // runs every timer due within ms (in time order, including ones scheduled meanwhile)
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && !t.done && t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = due.at;
      due.done = true;
      due.fn();
    }
    now = until;
  };
  const P = ctx.PL.plugins;
  // a bundled plugin that records what it hears
  const listen = (id = 'rec', opts = {}) => {
    const got = [];
    P.register({ id, name: id, version: '1', apiVersion: 1, onPlayback: (ev) => { got.push(J(ev)); }, ...opts });
    return got;
  };
  return { ctx, P, advance, warnings, doc, listen };
}

const MOVIE = {
  ratingKey: '901', key: '/library/metadata/901', type: 'movie', title: 'Sintel', year: 2010, duration: 888000,
  contentRating: 'PG-13', thumb: '/library/metadata/901/thumb/1', librarySectionTitle: 'Films', librarySectionID: 3,
  Genre: [{ tag: 'Animation' }, { tag: 'Fantasy' }, { tag: 'Short' }, { tag: 'Adventure' }],
  Media: [{ Part: [{ key: '/library/parts/1/file.mkv', file: '/data/films/Sintel.mkv' }] }],
};
const EP1 = { ratingKey: '701', type: 'episode', title: 'Llama Drama', grandparentTitle: 'Caminandes', parentIndex: 1, index: 1, year: 2013, duration: 90000, contentRating: 'TV-G' };
const EP2 = { ratingKey: '702', type: 'episode', title: 'Gran Dillama', grandparentTitle: 'Caminandes', parentIndex: 1, index: 2, duration: 146000, contentRating: 'TV-G' };

test('playback: play → pause → resume → seek → stop, in order, after the frame', () => {
  const { P, advance, listen } = load();
  const got = listen();
  const s = P.playbackSession();
  s.playing('901', MOVIE, false, 1000);
  s.paused(5000);
  s.playing('901', MOVIE, false, 5000);       // resume
  s.playing('901', MOVIE, false, 65000);      // a seek that restarted the stream: still playing
  s.waiting(() => 65000); s.playing('901', MOVIE, false, 65100); // a direct seek's short stall
  s.stopped(70000);
  assert.equal(got.length, 0, 'nothing is delivered in the task that reported it');
  advance(199);
  assert.equal(got.length, 0);
  advance(1);
  assert.deepEqual(got.map((e) => e.event), ['play', 'pause', 'resume', 'stop']);
  assert.deepEqual(got.map((e) => e.positionMs), [1000, 5000, 5000, 70000]);
  assert.equal(got[0].item.title, 'Sintel');
  assert.equal(typeof got[0].at, 'number');
  // a second stop (the player's exit after a failure) says nothing more
  s.stopped(70000); s.ended(70000); s.paused(1);
  advance(1000);
  assert.equal(got.length, 4);
  assert.equal(s.state(), 'idle');
});

test('playback: Up Next: the old episode ended, then the next one plays; an early jump is a stop', () => {
  const { P, advance, listen } = load();
  const got = listen();
  const s = P.playbackSession();
  s.playing('701', EP1, false, 0);
  s.ended(88000);                       // credits → Up Next (or the video ending)
  s.playing('702', EP2, false, 0);
  // the player says "stopped" for a Next episode press early in an episode (js/screens/player.js playNext)
  s.stopped(30000);
  s.playing('701', EP1, false, 0);
  advance(500);
  assert.deepEqual(got.map((e) => [e.event, e.item.episode]), [['play', 1], ['ended', 1], ['play', 2], ['stop', 2], ['play', 1]]);
  // an item change the player never reported the end of still ends the old one first
  s.playing('901', MOVIE, false, 0);
  advance(500);
  assert.deepEqual(got.slice(5).map((e) => [e.event, e.item.title]), [['stop', 'Llama Drama'], ['play', 'Sintel']]);
});

test('playback: Live TV: kind live, the channel, its category; changing channel is stop then play', () => {
  const { P, advance, listen } = load();
  const got = listen();
  const s = P.playbackSession();
  const news = { identifier: '104', title: 'Demo News 24' };
  const sport = { identifier: '110', title: 'Racing Live' };
  s.playing('live:104', { channel: news, now: { type: 'episode', grandparentTitle: 'Evening Bulletin', title: '31 October', Genre: [{ tag: 'News' }] } }, true, null);
  s.paused(null);
  s.playing('live:104', { channel: news, now: null }, true, null);
  s.playing('live:110', { channel: sport, now: null }, true, null);   // no guide data: the name decides
  s.stopped(null);
  advance(500);
  assert.deepEqual(got.map((e) => e.event), ['play', 'pause', 'resume', 'stop', 'play', 'stop']);
  assert.deepEqual(got[0].item, { type: 'live', kind: 'live', title: 'Evening Bulletin', channel: 'Demo News 24', liveCategory: 'news', genres: ['News'], isKids: false });
  assert.equal(got[0].positionMs, null);
  assert.equal(got[3].item.channel, 'Demo News 24');
  assert.deepEqual([got[4].item.title, got[4].item.liveCategory], ['Racing Live', 'sports']);
});

test('playback: buffering only after a 2 s stall, and its end', () => {
  const { P, advance, listen } = load();
  const got = listen();
  const s = P.playbackSession();
  s.playing('901', MOVIE, false, 0);
  s.waiting(() => 10000);
  advance(1999);
  s.playing('901', MOVIE, false, 10000);       // recovered in time: nothing
  s.waiting(() => 20000);
  advance(2000);
  s.playing('901', MOVIE, false, 20500);
  s.waiting(() => 30000);
  s.paused(30000);                             // paused while stalled: a pause, no buffering
  advance(5000);
  assert.deepEqual(got.map((e) => e.event), ['play', 'buffering-start', 'buffering-end', 'pause']);
  assert.equal(got[1].positionMs, 20000);
});

test('playback: what a plugin learns about an item (and nothing that identifies the server)', () => {
  const { P } = load();
  const m = J(P.playbackItem(MOVIE, false));
  assert.deepEqual(m, { type: 'movie', kind: 'movie', title: 'Sintel', year: 2010, durationMs: 888000, contentRating: 'PG-13', genres: ['Animation', 'Fantasy', 'Short'], isKids: false });
  const e = J(P.playbackItem(EP1, false));
  assert.deepEqual(e, { type: 'episode', kind: 'series', title: 'Llama Drama', showTitle: 'Caminandes', season: 1, episode: 1, year: 2013, durationMs: 90000, contentRating: 'TV-G', genres: [], isKids: true });
  const clip = J(P.playbackItem({ type: 'clip', title: 'Trailer', ratingKey: '5' }, false));
  assert.equal(clip.type, 'clip');
  assert.equal(clip.kind, null);
  const text = JSON.stringify([m, e, clip]);
  for (const leak of ['901', 'library', 'thumb', 'ratingKey', 'file', 'Section']) assert.ok(!text.includes(leak), leak);
  const kids = (meta) => P.playbackItem(meta, false).isKids;
  assert.equal(kids({ type: 'movie', contentRating: 'G' }), true);
  assert.equal(kids({ type: 'movie', contentRating: 'gb/U' }), true);
  assert.equal(kids({ type: 'movie', contentRating: 'PG' }), true, 'PG films count');
  assert.equal(kids({ type: 'episode', contentRating: 'TV-PG' }), false, 'TV-PG does not');
  assert.equal(kids({ type: 'movie', contentRating: 'gb/15' }), false);
  assert.equal(kids({ type: 'movie', contentRating: 'R', librarySectionTitle: 'Kids Films' }), true, 'a kids library');
  assert.equal(kids({ type: 'episode', Genre: [{ tag: 'Children' }] }), true, 'a children\'s genre');
  assert.equal(kids({ type: 'movie' }), false);
  const live = J(P.playbackItem({ channel: { title: 'CBeebies HD', identifier: '9' }, now: null }, true));
  assert.deepEqual([live.liveCategory, live.isKids], ['kids', true]);
  assert.equal(J(P.playbackItem({ channel: { title: 'Channel 9', identifier: '9' } }, true)).liveCategory, null);
});

test('playback: isolation: a throwing, rejecting or never-answering plugin changes nothing for the others', async () => {
  const { P, advance, warnings, listen } = load();
  P.register({ id: 'throws', name: 'T', version: '1', apiVersion: 1, onPlayback: () => { throw new Error('boom'); } });
  P.register({ id: 'rejects', name: 'R', version: '1', apiVersion: 1, onPlayback: () => Promise.reject(new Error('nope')) });
  P.register({ id: 'hangs', name: 'H', version: '1', apiVersion: 1, onPlayback: () => new Promise(() => {}) });
  P.register({ id: 'mutates', name: 'M', version: '1', apiVersion: 1, onPlayback: (ev) => { ev.event = 'hacked'; ev.item.title = 'x'; ev.item.genres.push('y'); } });
  const got = listen('rec');
  const s = P.playbackSession();
  // reporting returns at once: no plugin code runs here
  s.playing('901', MOVIE, false, 0);
  s.paused(1000);
  assert.equal(warnings.length, 0);
  advance(200);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((e) => [e.event, e.item.title, e.item.genres.length]), [['play', 'Sintel', 3], ['pause', 'Sintel', 3]]);
  assert.ok(warnings.some((w) => /throws onPlayback failed: boom/.test(w)));
  assert.ok(warnings.some((w) => /rejects onPlayback failed: nope/.test(w)));
});

test('playback: switched-off plugins hear nothing; with no listener the tracker does no work', () => {
  const { P, advance, listen } = load();
  const s0 = P.playbackSession();
  assert.equal(P.hasPlayback(), false);
  s0.playing('901', MOVIE, false, 0);
  assert.equal(s0.state(), 'idle', 'nobody listens: no session, no item built');
  const got = listen('rec');
  P.setEnabled('rec', false);
  const s = P.playbackSession();
  s.playing('901', MOVIE, false, 0);
  advance(500);
  assert.equal(got.length, 0);
  P.setEnabled('rec', true);
  s.stopped(0);
  s.playing('901', MOVIE, false, 0);
  advance(500);
  assert.deepEqual(got.map((e) => e.event), ['play']);
});

test('playback: while the page goes away the events are delivered at once', () => {
  const { ctx, P, doc, listen } = load();
  const got = listen();
  const s = P.playbackSession();
  s.playing('901', MOVIE, false, 0);
  doc.hidden = true; // the TV app leaving the foreground: the player stops in this task
  s.stopped(4000);
  assert.deepEqual(got.map((e) => e.event), ['play', 'stop'], 'the queued play goes first');
  doc.hidden = false;
  ctx.PL.leaving = true; // a browser tab closing
  s.playing('901', MOVIE, false, 0);
  assert.equal(got.length, 3);
});

test('playback: the player\'s side is cheap (no plugin work, microseconds per report)', () => {
  const { P, listen } = load();
  listen();
  const s = P.playbackSession();
  const N = 20000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    s.playing('901', MOVIE, false, i);
    s.paused(i);
  }
  const perReport = Number(process.hrtime.bigint() - t0) / 1e3 / (2 * N);
  // a 1.1 GHz TV is ~10x slower than this machine; still far under a millisecond
  assert.ok(perReport < 20, `${perReport.toFixed(2)} µs per report`);
});

test('player: every emission point goes through Player.playback (no plugin calls in the player)', () => {
  const src = read('js/screens/player.js');
  const calls = (src.match(/this\.playback\('|self\.playback\('/g) || []).length;
  assert.equal(calls, 7, 'playing, paused, waiting, stopped (fail, stop), ended (onEnded, finishCredits)');
  assert.match(src, /this\.playback\(manual !== true \|\| \(dur && pos \/ dur >= 0\.9\) \? 'ended' : 'stopped'\)/, 'playNext: ended from the credits');
  assert.ok(!/plugins\.playback\(/.test(src), 'the player never dispatches itself');
  assert.match(src, /if \(!self\.scrubState\) self\.playback\('paused'\)/, 'a scrub is not a pause');
});
