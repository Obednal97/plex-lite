// A library tab (Movies / TV Shows): sub-nav of Recommended, Library (sort + filters) and Collections.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;

  var SORTS = {
    movie: [
      { key: 'titleSort', label: 'Title', dir: 'asc' },
      { key: 'addedAt', label: 'Date added', dir: 'desc' },
      { key: 'originallyAvailableAt', label: 'Release date', dir: 'desc' },
      { key: 'audienceRating', label: 'Audience rating', dir: 'desc' },
      { key: 'rating', label: 'Critic rating', dir: 'desc' },
      { key: 'lastViewedAt', label: 'Last watched', dir: 'desc' },
      { key: 'duration', label: 'Duration', dir: 'desc' },
      { key: 'random', label: 'Random', dir: 'asc' },
    ],
    show: [
      { key: 'titleSort', label: 'Title', dir: 'asc' },
      { key: 'episode.addedAt', label: 'New episodes', dir: 'desc' },
      { key: 'addedAt', label: 'Date added', dir: 'desc' },
      { key: 'originallyAvailableAt', label: 'First aired', dir: 'desc' },
      { key: 'audienceRating', label: 'Audience rating', dir: 'desc' },
      { key: 'lastViewedAt', label: 'Last watched', dir: 'desc' },
      { key: 'random', label: 'Random', dir: 'asc' },
    ],
  };

  // ---- Filter bar: chips that open pickers -------------------------------------------------------

  function FilterBar() {
    this.el = PL.el('div', 'chip-row');
    this.track = PL.el('div', 'chip-track');
    this.el.appendChild(this.track);
    this.height = 88;
    this.index = 0;
    this.focused = false;
    this.items = [];
  }

  // items: [{label, value, active, action}]
  FilterBar.prototype.set = function (items) {
    PL.clear(this.track);
    this.items = items;
    var self = this;
    this.nodes = items.map(function (it, i) {
      var n = PL.el('div', 'chip' + (it.active ? ' selected' : ''));
      n.appendChild(document.createTextNode(it.label));
      if (it.value) n.appendChild(PL.el('span', 'chip-value', it.value));
      n.addEventListener('click', function () { self.index = i; it.action(); });
      self.track.appendChild(n);
      return n;
    });
    this.index = PL.clamp(this.index, 0, items.length - 1);
    this.paint();
  };

  FilterBar.prototype.paint = function () {
    var self = this;
    this.nodes.forEach(function (n, i) { n.classList.toggle('focused', self.focused && i === self.index); });
  };

  FilterBar.prototype.setFocused = function (on) {
    this.focused = on;
    this.paint();
  };

  FilterBar.prototype.key = function (code) {
    if (code === K.LEFT || code === K.RIGHT) {
      var next = this.index + (code === K.RIGHT ? 1 : -1);
      if (next < 0 || next >= this.items.length) return false;
      this.index = next;
      this.paint();
      return true;
    }
    if (code === K.ENTER) {
      this.items[this.index].action();
      return true;
    }
    return false;
  };

  // ---- Recommended -------------------------------------------------------------------------------

  function shelfKind(hub) {
    var id = hub.hubIdentifier || '';
    if (hub.type === 'episode' || /inprogress|continue|ondeck/.test(id)) return 'wide';
    return 'poster';
  }

  function Hero(el) {
    this.el = PL.el('div', 'hero');
    this.eyebrow = PL.el('div', 'hero-eyebrow');
    this.title = PL.el('div', 'hero-title');
    this.meta = PL.el('div', 'hero-meta');
    this.summary = PL.el('div', 'hero-summary');
    [this.eyebrow, this.title, this.meta, this.summary].forEach(function (n) { this.el.appendChild(n); }, this);
    el.appendChild(this.el);
    this.update = PL.debounce(this.apply.bind(this), 350);
  }

  Hero.prototype.apply = function (item) {
    if (!item || (this.isVisible && !this.isVisible())) return;
    this.eyebrow.textContent = item.type === 'episode' ? PL.fmt.episode(item) + (item.title ? ' · ' + item.title : '') : '';
    var title = ui.itemTitle(item) || '';
    this.title.textContent = title;
    this.title.classList.toggle('long', title.length > 26);
    PL.clear(this.meta);
    this.meta.appendChild(document.createTextNode(ui.metaLine(item, { skipEpisode: true })));
    if (item.viewOffset && item.duration) this.meta.appendChild(document.createTextNode(' · ' + PL.fmt.remaining(item)));
    this.summary.textContent = item.summary || '';
    PL.app.backdrop.set(PL.plex.image(ui.artPath(item), 1920, 1080, { quality: 72 }), 'hero');
  };

  function RecommendedMode(screen) {
    this.screen = screen;
    this.el = PL.el('div', 'mode-rec');
    this.hero = new Hero(this.el);
    this.hero.isVisible = function () { return screen.visible; };
    this.status = PL.el('div', 'loading');
    this.status.appendChild(ui.spinner());
    this.el.appendChild(this.status);
    this.stackHost = PL.el('div', 'rec-stack');
    this.el.appendChild(this.stackHost);
    var self = this;
    this.stack = new ui.VStack(this.stackHost, {
      top: 640,
      keep: 2,
      anchor: function (i, top) { return i === 0 ? top : 150; },
      onFocusZone: function () { self.screen.updateHeader(); },
    });
    this.loadedAt = 0;
    this.alive = true;
    this.load();
  }

  RecommendedMode.prototype.load = function () {
    var self = this;
    var section = this.screen.section;
    this.loadedAt = Date.now();
    PL.plex.get('/hubs/sections/' + section.key, { count: 20, excludeFields: 'file' }).then(function (mc) {
      if (!self.alive) return;
      var hubs = (mc.Hub || []).filter(PL.plex.isVideoHub);
      self.status.style.display = 'none';
      if (!hubs.length) {
        self.status.style.display = '';
        PL.clear(self.status);
        self.status.appendChild(PL.el('div', '', 'Nothing to recommend yet'));
        return;
      }
      self.build(hubs);
    }, function (err) {
      if (!self.alive) return;
      PL.clear(self.status);
      self.status.appendChild(PL.el('div', '', PL.errorMessage(err)));
    });
  };

  RecommendedMode.prototype.build = function (hubs) {
    var self = this;
    var shadow = this.screen.shadow;
    this.hubs = hubs;
    var zones = hubs.map(function (hub) {
      return new ui.Shelf({
        title: hub.title,
        items: hub.Metadata,
        kind: shelfKind(hub),
        total: hub.more ? hub.size + 100 : hub.size,
        shadow: shadow,
        loadMore: hub.more ? function (start) { return PL.plex.hubPage(hub, start, 20); } : null,
        onFocusItem: function (item) { self.hero.update(item); },
        onSelect: function (item) { PL.app.push(screens.details(item)); },
      });
    });
    this.stack.setZones(zones, 0);
    if (hubs[0] && hubs[0].Metadata[0] && this.screen.visible) this.hero.apply(hubs[0].Metadata[0]);
    if (this.focused) this.stack.focus(true);
    this.addPluginShelves(zones);
  };

  // Plugins may add shelves after the Plex rows (e.g. "Trending on Trakt"). They arrive late and are
  // appended without moving the focus.
  RecommendedMode.prototype.addPluginShelves = function (base) {
    if (!PL.plugins || !PL.plugins.shelfRows) return;
    var self = this;
    var shadow = this.screen.shadow;
    PL.plugins.shelfRows(this.screen.section).then(function (shelves) {
      if (!self.alive || !shelves || !shelves.length) return;
      var extra = shelves.filter(function (sh) { return sh && sh.items && sh.items.length; }).map(function (sh) {
        return new ui.Shelf({
          title: sh.title,
          items: sh.items,
          kind: sh.kind || 'poster',
          shadow: shadow,
          onFocusItem: function (item) { if (item.art || item.ratingKey) self.hero.update(item); },
          onSelect: sh.onSelect || function (item) { PL.app.push(screens.details(item)); },
        });
      });
      if (!extra.length) return;
      var focused = self.focused;
      var index = self.stack.index;
      if (focused) self.stack.focus(false);
      self.stack.setZones(base.concat(extra), index);
      if (focused) self.stack.focus(true);
    }, function () { /* plugin failures never affect the screen */ });
  };

  // Called when coming back from details or the player: progress may have changed.
  RecommendedMode.prototype.refresh = function () {
    if (!this.hubs || Date.now() - this.loadedAt < 15000) return;
    var self = this;
    this.loadedAt = Date.now();
    PL.plex.get('/hubs/sections/' + this.screen.section.key, { count: 20, excludeFields: 'file' }).then(function (mc) {
      if (!self.alive) return;
      var fresh = {};
      (mc.Hub || []).forEach(function (h) { fresh[h.hubIdentifier] = h; });
      self.hubs.forEach(function (hub, i) {
        var h = fresh[hub.hubIdentifier];
        if (h && h.Metadata) self.stack.zones[i].replaceItems(h.Metadata, h.more ? h.size + 100 : h.size);
      });
    }, function () { /* keep what is on screen */ });
  };

  RecommendedMode.prototype.setFocused = function (on) {
    this.focused = on;
    if (this.stack.zones.length) this.stack.focus(on);
    if (!on) this.screen.shadow.hide();
  };

  RecommendedMode.prototype.scrolled = function () { return this.focused && this.stack.index > 0; };

  RecommendedMode.prototype.show = function () {
    var z = this.stack.current();
    if (z && z.current()) this.hero.apply(z.current());
    else PL.app.backdrop.set(null, 'hero');
    this.refresh();
  };

  RecommendedMode.prototype.applyScroll = function (scrolled) {
    this.hero.el.classList.toggle('faded', scrolled);
    PL.app.backdrop.dim(scrolled ? 0.35 : 1);
  };

  RecommendedMode.prototype.key = function (code) {
    if (!this.stack.zones.length) return false;
    var handled = this.stack.key(code);
    return handled;
  };

  RecommendedMode.prototype.hide = function () { this.hero.update.cancel(); };
  RecommendedMode.prototype.destroy = function () { this.alive = false; this.hero.update.cancel(); PL.app.backdrop.dim(1); };

  // ---- Library grid ----------------------------------------------------------------------------

  function filtersKey(section) { return 'filters.' + section.key; }

  function AllMode(screen) {
    this.screen = screen;
    var section = this.section = screen.section;
    this.el = PL.el('div', 'mode-all');
    this.sorts = SORTS[section.type] || SORTS.movie;
    this.filters = PL.storage.get(filtersKey(section), null) || { sort: 'titleSort', dir: 'asc', genre: null, decade: null, unwatched: false };
    this.bar = new FilterBar();
    this.bar.el.style.top = '214px';
    this.bar.el.classList.add('fade');
    this.el.appendChild(this.bar.el);
    this.count = PL.el('div', 'page-count fade');
    this.count.style.top = '228px';
    this.el.appendChild(this.count);
    this.empty = PL.el('div', 'grid-empty');
    this.empty.style.top = '320px';
    this.el.appendChild(this.empty);
    var self = this;
    this.grid = new ui.Grid({
      columns: 6,
      shadow: screen.shadow,
      anchor: 90,
      fetchPage: function (start, size) { return self.fetch(start, size); },
      onLoaded: function (total) { self.onLoaded(total); },
      onError: function (err) { self.empty.textContent = PL.errorMessage(err); },
      onFocusItem: function (item) { if (self.screen.visible) self.ambient(item); self.screen.updateHeader(); },
      onSelect: function (item) { PL.app.push(screens.details(item)); },
    });
    this.grid.el.style.top = '320px';
    this.el.appendChild(this.grid.el);
    this.area = 'bar';
    this.ambient = PL.debounce(function (item) {
      if (item && self.screen.visible) PL.app.backdrop.set(ui.ambient(ui.artPath(item)), 'ambient');
    }, 400);
    this.paintBar();
    this.grid.reset(0);
  }

  AllMode.prototype.sortDef = function () {
    var f = this.filters;
    return this.sorts.filter(function (s) { return s.key === f.sort; })[0] || this.sorts[0];
  };

  AllMode.prototype.fetch = function (start, size) {
    var f = this.filters;
    var params = {
      type: this.section.type === 'show' ? 2 : 1,
      sort: f.sort + (f.dir === 'desc' ? ':desc' : ''),
      includeCollections: 0,
      excludeFields: 'summary',
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
    };
    if (f.genre) params.genre = f.genre.key;
    if (f.decade) params.decade = f.decade.key;
    if (f.unwatched) params.unwatched = 1;
    return PL.plex.get('/library/sections/' + this.section.key + '/all', params).then(function (mc) {
      return { total: mc.totalSize != null ? mc.totalSize : (mc.size || 0), items: mc.Metadata || [] };
    });
  };

  AllMode.prototype.onLoaded = function (total) {
    this.count.textContent = total ? total.toLocaleString() + (total === 1 ? ' title' : ' titles') : '';
    this.empty.textContent = total ? '' : 'Nothing matches these filters';
    if (!total && this.area === 'grid') {
      this.area = 'bar';
      this.grid.setFocused(false);
      this.bar.setFocused(this.focused);
    }
  };

  AllMode.prototype.paintBar = function () {
    var self = this;
    var f = this.filters;
    var sort = this.sortDef();
    this.bar.set([
      { label: 'Sort', value: sort.label + (f.dir === 'desc' ? ' ↓' : ' ↑'), action: function () { self.pickSort(); } },
      { label: 'Genre', value: f.genre ? f.genre.title : 'All', active: !!f.genre, action: function () { self.pickTag('genre'); } },
      { label: 'Decade', value: f.decade ? f.decade.title : 'All', active: !!f.decade, action: function () { self.pickTag('decade'); } },
      { label: 'Unwatched', active: f.unwatched, action: function () { f.unwatched = !f.unwatched; self.apply(); } },
    ].concat(f.genre || f.decade || f.unwatched ? [{ label: 'Clear filters', action: function () { f.genre = f.decade = null; f.unwatched = false; self.apply(); } }] : []));
  };

  AllMode.prototype.apply = function () {
    PL.storage.set(filtersKey(this.section), this.filters);
    this.paintBar();
    this.count.textContent = '';
    this.empty.textContent = '';
    this.grid.reset(0);
  };

  AllMode.prototype.pickSort = function () {
    var self = this;
    var f = this.filters;
    PL.app.push(screens.sheet([{
      heading: 'Sort by',
      rows: this.sorts.map(function (s) {
        var on = s.key === f.sort;
        return {
          label: s.label, sub: on ? (f.dir === 'desc' ? 'descending' : 'ascending') : '', checked: on,
          action: function () {
            if (on) f.dir = f.dir === 'desc' ? 'asc' : 'desc';
            else { f.sort = s.key; f.dir = s.dir; }
            self.apply();
          },
        };
      }),
    }]));
  };

  AllMode.prototype.pickTag = function (kind) {
    var self = this;
    var f = this.filters;
    if (this.picking) return;
    this.picking = true;
    PL.plex.get('/library/sections/' + this.section.key + '/' + kind, { type: this.section.type === 'show' ? 2 : 1 }).then(function (mc) {
      self.picking = false;
      if (self.alive === false || PL.app.top() !== self.screen) return;
      var dirs = mc.Directory || [];
      var rows = [{ label: 'All', checked: !f[kind], action: function () { f[kind] = null; self.apply(); } }];
      dirs.forEach(function (d) {
        rows.push({
          label: d.title, checked: !!f[kind] && String(f[kind].key) === String(d.key),
          action: function () { f[kind] = { key: d.key, title: d.title }; self.apply(); },
        });
      });
      PL.app.push(screens.sheet([{ heading: kind === 'genre' ? 'Genre' : 'Decade', rows: rows }]));
    }, function (err) { self.picking = false; PL.toast(PL.errorMessage(err)); });
  };

  AllMode.prototype.setFocused = function (on) {
    this.focused = on;
    this.bar.setFocused(on && this.area === 'bar');
    this.grid.setFocused(on && this.area === 'grid');
    if (!on) this.screen.shadow.hide();
  };

  AllMode.prototype.scrolled = function () { return this.focused && this.area === 'grid' && this.grid.rowOf(this.grid.index) > 0; };

  AllMode.prototype.applyScroll = function (scrolled) {
    this.bar.el.classList.toggle('faded', scrolled);
    this.count.classList.toggle('faded', scrolled);
  };

  AllMode.prototype.show = function () {
    var item = this.grid.items[this.grid.index];
    PL.app.backdrop.set(item ? ui.ambient(ui.artPath(item)) : null, 'ambient');
  };

  AllMode.prototype.key = function (code) {
    if (this.area === 'bar') {
      if (this.bar.key(code)) return true;
      if (code === K.DOWN && this.grid.total > 0) {
        this.area = 'grid';
        this.bar.setFocused(false);
        this.grid.setFocused(true);
        return true;
      }
      return false;
    }
    if (this.grid.key(code)) return true;
    if (code === K.UP) {
      this.area = 'bar';
      this.grid.setFocused(false);
      this.bar.setFocused(true);
      return true;
    }
    return false;
  };

  AllMode.prototype.hide = function () { this.ambient.cancel(); };
  AllMode.prototype.destroy = function () { this.alive = false; this.ambient.cancel(); };

  // ---- Collections ---------------------------------------------------------------------------------

  function CollectionsMode(screen) {
    this.screen = screen;
    var section = screen.section;
    this.el = PL.el('div', 'mode-col');
    this.count = PL.el('div', 'page-count fade');
    this.count.style.top = '228px';
    this.el.appendChild(this.count);
    this.empty = PL.el('div', 'grid-empty');
    this.empty.style.top = '310px';
    this.el.appendChild(this.empty);
    var self = this;
    this.grid = new ui.Grid({
      columns: 6,
      shadow: screen.shadow,
      anchor: 90,
      fetchPage: function (start, size) {
        return PL.plex.get('/library/sections/' + section.key + '/collections', {
          'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size,
        }).then(function (mc) {
          return { total: mc.totalSize != null ? mc.totalSize : (mc.size || 0), items: mc.Metadata || [] };
        });
      },
      onLoaded: function (total) {
        self.count.textContent = total ? total + (total === 1 ? ' collection' : ' collections') : '';
        self.empty.textContent = total ? '' : 'No collections in this library';
      },
      onError: function (err) { self.empty.textContent = PL.errorMessage(err); },
      onFocusItem: function (item) { if (self.screen.visible) self.ambient(item); self.screen.updateHeader(); },
      onSelect: function (item) {
        PL.app.push(screens.items(item.title, '/library/collections/' + item.ratingKey + '/children', {}));
      },
    });
    this.grid.el.style.top = '300px';
    this.el.appendChild(this.grid.el);
    this.ambient = PL.debounce(function (item) {
      if (item && self.screen.visible) PL.app.backdrop.set(ui.ambient(item.art || item.thumb), 'ambient');
    }, 400);
    this.grid.reset(0);
  }

  CollectionsMode.prototype.setFocused = function (on) {
    this.focused = on;
    this.grid.setFocused(on);
    if (!on) this.screen.shadow.hide();
  };
  CollectionsMode.prototype.scrolled = function () { return this.focused && this.grid.rowOf(this.grid.index) > 0; };
  CollectionsMode.prototype.applyScroll = function (scrolled) { this.count.classList.toggle('faded', scrolled); };
  CollectionsMode.prototype.show = function () {
    var item = this.grid.items[this.grid.index];
    PL.app.backdrop.set(item ? ui.ambient(item.art || item.thumb) : null, 'ambient');
  };
  CollectionsMode.prototype.key = function (code) { return this.grid.total > 0 && this.grid.key(code); };
  CollectionsMode.prototype.hide = function () { this.ambient.cancel(); };
  CollectionsMode.prototype.destroy = function () { this.ambient.cancel(); };

  // ---- The screen ----------------------------------------------------------------------------------

  var MODES = [
    { label: 'Recommended', value: 'rec', make: function (s) { return new RecommendedMode(s); } },
    { label: 'Library', value: 'all', make: function (s) { return new AllMode(s); } },
    { label: 'Collections', value: 'col', make: function (s) { return new CollectionsMode(s); } },
  ];

  function LibraryScreen(section) {
    this.root = true;
    this.longPress = true;
    this.section = section;
    this.el = PL.el('div', 'library');
    this.shadow = new ui.FocusShadow();
    this.modeHost = PL.el('div', 'mode-host');
    this.el.appendChild(this.modeHost);
    var self = this;
    var saved = PL.storage.get('mode.' + section.key, 'rec');
    var selected = Math.max(0, MODES.map(function (m) { return m.value; }).indexOf(saved));
    this.subnav = new ui.ChipRow(MODES.map(function (m) { return { label: m.label, value: m.value }; }), {
      selected: selected,
      onChange: function (value, i) { self.setMode(i); },
    });
    this.subnav.el.classList.add('subnav-row', 'fade');
    this.subnav.el.style.top = '136px';
    this.el.appendChild(this.subnav.el);
    this.area = 'content';
    this.mode = null;
    this.setMode(selected);
  }

  LibraryScreen.prototype.setMode = function (i) {
    if (this.mode) {
      this.mode.setFocused(false);
      if (this.mode.destroy) this.mode.destroy();
      this.modeHost.removeChild(this.mode.el);
    }
    this.shadow.hide();
    if (this.shadow.el.parentNode) this.shadow.el.parentNode.removeChild(this.shadow.el);
    this.modeIndex = i;
    PL.storage.set('mode.' + this.section.key, MODES[i].value);
    this.mode = MODES[i].make(this);
    this.modeHost.appendChild(this.mode.el);
    if (this.visible) this.mode.show();
    if (this.area === 'content' && !PL.app.tabsFocused) this.mode.setFocused(true);
    this.updateHeader();
  };

  LibraryScreen.prototype.updateHeader = function () {
    var scrolled = this.area === 'content' && !PL.app.tabsFocused && this.mode && this.mode.scrolled();
    PL.app.tabs.show(!scrolled && this.visible);
    this.subnav.el.classList.toggle('faded', !!scrolled);
    if (this.mode && this.mode.applyScroll) this.mode.applyScroll(!!scrolled);
  };

  LibraryScreen.prototype.focusArea = function (area) {
    this.area = area;
    this.subnav.setFocused(area === 'subnav');
    if (this.mode) this.mode.setFocused(area === 'content');
    this.updateHeader();
  };

  LibraryScreen.prototype.focusFromTabs = function () { this.focusArea('subnav'); };

  LibraryScreen.prototype.onTabsFocus = function () {
    this.subnav.setFocused(false);
    if (this.mode) this.mode.setFocused(false);
    this.updateHeader();
  };

  LibraryScreen.prototype.show = function () {
    this.visible = true;
    if (this.mode) this.mode.show();
    if (!PL.app.tabsFocused) this.focusArea(this.area);
  };

  LibraryScreen.prototype.hide = function () {
    this.visible = false;
    if (this.mode && this.mode.hide) this.mode.hide();
    PL.app.backdrop.dim(1);
  };

  LibraryScreen.prototype.destroy = function () {
    if (this.mode && this.mode.destroy) this.mode.destroy();
  };

  LibraryScreen.prototype.key = function (code) {
    if (this.area === 'subnav') {
      if (code === K.DOWN) {
        this.subnav.choose();
        this.focusArea('content');
        return true;
      }
      if (code === K.UP) return PL.app.focusTabs();
      return this.subnav.key(code);
    }
    var handled = this.mode.key(code);
    if (!handled && code === K.UP) {
      this.focusArea('subnav');
      handled = true;
    }
    this.updateHeader();
    return handled;
  };

  screens.library = function (section) { return new LibraryScreen(section); };

  // ---- Generic item grid (a collection, an actor's films, ...) --------------------------------

  // path: list endpoint; params: extra query parameters
  screens.items = function (title, path, params) {
    var el = PL.el('div', 'items-screen');
    var shadow = new ui.FocusShadow();
    var head = PL.el('div', 'page-title fade', title);
    var count = PL.el('div', 'page-count fade');
    el.appendChild(head);
    el.appendChild(count);
    var ambient = PL.debounce(function (item) {
      if (item) PL.app.backdrop.set(ui.ambient(ui.artPath(item)), 'ambient');
    }, 400);
    var grid = new ui.Grid({
      columns: 6,
      shadow: shadow,
      anchor: 90,
      fetchPage: function (start, size) {
        var q = {};
        Object.keys(params || {}).forEach(function (k) { q[k] = params[k]; });
        q['X-Plex-Container-Start'] = start;
        q['X-Plex-Container-Size'] = size;
        return PL.plex.get(path, q).then(function (mc) {
          return { total: mc.totalSize != null ? mc.totalSize : (mc.size || 0), items: mc.Metadata || [] };
        });
      },
      onLoaded: function (total) { count.textContent = total ? total + (total === 1 ? ' title' : ' titles') : 'Nothing here'; },
      onError: function (err) { count.textContent = PL.errorMessage(err); },
      onFocusItem: function (item) {
        ambient(item);
        var scrolled = grid.rowOf(grid.index) > 0;
        head.classList.toggle('faded', scrolled);
        count.classList.toggle('faded', scrolled);
      },
      onSelect: function (item) { PL.app.push(screens.details(item)); },
    });
    grid.el.style.top = '260px';
    el.appendChild(grid.el);
    grid.reset(0);
    return {
      el: el,
      longPress: true,
      show: function () {
        var item = grid.items[grid.index];
        PL.app.backdrop.set(item ? ui.ambient(ui.artPath(item)) : null, 'ambient');
        grid.setFocused(true);
      },
      hide: function () { ambient.cancel(); grid.setFocused(false); },
      destroy: function () { ambient.cancel(); },
      key: function (code) { return grid.key(code); },
    };
  };
})();
