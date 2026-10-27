// Plex Lite's Overseerr bridge. Runs on the TV's Node (v0.12 on webOS 4.5: ES5 only).
//
// Overseerr's session cookie is HttpOnly + SameSite=Lax, so the web app (a file:// page) can sign in
// but never send the cookie again. This service signs in with the user's Plex token, keeps the
// cookie itself and proxies API calls to that one Overseerr server. Tokens and cookies are never
// logged or returned to the caller.
//
// Sessions are per Plex profile: the app passes a `key` (the profile it is acting for) with every
// call, so a request or problem report is always made under that profile's own Overseerr account.
// Calls without a key use the "default" session (older app builds).
'use strict';

var Service = require('webos-service');
var https = require('https');
var http = require('http');
var fs = require('fs');
var urlLib = require('url');

var service = new Service('com.bednal.plexlite.service');
var STATE_FILE = '/tmp/com.bednal.plexlite.service.json';
var MAX_SESSIONS = 8;
var MAX_TITLES = 300;
var KEY_RE = /^[A-Za-z0-9:_.-]{1,80}$/;
var state = load();

// state: {base, sessions: {key: {cookie, user, used}}, titles: {'movie:123': {title, year, posterPath, backdropPath}}}
function load() {
  var s = null;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (!s.sessions) {
    // version 1 kept one session at the top level
    s.sessions = {};
    if (s.cookie) s.sessions['default'] = { cookie: s.cookie, user: s.user || null, used: Date.now() };
    delete s.cookie;
    delete s.user;
  }
  if (!s.titles) s.titles = {};
  if (!s.base) s.base = null;
  return s;
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 384 }); // 0600
  } catch (e) { /* in-memory only */ }
}

function keyOf(payload) {
  var k = payload && payload.key;
  if (k == null || k === '') return 'default';
  k = String(k);
  return KEY_RE.test(k) ? k : null;
}

function session(key) {
  var s = state.sessions[key];
  return s && s.cookie ? s : null;
}

function normalizeBase(raw) {
  var u = urlLib.parse(String(raw || '').trim());
  if (!/^https?:$/.test(u.protocol || '') || !u.hostname) return null;
  return u.protocol + '//' + u.host;
}

// method, base, path ('/api/v1/...'), body (object or null), cookie -> cb(err, {status, data, setCookie})
function call(method, base, path, body, cookie, cb) {
  var u = urlLib.parse(base + path);
  var payload = body == null ? null : new Buffer(JSON.stringify(body), 'utf8');
  var headers = { Accept: 'application/json', 'User-Agent': 'PlexLite/0.1 (webOS)' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  if (cookie) headers.Cookie = cookie;
  var lib = u.protocol === 'https:' ? https : http;
  var done = false;
  var finish = function (err, res) {
    if (done) return;
    done = true;
    cb(err, res);
  };
  var req = lib.request({
    method: method, hostname: u.hostname, port: u.port, path: u.path, headers: headers,
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var text = Buffer.concat(chunks).toString('utf8');
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 200) }; }
      finish(null, { status: res.statusCode, data: data, setCookie: res.headers['set-cookie'] || [] });
    });
  });
  req.setTimeout(20000, function () { req.abort(); finish(new Error('timed out')); });
  req.on('error', function (err) { finish(err); });
  if (payload) req.write(payload);
  req.end();
}

function sessionCookie(setCookie) {
  for (var i = 0; i < setCookie.length; i++) {
    var m = /^\s*(connect\.sid=[^;]+)/.exec(setCookie[i]);
    if (m) return m[1];
  }
  return null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    displayName: u.displayName || u.plexUsername || u.username || 'Overseerr user',
    permissions: u.permissions || 0,
  };
}

function fail(msg, text, code) {
  msg.respond({ returnValue: false, errorCode: code || 'error', errorText: text });
}

function isAuthFailure(res) {
  return res.status === 401 || (res.status === 403 && /auth/i.test(JSON.stringify(res.data || '')));
}

