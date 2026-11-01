// A fake Overseerr (Seerr) for the demo server and the plugin's tests: the /api/v1 endpoints the
// Overseerr plugin calls, with made-up request states around the demo library. Titles in the demo
// library are "available" (with their Plex ratingKey and artwork); the others are public-domain
// classics and invented upcoming titles with generated posters (server.mjs draws /demo-seerr/*).
// No TMDB data or artwork.
//
//   const seerr = createSeerr(model);   // model: tools/demo/model.mjs (or null for a library-less one)
//   seerr.handle({method, path, cookie, body}) -> {status, data, setCookie?}
//   seerr.kill(userId)                  // end that user's session on the "server" (signed out elsewhere)
import { demoTmdb, slug } from './model.mjs';

const DENIED = { status: 403, error: 'You do not have permission to access this endpoint' };
// Plex tokens the demo hands out (server.mjs plextv: the owner, and Home users' switch tokens)
const USERS = {
  'demo-token': { id: 1, displayName: 'Demo', permissions: 2 },
  'demo-demo-user-1': { id: 2, displayName: 'Kids', permissions: 32 | 4194304 },
  'tok-a': { id: 1, displayName: 'Demo', permissions: 2 },
  'tok-b': { id: 2, displayName: 'Kids', permissions: 32 | 4194304 },
};

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString();

const CLASSICS = [
  ['Metropolis', 1927, 'In a city divided between workers and planners, the son of its master falls for a prophet of the workers.'],
  ['The Kid', 1921, 'The Tramp takes in an abandoned child, until the authorities come for him.'],
  ['Safety Last!', 1923, 'A young man from a small town ends up climbing the outside of a department store.'],
  ['Sherlock Jr.', 1924, 'A cinema projectionist who longs to be a detective is framed by a rival.'],
  ['The Gold Rush', 1925, 'A lone prospector heads for the Klondike and finds more than gold.'],
  ['A Trip to the Moon', 1902, 'Astronomers fire themselves at the Moon and meet its people.'],
  ['Detour', 1945, 'A nightclub pianist hitchhikes to Hollywood, and his luck runs out on the way.'],
  ['The Cabinet of Dr. Caligari', 1920, 'A showman and his sleepwalker arrive in a mountain town as murders begin.'],
  ['The Lodger', 1927, 'A landlady begins to suspect her quiet new lodger.'],
];
// invented titles (nothing real is "upcoming" here)
const UPCOMING = [
  ['The Last Lighthouse', 34, 'A demo title: a keeper stays on after the light is switched off for good.'],
  ['Paper Moons', 62, 'A demo title: two rival animators share one tiny studio.'],
  ['Northern Line', 95, 'A demo title: a night on the last train out of the city.'],
  ['Quiet Orbit', 130, 'A demo title: a repair crew and a satellite that won\'t stay fixed.'],
  ['Saltmarsh', 170, 'A demo title: a birdwatcher finds something in the reeds.'],
];
const SHOWS = [
  ['Flatland Stories', 2021, 3, 'A demo series of short animated tales from a two-dimensional world.'],
  ['The Lighthouse Diaries', 2019, 2, 'A demo series: a year on a remote island, one keeper at a time.'],
  ['Night Shift Radio', 2023, 1, 'A demo series about the people who keep a city\'s radio on at night.'],
  ['Tidal Island', 2020, 4, 'A demo series filmed on an island cut off twice a day by the sea.'],
];
const UPCOMING_SHOWS = [
  ['Orbit Station', 48, 'A demo series: life on a small research station, starting soon.'],
  ['The Glasshouse', 110, 'A demo series about a botanical garden and its night gardener.'],
];
// how many seasons Overseerr says the demo library's shows have (Plex has fewer of some)
const SHOW_SEASONS = { 'nasa-explorers': 5, sciencecasts: 4, caminandes: 1 };

