// Tests for the phone and tablet layer's browse decisions (web/touch/screens/browse.js,
// PL.touchBrowseLogic): saved filters, sort directions, counts, the page-by-page grid's geometry,
// the A–Z rail, a shelf's "See all" paging and Surprise Me's wording.
//   node --test test/touch-browse.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function load() {
  const ctx = {};
  ctx.window = ctx; // window.PL is the global PL, as in a browser
  vm.createContext(ctx);
  ctx.PL = { KEY: {} }; // js/az.js (PL.az) needs only the key codes object
  vm.runInContext(read('js/az.js'), ctx, { filename: 'js/az.js' });
  vm.runInContext(read('web/touch/screens/browse.js'), ctx, { filename: 'web/touch/screens/browse.js' });
  return ctx.PL;
}
const PL = load();
const B = PL.touchBrowseLogic;
const J = (v) => JSON.parse(JSON.stringify(v));

test('touch browse: the screens stay out of the way without the touch layer', () => {
  assert.equal(PL.touch, undefined);
  assert.ok(B);
});

test('touch browse: sorts are the TV\'s, per library type', () => {
  assert.deepEqual(J(B.sorts('movie').map((s) => s.key)), ['titleSort', 'addedAt', 'originallyAvailableAt', 'audienceRating', 'rating', 'lastViewedAt', 'duration', 'random']);
  assert.equal(B.sorts('show')[1].key, 'episode.addedAt');
  assert.equal(B.sorts('anything')[0].key, 'titleSort');
});

test('touch browse: sort directions read in words', () => {
  assert.equal(B.dirLabel('titleSort', 'asc'), 'A to Z');
  assert.equal(B.dirLabel('titleSort', 'desc', true), 'Z–A');
  assert.equal(B.dirLabel('addedAt', 'desc'), 'Newest first');
  assert.equal(B.dirLabel('episode.addedAt', 'asc', true), 'Oldest');
  assert.equal(B.dirLabel('audienceRating', 'desc'), 'Highest first');
  assert.equal(B.dirLabel('duration', 'asc'), 'Shortest first');
  assert.equal(B.dirLabel('random', 'asc'), '');
});

test('touch browse: saved filters are checked, unknown ones fall back', () => {
  assert.deepEqual(J(B.normalFilters(null, 'movie')), { sort: 'titleSort', dir: 'asc', genre: null, decade: null, unwatched: false });
  assert.deepEqual(J(B.normalFilters({ sort: 'addedAt' }, 'movie')), { sort: 'addedAt', dir: 'desc', genre: null, decade: null, unwatched: false });
  // the TV's shape, as it saves it
  const tv = { sort: 'titleSort', dir: 'desc', genre: { key: 4, title: 'Comedy' }, decade: { key: '1990', title: '1990s' }, unwatched: true };
  assert.deepEqual(J(B.normalFilters(tv, 'movie')), { sort: 'titleSort', dir: 'desc', genre: { key: '4', title: 'Comedy' }, decade: { key: '1990', title: '1990s' }, unwatched: true });
  // a show-only sort on a movie library, junk values
  assert.equal(B.normalFilters({ sort: 'episode.addedAt' }, 'movie').sort, 'titleSort');
  assert.equal(B.normalFilters({ sort: 'episode.addedAt', dir: 'sideways' }, 'show').dir, 'desc');
  assert.equal(B.normalFilters({ genre: 'Comedy', unwatched: 'yes' }, 'movie').genre, null);
  assert.equal(B.normalFilters('nonsense', 'show').sort, 'titleSort');
});

test('touch browse: filter parameters and Surprise Me filters match the TV', () => {
  const f = B.normalFilters({ genre: { key: '4', title: 'Comedy' }, decade: { key: '1990', title: '1990s' }, unwatched: true }, 'show');
  assert.deepEqual(J(B.filterParams(f, 'show')), { type: 2, includeCollections: 0, genre: '4', decade: '1990', unwatched: 1 });
  assert.deepEqual(J(B.filterParams(B.normalFilters(null, 'movie'), 'movie')), { type: 1, includeCollections: 0 });
  const s = B.surpriseFilters(f);
  assert.equal(s.label, 'Comedy · 1990s');
  assert.equal(s.unwatched, true);
  assert.equal(B.filtered(f), true);
  assert.equal(B.filtered(B.normalFilters(null, 'movie')), false);
});

test('touch browse: counts', () => {
  assert.equal(B.countLabel(1, 'movie'), '1 movie');
  assert.equal(B.countLabel(1234, 'movie'), '1,234 movies');
  assert.equal(B.countLabel(2, 'show'), '2 shows');
  assert.equal(B.countLabel(5, 'collection'), '5 collections');
  assert.equal(B.countLabel(1000000, 'title'), '1,000,000 titles');
  assert.equal(B.countLabel(0, 'movie'), '');
  assert.equal(B.countLabel(undefined, 'movie'), '');
});

