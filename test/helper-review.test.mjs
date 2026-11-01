// Plex Lite home helper: fixes from the review of feature/helper (one test per finding).
//   node --test test/helper-review.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvFile, readConfig } from '../helper/lib/config.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('review 2: DRY_RUN only turns off on an explicit 0/false/no/off; trailing comments keep it on', () => {
  for (const v of ['1  # keep on', '0 # live', 'yes please', '', undefined, '01', 'off-ish']) {
    assert.equal(readConfig(v === undefined ? {} : { DRY_RUN: v }).dryRun, true, JSON.stringify(v));
  }
  for (const v of ['0', 'false', 'NO', ' off ']) assert.equal(readConfig({ DRY_RUN: v }).dryRun, false, v);
});

test('review 2: PAUSED: unset/0/false/no/off = running, anything unrecognised = paused', () => {
  for (const v of [undefined, '', '0', 'false', 'no', 'off']) assert.equal(readConfig(v === undefined ? {} : { PAUSED: v }).paused, false, JSON.stringify(v));
  for (const v of ['1', 'yes', '0 # not paused', 'maybe']) assert.equal(readConfig({ PAUSED: v }).paused, true, v);
});

test('review 2: --env files are read like systemd reads them (an inline # is part of the value)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plexlite-helper-env-'));
  const file = join(dir, 'helper.env');
  writeFileSync(file, 'DRY_RUN=0 # go live\n# a comment line\nPAUSED=0\n');
  const env = loadEnvFile(file, {});
  assert.equal(env.DRY_RUN, '0 # go live');
  assert.equal(readConfig(env).dryRun, true, 'not an explicit 0, so still a dry run');
  assert.equal(readConfig(env).paused, false);
});

// ---------------------------------------------------------------------------------------------------
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { request } from '../helper/lib/http.mjs';
import { GOOD_TOKEN, report, startWorld } from './helper-fakes.mjs';

const FILE = 'Example Film (2020)/Example.Film.2020.1080p.WEB.mkv';
const PLEX_NAME = 'Example.Film.2020.1080p.WEB.mkv';

async function film(opts = {}, movie = {}) {
  const t = await startWorld(opts);
  t.w.addUser(5, 4194304);
  t.w.addMovie({ id: 7, title: 'Example Film', tmdbId: 1001, file: FILE, ...movie });
  return t;
}
const filmIssue = (t, o = {}) => t.w.addIssue({ id: o.id || 1, mediaType: 'movie', tmdbId: 1001, message: report(o.reason || 'video-quality', 'movie', { file: o.file === undefined ? PLEX_NAME : o.file }), ...o });
const unchanged = (arr) => { assert.deepEqual(arr.failed, []); assert.deepEqual(arr.deleted, []); assert.deepEqual(arr.commands, []); };
const radarrImport = (t, o) => t.w.radarr.history.push({ id: o.id, movieId: o.movieId || 7, eventType: 'downloadFolderImported', downloadId: o.dl, sourceTitle: o.release || `rel-${o.dl}`, data: { importedPath: `/data/movies/${FILE}` }, date: o.date });
const radarrGrab = (t, o) => t.w.radarr.history.push({ id: o.id, movieId: o.movieId || 7, eventType: 'grabbed', downloadId: o.dl, sourceTitle: o.release || `rel-${o.dl}`, data: {}, date: o.date });

// Show 300 S1 E1–E3 from one pack (Plex sees the same files in its Season 1), E4 alone
async function show(opts = {}) {
  const t = await startWorld(opts);
  t.w.addUser(5, 4194304);
  t.w.addSeries({ id: 300, title: 'Example Show', tvdbId: 9300, seasons: { 1: [
    { episode: 1, file: 'Example.Show.S01E01.mkv', downloadId: 'PACK1', release: 'Example.Show.S01-GRP' },
    { episode: 2, file: 'Example.Show.S01E02.mkv', downloadId: 'PACK1', release: 'Example.Show.S01-GRP' },
    { episode: 3, file: 'Example.Show.S01E03.mkv', downloadId: 'PACK1', release: 'Example.Show.S01-GRP' },
    { episode: 4, file: 'Example.Show.S01E04.mkv', downloadId: 'SINGLE4', release: 'Example.Show.S01E04-OTHER' },
  ] } });
  t.w.addPlexShow(800, 9300, [1, 2, 3, 4].map((e) => [800 + e, 1, e, `/media/tv/Example Show/Season 1/Example.Show.S01E0${e}.mkv`]));
  return t;
}
const seasonIssue = (t, o = {}) => t.w.addIssue({ id: o.id || 1, mediaType: 'tv', tvdbId: 9300, season: 1, episode: 0, mediaRatingKey: '800', message: report(o.reason || 'video-quality', 'season', { season: 1 }), ...o });