export function createSeerr(model) {
  const titles = new Map(); // `${type}:${tmdb}` -> title record
  const add = (t) => { titles.set(`${t.type}:${t.id}`, t); return t; };
  const poster = (s) => `/demo-seerr/poster/${s}`;
  const backdrop = (s) => `/demo-seerr/art/${s}`;

  // the demo library: available, with its Plex ratingKey and artwork
  for (const m of (model && model.movies) || []) {
    add({ type: 'movie', id: demoTmdb(m._id), title: m.title, year: m.year, date: `${m.year}-06-01`, overview: m.summary || '',
      posterPath: m.thumb, backdropPath: m.art, status: 5, ratingKey: m.ratingKey });
  }
  for (const s of (model && model.shows) || []) {
    const n = SHOW_SEASONS[s._id] || s._seasons.length;
    const inPlex = s._seasons.map((x) => x.index);
    const seasons = [];
    for (let i = 1; i <= n; i++) seasons.push({ seasonNumber: i, name: `Season ${i}`, episodeCount: 4 + i, airDate: `${s.year + i - 1}-03-01`, status: inPlex.includes(i) ? 5 : 1 });
    if (s._id === 'sciencecasts') seasons.push({ seasonNumber: n + 1, name: `Season ${n + 1}`, episodeCount: 6, airDate: day(80), status: 1 });
    add({ type: 'tv', id: demoTmdb(s._id), title: s.title, year: s.year, date: `${s.year}-03-01`, overview: s.summary || '',
      posterPath: s.thumb, backdropPath: s.art, status: seasons.every((x) => x.status === 5) ? 5 : 4, ratingKey: s.ratingKey, seasons });
  }
  CLASSICS.forEach(([title, year, overview], i) => add({ type: 'movie', id: 910000 + i, title, year, date: `${year}-02-01`, overview,
    posterPath: poster(slug(title)), backdropPath: backdrop(slug(title)), status: 1 }));
  UPCOMING.forEach(([title, inDays, overview], i) => add({ type: 'movie', id: 920000 + i, title, year: Number(day(inDays).slice(0, 4)), date: day(inDays), overview,
    posterPath: poster(slug(title)), backdropPath: backdrop(slug(title)), status: 1, upcoming: true }));
  SHOWS.forEach(([title, year, n, overview], i) => {
    const seasons = [];
    for (let k = 1; k <= n; k++) seasons.push({ seasonNumber: k, name: `Season ${k}`, episodeCount: 6, airDate: `${year + k - 1}-09-01`, status: 1 });
    add({ type: 'tv', id: 930000 + i, title, year, date: `${year}-09-01`, overview, posterPath: poster(slug(title)), backdropPath: backdrop(slug(title)), status: 1, seasons });
  });
  UPCOMING_SHOWS.forEach(([title, inDays, overview], i) => add({ type: 'tv', id: 940000 + i, title, year: Number(day(inDays).slice(0, 4)), date: day(inDays), overview,
    posterPath: poster(slug(title)), backdropPath: backdrop(slug(title)), status: 1, upcoming: true,
    seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 8, airDate: day(inDays), status: 1 }] }));

  const find = (type, title) => [...titles.values()].find((t) => t.type === type && t.title === title);

  // requests: who, what, when, and how far they have got
  const requests = [];
  let nextRequest = 40;
  const request = (t, userId, status, ageDays, seasons, extra) => {
    if (!t) return null;
    const r = { id: nextRequest++, status, type: t.type, createdAt: iso(-ageDays), updatedAt: iso(-ageDays / 2), userId, tmdb: t.id,
      seasons: (seasons || []).map((n) => ({ id: nextRequest * 10 + n, seasonNumber: n, status: status === 5 ? 5 : status })), is4k: false };
    requests.push(r);
    Object.assign(t, extra || {});
    return r;
  };
  request(find('movie', 'Metropolis'), 1, 1, 0, null, { status: 2 }); // just now: "today" at any time of day
  request(find('movie', 'The Kid'), 1, 2, 2, null, { status: 3, downloads: [{ title: 'The.Kid.1921.1080p', status: 'downloading', size: 4e9, sizeLeft: 2.2e9, timeLeft: '00:18:00' }] });
  request(find('tv', 'NASA ScienceCasts'), 1, 1, 1, [3]);
  const flat = request(find('tv', 'Flatland Stories'), 1, 2, 9, [1, 2], { status: 4, seasons: find('tv', 'Flatland Stories').seasons.map((s) => ({ ...s, status: s.seasonNumber === 1 ? 5 : s.seasonNumber === 2 ? 3 : 1 })) });
  flat.seasons[0].status = 5; // season 1 is in (Seerr marks a season request completed)
  request(find('movie', 'Paper Moons'), 1, 2, 4, null, { status: 3 });
  request(find('movie', 'Spring'), 1, 5, 21);
  request(find('movie', 'Detour'), 1, 3, 40);
  request(find('movie', 'Sherlock Jr.'), 2, 1, 3, null, { status: 2 });

  // sessions: one cookie per user; `dead` ones were signed out on the server
  const dead = new Set();

  function mediaInfo(t) {
    if (t.status <= 1 && !requests.some((r) => r.tmdb === t.id && r.type === t.type)) return undefined;
    const reqs = requests.filter((r) => r.tmdb === t.id && r.type === t.type);
    return {
      id: t.id - 800000, tmdbId: t.id, tvdbId: null, mediaType: t.type, status: t.status, ratingKey: t.ratingKey || null,
      createdAt: iso(-30), updatedAt: iso(-1),
      seasons: (t.seasons || []).filter((s) => s.status > 1).map((s) => ({ id: s.seasonNumber, seasonNumber: s.seasonNumber, status: s.status })),
      requests: reqs.map((r) => ({ id: r.id, status: r.status, seasons: r.seasons, requestedBy: { id: r.userId } })),
      issues: [],
      downloadStatus: t.downloads || [],
    };
  }

  function result(t) {
    const out = { id: t.id, mediaType: t.type, overview: t.overview, posterPath: t.posterPath, backdropPath: t.backdropPath, mediaInfo: mediaInfo(t), popularity: 10 };
    if (t.type === 'movie') Object.assign(out, { title: t.title, releaseDate: t.date });
    else Object.assign(out, { name: t.name || t.title, firstAirDate: t.date });
    return out;
  }

  const list = (type, pick) => ({ page: 1, totalPages: 1, totalResults: 0, results: [...titles.values()].filter((t) => t.type === type && pick(t)).map(result) });
  const order = (names) => (t) => names.includes(t.title);
  const sorted = (type, names) => {
    const l = list(type, order(names));
    l.results.sort((a, b) => names.indexOf(a.title || a.name) - names.indexOf(b.title || b.name));
    return l;
  };

  function handle({ method, path, cookie, body }) {
    const send = (status, data, setCookie) => ({ status, data, setCookie });
    const url = new URL(path, 'http://seerr');
    const p = url.pathname.replace(/^\/api\/v1/, '');
    const q = url.searchParams;
    if (p === '/status') return send(200, { version: '3.4.1-demo' });
    if (p === '/auth/plex' && method === 'POST') {
      let tok = null;
      try { tok = JSON.parse(body || '{}').authToken; } catch { /* bad body */ }
      const u = USERS[tok];
      if (!u) return send(403, { message: 'Access denied.' });
      dead.delete(u.id);
      return send(200, { ...u, plexToken: 'secret' }, `connect.sid=s%3Ademo${u.id}; Path=/; HttpOnly; SameSite=Lax`);
    }
    const m = /connect\.sid=s%3Ademo(\d+)/.exec(cookie || '');
    const uid = m ? Number(m[1]) : 0;
    const user = Object.values(USERS).find((u) => u.id === uid);
    if (!user || dead.has(uid)) return send(403, DENIED);
    if (p === '/auth/logout') return send(200, { status: 'ok' }, 'connect.sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    if (p === '/auth/me') return send(200, user);
    // admin only, as in Overseerr: a signed-in user without the permission gets the same 403
    if (p.indexOf('/settings') === 0) return user.permissions & 2 ? send(200, {}) : send(403, DENIED);

    if (p === '/discover/trending') {
      const type = q.get('mediaType');
      const names = ['Big Buck Bunny', 'Metropolis', 'NASA Explorers', 'The Kid', 'Flatland Stories', 'Sintel', 'Tidal Island', 'Safety Last!',
        'Sherlock Jr.', 'NASA ScienceCasts', 'Spring', 'The Lighthouse Diaries', 'Caminandes', 'The Gold Rush', 'Night Shift Radio', 'Charade'];
      const all = names.map((n) => [...titles.values()].find((t) => t.title === n)).filter(Boolean).filter((t) => !type || type === 'all' || t.type === type);
      return send(200, { page: 1, totalPages: 1, totalResults: all.length, results: all.map(result) });
    }
    if (p === '/discover/movies') return send(200, sorted('movie', ['Sherlock Jr.', 'Tears of Steel', 'The Gold Rush', 'Safety Last!', 'Night of the Living Dead', 'A Trip to the Moon', 'Cosmos Laundromat', 'The Cabinet of Dr. Caligari', 'The Lodger', 'Detour', 'Nosferatu', 'His Girl Friday']));
    if (p === '/discover/movies/upcoming') return send(200, list('movie', (t) => t.upcoming));
    if (p === '/discover/tv') return send(200, sorted('tv', ['Tidal Island', 'NASA ScienceCasts', 'The Lighthouse Diaries', 'Caminandes', 'Flatland Stories', 'Night Shift Radio', 'NASA Explorers']));
    if (p === '/discover/tv/upcoming') return send(200, list('tv', (t) => t.upcoming));
    if (p === '/search') {
      const needle = String(q.get('query') || '').toLowerCase();
      const hits = [...titles.values()].filter((t) => needle && t.title.toLowerCase().includes(needle));
      return send(200, { page: 1, totalPages: 1, totalResults: hits.length, results: hits.map(result) });
    }
    let mm;
    if ((mm = /^\/(movie|tv)\/(\d+)$/.exec(p))) {
      const t = titles.get(`${mm[1]}:${mm[2]}`);
      if (!t) return send(404, { message: 'Unable to retrieve details.' });
      const r = result(t);
      if (t.type === 'tv') r.seasons = [{ seasonNumber: 0, name: 'Specials', episodeCount: 2 }].concat(t.seasons || []).map((s) => ({ seasonNumber: s.seasonNumber, name: s.name, episodeCount: s.episodeCount, airDate: s.airDate }));
      return send(200, r);
    }
    if (p === '/request' && method === 'GET') {
      const by = q.get('requestedBy') ? Number(q.get('requestedBy')) : null;
      // like Overseerr: someone without MANAGE_REQUESTS only ever sees their own
      if (!(user.permissions & 2) && by && by !== uid) return send(403, { message: 'You do not have permission to view this user\'s requests.' });
      const who = user.permissions & 2 ? by : uid;
      const mine = requests.filter((r) => !who || r.userId === who).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const take = Number(q.get('take') || 10);
      const page = mine.slice(Number(q.get('skip') || 0), Number(q.get('skip') || 0) + take);
      return send(200, {
        pageInfo: { pages: Math.ceil(mine.length / take), pageSize: take, results: mine.length, page: 1 },
        results: page.map((r) => {
          const t = titles.get(`${r.type}:${r.tmdb}`);
          const mi = mediaInfo(t) || { id: t.id - 800000, tmdbId: t.id, mediaType: t.type, status: t.status, downloadStatus: [] };
          // (Overseerr's list query doesn't load the media's seasons)
          const media = { ...mi };
          delete media.seasons;
          delete media.requests;
          return { id: r.id, status: r.status, type: r.type, createdAt: r.createdAt, updatedAt: r.updatedAt, is4k: r.is4k,
            media, seasons: r.seasons, requestedBy: { id: r.userId, displayName: 'x' }, modifiedBy: null };
        }),
      });
    }
    if (p === '/request' && method === 'POST') {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch { /* bad body */ }
      const t = titles.get(`${b.mediaType}:${b.mediaId}`);
      if (!t) return send(404, { message: 'Media not found' });
      const r = request(t, uid, 1, 0, b.seasons || []);
      if (t.status < 2) t.status = 2;
      return send(201, { id: r.id, status: 1, requestedBy: { id: uid } });
    }
    if (p === '/media') {
      const f = q.get('filter');
      const want = f === 'processing' ? 3 : f === 'partial' ? 4 : 5;
      return send(200, { pageInfo: {}, results: [...titles.values()].filter((t) => t.status === want).map(mediaInfo).filter(Boolean) });
    }
    if (p === '/issue' && method === 'POST') return send(201, { id: 7, createdBy: { id: uid } });
    return send(404, { message: `the demo Overseerr does not implement ${method} ${p}` });
  }

  return { handle, kill: (u) => dead.add(u), titles, requests };
}
