// Tests for What's coming (plugins/whats-coming): date captions, grouping, the "New episodes this
// week" and "Films arriving soon" shelves (only shows in the library, cached answers), the missing
// episodes badge and "Search for missing episodes", against the fake helper with the demo library.
//   node --test test/whats-coming.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEnv, plexItem, model, show, movie, ids, tick } from './fixtures/helper-env.mjs';

const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

const TV = { key: '2', type: 'show', title: 'TV Shows' };
const MOVIES = { key: '1', type: 'movie', title: 'Movies' };
// Friday 30 October 2026, 15:00 local
const NOW = new Date(2026, 9, 30, 15, 0);
const at = (days, h, m = 0) => new Date(2026, 9, 30 + days, h, m).toISOString();

test('what\'s coming: episode times read as people say them', async () => {
  const env = await makeEnv({ noHelper: true });
  const w = (iso) => env.W.episodeWhen(iso, NOW);
  assert.equal(w(at(0, 21)), 'Tonight 21:00');
  assert.equal(w(at(0, 16, 30)), 'Today 16:30');
  assert.equal(w(at(1, 20, 5)), 'Tomorrow 20:05');
  assert.equal(w(at(4, 21)), 'Tuesday');
  assert.equal(w(at(9, 21)), '8 Nov');
  assert.equal(w(at(0, 9)), 'Aired today');
  assert.equal(w(at(-1, 22)), 'Aired yesterday');
  assert.equal(w(at(-2, 22)), 'Aired Wednesday');
  assert.equal(w('nonsense'), '');
});

test('what\'s coming: film release captions', async () => {
  const env = await makeEnv({ noHelper: true });
  const f = (releaseDate, releaseType, hasFile) => env.W.filmWhen({ releaseDate, releaseType, hasFile }, NOW);
  assert.equal(f('2026-11-06', 'digital'), 'Digital release 6 Nov');
  assert.equal(f('2026-11-03', 'digital'), 'Digital release Tuesday');
  assert.equal(f('2026-10-31', 'cinema'), 'In cinemas tomorrow');
  assert.equal(f('2026-10-30', 'physical'), 'Disc release today');
  assert.equal(f('2026-10-28', 'cinema'), 'In cinemas now');
  assert.equal(f('2026-10-29', 'digital'), 'Digital release yesterday');
  assert.equal(f('2026-10-29', 'digital', true), 'Ready to watch');
});

test('what\'s coming: a show\'s episodes on one day make one card', async () => {
  const env = await makeEnv({ noHelper: true });
  const ep = (tvdbId, season, episode, iso, extra = {}) => ({ mediaType: 'tv', source: 'sonarr', tvdbId, title: 'Show ' + tvdbId, season, episode, episodeTitle: 'E' + episode, airDateUtc: iso, ...extra });
  const groups = env.W.groupEpisodes([
    ep(1, 2, 1, at(-1, 21), { hasFile: true }), ep(1, 2, 2, at(-1, 21), { hasFile: true }), ep(1, 2, 3, at(-1, 22)),
    ep(2, 1, 1, at(0, 21), { seriesPremiere: true }),
    ep(1, 2, 4, at(6, 21)),
    { mediaType: 'movie', tmdbId: 5, releaseDate: '2026-11-01' },
  ], NOW);
  assert.equal(groups.length, 3);
  assert.equal(env.W.episodeLabel(groups[0].season, groups[0].episodes), 'S2 E1–E3');
  assert.equal(env.W.episodeTag(groups[0]), 'New');
  assert.equal(env.W.episodeTag(groups[1]), 'Premiere');
  assert.equal(env.W.episodeTag(groups[2]), '', 'not aired yet: no tag');
  assert.equal(env.W.episodeLabel(3, [5, 2]), 'S3 · 2 episodes');
});

