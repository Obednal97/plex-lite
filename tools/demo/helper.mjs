// A fake home server helper that follows the helper's API contract (docs/HOME-HELPER.md): /healthz,
// /coming, /missing, /missing/search, /subtitles, /subtitles/search, /subtitles/sync and an empty
// /queue, with CORS, X-Plex-Token on actions, the rate limit, dry run and the contract's error
// answers (notes 12 / docs/HELPER.md, as of the helper's 2026-10-31 changes).
//
// The demo server mounts it at /helper (so Settings → Home server helper takes
// http://127.0.0.1:8930/helper), with data made from the demo library relative to today; the tests
// start it on their own port with data of their own:
//
//   import { createFakeHelper, startFakeHelper, demoData } from './helper.mjs';
//   const helper = await startFakeHelper({ data: {...}, services: {...} });   // helper.url, helper.close()
//
// opts: {data, services, dryRun, paused, plexRefreshed (default true), acceptToken(token), latencyMs, searchMs,
//        now() -> ms (the clock /coming filters by)}
// data: {coming: [items], missing: {<tvdbId>: answer}, subtitles: {<query key>: {languages, have, missing}},
//        found: (body) -> provider name | null (what /subtitles/search finds)}
// The query key is "movie:<tmdbId>" or "episode:<tvdbId>:<season>:<episode>".
import { createServer } from 'node:http';

const LIMIT = 20;
const WINDOW_MS = 10 * 60 * 1000;

