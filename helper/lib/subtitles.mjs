// Bazarr: what a title has and lacks, a search-and-download for one language, and a sync.
// Checked against Bazarr's own API code (bazarr/api/*, 1.4.5 and 1.6.2):
//   GET   /api/series?seriesid[]=        → {data: [{sonarrSeriesId, profileId, …}]}
//   GET   /api/episodes?episodeid[]=     → {data: [{sonarrEpisodeId, subtitles, missing_subtitles, …}]}
//   GET   /api/movies?radarrid[]=        → {data: [{radarrId, profileId, subtitles, missing_subtitles, …}]}
//   GET   /api/system/languages/profiles → [{profileId, name, items: [{language, forced, hi}]}]
//   GET   /api/system/languages          → [{name, code2, code3, enabled}]
//   PATCH /api/episodes/subtitles  seriesid, episodeid, language, forced, hi → 204 (search + download)
//   PATCH /api/movies/subtitles    radarrid, language, forced, hi            → 204
//   GET   /api/episodes/history?episodeid=  /api/movies/history?radarrid=  → {data: [...newest first], total}
//   PATCH /api/subtitles  action=sync, language, path, type=episode|movie, id, forced, hi → 204
//   GET   /api/system/jobs (1.5+)        → {data: [{job_name, status}]}
// From 1.5 the download PATCH only queues a job, so the helper watches the title's history for
// the new subtitle (and the jobs list to stop waiting early). 1.4 answers when it's done.
import { episodes, movieByTmdb, seriesByTvdb } from './arr.mjs';
import { HttpError, UpstreamError } from './http.mjs';

