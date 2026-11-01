// Plex Lite home helper: the read endpoints and the actions, against fake services.
//   node --test test/helper-api.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvFile, readConfig } from '../helper/lib/config.mjs';
import { GOOD_TOKEN, startWorld } from './helper-fakes.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86400000;
const at = (t, days) => new Date(t.clock.now() + days * DAY).toISOString();

test('helper config: dry run is the default; the env file loader keeps what is already set', () => {
  assert.equal(readConfig({}).dryRun, true);
  assert.equal(readConfig({ DRY_RUN: '0' }).dryRun, false);
  assert.equal(readConfig({}).otherAction, 'manual');
  assert.equal(readConfig({}).backfillDays, 0, 'a backfill is a deliberate one-off');
  assert.equal(readConfig({ SONARR_URL: 'http://sonarr.example.com/' }).sonarr, null, 'a URL without a key is not configured');
  const dir = mkdtempSync(join(tmpdir(), 'plexlite-helper-env-'));
  const file = join(dir, 'helper.env');
  writeFileSync(file, '# comment\nSONARR_URL=http://sonarr.example.com:8989/\nSONARR_API_KEY="abc"\nDRY_RUN=1 # first run\n');
  const env = loadEnvFile(file, { DRY_RUN: '0' });
  assert.equal(env.SONARR_API_KEY, 'abc');
  assert.equal(env.DRY_RUN, '0');
  assert.deepEqual(readConfig(env).sonarr, { url: 'http://sonarr.example.com:8989', key: 'abc' });
});