test('touch browse: the grid loads only the pages on screen', () => {
  const geo = { top: 200, pitch: 250, cols: 3, total: 3000 };
  // at the top: rows 0..3 on an 852 px screen, plus 900 px ahead
  let r = B.visibleRange(geo, 0, 852, 900);
  assert.deepEqual(J(r), { first: 0, last: 3 * Math.floor((852 + 900 - 200) / 250) + 2 });
  assert.deepEqual(J(B.pagesFor(r, 60)), [0]);
  // a jump far down: just the pages around it
  r = B.visibleRange(geo, 200 + 400 * 250, 200 + 400 * 250 + 852, 0);
  assert.deepEqual(J(r), { first: 1200, last: 1211 }); // rows 400 to 403
  assert.deepEqual(J(B.pagesFor(r, 60)), [20]);
  assert.deepEqual(J(B.pagesFor({ first: 1190, last: 1214 }, 60)), [19, 20]);
  // the end of the list: clamped
  r = B.visibleRange(geo, 1e9, 1e9 + 852, 900);
  assert.equal(r, null);
  r = B.visibleRange(geo, 200 + 998 * 250, 200 + 998 * 250 + 852, 900);
  assert.equal(r.last, 2999);
  // nothing measured yet
  assert.equal(B.visibleRange(null, 0, 800, 0), null);
  assert.equal(B.visibleRange({ top: 0, pitch: 0, cols: 3, total: 9 }, 0, 800, 0), null);
  assert.deepEqual(J(B.pagesFor(null, 60)), []);
});

test('touch browse: the first title under the filter bar', () => {
  const geo = { top: 200, pitch: 250, cols: 4, total: 100 };
  assert.equal(B.firstIndexAt(geo, 0), 0);
  assert.equal(B.firstIndexAt(geo, 200 + 250 * 3), 12);
  assert.equal(B.firstIndexAt(geo, 200 + 250 * 3 + 100), 12); // most of row 3 still shows
  assert.equal(B.firstIndexAt(geo, 1e9), 99);
  assert.equal(B.firstIndexAt(null, 500), 0);
});

test('touch browse: the A–Z rail maps a finger to a letter with titles', () => {
  assert.equal(B.railIndexAt(100, 100, 270, 27), 0);
  assert.equal(B.railIndexAt(105, 100, 270, 27), 0);
  assert.equal(B.railIndexAt(115, 100, 270, 27), 1);
  assert.equal(B.railIndexAt(369, 100, 270, 27), 26);
  assert.equal(B.railIndexAt(-50, 100, 270, 27), 0); // dragged past the ends
  assert.equal(B.railIndexAt(9999, 100, 270, 27), 26);
  const model = PL.az.index([{ title: '#', size: 3 }, { title: 'B', size: 5 }, { title: 'M', size: 2 }, { title: 'S', size: 9 }], false);
  const order = PL.az.order(model);
  assert.equal(B.railTarget(model, order, order.indexOf('B')), 'B');
  assert.equal(B.railTarget(model, order, order.indexOf('C')), 'M'); // no C: the next one down
  assert.equal(B.railTarget(model, order, order.indexOf('Z')), 'S'); // nothing below: the nearest up
  assert.equal(B.railTarget(model, order, 0), '#');
  assert.equal(B.railTarget(null, order, 3), null);
  // Z–A: the rail reads Z at the top
  const desc = PL.az.index([{ title: 'A', size: 2 }, { title: 'C', size: 1 }], true);
  const dOrder = PL.az.order(desc);
  assert.equal(dOrder[0], 'Z');
  assert.equal(B.railTarget(desc, dOrder, 0), 'C');
  assert.equal(desc.starts.C, 0);
  assert.equal(desc.starts.A, 1);
});

test('touch browse: the rail fits its room', () => {
  assert.equal(B.railFit(540, 27), 'full');
  assert.equal(B.railFit(378, 27), 'full');
  assert.equal(B.railFit(300, 27), 'dense');
  assert.equal(B.railFit(216, 27), 'dense');
  assert.equal(B.railFit(150, 27), 'none');
});

test('touch browse: See all', () => {
  assert.equal(B.wideHub({ type: 'episode' }), true);
  assert.equal(B.wideHub({ type: 'movie', hubIdentifier: 'movie.inprogress.1' }), true);
  assert.equal(B.wideHub({ type: 'mixed', hubIdentifier: 'home.continue' }), true);
  assert.equal(B.wideHub({ type: 'movie', hubIdentifier: 'movie.recentlyadded.1' }), false);
  assert.equal(B.wideHub(null), false);
  const items = (n) => Array.from({ length: n }, (_, i) => ({ ratingKey: String(i) }));
  // a hub with "more": a full page means maybe another
  assert.equal(B.hubResult({ more: true, size: 20 }, 0, 40, items(40)).total, 41);
  assert.equal(B.hubResult({ more: true, size: 20 }, 40, 40, items(12)).total, 52);
  // a hub that knows its size
  assert.equal(B.hubResult({ more: false, size: 100 }, 0, 40, items(40)).total, 100);
  assert.equal(B.hubResult({}, 0, 40, []).total, 0);
  assert.equal(B.hubResult({}, 0, 40, null).items.length, 0);
});

test('touch browse: Surprise Me says where the pick came from', () => {
  assert.equal(B.surpriseLine({ total: 14, pool: 'unwatched' }, 'movie', ''), 'Surprise pick · From 14 unwatched movies');
  assert.equal(B.surpriseLine({ total: 1, pool: 'all' }, 'show', 'Comedy'), 'Surprise pick · From 1 show · Comedy');
  assert.equal(B.surpriseLine({ total: 1200, pool: 'rewatch' }, 'movie', ''), 'Surprise pick · You’ve seen all 1,200 movies, so here’s a rewatch');
  assert.equal(B.surpriseEpisode('next', 'S2 · E3', 'The Title', '24m'), 'Next up S2 · E3 · The Title · 24m');
  assert.equal(B.surpriseEpisode('start', 'S1 · E1', '', ''), 'Starts with S1 · E1');
  assert.equal(B.surpriseEpisode('resume', 'S1 · E4', 'Pilot', '10m left'), 'Resume S1 · E4 · Pilot · 10m left');
  assert.equal(B.surpriseEpisode('odd', 'S1 · E1', null, null), 'S1 · E1');
});
