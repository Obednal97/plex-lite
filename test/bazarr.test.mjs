// Tests for Subtitles (plugins/bazarr): the "Subtitles…" action and its sheet, Find / Fix timing
// through the helper (token, bodies, messages), the "No English subtitles" badge from one cached
// request, and hiding when Bazarr isn't available. Fake helper + demo library.
//   node --test test/bazarr.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEnv, plexItem, show, movie, ids } from './fixtures/helper-env.mjs';

const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = 'Subtitles…';

async function ready(opts) {
  const env = await makeEnv(opts);
  await env.H.health();
  return env;
}

test('subtitles: the action is on films and episodes while Bazarr is up', async () => {
  const env = await makeEnv();
  const sintel = plexItem(movie('sintel').ratingKey);
  assert.ok(!env.PL.plugins.actions(sintel).some((a) => a.label === LABEL), 'unknown health: not yet');
  await env.H.health();
  assert.ok(env.PL.plugins.actions(sintel).some((a) => a.label === LABEL));
  const ep = plexItem(show('caminandes')._seasons[0]._episodes[0].ratingKey);
  assert.ok(env.PL.plugins.actions(ep).some((a) => a.label === LABEL));
  assert.ok(!env.PL.plugins.actions(plexItem(show('caminandes').ratingKey)).some((a) => a.label === LABEL), 'not on shows');
  await env.close();
  const off = await ready({ services: { bazarr: false } });
  assert.ok(!off.PL.plugins.actions(sintel).some((a) => a.label === LABEL), 'Bazarr not set up: hidden');
  same(await off.PL.plugins.badges(sintel), []);
  await off.close();
});

test('subtitles: the sheet lists what the title has, what is missing and Fix timing', async () => {
  const env = await ready();
  env.PL.plugins.actions(plexItem(movie('sintel').ratingKey)).find((a) => a.label === LABEL).run();
  await wait(40);
  assert.equal(env.toasts[0], 'Checking subtitles…');
  const sheet = env.sheets().pop();
  same(sheet.sections.map((s) => s.heading), ['Subtitles · Sintel', 'Missing', 'Out of sync?']);
  same(sheet.sections[0].rows.map((r) => [r.label, r.sub]), [['English', 'Subtitle file']]);
  same(sheet.sections[1].rows.map((r) => r.label), ['Find Spanish subtitles']);
  same(sheet.sections[2].rows.map((r) => [r.label, r.sub]), [['Fix subtitle timing', 'English']]);
  const q = env.helper.log.find((l) => l.path === '/subtitles');
  same(q.query, { type: 'movie', tmdbId: ids(movie('sintel')).tmdb });
  await env.close();
});

test('subtitles: an episode is named by its show\'s TVDB id, season and episode', async () => {
  const env = await ready();
  const cam = show('caminandes');
  env.PL.plugins.actions(plexItem(cam._seasons[0]._episodes[1].ratingKey)).find((a) => a.label === LABEL).run();
  await wait(40);
  same(env.helper.log.find((l) => l.path === '/subtitles').query, { type: 'episode', tvdbId: ids(cam).tvdb, season: '1', episode: '2' });
  const sheet = env.sheets().pop();
  assert.equal(sheet.sections[0].heading, 'Subtitles · Caminandes · S1 E2');
  same(sheet.sections[0].rows.map((r) => [r.label, r.sub]), [['English', 'Subtitle file'], ['Spanish', 'In the video file']]);
  assert.equal(sheet.sections.length, 2, 'nothing missing: no Missing section');
  await env.close();
});

test('subtitles: Find English subtitles downloads, Find Spanish finds none', async () => {
  const env = await ready();
  const nos = plexItem(movie('nosferatu').ratingKey);
  env.PL.plugins.actions(nos).find((a) => a.label === LABEL).run();
  await wait(40);
  const sheet = env.sheets().pop();
  assert.equal(sheet.sections[0].rows[0].label, 'No subtitles yet');
  const [en, es] = sheet.sections[1].rows;
  assert.equal(en.label, 'Find English subtitles');
  en.action();
  assert.equal(env.toasts[env.toasts.length - 1], 'Finding English subtitles…');
  assert.ok(env.toastNode.children.some((c) => c.cls === 'hh-spin'), 'with a spinner');
  await wait(60);
  assert.equal(env.toasts.pop(), 'Found English subtitles · they\'re in Plex now', 'the helper refreshed Plex');
  const post = env.helper.log.find((l) => l.path === '/subtitles/search');
  assert.equal(post.token, 'demo-owner-token');
  same(env.http.find((h) => h.url.endsWith('/subtitles/search')).body,
    { type: 'movie', tmdbId: Number(ids(movie('nosferatu')).tmdb), ratingKey: movie('nosferatu').ratingKey, language: 'en', forced: false, hi: false });
  es.action();
  await wait(60);
  assert.equal(env.toasts.pop(), 'Bazarr couldn\'t find any');
  // the cached answer was dropped: the sheet now shows the new English file
  env.PL.plugins.actions(nos).find((a) => a.label === LABEL).run();
  await wait(40);
  same(env.sheets().pop().sections[0].rows.map((r) => r.label), ['English']);
  await env.close();
});

