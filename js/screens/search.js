// Search tab: on-screen keyboard on the left, results on the right. Titles come from the local
// fuzzy index on every keystroke; episodes and people come from the server, debounced. With Live
// TV, channels and the guide's programmes (PL.liveGuide, already in memory) are matched locally on
// every keystroke too (js/livetv-search.js); the guide loads in the background when Search opens.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;

  var CHARS = 'abcdefghijklmnopqrstuvwxyz1234567890';
  var COLS = 6;
  var CHAR_ROWS = CHARS.length / COLS;
  var WIDE = [
    { label: 'Space', act: 'space' },
    { label: 'Delete', act: 'delete' },
    { label: 'Clear', act: 'clear' },
  ];
  // 6 x 66px keys on a 78px pitch and 3 x 144px wide keys on a 156px pitch both span 456px,
  // the search field's width, so every edge lines up.
  var KEY = 66;
  var PITCH = 78;
  var WIDE_W = 144;
  var WIDE_PITCH = 156;
  var FIELD_W = 456;
  var RESULTS_LEFT = 640;
  var CLIP_LEFT = 600;

  var lastQuery = '';
  var LS = PL.liveSearch;
  var LL = PL.liveLogic;
  var GUIDE_AHEAD = 6 * 3600;     // Search keeps this much of the guide loaded (two or three blocks)
  var GUIDE_DELAY_MS = 800;       // after Search opens, so the first frames and keys come first
  // TV rows follow the typing by this much: matching and two more shelves cost ~35 ms a keystroke on
  // a 2019 TV, so the key's own frame (field, titles) comes first and a fast typist pays once
  var TV_DEBOUNCE_MS = 150;
  // Channels row: a quiet tile with the logo plate, number, name and what's on (DESIGN.md)
  var CHANNEL_GEO = { w: 360, h: 202, pitch: 388, scale: 1.09 };

  function now() { return Math.floor(Date.now() / 1000); }
  function liveTv() { return !!(PL.app && PL.app.hasLiveTv && PL.liveGuide && LS); }

  function charFor(code, e) {
    if (e && (e.ctrlKey || e.metaKey || e.altKey)) return null;
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
    if (code >= 48 && code <= 57) return String.fromCharCode(code);
    if (code >= 96 && code <= 105) return String.fromCharCode(code - 48);
    if (code === 32) return ' ';
    return null;
  }

  function SearchScreen() {
    this.longPress = true;
    this.typesLetters = true; // a keyboard's letters type here (the web build maps them elsewhere)
    this.root = true;
    this.alive = true;
    this.el = PL.el('div', 'search-screen');
    this.shadow = new ui.FocusShadow();
    this.query = lastQuery;
    this.local = [];
    this.server = { titles: [], people: [], episodes: [] };
    this.serverDone = false;
    this.pending = null;
    this.seq = 0;
    this.zoneIds = '';
    this.area = 'keys';
    this.row = 0;
    this.col = 0;
    this.visible = false;
    this.serverStale = false;

    this.field = PL.el('div', 'search-field');
    this.field.style.left = '96px';
    this.field.style.width = FIELD_W + 'px';
    this.el.appendChild(this.field);
    this.buildKeyboard();

    var clip = PL.el('div', 'search-clip');
    clip.style.cssText = 'position:absolute;left:' + CLIP_LEFT + 'px;top:0;width:' + (ui.SCREEN_W - CLIP_LEFT) + 'px;height:' + ui.SCREEN_H + 'px;overflow:hidden';
    this.results = PL.el('div', 'search-results');
    this.results.style.left = -CLIP_LEFT + 'px';
    clip.appendChild(this.results);
    this.el.appendChild(clip);
    this.status = PL.el('div', 'search-status');
    this.el.appendChild(this.status);
    var me = this;
    this.stack = new ui.VStack(this.results, {
      top: 150,
      keep: 3,
      anchor: function (i, top, zone) { return i === 0 ? top : Math.min(top, 1040 - zone.height); },
      onFocusZone: function () { me.updateHeader(); },
    });

    var self = this;
    this.runServer = PL.debounce(function (q) { self.serverSearch(q); }, 300);
    // plugin shelves (e.g. Overseerr requests) come after Search's own; slower, so a longer pause
    this.pluginRows = [];
    this.pluginSeq = 0;
    this.runPlugins = PL.debounce(function (q) { self.pluginSearch(q); }, 450);
    this.ambient = PL.debounce(function (item) {
      var path = item && (ui.artPath(item) || item.thumb);
      if (path) PL.app.backdrop.set(ui.ambient(path), 'ambient');
    }, 400);
    this.offIndex = PL.fuzzy.onChange(function () { if (self.alive) self.update(true); });
    this.indexError = null;
    // Live TV: channel and guide indexes, rebuilt when the guide changes (not per keystroke)
    this.tv = { channels: [], shows: [] };
    this.tvFirst = false;       // the TV rows go above Movies & Shows (LS.channelsFirst)
    this.tvFirstFor = null;     // the query that decided it
    this.tvIndex = null;        // {channels, guide, gen, at}
    this.tvGen = 0;
    this.tvCache = {};
    this.timing = null;         // {local, render} ms for the last keystroke; tvTiming {tv, render} for the TV rows
    if (liveTv()) {
      // the guide changed: rebuild the index while idle (not on the next keystroke), then the rows
      this.offGuide = PL.liveGuide.listen(function () {
        self.tvGen++;
        if (self.alive && self.visible) self.tvSoon();
      });
      this.tvSoon = PL.debounce(function () {
        if (!self.alive || !self.visible || !PL.liveGuide.channels.length) return;
        self.tvIndexNow();
        if (self.query.trim()) self.updateTv();
      }, 250);
      this.runTv = PL.debounce(function () { if (self.alive && self.visible) self.updateTv(); }, TV_DEBOUNCE_MS);
    }
    this.renderField();
  }

  // ---- Keyboard --------------------------------------------------------------------------------

  SearchScreen.prototype.buildKeyboard = function () {
    var kb = PL.el('div', 'keyboard');
    kb.style.left = '96px';
    kb.style.width = FIELD_W + 'px';
    var self = this;
    this.keyNodes = [];
    for (var r = 0; r < CHAR_ROWS; r++) {
      var row = [];
      for (var c = 0; c < COLS; c++) {
        var ch = CHARS.charAt(r * COLS + c);
        var n = PL.el('div', 'key', ch.toUpperCase());
        n.style.cssText = 'left:' + (c * PITCH) + 'px;top:' + (r * PITCH) + 'px;width:' + KEY + 'px;height:' + KEY + 'px;line-height:' + (KEY - 2) + 'px';
        n.addEventListener('click', this.press.bind(this, r, c));
        kb.appendChild(n);
        row.push(n);
      }
      this.keyNodes.push(row);
    }
    this.wideNodes = WIDE.map(function (w, i) {
      var n = PL.el('div', 'key wide', w.label);
      n.style.cssText = 'left:' + (i * WIDE_PITCH) + 'px;top:' + (CHAR_ROWS * PITCH) + 'px;width:' + WIDE_W + 'px;height:' + KEY + 'px;line-height:' + (KEY - 2) + 'px';
      n.addEventListener('click', function () { self.press(CHAR_ROWS, i * 2); });
      kb.appendChild(n);
      return n;
    });
    this.el.appendChild(kb);
  };

  SearchScreen.prototype.wideIndex = function () {
    return Math.min(WIDE.length - 1, Math.floor(this.col / 2));
  };

  SearchScreen.prototype.paintKeys = function () {
    var on = this.area === 'keys' && !PL.app.tabsFocused && this.visible;
    var self = this;
    this.keyNodes.forEach(function (row, r) {
      row.forEach(function (n, c) { n.classList.toggle('focused', on && self.row === r && self.col === c); });
    });
    var wi = this.wideIndex();
    this.wideNodes.forEach(function (n, i) { n.classList.toggle('focused', on && self.row === CHAR_ROWS && wi === i); });
  };

  SearchScreen.prototype.press = function (r, c) {
    this.row = r;
    this.col = c;
    if (r < CHAR_ROWS) {
      this.type(CHARS.charAt(r * COLS + c));
    } else {
      var act = WIDE[Math.min(WIDE.length - 1, Math.floor(c / 2))].act;
      if (act === 'space') this.type(' ');
      else if (act === 'delete') this.erase();
      else this.setQuery('');
    }
    this.paintKeys();
  };

  SearchScreen.prototype.keyboardKey = function (code) {
    var last = CHAR_ROWS;
    if (code === K.LEFT) {
      if (this.row === last) this.col = Math.max(0, (this.wideIndex() - 1) * 2);
      else if (this.col > 0) this.col--;
    } else if (code === K.RIGHT) {
      var atEdge = this.row === last ? this.wideIndex() === WIDE.length - 1 : this.col === COLS - 1;
      if (atEdge) {
        this.focusResults();
        return true;
      }
      if (this.row === last) this.col = (this.wideIndex() + 1) * 2;
      else this.col++;
    } else if (code === K.UP) {
      if (this.row === 0) return PL.app.focusTabs();
      if (this.row === last) this.col = this.wideIndex() * 2;
      this.row--;
    } else if (code === K.DOWN) {
      if (this.row < last) this.row++;
    } else if (code === K.ENTER) {
      this.press(this.row, this.col);
      return true;
    } else {
      return false;
    }
    this.paintKeys();
    return true;
  };

  // ---- Query -------------------------------------------------------------------------------------

  SearchScreen.prototype.type = function (ch) {
    if (ch === ' ' && (!this.query || /\s$/.test(this.query))) return;
    if (this.query.length >= 60) return;
    this.setQuery(this.query + ch);
  };

  SearchScreen.prototype.erase = function () {
    if (this.query) this.setQuery(this.query.slice(0, -1));
  };

  SearchScreen.prototype.setQuery = function (q) {
    if (q === this.query) return;
    this.query = q;
    lastQuery = q;
    this.renderField();
    this.update(false);
  };

  SearchScreen.prototype.renderField = function () {
    PL.clear(this.field);
    var q = this.query;
    if (q) {
      this.field.appendChild(document.createTextNode(q.length > 18 ? '…' + q.slice(-17) : q));
      this.field.appendChild(PL.el('span', 'caret'));
    } else {
      this.field.appendChild(PL.el('span', 'caret'));
      this.field.appendChild(PL.el('span', 'placeholder', 'Search'));
    }
  };

  // indexChanged: the local index finished building/refreshing (re-run without hitting the server)
  SearchScreen.prototype.update = function (indexChanged) {
    var q = this.query.trim();
    if (!q) {
      this.runServer.cancel();
      this.abortServer();
      this.runPlugins.cancel();
      this.pluginSeq++;
      this.pluginRows = [];
      this.local = [];
      this.tv = { channels: [], shows: [] };
      this.tvFirst = false;
      this.tvFirstFor = null;
      this.server = { titles: [], people: [], episodes: [] };
      this.serverDone = false;
      this.render();
      return;
    }
    var t0 = Date.now();
    this.local = PL.fuzzy.ready ? PL.fuzzy.query(q, 40) : [];
    var t1 = Date.now();
    this.render();
    this.timing = { local: t1 - t0, render: Date.now() - t1 };
    // (until then the rows of the query a moment ago stay, like the server's rows do)
    if (this.runTv) this.runTv();
    if (!indexChanged) {
      this.serverDone = false;
      if (this.visible) this.runServer(q);
      else this.serverStale = true;
      if (PL.plugins.hasSearch()) {
        this.pluginSeq++;
        if (this.visible) this.runPlugins(q);
      }
    }
  };

  // ---- Live TV -----------------------------------------------------------------------------------

  // Loads the channels and the next few hours of the guide (shared with the Live TV tab, so usually
  // already there). Failures stay quiet: channel names still match whatever the lineup gave.
  SearchScreen.prototype.loadGuide = function () {
    if (!liveTv() || this.guideAsked) return;
    this.guideAsked = true;
    var G = PL.liveGuide;
    var self = this;
    var quiet = function (what) {
      return function (err) {
        self.guideAsked = false; // try again next time Search opens
        PL.log('search: no live TV ' + what, err && (err.status || err.message));
      };
    };
    // the lineup first (small), so channel names match even if the guide then fails
    G.loadChannels().then(function () {
      if (!self.alive) return null;
      return G.load().then(function () {
        var t = now();
        return self.alive ? G.ensure(t, t + GUIDE_AHEAD) : null;
      }).then(null, quiet('guide'));
    }, quiet('lineup'));
  };

  // Rebuilt when the guide changed or a minute has passed (programmes end; what's on now moves on).
  SearchScreen.prototype.tvIndexNow = function () {
    var G = PL.liveGuide;
    var t = now();
    var have = this.tvIndex;
    if (have && have.gen === this.tvGen && t - have.at < LS.REBUILD_MS / 1000) return have;
    var started = Date.now();
    this.tvCache = LS.trimCache(this.tvCache);
    var chans = have && have.list === G.channels ? have.channels : LS.indexChannels(G.channels);
    this.tvIndex = {
      list: G.channels,
      channels: chans,
      guide: LS.indexGuide(G.channels, G.list, t, this.tvCache),
      gen: this.tvGen,
      at: t,
      ms: Date.now() - started,
    };
    return this.tvIndex;
  };

  SearchScreen.prototype.updateTv = function () {
    var q = this.query.trim();
    if (!q) return;
    var t0 = Date.now();
    this.tv = this.tvSearch(q);
    // Order: decided here, with the TV rows, from local results only. It never changes under a
    // focus that is in the results for the same query (a late index or guide update can't move it).
    var first = this.tv.first;
    if (this.area === 'results' && this.tvFirstFor === q) first = this.tvFirst;
    this.tvFirst = first;
    this.tvFirstFor = q;
    var t1 = Date.now();
    this.render();
    this.tvTiming = { tv: t1 - t0, render: Date.now() - t1 };
  };

  SearchScreen.prototype.tvSearch = function (text) {
    if (!liveTv() || !PL.liveGuide.channels.length) return { channels: [], shows: [] };
    var G = PL.liveGuide;
    var q = LS.query(text);
    if (!q) return { channels: [], shows: [] };
    var idx = this.tvIndexNow();
    var t = now();
    var matched = LS.matchChannels(idx.channels, q, { limit: 30, isFavourite: G.isFavourite });
    var first = LS.channelsFirst(q, matched.best, LS.titleScore(this.local[0], q));
    var channels = matched.map(function (c) {
      var nn = G.nowNext(c.identifier, t);
      return { ratingKey: 'live-ch-' + c.identifier, liveChannel: c, airing: nn.now, next: nn.next };
    });
    var shows = LS.matchProgrammes(idx.guide, q, t, 30).map(function (h) {
      return { ratingKey: 'live-air-' + h.c.identifier + '-' + h.a.b, liveChannel: h.c, airing: h.a, onNow: h.onNow, art: h.a.art };
    });
    return { channels: channels, shows: shows, first: first };
  };

  // OK on a channel, or on a programme that is on now: watch it from live, with CH+/CH- along
  // every channel (as from the guide's All filter).
  SearchScreen.prototype.watch = function (c) {
    var G = PL.liveGuide;
    if (!G.src) return;
    var list = G.channels;
    var index = 0;
    for (var i = 0; i < list.length; i++) if (list[i].identifier === c.identifier) { index = i; break; }
    var shape = function (x) { return { identifier: x.identifier, id: x.id, vcn: x.vcn, title: x.name, thumb: x.thumb }; };
    PL.app.push(screens.player(null, {
      live: { label: 'All channels', dvrKey: G.src.dvrKey, channel: shape(list[index] || c), channels: list.map(shape), index: index },
    }));
  };

  // OK on a later programme (or "Show in guide"): the Live TV tab, on that channel and time.
  SearchScreen.prototype.showInGuide = function (c, t) {
    var ids = PL.app.tabs.tabs.map(function (x) { return x.id; });
    var i = ids.indexOf('livetv');
    if (i < 0) return;
    PL.liveGuide.openAt = { identifier: c.identifier, t: t || now() };
    PL.app.selectTab(i);
  };

  SearchScreen.prototype.liveMenu = function (item) {
    var G = PL.liveGuide;
    var c = item.liveChannel;
    var a = item.ratingKey.indexOf('live-air-') === 0 ? item.airing : null;
    var later = a && a.b > now();
    var self = this;
    var fav = G.isFavourite(c.identifier);
    var rows = [];
    if (!later) rows.push({ label: 'Watch ' + c.name, action: function () { self.watch(c); } });
    rows.push({ label: 'Show in guide', action: function () { self.showInGuide(c, a ? a.b : now()); } });
    rows.push({
      label: fav ? 'Remove from Favourites' : 'Add to Favourites',
      action: function () {
        var on = G.toggleFavourite(c.identifier);
        PL.toast(on ? 'Added ' + c.name + ' to Favourites' : 'Removed ' + c.name + ' from Favourites');
      },
    });
    PL.app.push(screens.sheet([{ heading: c.vcn + '  ' + c.name + (a ? '  ·  ' + a.title : ''), rows: rows }], { focus: 0 }));
    return true;
  };

  // Stale answers (the query moved on, or the screen went away) are dropped.
  SearchScreen.prototype.pluginSearch = function (q) {
    var self = this;
    var seq = ++this.pluginSeq;
    PL.plugins.searchRows(q).then(function (rows) {
      if (!self.alive || seq !== self.pluginSeq || q !== self.query.trim()) return;
      self.pluginRows = rows;
      self.render();
    });
  };

  SearchScreen.prototype.abortServer = function () {
    if (this.pending) {
      this.pending.abort();
      this.pending = null;
    }
  };

  SearchScreen.prototype.serverSearch = function (q) {
    var self = this;
    this.abortServer();
    var seq = ++this.seq;
    // PL.http directly (not PL.plex.search) so the request can be aborted when the query changes
    var req = PL.http('GET', PL.plex.url('/hubs/search', { query: q, limit: 20, includeCollections: 0 }), { timeout: 10000 });
    this.pending = req;
    req.then(function (res) {
      if (!self.alive || seq !== self.seq) return;
      self.pending = null;
      if (!self.visible) {
        self.serverStale = true;
        return;
      }
      self.server = self.parseServer((res && res.MediaContainer) || {});
      self.serverDone = true;
      self.render();
    }, function (err) {
      if (!self.alive || seq !== self.seq || (err && err.aborted)) return;
      self.pending = null;
      self.serverDone = true;
      PL.warn('server search failed', err && err.message);
      if (err && err.status === 401 && PL.plex.onUnauthorized) PL.plex.onUnauthorized(err);
      self.render();
    });
  };

  SearchScreen.prototype.parseServer = function (mc) {
    var out = { titles: [], people: [], episodes: [] };
    (mc.Hub || []).forEach(function (hub) {
      if ((hub.type === 'movie' || hub.type === 'show') && hub.Metadata) {
        out.titles = out.titles.concat(hub.Metadata);
      } else if (hub.type === 'episode' && hub.Metadata) {
        out.episodes = hub.Metadata.slice(0, 30);
      } else if (hub.type === 'actor' && hub.Directory) {
        // Plex returns one entry per library; one card per person (tag ids are global, the name is
        // the fallback when ids differ). The person page lists their work in every library.
        var seen = {};
        out.people = [];
        hub.Directory.forEach(function (d) {
          var key = seen['id:' + d.id] || seen['name:' + d.tag];
          if (key) {
            if (!key.thumb && d.thumb) key.thumb = d.thumb;
            return;
          }
          var item = {
            ratingKey: 'person-' + d.id,
            type: 'person',
            title: d.tag,
            thumb: d.thumb,
            person: { id: d.id, name: d.tag, thumb: d.thumb },
          };
          seen['id:' + d.id] = item;
          seen['name:' + d.tag] = item;
          out.people.push(item);
        });
      }
    });
    return out;
  };

  // Local fuzzy matches first; server title matches the index missed are appended.
  SearchScreen.prototype.titles = function () {
    var seen = {};
    var out = [];
    this.local.forEach(function (it) { seen[it.ratingKey] = true; out.push(it); });
    this.server.titles.forEach(function (it) {
      if (!seen[it.ratingKey]) {
        seen[it.ratingKey] = true;
        out.push(it);
      }
    });
    return out.slice(0, 40);
  };

  // ---- Results -----------------------------------------------------------------------------------

  SearchScreen.prototype.render = function () {
    var q = this.query.trim();
    var sections = [];
    if (q) {
      var titles = this.titles();
      var titleRow = titles.length ? { id: 'titles', title: 'Movies & Shows', kind: 'poster', items: titles } : null;
      // local like the titles, so they sit above the server's rows and don't move when those arrive;
      // above the titles when the query is about channels (this.tvFirst)
      if (titleRow && !this.tvFirst) sections.push(titleRow);
      var live = this.liveMenu.bind(this);
      if (this.tv.channels.length) {
        sections.push({ id: 'channels', title: 'Channels', kind: 'wide', geometry: CHANNEL_GEO, makeCard: makeChannelCard, onLongPress: live, items: this.tv.channels });
      }
      if (this.tv.shows.length) sections.push({ id: 'ontv', title: 'On TV', kind: 'wide', makeCard: makeAiringCard, onLongPress: live, items: this.tv.shows });
      if (titleRow && this.tvFirst) sections.push(titleRow);
      if (this.server.people.length) {
        sections.push({ id: 'people', title: 'People', kind: 'poster', geometry: ui.PERSON_GEO, makeCard: ui.makePersonCard, items: this.server.people });
      }
      if (this.server.episodes.length) sections.push({ id: 'episodes', title: 'Episodes', kind: 'wide', items: this.server.episodes });
      this.pluginRows.forEach(function (row) { if (row.items.length) sections.push(row); });
    }
    this.renderStatus(q, sections.length);
    this.renderZones(sections);
  };

  SearchScreen.prototype.renderStatus = function (q, count) {
    var text = '';
    if (!q) {
      var what = liveTv() ? 'Search movies, shows, episodes, people and live TV' : 'Search movies, shows, episodes and people';
      text = this.indexError ? 'Search is limited: ' + PL.errorMessage(this.indexError) : what;
    }
    else if (!count && !PL.fuzzy.ready && PL.fuzzy.isBuilding()) text = 'Indexing your library…';
    else if (!count && this.serverDone) text = 'No results for “' + q + '”';
    else if (!count) text = 'Searching…';
    this.status.textContent = text;
    this.status.style.display = text ? '' : 'none';
  };

  // Shelves are reused per section. While the query is unchanged (the index finished, server hubs
  // arrived) the focused zone and item stay put; a new query starts each shelf at its first item.
  SearchScreen.prototype.renderZones = function (sections) {
    var self = this;
    var q = this.query.trim();
    var sameQuery = q === this.renderedQuery;
    this.renderedQuery = q;
    var ids = sections.map(function (s) { return s.id; });
    var old = {};
    this.stack.zones.forEach(function (z) { old[z.sectionId] = z; });
    var current = this.stack.current();
    var focusedId = current ? current.sectionId : null;
    var zones = sections.map(function (s) {
      var shelf = old[s.id];
      // the same items as last time (the TV rows until their debounce, the server's rows until they
      // answer): the cards stay as they are
      if (shelf && shelf.srcItems === s.items) return shelf;
      if (shelf) {
        shelf.srcItems = s.items;
        if (!sameQuery) shelf.index = 0;
        shelf.replaceItems(s.items, s.items.length);
        if (!sameQuery && shelf.index !== 0) {
          shelf.index = 0;
          shelf.render();
        }
        return shelf;
      }
      shelf = new ui.Shelf({
        title: s.title,
        items: s.items,
        kind: s.kind,
        left: RESULTS_LEFT,
        shadow: self.shadow,
        makeCard: s.makeCard,
        geometry: s.geometry,
        onLongPress: s.onLongPress,
        onFocusItem: function (item) { self.focusedItem(item); },
        onSelect: function (item) { self.open(item); },
      });
      shelf.sectionId = s.id;
      shelf.srcItems = s.items;
      return shelf;
    });
    var key = ids.join(',');
    if (key === this.zoneIds) {
      if (this.area === 'results' && this.stack.current()) this.focusedItem(this.stack.current().current());
      return;
    }
    var wasResults = this.area === 'results';
    this.stack.focus(false);
    this.shadow.hide();
    this.zoneIds = key;
    // the focused row stays put only while the focus is in the results; from the keyboard, Right
    // always lands on the top row (which may have changed: the TV rows can go first)
    var keep = sameQuery && focusedId && wasResults ? ids.indexOf(focusedId) : -1;
    this.stack.setZones(zones, keep >= 0 ? keep : 0);
    if (wasResults) {
      if (zones.length) this.stack.focus(true);
      else this.focusKeys();
    }
  };

  SearchScreen.prototype.focusedItem = function (item) {
    if (item && this.visible) this.ambient(item);
  };

  SearchScreen.prototype.open = function (item) {
    if (item.liveChannel) {
      var a = item.ratingKey.indexOf('live-air-') === 0 ? item.airing : null;
      if (a && a.b > now()) this.showInGuide(item.liveChannel, a.b);
      else this.watch(item.liveChannel);
      return;
    }
    if (item.plugin) {
      PL.plugins.select(item);
      return;
    }
    if (item.type === 'person') {
      var p = item.person;
      PL.app.push(screens.person({ id: p.id, name: p.name, thumb: item.thumb || p.thumb }, { filter: 'actor' }));
      return;
    }
    PL.app.push(screens.details(item));
  };

  // the tab bar hides once the results are scrolled past their first row, like the library screens
  SearchScreen.prototype.updateHeader = function () {
    if (!this.visible || PL.app.tabsFocused) return;
    PL.app.tabs.show(!(this.area === 'results' && this.stack.index > 0));
  };

  SearchScreen.prototype.focusResults = function () {
    if (!this.stack.zones.length) return;
    this.area = 'results';
    this.paintKeys();
    this.stack.focus(true);
  };

  SearchScreen.prototype.focusKeys = function () {
    this.area = 'keys';
    PL.app.tabs.show(this.visible);
    this.stack.focus(false);
    this.shadow.hide();
    this.paintKeys();
  };

  // ---- Screen interface ---------------------------------------------------------------------------

  SearchScreen.prototype.key = function (code, e) {
    var ch = charFor(code, e);
    if (ch) {
      this.type(ch);
      return true;
    }
    if (code === K.BACKSPACE) {
      if (!this.query) return false;
      this.erase();
      return true;
    }
    if (this.area === 'results') {
      if (this.stack.key(code)) return true;
      if (code === K.LEFT || code === K.BACK || code === K.ESC) {
        this.focusKeys();
        return true;
      }
      if (code === K.UP) return PL.app.focusTabs();
      return false;
    }
    return this.keyboardKey(code);
  };

  SearchScreen.prototype.show = function () {
    this.visible = true;
    var self = this;
    PL.app.backdrop.set(null, 'ambient');
    if (!PL.app.tabsFocused) {
      if (this.area === 'results' && this.stack.zones.length) this.stack.focus(true);
      else this.focusKeys();
    }
    if (liveTv()) {
      clearTimeout(this.guideTimer);
      this.guideTimer = setTimeout(function () { if (self.alive && self.visible) self.loadGuide(); }, GUIDE_DELAY_MS);
    }
    PL.fuzzy.ensure().then(function () {
      self.indexError = null;
    }, function (err) {
      self.indexError = err;
      PL.warn('search index failed', err && err.message);
      if (self.alive) self.render();
    });
    if (!this.stack.zones.length) {
      if (this.query) this.update(false);
      else this.render();
    } else if (this.serverStale && this.query.trim()) {
      this.serverSearch(this.query.trim());
    }
    this.serverStale = false;
    if (this.query.trim() && !this.pluginRows.length && PL.plugins.hasSearch()) this.runPlugins(this.query.trim());
  };

  SearchScreen.prototype.hide = function () {
    this.visible = false;
    clearTimeout(this.guideTimer);
    if (this.tvSoon) this.tvSoon.cancel();
    if (this.runTv) this.runTv.cancel();
    this.ambient.cancel();
    if (this.query.trim() && !this.serverDone) this.serverStale = true;
    this.runServer.cancel();
    this.abortServer();
    this.runPlugins.cancel();
    this.stack.focus(false);
    this.shadow.hide();
    this.paintKeys();
  };

  SearchScreen.prototype.focusFromTabs = function () {
    this.focusKeys();
  };

  SearchScreen.prototype.onTabsFocus = function () {
    this.stack.focus(false);
    this.shadow.hide();
    this.paintKeys();
  };

  SearchScreen.prototype.destroy = function () {
    this.alive = false;
    this.offIndex();
    if (this.offGuide) this.offGuide();
    if (this.tvSoon) this.tvSoon.cancel();
    if (this.runTv) this.runTv.cancel();
    clearTimeout(this.guideTimer);
    this.runServer.cancel();
    this.runPlugins.cancel();
    this.pluginSeq++;
    this.ambient.cancel();
    this.abortServer();
  };

  // ---- Live TV cards ------------------------------------------------------------------------------

  function logoPlate(c, cls) {
    var plate = PL.el('div', cls);
    PL.logos.fill(plate, c, { w: 128, h: 68, textClass: 'stv-logo-text' });
    return plate;
  }

  function progressLine(a, t) {
    var bar = PL.el('div', 'stv-progress');
    var fill = PL.el('div', 'stv-progress-fill');
    fill.style.transform = 'scaleX(' + LL.progress(a, t).toFixed(3) + ')';
    bar.appendChild(fill);
    return bar;
  }

  // A channel: logo plate and number at the top, the name and what's on now below, a teal line for
  // how far through it is.
  function makeChannelCard(item, kind, geo) {
    var c = item.liveChannel;
    var a = item.airing;
    var t = now();
    var card = PL.el('div', 'card card-wide card-stv-chan');
    var inner = PL.el('div', 'card-inner');
    inner.style.width = geo.w + 'px';
    inner.style.height = geo.h + 'px';
    inner.appendChild(logoPlate(c, 'stv-logo'));
    var num = PL.el('div', 'stv-num', c.vcn);
    if (PL.liveGuide.isFavourite(c.identifier)) num.appendChild(PL.el('span', 'stv-fav', '★'));
    inner.appendChild(num);
    inner.appendChild(PL.el('div', 'stv-name', c.name));
    var on = PL.el('div', 'stv-on' + (a ? '' : ' stv-none'));
    if (a) {
      on.textContent = a.title + '  ·  ' + LL.status(a, t);
    } else {
      on.textContent = item.next ? 'Next ' + LL.clock(item.next.b) + '  ' + item.next.title : 'No guide information';
    }
    inner.appendChild(on);
    if (a) inner.appendChild(progressLine(a, t));
    inner.appendChild(PL.el('div', 'card-edge'));
    card.appendChild(inner);
    return card;
  }

  // A programme: its art with the title on it, LIVE or the start time in the corner, the channel
  // and the time left (or when it starts) under the title, a progress line while it is on.
  function makeAiringCard(item, kind, geo) {
    var c = item.liveChannel;
    var a = item.airing;
    var t = now();
    var card = PL.el('div', 'card card-wide card-stv-air');
    var inner = PL.el('div', 'card-inner');
    inner.style.width = geo.w + 'px';
    inner.style.height = geo.h + 'px';
    var src = a.art ? PL.plex.image(a.art, geo.w, geo.h) : null;
    if (src) {
      var img = PL.el('img', 'card-img');
      img.width = geo.w;
      img.height = geo.h;
      img.onerror = function () { img.style.visibility = 'hidden'; };
      ui.fadeInImage(img, src);
      inner.appendChild(img);
    }
    inner.appendChild(logoPlate(c, 'stv-badge'));
    inner.appendChild(item.onNow ? PL.el('div', 'stv-pill stv-live', 'LIVE') : PL.el('div', 'stv-pill', LL.day(a.b, t) === 'Today' ? LL.clock(a.b) : LL.day(a.b, t).slice(0, 3) + ' ' + LL.clock(a.b)));
    if (item.onNow) inner.appendChild(progressLine(a, t));
    inner.appendChild(PL.el('div', 'card-edge'));
    card.appendChild(inner);
    var meta = PL.el('div', 'card-meta');
    meta.style.width = geo.w + 'px';
    meta.appendChild(PL.el('div', 'card-title', a.title));
    // the corner pill has the start time; under the title: time left, "Starts in 10 min", or how long
    var when = item.onNow || a.b - t <= 3600 ? LL.status(a, t) : LL.span(a.e - a.b);
    meta.appendChild(PL.el('div', 'card-sub', c.vcn + ' ' + c.name + '  ·  ' + when));
    card.appendChild(meta);
    return card;
  }

  screens.search = function () { return new SearchScreen(); };
})();
