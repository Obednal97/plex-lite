// Plex Lite home helper: "Report a problem" against fake Seerr / Radarr / Sonarr / Bazarr / Plex.
//   node --test test/helper-report.test.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseTail } from '../helper/lib/report.mjs';
import { report, SECRET, startWorld } from './helper-fakes.mjs';

const MOVIE_FILE = 'Example Film (2020)/Example.Film.2020.1080p.WEB.mkv';

async function movieWorld(opts = {}, movie = {}) {
  const t = await startWorld(opts);
  t.w.addUser(5, 4194304); // CREATE_ISSUES
  t.w.addMovie({ id: 7, title: 'Example Film', tmdbId: 1001, file: MOVIE_FILE, ...movie });
  return t;
}
const movieIssue = (t, o = {}) => t.w.addIssue({
  id: o.id || 1, mediaType: 'movie', tmdbId: 1001, issueType: 1,
  message: report(o.reason || 'video-quality', 'movie', { plex: 501, file: o.file === undefined ? 'Example.Film.2020.1080p.WEB.mkv' : o.file }),
  ...o,
});

// Show 300 (tvdb 9300): S1 E1–E3 from one season pack, E4 from its own grab; S2 E1 alone.
async function showWorld(opts = {}, extraSeasons = {}) {
  const t = await startWorld(opts);
  t.w.addUser(5, 4194304);
  t.w.addSeries({
    id: 300, title: 'Example Show', tvdbId: 9300, tmdbId: 7300,
    seasons: {
      1: [
        { episode: 1, file: 'Example.Show.S01E01.mkv', downloadId: 'PACK1', release: 'Example.Show.S01.1080p-GRP' },
        { episode: 2, file: 'Example.Show.S01E02.mkv', downloadId: 'PACK1', release: 'Example.Show.S01.1080p-GRP' },
        { episode: 3, file: 'Example.Show.S01E03.mkv', downloadId: 'PACK1', release: 'Example.Show.S01.1080p-GRP' },
        { episode: 4, file: 'Example.Show.S01E04.mkv', downloadId: 'SINGLE4', release: 'Example.Show.S01E04.720p-OTHER' },
      ],
      2: [{ episode: 1, file: 'Example.Show.S02E01.mkv' }],
      ...extraSeasons,
    },
  });
  t.w.mirrorToPlex(300, 800);
  return t;
}
const epIssue = (t, o = {}) => t.w.addIssue({
  id: o.id || 1, mediaType: 'tv', tmdbId: 7300, tvdbId: 9300, issueType: 2, mediaRatingKey: '800',
  season: o.season == null ? 1 : o.season, episode: o.episode == null ? 2 : o.episode,
  message: report(o.reason || 'audio-language', o.scope || 'episode', {
    season: o.season == null ? 1 : o.season, episode: o.episode == null ? 2 : o.episode,
    // the ratingKey mirrorToPlex gives that episode
    plex: 80000 + (o.season == null ? 1 : o.season) * 10 + (o.episode == null ? 2 : o.episode), file: o.file === undefined ? 'Example.Show.S01E02.mkv' : o.file,
  }),
  ...o,
});

const nothingChanged = (arr) => {
  assert.deepEqual(arr.failed, [], 'nothing blocklisted');
  assert.deepEqual(arr.deleted, [], 'nothing deleted');
  assert.deepEqual(arr.commands, [], 'no search');
};

test('helper: parses the plexlite: tail of a report', () => {
  assert.deepEqual(parseTail('Wrong audio language\n\nReported from Plex Lite (S1 E6).\nplexlite: reason=audio-language; scope=episode; season=1; episode=6; plex=123; file=A, B.mkv'),
    { reason: 'audio-language', scope: 'episode', season: '1', episode: '6', plex: '123', file: 'A, B.mkv' });
  assert.equal(parseTail('made in the web UI'), null);
});

