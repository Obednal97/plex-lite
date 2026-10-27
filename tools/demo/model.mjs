// Builds an in-memory, Plex-shaped library from tools/demo/library.json: rating keys, tag ids, image
// paths, hubs, search and the Live TV schedule. server.mjs turns these into HTTP answers.
//
// Everything here is demo content: openly licensed films (see docs/screenshots/CREDITS.md).
import { readFileSync } from 'node:fs';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// A stable, readable slug: "Tears of Steel" -> "tears-of-steel".
export const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-');

// "The General" sorts as "General"
const titleSort = (t) => String(t).replace(/^(the|a|an)\s+/i, '');

export function loadLibrary(file) {
  const lib = JSON.parse(readFileSync(file, 'utf8'));
  return new Model(lib);
}

class Model {
  constructor(lib) {
    this.lib = lib;
    this.seed = Number(process.env.PLEXLITE_DEMO_SEED) || 0;
    this.items = new Map(); // ratingKey -> Plex metadata (without heavy children)
    this.images = new Map(); // Plex image path -> image ref ("media:<id>" | "gen:<kind>/<key>")
    this.tags = new Map(); // "Genre:Animation" -> {id, tag}
    this.people = new Map(); // name -> {id, tag, thumb}
    this.nextKey = 1000;
    this.nextId = 1;
    this.sections = [
      { key: '1', type: 'movie', title: 'Movies', agent: 'tv.plex.agents.movie', scanner: 'Plex Movie' },
      { key: '2', type: 'show', title: 'TV Shows', agent: 'tv.plex.agents.series', scanner: 'Plex TV Series' },
    ];
    this.movies = [];
    this.shows = [];
    this.collections = [];
    const t0 = now();
    (lib.movies || []).forEach((m, i) => this.addMovie(m, t0 - (i * 2 + 1) * DAY * 3));
    (lib.shows || []).forEach((s, i) => this.addShow(s, t0 - (i * 3 + 2) * DAY));
    (lib.collections || []).forEach((c) => this.addCollection(c));
  }

  key() { return String(this.nextKey++); }

