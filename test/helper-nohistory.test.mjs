// Plex Lite home helper: files with no download history (owner's option B, 2026-11-01). A film or
// single episode whose file has no import and no grab record may be deleted and searched again
// without a blocklist, when the report names exactly that file.
//   node --test test/helper-nohistory.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../helper/lib/config.mjs';
import { report, startWorld } from './helper-fakes.mjs';

const FILE = 'Example Film (2020)/Example.Film.2020.1080p.WEB.mkv';
const NAME = 'Example.Film.2020.1080p.WEB.mkv';

async function film(opts = {}, movie = {}) {
  const t = await startWorld(opts);
  t.w.addUser(5, 4194304);
  t.w.addMovie({ id: 7, title: 'Example Film', tmdbId: 1001, file: FILE, grab: false, ...movie }); // no history at all
  return t;
}
const filmIssue = (t, o = {}) => t.w.addIssue({ id: o.id || 1, mediaType: 'movie', tmdbId: 1001, message: report('video-quality', 'movie', { file: o.file === undefined ? NAME : o.file }), ...o });

// Show 300: S1 E1–E3 rescanned from disk (no history); S1 E4 has its normal history
async function show(opts = {}) {
  const t = await startWorld(opts);
  t.w.addUser(5, 4194304);
  t.w.addSeries({ id: 300, title: 'Example Show', tvdbId: 9300, seasons: { 1: [
    { episode: 1, file: 'Example.Show.S01E01.mkv', importRecord: false, grab: false },
    { episode: 2, file: 'Example.Show.S01E02.mkv', importRecord: false, grab: false, monitored: false },
    { episode: 3, file: 'Example.Show.S01E03.mkv', importRecord: false, grab: false },
    { episode: 4, file: 'Example.Show.S01E04.mkv', downloadId: 'SINGLE4' },
  ] } });
  t.w.mirrorToPlex(300, 800);
  return t;
}
const epIssue = (t, e, o = {}) => t.w.addIssue({
  id: o.id || 1, mediaType: 'tv', tvdbId: 9300, season: 1, episode: e, mediaRatingKey: '800',
  message: report('corrupt', e ? 'episode' : 'season', { season: 1, episode: e, file: o.file === undefined ? `Example.Show.S01E0${e}.mkv` : o.file }),
  ...o,
});
const untouched = (arr) => { assert.deepEqual(arr.failed, []); assert.deepEqual(arr.deleted, []); assert.deepEqual(arr.commands, []); };

test('no history: NO_HISTORY_ACTION defaults to redownload; only exactly "manual" (or anything unknown) waits', () => {
  assert.equal(readConfig({}).noHistoryAction, 'redownload');
  assert.equal(readConfig({ NO_HISTORY_ACTION: 'redownload' }).noHistoryAction, 'redownload');
  assert.equal(readConfig({ NO_HISTORY_ACTION: 'manual' }).noHistoryAction, 'manual');
  assert.equal(readConfig({ NO_HISTORY_ACTION: 'redownload # yes' }).noHistoryAction, 'manual', 'not understood: the careful choice');
});

test('no history: a film is deleted and searched again, with no blocklist call, and the comment says so', async () => {
  const t = await film();
  try {
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    assert.deepEqual(t.w.radarr.failed, [], 'nothing to blocklist');
    assert.deepEqual(t.w.radarr.deleted, [700]);
    assert.deepEqual(t.w.radarr.commands, [{ name: 'MoviesSearch', movieIds: [7] }]);
    assert.equal(t.w.comments(1)[0], 'Fixed automatically: this file had no download history, so nothing could be blocklisted. ' +
      `Deleted \`${NAME}\` and searched for a new copy; the same release may come back. It shows in Plex Lite → Downloading. If the new one is wrong too, report it again.`);
    assert.equal(t.w.seerr.issues.get(1).status, 2);
    assert.equal(t.helper.state.data.handled[1].step, 'searched');
  } finally { await t.close(); }
});