test('helper: movie report → blocklist the one grab, delete the file, search, comment, resolve', async () => {
  const t = await movieWorld();
  try {
    movieIssue(t);
    const r = await t.webhook(1);
    assert.equal(r.status, 202);
    await t.helper.reports.idle();
    const R = t.w.radarr;
    assert.deepEqual(R.failed, [72], 'the grabbed record is marked failed');
    assert.deepEqual(R.deleted, [700]);
    assert.deepEqual(R.commands, [{ name: 'MoviesSearch', movieIds: [7] }]);
    const [c] = t.w.comments(1);
    assert.match(c, /^Fixed automatically: blocklisted `Example\.Film\.2020\.1080p\.WEB-GRP`, deleted the file and searched/);
    assert.equal(t.w.seerr.issues.get(1).status, 2, 'resolved');
    assert.equal(t.helper.state.data.handled[1].outcome, 'fixed');
  } finally { await t.close(); }
});

test('helper: a movie Radarr unmonitored on delete is monitored again before the search', async () => {
  const t = await movieWorld();
  try {
    t.w.radarr.unmonitorDeleted = true;
    movieIssue(t);
    await t.helper.reports.processIssue(1);
    assert.deepEqual(t.w.radarr.editor, [{ movieIds: [7], monitored: true }]);
    assert.equal(t.w.radarr.commands.length, 1);
  } finally { await t.close(); }
});

test('helper: dry run looks everything up, comments the plan, changes nothing, does not resolve', async () => {
  const t = await movieWorld({ env: { DRY_RUN: '1' } });
  try {
    movieIssue(t);
    const r = await t.helper.reports.processIssue(1);
    assert.equal(r.outcome, 'dry_run');
    nothingChanged(t.w.radarr);
    assert.match(t.w.comments(1)[0], /^Dry run \(nothing changed\): would blocklist `Example\.Film\.2020\.1080p\.WEB-GRP`, delete `Example\.Film\.2020\.1080p\.WEB\.mkv` and start a search/);
    assert.equal(t.w.seerr.issues.get(1).status, 1, 'still open');
    assert.ok(t.helper.state.data.dryRunHandled[1] && !t.helper.state.data.handled[1]);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'already_handled', 'once per dry run');
  } finally { await t.close(); }
});

test('helper: episode report → that episode only, monitored, EpisodeSearch', async () => {
  const t = await showWorld();
  try {
    epIssue(t);
    await t.helper.reports.processIssue(1);
    const S = t.w.sonarr;
    const e2 = t.w.episode(300, 1, 2);
    assert.equal(S.failed.length, 1, 'one grab blocklisted');
    assert.equal(S.history.find((h) => h.id === S.failed[0]).downloadId, 'PACK1');
    assert.deepEqual(S.deleted, [e2.id + 500000], 'only E2 is deleted; the rest of the pack stays');
    assert.deepEqual(S.monitor, [{ episodeIds: [e2.id], monitored: true }]);
    assert.deepEqual(S.commands, [{ name: 'EpisodeSearch', episodeIds: [e2.id] }]);
    assert.equal(t.w.episode(300, 1, 1).hasFile, true);
    assert.equal(t.w.seerr.issues.get(1).status, 2);
  } finally { await t.close(); }
});

test('helper: season report → one blocklist per downloadId, bulk delete, SeasonSearch', async () => {
  const t = await showWorld();
  try {
    epIssue(t, { episode: 0, scope: 'season', reason: 'video-quality', file: null });
    await t.helper.reports.processIssue(1);
    const S = t.w.sonarr;
    const ids = S.failed.map((id) => S.history.find((h) => h.id === id).downloadId).sort();
    assert.deepEqual(ids, ['PACK1', 'SINGLE4'], 'a season pack is one grab');
    assert.equal(S.deleted.length, 4);
    assert.deepEqual(S.commands, [{ name: 'SeasonSearch', seriesId: 300, seasonNumber: 1 }]);
    assert.equal(t.w.episode(300, 2, 1).hasFile, true, 'season 2 untouched');
    assert.match(t.w.comments(1)[0], /blocklisted `Example\.Show\.S01\.1080p-GRP`, `Example\.Show\.S01E04\.720p-OTHER`/);
  } finally { await t.close(); }
});