test('what\'s coming: New episodes this week shows only shows in this library, with Plex art', async () => {
  const env = await makeEnv();
  const shelves = await env.PL.plugins.shelfRows(TV);
  const shelf = shelves.find((s) => s.id === 'whats-coming:episodes');
  assert.ok(shelf, 'shelf');
  assert.equal(shelf.title, 'New episodes this week');
  assert.equal(shelf.kind, 'wide');
  const titles = shelf.items.map((i) => i.title);
  assert.ok(!titles.includes('A Show Not In Plex'), 'shows outside the library are left out');
  same(titles, ['NASA ScienceCasts', 'NASA Explorers', 'Caminandes', 'NASA Explorers']);
  const sc = show('sciencecasts');
  const first = shelf.items[0];
  assert.equal(first.art, sc.art, 'the show\'s own art from Plex');
  assert.equal(first.tag, 'New');
  assert.match(first.year, /^S2 E2 · Aired /);
  assert.equal(shelf.items[1].tag, 'Premiere');
  assert.match(shelf.items[1].year, /^S6 E1 · /);
  assert.equal(first.type, 'coming', 'not a Plex item: core actions don\'t apply');
  assert.equal(new Set(shelf.items.map((i) => i.ratingKey)).size, shelf.items.length, 'unique keys');
  // no films on a TV library
  assert.ok(!shelves.some((s) => s.id === 'whats-coming:films'));

  // cached: a second Recommended visit asks nobody
  const before = { helper: env.helper.log.length, plex: env.plexCalls.length };
  await env.PL.plugins.shelfRows(TV);
  assert.equal(env.helper.log.filter((l) => l.path === '/coming').length, 1, '/coming once');
  assert.equal(env.helper.log.length, before.helper);
  assert.equal(env.plexCalls.length, before.plex, 'library matches are cached');
  await env.close();
});

test('what\'s coming: OK opens the episode once it has a file, else the show', async () => {
  const env = await makeEnv();
  const shelf = (await env.PL.plugins.shelfRows(TV)).find((s) => s.id === 'whats-coming:episodes');
  const sc = show('sciencecasts');
  shelf.onSelect(shelf.items[0]);
  await tick(10);
  let opened = env.pushed.pop();
  const lastSeason = sc._seasons[sc._seasons.length - 1];
  assert.equal(opened.kind, 'details');
  assert.equal(opened.item.ratingKey, lastSeason._episodes[lastSeason._episodes.length - 1].ratingKey, 'the aired episode');
  shelf.onSelect(shelf.items[1]);
  await tick(10);
  opened = env.pushed.pop();
  assert.equal(opened.item.ratingKey, show('nasa-explorers').ratingKey, 'not aired yet: the show');
  await env.close();
});

