// Overseerr plugin, shared core: per-profile sessions, API calls, permissions, Plex -> Overseerr
// mapping and the download list. Loaded before report.js, downloads.js and plugin.js, which use
// PL.overseerr. Works with Overseerr and its successor Seerr (same /api/v1).
//
// Sessions follow the active Plex Home profile: each profile signs in to Overseerr with its own
// Plex token, so requests and problem reports are made under that person's own account. A profile
// signs in automatically once it has signed in on this TV before; the first time is an explicit
// choice in Settings, because Overseerr may create an account for a Plex user it hasn't seen.
'use strict';

(function () {
  var O = PL.overseerr = {};

  O.TMDB_IMG = 'https://image.tmdb.org/t/p/';
  // TMDB artwork at a TMDB size ('w342', 'w780'); the Plex server resizes it for the screen. (The
  // demo server swaps this for its own images.)
  O.img = function (path, size) { return path ? O.TMDB_IMG + size + path : null; };
  // Overseerr/Seerr permission bits (server/lib/permissions.ts)
  O.PERM = { ADMIN: 2, MANAGE_ISSUES: 1048576, CREATE_ISSUES: 4194304 };
  var STATUS_REFRESH_MS = 10 * 60 * 1000;
  var DOWNLOADS_MAX_AGE = 20000;

  // ---- Config and profiles ------------------------------------------------------------------------

  // {url, helperUrl?, profiles: {key: {user: {id, displayName, permissions}, at}}}
  O.config = function (ctx) {
    var cfg = ctx.storage.get('config', null);
    if (cfg && cfg.user && !cfg.profiles) {
      // version 1: one session, signed in by whoever was active; adopt it for the account owner only
      cfg.profiles = {};
      if (!ctx.profile()) cfg.profiles[O.profileKey(ctx)] = { user: cfg.user, at: Date.now() };
      delete cfg.user;
      ctx.storage.set('config', cfg);
    }
    if (cfg && !cfg.profiles) cfg.profiles = {};
    return cfg;
  };

  function saveConfig(ctx, cfg) { ctx.storage.set('config', cfg); }

  // 32-bit FNV-1a, hex: tells tokens apart without storing them
  function fingerprint(s) {
    var h = 0x811c9dc5;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // The service keeps one Overseerr session per key. Profiles are keyed by their Plex Home uuid; the
  // account owner (no profile picked) by a fingerprint of the account token.
  O.profileKey = function (ctx) {
    var p = ctx.profile();
    if (p && p.uuid) return 'p-' + String(p.uuid).replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    return 'o-' + fingerprint(ctx.plexToken());
  };

  O.profileName = function (ctx) {
    var p = ctx.profile();
    return (p && p.title) || 'Account owner';
  };

  // the Overseerr user this profile is signed in as (null: this profile hasn't signed in here)
  O.account = function (ctx) {
    var cfg = O.config(ctx);
    var a = cfg && cfg.profiles[O.profileKey(ctx)];
    return a && a.user ? a.user : null;
  };

  O.ready = function (ctx) {
    var cfg = O.config(ctx);
    return !!(cfg && cfg.url && O.account(ctx));
  };

  O.can = function (user, bits) {
    var p = (user && user.permissions) || 0;
    if (p & O.PERM.ADMIN) return true;
    for (var i = 0; i < bits.length; i++) if (p & bits[i]) return true;
    return false;
  };

  O.canReport = function (ctx) {
    return O.ready(ctx) && O.can(O.account(ctx), [O.PERM.MANAGE_ISSUES, O.PERM.CREATE_ISSUES]);
  };

  // ---- Service calls --------------------------------------------------------------------------------

  // The webOS service on the TV; in the web build seerr-web.js answers the same methods from the
  // browser (O.web, only loaded there).
  function service(ctx, method, params) {
    return O.web ? O.web.call(ctx, method, params) : ctx.service(method, params);
  }

  O.signIn = function (ctx, url) {
    var token = ctx.plexToken();
    if (!token) return Promise.reject(new Error('Sign in to Plex first'));
    var key = O.profileKey(ctx);
    return service(ctx, 'login', { url: url, plexToken: token, key: key }).then(function (r) {
      var cfg = O.config(ctx) || { profiles: {} };
      if (cfg.url && cfg.url !== r.url) cfg.profiles = {};
      cfg.url = r.url;
      cfg.profiles[key] = { user: r.user, at: Date.now() };
      saveConfig(ctx, cfg);
      lastStatus[key] = Date.now();
      return r.user;
    });
  };

  O.forget = function (ctx) {
    var cfg = O.config(ctx);
    var key = O.profileKey(ctx);
    if (cfg && cfg.profiles[key]) {
      delete cfg.profiles[key];
      saveConfig(ctx, cfg);
    }
    return service(ctx, 'logout', { key: key }).then(null, function () {});
  };

  // A service call as the active profile. If the service lost the session (it lives in /tmp) and
  // this profile has signed in here before, sign in again once and retry.
  O.svc = function (ctx, method, params) {
    var key = O.profileKey(ctx);
    var withKey = function () {
      var p = {};
      Object.keys(params || {}).forEach(function (k) { p[k] = params[k]; });
      p.key = key;
      return service(ctx, method, p);
    };
    return withKey().then(null, function (err) {
      var cfg = O.config(ctx);
      if (err.code !== 'unauthenticated' || !cfg || !cfg.url || !cfg.profiles[key]) throw err;
      return O.signIn(ctx, cfg.url).then(withKey);
    });
  };

  O.api = function (ctx, method, path, body) {
    return O.svc(ctx, 'request', { method: method, path: path, body: body == null ? null : body }).then(function (r) {
      if (r.status >= 400) {
        var err = new Error((r.data && r.data.message) || ('Overseerr error (HTTP ' + r.status + ')'));
        err.status = r.status;
        throw err;
      }
      return r.data;
    });
  };

  // Permissions can change on the server; refresh them now and then (never more than every 10 min).
  var lastStatus = {};
  O.refreshUser = function (ctx, force) {
    if (!O.ready(ctx)) return Promise.resolve(null);
    var key = O.profileKey(ctx);
    if (!force && lastStatus[key] && Date.now() - lastStatus[key] < STATUS_REFRESH_MS) return Promise.resolve(O.account(ctx));
    lastStatus[key] = Date.now();
    return O.svc(ctx, 'status', {}).then(function (r) {
      var cfg = O.config(ctx);
      if (!r.signedIn) return O.signIn(ctx, cfg.url);
      if (cfg && cfg.profiles[key]) {
        cfg.profiles[key].user = r.user;
        saveConfig(ctx, cfg);
      }
      return r.user;
    }).then(null, function (err) {
      ctx.warn('status failed: ' + (err && err.message));
      return O.account(ctx);
    });
  };

  // ---- Plex item -> Overseerr title -------------------------------------------------------------------

  function guid(item, scheme) {
    var list = (item && item.Guid) || [];
    for (var i = 0; i < list.length; i++) {
      var id = String(list[i].id || '');
      if (id.indexOf(scheme + '://') === 0) return id.slice(scheme.length + 3);
    }
    return null;
  }

  // The movie or show a Plex item belongs to, with its Guids: {type: 'movie'|'tv', ratingKey, title, year, tmdb, tvdb, imdb}
  O.plexTitle = function (ctx, item) {
    var t = item.type;
    var key = t === 'episode' ? item.grandparentRatingKey : t === 'season' ? item.parentRatingKey : item.ratingKey;
    var have = (t === 'movie' || t === 'show') && item.Guid ? Promise.resolve(item) : ctx.plex.metadata(key);
    return have.then(function (m) {
      return {
        type: m.type === 'show' ? 'tv' : 'movie',
        ratingKey: String(m.ratingKey),
        title: m.title,
        year: m.year,
        tmdb: guid(m, 'tmdb'),
        tvdb: guid(m, 'tvdb'),
        imdb: guid(m, 'imdb'),
      };
    });
  };

  // TMDB id for a Plex title. Shows without a tmdb:// Guid are found through Overseerr's search,
  // matched on their TVDB id (or IMDb id for movies).
  // A failure that asking again won't change (no id, no match) is marked err.permanent.
  function permanent(err) {
    err.permanent = true;
    return err;
  }

  O.tmdbFor = function (ctx, pt) {
    if (pt.tmdb) return Promise.resolve(Number(pt.tmdb));
    if (!pt.tvdb && !pt.imdb) return Promise.reject(permanent(new Error('Plex has no TMDB, TVDB or IMDb id for this title')));
    return O.api(ctx, 'GET', '/search?query=' + encodeURIComponent(pt.title || '') + '&page=1').then(function (data) {
      var hit = ((data && data.results) || []).filter(function (r) {
        if (r.mediaType !== pt.type) return false;
        var mi = r.mediaInfo || {};
        if (pt.tvdb && String(mi.tvdbId) === String(pt.tvdb)) return true;
        return !!(pt.imdb && mi.imdbId && mi.imdbId === pt.imdb);
      })[0];
      if (!hit) throw permanent(new Error('Couldn\'t find this title on Overseerr'));
      return hit.id;
    });
  };

  // {title, year, posterPath, media: {mediaId, status, ratingKey, downloads, issues}|null}
  O.lookup = function (ctx, mediaType, tmdbId) {
    return O.svc(ctx, 'lookup', { mediaType: mediaType, tmdbId: tmdbId });
  };

  // ---- Downloads ------------------------------------------------------------------------------------

  // "1.02:03:04" / "02:03:04" -> seconds
  function parseSpan(s) {
    var m = /^(?:(\d+)\.)?(\d+):(\d\d):(\d\d)/.exec(String(s || ''));
    if (!m) return null;
    return (Number(m[1] || 0) * 86400) + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  }

  // Overseerr reports the *arr queue status; collapse it to what a viewer cares about.
  function stateOf(d) {
    var s = String(d.status || '').toLowerCase();
    if (s === 'completed' || (d.size > 0 && d.sizeLeft === 0)) return 'importing';
    if (s === 'downloading') return 'downloading';
    if (s === 'paused') return 'paused';
    if (s === 'failed') return 'failed';
    if (s === 'warning' || s === 'stalled') return 'stalled';
    return 'queued';
  }

  var STATE_ORDER = ['downloading', 'importing', 'stalled', 'paused', 'queued', 'failed'];
  O.STATE_LABEL = {
    downloading: 'Downloading', importing: 'Almost ready', stalled: 'Stalled', paused: 'Paused', queued: 'Queued', failed: 'Failed',
  };

  // Groups one title's downloads (a show can have many episodes in flight) into one entry.
  function entryFrom(src, rows) {
    var size = 0;
    var left = 0;
    var time = null;
    var states = {};
    var eps = [];
    rows.forEach(function (d) {
      size += d.size || 0;
      left += Math.min(d.sizeLeft || 0, d.size || 0);
      var st = stateOf(d);
      states[st] = true;
      var sec = d.timeLeftSeconds != null ? d.timeLeftSeconds : parseSpan(d.timeLeft);
      if (sec == null && d.eta) {
        var ms = Date.parse(d.eta) - Date.now();
        if (ms > 0) sec = Math.round(ms / 1000);
      }
      if (sec != null && st === 'downloading') time = Math.max(time || 0, sec);
      if (d.season != null && d.episode != null) {
        eps.push({
          season: d.season, episode: d.episode, title: d.episodeTitle || '', state: st,
          progress: d.size > 0 ? Math.max(0, Math.min(1, (d.size - Math.min(d.sizeLeft || 0, d.size)) / d.size)) : 0,
        });
      }
    });
    eps.sort(function (a, b) { return a.season - b.season || a.episode - b.episode; });
    var state = STATE_ORDER.filter(function (s) { return states[s]; })[0] || 'queued';
    return {
      id: src.mediaType + '-' + (src.tmdbId || ('tvdb' + src.tvdbId)),
      mediaType: src.mediaType,
      tmdbId: src.tmdbId ? Number(src.tmdbId) : null,
      tvdbId: src.tvdbId ? Number(src.tvdbId) : null,
      ratingKey: src.ratingKey ? String(src.ratingKey) : null,
      title: src.title || (rows[0] && rows[0].title) || 'Unknown title',
      year: src.year || '',
      poster: src.poster || O.img(src.posterPath, 'w342'),
      backdrop: src.backdrop || O.img(src.backdropPath, 'w1280'),
      size: size,
      sizeLeft: left,
      progress: size > 0 ? Math.max(0, Math.min(1, (size - left) / size)) : 0,
      timeLeft: time,
      state: state,
      count: rows.length,
      episodes: eps,
      releases: rows.map(function (d) { return d.title || d.releaseTitle || ''; }).filter(Boolean).slice(0, 10),
    };
  }

  function fromSeerr(items) {
    return (items || []).map(function (m) { return entryFrom(m, m.downloads || []); });
  }

  // The helper's /queue (see notes on the home-server helper): one row per *arr queue record.
  function fromHelper(data) {
    var groups = {};
    var order = [];
    ((data && data.items) || []).forEach(function (q) {
      if (!q || (q.mediaType !== 'movie' && q.mediaType !== 'tv')) return;
      var id = q.mediaType + ':' + (q.tmdbId || ('tvdb' + q.tvdbId));
      if (!groups[id]) {
        groups[id] = { src: { mediaType: q.mediaType, tmdbId: q.tmdbId, tvdbId: q.tvdbId, title: q.title, year: q.year, poster: q.posterUrl, backdrop: q.fanartUrl }, rows: [] };
        order.push(id);
      }
      groups[id].rows.push({
        title: q.releaseTitle, status: q.status, size: q.size, sizeLeft: q.sizeLeft,
        timeLeftSeconds: q.timeLeftSeconds, eta: q.eta, season: q.season, episode: q.episode, episodeTitle: q.episodeTitle,
      });
    });
    return order.map(function (id) { return entryFrom(groups[id].src, groups[id].rows); });
  }

  function sortEntries(list) {
    return list.sort(function (a, b) {
      var sa = STATE_ORDER.indexOf(a.state);
      var sb = STATE_ORDER.indexOf(b.state);
      return sa - sb || (a.timeLeft || 1e9) - (b.timeLeft || 1e9) || String(a.title).localeCompare(String(b.title));
    });
  }

  // "https://helper.example.com:8787" (or a LAN address); paths are dropped
  O.normalizeUrl = function (raw, what) {
    var s = String(raw || '').trim();
    if (!s) throw new Error('Enter the ' + what + ' address');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    var m = /^(https?):\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(?:[\/?#].*)?$/i.exec(s);
    if (!m) throw new Error('That doesn\'t look like an address');
    return m[1].toLowerCase() + '://' + m[2] + (m[3] || '');
  };

  // The home server helper's address. With the shared setting (plugins/home-helper, PL.homeHelper)
  // only that one counts: no address there, or that plugin switched off, means no helper (it adopts
  // and then deletes this plugin's older "Download queue address"). Without it, that older address.
  // null too when this page can't reach it (an http helper from an https web page).
  O.helperUrl = function (ctx) {
    var H = PL.homeHelper;
    if (H && typeof H.url === 'function') {
      var shared = H.url();
      if (!shared || (H.blocked && H.blocked(shared))) return null;
      return String(shared).replace(/\/+$/, '');
    }
    var cfg = O.config(ctx) || {};
    return cfg.helperUrl || null;
  };

  // ---- Small caches (per profile) ------------------------------------------------------------------

  // A promise per id, kept for maxAge after it resolves; a failure isn't kept. All of this profile's
  // entries go when the profile changes, and a late answer never lands in another profile's store.
  // Each cache keeps its CACHED_MAX most recently used ids.
  var CACHED_MAX = 100;
  var stores = {};

  function newStore(key) { return { key: key, map: Object.create(null), order: [] }; }

  function used(st, id) {
    var i = st.order.indexOf(id);
    if (i >= 0) st.order.splice(i, 1);
    st.order.push(id);
    while (st.order.length > CACHED_MAX) delete st.map[st.order.shift()];
  }

  function unlist(st, id) {
    var i = st.order.indexOf(id);
    if (i >= 0) st.order.splice(i, 1);
  }

  O.cached = function (ctx, name, id, maxAge, fetch) {
    var key = O.profileKey(ctx);
    id = String(id);
    var st = stores[name];
    if (!st || st.key !== key) st = stores[name] = newStore(key);
    var hit = st.map[id];
    if (hit && (hit.pending || Date.now() - hit.at < maxAge)) {
      used(st, id);
      return hit.promise;
    }
    var entry = { at: 0, pending: true, promise: null };
    entry.promise = fetch().then(function (v) {
      entry.pending = false;
      entry.at = Date.now();
      entry.value = v;
      return v;
    }, function (err) {
      if (st.map[id] === entry) {
        delete st.map[id];
        unlist(st, id);
      }
      throw err;
    });
    st.map[id] = entry;
    used(st, id);
    return entry.promise;
  };

  O.cachedSize = function (name) { return stores[name] ? stores[name].order.length : 0; }; // (tests)

  // The value already in a cache (fresh or not), or undefined: for answers that must be synchronous.
  O.peek = function (ctx, name, id) {
    var st = stores[name];
    var hit = st && st.key === O.profileKey(ctx) ? st.map[String(id)] : null;
    return hit && !hit.pending ? hit.value : undefined;
  };

  // Forget one entry (id) or a whole cache (no id), e.g. after a request changed a title's status.
  O.forgetCached = function (name, id) {
    var st = stores[name];
    if (!st) return;
    if (id == null) {
      st.map = Object.create(null);
      st.order = [];
    } else {
      delete st.map[String(id)];
      unlist(st, String(id));
    }
  };

  // A show's seasons as Overseerr sees them, from the compact lookup (cached 10 min):
  // {tmdbId, title, year, posterPath, media, seasons: [{season, name, episodes, airDate, status, requested}]}
  var SHOW_MAX_AGE = 10 * 60 * 1000;
  O.show = function (ctx, tmdbId, maxAge) {
    return O.cached(ctx, 'show', String(tmdbId), maxAge == null ? SHOW_MAX_AGE : maxAge, function () {
      return O.lookup(ctx, 'tv', tmdbId).then(function (r) {
        return { tmdbId: Number(tmdbId), title: r.title, year: r.year, posterPath: r.posterPath, media: r.media, seasons: r.seasons || [] };
      });
    });
  };

  // Seasons that can still be requested: nothing on Overseerr yet (unknown, no open request).
  // aired: only seasons that have started (an announced season doesn't make a show "missing" one).
  O.openSeasons = function (seasons, aired) {
    var today = new Date().toISOString().slice(0, 10);
    return (seasons || []).filter(function (s) {
      if (s.status > 1 || s.requested) return false;
      if (aired && (!s.episodes || (s.airDate && s.airDate > today))) return false;
      return true;
    });
  };

  var cache = { key: null, at: 0, list: null, pending: null, source: null };

  // Promise<{list, source: 'helper'|'overseerr', at}>, cached for 20 s and shared by every caller.
  // A new helper address (or none) starts afresh, like another profile.
  O.downloads = function (ctx, maxAge) {
    var helperUrl = O.helperUrl(ctx);
    var key = O.profileKey(ctx) + '|' + (helperUrl || '');
    var age = maxAge == null ? DOWNLOADS_MAX_AGE : maxAge;
    // another profile's list is never served, not even while this one loads
    if (cache.key !== key) cache = { key: key, at: 0, list: null, pending: null, source: null };
    var mine = cache;
    if (mine.list && Date.now() - mine.at < age) {
      return Promise.resolve({ list: mine.list, source: mine.source, at: mine.at });
    }
    if (mine.pending) return mine.pending;
    var seerr = function () {
      return O.svc(ctx, 'downloads', {}).then(function (r) { return { list: fromSeerr(r.items), source: 'overseerr' }; });
    };
    var helper = helperUrl ? ctx.http('GET', helperUrl + '/queue', { timeout: 6000 }).then(function (data) {
      if (typeof data === 'string') data = JSON.parse(data);
      return { list: fromHelper(data), source: 'helper' };
    }).then(null, function (err) {
      ctx.warn('download queue helper failed, using Overseerr: ' + (err && err.message));
      return seerr();
    }) : null;
    var p = null;
    p = (helper || seerr()).then(function (r) {
      var list = sortEntries(r.list);
      if (mine.pending === p) mine.pending = null;
      // a profile switch while this was loading replaced the cache object; keep the answer out of it
      if (cache === mine) {
        mine.list = list;
        mine.source = r.source;
        mine.at = Date.now();
      }
      return { list: list, source: r.source, at: Date.now() };
    }, function (err) {
      if (mine.pending === p) mine.pending = null;
      throw err;
    });
    mine.pending = p;
    return p;
  };

  // The list already loaded for this profile (any age), or null: for values shown at once.
  O.downloadsKnown = function (ctx) {
    return cache.key === O.profileKey(ctx) + '|' + (O.helperUrl(ctx) || '') && cache.list ? cache.list : null;
  };

  // The download entry for a Plex title ({type, ratingKey, tmdb, tvdb}), or null.
  O.matchDownload = function (list, pt) {
    return (list || []).filter(function (e) {
      if (e.mediaType !== pt.type) return false;
      if (e.ratingKey && pt.ratingKey && e.ratingKey === pt.ratingKey) return true;
      if (e.tmdbId && pt.tmdb && String(e.tmdbId) === String(pt.tmdb)) return true;
      return !!(e.tvdbId && pt.tvdb && String(e.tvdbId) === String(pt.tvdb));
    })[0] || null;
  };

  // ---- Formatting -----------------------------------------------------------------------------------

  O.fmtTime = function (sec) {
    if (sec == null) return '';
    if (sec < 60) return 'under a minute';
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 48) return h + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
    return Math.round(h / 24) + ' days';
  };

  O.fmtSize = function (bytes) {
    if (!(bytes > 0)) return '';
    var gb = bytes / 1073741824;
    return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(bytes / 1048576) + ' MB';
  };

  O.pct = function (p) { return Math.floor(p * 100) + '%'; };

  O.episodeLabel = function (eps) {
    if (!eps.length) return '';
    if (eps.length === 1) return 'S' + eps[0].season + ' E' + eps[0].episode;
    var first = eps[0];
    var last = eps[eps.length - 1];
    if (first.season === last.season) return 'S' + first.season + ' E' + first.episode + '–E' + last.episode;
    return eps.length + ' episodes';
  };

  // "45% · 12 min left" / "Queued" / "Almost ready"
  O.progressLine = function (e) {
    if (e.state === 'downloading') {
      var t = O.fmtTime(e.timeLeft);
      return O.pct(e.progress) + (t ? ' · ' + t + ' left' : '');
    }
    return O.STATE_LABEL[e.state] + ((e.state === 'stalled' || e.state === 'paused') && e.progress >= 0.01 ? ' · ' + O.pct(e.progress) : '');
  };

  // ---- Your requests ---------------------------------------------------------------------------------

  // "Season 2", "Seasons 1–3", "Seasons 1, 3 and 5"
  O.seasonsLabel = function (nums) {
    var list = (nums || []).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
    if (!list.length) return '';
    if (list.length === 1) return 'Season ' + list[0];
    var runs = [];
    list.forEach(function (n) {
      var last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else if (!last || n !== last[1]) runs.push([n, n]);
    });
    var parts = [];
    runs.forEach(function (r) {
      if (r[0] === r[1]) parts.push(String(r[0]));
      else if (r[1] === r[0] + 1) parts.push(String(r[0]), String(r[1]));
      else parts.push(r[0] + '–' + r[1]);
    });
    if (parts.length === 1) return 'Seasons ' + parts[0];
    return 'Seasons ' + parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "today", "yesterday", "3 days ago", "2 weeks ago", "12 Oct", "12 Oct 2024"
  O.when = function (iso, now) {
    var t = Date.parse(iso);
    if (!(t > 0)) return '';
    var n = now || Date.now();
    var d = new Date(t);
    var today = new Date(n);
    today.setHours(0, 0, 0, 0);
    var day = new Date(t);
    day.setHours(0, 0, 0, 0);
    var days = Math.round((today - day) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 28) return Math.floor(days / 7) === 1 ? 'a week ago' : Math.floor(days / 7) + ' weeks ago';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== today.getFullYear() ? ' ' + d.getFullYear() : '');
  };

  // "19 Jan 2027"
  O.date = function (iso) {
    var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(iso || ''));
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  };

  // What a request has come to, as a viewer would put it. r: a `requests` item (service.js).
  // -> {state, label, tone, progress (0–1 while downloading, else null)}
  O.requestState = function (r) {
    if (r.status === 3) return { state: 'declined', label: 'Declined', tone: 'warn', progress: null };
    if (r.status === 4) return { state: 'failed', label: 'Failed', tone: 'warn', progress: null };
    if (r.status === 1) return { state: 'pending', label: 'Pending approval', tone: 'pending', progress: null };
    // approved (2) or, on Seerr, completed (5)
    var have = 0;
    var some = false;
    var asked = r.mediaType === 'tv' ? (r.seasons || []) : [];
    if (asked.length) {
      var media = {};
      (r.mediaSeasons || []).forEach(function (s) { media[s.season] = s.status; });
      asked.forEach(function (s) {
        if (s.status === 5 || media[s.season] === 5) have += 1;
        else if (media[s.season] === 4) some = true;
      });
    }
    var all = r.status === 5 || (asked.length ? have === asked.length : r.mediaStatus === 5);
    if (all) return { state: 'available', label: 'Available', tone: 'done', progress: null };
    var size = 0;
    var left = 0;
    (r.downloads || []).forEach(function (d) { size += d.size || 0; left += Math.min(d.sizeLeft || 0, d.size || 0); });
    if (size > 0) {
      var p = Math.max(0, Math.min(1, (size - left) / size));
      return { state: 'downloading', label: 'Downloading ' + O.pct(p), tone: 'accent', progress: p };
    }
    if (have || some || (!asked.length && r.mediaStatus === 4)) return { state: 'partial', label: 'Partly available', tone: 'done', progress: null };
    if (r.mediaStatus === 3) return { state: 'processing', label: 'Processing', tone: 'accent', progress: null };
    return { state: 'approved', label: 'Approved', tone: 'accent', progress: null };
  };

  O.requestEntry = function (r) {
    var st = O.requestState(r);
    var seasons = O.seasonsLabel((r.seasons || []).map(function (s) { return s.season; }));
    return {
      id: 'req-' + r.id,
      requestId: r.id,
      mediaType: r.mediaType,
      tmdbId: r.tmdbId,
      tvdbId: r.tvdbId,
      ratingKey: r.ratingKey ? String(r.ratingKey) : null,
      title: r.title || 'Unknown title',
      year: r.year || '',
      poster: O.img(r.posterPath, 'w342'),
      backdrop: O.img(r.backdropPath, 'w1280'),
      what: r.mediaType === 'tv' ? (seasons || 'Series') : [r.year, 'Film'].filter(Boolean).join(' · '),
      when: O.when(r.createdAt),
      state: st.state,
      label: st.label,
      tone: st.tone,
      progress: st.progress,
      is4k: !!r.is4k,
    };
  };

  // Promise<{list: [entry], at}>, cached for 20 s (the Overseerr page and the screen share it).
  O.requests = function (ctx, maxAge) {
    return O.cached(ctx, 'requests', 'mine', maxAge == null ? 20000 : maxAge, function () {
      return O.svc(ctx, 'requests', { take: 50 }).then(function (r) {
        return { list: (r.items || []).map(O.requestEntry), at: r.at || Date.now() };
      });
    });
  };
})();