test('helper: a multi-episode file is searched for every episode it held', async () => {
  const t = await startWorld();
  try {
    t.w.addUser(5, 4194304);
    t.w.addSeries({ id: 310, title: 'Double Show', tvdbId: 9310, seasons: { 1: [
      { episode: 1, file: 'Double.S01E01E02.mkv', fileId: 777, downloadId: 'D12' },
      { episode: 2, file: 'Double.S01E01E02.mkv', fileId: 777, downloadId: 'D12' },
    ] } });
    t.w.addIssue({ id: 1, mediaType: 'tv', tvdbId: 9310, season: 1, episode: 1, message: report('corrupt', 'episode', { season: 1, episode: 1, file: 'Double.S01E01E02.mkv' }) });
    await t.helper.reports.processIssue(1);
    assert.deepEqual(t.w.sonarr.deleted, [777]);
    assert.deepEqual(t.w.sonarr.commands[0].episodeIds.length, 2);
  } finally { await t.close(); }
});

test('helper: whole-show and "something else" reports wait for a person', async () => {
  const t = await showWorld();
  try {
    epIssue(t, { id: 1, season: 0, episode: 0, scope: 'show', reason: 'corrupt', file: null });
    epIssue(t, { id: 2, reason: 'other', label: 'Something else: the picture is green' });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'manual');
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'manual');
    assert.match(t.w.comments(1)[0], /^Whole-show reports need a person/);
    assert.equal(t.w.comments(2)[0], 'A person will look at this.');
    nothingChanged(t.w.sonarr);
    assert.equal(t.w.seerr.issues.get(1).status, 1);
  } finally { await t.close(); }
});

test('helper: OTHER_ACTION=regrab re-grabs "something else"', async () => {
  const t = await showWorld({ env: { OTHER_ACTION: 'regrab' } });
  try {
    epIssue(t, { reason: 'other' });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    assert.equal(t.w.sonarr.deleted.length, 1);
  } finally { await t.close(); }
});

test('helper: subs-burned and the legacy subtitles reason re-grab', async () => {
  const t = await showWorld({ env: { LIMIT_PER_TITLE_7D: '5', LIMIT_PER_USER_24H: '5' } });
  try {
    epIssue(t, { id: 1, episode: 1, reason: 'subs-burned', file: 'Example.Show.S01E01.mkv' });
    epIssue(t, { id: 2, episode: 2, reason: 'subtitles' });
    // made in Seerr's own UI: no plexlite: line, issueType 2 (audio), no file= to check
    t.w.addIssue({ id: 3, mediaType: 'tv', tvdbId: 9300, issueType: 2, season: 1, episode: 3, message: 'sound is off' });
    for (const id of [1, 2, 3]) assert.equal((await t.helper.reports.processIssue(id)).outcome, 'fixed', `issue ${id}`);
    assert.equal(t.w.sonarr.deleted.length, 3);
  } finally { await t.close(); }
});

test('helper: subs-missing asks Bazarr (no delete), refreshes Plex, comments and resolves', async () => {
  const t = await showWorld();
  try {
    const e2 = t.w.episode(300, 1, 2);
    t.w.addBazarrProfile(1, [{ language: 'en' }]);
    t.w.bazarr.series.push({ sonarrSeriesId: 300, profileId: 1 });
    t.w.bazarr.episodes.push({ sonarrSeriesId: 300, sonarrEpisodeId: e2.id, subtitles: [], missing_subtitles: [{ code2: 'en', name: 'English', forced: false, hi: false }] });
    epIssue(t, { reason: 'subs-missing', issueType: 3 });
    const r = await t.helper.reports.processIssue(1);
    assert.equal(r.outcome, 'subs_fixed');
    nothingChanged(t.w.sonarr);
    assert.deepEqual(t.w.bazarr.patches.map((p) => [p.kind, p.id, p.seriesid, p.language, p.forced, p.hi]), [['episode', e2.id, '300', 'en', 'False', 'False']]);
    assert.deepEqual(t.w.plex.refreshed, ['80012'], 'the episode from the report\'s plex= key');
    assert.match(t.w.comments(1)[0], /^Fixed automatically: Bazarr downloaded English for S1 E2 \(opensubtitlescom\)/);
    assert.equal(t.w.seerr.issues.get(1).status, 2);
  } finally { await t.close(); }
});