test('what\'s coming: Films arriving soon on movie libraries', async () => {
  const env = await makeEnv();
  const shelf = (await env.PL.plugins.shelfRows(MOVIES)).find((s) => s.id === 'whats-coming:films');
  assert.equal(shelf.title, 'Films arriving soon');
  same(shelf.items.map((i) => i.title), ['Wing It!', 'Paper Comets', 'The Clockmaker\'s Garden', 'Northern Lights Express']);
  assert.equal(shelf.items[0].year, 'Ready to watch');
  assert.equal(shelf.items[0].tag, 'New');
  assert.equal(shelf.items[1].year, 'In cinemas tomorrow');
  assert.match(shelf.items[2].year, /^Digital release /);
  assert.match(shelf.items[3].year, /^Disc release /);
  assert.equal(shelf.items[1].art, 'https://img.example.com/art/paper-comets.jpg', 'Radarr\'s fanart');
  // OK: in the library -> its page; not out yet -> a note
  shelf.onSelect(shelf.items[0]);
  await tick(10);
  assert.equal(env.pushed.pop().item.ratingKey, movie('wing-it').ratingKey);
  shelf.onSelect(shelf.items[2]);
  const note = env.pushed.pop();
  assert.equal(note.kind, 'sheet');
  assert.match(note.sections[0].heading, /^The Clockmaker's Garden \(2026\)$/);
  assert.match(note.sections[0].rows[0].label, /^Digital release \w+ \d+ [A-Z][a-z]{2}$/);
  assert.equal(note.sections[0].rows[0].sub, 'Radarr gets it then');
  await env.close();
});

test('what\'s coming: hidden without the helper, Sonarr or Radarr', async () => {
  const off = await makeEnv({ services: { sonarr: false } });
  assert.ok(!(await off.PL.plugins.shelfRows(TV)).some((s) => s.id === 'whats-coming:episodes'));
  assert.ok((await off.PL.plugins.shelfRows(MOVIES)).some((s) => s.id === 'whats-coming:films'), 'Radarr alone still has films');
  await off.close();
  const none = await makeEnv({ noHelper: true });
  same(await none.PL.plugins.shelfRows(TV), []);
  assert.equal(none.http.length, 0, 'no helper: no requests');
  const gone = await makeEnv();
  gone.H.setUrl('http://127.0.0.1:9');
  same(await gone.PL.plugins.shelfRows(TV), []);
  same(await gone.PL.plugins.badges(plexItem(show('nasa-explorers').ratingKey)), []);
  await gone.close();
});

test('what\'s coming: "3 episodes missing" on a show and its season, from one cached request', async () => {
  const env = await makeEnv();
  const nx = show('nasa-explorers');
  assert.deepEqual(JSON.parse(JSON.stringify(await env.PL.plugins.badges(plexItem(nx.ratingKey))))
    .filter((b) => /missing/.test(b.label)), [{ label: '3 episodes missing', tone: '' }]);
  const season = await env.PL.plugins.badges(plexItem(nx._seasons[0].ratingKey));
  assert.ok(season.some((b) => b.label === '3 episodes missing'));
  assert.equal(env.helper.log.filter((l) => l.path === '/missing').length, 1);
  // nothing missing: no badge; not in Sonarr (404): no badge
  const cam = await env.PL.plugins.badges(plexItem(show('caminandes').ratingKey));
  assert.ok(!cam.some((b) => /missing/.test(b.label)));
  const sc = await env.PL.plugins.badges(plexItem(show('sciencecasts').ratingKey));
  assert.ok(!sc.some((b) => /missing/.test(b.label)));
  // films and episodes never ask /missing
  await env.PL.plugins.badges(plexItem(movie('sintel').ratingKey));
  assert.equal(env.helper.log.filter((l) => l.path === '/missing').length, 3);
  await env.close();
});

test('what\'s coming: Search for missing episodes', async () => {
  const env = await makeEnv();
  const nx = plexItem(show('nasa-explorers').ratingKey);
  const label = 'Search for missing episodes';
  assert.ok(!env.PL.plugins.actions(nx).some((a) => a.label === label), 'unknown health: no action yet');
  await env.H.health();
  assert.ok(env.PL.plugins.actions(nx).some((a) => a.label === label), 'shown once Sonarr is known to be up');
  // the cached /missing says Caminandes has nothing missing: no action
  const cam = plexItem(show('caminandes').ratingKey);
  await env.PL.plugins.badges(cam);
  assert.ok(!env.PL.plugins.actions(cam).some((a) => a.label === label));
  assert.ok(!env.PL.plugins.actions(plexItem(movie('sintel').ratingKey)).some((a) => a.label === label), 'not on films');

  env.PL.plugins.actions(nx).find((a) => a.label === label).run();
  await tick(10);
  await new Promise((r) => setTimeout(r, 30));
  const post = env.helper.log.find((l) => l.path === '/missing/search');
  assert.equal(post.token, 'demo-owner-token');
  assert.deepEqual(env.http.find((h) => h.url.endsWith('/missing/search')).body, { tvdbId: Number(ids(show('nasa-explorers')).tvdb) });
  assert.equal(env.toasts.pop(), 'Searching for 3 missing episodes');
  assert.ok(env.toasts.includes('Asking Sonarr to search…'));

  // a season page searches that season only
  const season = plexItem(show('nasa-explorers')._seasons[0].ratingKey);
  env.PL.plugins.actions(season).find((a) => a.label === label).run();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(env.http.filter((h) => h.url.endsWith('/missing/search')).pop().body, { tvdbId: Number(ids(show('nasa-explorers')).tvdb), season: 5 });

  // the helper refuses the sign-in: said plainly
  env.PL.plex.token = 'someone-else';
  env.PL.plugins.actions(nx).find((a) => a.label === label).run();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(env.toasts.pop(), 'The helper didn\'t accept your Plex sign-in');
  await env.close();
});

test('what\'s coming: the demo library\'s ids line up with the fake helper', () => {
  assert.ok(model.shows.every((s) => ids(s).tvdb), 'every demo show has a tvdb id');
  assert.ok(model.movies.every((m) => ids(m).tmdb), 'every demo film has a tmdb id');
});

test('what\'s coming: dry run and nothing to search are said honestly', async () => {
  const env = await makeEnv();
  await env.H.health();
  const label = 'Search for missing episodes';
  env.helper.state.dryRun = true;
  const nx = plexItem(show('nasa-explorers').ratingKey);
  env.PL.plugins.actions(nx).find((a) => a.label === label).run();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(env.toasts.pop(), 'Dry run: the helper would search for 3 episodes');
  env.helper.state.dryRun = false;
  // Caminandes: nothing missing -> {queued: false, episodes: 0}
  env.PL.plugins.actions(plexItem(show('caminandes').ratingKey)).find((a) => a.label === label).run();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(env.toasts.pop(), 'Nothing missing to search for');
  await env.close();
});
