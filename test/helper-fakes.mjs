// Fake Seerr, Sonarr, Radarr, Bazarr and Plex servers for the helper tests, plus a helper started
// against them. Not a test file itself. Every name, id and path here is made up.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHelper } from '../helper/lib/app.mjs';
import { readConfig } from '../helper/lib/config.mjs';

export const API_KEYS = { seerr: 'seerr-test-key', sonarr: 'sonarr-test-key', radarr: 'radarr-test-key', bazarr: 'bazarr-test-key' };
export const SECRET = 'test-webhook-secret';
export const GOOD_TOKEN = 'viewer-plex-token';
export const SERVER_TOKEN = 'server-plex-token';
export const BASE_TIME = Date.parse('2026-10-31T12:00:00Z');

// A clock that runs in real time (polls and timeouts work) but can be moved forward.
export function makeClock() {
  const realStart = Date.now();
  let offset = 0;
  return { now: () => BASE_TIME + (Date.now() - realStart) + offset, advance: (ms) => { offset += ms; } };
}

function fakeServer(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake.invalid');
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    }
    const call = { method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers };
    calls.push(call);
    let out;
    try { out = await handler(call); } catch (e) { out = { status: 500, body: { message: e.message } }; }
    if (out === undefined) out = { status: 404, body: { message: 'not found' } };
    if (!out || out.status == null || !('body' in out)) out = { status: 200, body: out };
    if (out.delay) await new Promise((r) => setTimeout(r, out.delay));
    const text = out.body == null ? '' : JSON.stringify(out.body);
    res.writeHead(out.status, text ? { 'Content-Type': 'application/json' } : {});
    res.end(text);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }) });
  }));
}

const m = (path, re) => re.exec(path);
const num = (v) => (v == null ? null : Number(v));
const paged = (records) => ({ page: 1, pageSize: 200, totalRecords: records.length, records });