test('helper: subs-missing that Bazarr can\'t find stays open with a comment', async () => {
  const t = await movieWorld();
  try {
    t.w.bazarr.find = () => null;
    t.w.addBazarrProfile(1, [{ language: 'en' }]);
    t.w.bazarr.movies.push({ radarrId: 7, profileId: 1, subtitles: [], missing_subtitles: [{ code2: 'en', name: 'English' }] });
    movieIssue(t, { reason: 'subs-missing', issueType: 3 });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'subs_not_found');
    assert.match(t.w.comments(1)[0], /^Bazarr searched for English but found nothing\. Left open/);
    assert.equal(t.w.seerr.issues.get(1).status, 1);
    nothingChanged(t.w.radarr);
  } finally { await t.close(); }
});

test('helper: subs-missing in dry run only says what it would ask Bazarr for', async () => {
  const t = await movieWorld({ env: { DRY_RUN: '1' } });
  try {
    t.w.bazarr.movies.push({ radarrId: 7, profileId: 1, subtitles: [], missing_subtitles: [{ code2: 'en', name: 'English' }] });
    movieIssue(t, { reason: 'subs-missing', issueType: 3 });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'dry_run');
    assert.deepEqual(t.w.bazarr.patches, []);
    assert.equal(t.w.comments(1)[0], 'Dry run (nothing changed): would ask Bazarr for English.');
  } finally { await t.close(); }
});

test('helper: subs-missing without Bazarr waits for a person', async () => {
  const t = await movieWorld({ skip: ['bazarr'] });
  try {
    movieIssue(t, { reason: 'subs-missing', issueType: 3 });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'manual');
    assert.match(t.w.comments(1)[0], /Bazarr isn't set up/);
  } finally { await t.close(); }
});

// ---- safety limits --------------------------------------------------------------------------------

test('helper safety: a file name that isn\'t Radarr\'s (another version) stops everything', async () => {
  const t = await movieWorld();
  try {
    movieIssue(t, { file: 'Example.Film.2020.2160p.REMUX.mkv' });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    nothingChanged(t.w.radarr);
    assert.match(t.w.comments(1)[0], /isn't Radarr's file .*another version\. Nothing was changed; left for a person\./);
    assert.equal(t.w.seerr.issues.get(1).status, 1);
  } finally { await t.close(); }
});

for (const [name, movie, expect] of [
  ['no import record (manual import)', { importRecord: false }, /no import record/],
  ['an import without a download id', { noDownloadId: true }, /no download id/],
  ['two grab records for one download', { grabs: 2 }, /2 grab records/],
  ['no grab record', { grabs: 0 }, /no grab record/],
  ['a file outside the root folders', { root: '/elsewhere' }, /root folders/],
  ['no file at all', { file: null }, /no file/],
]) {
  test(`helper safety: ${name} → nothing deleted`, async () => {
    const t = await movieWorld({}, movie);
    try {
      movieIssue(t, { file: null });
      await t.helper.reports.processIssue(1);
      nothingChanged(t.w.radarr);
      assert.match(t.w.comments(1)[0], expect);
    } finally { await t.close(); }
  });
}