const DOWNLOAD_ACTIONS = new Set([1, 2, 3]); // downloaded, manually downloaded, upgraded
const truthy = (v) => v === true || /^true$/i.test(String(v));
const TF = (v) => (truthy(v) ? 'True' : 'False');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeSubtitles({ cfg, svc, plex, now, log }) {
  let langNames = null; // {at, map}
  let jobsSupported = true;

  function need() {
    if (!svc.bazarr) throw new HttpError(503, 'unavailable', 'Bazarr is not configured');
  }

  async function names() {
    if (langNames && now() - langNames.at < 3600 * 1000) return langNames.map;
    const map = new Map();
    try {
      for (const l of (await svc.bazarr.get('/system/languages')) || []) if (l && l.code2) map.set(l.code2, l.name);
    } catch (e) { log(`bazarr languages: ${e.message}`); }
    langNames = { at: now(), map };
    return map;
  }
  async function nameOf(code) {
    const m = await names();
    if (m.get(code)) return m.get(code);
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
  }

  // body or query → the arr and Bazarr ids of one movie or episode
  async function target(p) {
    need();
    const type = String(p.type || '');
    if (type === 'movie') {
      const tmdbId = Number(p.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new HttpError(400, 'bad_request', 'tmdbId is required for a movie');
      if (!svc.radarr) throw new HttpError(503, 'unavailable', 'Radarr is not configured');
      const movie = await movieByTmdb(svc.radarr, tmdbId);
      if (!movie || movie.ambiguous) throw new HttpError(404, 'not_found', 'Radarr does not have this film');
      return { type, tmdbId, radarrId: movie.id, title: movie.title };
    }
    if (type === 'episode') {
      const tvdbId = Number(p.tvdbId);
      const season = Number(p.season);
      const episode = Number(p.episode);
      if (![tvdbId, season, episode].every(Number.isInteger) || tvdbId <= 0) {
        throw new HttpError(400, 'bad_request', 'tvdbId, season and episode are required for an episode');
      }
      if (!svc.sonarr) throw new HttpError(503, 'unavailable', 'Sonarr is not configured');
      const series = await seriesByTvdb(svc.sonarr, tvdbId);
      if (!series || series.ambiguous) throw new HttpError(404, 'not_found', 'Sonarr does not have this show');
      const ep = (await episodes(svc.sonarr, series.id, season)).find((e) => e.episodeNumber === episode);
      if (!ep) throw new HttpError(404, 'not_found', 'Sonarr does not have this episode');
      return { type, tvdbId, tmdbId: Number(series.tmdbId) || 0, season, episode, seriesId: series.id, episodeId: ep.id, title: series.title };
    }
    throw new HttpError(400, 'bad_request', "type must be 'movie' or 'episode'");
  }

  // Bazarr's record for the target plus its language profile id
  async function item(t) {
    if (t.type === 'movie') {
      const r = await svc.bazarr.get('/movies', { 'radarrid[]': t.radarrId });
      const m = ((r && r.data) || [])[0];
      if (!m) throw new HttpError(404, 'not_found', 'Bazarr does not have this film yet');
      return { rec: m, profileId: m.profileId };
    }
    const [s, e] = await Promise.all([
      svc.bazarr.get('/series', { 'seriesid[]': t.seriesId }),
      svc.bazarr.get('/episodes', { 'episodeid[]': t.episodeId }),
    ]);
    const ep = ((e && e.data) || [])[0];
    if (!ep) throw new HttpError(404, 'not_found', 'Bazarr does not have this episode yet');
    const series = ((s && s.data) || [])[0];
    return { rec: ep, profileId: series ? series.profileId : null };
  }

  async function profileLanguages(profileId) {
    if (profileId == null) return [];
    const list = await svc.bazarr.get('/system/languages/profiles');
    const p = (Array.isArray(list) ? list : []).find((x) => Number(x.profileId) === Number(profileId));
    const out = [];
    for (const i of (p && p.items) || []) {
      out.push({ code: i.language, name: await nameOf(i.language), forced: truthy(i.forced), hi: truthy(i.hi) });
    }
    return out;
  }

  const lang = async (x) => ({ code: x.code2, name: x.name || (await nameOf(x.code2)), forced: truthy(x.forced), hi: truthy(x.hi) });

  async function getSubtitles(query) {
    const t = await target(Object.fromEntries(query));
    const { rec, profileId } = await item(t);
    const have = [];
    for (const s of rec.subtitles || []) have.push({ ...(await lang(s)), external: !!s.path });
    const missing = [];
    for (const s of rec.missing_subtitles || []) missing.push(await lang(s));
    return { version: 1, updatedAt: new Date(now()).toISOString(), languages: await profileLanguages(profileId), have, missing };
  }

  async function history(t) {
    const r = t.type === 'movie'
      ? await svc.bazarr.get('/movies/history', { radarrid: t.radarrId, length: 10 })
      : await svc.bazarr.get('/episodes/history', { episodeid: t.episodeId, length: 10 });
    return { total: Number(r && r.total) || 0, data: (r && r.data) || [] };
  }

  async function searchStillRunning() {
    if (!jobsSupported) return false;
    try {
      const r = await svc.bazarr.get('/system/jobs');
      return ((r && r.data) || []).some((j) => /^(pending|running)$/.test(String(j.status)) && /search/i.test(String(j.job_name)));
    } catch (e) {
      if (e instanceof UpstreamError && (e.status === 404 || e.status === 405)) { jobsSupported = false; return false; }
      return true; // unknown: keep waiting until the deadline
    }
  }

  // Search and download the best subtitle for one language → {status, language, provider?}
  async function search(t, language, forced = false, hi = false) {
    const start = now();
    const before = await history(t);
    const form = t.type === 'movie'
      ? { radarrid: t.radarrId, language, forced: TF(forced), hi: TF(hi) }
      : { seriesid: t.seriesId, episodeid: t.episodeId, language, forced: TF(forced), hi: TF(hi) };
    try {
      await svc.bazarr.call('PATCH', t.type === 'movie' ? '/movies/subtitles' : '/episodes/subtitles', {
        form, timeout: (cfg.subtitleWaitSeconds + 15) * 1000,
      });
    } catch (e) {
      if (!(e instanceof UpstreamError) || e.status !== 0) throw e;
      // timed out waiting for Bazarr 1.4's synchronous search: watch the history like 1.5+
    }
    const deadline = start + cfg.subtitleWaitSeconds * 1000;
    for (;;) {
      const h = await history(t);
      const fresh = h.data.slice(0, Math.max(0, h.total - before.total));
      const hit = fresh.find((x) => DOWNLOAD_ACTIONS.has(Number(x.action)) && x.language && x.language.code2 === language);
      if (hit) return { status: 'downloaded', language, provider: hit.provider || null };
      if (now() >= deadline || !(await searchStillRunning())) {
        // one last look: the job may have finished between the two calls
        const last = await history(t);
        const lastFresh = last.data.slice(0, Math.max(0, last.total - before.total));
        const hit2 = lastFresh.find((x) => DOWNLOAD_ACTIONS.has(Number(x.action)) && x.language && x.language.code2 === language);
        return hit2 ? { status: 'downloaded', language, provider: hit2.provider || null } : { status: 'not_found' };
      }
      await sleep(cfg.pollMs);
    }
  }

  async function searchAction(body) {
    const t = await target(body);
    let language = body.language ? String(body.language) : null;
    if (!language) {
      const { profileId } = await item(t);
      const langs = await profileLanguages(profileId);
      if (!langs.length) throw new HttpError(400, 'bad_request', 'language is required (this title has no Bazarr language profile)');
      language = langs[0].code;
    } else await item(t); // 404 when Bazarr doesn't know the title
    if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) throw new HttpError(400, 'bad_request', 'language must be a code such as en');
    if (cfg.dryRun) {
      log(`dry run: would ask Bazarr for ${language} subtitles for ${describe(t)}`);
      return { status: 'dry_run', dryRun: true, language };
    }
    const r = await search(t, language, truthy(body.forced), truthy(body.hi));
    log(`subtitle search ${language} for ${describe(t)}: ${r.status}${r.provider ? ` (${r.provider})` : ''}`);
    if (r.status === 'downloaded') r.plexRefreshed = await plex.refresh(t, body.ratingKey);
    return r;
  }

  async function syncAction(body) {
    const t = await target(body);
    const language = body.language ? String(body.language) : '';
    if (!language) throw new HttpError(400, 'bad_request', 'language is required');
    const { rec } = await item(t);
    const forced = truthy(body.forced);
    const hi = truthy(body.hi);
    const sub = (rec.subtitles || []).find((s) => s.code2 === language && !!s.path && truthy(s.forced) === forced && truthy(s.hi) === hi)
      || (rec.subtitles || []).find((s) => s.code2 === language && !!s.path);
    if (!sub) throw new HttpError(404, 'not_found', `no external ${language} subtitle to sync`);
    if (cfg.dryRun) {
      log(`dry run: would ask Bazarr to sync the ${language} subtitle of ${describe(t)}`);
      return { status: 'dry_run', dryRun: true };
    }
    try {
      await svc.bazarr.call('PATCH', '/subtitles', {
        form: {
          action: 'sync', language, path: sub.path, type: t.type, id: t.type === 'movie' ? t.radarrId : t.episodeId,
          forced: TF(sub.forced), hi: TF(sub.hi),
        },
        timeout: 10000,
      });
    } catch (e) {
      // an older Bazarr syncs before answering: a timeout means it is still at it
      if (!(e instanceof UpstreamError) || e.status !== 0) throw e;
    }
    log(`subtitle sync ${language} for ${describe(t)} queued`);
    return { status: 'queued' };
  }

  return { target, item, search, profileLanguages, getSubtitles, searchAction, syncAction };
}

export function describe(t) {
  if (t.type === 'movie') return `${t.title || 'movie'} (tmdb ${t.tmdbId})`;
  return `${t.title || 'show'} S${t.season} E${t.episode}`;
}