// ---------------------------------------------------------------------------------------------------
// The world the fakes serve. Tests add to it and inspect what changed.
export function makeWorld(clock) {
  const w = {
    clock,
    seerr: { issues: new Map(), users: new Map(), tv: {}, nextComment: 1000 },
    radarr: { movies: [], history: [], queue: [], roots: ['/data/movies/'], commands: [], failed: [], deleted: [], editor: [], calendar: [], profiles: [{ name: 'Any', upgradeAllowed: false, cutoff: 1 }], failDelete: false },
    sonarr: { series: [], episodes: [], files: [], history: [], queue: [], roots: ['/data/tv'], commands: [], failed: [], deleted: [], monitor: [], calendar: [], profiles: [{ name: 'Any', upgradeAllowed: false, cutoff: 1 }] },
    bazarr: { series: [], episodes: [], movies: [], profiles: [], languages: [{ code2: 'en', name: 'English' }, { code2: 'fr', name: 'French' }], history: { episode: {}, movie: {} }, patches: [], syncs: [], jobs: [], noJobs: false, onSearch: null },
    plex: { tokens: new Set([GOOD_TOKEN, SERVER_TOKEN]), refreshed: [], sections: [], items: {}, leaves: {} },
  };

  // ---- Seerr ----
  w.addUser = (id, permissions) => w.seerr.users.set(id, { id, displayName: `user${id}`, permissions });
  w.addIssue = (o) => {
    const issue = {
      id: o.id, issueType: o.issueType || 1, status: o.status || 1,
      problemSeason: o.season || 0, problemEpisode: o.episode || 0,
      createdAt: new Date(o.createdAt != null ? o.createdAt : clock.now() - 60000).toISOString(),
      createdBy: { id: o.userId || 5 },
      media: { mediaType: o.mediaType || 'movie', tmdbId: o.tmdbId || null, tvdbId: o.tvdbId || null, ratingKey: o.mediaRatingKey || null },
      comments: [{ id: o.id * 10, message: o.message, user: { id: o.userId || 5 }, createdAt: new Date(clock.now() - 60000).toISOString() }],
    };
    for (const c of o.extraComments || []) issue.comments.push({ id: ++w.seerr.nextComment, message: c, user: { id: 1 } });
    w.seerr.issues.set(o.id, issue);
    return issue;
  };
  w.comments = (id) => w.seerr.issues.get(id).comments.slice(1).map((c) => c.message);

  // ---- Radarr ----
  w.addMovie = (o) => {
    const file = o.file === null ? null : {
      id: o.fileId || o.id * 100, movieId: o.id, relativePath: o.file || `${o.title} (2020)/${o.title}.2020.1080p.WEB.mkv`,
      path: `${o.root || '/data/movies'}/${o.file || `${o.title} (2020)/${o.title}.2020.1080p.WEB.mkv`}`,
      dateAdded: o.dateAdded || '2026-10-01T00:00:30Z',
    };
    const movie = { id: o.id, title: o.title, tmdbId: o.tmdbId, imdbId: `tt${o.tmdbId}`, year: 2020, monitored: o.monitored !== false, hasFile: !!file, movieFile: file, images: [{ coverType: 'poster', url: '/MediaCover/1/poster.jpg', remoteUrl: `https://image.example.com/${o.tmdbId}/poster.jpg` }, { coverType: 'fanart', remoteUrl: `https://image.example.com/${o.tmdbId}/fanart.jpg` }], ...o.extra };
    w.radarr.movies.push(movie);
    if (file && o.grab !== false) {
      const dl = o.downloadId || `DL-M${o.id}`;
      if (o.importRecord !== false) w.radarr.history.push({ id: o.id * 10 + 1, movieId: o.id, eventType: 'downloadFolderImported', downloadId: o.noDownloadId ? null : dl, sourceTitle: `${o.title.replace(/ /g, '.')}.2020.1080p.WEB-GRP`, data: { importedPath: file.path }, date: '2026-10-01T00:00:00Z' });
      for (let i = 0; i < (o.grabs == null ? 1 : o.grabs); i++) w.radarr.history.push({ id: o.id * 10 + 2 + i, movieId: o.id, eventType: 'grabbed', downloadId: dl, sourceTitle: `${o.title.replace(/ /g, '.')}.2020.1080p.WEB-GRP`, data: {}, date: '2026-09-30T00:00:00Z' });
    }
    return movie;
  };

  // ---- Sonarr ----
  // seasons: {1: [{episode, file?: 'name', downloadId?, aired?: bool, monitored?, hasFile?}]}
  w.addSeries = (o) => {
    const series = { id: o.id, title: o.title, tvdbId: o.tvdbId, tmdbId: o.tmdbId || 0, imdbId: `tt${o.tvdbId}`, year: 2015, monitored: o.monitored !== false, seasons: [], images: [{ coverType: 'poster', remoteUrl: `https://image.example.com/tv${o.tvdbId}/poster.jpg` }, { coverType: 'fanart', remoteUrl: `https://image.example.com/tv${o.tvdbId}/fanart.jpg` }] };
    w.sonarr.series.push(series);
    let epId = o.id * 1000;
    let hist = o.id * 100000;
    const grabbedFor = new Set();
    for (const [sn, eps] of Object.entries(o.seasons || {})) {
      const s = Number(sn);
      series.seasons.push({ seasonNumber: s, monitored: (o.unmonitoredSeasons || []).includes(s) ? false : true });
      for (const e of eps) {
        const id = e.id || ++epId;
        const aired = e.aired !== false;
        let fileId = 0;
        if (e.file) {
          fileId = e.fileId || id + 500000;
          const rel = `Season ${s}/${e.file}`;
          if (!w.sonarr.files.find((f) => f.id === fileId)) w.sonarr.files.push({ id: fileId, seriesId: o.id, seasonNumber: s, relativePath: rel, path: `${o.root || '/data/tv'}/${o.title}/${rel}`, dateAdded: e.dateAdded || '2026-10-01T00:00:30Z' });
          const dl = e.downloadId === null ? null : e.downloadId || `DL-S${o.id}-${s}-${e.episode}`;
          if (e.importRecord !== false) w.sonarr.history.push({ id: ++hist, episodeId: id, seriesId: o.id, eventType: 'downloadFolderImported', downloadId: dl, sourceTitle: e.release || `${o.title}.S${s}E${e.episode}`, data: { importedPath: `${o.root || '/data/tv'}/${o.title}/${rel}` }, date: '2026-10-01T00:00:00Z' });
          if (dl && e.grab !== false) {
            // a season pack writes one grabbed record per episode, all with the same downloadId
            w.sonarr.history.push({ id: ++hist, episodeId: id, seriesId: o.id, eventType: 'grabbed', downloadId: dl, sourceTitle: e.release || `${o.title}.S${s}E${e.episode}`, data: {}, date: '2026-09-30T00:00:00Z' });
            grabbedFor.add(dl);
          }
        }
        w.sonarr.episodes.push({
          id, seriesId: o.id, seasonNumber: s, episodeNumber: e.episode, title: e.title || `Episode ${e.episode}`,
          airDateUtc: e.airDateUtc || (aired ? new Date(clock.now() - (100 - e.episode) * 86400000).toISOString() : new Date(clock.now() + 5 * 86400000).toISOString()),
          hasFile: !!fileId, episodeFileId: fileId, monitored: e.monitored !== false,
        });
      }
    }
    return series;
  };
  w.episode = (seriesId, s, e) => w.sonarr.episodes.find((x) => x.seriesId === seriesId && x.seasonNumber === s && x.episodeNumber === e);

  // ---- Bazarr ----
  w.addBazarrProfile = (profileId, items) => w.bazarr.profiles.push({ profileId, name: `Profile ${profileId}`, cutoff: null, items: items.map((i, n) => ({ id: n + 1, language: i.language, forced: i.forced ? 'True' : 'False', hi: i.hi ? 'True' : 'False', audio_exclude: 'False' })) });
  // what a search finds: {kind, id, language} → provider name or null; set w.bazarr.find = fn
  w.bazarr.find = () => 'opensubtitlescom';
  w.bazarr.onSearch = (kind, id, form) => {
    const provider = w.bazarr.find(kind, id, form);
    if (!provider) return;
    const list = w.bazarr.history[kind][id] || (w.bazarr.history[kind][id] = []);
    list.unshift({ action: 1, provider, language: { code2: form.language, name: 'English', forced: form.forced === 'True', hi: form.hi === 'True' } });
    const rec = kind === 'episode' ? w.bazarr.episodes.find((e) => e.sonarrEpisodeId === id) : w.bazarr.movies.find((x) => x.radarrId === id);
    if (rec) {
      rec.missing_subtitles = (rec.missing_subtitles || []).filter((x) => x.code2 !== form.language);
      rec.subtitles = [...(rec.subtitles || []), { code2: form.language, name: 'English', forced: false, hi: false, path: `/data/x.${form.language}.srt` }];
    }
  };

  // ---- Plex ----
  w.addPlexMovie = (ratingKey, tmdbId) => {
    if (!w.plex.sections.find((s) => s.key === '1')) w.plex.sections.push({ key: '1', type: 'movie', title: 'Films' });
    (w.plex.items['1'] || (w.plex.items['1'] = [])).push({ ratingKey: String(ratingKey), type: 'movie', Guid: [{ id: `tmdb://${tmdbId}` }] });
  };
  // leaves: [[ratingKey, season, episode, file?]]
  w.addPlexShow = (ratingKey, tvdbId, leaves) => {
    if (!w.plex.sections.find((s) => s.key === '2')) w.plex.sections.push({ key: '2', type: 'show', title: 'TV' });
    const list = w.plex.items['2'] || (w.plex.items['2'] = []);
    if (!list.find((x) => x.ratingKey === String(ratingKey))) list.push({ ratingKey: String(ratingKey), type: 'show', Guid: [{ id: `tvdb://${tvdbId}` }] });
    w.plex.leaves[String(ratingKey)] = leaves.map(([rk, s, e, file]) => ({
      ratingKey: String(rk), type: 'episode', parentIndex: s, index: e, grandparentRatingKey: String(ratingKey),
      Guid: [{ id: `tvdb://${rk}0` }], Media: file ? [{ Part: [{ file }] }] : [],
    }));
  };
  // Plex sees the same files as Sonarr, in the same seasons
  w.mirrorToPlex = (seriesId, showKey) => {
    const series = w.sonarr.series.find((x) => x.id === seriesId);
    const leaves = w.sonarr.episodes.filter((e) => e.seriesId === seriesId && e.hasFile).map((e) => {
      const f = w.sonarr.files.find((x) => x.id === e.episodeFileId);
      return [Number(showKey) * 100 + e.seasonNumber * 10 + e.episodeNumber, e.seasonNumber, e.episodeNumber, `/media/tv/${f.relativePath}`];
    });
    w.addPlexShow(showKey, series.tvdbId, leaves);
  };
  w.plexMetadata = (key) => {
    for (const list of Object.values(w.plex.items)) { const m = list.find((x) => x.ratingKey === String(key)); if (m) return m; }
    for (const leaves of Object.values(w.plex.leaves)) { const m = leaves.find((x) => x.ratingKey === String(key)); if (m) return m; }
    return null;
  };
  return w;
}