// GET as the session `key`; cb(err, data) where err.code 'unauthenticated' means sign in again.
function apiGet(key, path, cb) {
  var s = session(key);
  if (!s) { var e = new Error('Not signed in to Overseerr'); e.code = 'unauthenticated'; return cb(e); }
  call('GET', state.base, '/api/v1' + path, null, s.cookie, function (err, res) {
    if (err) return cb(err);
    if (isAuthFailure(res)) {
      dropSession(key);
      var e2 = new Error('Overseerr session ended');
      e2.code = 'unauthenticated';
      return cb(e2);
    }
    if (res.status !== 200) return cb(new Error((res.data && res.data.message) || ('HTTP ' + res.status)));
    cb(null, res.data);
  });
}

function dropSession(key) {
  if (state.sessions[key]) {
    delete state.sessions[key];
    save();
  }
}

// keeps the most recently used sessions
function trimSessions() {
  var keys = Object.keys(state.sessions);
  if (keys.length <= MAX_SESSIONS) return;
  keys.sort(function (a, b) { return (state.sessions[a].used || 0) - (state.sessions[b].used || 0); });
  keys.slice(0, keys.length - MAX_SESSIONS).forEach(function (k) { delete state.sessions[k]; });
}

function respondError(msg, err) {
  if (err.code === 'unauthenticated') return fail(msg, err.message, 'unauthenticated');
  fail(msg, 'Could not reach Overseerr (' + err.message + ')', 'network');
}

service.register('login', function (msg) {
  var key = keyOf(msg.payload);
  var base = normalizeBase(msg.payload.url);
  var token = msg.payload.plexToken;
  if (!key) return fail(msg, 'Bad profile key', 'bad_request');
  if (!base) return fail(msg, 'That isn\'t an Overseerr address', 'bad_url');
  if (!token) return fail(msg, 'Plex sign-in is missing', 'no_token');
  call('POST', base, '/api/v1/auth/plex', { authToken: token }, null, function (err, res) {
    if (err) return fail(msg, 'Could not reach Overseerr (' + err.message + ')', 'network');
    if (res.status === 403) return fail(msg, 'Overseerr doesn\'t let this Plex account sign in', 'forbidden');
    if (res.status !== 200) return fail(msg, (res.data && res.data.message) || ('Overseerr refused the sign-in (HTTP ' + res.status + ')'), 'auth');
    var cookie = sessionCookie(res.setCookie);
    if (!cookie) return fail(msg, 'Overseerr did not start a session', 'auth');
    // a different server invalidates every other profile's session
    if (state.base !== base) state.sessions = {};
    state.base = base;
    state.sessions[key] = { cookie: cookie, user: publicUser(res.data), used: Date.now() };
    trimSessions();
    save();
    msg.respond({ returnValue: true, user: state.sessions[key].user, url: base });
  });
});

// Refreshes the user (permissions can change on the server). Never signs in by itself.
service.register('status', function (msg) {
  var key = keyOf(msg.payload);
  if (!key) return fail(msg, 'Bad profile key', 'bad_request');
  if (!session(key)) return msg.respond({ returnValue: true, signedIn: false, url: state.base });
  apiGet(key, '/auth/me', function (err, data) {
    if (err && err.code === 'unauthenticated') return msg.respond({ returnValue: true, signedIn: false, url: state.base });
    if (err) return respondError(msg, err);
    var s = session(key);
    if (s) {
      s.user = publicUser(data);
      s.used = Date.now();
      save();
    }
    msg.respond({ returnValue: true, signedIn: true, user: publicUser(data), url: state.base });
  });
});