test('helper: /healthz, CORS on every answer, preflight, unknown paths', async () => {
  const t = await startWorld({ skip: ['bazarr'], env: { DRY_RUN: '1' } });
  try {
    const h = await t.call('GET', '/healthz');
    assert.equal(h.status, 200);
    assert.equal(h.headers['access-control-allow-origin'], '*');
    assert.deepEqual(h.data, { ok: true, version: '1.0.0', dryRun: true, paused: false, services: { seerr: true, sonarr: true, radarr: true, bazarr: false, plex: true } });
    const pre = await t.call('OPTIONS', '/subtitles/search', { headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-plex-token' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
    assert.equal(pre.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
    assert.equal(pre.headers['access-control-allow-headers'], 'Content-Type, X-Plex-Token');
    const nf = await t.call('GET', '/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.data.error, 'not_found');
    assert.equal(nf.headers['access-control-allow-origin'], '*');
    assert.equal((await t.call('GET', '/subtitles?type=movie&tmdbId=1')).data.error, 'unavailable');
  } finally { await t.close(); }
});

test('helper: /queue maps Radarr and Sonarr queue records without secrets', async () => {
  const t = await startWorld();
  try {
    t.w.radarr.queue.push({
      id: 11, movieId: 7, title: 'Example.Film.2020.1080p.WEB-GRP', status: 'Downloading', trackedDownloadState: 'downloading',
      size: 2000, sizeleft: 500, timeleft: '00:01:05', estimatedCompletionTime: '2026-10-31T12:01:05Z', protocol: 'torrent',
      downloadId: 'SECRET-HASH', outputPath: '/downloads/x', indexer: 'Some Indexer', downloadClient: 'qBittorrent',
      quality: { quality: { name: 'WEBDL-1080p' } },
      movie: { title: 'Example Film', year: 2020, tmdbId: 1001, imdbId: 'tt1', images: [{ coverType: 'poster', url: '/MediaCover/7/poster.jpg', remoteUrl: 'https://image.example.com/p.jpg' }] },
    });
    t.w.sonarr.queue.push({
      id: 12, seriesId: 300, episodeId: 3001, seasonNumber: 1, title: 'Example.Show.S01E06.1080p', status: 'queued',
      size: 1000, sizeleft: 1000, timeleft: '1.02:00:00',
      series: { title: 'Example Show', year: 2015, tvdbId: 9300, tmdbId: 7300, images: [{ coverType: 'fanart', remoteUrl: 'https://image.example.com/f.jpg' }] },
      episode: { seasonNumber: 1, episodeNumber: 6, title: 'Six' },
    });
    const r = await t.call('GET', '/queue');
    assert.equal(r.status, 200);
    assert.equal(r.data.version, 1);
    assert.ok(r.data.updatedAt);
    const [film, ep] = r.data.items;
    assert.deepEqual(film, {
      source: 'radarr', id: 'radarr-11', mediaType: 'movie', tmdbId: 1001, tvdbId: 0, imdbId: 'tt1', title: 'Example Film', year: 2020,
      season: null, episode: null, episodeTitle: null, releaseTitle: 'Example.Film.2020.1080p.WEB-GRP', status: 'downloading',
      trackedState: 'downloading', size: 2000, sizeLeft: 500, timeLeftSeconds: 65, eta: '2026-10-31T12:01:05Z', quality: 'WEBDL-1080p',
      protocol: 'torrent', posterUrl: 'https://image.example.com/p.jpg', fanartUrl: null, errorMessage: null,
    });
    assert.equal(ep.id, 'sonarr-12');
    assert.equal(ep.mediaType, 'tv');
    assert.equal(ep.tvdbId, 9300);
    assert.equal(ep.tmdbId, 7300);
    assert.equal(ep.season, 1);
    assert.equal(ep.episode, 6);
    assert.equal(ep.timeLeftSeconds, 26 * 3600);
    assert.equal(ep.fanartUrl, 'https://image.example.com/f.jpg');
    const text = JSON.stringify(r.data);
    for (const secret of ['SECRET-HASH', '/downloads', 'Some Indexer', 'qBittorrent', 'MediaCover']) assert.ok(!text.includes(secret), secret);
    // cached for 5 s
    const calls = t.servers.radarr.calls.length;
    await t.call('GET', '/queue');
    assert.equal(t.servers.radarr.calls.length, calls);
  } finally { await t.close(); }
});

test('helper: /coming covers 2 days back to `days` ahead, monitored only, with Radarr\'s best date', async () => {
  const t = await startWorld();
  try {
    const series = { title: 'Example Show', tvdbId: 9300, tmdbId: 7300, year: 2015, monitored: true, images: [{ coverType: 'poster', remoteUrl: 'https://image.example.com/s.jpg' }] };
    t.w.sonarr.calendar.push(
      { seasonNumber: 2, episodeNumber: 1, title: 'Back', airDateUtc: at(t, 1), monitored: true, hasFile: false, series },
      { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDateUtc: at(t, -1), monitored: true, hasFile: true, series: { ...series, title: 'New Show', tvdbId: 9400 } },
      { seasonNumber: 2, episodeNumber: 2, title: 'Unmonitored', airDateUtc: at(t, 2), monitored: false, series },
      { seasonNumber: 2, episodeNumber: 3, title: 'Too far', airDateUtc: at(t, 9), monitored: true, series },
      { seasonNumber: 2, episodeNumber: 4, title: 'Too old', airDateUtc: at(t, -3), monitored: true, series },
    );
    t.w.radarr.calendar.push(
      { title: 'Digital Film', tmdbId: 1, year: 2026, monitored: true, inCinemas: at(t, -60), digitalRelease: at(t, 3), physicalRelease: at(t, 40), hasFile: false, images: [] },
      { title: 'Cinema Only', tmdbId: 2, year: 2026, monitored: true, inCinemas: at(t, 2), hasFile: false, images: [] },
      { title: 'In Cinemas, Digital Later', tmdbId: 3, monitored: true, inCinemas: at(t, 1), digitalRelease: at(t, 60) },
      { title: 'Physical', tmdbId: 4, monitored: true, inCinemas: at(t, -90), physicalRelease: at(t, 4) },
      { title: 'Unmonitored Film', tmdbId: 5, monitored: false, digitalRelease: at(t, 1) },
    );
    const r = await t.call('GET', '/coming?days=7');
    assert.equal(r.status, 200);
    const sonarrCall = t.servers.sonarr.calls.find((c) => c.path === '/api/v3/calendar');
    assert.ok(Math.abs(Date.parse(sonarrCall.query.get('start')) - Date.parse(at(t, -2))) < 5000, 'from 2 days back');
    assert.equal(sonarrCall.query.get('unmonitored'), 'false');
    assert.equal(sonarrCall.query.get('includeSeries'), 'true');
    assert.deepEqual(r.data.items.map((i) => i.title + (i.episodeTitle ? `/${i.episodeTitle}` : '')), [
      'New Show/Pilot', 'Example Show/Back', 'Cinema Only', 'Digital Film', 'Physical',
    ]);
    const pilot = r.data.items[0];
    assert.equal(pilot.seriesPremiere, true);
    assert.equal(pilot.seasonPremiere, true);
    assert.equal(pilot.hasFile, true);
    assert.equal(r.data.items[1].seasonPremiere, true);
    assert.equal(r.data.items[1].seriesPremiere, false);
    assert.equal(r.data.items[1].posterUrl, 'https://image.example.com/s.jpg');
    const digital = r.data.items.find((i) => i.title === 'Digital Film');
    assert.equal(digital.releaseType, 'digital');
    assert.equal(digital.mediaType, 'movie');
    assert.equal(r.data.items.find((i) => i.title === 'Cinema Only').releaseType, 'cinema');
    assert.equal(r.data.items.find((i) => i.title === 'Physical').releaseType, 'physical');
    assert.equal((await t.call('GET', '/coming?days=1')).data.items.length, 2, 'yesterday + tomorrow');
    assert.equal((await t.call('GET', '/coming?days=abc')).status, 400);
    const far = await t.call('GET', '/coming?days=99');
    const call = t.servers.radarr.calls.filter((c) => c.path === '/api/v3/calendar').pop();
    assert.equal(far.status, 200);
    assert.ok(Math.abs(Date.parse(call.query.get('end')) - Date.parse(at(t, 30))) < 5000, 'capped at 30 days');
  } finally { await t.close(); }
});

function missingShow(t) {
  t.w.addSeries({
    id: 300, title: 'Example Show', tvdbId: 9300, unmonitoredSeasons: [0],
    seasons: {
      0: [{ episode: 1 }],
      1: [{ episode: 1, file: 'a.mkv' }, { episode: 2 }, { episode: 3, monitored: false }],
      2: [{ episode: 1 }, { episode: 2 }, { episode: 3, aired: false }],
      3: [{ episode: 1, aired: false }],
    },
  });
}

test('helper: /missing lists aired, monitored episodes without a file, per season', async () => {
  const t = await startWorld();
  try {
    missingShow(t);
    const r = await t.call('GET', '/missing?tvdbId=9300');
    assert.equal(r.status, 200);
    assert.equal(r.data.monitored, true);
    assert.deepEqual(r.data.seasons.map((s) => [s.season, s.monitored, s.episodes, s.have, s.missing.map((e) => e.episode)]), [
      [1, true, 3, 1, [2]],
      [2, true, 2, 0, [1, 2]],
    ]);
    assert.ok(r.data.seasons[1].missing[0].airDateUtc);
    assert.equal((await t.call('GET', '/missing?tvdbId=1')).status, 404);
    assert.equal((await t.call('GET', '/missing?tvdbId=1')).data.error, 'not_found');
    assert.equal((await t.call('GET', '/missing')).status, 400);
  } finally { await t.close(); }
});

test('helper: /missing/search needs a Plex token the server accepts, then searches', async () => {
  const t = await startWorld();
  try {
    missingShow(t);
    assert.equal((await t.call('POST', '/missing/search', { body: { tvdbId: 9300 } })).status, 401);
    const bad = await t.call('POST', '/missing/search', { body: { tvdbId: 9300 }, token: 'stolen' });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, 'unauthenticated');
    const r = await t.call('POST', '/missing/search', { body: { tvdbId: 9300 }, token: GOOD_TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { queued: true, episodes: 3 });
    const e12 = t.w.episode(300, 1, 2).id;
    assert.deepEqual(t.w.sonarr.commands, [
      { name: 'SeasonSearch', seriesId: 300, seasonNumber: 2 }, // every aired episode of S2 is missing
      { name: 'EpisodeSearch', episodeIds: [e12] },
    ]);
    // one episode; and nothing to do
    t.w.sonarr.commands.length = 0;
    assert.deepEqual((await t.call('POST', '/missing/search', { body: { tvdbId: 9300, season: 2, episode: 1 }, token: GOOD_TOKEN })).data, { queued: true, episodes: 1 });
    assert.deepEqual(t.w.sonarr.commands, [{ name: 'EpisodeSearch', episodeIds: [t.w.episode(300, 2, 1).id] }]);
    assert.deepEqual((await t.call('POST', '/missing/search', { body: { tvdbId: 9300, season: 3 }, token: GOOD_TOKEN })).data, { queued: false, episodes: 0 });
    // an episode already downloading isn't searched again
    t.w.sonarr.commands.length = 0;
    t.w.sonarr.queue.push({ id: 1, seriesId: 300, episodeId: e12 });
    assert.deepEqual((await t.call('POST', '/missing/search', { body: { tvdbId: 9300, season: 1 }, token: GOOD_TOKEN })).data, { queued: false, episodes: 0 });
    // the token is checked once and then cached
    const plexChecks = t.servers.plex.calls.filter((c) => c.path === '/library/sections' && c.headers['x-plex-token'] === GOOD_TOKEN).length;
    assert.equal(plexChecks, 1);
    assert.equal((await t.call('POST', '/missing/search', { body: 'not json', token: GOOD_TOKEN })).status, 400);
  } finally { await t.close(); }
});

test('helper: actions are rate limited per token; dry run searches nothing', async () => {
  const t = await startWorld({ env: { ACTIONS_PER_10_MIN: '2', DRY_RUN: '1' } });
  try {
    missingShow(t);
    const first = await t.call('POST', '/missing/search', { body: { tvdbId: 9300 }, token: GOOD_TOKEN });
    assert.deepEqual(first.data, { queued: false, dryRun: true, episodes: 3 });
    assert.deepEqual(t.w.sonarr.commands, []);
    assert.equal((await t.call('GET', '/healthz')).data.dryRun, true);
    await t.call('POST', '/missing/search', { body: { tvdbId: 9300 }, token: GOOD_TOKEN });
    const third = await t.call('POST', '/missing/search', { body: { tvdbId: 9300 }, token: GOOD_TOKEN });
    assert.equal(third.status, 429);
    assert.equal(third.data.error, 'rate_limited');
    t.clock.advance(11 * 60000);
    assert.equal((await t.call('POST', '/missing/search', { body: { tvdbId: 9300 }, token: GOOD_TOKEN })).status, 200);
  } finally { await t.close(); }
});

test('helper: actions without PLEX_URL are unavailable', async () => {
  const t = await startWorld({ skip: ['plex'] });
  try {
    const r = await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001 }, token: GOOD_TOKEN });
    assert.equal(r.status, 503);
    assert.equal(r.data.error, 'unavailable');
  } finally { await t.close(); }
});

// ---- Bazarr -------------------------------------------------------------------------------------

function bazarrWorld(t) {
  t.w.addSeries({ id: 300, title: 'Example Show', tvdbId: 9300, seasons: { 1: [{ episode: 6, file: 'e6.mkv' }] } });
  t.w.addMovie({ id: 7, title: 'Example Film', tmdbId: 1001 });
  const e6 = t.w.episode(300, 1, 6).id;
  t.w.addBazarrProfile(2, [{ language: 'en' }, { language: 'fr', forced: true }]);
  t.w.bazarr.series.push({ sonarrSeriesId: 300, profileId: 2 });
  t.w.bazarr.episodes.push({
    sonarrSeriesId: 300, sonarrEpisodeId: e6,
    subtitles: [{ code2: 'en', name: 'English', forced: false, hi: false, path: '/data/tv/Example Show/Season 1/e6.en.srt' }, { code2: 'fr', name: 'French', forced: false, hi: false, path: null }],
    missing_subtitles: [{ code2: 'fr', name: 'French', forced: true, hi: false }],
  });
  t.w.bazarr.movies.push({ radarrId: 7, profileId: 2, subtitles: [], missing_subtitles: [{ code2: 'en', name: 'English', forced: false, hi: false }] });
  t.w.addPlexMovie(501, 1001);
  t.w.addPlexShow(800, 9300, [[806, 1, 6]]);
  return e6;
}

test('helper: GET /subtitles gives the profile languages, what the file has and lacks', async () => {
  const t = await startWorld();
  try {
    bazarrWorld(t);
    const r = await t.call('GET', '/subtitles?type=episode&tvdbId=9300&season=1&episode=6');
    assert.equal(r.status, 200);
    assert.deepEqual({ languages: r.data.languages, have: r.data.have, missing: r.data.missing }, {
      languages: [{ code: 'en', name: 'English', forced: false, hi: false }, { code: 'fr', name: 'French', forced: true, hi: false }],
      have: [{ code: 'en', name: 'English', forced: false, hi: false, external: true }, { code: 'fr', name: 'French', forced: false, hi: false, external: false }],
      missing: [{ code: 'fr', name: 'French', forced: true, hi: false }],
    });
    assert.equal(r.data.version, 1);
    const film = await t.call('GET', '/subtitles?type=movie&tmdbId=1001');
    assert.deepEqual(film.data.missing, [{ code: 'en', name: 'English', forced: false, hi: false }]);
    assert.equal((await t.call('GET', '/subtitles?type=movie&tmdbId=42')).status, 404);
    assert.equal((await t.call('GET', '/subtitles?type=episode&tvdbId=9300&season=1&episode=9')).status, 404);
    assert.equal((await t.call('GET', '/subtitles?type=film')).status, 400);
  } finally { await t.close(); }
});

test('helper: POST /subtitles/search waits for Bazarr\'s job, then refreshes the item in Plex', async () => {
  const t = await startWorld();
  try {
    bazarrWorld(t);
    const r = await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001, language: 'en' }, token: GOOD_TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { status: 'downloaded', language: 'en', provider: 'opensubtitlescom', plexRefreshed: true });
    assert.deepEqual(t.w.bazarr.patches.map((p) => [p.kind, p.radarrid, p.language, p.forced, p.hi]), [['movie', '7', 'en', 'False', 'False']]);
    assert.deepEqual(t.w.plex.refreshed, ['501'], 'found in Plex by its tmdb guid');
    // an episode, with the ratingKey sent by Plex Lite
    const e = await t.call('POST', '/subtitles/search', { body: { type: 'episode', tvdbId: 9300, season: 1, episode: 6, language: 'fr', forced: true, ratingKey: '806' }, token: GOOD_TOKEN });
    assert.equal(e.data.status, 'downloaded');
    assert.equal(t.w.bazarr.patches[1].forced, 'True');
    assert.equal(t.w.bazarr.patches[1].seriesid, '300');
    assert.deepEqual(t.w.plex.refreshed, ['501', '806']);
  } finally { await t.close(); }
});

