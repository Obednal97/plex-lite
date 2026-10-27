// Plugins, Phase 1: bundled, reviewed plugins (plugins/<id>/plugin.js). See docs/PLUGINS.md.
//
// A plugin calls PL.plugins.register(def). Every hook is optional:
//   def.settingsRows(ctx)        -> [{label, value, action}]                 rows in Settings
//   def.searchRows(q, ctx)       -> Promise<shelf | [shelf] | null>          shelves after Search's own
//   def.shelfRows(section, ctx)  -> Promise<[shelf]>                         shelves on a library's Recommended
//   def.actions(item, ctx)       -> [{label, icon?, run()}]                  details pills + hold-OK menu
//   def.onSelect(item, ctx)      OK on an item that came from one of its shelves
//   def.services                 [luna service ids] bundled in plugins/<id>/service/
//   def.tabs                     [{id, title}] tabs it adds (max 2 plugin tabs in total)
//   def.screen(tabId, ctx)       -> Promise<model> what a tab shows (rendered by Plex Lite, see
//                                   js/screens/plugin-screen.js): {type: 'shelves'|'grid'|'page', …}
// A shelf is {id, title, kind: 'poster'|'wide', items, makeCard?, onSelect?}.
// External plugins (separately installed, sandboxed; js/plugin-host.js) register definitions with
// def.external = true whose hooks are all asynchronous.
//
// The host functions below are what screens call. Each one isolates every plugin (try/catch, plus a
// timeout for promises): a broken plugin loses its own rows and is logged, the screen carries on.
'use strict';