// Only /api/v1/* on the signed-in server; the app can never point the cookie elsewhere.
service.register('request', function (msg) {
  var p = msg.payload;
  var key = keyOf(p);
  var method = String(p.method || 'GET').toUpperCase();
  var path = String(p.path || '');
  if (!key) return fail(msg, 'Bad profile key', 'bad_request');
  if (['GET', 'POST', 'PUT', 'DELETE'].indexOf(method) === -1) return fail(msg, 'Bad method', 'bad_request');
  if (!/^\/[A-Za-z0-9_\-\/?=&%.,:+]*$/.test(path) || path.indexOf('..') !== -1) return fail(msg, 'Bad path', 'bad_request');
  var s = session(key);
  if (!s) return fail(msg, 'Not signed in to Overseerr', 'unauthenticated');
  s.used = Date.now();
  call(method, state.base, '/api/v1' + path, p.body == null ? null : p.body, s.cookie, function (err, res) {
    if (err) return fail(msg, 'Could not reach Overseerr (' + err.message + ')', 'network');
    if (isAuthFailure(res)) {
      dropSession(key);
      return fail(msg, 'Overseerr session ended', 'unauthenticated');
    }
    msg.respond({ returnValue: true, status: res.status, data: res.data });
  });
});

// key given: that profile; no key and all: true: every profile on this TV.
service.register('logout', function (msg) {
  var p = msg.payload || {};
  var keys = p.all ? Object.keys(state.sessions) : [keyOf(p)];
  keys = keys.filter(function (k) { return k && state.sessions[k]; });
  var pending = keys.length;
  var done = function () {
    keys.forEach(function (k) { delete state.sessions[k]; });
    save();
    msg.respond({ returnValue: true });
  };
  if (!pending) return done();
  keys.forEach(function (k) {
    call('POST', state.base, '/api/v1/auth/logout', {}, state.sessions[k].cookie, function () {
      pending -= 1;
      if (!pending) done();
    });
  });
});

// ---- Compact views for the TV (the full Overseerr answers are 100-300 KB) --------------------

// Title, year and artwork for a TMDB id, cached (in the state file) because they rarely change.
function titleFor(key, mediaType, tmdbId, cb) {
  var ck = mediaType + ':' + tmdbId;
  if (state.titles[ck]) return cb(null, state.titles[ck]);
  apiGet(key, '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + tmdbId, function (err, d) {
    if (err || !d) return cb(err || new Error('no data'));
    var t = {
      title: d.title || d.name || '',
      year: String(d.releaseDate || d.firstAirDate || '').slice(0, 4),
      posterPath: d.posterPath || null,
      backdropPath: d.backdropPath || null,
    };
    var keys = Object.keys(state.titles);
    if (keys.length >= MAX_TITLES) delete state.titles[keys[0]];
    state.titles[ck] = t;
    cb(null, t);
  });
}

function trimDownload(d) {
  var ep = d.episode || null;
  return {
    title: String(d.title || '').slice(0, 200),
    status: String(d.status || ''),
    size: Number(d.size) || 0,
    sizeLeft: Number(d.sizeLeft) || 0,
    timeLeft: d.timeLeft || null,
    eta: d.estimatedCompletionTime || null,
    season: ep ? ep.seasonNumber : null,
    episode: ep ? ep.episodeNumber : null,
    episodeTitle: ep ? String(ep.title || '').slice(0, 120) : null,
  };
}

function trimMedia(m) {
  return {
    mediaId: m.id,
    mediaType: m.mediaType,
    tmdbId: m.tmdbId,
    tvdbId: m.tvdbId || null,
    ratingKey: m.ratingKey || null,
    status: m.status,
    updatedAt: m.updatedAt || null,
    downloads: (m.downloadStatus || []).slice(0, 60).map(trimDownload),
  };
}

// runs fn(item, cb) for every item, at most `limit` at a time; then done()
function eachLimit(items, limit, fn, done) {
  var i = 0;
  var running = 0;
  var left = items.length;
  if (!left) return done();
  var next = function () {
    while (running < limit && i < items.length) {
      running += 1;
      fn(items[i++], function () {
        running -= 1;
        left -= 1;
        if (!left) return done();
        next();
      });
    }
  };
  next();
}