// ---------------------------------------------------------------------------------------------------
function seerrHandler(w) {
  return (c) => {
    if (c.headers['x-api-key'] !== API_KEYS.seerr) return { status: 401, body: { message: 'Unauthorized' } };
    const p = c.path.replace(/^\/api\/v1/, '');
    let r;
    if (c.method === 'GET' && p === '/auth/me') return { id: 1 };
    if (c.method === 'GET' && p === '/issue') {
      const all = [...w.seerr.issues.values()].filter((i) => c.query.get('filter') !== 'open' || i.status === 1)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const take = Number(c.query.get('take') || 10);
      const skip = Number(c.query.get('skip') || 0);
      return { pageInfo: { results: all.length }, results: all.slice(skip, skip + take) };
    }
    if ((r = m(p, /^\/issue\/(\d+)$/)) && c.method === 'GET') {
      const i = w.seerr.issues.get(Number(r[1]));
      return i ? i : { status: 404, body: { message: 'Issue not found.' } };
    }
    if ((r = m(p, /^\/issue\/(\d+)\/comment$/)) && c.method === 'POST') {
      const i = w.seerr.issues.get(Number(r[1]));
      i.comments.push({ id: ++w.seerr.nextComment, message: c.body.message, user: { id: 1 }, createdAt: new Date(w.clock.now()).toISOString() });
      return i;
    }
    if ((r = m(p, /^\/issue\/(\d+)\/(resolved|open)$/)) && c.method === 'POST') {
      const i = w.seerr.issues.get(Number(r[1]));
      i.status = r[2] === 'resolved' ? 2 : 1;
      return i;
    }
    if ((r = m(p, /^\/user\/(\d+)$/)) && c.method === 'GET') {
      const u = w.seerr.users.get(Number(r[1]));
      return u || { status: 404, body: { message: 'User not found.' } };
    }
    if ((r = m(p, /^\/tv\/(\d+)$/)) && c.method === 'GET') return w.seerr.tv[r[1]] || { status: 404, body: {} };
    return undefined;
  };
}