test('subtitles: Fix subtitle timing', async () => {
  const env = await ready();
  const cam = show('caminandes');
  const ep = plexItem(cam._seasons[0]._episodes[0].ratingKey);
  env.PL.plugins.actions(ep).find((a) => a.label === LABEL).run();
  await wait(40);
  const fix = env.sheets().pop().sections.find((s) => s.heading === 'Out of sync?').rows[0];
  fix.action();
  await wait(40);
  assert.equal(env.toasts.pop(), 'Re-timing English subtitles · takes a minute or two');
  same(env.http.find((h) => h.url.endsWith('/subtitles/sync')).body,
    { type: 'episode', tvdbId: Number(ids(cam).tvdb), season: 1, episode: 1, ratingKey: cam._seasons[0]._episodes[0].ratingKey, language: 'en', forced: false, hi: false });
  env.PL.plex.token = 'not-plex';
  fix.action();
  await wait(40);
  assert.equal(env.toasts.pop(), 'The helper didn\'t accept your Plex sign-in');
  await env.close();
});

test('subtitles: "No English subtitles" badge from one cached request', async () => {
  const env = await makeEnv();
  const nos = plexItem(movie('nosferatu').ratingKey);
  const labels = async (it) => JSON.parse(JSON.stringify(await env.PL.plugins.badges(it))).map((b) => b.label);
  assert.ok((await labels(nos)).includes('No English subtitles'));
  await labels(nos);
  assert.equal(env.helper.log.filter((l) => l.path === '/subtitles').length, 1, 'cached');
  // Sintel misses Spanish (not English): the badge names the first missing language
  assert.ok((await labels(plexItem(movie('sintel').ratingKey))).includes('No Spanish subtitles'));
  // nothing missing: no badge
  assert.ok(!(await labels(plexItem(show('caminandes')._seasons[0]._episodes[0].ratingKey))).some((l) => /subtitles/.test(l)));
  // forced-only gaps don't warn
  assert.equal(env.B.badgeLanguage({ missing: [{ code: 'en', name: 'English', forced: true }] }), null);
  await env.close();
});

test('subtitles: a title Bazarr doesn\'t know says so', async () => {
  const env = await ready({ data: { coming: [], missing: {}, subtitles: {} } });
  env.PL.plugins.actions(plexItem(movie('sintel').ratingKey)).find((a) => a.label === LABEL).run();
  await wait(40);
  assert.equal(env.toasts.pop(), 'Bazarr doesn\'t know this title');
  assert.equal(env.sheets().length, 0);
  await env.close();
});

test('subtitles: dry run, no Plex refresh, and nothing to re-time', async () => {
  const env = await ready({ plexRefreshed: false });
  env.PL.plugins.actions(plexItem(movie('the-general').ratingKey)).find((a) => a.label === LABEL).run();
  await wait(40);
  const sheet = env.sheets().pop();
  const find = sheet.sections.find((s) => s.heading === 'Missing').rows[0];
  find.action();
  await wait(60);
  assert.equal(env.toasts.pop(), 'Found English subtitles · restart playback to see them', 'Plex not refreshed');
  assert.ok(!sheet.sections.some((s) => s.heading === 'Out of sync?'), 'no subtitle file: no Fix timing');
  env.helper.state.dryRun = true;
  sheet.sections.find((s) => s.heading === 'Missing').rows[1].action();
  await wait(60);
  assert.equal(env.toasts.pop(), 'Dry run: the helper would look for Spanish subtitles');
  // re-timing a language with no file: the helper's 404, said plainly
  const ids2 = await env.H.titleIds(env.def('bazarr').ctx, plexItem(movie('sintel').ratingKey));
  env.helper.state.dryRun = false;
  await env.B.sync(env.def('bazarr').ctx, ids2, { code: 'es', name: 'Spanish' });
  assert.equal(env.toasts.pop(), 'There\'s no Spanish subtitle file to re-time');
  env.helper.state.dryRun = true;
  await env.B.sync(env.def('bazarr').ctx, ids2, { code: 'en', name: 'English' });
  assert.equal(env.toasts.pop(), 'Dry run: the helper would re-time English subtitles');
  await env.close();
});