  random() {
    if (!this.seed) return Math.random();
    // mulberry32
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  tag(kind, name) {
    const k = `${kind}:${name}`;
    if (!this.tags.has(k)) this.tags.set(k, { id: this.nextId++, tag: name, filter: `${kind.toLowerCase()}=${this.nextId - 1}` });
    return this.tags.get(k);
  }

  person(name) {
    if (!this.people.has(name)) {
      const photo = (this.lib.people || {})[name];
      const p = { id: this.nextId++, tag: name };
      if (photo) p.thumb = this.imagePath(`/library/people/${p.id}/thumb`, `media:${photo}`);
      this.people.set(name, p);
    }
    return this.people.get(name);
  }

  // Registers an image under a Plex-looking path and returns the path.
  imagePath(path, ref) {
    if (!ref) return undefined;
    this.images.set(path, ref);
    return path;
  }

  art(rk, kind, media, gen) {
    const ref = media ? `media:${media}` : gen ? `gen:${gen}` : null;
    return this.imagePath(`/library/metadata/${rk}/${kind}/${this.nextId++}`, ref);
  }

  // One version per item: the demo's direct-play file (a WebM on Wikimedia Commons, see server.mjs).
  media(rk, durationMs, src) {
    const id = this.nextId++;
    const partId = this.nextId++;
    const video = src && this.lib.videos && this.lib.videos[src];
    const height = (video && video.height) || 1080;
    return [{
      id, duration: durationMs, bitrate: 4200, width: Math.round(height * 16 / 9), height, aspectRatio: 1.78,
      audioChannels: (video && video.audioChannels) || 2, audioCodec: 'opus', videoCodec: 'vp9', container: 'webm',
      videoResolution: String(height >= 1000 ? 1080 : height), videoFrameRate: '24p',
      Part: [{
        id: partId, key: `/library/parts/${partId}/1/file.webm`, duration: durationMs, container: 'webm',
        size: Math.round(durationMs / 1000 * 4200 * 1000 / 8), video: src || null,
        Stream: [
          { id: this.nextId++, streamType: 1, codec: 'vp9', index: 0, displayTitle: `${height}p (VP9)`, selected: true },
          { id: this.nextId++, streamType: 2, codec: 'opus', index: 1, channels: 2, language: 'English', languageCode: 'eng', displayTitle: 'English (Opus Stereo)', selected: true },
        ],
      }],
    }];
  }

  addMovie(m, addedAt) {
    const rk = this.key();
    const id = m.id || slug(m.title);
    const durationMs = Math.round((m.durationMin || 90) * 60000);
    const item = {
      ratingKey: rk, key: `/library/metadata/${rk}`, guid: `demo://movie/${id}`, type: 'movie',
      librarySectionID: 1, librarySectionKey: '/library/sections/1', librarySectionTitle: 'Movies',
      title: m.title, titleSort: titleSort(m.title), originalTitle: m.originalTitle, year: m.year,
      originallyAvailableAt: m.released || `${m.year}-01-01`, summary: m.summary, tagline: m.tagline,
      studio: m.studio, contentRating: m.contentRating || undefined, duration: durationMs,
      addedAt, updatedAt: addedAt, viewCount: m.watched ? 1 : undefined,
      lastViewedAt: m.watched || m.progress || m.offsetSec ? addedAt + DAY : undefined,
      viewOffset: m.offsetSec ? m.offsetSec * 1000 : m.progress ? Math.round(durationMs * m.progress) : undefined,
      thumb: this.art(rk, 'thumb', m.poster, `poster/${id}`),
      art: this.art(rk, 'art', m.backdrop, m.backdrop ? null : `art/${id}`),
      Genre: (m.genres || []).map((g) => this.tag('Genre', g)),
      Director: (m.director || []).map((n) => this.person(n)),
      Writer: (m.writer || []).map((n) => this.person(n)),
      Role: (m.cast || []).map((c) => ({ ...this.person(c.name), role: c.role })),
      Country: (m.country ? [m.country] : []).map((c) => this.tag('Country', c)),
      _id: id, _decade: Math.floor(m.year / 10) * 10, _section: '1', _src: m,
    };
    const logo = m.logo ? `media:${m.logo}` : m.genLogo ? `gen:logo/${id}` : null;
    if (logo) item.Image = [{ type: 'clearLogo', url: this.imagePath(`/library/metadata/${rk}/clearLogo/${this.nextId++}`, logo) }];
    item.Media = this.media(rk, durationMs, m.video);
    item.Extras = (m.extras || []).map((x, i) => this.addExtra(item, x, i));
    if (m.markers) item._markers = m.markers;
    if (m.chapters) item._chapters = m.chapters;
    this.items.set(rk, item);
    this.movies.push(item);
    return item;
  }

  addExtra(parent, x, i) {
    const rk = this.key();
    const durationMs = Math.round((x.durationMin || 3) * 60000);
    const extra = {
      ratingKey: rk, key: `/library/metadata/${rk}`, type: 'clip', subtype: x.subtype || 'trailer', extraType: 1,
      title: x.title, year: x.year || parent.year, duration: durationMs, index: i + 1,
      thumb: this.art(rk, 'thumb', x.thumb, `art/${slug(x.title)}`), parentRatingKey: parent.ratingKey,
      _section: parent._section,
    };
    extra.art = extra.thumb;
    extra.Media = this.media(rk, durationMs, x.video);
    this.items.set(rk, extra);
    return extra;
  }

  addShow(s, addedAt) {
    const rk = this.key();
    const id = s.id || slug(s.title);
    const show = {
      ratingKey: rk, key: `/library/metadata/${rk}/children`, guid: `demo://show/${id}`, type: 'show',
      librarySectionID: 2, librarySectionKey: '/library/sections/2', librarySectionTitle: 'TV Shows',
      title: s.title, titleSort: titleSort(s.title), year: s.year, originallyAvailableAt: s.released || `${s.year}-01-01`,
      summary: s.summary, studio: s.studio, contentRating: s.contentRating || undefined,
      addedAt, updatedAt: addedAt,
      thumb: this.art(rk, 'thumb', s.poster, `poster/${id}`),
      art: this.art(rk, 'art', s.backdrop, s.backdrop ? null : `art/${id}`),
      Genre: (s.genres || []).map((g) => this.tag('Genre', g)),
      Director: (s.director || []).map((n) => this.person(n)),
      Writer: (s.writer || []).map((n) => this.person(n)),
      Role: (s.cast || []).map((c) => ({ ...this.person(c.name), role: c.role })),
      _id: id, _decade: Math.floor(s.year / 10) * 10, _section: '2', _src: s, _seasons: [],
    };
    const logo = s.logo ? `media:${s.logo}` : s.genLogo ? `gen:logo/${id}` : null;
    if (logo) show.Image = [{ type: 'clearLogo', url: this.imagePath(`/library/metadata/${rk}/clearLogo/${this.nextId++}`, logo) }];
    this.items.set(rk, show);
    let leaf = 0;
    let viewed = 0;
    (s.seasons || []).forEach((se) => {
      const srk = this.key();
      const season = {
        ratingKey: srk, key: `/library/metadata/${srk}/children`, type: 'season', index: se.index,
        title: se.title || (se.index === 0 ? 'Specials' : `Season ${se.index}`),
        parentRatingKey: rk, parentKey: show.key.replace('/children', ''), parentTitle: show.title, parentIndex: undefined,
        parentThumb: show.thumb, parentArt: show.art, art: show.art,
        thumb: se.poster ? this.art(srk, 'thumb', se.poster) : show.thumb,
        librarySectionID: 2, addedAt, _section: '2', _episodes: [],
      };
      this.items.set(srk, season);
      show._seasons.push(season);
      (se.episodes || []).forEach((e, i) => {
        const erk = this.key();
        const durationMs = Math.round((e.durationMin || 10) * 60000);
        const ep = {
          ratingKey: erk, key: `/library/metadata/${erk}`, type: 'episode', index: e.index || i + 1, parentIndex: se.index,
          title: e.title, summary: e.summary, originallyAvailableAt: e.aired, year: e.aired ? Number(e.aired.slice(0, 4)) : s.year,
          duration: durationMs, contentRating: show.contentRating,
          parentRatingKey: srk, parentTitle: season.title, parentThumb: season.thumb,
          grandparentRatingKey: rk, grandparentTitle: show.title, grandparentThumb: show.thumb, grandparentArt: show.art,
          grandparentKey: `/library/metadata/${rk}`,
          thumb: this.art(erk, 'thumb', e.thumb, e.thumb ? null : `still/${id}-${se.index}-${i + 1}`),
          art: show.art, addedAt: addedAt - (100 - i) * 60,
          viewCount: e.watched ? 1 : undefined,
          viewOffset: e.offsetSec ? e.offsetSec * 1000 : e.progress ? Math.round(durationMs * e.progress) : undefined,
          lastViewedAt: e.watched || e.progress || e.offsetSec ? addedAt + DAY + (e.offsetSec ? 3600 : 0) : undefined,
          Director: (e.director || []).map((n) => this.person(n)),
          Writer: (e.writer || []).map((n) => this.person(n)),
          librarySectionID: 2, _section: '2',
        };
        if (show.Image) ep.Image = show.Image;
        ep.Media = this.media(erk, durationMs, e.video);
        if (e.markers) ep._markers = e.markers;
        this.items.set(erk, ep);
        season._episodes.push(ep);
        leaf++;
        if (e.watched) viewed++;
      });
      season.leafCount = season._episodes.length;
      season.viewedLeafCount = season._episodes.filter((e) => e.viewCount).length;
    });
    show.childCount = show._seasons.length;
    show.leafCount = leaf;
    show.viewedLeafCount = viewed;
    const eps = this.episodesOf(show);
    show.duration = eps.length ? eps[0].duration : undefined;
    show.lastViewedAt = Math.max(0, ...eps.map((e) => e.lastViewedAt || 0)) || undefined;
    this.shows.push(show);
  }

  addCollection(c) {
    const rk = this.key();
    const members = c.items.map((t) => this.movies.find((m) => m._id === t || m.title === t)).filter(Boolean);
    const id = c.id || slug(c.title);
    const col = {
      ratingKey: rk, key: `/library/collections/${rk}/children`, type: 'collection', subtype: 'movie',
      title: c.title, titleSort: titleSort(c.title), summary: c.summary, childCount: members.length,
      thumb: this.art(rk, 'thumb', c.poster, `collection/${rk}`),
      art: members[0] && members[0].art, librarySectionID: 1, addedAt: now() - DAY, _members: members, _id: id,
    };
    this.items.set(rk, col);
    this.collections.push(col);
  }

  episodesOf(show) {
    return show._seasons.filter((s) => s.index > 0).concat(show._seasons.filter((s) => s.index === 0))
      .reduce((a, s) => a.concat(s._episodes), []);
  }

  // The next unwatched (or in-progress) episode, else the first.
  onDeck(show) {
    const eps = this.episodesOf(show);
    return eps.find((e) => e.viewOffset) || eps.find((e) => !e.viewCount) || eps[0] || null;
  }

  // ---- Listing -------------------------------------------------------------------------------

  sectionItems(key, type) {
    if (key === '1') return this.movies;
    if (key === '2') {
      if (String(type) === '4') return this.shows.reduce((a, s) => a.concat(this.episodesOf(s)), []);
      return this.shows;
    }
    return [];
  }

  filter(items, q) {
    let out = items;
    const tagFilter = (field, name) => {
      const v = q.get(name);
      if (!v) return;
      const ids = v.split(',').map(Number);
      out = out.filter((it) => (it[field] || []).some((t) => ids.includes(t.id)));
    };
    tagFilter('Genre', 'genre');
    tagFilter('Role', 'actor');
    tagFilter('Director', 'director');
    tagFilter('Writer', 'writer');
    if (q.get('decade')) out = out.filter((it) => String(it._decade) === q.get('decade'));
    if (q.get('unwatched') === '1') {
      out = out.filter((it) => (it.type === 'show' ? it.viewedLeafCount < it.leafCount : !it.viewCount));
    }
    return this.sort(out, q.get('sort') || 'titleSort');
  }

  sort(items, spec) {
    const [field, dir] = spec.split(':');
    const val = {
      titleSort: (i) => (i.titleSort || i.title || '').toLowerCase(),
      addedAt: (i) => i.addedAt || 0,
      'episode.addedAt': (i) => i.addedAt || 0,
      originallyAvailableAt: (i) => i.originallyAvailableAt || '',
      lastViewedAt: (i) => i.lastViewedAt || 0,
      duration: (i) => i.duration || 0,
      audienceRating: (i) => i.year || 0,
      rating: (i) => i.year || 0,
    }[field];
    const out = items.slice();
    if (field === 'random') {
      // Fisher-Yates; PLEXLITE_DEMO_SEED makes it repeatable (tools/demo/shots.mjs uses it)
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
    if (!val) return out;
    out.sort((a, b) => { const x = val(a); const y = val(b); return x < y ? -1 : x > y ? 1 : 0; });
    return dir === 'desc' ? out.reverse() : out;
  }

  // /library/sections/{id}/firstCharacter: titles per first letter, in titleSort order, as Plex does
  // it ('#' for digits and symbols, letters folded to upper case, letters without titles left out).
  // Built from runs over the sorted list so the counts always add up to this mock's own sort order.
  firstCharacter(items) {
    const out = [];
    for (const it of this.sort(items, 'titleSort')) {
      const c = (it.titleSort || it.title || '').charAt(0).normalize('NFD').charAt(0).toUpperCase();
      const letter = c >= 'A' && c <= 'Z' ? c : '#';
      const last = out[out.length - 1];
      if (last && last.title === letter) last.size++;
      else out.push({ key: letter === '#' ? '%23' : letter, title: letter, size: 1 });
    }
    return out;
  }

  tagDirectory(sectionKey, kind) {
    const items = this.sectionItems(sectionKey);
    if (kind === 'decade') {
      const decades = [...new Set(items.map((i) => i._decade))].sort((a, b) => b - a);
      return decades.map((d) => ({ key: String(d), title: `${d}s`, fastKey: `/library/sections/${sectionKey}/all?decade=${d}` }));
    }
    const field = { genre: 'Genre', actor: 'Role', director: 'Director', writer: 'Writer', country: 'Country' }[kind];
    if (!field) return [];
    const seen = new Map();
    items.forEach((i) => (i[field] || []).forEach((t) => seen.set(t.id, t)));
    return [...seen.values()].sort((a, b) => a.tag.localeCompare(b.tag))
      .map((t) => ({ key: String(t.id), title: t.tag, fastKey: `/library/sections/${sectionKey}/all?${kind}=${t.id}` }));
  }

  // ---- Hubs ------------------------------------------------------------------------------------

  hub(id, title, type, items, extra) {
    return { hubKey: `/hubs/demo/${id}`, key: `/hubs/demo/${id}`, hubIdentifier: id, title, type, size: items.length,
      more: false, style: 'shelf', Metadata: items, ...extra };
  }

  sectionHubs(key) {
    const hubs = [];
    if (key === '1') {
      const m = this.movies;
      const inProgress = m.filter((i) => i.viewOffset).sort((a, b) => b.lastViewedAt - a.lastViewedAt);
      if (inProgress.length) hubs.push(this.hub('movie.inprogress.1', 'Continue Watching', 'movie', inProgress));
      hubs.push(this.hub('movie.recentlyadded.1', 'Recently Added', 'movie', this.sort(m, 'addedAt:desc').slice(0, 20)));
      (this.lib.movieHubs || []).forEach((h, i) => {
        const items = h.genre ? m.filter((x) => x.Genre.some((g) => g.tag === h.genre)) : h.items.map((t) => m.find((x) => x._id === t || x.title === t)).filter(Boolean);
        if (items.length) hubs.push(this.hub(`movie.demo.${i}`, h.title, 'movie', items));
      });
    } else if (key === '2') {
      const eps = this.shows.reduce((a, s) => a.concat(this.episodesOf(s)), []);
      const inProgress = eps.filter((e) => e.viewOffset).sort((a, b) => b.lastViewedAt - a.lastViewedAt);
      const next = this.shows.filter((s) => s.viewedLeafCount > 0 && s.viewedLeafCount < s.leafCount).map((s) => this.onDeck(s))
        .filter((e) => e && !inProgress.includes(e));
      if (inProgress.length || next.length) hubs.push(this.hub('tv.inprogress.2', 'Continue Watching', 'episode', inProgress.concat(next)));
      hubs.push(this.hub('tv.recentlyadded.2', 'Recently Added', 'show', this.sort(this.shows, 'addedAt:desc')));
      (this.lib.showHubs || []).forEach((h, i) => {
        const items = h.genre ? this.shows.filter((x) => x.Genre.some((g) => g.tag === h.genre)) : h.items.map((t) => this.shows.find((x) => x._id === t || x.title === t)).filter(Boolean);
        if (items.length) hubs.push(this.hub(`tv.demo.${i}`, h.title, 'show', items));
      });
    }
    return hubs;
  }

  related(item) {
    const genres = new Set((item.Genre || []).map((g) => g.id));
    const pool = item.type === 'movie' ? this.movies : this.shows;
    const scored = pool.filter((x) => x !== item)
      .map((x) => ({ x, s: (x.Genre || []).filter((g) => genres.has(g.id)).length + (x.Director || []).filter((d) => (item.Director || []).some((e) => e.id === d.id)).length * 2 }))
      .filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.x).slice(0, 20);
    return scored.length ? [this.hub(`${item.type}.similar`, 'More Like This', item.type, scored)] : [];
  }

  search(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const words = q.split(/\s+/);
    const hit = (s) => { const t = String(s || '').toLowerCase(); return words.every((w) => t.includes(w)); };
    const movies = this.movies.filter((m) => hit(m.title));
    const shows = this.shows.filter((s) => hit(s.title));
    const episodes = this.shows.reduce((a, s) => a.concat(this.episodesOf(s)), []).filter((e) => hit(e.title));
    const people = [...this.people.values()].filter((p) => hit(p.tag)).slice(0, 20)
      .map((p) => ({ id: p.id, tag: p.tag, thumb: p.thumb, librarySectionID: 1, type: 'tag', tagType: 6 }));
    const hubs = [];
    if (movies.length) hubs.push(this.hub('movie', 'Movies', 'movie', movies));
    if (shows.length) hubs.push(this.hub('show', 'Shows', 'show', shows));
    if (episodes.length) hubs.push(this.hub('episode', 'Episodes', 'episode', episodes));
    if (people.length) hubs.push({ hubIdentifier: 'actor', title: 'People', type: 'actor', size: people.length, Directory: people });
    return hubs;
  }

  // ---- Live TV -----------------------------------------------------------------------------------

  // A repeating schedule per channel, aligned to local midnight so it is the same on every request.
  schedule(channel) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const start = Math.floor(day.getTime() / 1000) - DAY;
    const items = channel.items.map((t) => this.findTitle(t)).filter(Boolean)
      .reduce((a, it) => a.concat(it.type === 'show' ? this.episodesOf(it) : [it]), []);
    const out = [];
    if (!items.length) return out;
    let t = start + (channel.offsetMin || 0) * 60;
    let i = 0;
    while (t < start + 3 * DAY) {
      const it = items[i % items.length];
      // round each slot up to 5 minutes, like a real guide
      const len = Math.max(5, Math.ceil(it.duration / 60000 / 5) * 5) * 60;
      out.push({ item: it, beginsAt: t, endsAt: t + len });
      t += len;
      i++;
    }
    return out;
  }

  findTitle(t) {
    return this.movies.find((m) => m._id === t || m.title === t) || this.shows.find((s) => s._id === t || s.title === t);
  }
}