test('helper: /subtitles/search → not_found when the job ends without a subtitle; old Bazarr without jobs', async () => {
  const t = await startWorld();
  try {
    bazarrWorld(t);
    t.w.bazarr.find = () => null;
    const started = Date.now();
    const r = await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001, language: 'en' }, token: GOOD_TOKEN });
    assert.deepEqual(r.data, { status: 'not_found' });
    assert.ok(Date.now() - started < 1500, 'stops waiting once the job is done');
    assert.deepEqual(t.w.plex.refreshed, []);
    // Bazarr 1.4: the PATCH answers when the search is over, and there is no jobs list
    t.w.bazarr.noJobs = true;
    t.w.bazarr.find = () => 'podnapisi';
    const old = await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001, language: 'en' }, token: GOOD_TOKEN });
    assert.equal(old.data.provider, 'podnapisi');
    // a search that never finishes gives up after SUBTITLE_WAIT_SECONDS
    t.w.bazarr.noJobs = false;
    t.w.bazarr.searchDelay = 60000;
    const slow = Date.now();
    assert.deepEqual((await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001, language: 'en' }, token: GOOD_TOKEN })).data, { status: 'not_found' });
    assert.ok(Date.now() - slow >= 1900);
  } finally { await t.close(); }
});

test('helper: /subtitles/search defaults to the profile\'s first language; dry run asks nothing', async () => {
  const t = await startWorld({ env: { DRY_RUN: '1' } });
  try {
    bazarrWorld(t);
    const r = await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001 }, token: GOOD_TOKEN });
    assert.deepEqual(r.data, { status: 'dry_run', dryRun: true, language: 'en' });
    assert.deepEqual(t.w.bazarr.patches, []);
  } finally { await t.close(); }
});