test('helper safety: a title already in the queue is left alone', async () => {
  const t = await movieWorld();
  try {
    t.w.radarr.queue.push({ id: 1, movieId: 7, title: 'x', status: 'downloading' });
    movieIssue(t);
    await t.helper.reports.processIssue(1);
    nothingChanged(t.w.radarr);
    assert.match(t.w.comments(1)[0], /already in Radarr's queue/);
  } finally { await t.close(); }
});

test('helper safety: a season with an ambiguous file does nothing for the whole season', async () => {
  const t = await showWorld({}, {
    3: [{ episode: 1, file: 'Example.Show.S03E01.mkv' }, { episode: 2, file: 'Example.Show.S03E02.mkv', downloadId: null }],
  });
  try {
    epIssue(t, { season: 3, episode: 0, scope: 'season', file: null });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    nothingChanged(t.w.sonarr);
  } finally { await t.close(); }
});

test('helper safety: more files than MAX_FILES_PER_ISSUE → nothing deleted', async () => {
  const t = await showWorld({ env: { MAX_FILES_PER_ISSUE: '3' } });
  try {
    epIssue(t, { episode: 0, scope: 'season', file: null });
    await t.helper.reports.processIssue(1);
    nothingChanged(t.w.sonarr);
    assert.match(t.w.comments(1)[0], /4 files is more than this helper handles at once \(3\)/);
  } finally { await t.close(); }
});

test('helper safety: blocklisted but the delete failed → no search, left open', async () => {
  const t = await movieWorld();
  try {
    t.w.radarr.failDelete = true;
    movieIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'error');
    assert.equal(t.w.radarr.failed.length, 1);
    assert.deepEqual(t.w.radarr.commands, []);
    assert.match(t.w.comments(1)[0], /deleting the file failed .*no search was started/);
    assert.equal(t.w.seerr.issues.get(1).status, 1);
  } finally { await t.close(); }
});

test('helper safety: only open, recent, untouched issues are acted on', async () => {
  const t = await movieWorld();
  try {
    movieIssue(t, { id: 1, status: 2 });
    movieIssue(t, { id: 2, createdAt: t.clock.now() - 16 * 60000 });
    movieIssue(t, { id: 3, extraComments: ['Looking into it'] });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'not_open');
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'too_old');
    assert.equal((await t.helper.reports.processIssue(3)).outcome, 'touched');
    assert.equal((await t.helper.reports.processIssue(99)).outcome, 'not_found');
    nothingChanged(t.w.radarr);
    assert.deepEqual(t.w.comments(1), []);
  } finally { await t.close(); }
});

test('helper safety: reporters without CREATE_ISSUES, and DENY_USERS, are refused', async () => {
  const t = await movieWorld({ env: { DENY_USERS: '6' } });
  try {
    t.w.addUser(4, 32); // REQUEST only
    t.w.addUser(6, 2); // admin, but denied
    movieIssue(t, { id: 1, userId: 4 });
    movieIssue(t, { id: 2, userId: 6 });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'not_allowed');
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'not_allowed');
    nothingChanged(t.w.radarr);
  } finally { await t.close(); }
});

test('helper safety: re-grab limits per person, per title and in total', async () => {
  const t = await showWorld({ env: { LIMIT_PER_USER_24H: '2', LIMIT_PER_TITLE_7D: '2', LIMIT_TOTAL_24H: '3' } });
  try {
    t.w.addUser(6, 4194304);
    epIssue(t, { id: 1, episode: 1, file: 'Example.Show.S01E01.mkv' });
    epIssue(t, { id: 2, episode: 2 });
    epIssue(t, { id: 3, episode: 3, userId: 6, file: 'Example.Show.S01E03.mkv' }); // 3rd for S1 in a week
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'fixed');
    assert.equal((await t.helper.reports.processIssue(3)).outcome, 'limit');
    assert.match(t.w.comments(3)[0], /limit reached \(2 automatic fixes per title per week\)/);
    // the same person on another season: their daily limit
    epIssue(t, { id: 4, season: 2, episode: 1, file: 'Example.Show.S02E01.mkv', createdAt: t.clock.now() });
    assert.equal((await t.helper.reports.processIssue(4)).outcome, 'limit');
    assert.match(t.w.comments(4)[0], /2 automatic fixes per person per day/);
    // a day later the person may again, but the title's week isn't over
    t.clock.advance(25 * 3600 * 1000);
    epIssue(t, { id: 5, season: 2, episode: 1, file: 'Example.Show.S02E01.mkv', createdAt: t.clock.now() });
    assert.equal((await t.helper.reports.processIssue(5)).outcome, 'fixed');
    assert.equal(t.w.sonarr.deleted.length, 3);
  } finally { await t.close(); }
});

