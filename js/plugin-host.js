// Plugin host (Phase 2): runs separately installed plugins in sandboxed iframes and exposes them
// to the app with the same hook shapes as bundled Phase 1 plugins (searchRows, shelfRows, actions,
// settingsRows). Plugins never see the Plex token or other plugins' data unless the user grants it;
// everything they can do is a host capability checked against their grants. See
// docs/PLUGINS-v2-design.md.
'use strict';

(function () {
  var PL = window.PL = window.PL || {};
  var host = PL.pluginHost = PL.pluginHost || {};

  var API_VERSION = 1;
  var LIMITS = {
    callTimeoutMs: 4000,
    readyTimeoutMs: 6000,
    maxMessageBytes: 256 * 1024,
    maxPending: 16,
    maxActiveFrames: 3,
    idleUnloadMs: 5 * 60 * 1000,
    maxFailures: 5,
    storageBytes: 64 * 1024,
    fetchBytes: 1024 * 1024,
  };
  host.LIMITS = LIMITS;

  // ---- Permissions -------------------------------------------------------------------------------

  var KNOWN = {
    'plex:read': { risk: 'low', text: 'Read your Plex libraries (titles, artwork, watch progress)' },
    'plex:token': { risk: 'high', text: 'Use your Plex sign-in (full access to your Plex account)' },
    'service': { risk: 'medium', text: 'Run its own background service on the TV' },
    'tabs': { risk: 'low', text: 'Add its own tab to Plex Lite' },
  };

  function originOf(url) {
    var m = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?(?:[\/?#]|$)/.exec(String(url || ''));
    if (!m) return null;
    var port = m[3] && !((m[1] === 'https' && m[3] === '443') || (m[1] === 'http' && m[3] === '80')) ? ':' + m[3] : '';
    return m[1].toLowerCase() + '://' + m[2].toLowerCase() + port;
  }

  // manifest.permissions: ["plex:read", "plex:token", "service", "network:https://api.example.com",
  // "network:user"] ("network:user" = an address the user types into the plugin's settings).
  function parsePermissions(manifest) {
    var out = [];
    var errors = [];
    (manifest.permissions || []).forEach(function (p) {
      if (typeof p !== 'string') { errors.push('bad permission'); return; }
      if (KNOWN[p]) {
        out.push({ id: p, risk: KNOWN[p].risk, text: KNOWN[p].text });
      } else if (p === 'network:user') {
        out.push({ id: p, risk: 'medium', text: 'Contact a server address you enter' });
      } else if (p.indexOf('network:') === 0 && originOf(p.slice(8))) {
        var o = originOf(p.slice(8));
        out.push({ id: 'network:' + o, risk: 'medium', text: 'Contact ' + o.replace(/^https?:\/\//, '') });
      } else {
        errors.push('unknown permission ' + p);
      }
    });
    return { list: out, errors: errors };
  }

  // Grant records live in PL.storage('pluginHost.grants'): {id: {version, hash, granted: [...],
  // origins: [...user-approved origins], denied: bool}}.
  function Grants(storage) {
    this.storage = storage;
  }

  Grants.prototype.all = function () { return this.storage.get('pluginHost.grants', {}) || {}; };
  Grants.prototype.get = function (id) { return this.all()[id] || null; };
  Grants.prototype.set = function (id, rec) {
    var all = this.all();
    all[id] = rec;
    this.storage.set('pluginHost.grants', all);
  };
  Grants.prototype.remove = function (id) {
    var all = this.all();
    delete all[id];
    this.storage.set('pluginHost.grants', all);
  };

  // Permissions the plugin asks for that the user has not granted yet. An update that adds one must
  // ask again; a code-only update keeps grants, EXCEPT "plex:token" (Sensitive), which is re-asked
  // whenever the version or code hash changes.
  Grants.prototype.missing = function (id, manifest, hash) {
    var rec = this.get(id);
    var have = rec && !rec.denied ? rec.granted : [];
    var changed = !!rec && (rec.version !== manifest.version || (hash && rec.hash && rec.hash !== hash));
    return parsePermissions(manifest).list.filter(function (p) {
      return have.indexOf(p.id) === -1 || (p.id === 'plex:token' && changed);
    });
  };

  function hasGrant(rec, perm) {
    return !!rec && !rec.denied && rec.granted.indexOf(perm) !== -1;
  }

  function originAllowed(rec, url) {
    var o = originOf(url);
    if (!o || !rec || rec.denied) return false;
    if (rec.granted.indexOf('network:' + o) !== -1) return true;
    return rec.granted.indexOf('network:user') !== -1 && (rec.origins || []).indexOf(o) !== -1;
  }

  // ---- Sanitising what crosses the boundary ------------------------------------------------------

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : (typeof v === 'number' ? String(v).slice(0, max) : '');
  }

  // What a plugin learns about a Plex item: plain facts, never URLs (they carry the token).
  var ITEM_FIELDS = ['ratingKey', 'type', 'title', 'year', 'guid', 'grandparentTitle', 'parentTitle',
    'parentIndex', 'index', 'duration', 'viewOffset', 'viewCount', 'librarySectionID', 'originallyAvailableAt'];

  function projectItem(item) {
    var out = {};
    ITEM_FIELDS.forEach(function (k) {
      var v = item && item[k];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    });
    return out;
  }

  // Images: a Plex path (resized by the Plex server) or an http(s) URL on an origin the plugin may contact.
  function sanitizeImage(img, rec) {
    if (!img) return null;
    if (typeof img === 'object' && typeof img.plex === 'string' && /^\/library\/[A-Za-z0-9\/_.-]+$/.test(img.plex)) {
      return { plex: img.plex };
    }
    if (typeof img === 'string' && originAllowed(rec, img)) return { url: img.slice(0, 1024) };
    return null;
  }

  function sanitizeShelf(raw, rec) {
    if (!raw || typeof raw !== 'object') return null;
    var items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 40).map(function (it, i) {
      it = it || {};
      return {
        key: str(it.key || String(i), 64),
        title: str(it.title, 120),
        subtitle: str(it.subtitle, 120),
        image: sanitizeImage(it.image, rec),
        progress: typeof it.progress === 'number' && it.progress >= 0 && it.progress <= 1 ? it.progress : 0,
        ratingKey: /^\d{1,12}$/.test(String(it.ratingKey || '')) ? String(it.ratingKey) : null,
        select: typeof it.select === 'string' ? it.select : null,
      };
    }).filter(function (it) { return it.title; });
    if (!items.length) return null;
    return { title: str(raw.title, 80) || 'From a plugin', kind: raw.kind === 'wide' ? 'wide' : 'poster', items: items };
  }

  var ICONS = ['play', 'restart', 'trailer', 'shuffle', 'check', 'watched', 'season', 'tracks', 'versions', 'show'];

  function sanitizeList(raw, max) {
    return (Array.isArray(raw) ? raw : []).slice(0, max).map(function (a) {
      a = a || {};
      return {
        id: typeof a.id === 'string' ? a.id : null,
        label: str(a.label, 48),
        value: str(a.value, 48),
        icon: ICONS.indexOf(a.icon) !== -1 ? a.icon : null,
      };
    }).filter(function (a) { return a.label && a.id; });
  }

  // Plex API reads a plugin may make through the host (GET only, the host adds the token).
  var PLEX_PATHS = [
    /^\/library\/sections(\/\d+(\/(all|collections|genre|decade|firstCharacter|recentlyAdded))?)?$/,
    /^\/library\/metadata\/\d+(\/(children|related|extras))?$/,
    /^\/library\/collections\/\d+\/children$/,
    /^\/hubs(\/(search|home\/(onDeck|continueWatching|recentlyAdded)|sections\/\d+))?$/,
  ];

  function plexPathAllowed(path) {
    return typeof path === 'string' && PLEX_PATHS.some(function (re) { return re.test(path); });
  }

  function cleanParams(params) {
    var out = {};
    Object.keys(params || {}).slice(0, 20).forEach(function (k) {
      var v = params[k];
      if (/^X-Plex-Token$/i.test(k)) return;
      if (/^[A-Za-z0-9_.:-]{1,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).slice(0, 200);
    });
    return out;
  }

  // Anything carrying the token (it shouldn't, but URLs inside responses can) is removed.
  function scrubToken(value, token) {
    if (!token) return value;
    var text = JSON.stringify(value);
    if (text.indexOf(token) === -1) return value;
    return JSON.parse(text.split(token).join(''));
  }

  // ---- RPC over postMessage ---------------------------------------------------------------------

  // opts: {post(msg), onCall(method, args) -> Promise, timeoutMs, maxPending, maxBytes}
  function Rpc(opts) {
    this.opts = opts;
    this.seq = 0;
    this.pending = {};
    this.count = 0;
    this.closed = false;
  }

  Rpc.prototype.size = function (msg) {
    try { return JSON.stringify(msg).length; } catch (e) { return Infinity; }
  };

  Rpc.prototype.call = function (method, args) {
    var self = this;
    if (this.closed) return Promise.reject(new Error('Plugin is not running'));
    if (this.count >= (this.opts.maxPending || LIMITS.maxPending)) return Promise.reject(new Error('Plugin is busy'));
    return new Promise(function (resolve, reject) {
      var id = ++self.seq;
      var timer = setTimeout(function () {
        if (!self.pending[id]) return;
        delete self.pending[id];
        self.count--;
        reject(new Error('Plugin did not answer in time'));
      }, self.opts.timeoutMs || LIMITS.callTimeoutMs);
      self.pending[id] = { resolve: resolve, reject: reject, timer: timer };
      self.count++;
      self.opts.post({ pl: 1, t: 'call', id: id, m: method, a: args || [] });
    });
  };

  // Handles one message from the plugin. Returns false for anything malformed or oversized.
  Rpc.prototype.receive = function (msg) {
    var self = this;
    if (this.closed || !msg || msg.pl !== 1 || typeof msg.t !== 'string') return false;
    if (this.size(msg) > (this.opts.maxBytes || LIMITS.maxMessageBytes)) return false;
    if (msg.t === 'res') {
      var p = this.pending[msg.id];
      if (!p) return false;
      delete this.pending[msg.id];
      this.count--;
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.v);
      else p.reject(new Error(str(msg.e, 200) || 'Plugin error'));
      return true;
    }
    if (msg.t === 'call') {
      if (typeof msg.m !== 'string' || !Array.isArray(msg.a)) return false;
      var reply = function (ok, v) {
        if (self.closed) return;
        self.opts.post(ok ? { pl: 1, t: 'res', id: msg.id, ok: true, v: v === undefined ? null : v }
          : { pl: 1, t: 'res', id: msg.id, ok: false, e: str((v && v.message) || v, 200) });
      };
      var run;
      try { run = Promise.resolve(this.opts.onCall(msg.m, msg.a)); } catch (e) { run = Promise.reject(e); }
      run.then(function (v) { reply(true, v); }, function (e) { reply(false, e); });
      return true;
    }
    if (msg.t === 'ready' && this.opts.onReady) {
      this.opts.onReady(msg.info || {});
      return true;
    }
    return false;
  };

  Rpc.prototype.close = function () {
    var self = this;
    this.closed = true;
    Object.keys(this.pending).forEach(function (id) {
      clearTimeout(self.pending[id].timer);
      self.pending[id].reject(new Error('Plugin stopped'));
    });
    this.pending = {};
    this.count = 0;
  };

  // ---- One plugin at runtime --------------------------------------------------------------------

  // The frame: opaque origin (sandbox without allow-same-origin), no network (connect-src 'none'),
  // no images/styles, no forms/popups/navigation of the app. The plugin's code is inlined.
  function buildSrcdoc(sdkSource, pluginSource) {
    var csp = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; " +
      "style-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
    var esc = function (s) { return String(s).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--'); };
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '"></head><body>' +
      '<script>' + esc(sdkSource) + '</script><script>' + esc(pluginSource) + '</script></body></html>';
  }

  // bundle: {manifest, source, hash}; deps: {grants, sdkSource, createFrame?, plex, storage, toast, sheet, http}
  function Runtime(bundle, deps) {
    this.manifest = bundle.manifest;
    this.id = bundle.manifest.id;
    this.source = bundle.source;
    this.hash = bundle.hash || null;
    this.deps = deps;
    this.frame = null;
    this.rpc = null;
    this.ready = null;
    this.info = null;
    this.failures = 0;
    this.disabled = false;
    this.lastUsed = 0;
    this.idleTimer = null;
  }

  Runtime.prototype.grant = function () {
    return this.deps.grants.get(this.id);
  };

  Runtime.prototype.start = function () {
    var self = this;
    if (this.ready) return this.ready;
    this.ready = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('Plugin did not start')); }, LIMITS.readyTimeoutMs);
      var frame = (self.deps.createFrame || createIframe)(buildSrcdoc(self.deps.sdkSource, self.source), function (msg) {
        self.rpc.receive(msg);
      });
      self.frame = frame;
      self.rpc = new Rpc({
        post: function (m) { frame.post(m); },
        onCall: function (method, args) { return self.capability(method, args); },
        onReady: function (info) {
          clearTimeout(timer);
          if (info.id !== self.id || (info.apiVersion || 1) > API_VERSION) {
            reject(new Error('Plugin identity or API version mismatch'));
            return;
          }
          self.info = info;
          resolve(info);
        },
      });
    });
    this.ready.then(null, function () { self.stop(); });
    return this.ready;
  };

  Runtime.prototype.stop = function () {
    if (this.rpc) this.rpc.close();
    if (this.frame) this.frame.destroy();
    this.frame = this.rpc = this.ready = this.info = null;
    clearTimeout(this.idleTimer);
  };

  // Calls a hook, starting the frame on first use and unloading it after a quiet spell.
  Runtime.prototype.call = function (method, args) {
    var self = this;
    if (this.disabled) return Promise.reject(new Error('Plugin disabled after repeated errors'));
    this.lastUsed = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(function () { self.stop(); }, LIMITS.idleUnloadMs);
    if (this.deps.beforeStart) this.deps.beforeStart(this);
    return this.start().then(function (info) {
      if (method !== 'invoke' && info.hooks.indexOf(method) === -1) return null;
      return self.rpc.call(method, args);
    }).then(function (v) {
      self.failures = 0;
      return v;
    }, function (e) {
      self.failures++;
      if (self.failures >= LIMITS.maxFailures) {
        self.disabled = true;
        self.stop();
        if (self.deps.toast) self.deps.toast((self.manifest.title || self.id) + ' was turned off after repeated errors');
      }
      throw e;
    });
  };

  // Everything a plugin can ask the host to do. Unknown or ungranted requests are refused.
  Runtime.prototype.capability = function (method, args) {
    var d = this.deps;
    var rec = this.grant();
    var self = this;
    if (method === 'plex.token' && hasGrant(rec, 'plex:token') && !this.tokenLogged) {
      // which plugin holds the sign-in is logged; the token itself never is
      this.tokenLogged = true;
      if (PL.log) PL.log('Plex sign-in handed to plugin', this.id);
    }
    switch (method) {
      case 'plex.get': {
        if (!hasGrant(rec, 'plex:read')) throw new Error('permission_denied: plex:read');
        if (!plexPathAllowed(args[0])) throw new Error('That Plex path is not available to plugins');
        return d.plex.get(args[0], cleanParams(args[1])).then(function (mc) { return scrubToken(mc, d.plex.token()); });
      }
      case 'plex.token':
        if (!hasGrant(rec, 'plex:token')) throw new Error('permission_denied: plex:token');
        return d.plex.token();
      case 'storage.get': {
        var all = d.storage.get('plugin.' + this.id, {}) || {};
        return all[str(args[0], 64)];
      }
      case 'storage.set': {
        var store = d.storage.get('plugin.' + this.id, {}) || {};
        store[str(args[0], 64)] = args[1];
        if (JSON.stringify(store).length > LIMITS.storageBytes) throw new Error('Plugin storage is full');
        d.storage.set('plugin.' + this.id, store);
        return true;
      }
      case 'toast':
        d.toast(str(args[0], 120));
        return true;
      case 'sheet': {
        var rows = sanitizeList(args[1], 20);
        d.sheet(str(args[0], 60), rows.map(function (r) {
          return { label: r.label, sub: r.value, action: function () { self.call('invoke', [r.id]).then(null, function () {}); } };
        }));
        return true;
      }
      case 'net.fetch': {
        var url = String(args[0] || '');
        if (!originAllowed(rec, url)) throw new Error('permission_denied: network ' + (originOf(url) || 'invalid address'));
        var o = args[1] || {};
        var method2 = /^(GET|POST|PUT|DELETE)$/.test(o.method) ? o.method : 'GET';
        var headers = {};
        Object.keys(o.headers || {}).forEach(function (k) {
          if (/^(content-type|accept|authorization|x-api-key)$/i.test(k)) headers[k] = String(o.headers[k]).slice(0, 2048);
        });
        return d.http(method2, url, { headers: headers, body: o.body == null ? null : String(o.body), timeout: 10000, text: true })
          .then(function (text) {
            text = String(text == null ? '' : text);
            if (text.length > LIMITS.fetchBytes) throw new Error('Response too large');
            return text;
          });
      }
      case 'service':
        if (!hasGrant(rec, 'service') || !d.service) throw new Error('permission_denied: service');
        return d.service(this.manifest.service, str(args[0], 40), args[1] || {});
      default:
        throw new Error('Unknown capability ' + method);
    }
  };

  // ---- Phase 1 adapter: an external plugin as a bundled-style definition ---------------------------

  // Screen models from a plugin: limited, plain data; functions arrive as ids and become closures.
  function sanitizeModel(raw, rec, rt) {
    if (!raw || typeof raw !== 'object' || ['shelves', 'grid', 'page'].indexOf(raw.type) === -1) return null;
    var toItems = function (list, max) {
      var s = sanitizeShelf({ title: 'x', items: (list || []).slice(0, max) }, rec);
      return s ? s.items : [];
    };
    var m = { type: raw.type, title: str(raw.title, 80) };
    if (raw.type === 'grid') m.items = toItems(raw.items, 500).map(function (it) { return itemFor(it, rt); });
    if (raw.type === 'page') {
      m.eyebrow = str(raw.eyebrow, 60);
      m.subtitle = str(raw.subtitle, 120);
      m.summary = str(raw.summary, 600);
      m.art = raw.art && typeof raw.art === 'object' ? (sanitizeImage(raw.art, rec) || {}).plex || null : null;
      m.actions = sanitizeList(raw.actions, 5).map(function (a) {
        return { label: a.label, icon: a.icon, run: function () { return invokeModel(rt, a.id); } };
      });
    }
    m.shelves = (Array.isArray(raw.shelves) ? raw.shelves : []).slice(0, 8).map(function (s) {
      var clean = sanitizeShelf(s, rec);
      return clean ? { title: clean.title, kind: clean.kind, items: clean.items.map(function (it) { return itemFor(it, rt); }) } : null;
    }).filter(Boolean);
    return m;
  }

  // An option that may answer with a new screen model.
  function invokeModel(rt, id, arg) {
    return rt.call('invoke', arg === undefined ? [id] : [id, arg]).then(function (v) { return sanitizeModel(v, rt.grant(), rt); });
  }

  // A sanitised plugin item as a card item for Plex Lite's components.
  function itemFor(it, rt) {
    return {
      ratingKey: it.ratingKey || 'plugin:' + rt.id + ':' + it.key,
      type: it.ratingKey ? 'movie' : 'plugin',
      title: it.title,
      year: it.subtitle,
      thumb: it.image ? (it.image.plex || it.image.url) : null,
      viewOffset: it.progress ? Math.round(it.progress * 1000) : 0,
      duration: it.progress ? 1000 : 0,
      onSelect: it.select ? function () { return invokeModel(rt, it.select); } : null,
    };
  }

  function toDefinition(rt, deps) {
    var rec = function () { return rt.grant(); };
    var shelfItems = function (shelf) {
      if (!shelf) return null;
      return {
        title: shelf.title,
        kind: shelf.kind,
        items: shelf.items.map(function (it) { return itemFor(it, rt); }),
        // OK on an item: the plugin's own option (may open a screen model), else Plex details
        onSelect: function (item) {
          if (item.onSelect) {
            item.onSelect().then(function (m) {
              if (m && PL.screens && PL.screens.pluginScreen) PL.app.push(PL.screens.pluginScreen(m, { title: m.title }));
            }, function (e) { if (PL.toast) PL.toast(String((e && e.message) || e)); });
          } else if (/^\d+$/.test(String(item.ratingKey)) && PL.screens) {
            PL.app.push(PL.screens.details(item));
          }
        },
      };
    };
    var def = {
      id: rt.id,
      name: rt.manifest.title || rt.id,
      version: rt.manifest.version,
      apiVersion: API_VERSION,
      external: true,
      description: rt.manifest.description,
      searchRows: function (q) {
        return rt.call('searchRows', [str(q, 100)]).then(function (s) { return shelfItems(sanitizeShelf(s, rec())); });
      },
      shelfRows: function (section) {
        var sec = { key: section && section.key, type: section && section.type, title: section && section.title };
        return rt.call('shelfRows', [sec]).then(function (list) {
          return (Array.isArray(list) ? list : []).slice(0, 3).map(function (s) { return shelfItems(sanitizeShelf(s, rec())); })
            .filter(Boolean);
        });
      },
      actions: function (item) {
        var projected = hasGrant(rec(), 'plex:read') ? projectItem(item) : { type: item && item.type };
        return rt.call('actions', [projected]).then(function (list) {
          return sanitizeList(list, 4).map(function (a) {
            return { label: a.label, icon: a.icon, run: function () { return rt.call('invoke', [a.id, projected]); } };
          });
        });
      },
      settingsRows: function () {
        return rt.call('settingsRows', []).then(function (list) {
          return sanitizeList(list, 10).map(function (a) {
            return { label: a.label, value: a.value, action: function () { return rt.call('invoke', [a.id]); } };
          });
        });
      },
      // Tabs need the "tabs" grant; the list comes from the manifest so it's known without starting
      // the plugin (max 2 per plugin; the registry caps plugin tabs overall).
      tabs: function () {
        if (!hasGrant(rec(), 'tabs')) return [];
        return (rt.manifest.tabs || []).slice(0, 2);
      },
      screen: function (tabId) {
        if (!hasGrant(rec(), 'tabs')) return Promise.resolve(null);
        return rt.call('screen', [str(tabId, 40)]).then(function (m) { return sanitizeModel(m, rec(), rt); });
      },
    };
    if (deps && deps.onDefinition) deps.onDefinition(def);
    return def;
  }

  // ---- Browser glue: frames, consent, loaders -----------------------------------------------------

  // A hidden sandboxed iframe; onMessage only receives messages from this frame.
  function createIframe(srcdoc, onMessage) {
    var holder = document.getElementById('plugin-frames');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'plugin-frames';
      holder.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden';
      document.body.appendChild(holder);
    }
    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.style.cssText = 'width:0;height:0;border:0';
    var listener = function (e) {
      if (e.source === iframe.contentWindow) onMessage(e.data);
    };
    window.addEventListener('message', listener);
    iframe.srcdoc = srcdoc;
    holder.appendChild(iframe);
    return {
      post: function (m) { if (iframe.contentWindow) iframe.contentWindow.postMessage(m, '*'); },
      destroy: function () {
        window.removeEventListener('message', listener);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      },
    };
  }

  // "Hello Shelf wants to: …" — resolves true (allow) or false (don't allow).
  host.consent = function (manifest, perms) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) {
        if (done) return;
        done = true;
        resolve(v);
      };
      var rows = perms.map(function (p) {
        return { label: p.text, sub: p.risk === 'high' ? 'Sensitive' : '', action: function () {} };
      });
      PL.app.push(PL.screens.sheet([
        { heading: (manifest.title || manifest.id) + ' ' + (manifest.version || '') + ' wants to', rows: rows },
        { heading: '', rows: [
          { label: 'Allow', action: function () { PL.app.pop(); finish(true); } },
          { label: 'Don\'t allow', action: function () { PL.app.pop(); finish(false); } },
        ] },
      ], { closeOnSelect: false, focus: perms.length }));
    });
  };

  // Desktop/dev loader: plugins unpacked under examples/plugins/<dir>/ (listed in index.json).
  host.devLoader = function (base) {
    base = base || 'examples/plugins/';
    var get = function (path) { return PL.http('GET', base + path, { text: true }); };
    return {
      list: function () {
        return get('index.json').then(function (t) { return JSON.parse(t); });
      },
      read: function (dir) {
        return get(dir + '/appinfo.json').then(function (t) {
          var manifest = JSON.parse(t);
          var meta = manifest.plexlitePlugin || {};
          return get(dir + '/' + meta.entry).then(function (source) {
            return { manifest: normalizeManifest(manifest), source: source, hash: null };
          });
        });
      },
    };
  };

  // TV loader: Plex Lite's own JS service reads installed plugin packages (WAM only lets a web app
  // read its own folder, so the host can't read another app's files itself). Service methods
  // listPlugins / readPlugin are specified in docs/PLUGINS-v2-design.md (reference code in
  // service-lib/plugin-loader.js).
  host.serviceLoader = function (callService) {
    return {
      list: function () { return callService('listPlugins', {}).then(function (r) { return r.plugins || []; }); },
      read: function (id) {
        return callService('readPlugin', { id: id }).then(function (r) {
          return { manifest: normalizeManifest(r.appinfo), source: r.source, hash: r.sha256 };
        });
      },
    };
  };

  // appinfo.json of a plugin package -> the manifest the host uses.
  function normalizeManifest(appinfo) {
    var meta = appinfo.plexlitePlugin || {};
    return {
      id: appinfo.id,
      title: appinfo.title,
      version: appinfo.version,
      apiVersion: meta.apiVersion || 1,
      entry: meta.entry,
      permissions: meta.permissions || [],
      tabs: (Array.isArray(meta.tabs) ? meta.tabs : []).filter(function (t) { return t && t.id && t.title; })
        .map(function (t) { return { id: str(t.id, 40), title: str(t.title, 18) }; }),
      service: meta.service || null,
      description: meta.description || appinfo.appDescription || '',
    };
  }

  host.runtimes = {};
  host.definitions = {};

  function liveFrames() {
    return Object.keys(host.runtimes).map(function (k) { return host.runtimes[k]; }).filter(function (r) { return r.frame; });
  }

  // Keeps at most LIMITS.maxActiveFrames plugin frames alive (least recently used are unloaded).
  function makeRoom(starting) {
    var live = liveFrames().filter(function (r) { return r !== starting; });
    live.sort(function (a, b) { return a.lastUsed - b.lastUsed; });
    while (live.length >= LIMITS.maxActiveFrames) live.shift().stop();
  }

  // Loads every installed plugin's manifest; plugins with grants become definitions immediately,
  // others wait in host.pending until the user enables them (consent).
  host.start = function (loader, opts) {
    opts = opts || {};
    var grants = new Grants(PL.storage);
    host.grants = grants;
    host.pending = [];
    return loader.list().then(function (ids) {
      return Promise.all(ids.map(function (id) {
        return loader.read(id).then(function (bundle) { return bundle; }, function (e) {
          PL.warn('plugin unreadable', id, e && e.message);
          return null;
        });
      }));
    }).then(function (bundles) {
      return Promise.all(bundles.filter(Boolean).map(function (b) {
        var m = b.manifest;
        if (!m.id || !m.entry || m.apiVersion > API_VERSION || parsePermissions(m).errors.length) {
          PL.warn('plugin skipped', m.id, 'invalid manifest or newer API');
          return null;
        }
        var rt = new Runtime(b, {
          grants: grants,
          sdkSource: opts.sdkSource,
          plex: { get: PL.plex.get, token: function () { return PL.plex.token; } },
          storage: PL.storage,
          toast: PL.toast,
          http: PL.http,
          service: opts.callService ? function (svc, method, params) { return opts.callService(svc, method, params); } : null,
          sheet: function (heading, rows) { PL.app.push(PL.screens.sheet([{ heading: heading, rows: rows }])); },
          beforeStart: makeRoom,
          createFrame: opts.createFrame,
        });
        host.runtimes[m.id] = rt;
        var rec = grants.get(m.id);
        var missing = grants.missing(m.id, m, b.hash);
        if (rec && !rec.denied && !missing.length) return host.activate(m.id);
        host.pending.push(m.id);
        return null;
      }));
    }).then(function () { return host.list(); });
  };

  host.activate = function (id) {
    var rt = host.runtimes[id];
    var def = toDefinition(rt, null);
    host.definitions[id] = def;
    if (PL.plugins && PL.plugins.register) {
      try { PL.plugins.register(def); } catch (e) { PL.warn('plugin register failed', id, e && e.message); }
    }
    return def;
  };

  // Asks the user (first enable, or an update adding permissions), then activates.
  host.enable = function (id) {
    var rt = host.runtimes[id];
    if (!rt) return Promise.reject(new Error('No such plugin'));
    var m = rt.manifest;
    var missing = host.grants.missing(id, m, rt.hash);
    var ask = missing.length ? host.consent(m, missing) : Promise.resolve(true);
    return ask.then(function (ok) {
      var prev = host.grants.get(id) || { granted: [], origins: [] };
      if (!ok) {
        host.grants.set(id, { version: m.version, hash: rt.hash, granted: prev.granted || [], origins: prev.origins || [], denied: true });
        return null;
      }
      var granted = parsePermissions(m).list.map(function (p) { return p.id; });
      host.grants.set(id, { version: m.version, hash: rt.hash, granted: granted, origins: prev.origins || [], denied: false });
      if (granted.indexOf('plex:token') !== -1 && PL.log) PL.log('Plex sign-in granted to plugin', id);
      host.pending = host.pending.filter(function (p) { return p !== id; });
      return host.activate(id);
    });
  };

  // An address the user typed for a "network:user" plugin (e.g. their Overseerr server).
  host.allowOrigin = function (id, url) {
    var rec = host.grants.get(id);
    var o = originOf(url);
    if (!rec || !o || rec.granted.indexOf('network:user') === -1) return false;
    if ((rec.origins || []).indexOf(o) === -1) rec.origins = (rec.origins || []).concat([o]);
    host.grants.set(id, rec);
    return true;
  };

  // Turns a plugin off and revokes everything it was granted (it asks again if re-enabled).
  host.revoke = function (id) {
    var rt = host.runtimes[id];
    if (rt) { rt.stop(); rt.disabled = false; rt.failures = 0; rt.tokenLogged = false; }
    delete host.definitions[id];
    if (PL.plugins && PL.plugins.unregister) PL.plugins.unregister(id);
    if (host.grants) host.grants.remove(id);
    if (host.pending.indexOf(id) === -1) host.pending.push(id);
    if (PL.log) PL.log('plugin access revoked', id);
  };
  host.disable = host.revoke;

  // Plugins that hold the Plex sign-in (shown in Settings → Plugins).
  host.tokenHolders = function () {
    return Object.keys(host.runtimes).filter(function (id) { return hasGrant(host.grants && host.grants.get(id), 'plex:token'); });
  };

  host.list = function () {
    return Object.keys(host.runtimes).map(function (id) {
      var rt = host.runtimes[id];
      var rec = host.grants && host.grants.get(id);
      return {
        id: id, title: rt.manifest.title, version: rt.manifest.version, description: rt.manifest.description,
        active: !!host.definitions[id], disabled: rt.disabled,
        permissions: parsePermissions(rt.manifest).list,
        granted: rec && !rec.denied ? rec.granted.slice() : [],
        holdsToken: hasGrant(rec, 'plex:token'),
      };
    });
  };

  // The SDK is not loaded into the app page; its source is inlined into each plugin frame.
  host.boot = function (loader, opts) {
    opts = opts || {};
    return PL.http('GET', 'js/plugin-sdk.js', { text: true }).then(function (sdk) {
      opts.sdkSource = sdk;
      return host.start(loader, opts);
    });
  };

  // Luna call from the app page (PalmServiceBridge), e.g. to Plex Lite's core service.
  host.luna = function (uri, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof PalmServiceBridge === 'undefined') { reject(new Error('Not on the TV')); return; }
      var bridge = new PalmServiceBridge();
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('No answer from ' + uri)); } }, timeoutMs || 8000);
      host.bridges = (host.bridges || []).concat([bridge]); // keep a reference until it answers
      bridge.onservicecallback = function (msg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        host.bridges.splice(host.bridges.indexOf(bridge), 1);
        var r;
        try { r = JSON.parse(msg); } catch (e) { r = { returnValue: false, errorText: 'Bad reply' }; }
        if (r.returnValue) resolve(r);
        else reject(new Error(r.errorText || 'Service error'));
      };
      bridge.call(uri, JSON.stringify(params || {}));
    });
  };

  var CORE = 'luna://com.bednal.plexlite.service/';

  // Starts the host for the app: dev examples with ?plugins=dev on a desktop, installed plugins
  // (through the core service) on the TV, nothing elsewhere. Never rejects.
  host.autoStart = function () {
    var dev = typeof location !== 'undefined' && /[?&]plugins=dev\b/.test(location.search);
    var onTv = typeof PalmServiceBridge !== 'undefined';
    if (!dev && !onTv) return Promise.resolve([]);
    var loader = dev ? host.devLoader() : host.serviceLoader(function (method, params) { return host.luna(CORE + method, params); });
    host.booted = host.boot(loader, {
      callService: function (svc, method, params) {
        if (!svc) return Promise.reject(new Error('This plugin has no service'));
        return host.luna('luna://' + svc + '/' + method, params, 25000);
      },
    }).then(null, function (e) {
      PL.warn('plugin host', e && e.message);
      return [];
    });
    return host.booted;
  };

  // Internals for tests.
  host._internals = {
    API_VERSION: API_VERSION, originOf: originOf, parsePermissions: parsePermissions, Grants: Grants, hasGrant: hasGrant,
    originAllowed: originAllowed, projectItem: projectItem, sanitizeShelf: sanitizeShelf, sanitizeList: sanitizeList,
    plexPathAllowed: plexPathAllowed, cleanParams: cleanParams, scrubToken: scrubToken, Rpc: Rpc, Runtime: Runtime,
    sanitizeModel: sanitizeModel,
    buildSrcdoc: buildSrcdoc, toDefinition: toDefinition, normalizeManifest: normalizeManifest,
  };
})();