// ---- 1. matching the import and the grab ----------------------------------------------------------

test('review 1: after one re-grab (same file name), the newest import whose date matches the file is used', async () => {
  const t = await film({}, { grab: false, dateAdded: '2026-10-20T10:00:20Z' });
  try {
    radarrImport(t, { id: 1, dl: 'OLD', date: '2026-10-01T00:00:00Z' });
    radarrGrab(t, { id: 2, dl: 'OLD', date: '2026-09-30T23:00:00Z' });
    radarrImport(t, { id: 3, dl: 'NEW', date: '2026-10-20T10:00:00Z' });
    radarrGrab(t, { id: 4, dl: 'NEW', date: '2026-10-20T09:00:00Z' });
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    assert.deepEqual(t.w.radarr.failed, [4], 'the grab that brought the current file');
  } finally { await t.close(); }
});

test('review 1: a hand-imported file with an old import record of the same name is not deleted', async () => {
  const t = await film({}, { grab: false, dateAdded: '2026-10-25T08:00:00Z' });
  try {
    radarrImport(t, { id: 1, dl: 'OLD', date: '2026-10-01T00:00:00Z' });
    radarrGrab(t, { id: 2, dl: 'OLD', date: '2026-09-30T23:00:00Z' });
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    unchanged(t.w.radarr);
    assert.match(t.w.comments(1)[0], /no import record from when .* was added/);
  } finally { await t.close(); }
});

test('review 1: a grab record of another film (history by downloadId is not title-filtered) stops it', async () => {
  const t = await film({}, { grab: false, dateAdded: '2026-10-01T00:00:10Z' });
  try {
    radarrImport(t, { id: 1, dl: 'DL', date: '2026-10-01T00:00:00Z' });
    radarrGrab(t, { id: 2, dl: 'DL', movieId: 99, date: '2026-09-30T23:00:00Z' });
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    unchanged(t.w.radarr);
  } finally { await t.close(); }
});

test('review 1: Sonarr: a grab of the download for another series stops it', async () => {
  const t = await show();
  try {
    const e2 = t.w.episode(300, 1, 2);
    for (const h of t.w.sonarr.history) if (h.eventType === 'grabbed' && h.downloadId === 'PACK1') { h.seriesId = 301; h.episodeId = 999999; }
    t.w.addIssue({ id: 1, mediaType: 'tv', tvdbId: 9300, season: 1, episode: 2, message: report('corrupt', 'episode', { season: 1, episode: 2, file: 'Example.Show.S01E02.mkv' }) });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    unchanged(t.w.sonarr);
    assert.ok(e2.hasFile);
  } finally { await t.close(); }
});

// ---- 3. PAUSED inside the flow --------------------------------------------------------------------

test('review 3: PAUSED is checked before an issue is recorded and again just before the first change', async () => {
  const t = await film();
  try {
    filmIssue(t);
    const paused = join(t.stateDir, 'PAUSED');
    writeFileSync(paused, '');
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'paused');
    assert.equal(t.helper.state.data.handled[1], undefined, 'not recorded: handled once unpaused');
    unlinkSync(paused);
    // paused while the helper is looking things up
    t.w.radarr.onQueue = () => writeFileSync(paused, '');
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'paused');
    unchanged(t.w.radarr);
    assert.equal(t.helper.state.data.handled[1], undefined);
    assert.deepEqual(t.w.comments(1), []);
    t.w.radarr.onQueue = null;
    unlinkSync(paused);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
  } finally { await t.close(); }
});

// ---- 4. interrupted runs, stopping, the state file --------------------------------------------------

