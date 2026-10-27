// Plugin catalogue and installs (Phase 2). The catalogue is a JSON list kept in the plex-lite repo
// (catalog/plugins.json) and fetched from a configurable URL; the last good copy is cached and a
// copy also ships inside the app as the offline fallback (and until catalog/ is on the repo's main).
// "web" plugins are one JS bundle: downloaded, checked against the catalogue's pinned SHA-256 and
// kept in localStorage, then run in the sandboxed frame (js/plugin-host.js) once the user consents.
// "service" plugins also install an IPK with a background service through Homebrew Channel.
'use strict';

(function (root) {
  var PL = root.PL;
  var DEFAULT_URL = 'https://raw.githubusercontent.com/Obednal97/plex-lite/main/catalog/plugins.json';
  var BUNDLED_URL = 'catalog/plugins.json';
  var HBC = 'luna://org.webosbrew.hbchannel.service/';
  var LIMITS = { catalogBytes: 256 * 1024, entries: 100, bundleBytes: 256 * 1024, totalBytes: 1024 * 1024, fetchMs: 10000, installMs: 180000 };
  var ID_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/;
  var VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
  var HASH_RE = /^[0-9a-f]{64}$/;
  var KINDS = { web: true, service: true };

  function cmpVersion(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : (c >= 0xdc00 && c <= 0xdfff) ? 0 : 3;
    }
    return n;
  }

  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

  // http(s) URLs as given; relative ones resolve against the catalogue's own URL. No other schemes,
  // no "..", so a bundled catalogue can only point inside catalog/.
  function resolveUrl(url, base) {
    if (typeof url !== 'string' || !url || url.length > 2000) return null;
    if (/^https?:\/\/[^\/\s]+/i.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:|^\/|\\/i.test(url) || /(^|\/)\.\.?(\/|$)/.test(url)) return null;
    var b = String(base || '').replace(/[?#].*$/, '');
    return b.slice(0, b.lastIndexOf('/') + 1) + url;
  }

  // -> {plugins: [entry], errors: [text], updated}. Bad entries are skipped (and listed in errors);
  // a catalogue that isn't one at all throws.
  function parseCatalog(input, baseUrl, opts) {
    opts = opts || {};
    var data = input;
    if (typeof input === 'string') {
      if (input.length > LIMITS.catalogBytes) throw new Error('Catalogue too large');
      data = JSON.parse(input);
    }
    if (!data || typeof data !== 'object' || data.schema !== 1 || !Array.isArray(data.plugins)) throw new Error('Not a plugin catalogue');
    var appVersion = opts.appVersion || PL.VERSION;
    var apiVersion = opts.apiVersion || 1;
    var parsePermissions = opts.parsePermissions || PL.pluginHost._internals.parsePermissions;
    var seen = {};
    var errors = [];
    var plugins = [];
    data.plugins.slice(0, LIMITS.entries).forEach(function (p, i) {
      var why = entryError(p, seen, parsePermissions);
      if (why) { errors.push(((p && typeof p.id === 'string') ? p.id.slice(0, 80) : 'entry ' + i) + ': ' + why); return; }
      seen[p.id] = true;
      var e = {
        id: p.id, name: str(p.name, 60), description: str(p.description, 300), author: str(p.author, 60),
        version: p.version, apiVersion: p.apiVersion, kind: p.kind, permissions: p.permissions.slice(),
        minAppVersion: p.minAppVersion || '0.0.0',
        homepage: /^https?:\/\//i.test(p.homepage || '') ? str(p.homepage, 300) : '',
        tabs: (Array.isArray(p.tabs) ? p.tabs : []).filter(function (t) {
          return t && ID_RE.test(String(t.id)) && typeof t.title === 'string';
        }).slice(0, 2).map(function (t) { return { id: t.id, title: t.title.slice(0, 24) }; }),
        bundleUrl: resolveUrl(p.bundleUrl, baseUrl),
        bundleSha256: p.kind === 'web' ? p.sha256 : p.bundleSha256,
      };
      if (p.kind === 'service') {
        e.ipkUrl = p.ipkUrl;
        e.ipkSha256 = p.sha256;
        e.serviceId = p.serviceId || p.id + '.service';
      }
      e.compatible = cmpVersion(appVersion, e.minAppVersion) >= 0 && e.apiVersion <= apiVersion;
      if (!e.compatible) e.needs = e.apiVersion > apiVersion ? 'Needs a newer Plex Lite' : 'Needs Plex Lite ' + e.minAppVersion;
      plugins.push(e);
    });
    return { plugins: plugins, errors: errors, updated: str(data.updated, 40) };
  }

  function entryError(p, seen, parsePermissions) {
    if (!p || typeof p !== 'object') return 'not an object';
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'bad id';
    if (seen[p.id]) return 'duplicate id';
    if (typeof p.name !== 'string' || !p.name) return 'missing name';
    if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) return 'bad version';
    if (p.minAppVersion != null && !VERSION_RE.test(String(p.minAppVersion))) return 'bad minAppVersion';
    if (typeof p.apiVersion !== 'number' || p.apiVersion < 1) return 'bad apiVersion';
    if (!KINDS[p.kind]) return 'bad kind';
    if (!Array.isArray(p.permissions)) return 'missing permissions';
    var perms = parsePermissions({ permissions: p.permissions });
    if (perms.errors.length) return perms.errors[0];
    if (typeof p.sha256 !== 'string' || !HASH_RE.test(p.sha256)) return 'bad sha256';
    if (typeof p.bundleUrl !== 'string' || !resolveUrl(p.bundleUrl, 'x/')) return 'bad bundleUrl';
    if (p.kind === 'service') {
      if (typeof p.ipkUrl !== 'string' || !/^https?:\/\//i.test(p.ipkUrl)) return 'bad ipkUrl';
      if (typeof p.bundleSha256 !== 'string' || !HASH_RE.test(p.bundleSha256)) return 'bad bundleSha256';
      if (p.serviceId != null && (typeof p.serviceId !== 'string' || p.serviceId.indexOf(p.id + '.') !== 0)) return 'serviceId must start with the plugin id';
      if (p.permissions.indexOf('service') === -1) return 'service plugins need the "service" permission';
    }
    return null;
  }

  // A catalogue entry as the manifest the host runs with.
  function manifestOf(e) {
    var m = {
      id: e.id, title: e.name, version: e.version, apiVersion: e.apiVersion, kind: e.kind,
      description: e.description, author: e.author, permissions: e.permissions.slice(), tabs: e.tabs.slice(),
    };
    if (e.kind === 'service') m.service = e.serviceId;
    return m;
  }

  // file:// requests report status 0 even when they succeed.
  function xhrText(url) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.timeout = LIMITS.fetchMs;
      x.onload = function () {
        var local = !/^https?:/i.test(url);
        if ((x.status >= 200 && x.status < 300) || (local && x.status === 0 && x.responseText)) resolve(x.responseText);
        else reject(new Error('HTTP ' + x.status));
      };
      x.onerror = x.ontimeout = function () { reject(new Error('Network error')); };
      x.send();
    });
  }

  // deps (all injectable for tests): storage {get,set,del}, fetchText(url), sha256(str), host
  // (PL.pluginHost), plugins (PL.plugins), luna(uri, params, timeoutMs, onUpdate), appVersion.
  function createStore(deps) {
    var d = deps || {};
    var dep = function (name, fallback) { return d[name] || fallback(); };
    var storage = function () { return dep('storage', function () { return PL.storage; }); };
    var host = function () { return dep('host', function () { return PL.pluginHost; }); };
    var plugins = function () { return dep('plugins', function () { return PL.plugins; }); };
    var fetchText = function (url) { return (d.fetchText || xhrText)(url); };
    var sha256 = function (s) { return (d.sha256 || PL.sha256)(s); };
    var luna = function (uri, params, ms, onUpdate) { return (d.luna || host().luna)(uri, params, ms, onUpdate); };
    var busy = {};

    var store = { LIMITS: LIMITS, DEFAULT_URL: DEFAULT_URL, catalog: null };

    store.catalogUrl = function () { return storage().get('plugins.catalogUrl', null) || DEFAULT_URL; };
    store.setCatalogUrl = function (url) {
      if (url && !/^https?:\/\/[^\/\s]+/i.test(url)) return false;
      if (url && url !== DEFAULT_URL) storage().set('plugins.catalogUrl', url);
      else storage().del('plugins.catalogUrl');
      return true;
    };

    function parse(text, url) {
      return parseCatalog(text, url, { appVersion: d.appVersion, parsePermissions: d.parsePermissions, apiVersion: d.apiVersion });
    }

    // Remote, then the cached last good copy or the bundled one (whichever is newer). Never rejects.
    store.loadCatalog = function () {
      var url = store.catalogUrl();
      return fetchText(url).then(function (text) {
        var c = parse(text, url);
        storage().set('plugins.catalogCache', { url: url, text: text, at: Date.now() });
        c.source = 'remote';
        return c;
      }).then(null, function (remoteErr) {
        var cached = null;
        var cache = storage().get('plugins.catalogCache', null);
        if (cache && cache.url === url && typeof cache.text === 'string') {
          try { cached = parse(cache.text, cache.url); cached.source = 'cache'; cached.at = cache.at; } catch (e) { cached = null; }
        }
        return fetchText(BUNDLED_URL).then(function (text) {
          var bundled = parse(text, BUNDLED_URL);
          bundled.source = 'bundled';
          return cached && cached.updated >= bundled.updated ? cached : bundled;
        }, function () {
          if (cached) return cached;
          throw remoteErr;
        });
      }).then(function (c) {
        store.catalog = c;
        return c;
      }, function (e) {
        store.catalog = { plugins: [], errors: [e && e.message || 'No catalogue'], source: 'none' };
        return store.catalog;
      });
    };

    // {id: {id, kind, version, hash, ipkSha256?, manifest, installedAt}}; code lives in plugins.bundle.<id>.
    store.installed = function () { return storage().get('plugins.installed', {}) || {}; };
    function saveInstalled(all) { storage().set('plugins.installed', all); }

    store.isConnected = function (id) {
      var h = host();
      return !!(h && h.definitions && h.definitions[id]) && !!(plugins() && plugins().isEnabled(id));
    };

    // 'not-installed' | 'update-available' | 'connected' | 'installed', plus details for the UI.
    store.state = function (entry) {
      var rec = store.installed()[entry.id];
      var connected = !!rec && store.isConnected(entry.id);
      var state = !rec ? 'not-installed'
        : cmpVersion(entry.version, rec.version) > 0 ? 'update-available'
        : connected ? 'connected' : 'installed';
      return { state: state, installed: rec || null, connected: connected, busy: !!busy[entry.id] };
    };

    function fetchVerified(url, hash) {
      if (!url) return Promise.reject(new Error('This plugin has no code to download'));
      return fetchText(url).then(function (src) {
        if (typeof src !== 'string' || !src) throw new Error('Empty plugin download');
        if (bytes(src) > LIMITS.bundleBytes) throw new Error('Plugin is too large (' + Math.round(bytes(src) / 1024) + ' KB)');
        if (sha256(src) !== hash) throw new Error('Download does not match the catalogue (checksum differs)');
        return src;
      });
    }

    function storeBundle(id, src) {
      var all = store.installed();
      var total = bytes(src);
      Object.keys(all).forEach(function (k) {
        if (k !== id) total += bytes(storage().get('plugins.bundle.' + k, '') || '');
      });
      if (total > LIMITS.totalBytes) throw new Error('Not enough room for more plugins');
      storage().set('plugins.bundle.' + id, src);
      // PL.storage swallows quota errors; read back to be sure the whole bundle landed.
      if (storage().get('plugins.bundle.' + id, null) !== src) {
        storage().del('plugins.bundle.' + id);
        throw new Error('Not enough room to store the plugin');
      }
    }

    // Install or update. onProgress(text) gets status lines. Resolves with the installed record; the
    // plugin then waits for consent (store.connect) unless an update keeps all its grants.
    store.install = function (entry, onProgress) {
      var say = function (t) { if (onProgress) { try { onProgress(t); } catch (e) { /* UI */ } } };
      if (busy[entry.id]) return Promise.reject(new Error('Already installing'));
      if (!entry.compatible) return Promise.reject(new Error(entry.needs || 'Not compatible'));
      busy[entry.id] = true;
      say('Downloading…');
      var src;
      return fetchVerified(entry.bundleUrl, entry.bundleSha256).then(function (s) {
        src = s;
        if (entry.kind !== 'service') return null;
        say('Installing service…');
        return luna(HBC + 'install', { ipkUrl: entry.ipkUrl, ipkHash: entry.ipkSha256, subscribe: true }, LIMITS.installMs, function (r) {
          if (r.statusText) say(String(r.statusText).slice(0, 60));
          return r.finished === true;
        });
      }).then(function () {
        storeBundle(entry.id, src);
        var all = store.installed();
        var rec = {
          id: entry.id, kind: entry.kind, version: entry.version, hash: entry.bundleSha256,
          manifest: manifestOf(entry), installedAt: Date.now(),
        };
        if (entry.kind === 'service') { rec.ipkSha256 = entry.ipkSha256; rec.serviceId = entry.serviceId; }
        all[entry.id] = rec;
        saveInstalled(all);
        var h = host();
        if (h && h.addRuntime) h.addRuntime({ manifest: rec.manifest, source: src, hash: rec.hash });
        if (PL.log) PL.log('plugin installed', entry.id, entry.version);
        delete busy[entry.id];
        return rec;
      }, function (e) {
        delete busy[entry.id];
        throw e;
      });
    };
    store.update = store.install;

    // Consent sheet, then on. Resolves true when the plugin is running.
    store.connect = function (id) {
      var h = host();
      if (!h || !h.runtimes || !h.runtimes[id]) return Promise.reject(new Error('Plugin is not installed'));
      return h.enable(id).then(function (def) {
        if (!def) return false;
        if (plugins() && plugins().setEnabled) plugins().setEnabled(id, true);
        return true;
      });
    };

    store.disconnect = function (id) {
      var h = host();
      if (h && h.revoke) h.revoke(id);
    };

    // Removes code, grants and the plugin's own storage; service plugins are uninstalled too.
    store.remove = function (id) {
      var all = store.installed();
      var rec = all[id];
      var h = host();
      if (h && h.removeRuntime) h.removeRuntime(id);
      delete all[id];
      saveInstalled(all);
      storage().del('plugins.bundle.' + id);
      storage().del('plugin.' + id);
      if (PL.log) PL.log('plugin removed', id);
      if (rec && rec.kind === 'service') {
        return luna(HBC + 'uninstall', { id: id }, 60000).then(function () { return true; }, function (e) {
          PL.warn('plugin service uninstall failed', id, e && e.message);
          return false;
        });
      }
      return Promise.resolve(true);
    };

    // Installed plugins for the host to start.
    store.installedBundles = function () {
      var all = store.installed();
      return Object.keys(all).map(function (id) {
        var rec = all[id];
        var src = storage().get('plugins.bundle.' + id, null);
        if (!src || !rec.manifest) return null;
        return { manifest: rec.manifest, source: src, hash: rec.hash };
      }).filter(Boolean);
    };

    return store;
  }

  PL.pluginStore = createStore();
  PL.pluginStore._create = createStore;
  PL.pluginStore._internals = { parseCatalog: parseCatalog, resolveUrl: resolveUrl, cmpVersion: cmpVersion, manifestOf: manifestOf, bytes: bytes, LIMITS: LIMITS };
})(typeof window !== 'undefined' ? window : this);
