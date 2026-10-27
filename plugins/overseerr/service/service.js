// Plex Lite's Overseerr bridge. Runs on the TV's Node (v0.12 on webOS 4.5: ES5 only).
//
// Overseerr's session cookie is HttpOnly + SameSite=Lax, so the web app (a file:// page) can sign in
// but never send the cookie again. This service signs in with the user's Plex token, keeps the
// cookie itself and proxies API calls to that one Overseerr server. Tokens and cookies are never
// logged or returned to the caller.
'use strict';

var Service = require('webos-service');
var https = require('https');
var http = require('http');
var fs = require('fs');
var urlLib = require('url');

var service = new Service('com.bednal.plexlite.service');
var STATE_FILE = '/tmp/com.bednal.plexlite.service.json';
var state = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { base: null, cookie: null, user: null };
  }
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 384 }); // 0600
  } catch (e) { /* in-memory only */ }
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
  var req = lib.request({
    method: method, hostname: u.hostname, port: u.port, path: u.path, headers: headers,
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var text = Buffer.concat(chunks).toString('utf8');
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 200) }; }
      cb(null, { status: res.statusCode, data: data, setCookie: res.headers['set-cookie'] || [] });
    });
  });
  req.setTimeout(20000, function () { req.abort(); });
  req.on('error', function (err) { cb(err); });
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
  return { id: u.id, displayName: u.displayName || u.plexUsername || u.username || u.email || 'Overseerr user', permissions: u.permissions };
}

function fail(msg, text, code) {
  msg.respond({ returnValue: false, errorCode: code || 'error', errorText: text });
}

service.register('login', function (msg) {
  var base = normalizeBase(msg.payload.url);
  var token = msg.payload.plexToken;
  if (!base) return fail(msg, 'That isn\'t an Overseerr address', 'bad_url');
  if (!token) return fail(msg, 'Plex sign-in is missing', 'no_token');
  call('POST', base, '/api/v1/auth/plex', { authToken: token }, null, function (err, res) {
    if (err) return fail(msg, 'Could not reach Overseerr (' + err.message + ')', 'network');
    if (res.status !== 200) return fail(msg, (res.data && res.data.message) || ('Overseerr refused the sign-in (HTTP ' + res.status + ')'), 'auth');
    var cookie = sessionCookie(res.setCookie);
    if (!cookie) return fail(msg, 'Overseerr did not start a session', 'auth');
    state = { base: base, cookie: cookie, user: publicUser(res.data) };
    save();
    msg.respond({ returnValue: true, user: state.user, url: base });
  });
});

service.register('status', function (msg) {
  if (!state.cookie) return msg.respond({ returnValue: true, signedIn: false });
  call('GET', state.base, '/api/v1/auth/me', null, state.cookie, function (err, res) {
    if (err) return fail(msg, 'Could not reach Overseerr (' + err.message + ')', 'network');
    if (res.status === 200) {
      state.user = publicUser(res.data);
      save();
      return msg.respond({ returnValue: true, signedIn: true, user: state.user, url: state.base });
    }
    msg.respond({ returnValue: true, signedIn: false, url: state.base });
  });
});

// Only /api/v1/* on the signed-in server; the app can never point the cookie elsewhere.
service.register('request', function (msg) {
  var p = msg.payload;
  var method = String(p.method || 'GET').toUpperCase();
  var path = String(p.path || '');
  if (['GET', 'POST', 'PUT', 'DELETE'].indexOf(method) === -1) return fail(msg, 'Bad method', 'bad_request');
  if (!/^\/[A-Za-z0-9_\-\/?=&%.,:+]*$/.test(path) || path.indexOf('..') !== -1) return fail(msg, 'Bad path', 'bad_request');
  if (!state.cookie) return fail(msg, 'Not signed in to Overseerr', 'unauthenticated');
  call(method, state.base, '/api/v1' + path, p.body == null ? null : p.body, state.cookie, function (err, res) {
    if (err) return fail(msg, 'Could not reach Overseerr (' + err.message + ')', 'network');
    if (res.status === 401 || (res.status === 403 && /auth/i.test(JSON.stringify(res.data || '')))) {
      return fail(msg, 'Overseerr session ended', 'unauthenticated');
    }
    msg.respond({ returnValue: true, status: res.status, data: res.data });
  });
});

service.register('logout', function (msg) {
  var done = function () {
    state = { base: state.base, cookie: null, user: null };
    save();
    msg.respond({ returnValue: true });
  };
  if (!state.cookie) return done();
  call('POST', state.base, '/api/v1/auth/logout', {}, state.cookie, function () { done(); });
});