test('review 4: each step is recorded; an issue left mid-way gets a comment on the next start and stays open', async () => {
  let t = await film();
  try {
    filmIssue(t, { id: 1 });
    await t.helper.reports.processIssue(1);
    assert.equal(t.helper.state.data.handled[1].step, 'searched');
    assert.equal(t.helper.state.data.handled[1].outcome, 'fixed');
    // a crash after blocklisting issue 2
    filmIssue(t, { id: 2 });
    t.helper.state.data.handled[2] = { at: t.clock.now(), outcome: 'started', step: 'blocklisted', arr: 'Radarr', releases: ['Example.Film.2020.1080p.WEB-GRP'] };
    t.helper.state.save();
    t = await t.restart();
    await t.helper.start();
    const [c] = t.w.comments(2);
    assert.match(c, /interrupted .* after blocklisting `Example\.Film\.2020\.1080p\.WEB-GRP`.*check Radarr/i);
    assert.equal(t.w.seerr.issues.get(2).status, 1);
    assert.equal(t.helper.state.data.handled[2].outcome, 'interrupted');
    await t.helper.start();
    assert.equal(t.w.comments(2).length, 1, 'only once');
  } finally { await t.close(); }
});

test('review 4: stopping finishes the destructive sequence already under way and starts nothing new', async () => {
  const t = await film();
  try {
    t.w.addMovie({ id: 8, title: 'Other Film', tmdbId: 1002 });
    filmIssue(t, { id: 1 });
    t.w.addIssue({ id: 2, mediaType: 'movie', tmdbId: 1002, userId: 5, message: report('corrupt', 'movie', {}) });
    t.w.radarr.failedDelay = 150;
    const first = t.helper.reports.enqueue(1, 'webhook');
    const second = t.helper.reports.enqueue(2, 'webhook');
    await new Promise((r) => setTimeout(r, 60)); // issue 1 is blocklisting now
    t.helper.reports.stop();
    assert.equal((await first).outcome, 'fixed', 'blocklist, delete and search all happened');
    assert.equal((await second).outcome, 'stopping');
    assert.deepEqual(t.w.radarr.deleted, [700]);
    assert.equal(t.helper.state.data.handled[2], undefined);
  } finally { await t.close(); }
});