function radarrHandler(w) {
  const R = w.radarr;
  return (c) => {
    if (c.headers['x-api-key'] !== API_KEYS.radarr) return { status: 401, body: {} };
    const p = c.path.replace(/^\/api\/v3/, '');
    const q = c.query;
    let r;
    if (c.method === 'GET') {
      if (p === '/system/status') return { version: '6.4.4' };
      if (p === '/qualityprofile') return R.profiles;
      if (p === '/movie') return R.movies.filter((x) => !q.get('tmdbId') || x.tmdbId === num(q.get('tmdbId')));
      if ((r = m(p, /^\/movie\/(\d+)$/))) return R.movies.find((x) => x.id === Number(r[1]));
      if (p === '/moviefile') return R.movies.filter((x) => x.id === num(q.get('movieId')) && x.movieFile).map((x) => x.movieFile);
      if (p === '/rootfolder') return R.roots.map((path, i) => ({ id: i + 1, path }));
      if (p === '/queue') {
        if (R.onQueue) R.onQueue();
        if (R.queueError) return { status: 500, body: { message: R.queueError } };
        return paged(R.queue);
      }
      if (p === '/calendar') return R.calendar;
      if (p === '/history/movie') {
        return R.history.filter((h) => h.movieId === num(q.get('movieId')) && (!q.get('eventType') || h.eventType === q.get('eventType')));
      }
      if (p === '/history') {
        const types = q.getAll('eventType').map(Number);
        const name = { 1: 'grabbed', 3: 'downloadFolderImported' };
        return paged(R.history.filter((h) => (!q.get('downloadId') || h.downloadId === q.get('downloadId')) && (!types.length || types.some((t) => name[t] === h.eventType))));
      }
    }
    if (c.method === 'POST' && (r = m(p, /^\/history\/failed\/(\d+)$/))) { R.failed.push(Number(r[1])); return { status: 200, body: null, delay: R.failedDelay || 0 }; }
    if (c.method === 'DELETE' && (r = m(p, /^\/moviefile\/(\d+)$/))) {
      if (R.failDelete) return { status: 500, body: { message: 'disk on fire' } };
      R.deleted.push(Number(r[1]));
      for (const mv of R.movies) if (mv.movieFile && mv.movieFile.id === Number(r[1])) { mv.movieFile = null; mv.hasFile = false; if (R.unmonitorDeleted) mv.monitored = false; }
      return { status: 200, body: null };
    }
    if (c.method === 'PUT' && p === '/movie/editor') {
      R.editor.push(c.body);
      for (const mv of R.movies) if (c.body.movieIds.includes(mv.id)) mv.monitored = c.body.monitored;
      return { status: 202, body: {} };
    }
    if (c.method === 'POST' && p === '/command') { R.commands.push(c.body); return { status: 201, body: { id: R.commands.length, ...c.body, status: 'queued' } }; }
    return undefined;
  };
}