test('helper: /subtitles/sync syncs the external subtitle in that language', async () => {
  const t = await startWorld();
  try {
    const e6 = bazarrWorld(t);
    const r = await t.call('POST', '/subtitles/sync', { body: { type: 'episode', tvdbId: 9300, season: 1, episode: 6, language: 'en' }, token: GOOD_TOKEN });
    assert.deepEqual(r.data, { status: 'queued' });
    assert.deepEqual(t.w.bazarr.syncs, [{ action: 'sync', language: 'en', path: '/data/tv/Example Show/Season 1/e6.en.srt', type: 'episode', id: String(e6), forced: 'False', hi: 'False' }]);
    // French is embedded only: nothing to sync
    const fr = await t.call('POST', '/subtitles/sync', { body: { type: 'episode', tvdbId: 9300, season: 1, episode: 6, language: 'fr' }, token: GOOD_TOKEN });
    assert.equal(fr.status, 404);
    assert.equal((await t.call('POST', '/subtitles/sync', { body: { type: 'movie', tmdbId: 1001 }, token: GOOD_TOKEN })).status, 400);
  } finally { await t.close(); }
});

test('helper: an upstream error is a 502 `upstream`, an unreachable service a 503', async () => {
  const t = await startWorld();
  try {
    bazarrWorld(t);
    await t.servers.bazarr.close();
    const r = await t.call('GET', '/subtitles?type=movie&tmdbId=1001');
    assert.equal(r.status, 503);
    assert.equal(r.data.error, 'unavailable');
    const h = await t.call('GET', '/healthz');
    assert.equal(h.data.services.bazarr, false);
    const q = await t.call('GET', '/missing?tvdbId=9300', {});
    assert.equal(q.status, 200);
    t.w.sonarr.series = null; // the fake now answers 500
    const broken = await t.call('GET', '/missing?tvdbId=9300');
    assert.equal(broken.status, 502);
    assert.equal(broken.data.error, 'upstream');
    assert.ok(!broken.data.message.includes('sonarr-test-key'));
  } finally { await t.close(); }
});
