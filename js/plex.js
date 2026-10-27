// Plex API client. Everything Plex needs goes in the query string (X-Plex-*) rather than headers,
// so requests stay "simple" CORS requests and skip a preflight round trip each.
'use strict';

(function () {
  var PLEX_TV = 'https://plex.tv';
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

  plex.commonParams = function (token) {
    return {
      'X-Plex-Product': 'Plex Lite',
      'X-Plex-Version': PL.VERSION,
      'X-Plex-Client-Identifier': plex.clientId,
      'X-Plex-Platform': 'webOS',
      'X-Plex-Platform-Version': '4.5',
      'X-Plex-Device': 'LG TV',
      'X-Plex-Device-Name': 'LG TV (Plex Lite)',
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

  plex.tvRequest = function (method, path, params, token) {
    var url = withParams(PLEX_TV + path, merge(plex.commonParams(token === undefined ? plex.token : token), params));
    return PL.http(method, url, { timeout: 15000 });
  };

  plex.createPin = function () {
    return plex.tvRequest('POST', '/api/v2/pins', { strong: 'false' }, null);
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

  plex.signOut = function () {
    plex.token = null;
    plex.server = null;
    PL.storage.del('token');
    PL.storage.del('server');
    PL.storage.del('profile');
    if (PL.fuzzy && PL.fuzzy.reset) PL.fuzzy.reset();
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

  plex.switchUser = function (user, pin) {
    return plex.tvRequest('POST', '/api/v2/home/users/' + user.uuid + '/switch', pin ? { pin: pin } : null).then(function (res) {
      if (!res || !res.authToken) throw new Error('Plex did not switch to ' + user.title);
      plex.setToken(res.authToken);
      PL.storage.set('profile', { uuid: user.uuid, title: user.title });
      if (PL.fuzzy && PL.fuzzy.reset) PL.fuzzy.reset();
      return plex.ensureServer(true);
    });
  };

  plex.listServers = function () {
    return plex.tvRequest('GET', '/api/v2/resources', { includeHttps: 1, includeRelay: 1 }).then(function (list) {
      return (list || []).filter(function (r) { return (r.provides || '').indexOf('server') !== -1; });
    });
  };

  // Candidate addresses in order of preference. Plain http on the LAN skips TLS work on the TV's
  // slow CPU; it is only offered when the server does not require secure connections.
  plex.candidates = function (resource) {
    var out = [];
    var conns = resource.connections || [];
    var add = function (uri, kind) { if (out.every(function (c) { return c.uri !== uri; })) out.push({ uri: uri, kind: kind }); };
    conns.filter(function (c) { return c.local && !c.relay; }).forEach(function (c) {
      if (!resource.httpsRequired) add('http://' + c.address + ':' + c.port, 'lan-http');
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
    if (!cands.length) return Promise.reject(new Error('This server has no addresses'));
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

  // {local: 'http://192.168.1.20:32400', remote: 'https://plex.example.com'}; either may be empty.
  plex.manual = function () {
    return PL.storage.get('manualServer', null) || { local: '', remote: '' };
  };

  plex.normalizeUri = function (raw) {
    var s = String(raw || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    if (!/^https?:\/\/[^\/\s]+$/i.test(s)) throw new Error('That doesn\'t look like a server address');
    return s;
  };

  // Connects to a typed-in address: asks the server who it is, then uses that server's access token
  // from the account (shared servers have their own) or the account token for owned ones.
  plex.connectUri = function (uri, kind) {
    return PL.http('GET', uri + '/identity', { timeout: 5000 }).then(function (res) {
      var id = res && res.MediaContainer && res.MediaContainer.machineIdentifier;
      if (!id) throw new Error('No Plex server answered at ' + uri);
      return plex.listServers().then(function (list) {
        var r = list.filter(function (x) { return x.clientIdentifier === id; })[0];
        var token = (r && r.accessToken) || plex.token;
        return probe(uri, token, 5000).then(function () {
          return { machineId: id, name: (r && r.name) || 'Plex server', uri: uri, token: token, kind: kind };
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
    plex.server = server;
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
    });
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