test('helper safety: total daily limit', async () => {
  const t = await movieWorld({ env: { LIMIT_TOTAL_24H: '1' } });
  try {
    t.w.addMovie({ id: 8, title: 'Other Film', tmdbId: 1002 });
    movieIssue(t, { id: 1 });
    t.w.addIssue({ id: 2, mediaType: 'movie', tmdbId: 1002, userId: 5, message: report('corrupt', 'movie', {}) });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'limit');
    assert.match(t.w.comments(2)[0], /1 automatic fixes per day/);
  } finally { await t.close(); }
});

test('helper safety: a second wrong-item for the same episode within 7 days waits for a person', async () => {
  const t = await showWorld();
  try {
    epIssue(t, { id: 1, reason: 'wrong-item', issueType: 4 });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    // the replacement arrived with the same name and is wrong again
    t.w.sonarr.files.push({ id: 999, seriesId: 300, seasonNumber: 1, relativePath: 'Season 1/Example.Show.S01E02.mkv', path: '/data/tv/Example Show/Season 1/Example.Show.S01E02.mkv' });
    Object.assign(t.w.episode(300, 1, 2), { hasFile: true, episodeFileId: 999 });
    epIssue(t, { id: 2, reason: 'wrong-item', issueType: 4, createdAt: t.clock.now() });
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'repeat_wrong_item');
    assert.match(t.w.comments(2)[0], /second "wrong film\/episode" report/);
  } finally { await t.close(); }
});

test('helper: a second wrong-language report says the next copy may be in it too', async () => {
  const t = await showWorld();
  try {
    epIssue(t, { id: 1, episode: 1, file: 'Example.Show.S01E01.mkv' });
    await t.helper.reports.processIssue(1);
    epIssue(t, { id: 2, episode: 2, createdAt: t.clock.now() });
    await t.helper.reports.processIssue(2);
    assert.doesNotMatch(t.w.comments(1)[0], /reported for the wrong language before/);
    assert.match(t.w.comments(2)[0], /reported for the wrong language before/);
  } finally { await t.close(); }
});

// ---- webhook ---------------------------------------------------------------------------------------

test('helper webhook: wrong or missing secret → 401, nothing processed and nothing logged', async () => {
  const t = await movieWorld();
  try {
    movieIssue(t);
    const before = t.logs.length;
    assert.equal((await t.webhook(1, { secret: 'nope' })).status, 401);
    const r = await t.call('POST', '/seerr-webhook', { body: { notification_type: 'ISSUE_CREATED', issue_id: '1' } });
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: 'unauthenticated', message: 'unauthenticated' });
    await t.helper.reports.idle();
    assert.equal(t.logs.length, before);
    nothingChanged(t.w.radarr);
  } finally { await t.close(); }
});

test('helper webhook: Seerr\'s test notification is logged and ignored; the same issue twice is processed once', async () => {
  const t = await movieWorld();
  try {
    movieIssue(t);
    const test1 = await t.webhook(0, { type: 'TEST_NOTIFICATION' });
    assert.equal(test1.status, 200);
    assert.equal(test1.data.ignored, 'test');
    await t.webhook(1);
    await t.webhook(1);
    await t.helper.reports.idle();
    assert.equal(t.w.radarr.deleted.length, 1);
    assert.equal(t.w.comments(1).length, 1);
  } finally { await t.close(); }
});

