// Tests for the Search tab's decisions on phones and tablets (web/touch/screens/search.js,
// PL.touchSearchLogic): recent searches, reading /hubs/search, the rows and their order, the filter
// chips, what to say when there is nothing to show, suggestions before typing, and what a channel
// or programme does when tapped.
//   node --test test/touch-search.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;

function logic() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  // the page half returns early: there is no PL.isWeb in Node
  vm.runInContext(readFileSync(join(ROOT, 'web/touch/screens/search.js'), 'utf8'), ctx, { filename: 'web/touch/screens/search.js' });
  return ctx.window.PL.touchSearchLogic;
}
const S = logic();
const J = (v) => JSON.parse(JSON.stringify(v));

test('touch search: queries are tidied', () => {
  assert.equal(S.clean('  star   wars '), 'star wars');
  assert.equal(S.clean(null), '');
  assert.equal(S.clean('x'.repeat(80)).length, 60);
});

test('touch search: recent searches are newest first, without repeats, capped', () => {
  assert.deepEqual(J(S.addRecent([], ' spring ')), ['spring']);
  assert.deepEqual(J(S.addRecent(['nasa', 'Spring'], 'spring')), ['spring', 'nasa']);
  assert.deepEqual(J(S.addRecent(['a', 'b'], '   ')), ['a', 'b']);
  assert.deepEqual(J(S.addRecent(null, 'x')), ['x']);
  assert.deepEqual(J(S.addRecent(['a', 42, '', 'b'], 'c')), ['c', 'a', 'b']); // junk in storage is dropped
  const many = Array.from({ length: 20 }, (_, i) => 'q' + i);
  assert.equal(S.addRecent(many, 'new').length, S.RECENT_MAX);
  assert.deepEqual(J(S.addRecent(['a', 'b', 'c'], 'd', 2)), ['d', 'a']);
});

test('touch search: /hubs/search becomes titles, episodes and one card per person', () => {
  const out = S.parseHubs({
    Hub: [
      { type: 'movie', Metadata: [{ ratingKey: '1', title: 'Spring' }] },
      { type: 'show', Metadata: [{ ratingKey: '2', title: 'Sprite' }] },
      { type: 'episode', Metadata: Array.from({ length: 40 }, (_, i) => ({ ratingKey: 'e' + i })) },
      { type: 'actor', Directory: [
        { id: 7, tag: 'Cary Grant', thumb: null },
        { id: 7, tag: 'Cary Grant', thumb: '/p/7' }, // the same person in another library
        { id: 9, tag: 'Cary Grant' },                // another id, the same name
        { id: 8, tag: 'Audrey Hepburn', thumb: '/p/8' },
      ] },
      { type: 'album', Metadata: [{ ratingKey: 'x' }] },
    ],
  });
  assert.deepEqual(J(out.titles.map((t) => t.ratingKey)), ['1', '2']);
  assert.equal(out.episodes.length, 30);
  assert.deepEqual(J(out.people), [
    { id: 7, tag: 'Cary Grant', name: 'Cary Grant', thumb: '/p/7', filter: 'actor' },
    { id: 8, tag: 'Audrey Hepburn', name: 'Audrey Hepburn', thumb: '/p/8', filter: 'actor' },
  ]);
  assert.deepEqual(J(S.parseHubs({})), { titles: [], people: [], episodes: [] });
  assert.deepEqual(J(S.parseHubs(null)), { titles: [], people: [], episodes: [] });
});

test('touch search: local titles first, then the server\'s the index missed', () => {
  const a = { ratingKey: '1' };
  const b = { ratingKey: '2' };
  const c = { ratingKey: '3' };
  assert.deepEqual(J(S.mergeTitles([a, b], [b, c]).map((x) => x.ratingKey)), ['1', '2', '3']);
  assert.deepEqual(J(S.mergeTitles([a, b, c], [], 2).map((x) => x.ratingKey)), ['1', '2']);
  assert.deepEqual(J(S.mergeTitles(null, null)), []);
});

const data = (o = {}) => Object.assign({ titles: [], channels: [], shows: [], people: [], episodes: [], plugins: [] }, o);
const ids = (list) => J(list.map((s) => s.id));

test('touch search: rows in the TV\'s order, empty ones left out; channels first when the query is a channel', () => {
  const d = data({ titles: [1], channels: [1], shows: [1], people: [1], episodes: [1], plugins: [{ id: 'seerr', title: 'Request', items: [1] }, { id: 'x', items: [] }] });
  assert.deepEqual(ids(S.sections(d)), ['titles', 'channels', 'ontv', 'people', 'episodes', 'plugin.seerr']);
  assert.deepEqual(ids(S.sections(Object.assign(d, { tvFirst: true }))), ['channels', 'ontv', 'titles', 'people', 'episodes', 'plugin.seerr']);
  assert.deepEqual(ids(S.sections(data({ people: [1] }))), ['people']);
  assert.deepEqual(ids(S.sections(data())), []);
  const kinds = J(S.sections(d).map((s) => s.kind + ':' + s.cat));
  assert.deepEqual(kinds, ['channel:live', 'airing:live', 'poster:titles', 'person:people', 'wide:titles', 'poster:titles']);
});

