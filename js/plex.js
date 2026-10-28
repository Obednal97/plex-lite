// Plex API client. Everything Plex needs goes in the query string (X-Plex-*) rather than headers,
// so requests stay "simple" CORS requests and skip a preflight round trip each.
'use strict';

(function () {
  // dev tools (tools/demo/server.mjs) can point plex.tv calls at a local mock
  var PLEX_TV = (window.PL_DEV && window.PL_DEV.plexTv) || 'https://plex.tv';
  var VIDEO_TYPES = { movie: 1, show: 1, season: 1, episode: 1, mixed: 1, clip: 1 };

  var plex = PL.plex = {
    clientId: null,
    token: null,
    server: null, // {machineId, name, uri, token}
  };

  plex.init = function () {
    var dev = window.PL_DEV || null;
    plex.clientId = PL.storage.get('clientId', null) || (dev && dev.clientId) || PL.uuid();
    PL.storage.set('clientId', plex.clientId);
    plex.token = (dev && dev.token) || PL.storage.get('token', null);
    if (plex.token) PL.storage.set('token', plex.token);
    plex.server = (dev && dev.server) || PL.storage.get('server', null);
  };

  // How this client shows up in Plex (dashboard, Authorized Devices). The web build replaces it
  // with the browser and OS (web/web.js).
  plex.device = { platform: 'webOS', platformVersion: '4.5', device: 'LG TV', deviceName: 'LG TV (Plex Lite)' };

  plex.commonParams = function (token) {
    var d = plex.device;
    return {
      'X-Plex-Product': 'Plex Lite',
      'X-Plex-Version': PL.VERSION,
      'X-Plex-Client-Identifier': plex.clientId,
      'X-Plex-Platform': d.platform,
      'X-Plex-Platform-Version': d.platformVersion,
      'X-Plex-Device': d.device,
      'X-Plex-Device-Name': d.deviceName,
      'X-Plex-Language': 'en',
      'X-Plex-Token': token || undefined,
    };
  };

  function withParams(url, params) {
    var q = PL.query(params);
    if (!q) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + q;
  }

  function merge(a, b) {
    var out = {};
    [a, b].forEach(function (o) { if (o) Object.keys(o).forEach(function (k) { out[k] = o[k]; }); });
    return out;
  }

  // ---- plex.tv: sign-in and server discovery -------------------------------------------------

  // A 401 from the media server means the token was revoked on plex.tv or the server's access token
  // changed. The app decides what to do (plex.onUnauthorized); the request still fails as usual.
  // (plex.tv requests are left out: their callers handle a rejected token themselves.)
  plex.onUnauthorized = null;
  plex.check401 = function (err) {
    if (err && err.status === 401 && plex.onUnauthorized) plex.onUnauthorized(err);
    throw err;
  };

  plex.tvRequest = function (method, path, params, token) {
    var url = withParams(PLEX_TV + path, merge(plex.commonParams(token === undefined ? plex.token : token), params));
    return PL.http(method, url, { timeout: 15000 });
  };

  // strong: a long code for the app.plex.tv/auth page (web sign-in); otherwise the four-character
  // code that is typed in at plex.tv/link.
  plex.createPin = function (strong) {
    return plex.tvRequest('POST', '/api/v2/pins', { strong: strong ? 'true' : 'false' }, null);
  };

  // Plex's own sign-in page for a strong PIN; Plex sends the browser on to forwardUrl afterwards.
  plex.authUrl = function (pin, forwardUrl) {
    return 'https://app.plex.tv/auth#?' + PL.query({
      clientID: plex.clientId,
      code: pin.code,
      forwardUrl: forwardUrl,
      'context[device][product]': 'Plex Lite',
      'context[device][platform]': plex.device.platform,
      'context[device][device]': plex.device.device,
      'context[device][version]': PL.VERSION,
    });
  };

  plex.checkPin = function (id) {
    return plex.tvRequest('GET', '/api/v2/pins/' + id, null, null).then(function (pin) {
      return pin && pin.authToken ? pin.authToken : null;
    });
  };

  plex.setToken = function (token) {
    plex.token = token;
    PL.storage.set('token', token);
  };

  // forget: the user chose Sign out (Settings). In the web build that also clears everything else
  // Plex Lite kept in the browser; a sign-in that expired or was revoked keeps the settings.
  // fn(forget) for each, before anything is cleared (the web build's Overseerr path ends its session)
  plex.onSignOut = [];

  plex.signOut = function (forget) {
    plex.onSignOut.forEach(function (fn) {
      try { fn(!!forget); } catch (e) { PL.warn('sign-out hook failed', e && e.message); }
    });
    plex.token = null;
    plex.server = null;
    PL.storage.del('token');
    PL.storage.del('server');
    PL.storage.del('profile');
    PL.storage.del('manualServer');
    // a browser may be shared: drop everything the app kept (settings, favourites, search index,
    // plugins) and start again as a new device
    if (PL.isWeb && forget) {
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf('pl.') === 0) localStorage.removeItem(k);
        }
        sessionStorage.clear();
      } catch (e) { /* storage blocked */ }
      plex.clientId = PL.uuid();
      PL.storage.set('clientId', plex.clientId);
    }
    if (PL.fuzzy && PL.fuzzy.reset) PL.fuzzy.reset();
    if (plex.onServerChange) plex.onServerChange();
  };

  plex.user = function () {
    return plex.tvRequest('GET', '/api/v2/user');
  };

  // Plex Home profiles. Switching swaps the account token; the server access token for the new
  // profile comes from a fresh server discovery (it differs for managed users).
  plex.homeUsers = function () {
    return plex.tvRequest('GET', '/api/v2/home/users').then(function (res) {
      return (res && (res.users || res)) || [];
    });
  };

  // All-or-nothing: the new profile's token, server and name are only kept if its server connects.
  plex.switchUser = function (user, pin) {
    var prev = { token: plex.token, server: plex.server, profile: PL.storage.get('profile', null) };
    return plex.tvRequest('POST', '/api/v2/home/users/' + user.uuid + '/switch', pin ? { pin: pin } : null).then(function (res) {
      if (!res || !res.authToken) throw new Error('Plex did not switch to ' + user.title);
      plex.token = res.authToken;
      return plex.ensureServer(true).then(function (server) {
        plex.setToken(res.authToken);
        PL.storage.set('profile', { uuid: user.uuid, title: user.title });
        if (PL.fuzzy && PL.fuzzy.reset) PL.fuzzy.reset();
        return server;
      });
    }).then(null, function (err) {
      plex.token = prev.token;
      if (prev.server) plex.useServer(prev.server);
      throw err;
    });
  };

  plex.listServers = function () {
    return plex.tvRequest('GET', '/api/v2/resources', { includeHttps: 1, includeRelay: 1 }).then(function (list) {
      return (list || []).filter(function (r) { return (r.provides || '').indexOf('server') !== -1; });
    });
  };

  // Candidate addresses in order of preference. Plain http on the LAN skips TLS work on the TV's
  // slow CPU; it is only offered when the server does not require secure connections. The web build
  // is served over https, so it uses the https (*.plex.direct) addresses only: a browser blocks
  // plain http from an https page (mixed content).
  plex.candidates = function (resource) {
    var out = [];
    var conns = resource.connections || [];
    var add = function (uri, kind) {
      if (PL.isWeb && !/^https:/i.test(uri)) return;
      if (out.every(function (c) { return c.uri !== uri; })) out.push({ uri: uri, kind: kind });
    };
    conns.filter(function (c) { return c.local && !c.relay; }).forEach(function (c) {
      if (!resource.httpsRequired && !PL.isWeb) add('http://' + c.address + ':' + c.port, 'lan-http');
      add(c.uri, 'lan');
    });
    conns.filter(function (c) { return !c.local && !c.relay; }).forEach(function (c) { add(c.uri, 'remote'); });
    conns.filter(function (c) { return c.relay; }).forEach(function (c) { add(c.uri, 'relay'); });
    return out;
  };

  function probe(uri, token, timeout) {
    return PL.http('GET', withParams(uri + '/identity', { 'X-Plex-Token': token }), { timeout: timeout });
  }

  // Probes all candidates at once; picks the most preferred one that answers.
  plex.connect = function (resource) {
    var cands = plex.candidates(resource);
    var token = resource.accessToken || plex.token;
    if (!cands.length) {
      return Promise.reject(new Error(PL.isWeb && (resource.connections || []).length
        ? resource.name + ' has no secure address, which a browser needs: in Plex, Settings, Network, set Secure connections to Preferred'
        : 'This server has no addresses'));
    }
    return new Promise(function (resolve, reject) {
      var state = cands.map(function () { return 'pending'; });
      var settled = false;
      var decide = function () {
        if (settled) return;
        for (var i = 0; i < state.length; i++) {
          if (state[i] === 'pending') return;
          if (state[i] === 'ok') {
            settled = true;
            return resolve({ machineId: resource.clientIdentifier, name: resource.name, uri: cands[i].uri, token: token, kind: cands[i].kind });
          }
        }
        settled = true;
        reject(new Error('Could not reach ' + resource.name + ' at any of its addresses'));
      };
      cands.forEach(function (c, i) {
        probe(c.uri, token, c.kind === 'relay' ? 8000 : 4000).then(
          function () { state[i] = 'ok'; decide(); },
          function () { state[i] = 'fail'; decide(); });
      });
    });
  };

  // ---- Manual server addresses (Settings) -------------------------------------------------------

  // {local: 'http://192.168.0.10:32400', remote: 'https://plex.example.com'}; either may be empty.
  plex.manual = function () {
    return PL.storage.get('manualServer', null) || { local: '', remote: '' };
  };

  // Keeps scheme://host[:port] only (drops paths like /web/index.html); plain http without a port
  // gets Plex's default 32400.
  plex.normalizeUri = function (raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = (PL.isWeb ? 'https://' : 'http://') + s;
    var m = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?(?:[\/?#].*)?$/i.exec(s);
    if (!m) throw new Error('That doesn\'t look like a server address');
    var scheme = m[1].toLowerCase();
    var port = m[3] || (scheme === 'http' ? '32400' : '');
    return scheme + '://' + m[2] + (port ? ':' + port : '');
  };

  // Connects to a typed-in address: asks the server who it is, then uses that server's access token
  // from the account (shared servers have their own) or the account token for owned ones.
  // The account token is never sent to a server that isn't linked to the account (a typo or a stranger's
  // server would otherwise receive it); a remote address must use https so it isn't sent in the clear.
  plex.connectUri = function (uri, kind) {
    if (kind === 'manual-remote' && !/^https:/i.test(uri)) {
      return Promise.reject(new Error('A remote address must start with https://'));
    }
    if (PL.isWeb && !/^https:/i.test(uri)) {
      return Promise.reject(new Error('In a browser the address must start with https:// (the page is secure)'));
    }
    return PL.http('GET', uri + '/identity', { timeout: 5000 }).then(function (res) {
      var id = res && res.MediaContainer && res.MediaContainer.machineIdentifier;
      if (!id) throw new Error('No Plex server answered at ' + uri);
      var known = plex.server && plex.server.machineId === id ? plex.server : null;
      return plex.listServers().then(function (list) {
        var r = list.filter(function (x) { return x.clientIdentifier === id; })[0];
        if (!r) throw new Error('That server isn\'t linked to your Plex account');
        return { id: id, name: r.name, token: r.accessToken || plex.token };
      }, function (err) {
        // plex.tv unreachable (LAN without internet): only reuse the token we already trust for this server
        if (!known) throw err;
        return { id: id, name: known.name, token: known.token };
      }).then(function (s) {
        return probe(uri, s.token, 5000).then(function () {
          return { machineId: s.id, name: s.name, uri: uri, token: s.token, kind: kind };
        });
      });
    });
  };

  function connectManual(manual) {
    var tries = [];
    if (manual.local) tries.push([manual.local, 'manual-local']);
    if (manual.remote) tries.push([manual.remote, 'manual-remote']);
    var attempt = function (i) {
      if (i >= tries.length) return Promise.reject(new Error('Your saved server addresses did not answer'));
      return plex.connectUri(tries[i][0], tries[i][1]).then(null, function () { return attempt(i + 1); });
    };
    return attempt(0);
  }

  plex.useServer = function (server) {
    var changed = !plex.server || plex.server.machineId !== server.machineId || plex.server.token !== server.token;
    plex.server = server;
    if (changed && plex.onServerChange) plex.onServerChange();
    PL.storage.set('server', server);
    PL.log('server', server.name, server.kind, PL.redact(server.uri));
  };

  // Uses the remembered server if it still answers; otherwise discovers servers again. The current
  // server stays in place until a replacement is found. force: skip the remembered one.
  plex.ensureServer = function (force) {
    var cached = plex.server;
    var rediscover = function () {
      return plex.listServers().then(function (servers) {
        if (!servers.length) throw new Error('No Plex servers are linked to this account');
        var preferred = cached && servers.filter(function (s) { return s.clientIdentifier === cached.machineId; })[0];
        var owned = servers.filter(function (s) { return s.owned; })[0];
        return plex.connect(preferred || owned || servers[0]);
      }).then(function (server) {
        plex.useServer(server);
        return server;
      });
    };
    var manual = plex.manual();
    if (manual.local || manual.remote) {
      var viaManual = function () {
        return connectManual(manual).then(function (server) {
          plex.useServer(server);
          return server;
        }, function (err) {
          PL.warn('manual addresses failed, using automatic discovery', err && err.message);
          return rediscover();
        });
      };
      if (!cached || force || String(cached.kind).indexOf('manual') !== 0) return viaManual();
      return probe(cached.uri, cached.token, 2500).then(function () { return cached; }, viaManual);
    }
    if (!cached || force) return rediscover();
    return probe(cached.uri, cached.token, 2500).then(function () {
      // stuck on a remote/relay address after a LAN hiccup: look for a LAN route in the background
      if (cached.kind === 'remote' || cached.kind === 'relay') {
        rediscover().then(function (s) { PL.log('server route now', s.kind); }, function () {});
      }
      return cached;
    }, rediscover);
  };

  // ---- Media server ----------------------------------------------------------------------------

  plex.url = function (path, params) {
    var s = plex.server;
    return withParams(s.uri + path, merge(plex.commonParams(s.token), params));
  };

  plex.request = function (method, path, params, opts) {
    return PL.http(method, plex.url(path, params), opts).then(function (res) {
      return res && res.MediaContainer ? res.MediaContainer : res;
    }, plex.check401);
  };

  plex.get = function (path, params, opts) { return plex.request('GET', path, params, opts); };

  // Server-side resized image, so the TV never decodes or scales big artwork.
  // extra: e.g. {blur: 28, opacity: 55, background: '0b0b0f', format: 'jpeg', quality: 70}
  plex.image = function (path, width, height, extra) {
    if (!path || !plex.server) return null;
    return withParams(plex.server.uri + '/photo/:/transcode', merge({
      width: Math.round(width), height: Math.round(height), minSize: 1, upscale: 1, url: path,
    }, merge(extra, { 'X-Plex-Token': plex.server.token })));
  };

  plex.isVideoHub = function (hub) {
    return hub && hub.size > 0 && VIDEO_TYPES[hub.type] === 1 && hub.Metadata && hub.Metadata.length > 0;
  };

  plex.hubs = function () {
    return plex.get('/hubs', { count: 20 }).then(function (mc) {
      return (mc.Hub || []).filter(plex.isVideoHub);
    });
  };

  plex.hubPage = function (hub, start, size) {
    return plex.get(hub.key, { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size }).then(function (mc) {
      return mc.Metadata || [];
    });
  };

  plex.sections = function () {
    return plex.get('/library/sections').then(function (mc) {
      return (mc.Directory || []).filter(function (d) { return d.type === 'movie' || d.type === 'show'; });
    });
  };

  plex.sectionPage = function (section, sort, start, size) {
    return plex.get('/library/sections/' + section.key + '/all', {
      type: section.type === 'show' ? 2 : 1,
      sort: sort,
      includeCollections: 0,
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
    }).then(function (mc) {
      return { total: mc.totalSize != null ? mc.totalSize : mc.size, items: mc.Metadata || [] };
    });
  };

  plex.metadata = function (ratingKey) {
    return plex.get('/library/metadata/' + ratingKey, { includeOnDeck: 1, includeExtras: 0, checkFiles: 0 }).then(function (mc) {
      var item = (mc.Metadata || [])[0];
      if (!item) throw new Error('This item is no longer on the server');
      return item;
    });
  };

  // A show's next episode from includeOnDeck=1. Plex sends OnDeck.Metadata as a single object (not
  // the usual array); accept both.
  plex.onDeck = function (show) {
    var m = show && show.OnDeck && show.OnDeck.Metadata;
    if (!m) return null;
    return (m.length != null ? m[0] : m) || null;
  };

  plex.children = function (ratingKey) {
    return plex.get('/library/metadata/' + ratingKey + '/children', { excludeAllLeaves: 1 }).then(function (mc) {
      return mc.Metadata || [];
    });
  };

  plex.search = function (query) {
    return plex.get('/hubs/search', { query: query, limit: 20, includeCollections: 0 }).then(function (mc) {
      return (mc.Hub || []).filter(plex.isVideoHub);
    });
  };

  plex.setWatched = function (ratingKey, watched) {
    return plex.get(watched ? '/:/scrobble' : '/:/unscrobble', { key: ratingKey, identifier: 'com.plexapp.plugins.library' });
  };

  plex.selectStreams = function (partId, choice) {
    var params = { allParts: 1 };
    if (choice.audioStreamID != null) params.audioStreamID = choice.audioStreamID;
    if (choice.subtitleStreamID != null) params.subtitleStreamID = choice.subtitleStreamID;
    return plex.request('PUT', '/library/parts/' + partId, params);
  };

  plex.createPlayQueue = function (item) {
    return plex.request('POST', '/playQueues', {
      type: 'video',
      uri: 'server://' + plex.server.machineId + '/com.plexapp.plugins.library/library/metadata/' + item.ratingKey,
      continuous: item.type === 'episode' ? 1 : 0,
      own: 1,
      includeChapters: 0,
    });
  };

  plex.timeline = function (params) {
    return plex.get('/:/timeline', params, { timeout: 8000 });
  };
})();
