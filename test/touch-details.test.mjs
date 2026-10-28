// Tests for the phone and tablet title and person pages' decisions (PL.touchDetailsLogic at the top of
// web/touch/screens/details.js): the Play button, which round actions show, Watched's choices, the
// season to open, cast and crew, a person's library filter, extras and version labels, ratings.
//   node --test test/touch-details.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;

function logic() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  // the page part returns at once without PL.isWeb and a touch layer: only the logic runs
  vm.runInContext(readFileSync(join(ROOT, 'web/touch/screens/details.js'), 'utf8'), ctx, { filename: 'details.js' });
  return ctx.window.PL.touchDetailsLogic;
}
const D = logic();
const J = (v) => JSON.parse(JSON.stringify(v));

test('details: Play says Resume from the time, with the progress and what is left', () => {
  const film = { type: 'movie', viewOffset: 213000, duration: 888000 };
  const pb = D.playButton(film, 'movie');
  assert.equal(pb.label, 'Resume from 3:33');
  assert.equal(pb.resume, true);
  assert.equal(pb.left, '11m left');
  assert.ok(Math.abs(pb.frac - 0.24) < 0.01);
  assert.deepEqual(J(D.playButton({ type: 'movie', duration: 888000 }, 'movie')), { label: 'Play', resume: false, frac: 0, left: '' });
  assert.equal(D.playButton({ viewOffset: 3725000, duration: 7200000 }, 'movie').label, 'Resume from 1:02:05');
  assert.equal(D.playButton(null, 'movie'), null);
});

test('details: a show or season page names the episode Play starts', () => {
  assert.equal(D.playButton({ parentIndex: 2, index: 3, viewOffset: 60000, duration: 1200000 }, 'show').label, 'Resume S2 · E3');
  assert.equal(D.playButton({ parentIndex: 1, index: 1 }, 'show').label, 'Play S1 · E1');
  assert.equal(D.playButton({ parentIndex: 0, index: 4 }, 'season').label, 'Play Special 4');
  assert.equal(D.playButton({ title: 'x' }, 'show').label, 'Play');
});

test('details: a season plays the episode in progress, else the first unwatched, else the first', () => {
  const eps = [{ index: 1, viewCount: 1 }, { index: 2 }, { index: 3, viewOffset: 5000 }];
  assert.equal(D.nextInSeason(eps).index, 3);
  assert.equal(D.nextInSeason(eps.slice(0, 2)).index, 2);
  assert.equal(D.nextInSeason([{ index: 1, viewCount: 1 }, { index: 2, viewCount: 2 }]).index, 1);
  assert.equal(D.nextInSeason([]), null);
  assert.equal(D.nextInSeason(null), null);
});

test('details: the season to open: the one asked for, else On Deck\'s, else the first', () => {
  const seasons = [{ ratingKey: '10' }, { ratingKey: '20' }, { ratingKey: 30 }];
  assert.equal(D.seasonIndex(seasons, '20', null), 1);
  assert.equal(D.seasonIndex(seasons, '30', { parentRatingKey: '20' }), 2);
  assert.equal(D.seasonIndex(seasons, null, { parentRatingKey: '20' }), 1);
  assert.equal(D.seasonIndex(seasons, null, null), 0);
  assert.equal(D.seasonIndex(seasons, '99', null), 0);
});

test('details: the trailer is the primary extra, else the first trailer; films and shows only', () => {
  const extras = [{ key: 'a', subtype: 'featurette' }, { key: 'b', subtype: 'trailer' }, { key: 'c', subtype: 'trailer' }];
  assert.equal(D.trailer({ type: 'movie', primaryExtraKey: 'c' }, extras).key, 'c');
  assert.equal(D.trailer({ type: 'show' }, extras).key, 'b');
  assert.equal(D.trailer({ type: 'episode' }, extras), null);
  assert.equal(D.trailer({ type: 'movie' }, [{ key: 'a', subtype: 'interview' }]), null);
});

test('details: round actions are the ones that apply, in P2\'s order', () => {
  const half = { viewOffset: 1 };
  assert.deepEqual(J(D.actions({ type: 'movie', target: half, trailer: {}, tracks: true })), ['restart', 'trailer', 'watched', 'tracks']);
  assert.deepEqual(J(D.actions({ type: 'movie', target: {}, trailer: null, tracks: false })), ['watched']);
  assert.deepEqual(J(D.actions({ type: 'show', target: half, trailer: null, tracks: true })), ['restart', 'shuffle', 'watched']);
  assert.deepEqual(J(D.actions({ type: 'season', target: {}, tracks: true })), ['watched']);
  assert.deepEqual(J(D.actions({ type: 'episode', target: {}, tracks: true })), ['watched', 'tracks']);
});

test('details: Audio & subs shows with tracks or several versions', () => {
  const part = (streams) => ({ Media: [{ Part: [{ id: 1, Stream: streams }] }] });
  assert.equal(D.hasTracks(part([{ streamType: 1 }, { streamType: 2 }])), true);
  assert.equal(D.hasTracks(part([{ streamType: 1 }, { streamType: 3 }])), true);
  assert.equal(D.hasTracks(part([{ streamType: 1 }])), false);
  assert.equal(D.hasTracks({ Media: [{}, {}] }), true);
  assert.equal(D.hasTracks({}), false);
});