test('review 4: an unreadable state.json is moved aside and the helper runs in dry run until it is dealt with', async () => {
  let t = await film({ env: { DRY_RUN: '0' } });
  try {
    await t.helper.close();
    writeFileSync(join(t.stateDir, 'state.json'), '{"handled": {"1": ');
    t = await t.restart();
    assert.equal(t.helper.cfg.dryRun, true);
    const aside = readdirSync(t.stateDir).filter((f) => f.startsWith('state.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.ok(t.logs.some((l) => /state\.json was unreadable/i.test(l)));
    assert.equal((await t.call('GET', '/healthz')).data.dryRun, true);
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'dry_run');
    t = await t.restart();
    assert.equal(t.helper.cfg.dryRun, true, 'still dry while the .corrupt file is there');
    unlinkSync(join(t.stateDir, aside[0]));
    t = await t.restart();
    assert.equal(t.helper.cfg.dryRun, false);
  } finally { await t.close(); }
});

// ---- 5. backfill is a one-off ------------------------------------------------------------------------

test('review 5: no backfill by default; the BACKFILL_DAYS file runs one once', async () => {
  assert.equal(readConfig({}).backfillDays, 0);
  let t = await film({ env: { BACKFILL_DAYS: null } });
  try {
    filmIssue(t, { id: 1, createdAt: t.clock.now() - 3 * 86400000 });
    await t.helper.start();
    assert.deepEqual(t.w.radarr.deleted, [], 'a normal start backfills nothing');
    writeFileSync(join(t.stateDir, 'BACKFILL_DAYS'), '14\n');
    t = await t.restart({ BACKFILL_DAYS: null });
    await t.helper.start();
    assert.deepEqual(t.w.radarr.deleted, [700]);
    assert.equal(existsSync(join(t.stateDir, 'BACKFILL_DAYS')), false, 'used once');
  } finally { await t.close(); }
});

test('review 5: a backfilled film or episode without file= is commented on, not deleted', async () => {
  const t = await film({ env: { BACKFILL_DAYS: '14' } });
  try {
    filmIssue(t, { id: 1, file: null, createdAt: t.clock.now() - 86400000 });
    const [r] = await t.helper.reports.backfill();
    assert.equal(r.outcome, 'ambiguous');
    unchanged(t.w.radarr);
    assert.match(t.w.comments(1)[0], /doesn't say which file/);
  } finally { await t.close(); }
});

// ---- 6. a season must be the same season in Plex and Sonarr ---------------------------------------------

test('review 6: a season whose Plex files are not Sonarr\'s season (numbering) is left for a person', async () => {
  const t = await show();
  try {
    // Plex's Season 1 shows other files (e.g. Plex orders by air date, Sonarr by DVD)
    t.w.addPlexShow(800, 9300, [[801, 1, 1, '/media/tv/Example Show/Season 1/Example.Show.S02E01.mkv'], [802, 1, 2, '/x/Example.Show.S01E02.mkv']]);
    seasonIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    unchanged(t.w.sonarr);
    assert.match(t.w.comments(1)[0], /Plex's Season 1 doesn't match Sonarr's/);
  } finally { await t.close(); }
});

test('review 6: without PLEX_TOKEN a season can\'t be checked, so it waits for a person; a matching one is fixed', async () => {
  const t = await show({ env: { PLEX_TOKEN: null } });
  try {
    seasonIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    unchanged(t.w.sonarr);
    assert.match(t.w.comments(1)[0], /PLEX_TOKEN/);
  } finally { await t.close(); }
  const t2 = await show();
  try {
    seasonIssue(t2);
    assert.equal((await t2.helper.reports.processIssue(1)).outcome, 'fixed');
  } finally { await t2.close(); }
});

// ---- 7. subtitles can't hold the queue; too-old reports say so --------------------------------------------

test('review 7: a long subtitles run stops at SUBTITLE_RUN_MAX_SECONDS and says what it didn\'t search', async () => {
  const t = await show({ env: { SUBTITLE_RUN_MAX_SECONDS: '1' } });
  try {
    t.w.bazarr.find = () => null;
    t.w.bazarr.searchDelay = 60000; // each search runs until SUBTITLE_WAIT_SECONDS (2)
    t.w.bazarr.series.push({ sonarrSeriesId: 300, profileId: 1 });
    for (const e of [1, 2, 3, 4]) t.w.bazarr.episodes.push({ sonarrSeriesId: 300, sonarrEpisodeId: t.w.episode(300, 1, e).id, subtitles: [], missing_subtitles: [{ code2: 'en', name: 'English' }] });
    seasonIssue(t, { reason: 'subs-missing', issueType: 3 });
    const started = Date.now();
    await t.helper.reports.processIssue(1);
    assert.ok(Date.now() - started < 3500, 'about one search, not four');
    assert.equal(t.w.bazarr.patches.length, 1);
    assert.match(t.w.comments(1)[0], /Not searched \(time limit\): English for S1 E2, English for S1 E3, English for S1 E4/);
  } finally { await t.close(); }
});

test('review 7: a report that is too old when its turn comes gets a comment (once)', async () => {
  const t = await film();
  try {
    filmIssue(t, { createdAt: t.clock.now() - 20 * 60000 });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'too_old');
    assert.match(t.w.comments(1)[0], /older than 15 minutes/);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'already_handled');
    assert.equal(t.w.comments(1).length, 1);
    unchanged(t.w.radarr);
  } finally { await t.close(); }
});

// ---- 8. unauthenticated callers can't hammer Plex ---------------------------------------------------

test('review 8: failed token checks are limited per client, and uncached checks in total', async () => {
  const t = await startWorld({ env: { AUTH_FAILS_PER_IP_10_MIN: '3', TOKEN_CHECKS_PER_10_MIN: '5' } });
  try {
    const plexChecks = () => t.servers.plex.calls.filter((c) => c.path === '/library/sections').length;
    for (let i = 0; i < 3; i++) assert.equal((await t.call('POST', '/missing/search', { body: { tvdbId: 1 }, token: `bad-${i}` })).status, 401);
    const limited = await t.call('POST', '/missing/search', { body: { tvdbId: 1 }, token: 'bad-x' });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error, 'rate_limited');
    assert.equal(plexChecks(), 3, 'the 4th never reached Plex');
    // the global cap: 5 uncached checks in 10 minutes (3 used above); a cached good token still works
    t.w.plex.tokens.add('good-2');
    t.w.plex.tokens.add('good-3');
    t.w.plex.tokens.add('good-4');
    const other = { 'X-Forwarded-For': 'ignored' };
    assert.equal((await t.call('POST', '/missing/search', { body: {}, token: GOOD_TOKEN, headers: other })).status, 429, 'same client is still blocked');
  } finally { await t.close(); }
});