function sonarrHandler(w) {
  const S = w.sonarr;
  return (c) => {
    if (c.headers['x-api-key'] !== API_KEYS.sonarr) return { status: 401, body: {} };
    const p = c.path.replace(/^\/api\/v3/, '');
    const q = c.query;
    let r;
    if (c.method === 'GET') {
      if (p === '/system/status') return { version: '4.0.20' };
      if (p === '/qualityprofile') return S.profiles;
      if (p === '/series') return S.series.filter((x) => !q.get('tvdbId') || x.tvdbId === num(q.get('tvdbId')));
      if (p === '/episode') {
        return S.episodes.filter((e) => e.seriesId === num(q.get('seriesId')) && (q.get('seasonNumber') == null || e.seasonNumber === num(q.get('seasonNumber'))));
      }
      if (p === '/episodefile') return S.files.filter((f) => f.seriesId === num(q.get('seriesId')));
      if (p === '/rootfolder') return S.roots.map((path, i) => ({ id: i + 1, path }));
      if (p === '/queue') return paged(S.queue);
      if (p === '/calendar') return S.calendar;
      if (p === '/history') {
        const types = q.getAll('eventType').map(Number);
        const name = { 1: 'grabbed', 3: 'downloadFolderImported' };
        return paged(S.history.filter((h) => (!q.get('episodeId') || h.episodeId === num(q.get('episodeId')))
          && (!q.get('downloadId') || h.downloadId === q.get('downloadId'))
          && (!types.length || types.some((t) => name[t] === h.eventType))));
      }
    }
    if (c.method === 'POST' && (r = m(p, /^\/history\/failed\/(\d+)$/))) {
      if (S.failFailed && S.failFailed.has(Number(r[1]))) return { status: 500, body: { message: 'internal detail' } };
      S.failed.push(Number(r[1]));
      return { status: 200, body: null };
    }
    const unfile = (ids) => {
      for (const id of ids) {
        S.deleted.push(id);
        S.files = S.files.filter((f) => f.id !== id);
        for (const e of S.episodes) if (e.episodeFileId === id) { e.episodeFileId = 0; e.hasFile = false; }
      }
    };
    if (c.method === 'DELETE' && p === '/episodefile/bulk') { unfile(c.body.episodeFileIds); return { status: 200, body: null }; }
    if (c.method === 'DELETE' && (r = m(p, /^\/episodefile\/(\d+)$/))) { unfile([Number(r[1])]); return { status: 200, body: null }; }
    if (c.method === 'PUT' && p === '/episode/monitor') { S.monitor.push(c.body); return { status: 202, body: {} }; }
    if (c.method === 'POST' && p === '/command') { S.commands.push(c.body); return { status: 201, body: { id: S.commands.length, ...c.body } }; }
    return undefined;
  };
}

