// Plugins, Phase 1: bundled, reviewed plugins (plugins/<id>/plugin.js). See docs/PLUGINS.md.
//
// A plugin calls PL.plugins.register(def). Every hook is optional:
//   def.settingsRows(ctx)        -> [{label, value, action}]                 rows in Settings
//   def.searchRows(q, ctx)       -> Promise<shelf | [shelf] | null>          shelves after Search's own
//   def.searchIdleRows(ctx)      -> Promise<shelf | [shelf] | null>          Search before anything is typed
//   def.shelfRows(section, ctx)  -> Promise<[shelf]>                         shelves on a library's Recommended
//                                   (each plugin's put in as it answers)
//   def.actions(item, ctx)       -> [{label, icon?, run()}] | Promise<[…]>  details pills + hold-OK menu
//                                   (shown at once; a promise's when it settles)
//   def.badges(item, ctx)        -> Promise<[{label, tone?}]>                 keyline badges on a details page
//   def.onSelect(item, ctx)      OK on an item that came from one of its shelves
//   def.onPlayback(event, ctx)   playback events (play, pause, resume, stop, ended, buffering-*), fire-and-forget
//   def.services                 [luna service ids] bundled in plugins/<id>/service/
//   def.web                      true: runs in the web build without its services (its own browser path)
//   def.tabs                     [{id, title}] tabs it adds (max 2 plugin tabs in total)
//   def.screen(tabId, ctx)       -> Promise<model> what a tab shows (rendered by Plex Lite, see
//                                   js/screens/plugin-screen.js): {type: 'shelves'|'grid'|'page', …}
// A shelf is {id, title, kind: 'poster'|'wide', items, makeCard?, onSelect?, at?}. at: on Recommended,
// after that many of the library's own rows (default: after all of them). An item may carry
// badge: {label, tone} for layouts that don't use makeCard (the touch layout).
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

  // Plugins this build can't run, with why (the web build has no webOS background services).
  plugins.unavailable = [];

  plugins.register = function (def) {
    // def.web: the plugin has a browser path of its own and doesn't need its services on the web
    if (PL.isWeb && def && def.services && def.services.length && def.web !== true) {
      plugins.unavailable.push({ id: def.id, name: def.name, reason: 'tv-service' });
      return false;
    }
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
      s.at = typeof s.at === 'number' && s.at >= 0 ? Math.min(50, Math.floor(s.at)) : null;
      s.items.forEach(function (it) {
        it.plugin = def.id;
        if (it.badge) {
          it.badge = it.badge.label ? { label: String(it.badge.label).slice(0, 40), tone: /^[a-z0-9-]{1,16}$/.test(it.badge.tone || '') ? it.badge.tone : '' } : null;
        }
      });
      s.onSelect = function (item) {
        safe(def, 'onSelect', null, function () {
          if (own) own(item, def.ctx);
          else if (def.onSelect) def.onSelect(item, def.ctx);
        });
      };
      return s;
    });
  }

  // a screen's callback for late answers: its failure is the screen's, not the plugin's
  function tell(hook, fn) {
    try { fn(); } catch (err) { PL.warn('plugins ' + hook + ' listener failed: ' + (err && err.message)); }
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

  // Search before anything is typed (shown instead of the blank space next to the keyboard). Only
  // asked when the query is empty, never while typing.
  plugins.searchIdleRows = function () {
    return Promise.all(active().filter(function (d) { return d.searchIdleRows; }).map(function (d) {
      return safeAsync(d, 'searchIdleRows', function () { return d.searchIdleRows(d.ctx); })
        .then(function (v) { return safe(d, 'searchIdleRows', [], function () { return normalizeShelves(d, v); }); });
    })).then(flatten);
  };

  plugins.hasSearchIdle = function () {
    return active().some(function (d) { return !!d.searchIdleRows; });
  };

  // Where plugin rows go among a screen's own rows: extra [{at, row}] (shelf.at: after that many of
  // base, or at the end without it); rows placed at the same point keep their order. -> rows
  plugins.placeRows = function (base, extra) {
    var out = base.map(function (r) { return { row: r, at: null }; });
    extra.forEach(function (x) {
      var at = typeof x.at === 'number' && x.at >= 0 ? Math.min(x.at, base.length) : base.length;
      var i = 0;
      var seen = 0;
      while (i < out.length && (seen < at || (out[i].at != null && out[i].at <= at))) {
        if (out[i].at == null) seen++;
        i++;
      }
      out.splice(i, 0, { row: x.row, at: at });
    });
    return out.map(function (o) { return o.row; });
  };

  // section: the Plex library section object ({key, type, title}). -> Promise of every plugin's
  // shelves, in plugin order. onRows(all, added) (optional) is called as each plugin answers with
  // shelves, so a slow plugin never holds back the others' rows: all is everything so far, in plugin
  // order, added the shelves that just came.
  plugins.shelfRows = function (section, onRows) {
    var slots = [];
    return Promise.all(active().filter(function (d) { return d.shelfRows; }).map(function (d, i) {
      slots[i] = [];
      return safeAsync(d, 'shelfRows', function () { return d.shelfRows(section, d.ctx); })
        .then(function (v) { return safe(d, 'shelfRows', [], function () { return normalizeShelves(d, v); }); })
        .then(function (list) {
          slots[i] = list;
          if (onRows && list.length) tell('shelfRows', function () { onRows(flatten(slots), list); });
          return list;
        });
    })).then(flatten);
  };

  function cleanActions(d, list) {
    return (list || []).filter(function (a) { return a && a.label && a.run; }).map(function (a) {
      return { label: a.label, icon: a.icon, run: function () { safe(d, 'action', null, function () { a.run(); }); } };
    });
  }

  // [{label, icon?, run()}] for a Plex item (details pills, hold-OK menu). Bundled plugins usually
  // answer at once; one that needs a lookup may answer with a Promise, and external plugins always
  // do.
  //   actions(item)          everything, in plugin order: an array when every plugin answered at once,
  //                          else a Promise of it
  //   actions(item, onLate)  what the plugins answered at once (an array, in plugin order) right away,
  //                          and onLate(all) each time a late plugin answers with actions (all:
  //                          everything so far, in plugin order), so one slow plugin never holds back
  //                          the others
  plugins.actions = function (item, onLate) {
    var withActions = active().filter(function (d) { return d.actions; });
    var slots = [];
    var pending = [];
    withActions.forEach(function (d, i) {
      var late = null;
      if (d.external) {
        late = safeAsync(d, 'actions', function () { return d.actions(item); }).then(function (l) { return cleanActions(d, l); });
      } else {
        var got = safe(d, 'actions', [], function () { return d.actions(item, d.ctx); });
        if (got && typeof got.then === 'function') {
          late = safeAsync(d, 'actions', function () { return got; }).then(function (l) { return safe(d, 'actions', [], function () { return cleanActions(d, l); }); });
        } else {
          slots[i] = safe(d, 'actions', [], function () { return cleanActions(d, got); });
          return;
        }
      }
      slots[i] = [];
      pending.push(late.then(function (list) {
        slots[i] = list || [];
        if (onLate && slots[i].length) tell('actions', function () { onLate(flatten(slots)); });
      }));
    });
    if (onLate || !pending.length) return flatten(slots);
    return Promise.all(pending).then(function () { return flatten(slots); });
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

  // Promise<[{label, tone}]> keyline badges for a details page (e.g. "Downloading 45%"); late and optional.
  plugins.badges = function (item) {
    return Promise.all(active().filter(function (d) { return d.badges && !d.external; }).map(function (d) {
      return safeAsync(d, 'badges', function () { return d.badges(item, d.ctx); }).then(function (list) {
        return (Array.isArray(list) ? list : []).filter(function (b) { return b && b.label; }).slice(0, 2).map(function (b) {
          return { label: String(b.label).slice(0, 40), tone: /^[a-z]{1,12}$/.test(b.tone || '') ? b.tone : '' };
        });
      });
    })).then(flatten);
  };

  // OK on an item that came from a plugin shelf (Search keeps plain items)
  plugins.select = function (item) {
    var d = item && find(item.plugin);
    if (d && d.onSelect && plugins.isEnabled(d.id)) safe(d, 'onSelect', null, function () { d.onSelect(item, d.ctx); });
  };

  // ---- onPlayback: playback events (docs/PLUGINS.md, "onPlayback") -------------------------------
  //
  // The player tells a session tracker (plugins.playbackSession) what its <video> did; the tracker
  // turns that into play / pause / resume / stop / ended / buffering-start / buffering-end and
  // queues them. Plugins hear about them later, in a timer of their own, never in the task that
  // handles a key press or a media event, and nobody waits for them: a plugin that throws, rejects or
  // never answers changes nothing for playback.

  var PLAYBACK_DEFER_MS = 200;     // after the frame that showed the controls has been drawn
  var BUFFERING_AFTER_MS = 2000;   // a stall shorter than this (a seek, a hiccup) isn't news
  var playbackQueue = [];
  var playbackTimer = null;

  plugins.hasPlayback = function () {
    return defs.some(function (d) { return typeof d.onPlayback === 'function' && plugins.isEnabled(d.id); });
  };

  function hiddenPage() {
    return !!PL.leaving || (typeof document !== 'undefined' && !!document.hidden);
  }

  function copyEvent(ev) {
    var item = {};
    Object.keys(ev.item).forEach(function (k) { item[k] = Array.isArray(ev.item[k]) ? ev.item[k].slice() : ev.item[k]; });
    return { event: ev.event, at: ev.at, item: item, positionMs: ev.positionMs };
  }

  function flushPlayback() {
    clearTimeout(playbackTimer);
    playbackTimer = null;
    var list = playbackQueue;
    playbackQueue = [];
    var targets = active().filter(function (d) { return typeof d.onPlayback === 'function'; });
    list.forEach(function (ev) {
      targets.forEach(function (d) {
        // each plugin gets its own copy, so one can't change what the next one sees
        safe(d, 'onPlayback', null, function () {
          var r = d.onPlayback(copyEvent(ev), d.ctx);
          if (r && typeof r.then === 'function') {
            r.then(null, function (err) { PL.warn('plugin ' + d.id + ' onPlayback failed: ' + (err && err.message)); });
          }
        });
      });
    });
  }

  // Queues one event. Cheap enough for the player to call from its media event handlers. While the
  // page goes away (the TV app leaving the foreground, a browser tab closing) the queue is delivered
  // at once: timers may not run after that.
  plugins.playback = function (ev) {
    if (!ev || !plugins.hasPlayback()) return;
    playbackQueue.push(ev);
    if (hiddenPage()) flushPlayback();
    else if (!playbackTimer) playbackTimer = setTimeout(flushPlayback, PLAYBACK_DEFER_MS);
  };

  // Ratings for children (country prefixes like "gb/" are ignored). PG counts for films only:
  // TV-PG covers a lot of grown-up television.
  var KIDS_RATINGS = ['G', 'U', 'UC', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G'];
  var KIDS_LIBRARY = /\b(kids|children'?s?)\b/i;
  var KIDS_GENRE = /^(children'?s?|kids)$/i;
  // the Live TV guide's categories (js/livetv-browse.js) in the words plugins get
  var LIVE_CATEGORY = { sport: 'sports', news: 'news', kids: 'kids', movies: 'movie', entertainment: 'series', documentaries: 'series' };

  function tags(list) {
    return (Array.isArray(list) ? list : []).map(function (g) { return g && g.tag; }).filter(function (t) { return typeof t === 'string' && t; });
  }

  function isKids(rating, type, genres, library) {
    var r = String(rating || '').replace(/^[a-z]{2}\//i, '').toUpperCase();
    if (KIDS_RATINGS.indexOf(r) !== -1 || (r === 'PG' && type === 'movie')) return true;
    if (library && KIDS_LIBRARY.test(library)) return true;
    return genres.some(function (g) { return KIDS_GENRE.test(g); });
  }

  // What plugins learn about what is playing: plain facts from metadata the player already has,
  // nothing that identifies the server or the account (no keys, paths, URLs or ids).
  // meta: the Plex item (or, for Live TV, {channel, now}: the channel and the tune's programme).
  plugins.playbackItem = function (meta, live) {
    var out;
    var genres;
    if (live) {
      var ch = (meta && meta.channel) || {};
      var now = (meta && meta.now) || null;
      genres = tags(now && now.Genre);
      var B = PL.liveBrowse;
      var cat = (B && genres.length && B.categoryOfGenres(genres)) ||
        (PL.liveGuide && PL.liveGuide.cats && PL.liveGuide.cats[ch.identifier]) ||
        (B && B.categoryOfName(ch.title)) || null;
      out = {
        type: 'live', kind: 'live',
        title: (now && (now.grandparentTitle || now.title)) || ch.title || 'Live TV',
        channel: ch.title || '',
        liveCategory: LIVE_CATEGORY[cat] || null,
      };
      if (now && now.contentRating) out.contentRating = String(now.contentRating);
      out.genres = genres.slice(0, 3);
      out.isKids = cat === 'kids' || isKids(out.contentRating, now && now.type, genres, null);
      return out;
    }
    meta = meta || {};
    var type = meta.type === 'movie' || meta.type === 'episode' ? meta.type : 'clip';
    genres = tags(meta.Genre);
    out = { type: type, kind: type === 'movie' ? 'movie' : type === 'episode' ? 'series' : null, title: String(meta.title || '') };
    if (type === 'episode') {
      if (meta.grandparentTitle) out.showTitle = String(meta.grandparentTitle);
      if (typeof meta.parentIndex === 'number') out.season = meta.parentIndex;
      if (typeof meta.index === 'number') out.episode = meta.index;
    }
    if (typeof meta.year === 'number') out.year = meta.year;
    if (typeof meta.duration === 'number') out.durationMs = meta.duration;
    if (meta.contentRating) out.contentRating = String(meta.contentRating);
    out.genres = genres.slice(0, 3);
    out.isKids = isKids(meta.contentRating, type, genres, meta.librarySectionTitle);
    return out;
  };

  // One per player. The player reports what its video did; this decides which event that is.
  //   playing(key, meta, live, posMs)  the video is playing (a new item when key changes)
  //   paused(posMs)                    paused by the viewer (not a scrub)
  //   waiting()                        stalled while playing
  //   stopped(posMs) / ended(posMs)    left the player or failed / finished (credits count)
  // A seek (a direct seek, or a stream restart) leaves the session playing and sends nothing.
  plugins.playbackSession = function () {
    var cur = null; // {key, item, state: 'playing'|'paused'|'buffering'}
    var stallTimer = null;
    var send = function (event, posMs) {
      plugins.playback({ event: event, at: Date.now(), item: cur.item, positionMs: posMs == null ? null : posMs });
    };
    var end = function (event, posMs) {
      clearTimeout(stallTimer);
      if (!cur) return;
      send(event, posMs);
      cur = null;
    };
    return {
      playing: function (key, meta, live, posMs) {
        clearTimeout(stallTimer);
        if (cur && cur.key !== key) end('stop', null); // another channel, or an item we never heard end
        if (!cur) {
          if (!plugins.hasPlayback()) return;
          cur = { key: key, item: plugins.playbackItem(meta, live), state: 'playing' };
          send('play', posMs);
          return;
        }
        var was = cur.state;
        cur.state = 'playing';
        if (was === 'paused') send('resume', posMs);
        else if (was === 'buffering') send('buffering-end', posMs);
      },
      paused: function (posMs) {
        clearTimeout(stallTimer);
        if (!cur || cur.state === 'paused') return;
        cur.state = 'paused';
        send('pause', posMs);
      },
      waiting: function (posFn) {
        if (!cur || cur.state !== 'playing') return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(function () {
          if (!cur || cur.state !== 'playing') return;
          cur.state = 'buffering';
          send('buffering-start', posFn ? posFn() : null);
        }, BUFFERING_AFTER_MS);
      },
      stopped: function (posMs) { end('stop', posMs); },
      ended: function (posMs) { end('ended', posMs); },
      state: function () { return cur ? cur.state : 'idle'; },
    };
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
        spinner: function () { return PL.ui.spinner(); },
        fadeInImage: function (img, src) { PL.ui.fadeInImage(img, src); },
        isBack: PL.isBack,
        KEY: PL.KEY,
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
      // the active Plex Home profile ({uuid, title}), or null for the account owner
      profile: function () { return PL.storage.get('profile', null); },
      // read-only Plex lookups on the connected server
      plex: {
        metadata: function (ratingKey) { return PL.plex.metadata(ratingKey); },
        children: function (ratingKey) { return PL.plex.children(ratingKey); },
        image: function (path, w, h) { return PL.plex.image(path, w, h); },
      },
      // bundled plugins only: push a screen object ({el, show, hide, key, destroy}) built with ctx.ui
      push: function (screen) { PL.app.push(screen); },
      // opens Plex Lite's details page for a Plex item ({ratingKey, type, title})
      // (the phone and tablet layer's own page while it is showing: web/touch/shell.js)
      openItem: function (item) {
        if (PL.touch && PL.touch.visible && PL.touch.open) PL.touch.open(item);
        else PL.app.push(PL.screens.details(item));
      },
      pop: function () { PL.app.pop(); },
      backdrop: function (url) { PL.app.backdrop.set(url || null, url ? 'detail' : 'ambient'); },
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