test('details: Watched is one choice when that is the only sensible one, else several', () => {
  const ids = (s, season) => J(D.watchedChoices(s, season)).map((c) => c.id + ':' + c.on);
  assert.deepEqual(ids({ type: 'movie' }), ['watched:true']);
  assert.deepEqual(ids({ type: 'movie', viewCount: 1 }), ['unwatched:false']);
  assert.deepEqual(ids({ type: 'movie', viewOffset: 9 }), ['watched:true', 'unwatched:false']);
  assert.deepEqual(ids({ type: 'season', leafCount: 4, viewedLeafCount: 4 }), ['unwatched:false']);
  const show = { type: 'show', leafCount: 6, viewedLeafCount: 2 };
  const choices = D.watchedChoices(show, { title: 'Season 2', leafCount: 2, viewedLeafCount: 0 });
  assert.deepEqual(J(choices).map((c) => c.label), ['Mark show watched', 'Mark show unwatched', 'Mark Season 2 watched']);
  assert.equal(D.watchedChoices(show, { title: 'Season 1', leafCount: 2, viewedLeafCount: 2 })[2].label, 'Mark Season 1 unwatched');
});

test('details: cast first, then directors and up to three writers, as person tags', () => {
  const full = {
    Role: [{ id: 1, tag: 'A', role: 'Hero', thumb: '/t' }, { id: 2, tag: 'B' }, { tag: 'no id' }],
    Director: [{ id: 3, tag: 'C' }],
    Writer: [{ id: 4, tag: 'W1' }, { id: 5, tag: 'W2' }, { id: 6, tag: 'W3' }, { id: 7, tag: 'W4' }],
  };
  const p = J(D.people(full));
  assert.deepEqual(p.map((x) => x.tag), ['A', 'B', 'C', 'W1', 'W2', 'W3']);
  assert.deepEqual(p[0], { id: 1, tag: 'A', role: 'Hero', thumb: '/t', filter: 'actor' });
  assert.equal(p[2].role, 'Director');
  assert.equal(p[2].filter, 'director');
  assert.equal(p[3].filter, 'writer');
  assert.deepEqual(J(D.people({})), []);
});

test('person: the library filter and id come from the tag, else from the role', () => {
  assert.equal(D.personFilter({ filter: 'director=12' }), 'director');
  assert.equal(D.personFilter({ filter: 'writer' }), 'writer');
  assert.equal(D.personFilter({ role: 'Director' }), 'director');
  assert.equal(D.personFilter({ role: 'Writer' }), 'writer');
  assert.equal(D.personFilter({ role: 'Sintel' }), 'actor');
  assert.equal(D.personFilter({}), 'actor');
  assert.equal(D.personId({ id: 35 }), 35);
  assert.equal(D.personId({ filter: 'actor=77' }), 77);
  assert.equal(D.personId({ tag: 'x' }), null);
});

test('person: the summary counts titles per kind of library', () => {
  const r = (type, n) => ({ section: { type }, items: new Array(n).fill({}) });
  assert.equal(D.personSummary([r('movie', 15), r('show', 1), r('show', 0)]), '15 movies · 1 show');
  assert.equal(D.personSummary([r('movie', 1), r('show', 3)]), '1 movie · 3 shows');
  assert.equal(D.personSummary([]), '');
});

test('details: extras, versions, ratings and episode rows read as on the TV', () => {
  assert.equal(D.extraLabel({ subtype: 'trailer', duration: 52200 }), 'Trailer · 1m');
  assert.equal(D.extraLabel({ subtype: 'odd' }), 'Extra');
  assert.equal(D.versionLabel({ videoResolution: '1080', videoCodec: 'hevc', bitrate: 4200, Part: [{ size: 1073741824 * 2.5 }] }), '1080p · HEVC · 2.5 GB · 4.2 Mbps');
  assert.equal(D.versionLabel({ videoResolution: '4k' }), '4K');
  assert.equal(D.versionLabel({}), 'Version');
  assert.deepEqual(J(D.ratings({ Rating: [
    { image: 'imdb://image.rating', value: 7.46 }, { image: 'rottentomatoes://image.rating.ripe', value: 9.1, type: 'critic' },
    { image: 'rottentomatoes://image.rating.upright', value: 8, type: 'audience' }, { image: 'themoviedb://image.rating', value: 7.2 },
    { image: 'other://x', value: 5 }, { image: 'imdb://image.rating', value: 0 },
  ] })), ['IMDb 7.5', 'RT 91%', 'RT Audience 80%', 'TMDb 72%']);
  assert.equal(D.episodeTitle({ index: 3, title: 'Pilot' }), '3. Pilot');
  assert.equal(D.episodeTitle({ title: 'Pilot' }), 'Pilot');
  assert.equal(D.episodeSub({ duration: 1500000 }), '25m');
  assert.equal(D.episodeSub({ duration: 1500000, viewOffset: 840000 }), '11m left');
  assert.equal(D.episodeSub({}), '');
});
