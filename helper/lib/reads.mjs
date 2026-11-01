// GET /queue, GET /coming, GET /missing and POST /missing/search.
import { episodes, images, queue, seriesByTvdb, timeleftSeconds } from './arr.mjs';
import { HttpError } from './http.mjs';

const DAY = 24 * 3600 * 1000;
const iso = (t) => new Date(t).toISOString();

export function makeReads({ cfg, svc, now, log }) {
  let queueCache = null; // {at, body}

  // ---- /queue (spec 09 §7; parsed by plugins/overseerr/seerr.js → fromHelper) ----
  function queueItem(source, q) {
    const tv = source === 'sonarr';
    const media = tv ? q.series || {} : q.movie || {};
    const ep = q.episode || {};
    return {
      source,
      id: `${source}-${q.id}`,
      mediaType: tv ? 'tv' : 'movie',
      tmdbId: Number(media.tmdbId) || 0,
      tvdbId: tv ? Number(media.tvdbId) || 0 : 0,
      imdbId: media.imdbId || null,
      title: media.title || q.title || '',
      year: Number(media.year) || null,
      season: tv ? (q.seasonNumber != null ? q.seasonNumber : ep.seasonNumber != null ? ep.seasonNumber : null) : null,
      episode: tv ? (ep.episodeNumber != null ? ep.episodeNumber : null) : null,
      episodeTitle: tv ? ep.title || null : null,
      releaseTitle: q.title || '',
      status: String(q.status || 'unknown').toLowerCase(),
      trackedState: q.trackedDownloadState || null,
      size: Number(q.size) || 0,
      sizeLeft: Number(q.sizeleft != null ? q.sizeleft : q.sizeLeft) || 0,
      timeLeftSeconds: timeleftSeconds(q.timeleft),
      eta: q.estimatedCompletionTime || null,
      quality: (q.quality && q.quality.quality && q.quality.quality.name) || null,
      protocol: q.protocol || null,
      ...images(media.images),
      errorMessage: q.errorMessage || null,
    };
  }

  async function getQueue() {
    if (!svc.sonarr && !svc.radarr) throw new HttpError(503, 'unavailable', 'neither Sonarr nor Radarr is configured');
    if (queueCache && now() - queueCache.at < 5000) return queueCache.body;
    const [r, s] = await Promise.all([
      svc.radarr ? queue(svc.radarr, { includeMovie: true }) : [],
      svc.sonarr ? queue(svc.sonarr, { includeSeries: true, includeEpisode: true }) : [],
    ]);
    const body = {
      version: 1,
      updatedAt: iso(now()),
      items: [...r.map((q) => queueItem('radarr', q)), ...s.map((q) => queueItem('sonarr', q))],
    };
    queueCache = { at: now(), body };
    return body;
  }

  // ---- /coming ----
  const RADARR_DATES = [['digitalRelease', 'digital'], ['physicalRelease', 'physical'], ['inCinemas', 'cinema']];

  async function getComing(query) {
    if (!svc.sonarr && !svc.radarr) throw new HttpError(503, 'unavailable', 'neither Sonarr nor Radarr is configured');
    const raw = query.get('days');
    let days = raw == null || raw === '' ? 7 : Number(raw);
    if (!Number.isFinite(days)) throw new HttpError(400, 'bad_request', 'days must be a number from 1 to 30');
    days = Math.min(30, Math.max(1, Math.round(days)));
    const start = now() - 2 * DAY;
    const end = now() + days * DAY;
    const range = { start: iso(start), end: iso(end), unmonitored: false };
    const [tv, films] = await Promise.all([
      svc.sonarr ? svc.sonarr.get('/calendar', { ...range, includeSeries: true }) : [],
      svc.radarr ? svc.radarr.get('/calendar', range) : [],
    ]);
    const items = [];
    for (const e of Array.isArray(tv) ? tv : []) {
      const s = e.series || {};
      if (!e.monitored || s.monitored === false || !e.airDateUtc) continue;
      const t = Date.parse(e.airDateUtc);
      if (!(t >= start && t <= end)) continue;
      items.push({
        source: 'sonarr', mediaType: 'tv',
        tmdbId: Number(s.tmdbId) || 0, tvdbId: Number(s.tvdbId) || 0, imdbId: s.imdbId || null,
        title: s.title || '', year: Number(s.year) || null,
        season: e.seasonNumber, episode: e.episodeNumber, episodeTitle: e.title || null,
        airDateUtc: e.airDateUtc,
        seasonPremiere: e.episodeNumber === 1,
        seriesPremiere: e.seasonNumber === 1 && e.episodeNumber === 1,
        hasFile: !!e.hasFile,
        ...images(s.images),
        _t: t,
      });
    }
    for (const m of Array.isArray(films) ? films : []) {
      if (!m.monitored) continue;
      // the digital date when there is one, else physical, else cinema; shown only if that date
      // is in the window (a film in cinemas now but out digitally in March isn't "arriving soon")
      const found = RADARR_DATES.find(([k]) => m[k]);
      if (!found) continue;
      const t = Date.parse(m[found[0]]);
      if (!(t >= start && t <= end)) continue;
      items.push({
        source: 'radarr', mediaType: 'movie',
        tmdbId: Number(m.tmdbId) || 0, tvdbId: 0, imdbId: m.imdbId || null,
        title: m.title || '', year: Number(m.year) || null,
        releaseDate: m[found[0]], releaseType: found[1],
        hasFile: !!m.hasFile,
        ...images(m.images),
        _t: t,
      });
    }
    items.sort((a, b) => a._t - b._t || String(a.title).localeCompare(String(b.title)) || (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
    for (const i of items) delete i._t;
    return { version: 1, updatedAt: iso(now()), items };
  }

  // ---- /missing ----
  const aired = (e) => e.airDateUtc && Date.parse(e.airDateUtc) <= now();

  async function showEpisodes(tvdbId) {
    if (!svc.sonarr) throw new HttpError(503, 'unavailable', 'Sonarr is not configured');
    const id = Number(tvdbId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_request', 'tvdbId is required');
    const series = await seriesByTvdb(svc.sonarr, id);
    if (!series || series.ambiguous) throw new HttpError(404, 'not_found', 'Sonarr does not have this show');
    return { series, eps: await episodes(svc.sonarr, series.id) };
  }

  function seasonMonitored(series, n) {
    const s = (series.seasons || []).find((x) => x.seasonNumber === n);
    return s ? s.monitored !== false : true;
  }

  async function getMissing(query) {
    const { series, eps } = await showEpisodes(query.get('tvdbId'));
    const bySeason = new Map();
    for (const e of eps) {
      if (!aired(e)) continue;
      // specials only when their season is monitored
      if (e.seasonNumber === 0 && !seasonMonitored(series, 0)) continue;
      if (!bySeason.has(e.seasonNumber)) bySeason.set(e.seasonNumber, []);
      bySeason.get(e.seasonNumber).push(e);
    }
    const seasons = [...bySeason.keys()].sort((a, b) => a - b).map((n) => {
      const list = bySeason.get(n).sort((a, b) => a.episodeNumber - b.episodeNumber);
      return {
        season: n,
        monitored: seasonMonitored(series, n),
        episodes: list.length,
        have: list.filter((e) => e.hasFile).length,
        missing: list.filter((e) => e.monitored && !e.hasFile)
          .map((e) => ({ episode: e.episodeNumber, title: e.title || null, airDateUtc: e.airDateUtc })),
      };
    });
    return { version: 1, updatedAt: iso(now()), monitored: series.monitored !== false, seasons };
  }

  async function missingSearch(body) {
    const { series, eps } = await showEpisodes(body.tvdbId);
    const season = body.season == null || body.season === '' ? null : Number(body.season);
    const episode = body.episode == null || body.episode === '' ? null : Number(body.episode);
    if ((season != null && !Number.isInteger(season)) || (episode != null && (!Number.isInteger(episode) || season == null))) {
      throw new HttpError(400, 'bad_request', 'season and episode must be numbers (episode needs a season)');
    }
    const inScope = eps.filter((e) => aired(e) && (season == null ? e.seasonNumber > 0 : e.seasonNumber === season)
      && (episode == null || e.episodeNumber === episode));
    // already downloading: don't search again
    const queued = new Set((await queue(svc.sonarr, { seriesIds: series.id })).map((q) => q.episodeId));
    const missing = inScope.filter((e) => e.monitored && !e.hasFile && !queued.has(e.id));
    const seasonSearches = [];
    let episodeIds = [];
    for (const n of [...new Set(missing.map((e) => e.seasonNumber))]) {
      const airedInSeason = inScope.filter((e) => e.seasonNumber === n);
      const missingInSeason = missing.filter((e) => e.seasonNumber === n);
      // a season pack search when the whole aired season is missing (and it's more than one episode)
      if (episode == null && missingInSeason.length > 1 && missingInSeason.length === airedInSeason.length) seasonSearches.push(n);
      else episodeIds = episodeIds.concat(missingInSeason.map((e) => e.id));
    }
    const what = [...seasonSearches.map((n) => `SeasonSearch S${n}`), ...(episodeIds.length ? [`EpisodeSearch ${episodeIds.length} episode(s)`] : [])];
    if (!missing.length) return { queued: false, episodes: 0 };
    if (cfg.dryRun) {
      log(`dry run: /missing/search for series ${series.id} would run ${what.join(', ')}`);
      return { queued: false, dryRun: true, episodes: missing.length };
    }
    for (const n of seasonSearches) await svc.sonarr.post('/command', { name: 'SeasonSearch', seriesId: series.id, seasonNumber: n });
    if (episodeIds.length) await svc.sonarr.post('/command', { name: 'EpisodeSearch', episodeIds });
    log(`/missing/search for series ${series.id}: ${what.join(', ')}`);
    return { queued: true, episodes: missing.length };
  }

  return { getQueue, getComing, getMissing, missingSearch };
}
