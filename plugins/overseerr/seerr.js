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
  O.tmdbFor = function (ctx, pt) {
    if (pt.tmdb) return Promise.resolve(Number(pt.tmdb));
    if (!pt.tvdb && !pt.imdb) return Promise.reject(new Error('Plex has no TMDB, TVDB or IMDb id for this title'));
    return O.api(ctx, 'GET', '/search?query=' + encodeURIComponent(pt.title || '') + '&page=1').then(function (data) {
      var hit = ((data && data.results) || []).filter(function (r) {
        if (r.mediaType !== pt.type) return false;
        var mi = r.mediaInfo || {};
        if (pt.tvdb && String(mi.tvdbId) === String(pt.tvdb)) return true;
        return !!(pt.imdb && mi.imdbId && mi.imdbId === pt.imdb);
      })[0];
      if (!hit) throw new Error('Couldn\'t find this title on Overseerr');
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
      poster: src.poster || (src.posterPath ? O.TMDB_IMG + 'w342' + src.posterPath : null),
      backdrop: src.backdrop || (src.backdropPath ? O.TMDB_IMG + 'w1280' + src.backdropPath : null),
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

  var cache = { key: null, at: 0, list: null, pending: null, source: null };

  // Promise<{list, source: 'helper'|'overseerr', at}>, cached for 20 s and shared by every caller.
  O.downloads = function (ctx, maxAge) {
    var key = O.profileKey(ctx);
    var age = maxAge == null ? DOWNLOADS_MAX_AGE : maxAge;
    // another profile's list is never served, not even while this one loads
    if (cache.key !== key) cache = { key: key, at: 0, list: null, pending: null, source: null };
    var mine = cache;
    if (mine.list && Date.now() - mine.at < age) {
      return Promise.resolve({ list: mine.list, source: mine.source, at: mine.at });
    }
    if (mine.pending) return mine.pending;
    var cfg = O.config(ctx) || {};
    var seerr = function () {
      return O.svc(ctx, 'downloads', {}).then(function (r) { return { list: fromSeerr(r.items), source: 'overseerr' }; });
    };
    var helper = cfg.helperUrl ? ctx.http('GET', cfg.helperUrl + '/queue', { timeout: 6000 }).then(function (data) {
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
})();