test('review 8: the global cap on uncached token checks', async () => {
  const t = await startWorld({ env: { TOKEN_CHECKS_PER_10_MIN: '2' } });
  try {
    t.w.plex.tokens.add('good-2');
    t.w.plex.tokens.add('good-3');
    assert.equal((await t.call('POST', '/missing/search', { body: {}, token: GOOD_TOKEN })).status, 400);
    assert.equal((await t.call('POST', '/missing/search', { body: {}, token: 'good-2' })).status, 400);
    assert.equal((await t.call('POST', '/missing/search', { body: {}, token: 'good-3' })).status, 429);
    assert.equal((await t.call('POST', '/missing/search', { body: {}, token: GOOD_TOKEN })).status, 400, 'cached tokens aren\'t checked again');
  } finally { await t.close(); }
});

// ---- low ------------------------------------------------------------------------------------------

test('review low: a partial blocklist names what was blocklisted; comments carry no upstream error text', async () => {
  const t = await show();
  try {
    const packGrab = t.w.sonarr.history.find((h) => h.eventType === 'grabbed' && h.downloadId === 'SINGLE4');
    t.w.sonarr.failFailed = new Set([packGrab.id]);
    seasonIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'error');
    const [c] = t.w.comments(1);
    assert.match(c, /blocklisted `Example\.Show\.S01-GRP`, but blocklisting `Example\.Show\.S01E04-OTHER` failed/);
    assert.doesNotMatch(c, /internal detail/);
    assert.ok(t.logs.some((l) => /internal detail/.test(l)), 'the detail is in the log');
    assert.deepEqual(t.w.sonarr.deleted, []);
  } finally { await t.close(); }
});

test('review low: an unexpected upstream error is a generic comment, the detail goes to the log', async () => {
  const t = await film();
  try {
    t.w.radarr.queueError = 'internal detail /secret/path';
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'error');
    assert.doesNotMatch(t.w.comments(1)[0], /internal detail|secret/);
    assert.match(t.w.comments(1)[0], /the helper's log/);
    assert.ok(t.logs.some((l) => /internal detail/.test(l)));
  } finally { await t.close(); }
});

test('review low: an upstream call has a total deadline, not just an idle timeout', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 50); // never idle, never done
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const started = Date.now();
    await assert.rejects(request('sonarr', `http://127.0.0.1:${server.address().port}`, '/x', { timeout: 300 }), (e) => e.status === 0);
    assert.ok(Date.now() - started < 1000);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('review low: a viewer\'s ratingKey is refreshed only when it is the target; otherwise the helper finds the item', async () => {
  const t = await startWorld();
  try {
    t.w.addMovie({ id: 7, title: 'Example Film', tmdbId: 1001 });
    t.w.addMovie({ id: 9, title: 'Someone Else', tmdbId: 1005 });
    t.w.addPlexMovie(501, 1001);
    t.w.addPlexMovie(999, 1005);
    t.w.bazarr.movies.push({ radarrId: 7, profileId: 1, subtitles: [], missing_subtitles: [] });
    const r = await t.call('POST', '/subtitles/search', { body: { type: 'movie', tmdbId: 1001, language: 'en', ratingKey: '999' }, token: GOOD_TOKEN });
    assert.equal(r.data.status, 'downloaded');
    assert.deepEqual(t.w.plex.refreshed, ['501'], 'not the other film');
  } finally { await t.close(); }
});

test('review low: a Seerr-UI "Subtitles" issue (no plexlite: line) goes to Bazarr, never delete', async () => {
  const t = await film();
  try {
    t.w.bazarr.movies.push({ radarrId: 7, profileId: 1, subtitles: [], missing_subtitles: [{ code2: 'en', name: 'English' }] });
    t.w.addIssue({ id: 1, mediaType: 'movie', tmdbId: 1001, issueType: 3, message: 'no subs' });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'subs_fixed');
    unchanged(t.w.radarr);
  } finally { await t.close(); }
});
