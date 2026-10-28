// Overseerr plugin, browser path (web build only; loaded after seerr.js by tools/build-web.mjs).
//
// On the TV the plugin talks to Overseerr through its webOS service (service/service.js). A browser
// has no such service, so this file answers the same methods (login, status, request, downloads,
// lookup, logout) with the same answers and error codes, calling the user's own Overseerr straight
// from the page with fetch and credentials: 'include'. That only works when Overseerr's reverse
// proxy allows this page's origin with credentials and answers preflights, and when the page is on
// the same site as Overseerr (otherwise the browser won't send its SameSite=Lax session cookie back).
// When either is missing the error says which, and explain() shows it in a sheet (docs/OVERSEERR.md,
// "On the web").
//
// Sessions: a browser holds one Overseerr cookie, not one per Plex Home profile. The profile it
// belongs to is remembered (`web.owner`); a call for another profile answers `unauthenticated`, and
// seerr.js then signs that profile in again (only if it has signed in here before), as it does when
// the TV's service lost a session. Changes (POST/PUT/DELETE) first check with /auth/me that the
// cookie still belongs to the expected Overseerr user, so a request or report is never made under
// someone else's account (another tab, or Overseerr's own pages, can replace the cookie).
'use strict';

(function () {
  var O = PL.overseerr;
  if (!O || !PL.isWeb) return;
  var W = O.web = {};

  W.DOCS_URL = 'https://github.com/Obednal97/plex-lite/blob/main/docs/OVERSEERR.md#on-the-web';
  var TIMEOUT_MS = 20000;
  var MAX_TITLES = 300;
  var KEY_RE = /^[A-Za-z0-9:_.-]{1,80}$/;
  var PATH_RE = /^\/[A-Za-z0-9_\-\/?=&%.,:+]*$/;

  // tests replace these
  W.fetch = function (url, init) { return window.fetch(url, init); };
  W.origin = function () { return window.location.origin; };

  // ---- Who the browser's Overseerr cookie belongs to ---------------------------------------------

  // {key, base, userId} (localStorage, so other tabs see a change at once)
  function owner(ctx) { return ctx.storage.get('web.owner', null); }

  var generation = 0; // bumped by every sign-in and sign-out
  function setOwner(ctx, value) {
    generation += 1;
    if (value) ctx.storage.set('web.owner', value);
    else ctx.storage.del('web.owner');
  }

  function session(ctx, key) {
    var o = owner(ctx);
    return o && o.key === key && o.base ? o : null;
  }

  // ---- Errors --------------------------------------------------------------------------------------

  function error(code, text, explain) {
    var e = new Error(text);
    e.code = code;
    if (explain) {
      e.setup = true;
      e.explain = explain;
    }
    return e;
  }

  function hostOf(base) { return String(base).replace(/^https?:\/\//, ''); }

  // The registrable domain, near enough for wording a message (the browser's own check decides).
  // Hosting platforms where every customer is a separate site count one label more.
  var SHARED = /(^|\.)(vercel\.app|netlify\.app|github\.io|pages\.dev|workers\.dev|onrender\.com|fly\.dev|duckdns\.org|ddns\.net|synology\.me|myds\.me|plex\.direct)$/;
  W.siteOf = function (host) {
    host = String(host || '').toLowerCase().replace(/:\d+$/, '');
    if (/^[\d.]+$/.test(host) || host.indexOf(':') !== -1) return host;
    var parts = host.split('.');
    var n = 2;
    if (SHARED.test(host)) n = 3;
    else if (parts.length > 2 && parts[parts.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu|ltd|plc|me|ne|or|go)$/.test(parts[parts.length - 2])) n = 3;
    return parts.slice(-n).join('.');
  };

  function guideRow() {
    return { label: 'Setup guide', sub: 'docs/OVERSEERR.md on GitHub, "On the web"', action: function () { W.openGuide(); }, guide: true };
  }

  function setupError(kind, base) {
    var here = W.origin();
    var host = hostOf(base);
    if (kind === 'credentials') {
      return error('cors', 'Overseerr allows this site, but not signed in (see Settings → Overseerr)', {
        title: 'Overseerr needs one more setting',
        rows: [
          { label: 'Overseerr answers this site, but not with its sign-in', sub: 'Its reverse proxy must send Access-Control-Allow-Credentials: true' },
          { label: 'And name this site, not *', sub: 'Access-Control-Allow-Origin: ' + here },
          guideRow(),
        ],
      });
    }
    if (kind === 'preflight') {
      return error('cors', 'Overseerr\'s proxy doesn\'t answer the browser\'s preflight (see Settings → Overseerr)', {
        title: 'Overseerr needs one more setting',
        rows: [
          { label: 'The browser checks first with an OPTIONS request', sub: 'Overseerr answers it with an error (405), so its reverse proxy must answer it instead' },
          { label: 'Answer OPTIONS for /api/ with 204', sub: 'With Allow-Origin ' + here + ', Allow-Credentials, the methods (GET, POST, PUT, DELETE) and the requested headers' },
          guideRow(),
        ],
      });
    }
    return error('cors', 'Overseerr doesn\'t allow this site (see Settings → Overseerr)', {
      title: 'Overseerr doesn\'t allow this site',
      rows: [
        { label: 'Overseerr is there, but the browser may not read its answers', sub: 'Its reverse proxy has to allow ' + here + ' (CORS with credentials) at ' + host },
        { label: 'What a server owner sets up', sub: 'Plex Lite on a subdomain of the same domain as Overseerr, and CORS for that address on Overseerr\'s proxy' },
        { label: 'Or use the TV app', sub: 'It talks to Overseerr directly and needs none of this' },
        guideRow(),
      ],
    });
  }

  function cookieError(base) {
    var mine = W.siteOf(hostOf(W.origin()));
    var theirs = W.siteOf(hostOf(base));
    var rows = mine !== theirs ? [
      { label: 'This page is on ' + mine + ', Overseerr on ' + theirs, sub: 'A browser keeps Overseerr\'s sign-in only for pages on the same site' },
      { label: 'What a server owner sets up', sub: 'Serve Plex Lite from a subdomain of ' + theirs + ', and allow that address on Overseerr\'s proxy' },
    ] : [
      { label: 'Overseerr signed you in, but the browser didn\'t send its cookie back', sub: 'Check that cookies aren\'t blocked for this site' },
      { label: 'And that the reverse proxy passes Set-Cookie on', sub: 'Unchanged: no Domain or SameSite rewriting' },
    ];
    rows.push(guideRow());
    return error('cookie', 'This browser didn\'t keep the Overseerr sign-in (see Settings → Overseerr)', {
      title: 'This browser didn\'t keep the sign-in', rows: rows,
    });
  }

  function csrfError() {
    return error('csrf', 'Overseerr\'s CSRF protection blocks this site (see Settings → Overseerr)', {
      title: 'Overseerr\'s CSRF protection is on',
      rows: [
        { label: 'With it on, Overseerr takes sign-ins and changes only from its own pages', sub: 'Plex Lite on the web can\'t send the token it asks for' },
        { label: 'Turn off "Enable CSRF Protection"', sub: 'Seerr: Settings → Network. Overseerr: Settings → General. It is off unless someone turned it on' },
        guideRow(),
      ],
    });
  }

  // fetch rejected (TypeError: offline, DNS, TLS, or CORS; the browser doesn't say which). A few
  // cheap probes of Overseerr's public /api/v1/status tell them apart.
  function diagnose(base, preflighted) {
    var url = base + '/api/v1/status';
    var probe = function (init) {
      return within(W.fetch(url, init), 8000).then(function () { return true; }, function () { return false; });
    };
    return probe({ credentials: 'include', cache: 'no-store' }).then(function (ok) {
      if (ok) return preflighted ? setupError('preflight', base) : error('network', 'Could not reach Overseerr (the connection dropped)');
      return probe({ credentials: 'omit', cache: 'no-store' }).then(function (anon) {
        if (anon) return setupError('credentials', base);
        return probe({ mode: 'no-cors', credentials: 'omit', cache: 'no-store' }).then(function (reachable) {
          if (reachable) return setupError('cors', base);
          return error('network', 'Could not reach Overseerr at ' + hostOf(base) + ' (offline, or the address is wrong)');
        });
      });
    });
  }

  function within(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timed out')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ---- HTTP ----------------------------------------------------------------------------------------

  // -> Promise<{status, data}>; a failed fetch is diagnosed into an error with a code
  function call(method, base, path, body) {
    var init = { method: method, credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body != null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var started;
    try { started = W.fetch(base + path, init); } catch (e) { started = Promise.reject(e); }
    return within(started, TIMEOUT_MS).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 200) }; }
        return { status: res.status, data: data };
      });
    }, function (err) {
      if (err && err.message === 'timed out') throw error('network', 'Could not reach Overseerr (timed out)');
      return diagnose(base, method !== 'GET' || body != null).then(function (e) { throw e; });
    });
  }

  function isAuthFailure(res) {
    return res.status === 401 || (res.status === 403 && /auth/i.test(JSON.stringify(res.data || '')));
  }

  function isCsrf(res) {
    return res.status === 403 && /csrf/i.test(JSON.stringify(res.data || ''));
  }

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      displayName: u.displayName || u.plexUsername || u.username || 'Overseerr user',
      permissions: u.permissions || 0,
    };
  }

  function normalizeBase(raw) {
    var m = /^(https?):\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(?:[\/?#].*)?$/i.exec(String(raw || '').trim());
    return m ? m[1].toLowerCase() + '://' + m[2].toLowerCase() + (m[3] || '') : null;
  }

  function unauthenticated(text) { return error('unauthenticated', text || 'Not signed in to Overseerr'); }

  // GET as the profile `key`; resolves with the data (HTTP 200) like the service's apiGet
  function apiGet(ctx, key, path) {
    var s = session(ctx, key);
    if (!s) return Promise.reject(unauthenticated());
    return call('GET', s.base, '/api/v1' + path).then(function (res) {
      if (isAuthFailure(res)) {
        dropOwner(ctx, key);
        throw unauthenticated('Overseerr session ended');
      }
      if (res.status !== 200) throw error('network', 'Could not reach Overseerr (' + ((res.data && res.data.message) || ('HTTP ' + res.status)) + ')');
      return res.data;
    });
  }

  function dropOwner(ctx, key) {
    var o = owner(ctx);
    if (o && o.key === key) setOwner(ctx, null);
  }

  // ---- Methods (same names, params and answers as service/service.js) -----------------------------

  var M = {};
  var pendingLogin = null; // {id, promise}: a profile switch fires several calls at once

  M.login = function (ctx, p) {
    var key = p.key == null || p.key === '' ? 'default' : String(p.key);
    var base = normalizeBase(p.url);
    if (!KEY_RE.test(key)) return Promise.reject(error('bad_request', 'Bad profile key'));
    if (!base) return Promise.reject(error('bad_url', 'That isn\'t an Overseerr address'));
    if (/^https:/.test(W.origin()) && /^http:/.test(base)) {
      return Promise.reject(error('bad_url', 'On the web, Overseerr\'s address must start with https://'));
    }
    if (!p.plexToken) return Promise.reject(error('no_token', 'Plex sign-in is missing'));
    var id = key + ' ' + base;
    if (pendingLogin && pendingLogin.id === id) return pendingLogin.promise;
    generation += 1;
    var promise = call('POST', base, '/api/v1/auth/plex', { authToken: p.plexToken }).then(function (res) {
      if (isCsrf(res)) throw csrfError();
      if (res.status === 403) throw error('forbidden', 'Overseerr doesn\'t let this Plex account sign in');
      if (res.status !== 200) throw error('auth', (res.data && res.data.message) || ('Overseerr refused the sign-in (HTTP ' + res.status + ')'));
      var signedIn = publicUser(res.data);
      // the sign-in counts only if the browser kept Overseerr's cookie and sends it back
      return call('GET', base, '/api/v1/auth/me').then(function (me) {
        if (me.status === 401 || me.status === 403 || (me.status === 200 && me.data && signedIn && me.data.id !== signedIn.id)) {
          throw cookieError(base);
        }
        if (me.status !== 200) throw error('auth', (me.data && me.data.message) || ('Overseerr error (HTTP ' + me.status + ')'));
        var user = publicUser(me.data);
        setOwner(ctx, { key: key, base: base, userId: user.id });
        return { returnValue: true, user: user, url: base };
      });
    });
    var mine = { id: id, promise: promise };
    pendingLogin = mine;
    var done = function () { if (pendingLogin === mine) pendingLogin = null; };
    promise.then(done, done);
    return promise;
  };

  // Refreshes the user; never signs in by itself.
  M.status = function (ctx, p) {
    var key = p.key || 'default';
    var s = session(ctx, key);
    var cfg = O.config(ctx);
    var url = (s && s.base) || (cfg && cfg.url) || null;
    if (!s) return Promise.resolve({ returnValue: true, signedIn: false, url: url });
    return apiGet(ctx, key, '/auth/me').then(function (data) {
      // someone else signed in to Overseerr in this browser since
      if (!data || data.id !== s.userId) {
        dropOwner(ctx, key);
        return { returnValue: true, signedIn: false, url: url };
      }
      return { returnValue: true, signedIn: true, user: publicUser(data), url: url };
    }, function (err) {
      if (err.code === 'unauthenticated') return { returnValue: true, signedIn: false, url: url };
      throw err;
    });
  };

  // Only /api/v1/* on the signed-in server, as in the service.
  M.request = function (ctx, p) {
    var key = p.key || 'default';
    var method = String(p.method || 'GET').toUpperCase();
    var path = String(p.path || '');
    if (!KEY_RE.test(key)) return Promise.reject(error('bad_request', 'Bad profile key'));
    if (['GET', 'POST', 'PUT', 'DELETE'].indexOf(method) === -1) return Promise.reject(error('bad_request', 'Bad method'));
    if (!PATH_RE.test(path) || path.indexOf('..') !== -1) return Promise.reject(error('bad_request', 'Bad path'));
    var s = session(ctx, key);
    if (!s) return Promise.reject(unauthenticated());
    var gen = generation;
    // a change goes out only as the Overseerr user this profile signed in as
    var check = method === 'GET' ? Promise.resolve() : apiGet(ctx, key, '/auth/me').then(function (me) {
      var now = session(ctx, key);
      if (!me || me.id !== s.userId || !now || now.base !== s.base) {
        dropOwner(ctx, key);
        throw unauthenticated('Overseerr is signed in as someone else in this browser');
      }
      // a sign-in started meanwhile may replace the cookie before this goes out
      if (generation !== gen) throw unauthenticated('Overseerr is signing in again');
    });
    return check.then(function () {
      return call(method, s.base, '/api/v1' + path, p.body == null ? null : p.body);
    }).then(function (res) {
      if (isCsrf(res)) throw csrfError();
      if (isAuthFailure(res)) {
        dropOwner(ctx, key);
        throw unauthenticated('Overseerr session ended');
      }
      return { returnValue: true, status: res.status, data: res.data };
    });
  };

  // key: that profile; all: true: whoever is signed in. Only the cookie's owner signs out of
  // Overseerr; for anyone else there is nothing in this browser to end.
  M.logout = function (ctx, p) {
    var o = owner(ctx);
    if (!o || !(p.all || o.key === (p.key || 'default'))) return Promise.resolve({ returnValue: true });
    setOwner(ctx, null);
    return call('POST', o.base, '/api/v1/auth/logout', {}).then(null, function () {}).then(function () {
      return { returnValue: true };
    });
  };

  // ---- Compact views (as the service builds them) --------------------------------------------------

  function titles(ctx) { return ctx.storage.get('web.titles', {}) || {}; }

  function cacheTitle(ctx, ck, t) {
    var all = titles(ctx);
    var keys = Object.keys(all);
    if (!all[ck] && keys.length >= MAX_TITLES) delete all[keys[0]];
    all[ck] = t;
    ctx.storage.set('web.titles', all);
  }

  function titleOf(d) {
    return {
      title: d.title || d.name || '',
      year: String(d.releaseDate || d.firstAirDate || '').slice(0, 4),
      posterPath: d.posterPath || null,
      backdropPath: d.backdropPath || null,
    };
  }

  function titleFor(ctx, key, mediaType, tmdbId) {
    var ck = mediaType + ':' + tmdbId;
    var known = titles(ctx)[ck];
    if (known) return Promise.resolve(known);
    return apiGet(ctx, key, '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + tmdbId).then(function (d) {
      if (!d) throw new Error('no data');
      var t = titleOf(d);
      cacheTitle(ctx, ck, t);
      return t;
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

  // fn(item) -> Promise for every item, at most `limit` at a time
  function eachLimit(items, limit, fn) {
    return new Promise(function (resolve) {
      var i = 0;
      var left = items.length;
      if (!left) { resolve(); return; }
      var next = function () {
        if (i >= items.length) return;
        var item = items[i++];
        var after = function () {
          left -= 1;
          if (!left) resolve();
          else next();
        };
        fn(item).then(after, after);
      };
      for (var n = 0; n < limit; n++) next();
    });
  }

  var downloadsCache = {}; // key -> {at, items}
  var downloadsPending = {}; // key -> Promise

  M.downloads = function (ctx, p) {
    var key = p.key || 'default';
    var cached = downloadsCache[key];
    if (cached && Date.now() - cached.at < 5000) return Promise.resolve({ returnValue: true, items: cached.items, at: cached.at });
    if (downloadsPending[key]) return downloadsPending[key];
    var queries = [
      '/media?filter=processing&take=100&sort=modified',
      '/media?filter=partial&take=100&sort=modified',
      '/media?filter=available&take=30&sort=modified',
    ];
    var seen = {};
    var found = [];
    var firstErr = null;
    var promise = Promise.all(queries.map(function (q) {
      return apiGet(ctx, key, q).then(function (data) { return data; }, function (err) { firstErr = firstErr || err; return null; });
    })).then(function (answers) {
      // in query order, as the service keeps them
      answers.forEach(function (data) {
        ((data && data.results) || []).forEach(function (m) {
          if (!m || seen[m.id] || !(m.downloadStatus && m.downloadStatus.length)) return;
          seen[m.id] = true;
          found.push(trimMedia(m));
        });
      });
      if (firstErr && !found.length) throw firstErr;
      return eachLimit(found, 4, function (item) {
        return titleFor(ctx, key, item.mediaType, item.tmdbId).then(function (t) {
          item.title = t.title;
          item.year = t.year;
          item.posterPath = t.posterPath;
          item.backdropPath = t.backdropPath;
        });
      });
    }).then(function () {
      delete downloadsPending[key];
      downloadsCache[key] = { at: Date.now(), items: found };
      return { returnValue: true, items: found, at: downloadsCache[key].at };
    }, function (err) {
      delete downloadsPending[key];
      throw err;
    });
    downloadsPending[key] = promise;
    return promise;
  };

  M.lookup = function (ctx, p) {
    var key = p.key || 'default';
    var type = p.mediaType === 'tv' ? 'tv' : p.mediaType === 'movie' ? 'movie' : null;
    var id = Number(p.tmdbId);
    if (!KEY_RE.test(key) || !type || !(id > 0) || Math.floor(id) !== id) return Promise.reject(error('bad_request', 'Bad lookup'));
    return apiGet(ctx, key, '/' + type + '/' + id).then(function (d) {
      if (!d || typeof d !== 'object') throw error('network', 'Overseerr sent no data');
      var mi = d.mediaInfo;
      var t = titleOf(d);
      cacheTitle(ctx, type + ':' + id, t);
      return {
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
      };
    });
  };

  // ---- What seerr.js and plugin.js use --------------------------------------------------------------

  // The last setup problem (CORS, cookie, CSRF), shown in Settings → Overseerr until a call works.
  W.problem = null;

  if (PL.plex && PL.plex.onSignOut) PL.plex.onSignOut.push(function (forget) { if (forget) W.signOut(); });

  // Same contract as ctx.service(method, params): resolves with the answer, rejects with err.code.
  W.call = function (ctx, method, params) {
    var fn = M[method];
    if (!fn) return Promise.reject(error('bad_request', 'Unknown method ' + method));
    var p;
    try { p = fn(ctx, params || {}); } catch (e) { p = Promise.reject(e); }
    return p.then(function (r) {
      W.problem = null;
      return r;
    }, function (err) {
      if (err && err.setup) W.problem = err;
      throw err;
    });
  };

  // Shows a setup problem in a sheet; false if err isn't one (the caller shows a toast).
  // (the web build's explanation card, with a Setup guide button; a plain sheet otherwise)
  W.explain = function (ctx, err) {
    if (!err || !err.setup || !err.explain) return false;
    var rows = err.explain.rows;
    if (PL.web && PL.web.info) {
      var lines = rows.filter(function (r) { return !r.guide; }).map(function (r) { return [r.label, r.sub]; });
      PL.web.info(err.explain.title, lines, [{ label: 'Setup guide', action: function () { W.openGuide(); } }]);
    } else {
      ctx.sheet([{ heading: err.explain.title, rows: rows }], { closeOnSelect: false });
    }
    return true;
  };

  W.openGuide = function () {
    try { window.open(W.DOCS_URL, '_blank', 'noopener'); } catch (e) { /* popup blocked */ }
  };

  // Plex Lite's Sign out (web): end the browser's Overseerr session too. Sent with keepalive
  // because the page reloads right after.
  W.signOut = function () {
    var o = PL.storage.get('plugin.overseerr.web.owner', null);
    if (!o || !o.base) return;
    PL.storage.del('plugin.overseerr.web.owner');
    try {
      W.fetch(o.base + '/api/v1/auth/logout', {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
      }).then(null, function () {});
    } catch (e) { /* ignore */ }
  };
})();
