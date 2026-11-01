// Home server helper, shared core (PL.homeHelper): the helper's address, its /healthz status and
// calls to it, for the bundled plugins built on it (What's coming, Subtitles, Overseerr's
// Downloading). The helper is a small service on the home server (helper/ in this repo) in front of
// Sonarr, Radarr, Bazarr and Overseerr; the API is in docs/HOME-HELPER.md.
//
// Loaded before plugins/overseerr/ (which reads PL.homeHelper.url()); plugin.js registers the
// settings row later, so the Settings order is Overseerr, Home server helper, What's coming,
// Subtitles, Home Assistant (index.html loads them in that order).
//
//   url()                    the address ('http://host:8787'), or null (not set, or the plugin is off)
//   health(maxAgeMs)         Promise<{ok, version, dryRun, paused, services: {seerr, sonarr, radarr, bazarr, plex}} | null>
//   get(path, {timeout})     Promise<answer>; rejects with err.status and err.code (contract codes)
//   post(path, body, ctx, {timeout})  the same, with X-Plex-Token from the calling plugin's profile
//   onChange(fn)             fn({url, health}) when the address or the services change; returns off()
// Extras for the bundled plugins: has(service) (sync, from the last /healthz), blocked(url),
// errorText(err, what), busy(text), idle(), titleIds(ctx, item), guid(item, scheme), lru(max),
// viewerKey(), isOwner().
'use strict';