test('helper webhook: PAUSED (setting or file) only logs', async () => {
  const t = await movieWorld();
  try {
    movieIssue(t);
    writeFileSync(join(t.stateDir, 'PAUSED'), '');
    const r = await t.webhook(1);
    assert.deepEqual(r.data, { ok: true, paused: true });
    await t.helper.reports.idle();
    nothingChanged(t.w.radarr);
    assert.equal((await t.call('GET', '/healthz')).data.paused, true);
  } finally { await t.close(); }
});

// ---- backfill --------------------------------------------------------------------------------------

test('helper backfill: open Plex Lite reports from the last BACKFILL_DAYS are processed once, across restarts', async () => {
  let t = await movieWorld({ env: { BACKFILL_DAYS: '14' } });
  try {
    t.w.addMovie({ id: 8, title: 'Other Film', tmdbId: 1002 });
    movieIssue(t, { id: 1, createdAt: t.clock.now() - 3 * 86400000 });
    t.w.addIssue({ id: 2, mediaType: 'movie', tmdbId: 1002, createdAt: t.clock.now() - 20 * 86400000, message: report('corrupt', 'movie', {}) });
    t.w.addIssue({ id: 3, mediaType: 'movie', tmdbId: 1002, createdAt: t.clock.now() - 86400000, message: 'made in the web UI' });
    const results = await t.helper.reports.backfill();
    assert.deepEqual(results.map((r) => [r.id, r.outcome]), [[1, 'fixed']], 'only the recent Plex Lite report');
    t = await t.restart();
    assert.deepEqual(await t.helper.reports.backfill(), [], 'not again after a restart');
    assert.equal(t.w.radarr.deleted.length, 1);
  } finally { await t.close(); }
});

test('helper backfill: a dry run first, then live: the live run fixes it once, despite the dry-run comment', async () => {
  let t = await movieWorld({ env: { BACKFILL_DAYS: '14', DRY_RUN: '1' } });
  try {
    movieIssue(t, { id: 1, createdAt: t.clock.now() - 2 * 86400000 });
    assert.deepEqual((await t.helper.reports.backfill()).map((r) => r.outcome), ['dry_run']);
    t = await t.restart();
    assert.deepEqual(await t.helper.reports.backfill(), [], 'a restart in dry run doesn\'t comment twice');
    t = await t.restart({ DRY_RUN: '0' });
    assert.deepEqual((await t.helper.reports.backfill()).map((r) => r.outcome), ['fixed']);
    t = await t.restart({ DRY_RUN: '0' });
    assert.deepEqual(await t.helper.reports.backfill(), []);
    assert.equal(t.w.radarr.deleted.length, 1);
    const comments = t.w.comments(1);
    assert.equal(comments.length, 2);
    assert.match(comments[0], /^Dry run/);
    assert.match(comments[1], /^Fixed automatically/);
  } finally { await t.close(); }
});

test('helper backfill: BACKFILL_DAYS=0 turns it off; start() runs it', async () => {
  const t = await movieWorld({ env: { BACKFILL_DAYS: '0' } });
  try {
    movieIssue(t, { id: 1, createdAt: t.clock.now() - 86400000 });
    assert.deepEqual(await t.helper.reports.backfill(), []);
    assert.equal(t.helper.cfg.dryRun, false);
    assert.ok(SECRET);
  } finally { await t.close(); }
});

test('helper backfill: Seerr not answering yet → null, so start() tries again later', async () => {
  const t = await movieWorld({ env: { BACKFILL_DAYS: '14' } });
  try {
    await t.servers.seerr.close();
    assert.equal(await t.helper.reports.backfill(), null);
    assert.ok(t.logs.some((l) => /backfill: can't list Seerr issues/.test(l)));
  } finally { await t.close(); }
});