(function () {
  var plugins = PL.plugins = {};
  var defs = [];
  var bridges = [];
  var TIMEOUT_MS = 8000;
  var ID_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/;
  var MAX_TABS = 2;

  // ---- Registry, enable/disable -----------------------------------------------------------------

  function disabledList() { return PL.storage.get('plugins.disabled', []) || []; }

  plugins.isEnabled = function (id) { return disabledList().indexOf(id) === -1; };

  plugins.setEnabled = function (id, on) {
    var list = disabledList().filter(function (x) { return x !== id; });
    if (!on) list.push(id);
    PL.storage.set('plugins.disabled', list);
  };

  plugins.register = function (def) {
    var problem = !def ? 'no definition'
      : !ID_RE.test(String(def.id || '')) ? 'bad id'
      : !def.name ? 'no name'
      : !def.version ? 'no version'
      : def.apiVersion !== 1 ? 'unsupported apiVersion ' + def.apiVersion
      : defs.some(function (d) { return d.id === def.id; }) ? 'duplicate id'
      : null;
    if (problem) {
      PL.warn('plugin rejected (' + (def && def.id) + '): ' + problem);
      return false;
    }
    def.ctx = def.external ? { id: def.id } : makeCtx(def);
    defs.push(def);
    return true;
  };

  plugins.unregister = function (id) {
    defs = defs.filter(function (d) { return d.id !== id; });
  };

  // [{id, name, version, enabled, description}]
  plugins.list = function () {
    return defs.map(function (d) {
      return { id: d.id, name: d.name, version: d.version, description: d.description || '', enabled: plugins.isEnabled(d.id), external: !!d.external };
    });
  };

  function active() { return defs.filter(function (d) { return plugins.isEnabled(d.id); }); }

  function find(id) { return defs.filter(function (d) { return d.id === id; })[0]; }

  // ---- Failure isolation -------------------------------------------------------------------------

  function safe(def, hook, fallback, fn) {
    try {
      return fn();
    } catch (err) {
      PL.warn('plugin ' + def.id + ' ' + hook + ' failed: ' + (err && err.message));
      return fallback;
    }
  }

  function safeAsync(def, hook, fn) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        PL.warn('plugin ' + def.id + ' ' + hook + ' timed out');
        resolve(null);
      }, TIMEOUT_MS);
      var finish = function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      var p = safe(def, hook, null, fn);
      if (!p || typeof p.then !== 'function') return finish(p);
      p.then(finish, function (err) {
        PL.warn('plugin ' + def.id + ' ' + hook + ' failed: ' + (err && err.message));
        finish(null);
      });
    });
  }

  // Tags each item with its plugin and wraps onSelect so screens can just call shelf.onSelect(item).
  function normalizeShelves(def, value) {
    var list = !value ? [] : Array.isArray(value) ? value : [value];
    return list.filter(function (s) { return s && s.items && s.items.length; }).map(function (s) {
      var own = s.onSelect;
      s.id = def.id + ':' + (s.id || 'shelf');
      s.kind = s.kind === 'wide' ? 'wide' : 'poster';
      s.items.forEach(function (it) { it.plugin = def.id; });
      s.onSelect = function (item) {
        safe(def, 'onSelect', null, function () {
          if (own) own(item, def.ctx);
          else if (def.onSelect) def.onSelect(item, def.ctx);
        });
      };
      return s;
    });
  }

  function flatten(lists) {
    return lists.reduce(function (all, l) { return all.concat(l || []); }, []);
  }

  // ---- Host functions (called by screens) -------------------------------------------------------

  plugins.searchRows = function (q) {
    return Promise.all(active().filter(function (d) { return d.searchRows; }).map(function (d) {
      return safeAsync(d, 'searchRows', function () { return d.searchRows(q, d.ctx); })
        .then(function (v) { return safe(d, 'searchRows', [], function () { return normalizeShelves(d, v); }); });
    })).then(flatten);
  };

  plugins.hasSearch = function () {
    return active().some(function (d) { return !!d.searchRows; });
  };

  // section: the Plex library section object ({key, type, title})
  plugins.shelfRows = function (section) {
    return Promise.all(active().filter(function (d) { return d.shelfRows; }).map(function (d) {
      return safeAsync(d, 'shelfRows', function () { return d.shelfRows(section, d.ctx); })
        .then(function (v) { return safe(d, 'shelfRows', [], function () { return normalizeShelves(d, v); }); });
    })).then(flatten);
  };

  function cleanActions(d, list) {
    return (list || []).filter(function (a) { return a && a.label && a.run; }).map(function (a) {
      return { label: a.label, icon: a.icon, run: function () { safe(d, 'action', null, function () { a.run(); }); } };
    });
  }

  // [{label, icon?, run()}] for a Plex item (details pills, hold-OK menu). Bundled plugins answer at
  // once; if an external plugin is active the result is a Promise (callers handle both).
  plugins.actions = function (item) {
    var withActions = active().filter(function (d) { return d.actions; });
    var bundled = flatten(withActions.filter(function (d) { return !d.external; }).map(function (d) {
      return safe(d, 'actions', [], function () { return cleanActions(d, d.actions(item, d.ctx)); });
    }));
    var external = withActions.filter(function (d) { return d.external; });
    if (!external.length) return bundled;
    return Promise.all(external.map(function (d) {
      return safeAsync(d, 'actions', function () { return d.actions(item); }).then(function (l) { return cleanActions(d, l); });
    })).then(function (lists) { return bundled.concat(flatten(lists)); });
  };

  // ---- Tabs (declarative screens) ----------------------------------------------------------------

  // [{plugin, id, title}] — at most MAX_TABS across all plugins, in registration order.
  plugins.tabs = function () {
    var out = [];
    active().forEach(function (d) {
      var list = typeof d.tabs === 'function' ? safe(d, 'tabs', [], function () { return d.tabs(); }) : d.tabs;
      (Array.isArray(list) ? list : []).forEach(function (t) {
        if (out.length >= MAX_TABS || !t || !t.id || !t.title || !d.screen) return;
        out.push({ plugin: d.id, id: String(t.id), title: String(t.title).slice(0, 18) });
      });
    });
    return out;
  };

  // The model a plugin tab shows (null if the plugin failed or timed out).
  plugins.screen = function (pluginId, tabId) {
    var d = find(pluginId);
    if (!d || !d.screen || !plugins.isEnabled(d.id)) return Promise.resolve(null);
    return safeAsync(d, 'screen', function () { return d.screen(tabId, d.ctx); });
  };

  // refresh (optional): lets a plugin ask Settings to redraw after it changed state
  plugins.settingsRows = function (refresh) {
    // external plugins' rows are async; they live in their own sheet (Settings → Plugins → the plugin)
    return flatten(active().filter(function (d) { return d.settingsRows && !d.external; }).map(function (d) {
      d.ctx.refreshSettings = refresh || function () {};
      return safe(d, 'settingsRows', [], function () { return d.settingsRows(d.ctx) || []; });
    }));
  };

  // OK on an item that came from a plugin shelf (Search keeps plain items)
  plugins.select = function (item) {
    var d = item && find(item.plugin);
    if (d && d.onSelect && plugins.isEnabled(d.id)) safe(d, 'onSelect', null, function () { d.onSelect(item, d.ctx); });
  };

  // ---- ctx: what a plugin may use ---------------------------------------------------------------

  function makeCtx(def) {
    var prefix = 'plugin.' + def.id + '.';
    var tag = '[' + def.id + ']';
    return {
      id: def.id,
      ui: {
        el: PL.el,
        makeCard: function (item, kind, geo) { return PL.ui.makeCard(item, kind, geo); },
        badge: function (node, cls, text) {
          var inner = node.querySelector('.card-inner');
          if (inner) inner.appendChild(PL.el('div', cls, text));
          return node;
        },
        icon: function (name) { return PL.ui.icon(name); },
      },
      sheet: function (sections, opts) { PL.app.push(PL.screens.sheet(sections, opts)); },
      textEntry: function (title, initial, placeholder, onDone) {
        PL.app.push(PL.screens.textEntry(title, initial, placeholder, onDone));
      },
      toast: PL.toast,
      log: function () { PL.log.apply(null, [tag].concat([].slice.call(arguments))); },
      warn: function () { PL.warn.apply(null, [tag].concat([].slice.call(arguments))); },
      storage: {
        get: function (k, d) { return PL.storage.get(prefix + k, d); },
        set: function (k, v) { PL.storage.set(prefix + k, v); },
        del: function (k) { PL.storage.del(prefix + k); },
      },
      http: PL.http,
      // explicit so it can be permissioned per plugin later
      plexToken: function () { return PL.plex.token; },
      // Calls one of the plugin's own bundled services (def.services); serviceId defaults to the first.
      service: function (method, params, serviceId) {
        var services = def.services || [];
        var id = serviceId || services[0];
        return new Promise(function (resolve, reject) {
          if (!id || services.indexOf(id) === -1) { reject(new Error(def.name + ' has no such service')); return; }
          if (typeof PalmServiceBridge === 'undefined') { reject(new Error(def.name + ' only works on the TV')); return; }
          var bridge = new PalmServiceBridge();
          bridges.push(bridge);
          var done = false;
          var finish = function () { done = true; clearTimeout(timer); bridges.splice(bridges.indexOf(bridge), 1); };
          var timer = setTimeout(function () {
            if (done) return;
            finish();
            reject(new Error(def.name + ' did not answer'));
          }, 25000);
          bridge.onservicecallback = function (msg) {
            if (done) return;
            finish();
            var r;
            try { r = JSON.parse(msg); } catch (e) { r = { returnValue: false, errorText: 'Bad reply from ' + def.name }; }
            if (r.returnValue) {
              resolve(r);
            } else {
              var err = new Error(r.errorText || def.name + ' error');
              err.code = r.errorCode;
              reject(err);
            }
          };
          bridge.call('luna://' + id + '/' + method, JSON.stringify(params || {}));
        });
      },
    };
  }
})();