(function () {
  var H = PL.homeHelper = {};
  var PREFIX = 'plugin.home-helper.';
  var DEFAULT_PORT = 8787;
  var HEALTH_MAX_AGE = 60000;
  var FAIL_MAX_AGE = 30000;
  var SHOW_IDS_MAX = 200;
  var listeners = [];
  var cache = { url: null, at: 0, value: null, ok: false, pending: null };

  H.PLUGIN_ID = 'home-helper';
  H.SERVICE_NAMES = { sonarr: 'Sonarr', radarr: 'Radarr', bazarr: 'Bazarr', seerr: 'Overseerr' };

  function read(k, d) { return PL.storage.get(PREFIX + k, d); }
  function write(k, v) { PL.storage.set(PREFIX + k, v); }

  // "homeserver.local" -> "http://homeserver.local:8787"; a scheme or port typed in is kept, and so is
  // a path (a helper behind a reverse proxy, e.g. https://home.example.com/helper).
  H.normalizeUrl = function (raw) {
    var s = String(raw || '').trim();
    if (!s) throw new Error('Enter the helper\'s address');
    var typedScheme = /^https?:\/\//i.test(s);
    if (!typedScheme) s = 'http://' + s;
    var m = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\/[^?#]*)?(?:[?#].*)?$/i.exec(s);
    if (!m) throw new Error('That doesn\'t look like an address');
    var port = m[3] || (typedScheme ? '' : ':' + DEFAULT_PORT);
    var path = (m[4] || '').replace(/\/+$/, '');
    return m[1].toLowerCase() + '://' + m[2].toLowerCase() + port + path;
  };

  // The stored address. Overseerr's own "Download queue address" (plugin.overseerr.config.helperUrl,
  // from before this setting existed) is adopted once if the shared one isn't set, and is deleted from
  // Overseerr's config either way: Overseerr only reads PL.homeHelper.url(), so removing the shared
  // address (or switching this plugin off) really stops its /queue calls.
  H.address = function () {
    var url = read('url', null);
    if (read('migrated', false)) return url || null;
    var seerr = PL.storage.get('plugin.overseerr.config', null);
    if (seerr && seerr.helperUrl) {
      if (!url) {
        try { url = H.normalizeUrl(seerr.helperUrl); } catch (e) { url = null; }
        if (url) write('url', url);
      }
      delete seerr.helperUrl;
      PL.storage.set('plugin.overseerr.config', seerr);
      write('migrated', true);
    } else if (url) {
      write('migrated', true);
    }
    return url || null;
  };

  H.enabled = function () {
    return !(PL.plugins && PL.plugins.isEnabled) || PL.plugins.isEnabled(H.PLUGIN_ID);
  };

  H.url = function () {
    return H.enabled() ? H.address() : null;
  };

  // null to clear
  H.setUrl = function (url) {
    if (url) write('url', url);
    else PL.storage.del(PREFIX + 'url');
    write('migrated', true);
    cache = { url: null, at: 0, value: null, ok: false, pending: null };
    fire();
  };

  // Why a browser can't reach this address from here: an http helper from an https page is mixed
  // content. (Browsers would let http://localhost through, but the web build's Content-Security-Policy
  // allows https: only and upgrades http requests, so nothing http is reachable.) null when it can be tried.
  H.blocked = function (url) {
    if (!url || !PL.isWeb) return null;
    var page = (typeof location !== 'undefined' && location.protocol) || '';
    if (page !== 'https:' || !/^http:/i.test(url)) return null;
    return 'mixed';
  };

  function same(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }

  function fire() {
    var info = { url: H.url(), health: cache.value };
    listeners.slice().forEach(function (fn) {
      try { fn(info); } catch (e) { PL.warn('home helper listener failed: ' + (e && e.message)); }
    });
  }

  H.onChange = function (fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  // ---- Calls ---------------------------------------------------------------------------------------

  var CODES = { 400: 'bad_request', 401: 'unauthenticated', 404: 'not_found', 405: 'bad_request', 429: 'rate_limited', 500: 'internal', 502: 'upstream', 503: 'unavailable' };

  function call(method, path, body, headers, timeout) {
    var url = H.url();
    if (!url) {
      var none = new Error('The home server helper isn\'t set up');
      none.code = 'not_configured';
      return Promise.reject(none);
    }
    if (H.blocked(url)) {
      var blocked = new Error('This browser can\'t reach the helper from an https page');
      blocked.code = 'blocked';
      return Promise.reject(blocked);
    }
    var opts = { timeout: timeout || 8000, headers: headers || {} };
    if (body != null) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return PL.http(method, url + path, opts).then(function (data) {
      if (data == null || typeof data !== 'object') {
        var bad = new Error('The helper sent an answer Plex Lite doesn\'t understand');
        bad.code = 'bad_answer';
        throw bad;
      }
      return data;
    }, function (err) {
      var e = new Error(err && err.message ? err.message : 'helper request failed');
      e.status = err ? err.status : 0;
      e.code = err && err.aborted ? 'aborted' : CODES[e.status] || (e.status >= 500 ? 'upstream' : e.status ? 'http_' + e.status : 'network');
      if (err && err.timeout) e.timeout = true;
      throw e;
    });
  }

  H.get = function (path, opts) {
    return call('GET', path, null, null, opts && opts.timeout);
  };

  // ctx: the calling plugin's ctx (its plexToken() is the active profile's token)
  H.post = function (path, body, ctx, opts) {
    var token = ctx && ctx.plexToken ? ctx.plexToken() : PL.plex && PL.plex.token;
    if (!token) {
      var e = new Error('Sign in to Plex first');
      e.code = 'unauthenticated';
      return Promise.reject(e);
    }
    return call('POST', path, body || {}, { 'X-Plex-Token': token }, opts && opts.timeout);
  };

  // ---- Health --------------------------------------------------------------------------------------

  // Promise<healthz | null>: null when not set up, blocked, unreachable or not ok. Answers are kept
  // for maxAgeMs (default a minute; failures 30 s) and concurrent callers share one request.
  H.health = function (maxAgeMs) {
    var url = H.url();
    if (!url || H.blocked(url)) return Promise.resolve(null);
    if (cache.url !== url) cache = { url: url, at: 0, value: null, ok: false, pending: null };
    var mine = cache;
    var age = maxAgeMs == null ? HEALTH_MAX_AGE : maxAgeMs;
    if (mine.at && Date.now() - mine.at < (mine.ok ? age : Math.min(age, FAIL_MAX_AGE))) return Promise.resolve(mine.value);
    if (mine.pending) return mine.pending;
    var settle = function (value) {
      mine.pending = null;
      if (cache !== mine) return value;
      var before = mine.value;
      mine.at = Date.now();
      mine.ok = !!value;
      mine.value = value;
      if (!same(before, value)) fire();
      return value;
    };
    mine.pending = H.get('/healthz', { timeout: 5000 }).then(function (h) {
      if (!h || h.ok !== true) return settle(null);
      var s = h.services || {};
      return settle({
        ok: true,
        version: h.version || '',
        dryRun: !!h.dryRun,
        paused: !!h.paused,
        services: { seerr: !!s.seerr, sonarr: !!s.sonarr, radarr: !!s.radarr, bazarr: !!s.bazarr, plex: !!s.plex },
      });
    }, function (err) {
      PL.warn('home helper unreachable: ' + (err && err.code));
      return settle(null);
    });
    return mine.pending;
  };

  // The last /healthz answer, without asking again (null: unknown or unreachable).
  H.lastHealth = function () {
    return cache.url && cache.url === H.url() ? cache.value : null;
  };

  // Has the current address been checked at least once?
  H.checked = function () {
    return !!(cache.url && cache.url === H.url() && cache.at);
  };

  // Sync: is this service (sonarr, radarr, bazarr, seerr) known to be up? For hooks that must answer
  // at once (actions); the async hooks call health() first.
  H.has = function (service) {
    var h = H.lastHealth();
    return !!(h && h.services && h.services[service]);
  };

  // "Connected · Sonarr, Radarr, Bazarr"
  H.servicesLine = function (h) {
    var names = ['sonarr', 'radarr', 'bazarr', 'seerr'].filter(function (k) { return h.services[k]; })
      .map(function (k) { return H.SERVICE_NAMES[k]; });
    return names.length ? names.join(', ') : 'No services set up';
  };

  // ---- Messages ------------------------------------------------------------------------------------

  // what: the service behind the call ('Sonarr', 'Bazarr'), for "isn't set up" and "didn't answer"
  H.errorText = function (err, what) {
    var c = err && err.code;
    if (c === 'unauthenticated') return 'The helper didn\'t accept your Plex sign-in';
    if (c === 'rate_limited') return 'Too many requests · try again in a few minutes';
    // 503: not configured, or not answering (actions too when the helper can't check Plex sign-ins)
    if (c === 'unavailable') return (what || 'That service') + ' isn\'t available on the helper right now';
    if (c === 'upstream') return (what || 'The service') + ' answered the helper with an error';
    if (c === 'not_found') return (what || 'The helper') + ' doesn\'t know this title';
    if (c === 'blocked') return 'This browser can\'t reach the helper · use the TV app';
    if (c === 'not_configured') return 'Set up the home server helper in Settings first';
    if (err && err.timeout) return 'The helper took too long to answer';
    return 'Couldn\'t reach the home server helper';
  };

  // A toast with a spinner for something that takes a while; the next toast replaces it (and the
  // spinner with it), and so does idle().
  var spin = null;
  var spinTimer = null;

  function dropSpinner() {
    clearTimeout(spinTimer);
    spinTimer = null;
    var n = spin;
    spin = null;
    // (an animation that is still in the DOM keeps running under a hidden toast)
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  function toastNode() {
    return typeof document !== 'undefined' && document.querySelector ? document.querySelector('.toast') : null;
  }

  H.busy = function (text) {
    dropSpinner();
    PL.toast(text, 65000);
    var node = toastNode();
    if (!node || !node.insertBefore) return;
    spin = PL.el('span', 'hh-spin');
    node.insertBefore(spin, node.firstChild);
    // the toast hides itself after 65 s: the spinner goes then too
    spinTimer = setTimeout(dropSpinner, 65000);
  };

  // Dry run (DRY_RUN=1 on the helper): actions answer {dryRun: true} and change nothing.
  H.dryRun = function (answer) {
    return !!(answer && answer.dryRun);
  };

  // Hides the busy toast (when a sheet opens instead of another toast) and stops its spinner.
  H.idle = function () {
    var node = toastNode();
    var busy = !!(spin && node && spin.parentNode === node);
    dropSpinner();
    if (busy) node.classList.remove('show');
  };

  // ---- Small caches -----------------------------------------------------------------------------------

  // A bounded map (least recently used entries go first) for the plugins' caches, so a long session
  // browsing hundreds of titles doesn't keep every answer.
  H.lru = function (max) {
    var map = Object.create(null);
    var order = [];
    var drop = function (k) {
      var i = order.indexOf(k);
      if (i >= 0) order.splice(i, 1);
    };
    return {
      get: function (k) {
        k = String(k);
        if (!(k in map)) return undefined;
        drop(k);
        order.push(k);
        return map[k];
      },
      set: function (k, v) {
        k = String(k);
        drop(k);
        order.push(k);
        map[k] = v;
        while (order.length > max) delete map[order.shift()];
      },
      del: function (k) {
        k = String(k);
        drop(k);
        delete map[k];
      },
      clear: function () {
        map = Object.create(null);
        order = [];
      },
      size: function () { return order.length; },
    };
  };

  // 32-bit FNV-1a, hex: tells tokens apart without keeping them
  function fingerprint(s) {
    var h = 0x811c9dc5;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // Who is watching, for caches of what Plex lets them see: the Plex Home profile, else the account
  // (by a fingerprint of its token, as Overseerr's sessions are keyed).
  H.viewerKey = function () {
    var p = PL.storage.get('profile', null);
    if (p && p.uuid) return 'p-' + String(p.uuid);
    return 'o-' + fingerprint(PL.plex && PL.plex.token);
  };

  // The account owner: no Plex Home profile picked, or the Home's admin profile (Plex can restrict
  // every other profile's libraries and ratings).
  H.isOwner = function () {
    var p = PL.storage.get('profile', null);
    return !p || p.admin === true;
  };

  // ---- Identifying a title ---------------------------------------------------------------------------

  // "tmdb://123" in a Plex item's Guid list -> "123"
  H.guid = function (item, scheme) {
    var list = (item && item.Guid) || [];
    for (var i = 0; i < list.length; i++) {
      var id = String(list[i].id || '');
      if (id.indexOf(scheme + '://') === 0) return id.slice(scheme.length + 3);
    }
    return null;
  };

  // show ratingKey -> {tvdbId, tmdbId, title}: a show's ids never change, so they're kept for the session
  var showIds = {};
  var showOrder = [];

  function remember(rk, ids) {
    if (!showIds[rk]) showOrder.push(rk);
    showIds[rk] = ids;
    while (showOrder.length > SHOW_IDS_MAX) delete showIds[showOrder.shift()];
    return ids;
  }

  function idsOfShow(ctx, show) {
    return { tvdbId: num(H.guid(show, 'tvdb')), tmdbId: num(H.guid(show, 'tmdb')), title: show.title || '' };
  }

  function num(v) { return v != null && /^\d+$/.test(String(v)) ? Number(v) : null; }

  H.showIds = function (ctx, ratingKey, have) {
    var rk = String(ratingKey || '');
    if (!rk) return Promise.resolve(null);
    if (showIds[rk]) return Promise.resolve(showIds[rk]);
    if (have && have.Guid) return Promise.resolve(remember(rk, idsOfShow(ctx, have)));
    return ctx.plex.metadata(rk).then(function (m) { return remember(rk, idsOfShow(ctx, m)); });
  };

  // The contract's way of naming a Plex item: Promise<{type: 'movie'|'episode'|'season'|'show',
  // tmdbId?, tvdbId?, season?, episode?, title, label}>; rejects when Plex has no usable id.
  H.titleIds = function (ctx, item) {
    var t = item && item.type;
    if (t === 'movie') {
      var direct = item.Guid ? Promise.resolve(item) : ctx.plex.metadata(item.ratingKey);
      return direct.then(function (m) {
        var tmdb = num(H.guid(m, 'tmdb'));
        if (!tmdb) throw noId();
        return { type: 'movie', tmdbId: tmdb, title: m.title || '', label: m.title || '' };
      });
    }
    var showKey = t === 'show' ? item.ratingKey : t === 'season' ? item.parentRatingKey : t === 'episode' ? item.grandparentRatingKey : null;
    if (!showKey) return Promise.reject(noId());
    return H.showIds(ctx, showKey, t === 'show' ? item : null).then(function (ids) {
      if (!ids || !ids.tvdbId) throw noId();
      var out = { type: t, tvdbId: ids.tvdbId, title: ids.title || item.grandparentTitle || item.parentTitle || item.title || '' };
      if (t === 'season') out.season = item.index;
      if (t === 'episode') {
        out.season = item.parentIndex;
        out.episode = item.index;
      }
      out.label = t === 'episode' ? out.title + ' · S' + out.season + ' E' + out.episode
        : t === 'season' ? out.title + ' · ' + (item.title || 'Season ' + item.index) : out.title;
      return out;
    });
  };

  function noId() {
    var e = new Error('Plex has no TVDB or TMDB id for this title');
    e.code = 'no_id';
    return e;
  }
})();
