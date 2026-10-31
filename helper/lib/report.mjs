// "Report a problem": a Seerr issue → blocklist the release, delete the file, search again (or a
// Bazarr search for missing subtitles), then comment on the issue and resolve it. The Seerr
// webhook is only a trigger: the issue is always re-read from Seerr (spec: notes 09 §5–6).
import {
  basename, EVENT, episodes, isEvent, movieByTmdb, queue, rootFolders, seriesByTvdb, underRoot,
} from './arr.mjs';
import { HttpError, UpstreamError } from './http.mjs';

const DAY = 24 * 3600 * 1000;
const PERM = { ADMIN: 2, MANAGE_ISSUES: 1048576, CREATE_ISSUES: 4194304 };
export const DRY_PREFIX = 'Dry run (nothing changed): ';

export const REASONS = {
  'video-quality': 'poor video quality',
  'audio-language': 'wrong audio language',
  'out-of-sync': 'audio out of sync',
  corrupt: 'stutters or looks corrupt',
  'wrong-item': 'the wrong film or episode',
  'subs-missing': 'subtitles missing',
  'subs-burned': 'burned-in subtitles',
  subtitles: 'subtitles missing or burned in',
  other: 'something else',
};
// Seerr's own issue types, for issues made in Seerr's web UI (no plexlite: line)
const FROM_TYPE = { 1: 'video-quality', 2: 'audio-language', 3: 'subtitles', 4: 'other' };