test('no history: an unmonitored episode is monitored and searched with EpisodeSearch', async () => {
  const t = await show();
  try {
    const e2 = t.w.episode(300, 1, 2);
    epIssue(t, 2);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'fixed');
    assert.deepEqual(t.w.sonarr.failed, []);
    assert.deepEqual(t.w.sonarr.deleted, [e2.id + 500000]);
    assert.deepEqual(t.w.sonarr.monitor, [{ episodeIds: [e2.id], monitored: true }]);
    assert.deepEqual(t.w.sonarr.commands, [{ name: 'EpisodeSearch', episodeIds: [e2.id] }]);
    assert.match(t.w.comments(1)[0], /^Fixed automatically: this file had no download history/);
  } finally { await t.close(); }
});

test('no history: without file=, or with another file name, it waits for a person', async () => {
  const t = await film();
  try {
    filmIssue(t, { id: 1, file: null });
    filmIssue(t, { id: 2, file: 'Example.Film.2020.2160p.mkv' });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    assert.match(t.w.comments(1)[0], /no download history.*doesn't name the file/);
    assert.equal((await t.helper.reports.processIssue(2)).outcome, 'ambiguous');
    untouched(t.w.radarr);
  } finally { await t.close(); }
});

test('no history: a season report still waits for a person', async () => {
  const t = await show();
  try {
    t.w.sonarr.episodes = t.w.sonarr.episodes.filter((e) => e.episodeNumber !== 4);
    t.w.sonarr.files = t.w.sonarr.files.filter((f) => !/E04/.test(f.relativePath));
    t.w.mirrorToPlex(300, 800);
    epIssue(t, 0, { file: null });
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    assert.match(t.w.comments(1)[0], /no download history/);
    untouched(t.w.sonarr);
  } finally { await t.close(); }
});

test('no history: history that exists but doesn\'t tie the file to a grab is unchanged (waits)', async () => {
  const t = await film();
  try {
    // an import of this film that points to another (older) file: not "no history"
    t.w.radarr.history.push({ id: 1, movieId: 7, eventType: 'downloadFolderImported', downloadId: 'OLD', data: { importedPath: '/data/movies/Example Film (2020)/Old.Name.mkv' }, date: '2026-09-01T00:00:00Z' });
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    assert.match(t.w.comments(1)[0], /no import record for/);
    untouched(t.w.radarr);
  } finally { await t.close(); }
  // an episode with a grab but no import
  const t2 = await show();
  try {
    const e1 = t2.w.episode(300, 1, 1);
    t2.w.sonarr.history.push({ id: 1, episodeId: e1.id, seriesId: 300, eventType: 'grabbed', downloadId: 'G1', sourceTitle: 'x', data: {}, date: '2026-09-01T00:00:00Z' });
    epIssue(t2, 1);
    assert.equal((await t2.helper.reports.processIssue(1)).outcome, 'ambiguous');
    untouched(t2.w.sonarr);
  } finally { await t2.close(); }
});

test('no history: NO_HISTORY_ACTION=manual waits; dry run only says what it would do', async () => {
  const t = await film({ env: { NO_HISTORY_ACTION: 'manual' } });
  try {
    filmIssue(t);
    assert.equal((await t.helper.reports.processIssue(1)).outcome, 'ambiguous');
    assert.match(t.w.comments(1)[0], /no download history/);
    untouched(t.w.radarr);
  } finally { await t.close(); }
  const t2 = await film({ env: { DRY_RUN: '1' } });
  try {
    filmIssue(t2);
    assert.equal((await t2.helper.reports.processIssue(1)).outcome, 'dry_run');
    untouched(t2.w.radarr);
    assert.equal(t2.w.comments(1)[0], `Dry run (nothing changed): would delete \`${NAME}\` and search for a new copy. It has no download history, so nothing can be blocklisted and the same release may come back.`);
  } finally { await t2.close(); }
});

test('no history: a fix interrupted while deleting says nothing was blocklisted', async () => {
  let t = await film();
  try {
    filmIssue(t);
    t.helper.state.data.handled[1] = { at: t.clock.now(), outcome: 'started', step: 'deleting', arr: 'Radarr', releases: [], noHistory: true };
    t.helper.state.save();
    t = await t.restart();
    await t.helper.start();
    assert.match(t.w.comments(1)[0], /interrupted \(a restart or crash\) while deleting the file \(it had no download history, so nothing was blocklisted\)/);
  } finally { await t.close(); }
});