test('touch search: chips are All and each kind with results, with counts', () => {
  const list = S.sections(data({ titles: [1, 2], episodes: [1], shows: [1, 2, 3], people: [] }));
  assert.deepEqual(J(S.chips(list)), [
    { id: 'all', label: 'All' },
    { id: 'titles', label: 'Movies & Shows', value: '3' },
    { id: 'live', label: 'Live TV', value: '3' },
  ]);
  // one kind still shows its chips (so the rows don't jump when a second kind arrives)
  assert.deepEqual(J(S.chips(S.sections(data({ people: [1] })))).map((c) => c.id), ['all', 'people']);
  assert.deepEqual(J(S.chips([])), []);
});

test('touch search: a picked filter holds while it has results, else All', () => {
  const chips = [{ id: 'all' }, { id: 'titles' }];
  assert.equal(S.pickFilter(chips, 'titles'), 'titles');
  assert.equal(S.pickFilter(chips, 'people'), 'all');
  assert.equal(S.pickFilter([], 'titles'), 'all');
  const list = S.sections(data({ titles: [1], shows: [1], episodes: [1] }));
  assert.deepEqual(ids(S.visible(list, 'titles')), ['titles', 'episodes']);
  assert.deepEqual(ids(S.visible(list, 'live')), ['ontv']);
  assert.deepEqual(ids(S.visible(list, 'all')), ['titles', 'ontv', 'episodes']);
});

test('touch search: what to say when there are no rows', () => {
  const st = (o) => S.status(Object.assign({ query: 'spri', count: 0, indexReady: true, indexBuilding: false, serverDone: false, serverError: null }, o));
  assert.equal(st({ query: '  ' }), 'idle');
  assert.equal(st({ count: 2 }), null);
  assert.equal(st({ count: 2, serverDone: true, serverError: new Error('x') }), null); // local rows still show
  assert.equal(st({ indexReady: false, indexBuilding: true }), 'indexing');
  assert.equal(st({}), 'searching');
  assert.equal(st({ serverDone: true }), 'none');
  assert.equal(st({ serverDone: true, serverError: new Error('offline') }), 'error');
});

test('touch search: suggestions are Continue Watching from every library, else recently added', () => {
  const hub = (id, keys) => ({ hubIdentifier: id, Metadata: keys.map((k) => ({ ratingKey: k })) });
  const cw = S.suggestions([hub('movie.recentlyadded.1', ['r1']), hub('movie.inprogress.1', ['a', 'b']), hub('tv.inprogress.2', ['b', 'c'])]);
  assert.equal(cw.title, 'Continue Watching');
  assert.deepEqual(J(cw.items.map((i) => i.ratingKey)), ['a', 'b', 'c']);
  assert.equal(S.suggestions([hub('home.continue', ['a', 'b', 'c', 'd'])], 2).items.length, 2);
  assert.equal(S.suggestions([hub('home.ondeck', ['a'])]).title, 'Continue Watching');
  const recent = S.suggestions([hub('home.movies.recent', ['r1', 'r2']), hub('home.television.recent', ['r3'])]);
  assert.equal(recent.title, 'Recently Added');
  assert.deepEqual(J(recent.items.map((i) => i.ratingKey)), ['r1', 'r2', 'r3']);
  assert.equal(S.suggestions([hub('movie.demo.1', ['x'])]), null);
  assert.equal(S.suggestions(null), null);
});

test('touch search: a channel plays with every channel to zap through, as the guide does', () => {
  const chans = [
    { identifier: 'a', id: 1, vcn: '101', name: 'One', thumb: '/a', title: '101 One' },
    { identifier: 'b', id: 2, vcn: '102', name: 'Two', thumb: null, title: '102 Two' },
  ];
  const live = J(S.liveFor(chans, 'b', '/livetv/dvrs/1'));
  assert.deepEqual(live, {
    label: 'All channels',
    dvrKey: '/livetv/dvrs/1',
    channel: { identifier: 'b', id: 2, vcn: '102', title: 'Two', thumb: null },
    channels: [
      { identifier: 'a', id: 1, vcn: '101', title: 'One', thumb: '/a' },
      { identifier: 'b', id: 2, vcn: '102', title: 'Two', thumb: null },
    ],
    index: 1,
  });
  assert.equal(S.liveFor(chans, 'gone', 'k').index, 0);
  assert.equal(S.liveFor([], 'a', 'k').channel, null);
});

test('touch search: a programme on now plays its channel, a later one opens the guide', () => {
  assert.equal(S.airingAction({ b: 100, e: 200 }, 150), 'watch');
  assert.equal(S.airingAction({ b: 100, e: 200 }, 100), 'watch');
  assert.equal(S.airingAction({ b: 300, e: 400 }, 150), 'guide');
});