function bazarrHandler(w) {
  const B = w.bazarr;
  return (c) => {
    if (c.headers['x-api-key'] !== API_KEYS.bazarr) return { status: 401, body: null };
    const p = c.path.replace(/^\/api/, '');
    const q = c.query;
    const form = c.body || {};
    if (c.method === 'GET') {
      if (p === '/system/status') return { data: { bazarr_version: '1.5.0' } };
      if (p === '/system/languages/profiles') return B.profiles;
      if (p === '/system/languages') return B.languages;
      if (p === '/series') return { data: B.series.filter((s) => q.getAll('seriesid[]').map(Number).includes(s.sonarrSeriesId)), total: 1 };
      if (p === '/episodes') return { data: B.episodes.filter((e) => q.getAll('episodeid[]').map(Number).includes(e.sonarrEpisodeId)) };
      if (p === '/movies') return { data: B.movies.filter((x) => q.getAll('radarrid[]').map(Number).includes(x.radarrId)), total: 1 };
      if (p === '/episodes/history') { const h = B.history.episode[num(q.get('episodeid'))] || []; return { data: h.slice(0, num(q.get('length')) || 1e9), total: h.length }; }
      if (p === '/movies/history') { const h = B.history.movie[num(q.get('radarrid'))] || []; return { data: h.slice(0, num(q.get('length')) || 1e9), total: h.length }; }
      if (p === '/system/jobs') return B.noJobs ? { status: 404, body: null } : { data: B.jobs };
    }
    if (c.method === 'PATCH' && (p === '/episodes/subtitles' || p === '/movies/subtitles')) {
      const kind = p === '/movies/subtitles' ? 'movie' : 'episode';
      const id = Number(kind === 'movie' ? form.radarrid : form.episodeid);
      B.patches.push({ kind, id, ...form });
      if (B.noJobs) { B.onSearch(kind, id, form); return { status: 204, body: null }; }
      // Bazarr 1.5+: the search runs as a job after the answer
      const job = { job_name: 'Searching subtitles', status: 'running' };
      B.jobs.push(job);
      setTimeout(() => { B.onSearch(kind, id, form); job.status = 'completed'; }, B.searchDelay == null ? 30 : B.searchDelay).unref();
      return { status: 204, body: null };
    }
    if (c.method === 'PATCH' && p === '/subtitles') { B.syncs.push(form); return { status: 204, body: null }; }
    return undefined;
  };
}