// "plexlite: reason=…; scope=…; season=1; …" → {reason, scope, season, episode, plex, file, versions}
export function parseTail(message) {
  const line = String(message || '').split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => /^plexlite:/i.test(l));
  if (!line) return null;
  const out = {};
  for (const part of line.replace(/^plexlite:\s*/i, '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sortComments = (list) => [...(list || [])].sort((a, b) => (a.id || 0) - (b.id || 0) || Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
const isDryComment = (c) => String((c && c.message) || '').startsWith(DRY_PREFIX);
const epLabel = (s, e) => (e ? `S${s} E${e}` : `Season ${s}`);
const nameForPlex = (s) => basename(s).replace(/;/g, ',');

export function makeReports({ cfg, svc, state, plex, subs, now, log, isPaused }) {
  let chain = Promise.resolve();

  function enqueue(id, source) {
    const run = chain.then(() => processIssue(id, source)).catch((e) => {
      log(`issue #${id}: unexpected error ${e && e.stack ? e.stack : e}`);
      return { outcome: 'error' };
    });
    chain = run;
    return run;
  }

  async function comment(id, text, dry) {
    const message = (dry ? DRY_PREFIX : '') + text;
    try {
      await svc.seerr.post(`/issue/${id}/comment`, { message });
    } catch (e) {
      log(`issue #${id}: comment failed: ${e.message}`);
    }
    return message;
  }

  async function resolve(id) {
    try { await svc.seerr.post(`/issue/${id}/resolved`); } catch (e) { log(`issue #${id}: resolve failed: ${e.message}`); }
  }

  // ---------------------------------------------------------------------------------------------
  async function processIssue(rawId, source = 'webhook') {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return { outcome: 'bad_id' };
    if (!svc.seerr) { log(`issue #${id}: Seerr is not configured`); return { outcome: 'unavailable' }; }
    const dry = cfg.dryRun;
    if (state.isHandled(id, dry)) { log(`issue #${id}: already handled`); return { outcome: 'already_handled' }; }

    let issue;
    try {
      issue = await svc.seerr.get(`/issue/${id}`);
      // the webhook can arrive a moment before the report's comment is readable: look once more
      if (source === 'webhook' && !(issue.comments || []).length) {
        await new Promise((r) => setTimeout(r, cfg.pollMs));
        issue = await svc.seerr.get(`/issue/${id}`);
      }
    } catch (e) {
      log(`issue #${id}: can't read it from Seerr: ${e.message}`);
      return { outcome: e.status === 404 ? 'not_found' : 'error' };
    }

    // ---- only untouched, open, recent reports (spec 09 §6) ----
    const comments = sortComments(issue.comments);
    const reporterComments = comments.filter((c) => !isDryComment(c));
    const first = reporterComments[0];
    const tail = first ? parseTail(first.message) : null;
    const age = now() - Date.parse(issue.createdAt);
    const maxAge = source === 'backfill' ? cfg.backfillDays * DAY : cfg.maxIssueAgeMinutes * 60000;
    const skip = (outcome, why) => { log(`issue #${id}: skipped (${why})`); return { outcome }; };
    if (Number(issue.status) !== 1) return skip('not_open', 'not open');
    if (!(age <= maxAge)) return skip('too_old', `created ${Math.round(age / 60000)} min ago`);
    if (reporterComments.length !== 1) return skip('touched', `${reporterComments.length} comments`);
    if (source === 'backfill' && !tail) return skip('no_tail', 'not from Plex Lite');

    // recorded before any comment or change: an issue is processed once, even across restarts
    state.markHandled(id, dry, 'started');
    const done = (outcome, extra = {}) => { state.setOutcome(id, dry, outcome); return { outcome, ...extra }; };
    const media = issue.media || {};
    const userId = issue.createdBy && issue.createdBy.id;
    const ctx = { id, dry, issue, media, userId, tail: tail || {} };

    try {
      // ---- the report ----
      let reason = tail && tail.reason ? tail.reason : FROM_TYPE[issue.issueType] || 'other';
      if (!REASONS[reason]) reason = 'other';
      const season = Number(issue.problemSeason) || 0;
      const episode = Number(issue.problemEpisode) || 0;
      const isMovie = media.mediaType === 'movie';
      const scope = isMovie ? 'movie' : episode ? 'episode' : season ? 'season' : 'show';
      Object.assign(ctx, { reason, season, episode, scope });
      log(`issue #${id}: user ${userId}, ${media.mediaType} tmdb ${media.tmdbId || '-'} tvdb ${media.tvdbId || '-'}, ` +
        `${scope}${season ? ` S${season}` : ''}${episode ? ` E${episode}` : ''}, reason ${reason}, ${source}${dry ? ', dry run' : ''}`);

      if (tail && ((tail.scope && tail.scope !== scope) || (Number(tail.season) || 0) !== season || (Number(tail.episode) || 0) !== episode)) {
        await comment(id, 'Not fixed automatically: the report\'s details don\'t match the issue\'s season and episode. Left for a person.', dry);
        return done('ambiguous');
      }

      // ---- who may trigger automatic fixes (re-checked now) ----
      let perms = 0;
      try {
        const user = await svc.seerr.get(`/user/${userId}`);
        perms = Number(user && user.permissions) || 0;
      } catch (e) { log(`issue #${id}: user ${userId} lookup failed: ${e.message}`); }
      const allowed = (perms & (PERM.ADMIN | PERM.MANAGE_ISSUES | PERM.CREATE_ISSUES)) && !cfg.denyUsers.includes(Number(userId));
      if (!allowed) {
        await comment(id, 'Not fixed automatically: this account can\'t trigger automatic fixes. Left for a person.', dry);
        return done('not_allowed');
      }

      if (reason === 'other' && cfg.otherAction === 'manual') {
        await comment(id, 'A person will look at this.', dry);
        return done('manual');
      }
      if (scope === 'show') {
        await comment(id, 'Whole-show reports need a person: report a season or an episode.', dry);
        return done('manual');
      }
      if (reason === 'subs-missing') return done(...(await subtitleFlow(ctx)));
      return done(...(await regrabFlow(ctx)));
    } catch (e) {
      log(`issue #${id}: error: ${e.message}`);
      await comment(id, `Not fixed automatically: the helper hit an error (${e.message}). Left for a person.`, dry);
      return done('error');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Missing subtitles → Bazarr (no delete)
  async function subtitleFlow(ctx) {
    const { id, dry, media, scope, season, episode } = ctx;
    if (!svc.bazarr) {
      await comment(id, 'Bazarr isn\'t set up on the home server helper, so missing subtitles need a person.', dry);
      return ['manual'];
    }
    // the movie or episodes in scope
    let targets = [];
    if (scope === 'movie') {
      targets = [await subs.target({ type: 'movie', tmdbId: media.tmdbId })];
    } else {
      const tvdbId = await tvdbFor(media);
      const series = tvdbId ? await seriesByTvdb(svc.sonarr, tvdbId) : null;
      if (!series || series.ambiguous) throw new Error('Sonarr doesn\'t have exactly one show for this title');
      const eps = (await episodes(svc.sonarr, series.id, season))
        .filter((e) => e.hasFile && (scope === 'season' || e.episodeNumber === episode));
      if (!eps.length) {
        await comment(id, `Not fixed automatically: Sonarr has no file for ${epLabel(season, episode)}. Left for a person.`, dry);
        return ['no_file'];
      }
      if (eps.length > cfg.maxFilesPerIssue) {
        await comment(id, `Not fixed automatically: ${eps.length} episodes is more than this helper handles at once (${cfg.maxFilesPerIssue}). Left for a person.`, dry);
        return ['limit'];
      }
      targets = eps.map((e) => ({ type: 'episode', tvdbId, tmdbId: Number(series.tmdbId) || 0, season: e.seasonNumber, episode: e.episodeNumber, seriesId: series.id, episodeId: e.id, title: series.title }));
    }
    const plan = [];
    const have = new Set();
    for (const t of targets) {
      let rec;
      try { rec = (await subs.item(t)).rec; } catch (e) {
        if (e instanceof HttpError && e.status === 404) continue;
        throw e;
      }
      for (const m of rec.missing_subtitles || []) plan.push({ t, code: m.code2, name: m.name || m.code2, forced: !!m.forced, hi: !!m.hi });
      for (const s of rec.subtitles || []) have.add(s.name || s.code2);
    }
    const where = (t) => (t.type === 'movie' ? '' : ` for ${epLabel(t.season, t.episode)}`);
    const refreshKey = scope === 'movie' || scope === 'episode' ? ctx.tail.plex : media.ratingKey;
    const refreshTarget = scope === 'season' ? { ...targets[0], type: 'show' } : targets[0];

    if (!plan.length) {
      if (!dry) await plex.refresh(refreshTarget, refreshKey);
      const list = [...have].join(', ');
      await comment(id, `${list ? `Bazarr already has ${list} subtitles for this` : 'Bazarr lists no missing subtitles for this'}` +
        `${plex.canRefresh() ? '; asked Plex to refresh' : ''}. If they still don't show, a person will look.`, dry);
      return ['nothing_missing'];
    }
    if (dry) {
      await comment(id, `would ask Bazarr for ${plan.map((p) => `${p.name}${p.forced ? ' (forced)' : ''}${where(p.t)}`).join(', ')}.`, true);
      return ['dry_run', { plan: plan.length }];
    }
    const found = [];
    const notFound = [];
    for (const p of plan) {
      const r = await subs.search(p.t, p.code, p.forced, p.hi);
      (r.status === 'downloaded' ? found : notFound).push(`${p.name}${where(p.t)}${r.provider ? ` (${r.provider})` : ''}`);
    }
    log(`issue #${id}: subtitles found ${found.length}, not found ${notFound.length}`);
    if (!found.length) {
      await comment(id, `Bazarr searched for ${notFound.join(', ')} but found nothing. Left open for a person.`, false);
      return ['subs_not_found'];
    }
    const refreshed = await plex.refresh(refreshTarget, refreshKey);
    await comment(id, `Fixed automatically: Bazarr downloaded ${found.join(', ')}.` +
      `${notFound.length ? ` Still missing: ${notFound.join(', ')}.` : ''}` +
      `${refreshed ? ' Plex is refreshing, so they show in a minute.' : ''} If they're wrong, report it again.`, false);
    await resolve(id);
    return ['subs_fixed', { found: found.length }];
  }

  async function tvdbFor(media) {
    if (Number(media.tvdbId)) return Number(media.tvdbId);
    if (!media.tmdbId) return 0;
    const tv = await svc.seerr.get(`/tv/${media.tmdbId}`);
    return Number(tv && tv.externalIds && tv.externalIds.tvdbId) || 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Blocklist → delete → search
  async function regrabFlow(ctx) {
    const { id, dry, media, scope, season, episode, reason, userId } = ctx;
    const arr = scope === 'movie' ? svc.radarr : svc.sonarr;
    if (!arr) {
      await comment(id, `Not fixed automatically: ${scope === 'movie' ? 'Radarr' : 'Sonarr'} isn't set up on the helper. Left for a person.`, dry);
      return ['unavailable'];
    }
    const tvdbId = scope === 'movie' ? 0 : await tvdbFor(media);
    const titleKey = scope === 'movie' ? `movie:${media.tmdbId}` : `tv:${tvdbId}:s${season}`;
    const itemKey = scope === 'episode' ? `${titleKey}e${episode}` : titleKey;

    if (reason === 'wrong-item' && state.priorReports('wrong-item', itemKey).length) {
      await comment(id, 'Not fixed automatically: this is the second "wrong film/episode" report for it within 7 days, which usually means a numbering or mapping problem in ' +
        `${scope === 'movie' ? 'Radarr' : 'Sonarr'}. Left for a person.`, dry);
      return ['repeat_wrong_item'];
    }
    const counts = state.regrabCounts(Number(userId), titleKey);
    const over = counts.user24h >= cfg.limitPerUser24h ? `${cfg.limitPerUser24h} automatic fixes per person per day`
      : counts.total24h >= cfg.limitTotal24h ? `${cfg.limitTotal24h} automatic fixes per day`
        : counts.title7d >= cfg.limitPerTitle7d ? `${cfg.limitPerTitle7d} automatic fixes per title per week` : null;
    if (over) {
      await comment(id, `Not fixed automatically: limit reached (${over}). Left for a person.`, dry);
      return ['limit'];
    }

    const plan = scope === 'movie' ? await planRadarr(ctx) : await planSonarr(ctx, tvdbId);
    if (!plan.ok) {
      log(`issue #${id}: stopped: ${plan.why}`);
      await comment(id, `Not fixed automatically: ${plan.why}. Nothing was changed; left for a person.`, dry);
      return ['ambiguous'];
    }
    const releases = plan.grabs.map((g) => `\`${g.release}\``).join(', ');
    const fileNames = plan.files.map((f) => `\`${basename(f.relativePath)}\``).join(', ');
    const searchWhat = plan.seasonSearch ? `a season search for Season ${season}` : 'a search for a new copy';
    log(`issue #${id}: plan: blocklist ${plan.grabs.length} grab(s) [${plan.grabs.map((g) => g.grabbedId).join(',')}], ` +
      `delete ${plan.files.length} file(s) [${plan.files.map((f) => f.id).join(',')}], ${searchWhat}`);
    if (dry) {
      await comment(id, `would blocklist ${releases}, delete ${fileNames} and start ${searchWhat}.`, true);
      return ['dry_run', { plan }];
    }

    // counted before the first destructive call
    state.recordRegrab(Number(userId), titleKey, id);
    const earlierLanguage = reason === 'audio-language' ? state.priorReports('audio-language', titleKey).length : 0;
    state.recordReport(reason, itemKey, id);
    if (reason === 'audio-language' && itemKey !== titleKey) state.recordReport(reason, titleKey, id);

    for (const g of plan.grabs) {
      try {
        await arr.post(`/history/failed/${g.grabbedId}`);
      } catch (e) {
        await comment(id, `Not fixed automatically: blocklisting \`${g.release}\` failed (${e.message}). Nothing was deleted; left for a person.`, false);
        return ['error'];
      }
    }
    try {
      if (scope === 'movie') await arr.del(`/moviefile/${plan.files[0].id}`);
      else if (plan.files.length === 1) await arr.del(`/episodefile/${plan.files[0].id}`);
      else await arr.call('DELETE', '/episodefile/bulk', { body: { episodeFileIds: plan.files.map((f) => f.id) } });
    } catch (e) {
      await comment(id, `Not fixed automatically: blocklisted ${releases}, but deleting the file failed (${e.message}), so no search was started. Left for a person.`, false);
      return ['error'];
    }
    // "Unmonitor deleted …" would stop the search finding anything
    try {
      if (scope === 'movie') {
        const m = await arr.get(`/movie/${plan.movieId}`);
        if (m && m.monitored === false) await arr.put('/movie/editor', { movieIds: [plan.movieId], monitored: true });
      } else {
        await arr.put('/episode/monitor', { episodeIds: plan.episodeIds, monitored: true });
      }
    } catch (e) { log(`issue #${id}: re-monitoring failed: ${e.message}`); }
    try {
      if (scope === 'movie') await arr.post('/command', { name: 'MoviesSearch', movieIds: [plan.movieId] });
      else if (plan.seasonSearch) await arr.post('/command', { name: 'SeasonSearch', seriesId: plan.seriesId, seasonNumber: season });
      else await arr.post('/command', { name: 'EpisodeSearch', episodeIds: plan.episodeIds });
    } catch (e) {
      await comment(id, `Blocklisted ${releases} and deleted the file, but starting the search failed (${e.message}). Left open: search for it in ${scope === 'movie' ? 'Radarr' : 'Sonarr'}.`, false);
      return ['search_failed'];
    }
    let text = `Fixed automatically: blocklisted ${releases}, deleted the file and searched for a new copy. It shows in Plex Lite → Downloading. If the new one is wrong too, report it again.`;
    if (earlierLanguage) text += ' This title was reported for the wrong language before: if every release is in that language, the next copy may be too.';
    await comment(id, text, false);
    await resolve(id);
    log(`issue #${id}: fixed`);
    return ['fixed'];
  }

  // the import of `file` and the one grab that brought it, or a reason to stop
  async function grabFor(arr, importRecords, file, single) {
    const imports = importRecords.filter((r) => isEvent(r, 'downloadFolderImported') && r.data && String(r.data.importedPath || '').endsWith(file.relativePath));
    const ids = [...new Set(imports.map((r) => r.downloadId).filter(Boolean))];
    if (!imports.length) return { why: `no import record for \`${basename(file.relativePath)}\` (imported by hand?)` };
    if (!ids.length) return { why: `the import of \`${basename(file.relativePath)}\` has no download id (imported by hand?)` };
    if (ids.length > 1) return { why: `\`${basename(file.relativePath)}\` was imported from ${ids.length} different downloads` };
    const r = await arr.get('/history', { downloadId: ids[0], eventType: EVENT.grabbed, page: 1, pageSize: 50 });
    const grabs = ((r && r.records) || []).filter((x) => isEvent(x, 'grabbed') && x.downloadId === ids[0]);
    if (!grabs.length) return { why: `no grab record for the download of \`${basename(file.relativePath)}\`` };
    // Radarr: exactly one. Sonarr writes one grabbed record per episode of a pack (same download).
    if (single && grabs.length !== 1) return { why: `${grabs.length} grab records for the download of \`${basename(file.relativePath)}\`` };
    return { grab: { grabbedId: grabs[0].id, downloadId: ids[0], release: grabs[0].sourceTitle || basename(file.relativePath) } };
  }

  function fileMismatch(tail, names) {
    if (!tail.file) return false;
    return !names.filter(Boolean).map(nameForPlex).includes(tail.file);
  }

  async function planRadarr(ctx) {
    const { media, tail } = ctx;
    const movie = await movieByTmdb(svc.radarr, media.tmdbId);
    if (!movie || movie.ambiguous) return { why: `Radarr doesn't have exactly one film with TMDB id ${media.tmdbId}` };
    if (!movie.hasFile) return { why: `Radarr has no file for ${movie.title}` };
    let file = movie.movieFile;
    if (!file || !file.id) file = ((await svc.radarr.get('/moviefile', { movieId: movie.id })) || [])[0];
    if (!file) return { why: `Radarr has no file for ${movie.title}` };
    if (fileMismatch(tail, [file.relativePath, file.originalFilePath])) {
      return { why: `the file Plex played (\`${tail.file}\`) isn't Radarr's file (\`${basename(file.relativePath)}\`): probably another version` };
    }
    const roots = await rootFolders(svc.radarr);
    if (!underRoot(file.path, roots)) return { why: `Radarr's file isn't under one of its root folders` };
    const q = await queue(svc.radarr, { movieIds: movie.id });
    if (q.some((x) => x.movieId === movie.id)) return { why: `a download for ${movie.title} is already in Radarr's queue` };
    const hist = await svc.radarr.get('/history/movie', { movieId: movie.id, eventType: 'downloadFolderImported' });
    const g = await grabFor(svc.radarr, Array.isArray(hist) ? hist : [], file, true);
    if (!g.grab) return { why: g.why };
    ctx.title = movie.title;
    return { ok: true, grabs: [g.grab], files: [file], movieId: movie.id };
  }

  async function planSonarr(ctx, tvdbId) {
    const { scope, season, episode, tail } = ctx;
    if (!tvdbId) return { why: 'the issue has no TVDB id' };
    const series = await seriesByTvdb(svc.sonarr, tvdbId);
    if (!series || series.ambiguous) return { why: `Sonarr doesn't have exactly one show with TVDB id ${tvdbId}` };
    const eps = await episodes(svc.sonarr, series.id, season);
    let inScope;
    if (scope === 'episode') {
      const ep = eps.find((e) => e.episodeNumber === episode);
      if (!ep) return { why: `Sonarr has no ${epLabel(season, episode)}` };
      if (!ep.hasFile || !ep.episodeFileId) return { why: `Sonarr has no file for ${epLabel(season, episode)}` };
      inScope = [ep];
    } else {
      inScope = eps.filter((e) => e.hasFile && e.episodeFileId);
      if (!inScope.length) return { why: `Sonarr has no files in Season ${season}` };
    }
    const fileIds = [...new Set(inScope.map((e) => e.episodeFileId))];
    if (fileIds.length > cfg.maxFilesPerIssue) return { why: `${fileIds.length} files is more than this helper handles at once (${cfg.maxFilesPerIssue})` };
    const allFiles = await svc.sonarr.get('/episodefile', { seriesId: series.id });
    const files = fileIds.map((fid) => (allFiles || []).find((f) => f.id === fid));
    if (files.some((f) => !f)) return { why: 'Sonarr\'s file list doesn\'t match its episodes' };
    if (scope === 'episode' && fileMismatch(tail, [files[0].relativePath])) {
      return { why: `the file Plex played (\`${tail.file}\`) isn't Sonarr's file (\`${basename(files[0].relativePath)}\`): probably another version` };
    }
    const roots = await rootFolders(svc.sonarr);
    if (files.some((f) => !underRoot(f.path, roots))) return { why: 'a file isn\'t under one of Sonarr\'s root folders' };
    // every episode those files hold (a multi-episode file covers several)
    const affected = eps.filter((e) => fileIds.includes(e.episodeFileId));
    const q = await queue(svc.sonarr, { seriesIds: series.id });
    const affectedIds = new Set(affected.map((e) => e.id));
    if (q.some((x) => affectedIds.has(x.episodeId) || (scope === 'season' && x.seriesId === series.id && x.seasonNumber === season))) {
      return { why: `a download for ${scope === 'season' ? `Season ${season}` : epLabel(season, episode)} is already in Sonarr's queue` };
    }
    const grabs = new Map();
    for (const f of files) {
      const ep = affected.find((e) => e.episodeFileId === f.id);
      const r = await svc.sonarr.get('/history', { episodeId: ep.id, eventType: EVENT.downloadFolderImported, page: 1, pageSize: 50, sortKey: 'date', sortDirection: 'descending' });
      const g = await grabFor(svc.sonarr, (r && r.records) || [], f, false);
      // one ambiguous file stops the whole issue
      if (!g.grab) return { why: g.why };
      if (!grabs.has(g.grab.downloadId)) grabs.set(g.grab.downloadId, g.grab);
    }
    ctx.title = series.title;
    return {
      ok: true, grabs: [...grabs.values()], files, seriesId: series.id,
      episodeIds: affected.map((e) => e.id), seasonSearch: scope === 'season',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // On start: open Plex Lite reports from the last BACKFILL_DAYS that predate the helper (or a
  // restart) are processed once.
  async function backfill() {
    if (!cfg.backfillDays || !svc.seerr) return [];
    if (isPaused()) { log('backfill skipped: paused'); return []; }
    const since = now() - cfg.backfillDays * DAY;
    const ids = [];
    try {
      for (let skip = 0; skip < 2000; skip += 50) {
        const r = await svc.seerr.get('/issue', { take: 50, skip, sort: 'added', filter: 'open' });
        const list = (r && r.results) || [];
        let older = false;
        for (const i of list) {
          if (Date.parse(i.createdAt) < since) { older = true; continue; }
          const plexlite = (i.comments || []).some((c) => parseTail(c.message));
          if (plexlite && !state.isHandled(i.id, cfg.dryRun)) ids.push(i.id);
        }
        if (older || list.length < 50) break;
      }
    } catch (e) {
      log(`backfill: can't list Seerr issues: ${e.message}`);
      return null;
    }
    ids.sort((a, b) => a - b);
    log(`backfill: ${ids.length} open Plex Lite report(s) from the last ${cfg.backfillDays} days to look at`);
    const results = [];
    for (const id of ids) results.push({ id, ...(await enqueue(id, 'backfill')) });
    return results;
  }

  return { enqueue, processIssue, backfill, idle: () => chain };
}

export { UpstreamError };
