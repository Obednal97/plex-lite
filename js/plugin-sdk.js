// Plugin SDK: runs INSIDE an external plugin's sandboxed iframe (opaque origin, CSP-locked). It
// gives the plugin the same register()/hook/ctx shape as bundled Phase 1 plugins, but every ctx
// call is an asynchronous request to the host over postMessage. Functions (action.run, row.action,
// item.onSelect) never cross the boundary: they stay here under ids the host can invoke.
'use strict';

(function () {
  var pending = {};
  var seq = 0;
  var def = null;
  var fns = {};
  var fnOrder = [];
  var MAX_FNS = 500;

  function post(msg) {
    msg.pl = 1;
    window.parent.postMessage(msg, '*');
  }

  function callHost(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      post({ t: 'call', id: id, m: method, a: args || [] });
    });
  }

  function keep(fn) {
    if (typeof fn !== 'function') return null;
    var id = 'f' + (++seq);
    fns[id] = fn;
    fnOrder.push(id);
    if (fnOrder.length > MAX_FNS) delete fns[fnOrder.shift()];
    return id;
  }

  var ctx = {
    plex: {
      get: function (path, params) { return callHost('plex.get', [path, params || {}]); },
    },
    // Only answers if the user granted "plex:token" (use your Plex sign-in).
    plexToken: function () { return callHost('plex.token', []); },
    storage: {
      get: function (key) { return callHost('storage.get', [key]); },
      set: function (key, value) { return callHost('storage.set', [key, value]); },
    },
    toast: function (message) { return callHost('toast', [message]); },
    // Network goes through the host, which enforces the granted origins (the frame's CSP blocks all
    // direct connections).
    fetch: function (url, opts) { return callHost('net.fetch', [url, opts || {}]); },
    sheet: function (heading, rows) {
      return callHost('sheet', [heading, (rows || []).map(function (r) { return { label: r.label, sub: r.sub, id: keep(r.run) }; })]);
    },
    service: function (method, params) { return callHost('service', [method, params || {}]); },
  };

  function wrapItem(it) {
    var out = {};
    Object.keys(it || {}).forEach(function (k) {
      if (k === 'onSelect') out.select = keep(it.onSelect);
      else if (typeof it[k] !== 'function') out[k] = it[k];
    });
    return out;
  }

  function wrapShelf(s) {
    if (!s) return null;
    return { title: s.title, kind: s.kind, items: (s.items || []).map(wrapItem) };
  }

  // Screen models (tabs): functions become ids, recursively for items/actions/shelves.
  function wrapModel(m) {
    if (!m || typeof m !== 'object') return null;
    var out = { type: m.type, title: m.title, eyebrow: m.eyebrow, subtitle: m.subtitle, summary: m.summary, art: m.art };
    if (m.items) out.items = m.items.map(wrapItem);
    if (m.shelves) out.shelves = m.shelves.map(wrapShelf);
    if (m.actions) out.actions = wrapList(m.actions, 'run');
    return out;
  }

  function wrapList(list, fnKey) {
    return (list || []).map(function (a) {
      var out = { label: a.label, icon: a.icon, value: a.value };
      out.id = keep(a[fnKey]);
      return out;
    });
  }

  var hooks = {
    searchRows: function (q) { return Promise.resolve(def.searchRows(q, ctx)).then(wrapShelf); },
    shelfRows: function (section) {
      return Promise.resolve(def.shelfRows(section, ctx)).then(function (list) {
        return (list || []).map(wrapShelf);
      });
    },
    actions: function (item) { return Promise.resolve(def.actions(item, ctx)).then(function (l) { return wrapList(l, 'run'); }); },
    settingsRows: function () { return Promise.resolve(def.settingsRows(ctx)).then(function (l) { return wrapList(l, 'action'); }); },
    screen: function (tabId) { return Promise.resolve(def.screen(tabId, ctx)).then(wrapModel); },
  };

  // Synchronous throws in plugin code become rejections, so the host always gets an answer.
  function handleCall(msg) {
    var run;
    try {
      if (msg.m === 'invoke') {
        var fn = fns[msg.a[0]];
        // an option may answer with a new screen model to open
        run = fn ? Promise.resolve(fn(msg.a[1], ctx)).then(function (v) { return v && v.type ? wrapModel(v) : null; })
          : Promise.reject(new Error('That option has expired'));
      } else if (hooks[msg.m] && def && typeof def[msg.m] === 'function') {
        run = hooks[msg.m].apply(null, msg.a || []);
      } else {
        run = Promise.reject(new Error('Unknown hook ' + msg.m));
      }
    } catch (e) {
      run = Promise.reject(e);
    }
    run.then(function (v) {
      post({ t: 'res', id: msg.id, ok: true, v: v === undefined ? null : v });
    }, function (e) {
      post({ t: 'res', id: msg.id, ok: false, e: String((e && e.message) || e) });
    });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.pl !== 1) return;
    if (d.t === 'res' && pending[d.id]) {
      var p = pending[d.id];
      delete pending[d.id];
      if (d.ok) p.resolve(d.v);
      else p.reject(new Error(d.e || 'Host refused'));
    } else if (d.t === 'call') {
      handleCall(d);
    }
  });

  window.PlexLitePlugin = {
    apiVersion: 1,
    register: function (d) {
      def = d;
      post({
        t: 'ready', id: 0,
        info: {
          id: d.id, name: d.name, version: d.version, apiVersion: d.apiVersion || 1,
          hooks: Object.keys(hooks).filter(function (h) { return typeof d[h] === 'function'; }),
          tabs: (Array.isArray(d.tabs) ? d.tabs : []).slice(0, 2).map(function (t) { return { id: String(t.id), title: String(t.title) }; }),
        },
      });
    },
  };
})();