function plexHandler(w) {
  const P = w.plex;
  return (c) => {
    const token = c.headers['x-plex-token'];
    if (c.path === '/identity') return { MediaContainer: { machineIdentifier: 'fake' } };
    if (!P.tokens.has(token)) return { status: 401, body: null };
    let r;
    if (c.method === 'GET' && c.path === '/library/sections') return { MediaContainer: { Directory: P.sections } };
    if (c.method === 'GET' && (r = m(c.path, /^\/library\/sections\/(\w+)\/all$/))) return { MediaContainer: { Metadata: P.items[r[1]] || [] } };
    if (c.method === 'GET' && (r = m(c.path, /^\/library\/metadata\/(\d+)\/allLeaves$/))) return { MediaContainer: { Metadata: P.leaves[r[1]] || [] } };
    if (c.method === 'GET' && (r = m(c.path, /^\/library\/metadata\/(\d+)$/))) {
      const md = w.plexMetadata(r[1]);
      return md ? { MediaContainer: { Metadata: [md] } } : { status: 404, body: null };
    }
    if (c.method === 'PUT' && (r = m(c.path, /^\/library\/metadata\/(\d+)\/refresh$/))) {
      if (token !== SERVER_TOKEN) return { status: 401, body: null };
      P.refreshed.push(r[1]);
      return { status: 200, body: null };
    }
    return undefined;
  };
}

// Start the fakes and a helper against them. env overrides the defaults (DRY_RUN=0 by default
// here, so tests opt in to dry-run). `skip` leaves services out: ['bazarr'].
export async function startWorld(opts = {}) {
  const clock = opts.clock || makeClock();
  const w = opts.world || makeWorld(clock);
  const servers = opts.servers || {
    seerr: await fakeServer(seerrHandler(w)),
    radarr: await fakeServer(radarrHandler(w)),
    sonarr: await fakeServer(sonarrHandler(w)),
    bazarr: await fakeServer(bazarrHandler(w)),
    plex: await fakeServer(plexHandler(w)),
  };
  const stateDir = opts.stateDir || mkdtempSync(join(tmpdir(), 'plexlite-helper-test-'));
  const skip = new Set(opts.skip || []);
  const env = {
    STATE_DIR: stateDir, WEBHOOK_SECRET: SECRET, DRY_RUN: '0', BACKFILL_DAYS: '0',
    SUBTITLE_WAIT_SECONDS: '2', POLL_MS: '20', UPSTREAM_TIMEOUT_MS: '3000',
    PLEX_TOKEN: SERVER_TOKEN,
  };
  for (const name of ['seerr', 'radarr', 'sonarr', 'bazarr']) {
    if (skip.has(name)) continue;
    env[`${name.toUpperCase()}_URL`] = servers[name].url;
    env[`${name.toUpperCase()}_API_KEY`] = API_KEYS[name];
  }
  if (!skip.has('plex')) env.PLEX_URL = servers.plex.url;
  Object.assign(env, opts.env || {});
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
  const logs = [];
  const helper = createHelper(readConfig(env), { now: clock.now, log: (line) => logs.push(line) });
  const addr = await helper.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;

  async function call(method, path, { body, token, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h['X-Plex-Token'] = token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return new Promise((resolve, reject) => {
      const req = http.request(base + path, { method, headers: h }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = text; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }
  const webhook = (issueId, extra = {}) => call('POST', '/seerr-webhook', {
    headers: { Authorization: `Bearer ${extra.secret || SECRET}` },
    body: { notification_type: extra.type || 'ISSUE_CREATED', issue_id: String(issueId), issue_type: 'VIDEO', media_type: 'movie' },
  });

  return {
    w, clock, servers, helper, base, logs, stateDir, call, webhook,
    // restart the helper on the same fakes and state (a new process after a reboot)
    restart: async (more = {}) => {
      await helper.close();
      return startWorld({ clock, world: w, servers, stateDir, skip: opts.skip, env: { ...(opts.env || {}), ...more } });
    },
    close: async (keepFakes) => {
      await helper.close();
      if (!keepFakes) for (const s of Object.values(servers)) await s.close();
    },
  };
}

// a Plex Lite report message, as plugins/overseerr/report.js writes it
export function report(reason, scope, { season, episode, plex, file, label } = {}) {
  const tag = [`reason=${reason}`, `scope=${scope}`];
  if (season) tag.push(`season=${season}`);
  if (episode) tag.push(`episode=${episode}`);
  if (plex) tag.push(`plex=${plex}`);
  if (file) tag.push(`file=${file}`);
  return `${label || 'Poor video quality'}\n\nReported from Plex Lite.\nplexlite: ${tag.join('; ')}`;
}
