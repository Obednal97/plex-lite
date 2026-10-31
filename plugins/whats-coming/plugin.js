// What's coming: Sonarr's and Radarr's calendars through the home server helper (PL.homeHelper).
//   - "New episodes this week" on TV libraries' Recommended: episodes of shows in that library that
//     aired in the last two days or air in the next seven ("S2 E5 · Tonight 21:00"), tagged New or
//     Premiere. OK opens the episode when it has a file, else the show.
//   - "Films arriving soon" on movie libraries' Recommended: Radarr's monitored films with a release
//     date in that window ("Digital release Friday").
//   - On a show's (or season's) details page: "3 episodes missing" from /missing, and "Search for
//     missing episodes" (POST /missing/search).
// Everything hides when the helper, Sonarr or Radarr isn't available. Helper answers are cached
// (/coming 15 min, /missing 5 min per show) and so are Plex library matches (30 min).
'use strict';

(function () {
  var COMING_MS = 15 * 60 * 1000;
  var MISSING_MS = 5 * 60 * 1000;
  var MATCH_MS = 30 * 60 * 1000;
  var MAX_ITEMS = 20;
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var RELEASE = { digital: 'Digital release', physical: 'Disc release', cinema: 'In cinemas' };

  var W = PL.whatsComing = {};

  function H() { return PL.homeHelper; }

  // ---- Dates -------------------------------------------------------------------------------------

  function pad(n) { return ('0' + n).slice(-2); }

  // "2026-11-06" is a calendar day (local midnight); anything with a time is an instant
  W.parseDate = function (s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  function dayNum(d) { return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); }

  function dayWords(d, now) {
    var diff = dayNum(d) - dayNum(now);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()];
    if (diff < 0 && diff > -7) return WEEKDAYS[d.getDay()];
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // "Tonight 21:00", "Today 14:30", "Tomorrow 21:00", "Thursday", "Aired yesterday", "Aired today"
  W.episodeWhen = function (iso, now) {
    var d = W.parseDate(iso);
    now = now || new Date();
    if (!d) return '';
    var diff = dayNum(d) - dayNum(now);
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.getTime() > now.getTime()) {
      if (diff <= 0) return (d.getHours() >= 17 ? 'Tonight ' : 'Today ') + time;
      if (diff === 1) return 'Tomorrow ' + time;
      return cap(dayWords(d, now));
    }
    return 'Aired ' + dayWords(d, now);
  };

  // "Digital release Friday", "In cinemas tomorrow", "In cinemas now", "Ready to watch"
  W.filmWhen = function (item, now) {
    now = now || new Date();
    if (item.hasFile) return 'Ready to watch';
    var d = W.parseDate(item.releaseDate);
    var what = RELEASE[item.releaseType] || 'Out';
    if (!d) return what;
    if (item.releaseType === 'cinema' && dayNum(d) < dayNum(now)) return 'In cinemas now';
    return what + ' ' + dayWords(d, now);
  };

  // ---- Episodes: one card per show and day ---------------------------------------------------------

  // "S2 E5", "S2 E1–E8", "S2 · 3 episodes"
  W.episodeLabel = function (season, eps) {
    var list = eps.slice().sort(function (a, b) { return a - b; });
    if (list.length === 1) return 'S' + season + ' E' + list[0];
    var run = list.every(function (e, i) { return i === 0 || e === list[i - 1] + 1; });
    return run ? 'S' + season + ' E' + list[0] + '–E' + list[list.length - 1] : 'S' + season + ' · ' + list.length + ' episodes';
  };

  // /coming tv items -> [{tvdbId, title, year, season, episodes, titles, at, aired, hasFile, premiere}]
  W.groupEpisodes = function (items, now) {
    now = now || new Date();
    var groups = {};
    var order = [];
    (items || []).forEach(function (it) {
      if (!it || it.mediaType !== 'tv' || !it.tvdbId || it.season == null || it.episode == null) return;
      var d = W.parseDate(it.airDateUtc);
      if (!d) return;
      var key = it.tvdbId + ':' + it.season + ':' + dayNum(d);
      var g = groups[key];
      if (!g) {
        g = groups[key] = { tvdbId: Number(it.tvdbId), title: it.title || '', year: it.year, season: it.season, episodes: [], titles: [],
          at: d, aired: false, hasFile: false, premiere: false, seriesPremiere: false };
        order.push(key);
      }
      g.episodes.push(it.episode);
      if (it.episodeTitle) g.titles.push(it.episodeTitle);
      if (d < g.at) g.at = d;
      if (d.getTime() <= now.getTime()) g.aired = true;
      if (it.hasFile) g.hasFile = true;
      if (it.seasonPremiere || it.seriesPremiere) g.premiere = true;
      if (it.seriesPremiere) g.seriesPremiere = true;
    });
    return order.map(function (k) { return groups[k]; }).sort(function (a, b) { return a.at - b.at; });
  };

  W.episodeTag = function (g) {
    if (g.premiere) return 'Premiere';
    if (g.aired && g.hasFile) return 'New';
    return '';
  };

  // ---- Helper answers (cached) ---------------------------------------------------------------------

  var coming = { url: null, at: 0, items: null, pending: null };

  W.coming = function () {
    var url = H().url();
    if (coming.url !== url) coming = { url: url, at: 0, items: null, pending: null };
    var mine = coming;
    if (mine.items && Date.now() - mine.at < COMING_MS) return Promise.resolve(mine.items);
    if (mine.pending) return mine.pending;
    mine.pending = H().get('/coming?days=7', { timeout: 6000 }).then(function (data) {
      mine.pending = null;
      mine.items = (data && data.items) || [];
      mine.at = Date.now();
      return mine.items;
    }, function (err) {
      mine.pending = null;
      throw err;
    });
    return mine.pending;
  };

  // tvdbId -> {at, value: /missing answer | null (Sonarr doesn't have the show)}
  var missing = {};

  W.missing = function (tvdbId, maxAge) {
    var hit = missing[tvdbId];
    if (hit && Date.now() - hit.at < (maxAge == null ? MISSING_MS : maxAge)) return Promise.resolve(hit.value);
    if (hit && hit.pending) return hit.pending;
    var p = H().get('/missing?tvdbId=' + encodeURIComponent(tvdbId), { timeout: 6000 }).then(function (data) {
      missing[tvdbId] = { at: Date.now(), value: data };
      return data;
    }, function (err) {
      if (err.code === 'not_found') {
        missing[tvdbId] = { at: Date.now(), value: null };
        return null;
      }
      delete missing[tvdbId];
      throw err;
    });
    missing[tvdbId] = { at: 0, value: null, pending: p };
    return p;
  };

  W.forgetMissing = function (tvdbId) { delete missing[tvdbId]; };

  // Missing aired episodes in a /missing answer (season: one season, else all but specials)
  W.missingCount = function (data, season) {
    if (!data || !data.seasons) return 0;
    return data.seasons.reduce(function (n, s) {
      if (season != null ? s.season !== season : s.season === 0) return n;
      return n + ((s.missing && s.missing.length) || 0);
    }, 0);
  };

  // ---- Plex library matches ------------------------------------------------------------------------

  var matches = {};

  function normTitle(s) { return String(s || '').toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

  // The library item for a Sonarr/Radarr title: TVDB/TMDB Guid first, else title and year.
  W.pickMatch = function (list, want) {
    var scheme = want.tvdbId ? 'tvdb' : 'tmdb';
    var id = String(want.tvdbId || want.tmdbId || '');
    var byId = (list || []).filter(function (m) { return id && H().guid(m, scheme) === id; })[0];
    if (byId) return byId;
    return (list || []).filter(function (m) {
      return normTitle(m.title) === normTitle(want.title) && (!want.year || !m.year || Math.abs(m.year - want.year) <= 1);
    })[0] || null;
  };

  // Promise<Plex item | null> in this library section (type 2 shows, 1 movies)
  W.findInSection = function (section, want) {
    var key = section.key + ':' + (want.tvdbId ? 'tv' + want.tvdbId : 'mv' + want.tmdbId);
    var hit = matches[key];
    if (hit && (hit.pending || Date.now() - hit.at < MATCH_MS)) return hit.pending || Promise.resolve(hit.value);
    var type = want.tvdbId ? 2 : 1;
    var ask = function (title) {
      return PL.plex.get('/library/sections/' + section.key + '/all', { type: type, title: title, includeGuids: 1 }).then(function (mc) {
        return W.pickMatch(mc.Metadata || [], want);
      });
    };
    var short = String(want.title || '').replace(/\s*\(\d{4}\)\s*$/, '');
    var p = ask(want.title).then(function (m) { return m || (short !== want.title ? ask(short) : null); }).then(function (m) {
      matches[key] = { at: Date.now(), value: m };
      return m;
    }, function () {
      delete matches[key];
      return null;
    });
    matches[key] = { at: 0, pending: p };
    return p;
  };

  // ---- Shelves --------------------------------------------------------------------------------------

  function touch() { return !!(PL.touch && PL.touch.engaged); }

  function tagged(tag, caption) {
    // the touch layer draws its own cards (no badge): the tag joins the caption there
    return touch() && tag ? tag + ' · ' + caption : caption;
  }

  function makeCard(ctx) {
    return function (item, kind, geo) {
      var node = ctx.ui.makeCard(item, kind, geo);
      return item.tag ? ctx.ui.badge(node, 'wc-tag wc-tag-' + item.tag.toLowerCase(), item.tag) : node;
    };
  }

  function tvShelf(section, items, ctx) {
    var now = new Date();
    var groups = W.groupEpisodes(items, now);
    var shows = {};
    groups.forEach(function (g) { shows[g.tvdbId] = g; });
    return Promise.all(Object.keys(shows).map(function (id) {
      var g = shows[id];
      return W.findInSection(section, { tvdbId: g.tvdbId, title: g.title, year: g.year }).then(function (m) { return [id, m]; });
    })).then(function (pairs) {
      var inLib = {};
      pairs.forEach(function (p) { if (p[1]) inLib[p[0]] = p[1]; });
      var out = groups.filter(function (g) { return inLib[g.tvdbId]; }).slice(0, MAX_ITEMS).map(function (g) {
        var show = inLib[g.tvdbId];
        var tag = W.episodeTag(g);
        var label = W.episodeLabel(g.season, g.episodes);
        var caption = label + ' · ' + W.episodeWhen(g.at.toISOString(), now);
        return {
          ratingKey: 'wc-ep-' + g.tvdbId + '-' + g.season + '-' + g.episodes.join('.'),
          type: 'coming',
          title: show.title,
          year: tagged(tag, caption),
          thumb: show.thumb,
          art: show.art,
          Image: show.Image,
          summary: g.titles.length === 1 ? g.titles[0] : g.titles.length ? g.episodes.length + ' episodes: ' + g.titles.slice(0, 3).join(', ') : '',
          tag: tag,
          coming: { kind: 'episode', showKey: String(show.ratingKey), showTitle: show.title, season: g.season, episode: Math.min.apply(null, g.episodes), hasFile: g.hasFile && g.aired },
        };
      });
      if (!out.length) return null;
      return { id: 'episodes', title: 'New episodes this week', kind: 'wide', items: out, makeCard: makeCard(ctx), onSelect: function (it) { open(ctx, it); } };
    });
  }

  function filmShelf(section, items, ctx) {
    var now = new Date();
    var films = (items || []).filter(function (it) { return it && it.mediaType === 'movie' && it.tmdbId; });
    var seen = {};
    films = films.filter(function (f) { if (seen[f.tmdbId]) return false; seen[f.tmdbId] = true; return true; }).slice(0, MAX_ITEMS);
    if (!films.length) return null;
    return {
      id: 'films',
      title: 'Films arriving soon',
      kind: 'wide',
      items: films.map(function (f) {
        var d = W.parseDate(f.releaseDate);
        var tag = f.hasFile && d && d <= now ? 'New' : '';
        return {
          ratingKey: 'wc-film-' + f.tmdbId,
          type: 'coming',
          title: f.title || '',
          year: tagged(tag, W.filmWhen(f, now)),
          thumb: f.posterUrl || null,
          art: f.fanartUrl || f.posterUrl || null,
          summary: '',
          tag: tag,
          coming: { kind: 'film', tmdbId: Number(f.tmdbId), title: f.title, year: f.year, hasFile: !!f.hasFile, section: section, when: W.filmWhen(f, now), date: d },
        };
      }),
      makeCard: makeCard(ctx),
      onSelect: function (it) { open(ctx, it); },
    };
  }

  // OK on a card: the episode (once it has a file) or the show; a film in the library, else a note
  function open(ctx, item) {
    var c = item.coming;
    if (c.kind === 'episode') {
      var show = { ratingKey: c.showKey, type: 'show', title: c.showTitle };
      if (!c.hasFile) { ctx.openItem(show); return; }
      ctx.plex.children(c.showKey).then(function (seasons) {
        var season = seasons.filter(function (s) { return s.index === c.season; })[0];
        if (!season) return null;
        return ctx.plex.children(season.ratingKey).then(function (eps) {
          return eps.filter(function (e) { return e.index === c.episode; })[0] || null;
        });
      }).then(function (ep) { ctx.openItem(ep || show); }, function () { ctx.openItem(show); });
      return;
    }
    var note = function () {
      // "Digital release Monday 2 Nov" (the caption already says Monday; the date pins it down)
      var day = c.date && !c.hasFile && !/ \d+ [A-Z][a-z]{2}$/.test(c.when) && !/now$/.test(c.when) ? ' ' + c.date.getDate() + ' ' + MONTHS[c.date.getMonth()] : '';
      ctx.sheet([{
        heading: c.title + (c.year ? ' (' + c.year + ')' : ''),
        rows: [{ label: c.when + day, sub: c.hasFile ? 'Plex hasn\'t added it yet' : 'Radarr gets it then', action: function () {} }],
      }]);
    };
    if (!c.hasFile) { note(); return; }
    W.findInSection(c.section, { tmdbId: c.tmdbId, title: c.title, year: c.year }).then(function (m) {
      if (m) ctx.openItem({ ratingKey: String(m.ratingKey), type: 'movie', title: m.title });
      else note();
    });
  }

  // ---- Details: missing episodes ---------------------------------------------------------------------

  function showOrSeason(item) { return item && (item.type === 'show' || item.type === 'season'); }

  function missingLabel(n) { return n === 1 ? '1 episode missing' : n + ' episodes missing'; }

  function searchMissing(ctx, item) {
    H().titleIds(ctx, item).then(function (ids) {
      var body = { tvdbId: ids.tvdbId };
      if (ids.season != null) body.season = ids.season;
      H().busy('Asking Sonarr to search…');
      return H().post('/missing/search', body, ctx, { timeout: 20000 }).then(function (r) {
        W.forgetMissing(ids.tvdbId);
        var n = (r && r.episodes) || 0;
        var eps = n === 1 ? '1 episode' : n + ' episodes';
        if (H().dryRun(r)) ctx.toast(n ? 'Dry run: the helper would search for ' + eps : 'Dry run: nothing missing to search for', 5000);
        else ctx.toast(!r || !r.queued || !n ? 'Nothing missing to search for' : 'Searching for ' + (n === 1 ? '1 missing episode' : n + ' missing episodes'));
      });
    }).then(null, function (err) {
      ctx.toast(err.code === 'no_id' ? err.message : H().errorText(err, 'Sonarr'), 5000);
    });
  }

  PL.plugins.register({
    id: 'whats-coming',
    name: 'What\'s coming',
    version: '1.0.0',
    apiVersion: 1,
    description: 'New episodes this week and films arriving soon, from Sonarr and Radarr through the home server helper.',

    shelfRows: function (section, ctx) {
      var hh = H();
      if (!hh || !hh.url() || !section || (section.type !== 'show' && section.type !== 'movie')) return null;
      var tv = section.type === 'show';
      return hh.health().then(function (h) {
        if (!h || !h.services[tv ? 'sonarr' : 'radarr']) return null;
        return W.coming().then(function (items) { return tv ? tvShelf(section, items, ctx) : filmShelf(section, items, ctx); });
      });
    },

    badges: function (item, ctx) {
      var hh = H();
      if (!hh || !hh.url() || !showOrSeason(item)) return null;
      return hh.health().then(function (h) {
        if (!h || !h.services.sonarr) return [];
        return hh.titleIds(ctx, item).then(function (ids) {
          return W.missing(ids.tvdbId).then(function (data) {
            var n = W.missingCount(data, ids.season);
            return n ? [{ label: missingLabel(n) }] : [];
          });
        });
      });
    },

    // Shown while Sonarr is up, unless the cached /missing says there's nothing to find.
    actions: function (item, ctx) {
      var hh = H();
      if (!hh || !showOrSeason(item) || !hh.has('sonarr')) return [];
      var tvdb = item.type === 'show' ? hh.guid(item, 'tvdb') : null;
      if (tvdb) {
        var hit = missing[tvdb];
        if (hit && hit.at && Date.now() - hit.at < MISSING_MS && (!hit.value || !W.missingCount(hit.value))) return [];
      } else if (item.type === 'show') {
        return [];
      }
      return [{ label: 'Search for missing episodes', icon: 'download', run: function () { searchMissing(ctx, item); } }];
    },
  });
})();