export function createFakeHelper(opts = {}) {
  const data = opts.data || { coming: [], missing: {}, subtitles: {} };
  const services = { seerr: false, sonarr: true, radarr: true, bazarr: true, plex: true, ...(opts.services || {}) };
  const accept = opts.acceptToken || ((t) => /^demo/.test(t));
  const latency = opts.latencyMs || 0;
  const clock = opts.now || Date.now;
  const log = [];
  const state = { dryRun: !!opts.dryRun, paused: !!opts.paused };
  const actions = new Map();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Plex-Token',
  };
  const send = (res, status, body) => {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, error, message) => send(res, status, { error, message });
  const list = (extra) => ({ version: 1, updatedAt: new Date().toISOString(), ...extra });
  const subsKey = (p) => (p.type === 'movie' ? `movie:${p.tmdbId}` : `episode:${p.tvdbId}:${p.season}:${p.episode}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function authorise(req, res) {
    const token = req.headers['x-plex-token'] || '';
    if (!token || !accept(token)) { fail(res, 401, 'unauthenticated', 'Plex did not accept that token'); return null; }
    const now = Date.now();
    const recent = (actions.get(token) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) { fail(res, 429, 'rate_limited', 'Too many actions; try again later'); return null; }
    recent.push(now);
    actions.set(token, recent);
    return token;
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
    });
  }

  // path: from the helper's root ("/healthz"); query: URLSearchParams
  async function handle(req, res, path, query) {
    log.push({ method: req.method, path, query: Object.fromEntries(query), token: req.headers['x-plex-token'] || null,
      contentType: req.headers['content-type'] || null });
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (latency) await wait(latency);
    if (req.method === 'GET') {
      if (path === '/healthz') return send(res, 200, { ok: true, version: '0.0.0-fake', dryRun: state.dryRun, paused: state.paused, services });
      if (path === '/queue') return send(res, 200, list({ items: [] }));
      if (path === '/coming') {
        if (!services.sonarr && !services.radarr) return fail(res, 503, 'unavailable', 'Sonarr and Radarr are not configured');
        const days = Math.min(30, Math.max(1, Number(query.get('days')) || 7));
        const now = clock();
        const items = (data.coming || []).filter((it) => {
          if (it.source === 'sonarr' && !services.sonarr) return false;
          if (it.source === 'radarr' && !services.radarr) return false;
          const at = Date.parse(it.airDateUtc || it.releaseDate);
          return at >= now - 2 * 86400000 - 86400000 && at <= now + days * 86400000;
        });
        return send(res, 200, list({ items }));
      }
      if (path === '/missing') {
        if (!services.sonarr) return fail(res, 503, 'unavailable', 'Sonarr is not configured');
        const id = query.get('tvdbId');
        if (!/^\d+$/.test(id || '')) return fail(res, 400, 'bad_request', 'tvdbId is required');
        const answer = (data.missing || {})[id];
        return answer ? send(res, 200, list(answer)) : fail(res, 404, 'not_found', 'Sonarr does not have this show');
      }
      if (path === '/subtitles') {
        if (!services.bazarr) return fail(res, 503, 'unavailable', 'Bazarr is not configured');
        const p = Object.fromEntries(query);
        if (!['movie', 'episode'].includes(p.type)) return fail(res, 400, 'bad_request', 'type must be movie or episode');
        const s = (data.subtitles || {})[subsKey(p)];
        return s ? send(res, 200, list(s)) : fail(res, 404, 'not_found', 'Bazarr does not have this title');
      }
      return fail(res, 404, 'not_found', `no ${path}`);
    }
    if (req.method !== 'POST') return fail(res, 405, 'bad_request', 'GET or POST');
    if (!authorise(req, res)) return undefined;
    const body = await readBody(req);
    if (!body) return fail(res, 400, 'bad_request', 'the body is not JSON');
    if (path === '/missing/search') {
      if (!services.sonarr) return fail(res, 503, 'unavailable', 'Sonarr is not configured');
      const answer = (data.missing || {})[body.tvdbId];
      if (!answer) return fail(res, 404, 'not_found', 'Sonarr does not have this show');
      // no season: every season except specials
      const n = answer.seasons.filter((s) => (body.season == null ? s.season !== 0 : s.season === body.season))
        .reduce((a, s) => a + s.missing.filter((e) => body.episode == null || e.episode === body.episode).length, 0);
      if (!n) return send(res, 200, { queued: false, episodes: 0 });
      return send(res, 200, state.dryRun ? { queued: false, dryRun: true, episodes: n } : { queued: true, episodes: n });
    }
    if (path === '/subtitles/search' || path === '/subtitles/sync') {
      if (!services.bazarr) return fail(res, 503, 'unavailable', 'Bazarr is not configured');
      if (!['movie', 'episode'].includes(body.type)) return fail(res, 400, 'bad_request', 'type is required');
      const s = (data.subtitles || {})[subsKey(body)];
      if (!s) return fail(res, 404, 'not_found', 'Bazarr does not have this title');
      if (path === '/subtitles/sync') {
        if (!body.language) return fail(res, 400, 'bad_request', 'language is required');
        if (!s.have.some((l) => l.code === body.language && l.external)) return fail(res, 404, 'not_found', 'no external subtitle in that language');
        return send(res, 200, state.dryRun ? { status: 'dry_run', dryRun: true } : { status: 'queued' });
      }
      // language is optional: the profile's first
      if (!body.language) body.language = (s.languages[0] || {}).code;
      if (state.dryRun) return send(res, 200, { status: 'dry_run', dryRun: true, language: body.language });
      if (opts.searchMs) await wait(opts.searchMs);
      const provider = data.found ? data.found(body) : null;
      if (!provider) return send(res, 200, { status: 'not_found' });
      // what Bazarr would now report: the language has an external file
      const i = s.missing.findIndex((l) => l.code === body.language && !!l.forced === !!body.forced && !!l.hi === !!body.hi);
      if (i >= 0) s.have.push({ ...s.missing.splice(i, 1)[0], external: true });
      return send(res, 200, { status: 'downloaded', language: body.language, provider, plexRefreshed: opts.plexRefreshed !== false && !!body.ratingKey });
    }
    return fail(res, 404, 'not_found', `no ${path}`);
  }

  return { handle, log, data, services, state };
}

// On its own port (tests): {url, helper, close()}
export function startFakeHelper(opts = {}) {
  const helper = createFakeHelper(opts);
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    helper.handle(req, res, u.pathname, u.searchParams).catch((e) => { res.writeHead(500); res.end(String(e)); });
  });
  server.unref();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, helper, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
  }));
}

// ---- Demo data -------------------------------------------------------------------------------------

const EN = { code: 'en', name: 'English', forced: false, hi: false };
const ES = { code: 'es', name: 'Spanish', forced: false, hi: false };

// Films Radarr is waiting for (not in the demo library; their art is generated): [slug, title, year]
export const UPCOMING_FILMS = [
  ['paper-comets', 'Paper Comets', 2026],
  ['the-clockmakers-garden', 'The Clockmaker\'s Garden', 2026],
  ['northern-lights-express', 'Northern Lights Express', 2026],
];

// Data relative to `now` for the demo library (model: tools/demo/model.mjs; img(kind, slug) -> the
// absolute URL of a generated poster or backdrop).
export function demoData(model, now, img) {
  const at = (days, hour, min = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, min, 0, 0);
    return d.toISOString();
  };
  const day = (days) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const ids = (item) => Object.fromEntries((item.Guid || []).map((g) => g.id.split('://')));
  const show = (id) => model.shows.find((s) => s._id === id);
  const movie = (id) => model.movies.find((m) => m._id === id);
  const tv = (s, season, episode, episodeTitle, airDateUtc, extra = {}) => ({
    source: 'sonarr', mediaType: 'tv', tvdbId: Number(ids(s).tvdb), tmdbId: Number(ids(s).tmdb), imdbId: null, title: s.title, year: s.year,
    season, episode, episodeTitle, airDateUtc, seasonPremiere: false, seriesPremiere: false, hasFile: false,
    posterUrl: img('poster', s._id), fanartUrl: img('art', s._id), ...extra,
  });
  const film = (slug, title, year, releaseDate, releaseType, extra = {}) => ({
    source: 'radarr', mediaType: 'movie', tmdbId: extra.tmdbId || 980000 + slug.length * 7 + year, tvdbId: null, imdbId: null, title, year,
    releaseDate, releaseType, hasFile: false, posterUrl: img('poster', slug), fanartUrl: img('art', slug), ...extra,
  });
  const sc = show('sciencecasts');
  const nx = show('nasa-explorers');
  const cam = show('caminandes');
  const lastSc = sc._seasons[sc._seasons.length - 1];
  const wing = movie('wing-it');
  const coming = [
    // the newest ScienceCasts episode in the library "aired yesterday" (so OK opens it)
    tv(sc, lastSc.index, lastSc._episodes.length, lastSc._episodes[lastSc._episodes.length - 1].title, at(-1, 18), { hasFile: true }),
    tv(nx, 6, 1, 'Return to the Moon', at(0, 21), { seasonPremiere: true }),
    tv(cam, 1, 4, 'Llama Lift-Off', at(3, 20)),
    tv(nx, 6, 2, 'Artemis in Orbit', at(7, 21)),
    // a show that isn't in the library: never shown
    { ...tv(cam, 1, 1, 'Pilot', at(1, 20)), tvdbId: 1, tmdbId: 1, title: 'A Show Not In Plex', year: 2026 },
    film('wing-it', wing.title, wing.year, day(-1), 'digital', { tmdbId: Number(ids(wing).tmdb), hasFile: true, posterUrl: img('poster', 'wing-it'), fanartUrl: img('art', 'wing-it') }),
    film(...UPCOMING_FILMS[0], day(1), 'cinema'),
    film(...UPCOMING_FILMS[1], day(3), 'digital'),
    film(...UPCOMING_FILMS[2], day(6), 'physical'),
  ].sort((a, b) => Date.parse(a.airDateUtc || a.releaseDate) - Date.parse(b.airDateUtc || b.releaseDate));

  const missing = {};
  for (const s of model.shows) {
    const tvdb = ids(s).tvdb;
    if (s._id === 'sciencecasts') continue; // not in Sonarr: 404
    missing[tvdb] = {
      monitored: true,
      seasons: s._seasons.map((se) => {
        const extra = s._id === 'nasa-explorers' ? [
          { episode: se._episodes.length + 1, title: 'Lunar Gateway', airDateUtc: at(-40, 20) },
          { episode: se._episodes.length + 2, title: 'Sample Return', airDateUtc: at(-33, 20) },
          { episode: se._episodes.length + 3, title: 'Night Launch', airDateUtc: at(-26, 20) },
        ] : [];
        return { season: se.index, monitored: true, episodes: se._episodes.length + extra.length, have: se._episodes.length, missing: extra };
      }),
    };
  }

  const subtitles = {};
  for (const m of model.movies) {
    // the silent classics have no subtitles yet; the rest have English and want Spanish
    const silent = ['nosferatu', 'the-general'].includes(m._id);
    subtitles[`movie:${ids(m).tmdb}`] = { languages: [EN, ES], have: silent ? [] : [{ ...EN, external: true }], missing: silent ? [EN, ES] : [ES] };
  }
  for (const s of model.shows) {
    for (const se of s._seasons) {
      for (const e of se._episodes) {
        subtitles[`episode:${ids(s).tvdb}:${se.index}:${e.index}`] = { languages: [EN], have: [{ ...EN, external: true }, { ...ES, external: false }], missing: [] };
      }
    }
  }
  // Bazarr finds English, never Spanish
  return { coming, missing, subtitles, found: (b) => (b.language === 'en' ? 'opensubtitles' : null) };
}