// Everything Overseerr knows to be downloading (its Sonarr/Radarr sync runs every minute):
// processing and partly available items, plus recently changed available ones (replacements).
var downloadsCache = {}; // key -> {at, items}
var downloadsWaiting = {}; // key -> [msg]

function respondAll(key, payload) {
  var list = downloadsWaiting[key] || [];
  delete downloadsWaiting[key];
  list.forEach(function (m) { m.respond(payload); });
}

service.register('downloads', function (msg) {
  var key = keyOf(msg.payload);
  if (!key) return fail(msg, 'Bad profile key', 'bad_request');
  var cached = downloadsCache[key];
  if (cached && Date.now() - cached.at < 5000) return msg.respond({ returnValue: true, items: cached.items, at: cached.at });
  if (downloadsWaiting[key]) { downloadsWaiting[key].push(msg); return; }
  downloadsWaiting[key] = [msg];
  var queries = [
    '/media?filter=processing&take=100&sort=modified',
    '/media?filter=partial&take=100&sort=modified',
    '/media?filter=available&take=30&sort=modified',
  ];
  var seen = {};
  var found = [];
  var firstErr = null;
  eachLimit(queries, 3, function (q, next) {
    apiGet(key, q, function (err, data) {
      if (err) { firstErr = firstErr || err; return next(); }
      ((data && data.results) || []).forEach(function (m) {
        if (!m || seen[m.id] || !(m.downloadStatus && m.downloadStatus.length)) return;
        seen[m.id] = true;
        found.push(trimMedia(m));
      });
      next();
    });
  }, function () {
    if (firstErr && !found.length) {
      var e = firstErr;
      var list = downloadsWaiting[key] || [];
      delete downloadsWaiting[key];
      list.forEach(function (m) { respondError(m, e); });
      return;
    }
    eachLimit(found, 4, function (item, next) {
      titleFor(key, item.mediaType, item.tmdbId, function (err, t) {
        if (!err && t) {
          item.title = t.title;
          item.year = t.year;
          item.posterPath = t.posterPath;
          item.backdropPath = t.backdropPath;
        }
        next();
      });
    }, function () {
      save();
      downloadsCache[key] = { at: Date.now(), items: found };
      respondAll(key, { returnValue: true, items: found, at: downloadsCache[key].at });
    });
  });
});

// One title's Overseerr record: the media id (needed to report a problem), its status, downloads
// and open issues. {key, mediaType: 'movie'|'tv', tmdbId}
service.register('lookup', function (msg) {
  var p = msg.payload || {};
  var key = keyOf(p);
  var type = p.mediaType === 'tv' ? 'tv' : p.mediaType === 'movie' ? 'movie' : null;
  var id = Number(p.tmdbId);
  if (!key || !type || !(id > 0) || Math.floor(id) !== id) return fail(msg, 'Bad lookup', 'bad_request');
  apiGet(key, '/' + type + '/' + id, function (err, d) {
    if (err) return respondError(msg, err);
    var mi = d && d.mediaInfo;
    var t = { title: d.title || d.name || '', year: String(d.releaseDate || d.firstAirDate || '').slice(0, 4), posterPath: d.posterPath || null, backdropPath: d.backdropPath || null };
    state.titles[type + ':' + id] = t;
    msg.respond({
      returnValue: true,
      title: t.title,
      year: t.year,
      posterPath: t.posterPath,
      media: mi ? {
        mediaId: mi.id,
        status: mi.status,
        ratingKey: mi.ratingKey || null,
        tvdbId: mi.tvdbId || null,
        downloads: (mi.downloadStatus || []).slice(0, 60).map(trimDownload),
        issues: (mi.issues || []).filter(function (i) { return i.status === 1; }).slice(0, 20).map(function (i) {
          return { id: i.id, issueType: i.issueType, problemSeason: i.problemSeason, problemEpisode: i.problemEpisode, createdAt: i.createdAt };
        }),
      } : null,
    });
  });
});
