// Search tab: on-screen keyboard on the left, results on the right. Titles come from the local
// fuzzy index on every keystroke; episodes and people come from the server, debounced.
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
    this.stack = new ui.VStack(this.results, {
      top: 150,
      keep: 3,
      anchor: function (i, top, zone) { return i === 0 ? top : Math.min(top, 1040 - zone.height); },
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
      this.server = { titles: [], people: [], episodes: [] };
      this.serverDone = false;
      this.render();
      return;
    }
    this.local = PL.fuzzy.ready ? PL.fuzzy.query(q, 40) : [];
    this.render();
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
      self.render();
    });
  };

  SearchScreen.prototype.parseServer = function (mc) {
    var out = { titles: [], people: [], episodes: [] };
    var sectionTitle = {};
    (PL.app.sections || []).forEach(function (s) { sectionTitle[String(s.key)] = s.title; });
    (mc.Hub || []).forEach(function (hub) {
      if ((hub.type === 'movie' || hub.type === 'show') && hub.Metadata) {
        out.titles = out.titles.concat(hub.Metadata);
      } else if (hub.type === 'episode' && hub.Metadata) {
        out.episodes = hub.Metadata.slice(0, 30);
      } else if (hub.type === 'actor' && hub.Directory) {
        var names = {};
        hub.Directory.forEach(function (d) { names[d.tag] = (names[d.tag] || 0) + 1; });
        out.people = hub.Directory.map(function (d) {
          var section = String(d.librarySectionID);
          return {
            ratingKey: 'actor-' + d.id + '-' + section,
            type: 'person',
            title: names[d.tag] > 1 && sectionTitle[section] ? d.tag + ' (' + sectionTitle[section] + ')' : d.tag,
            thumb: d.thumb,
            person: { id: d.id, name: d.tag, section: section },
          };
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
      if (titles.length) sections.push({ id: 'titles', title: 'Movies & Shows', kind: 'poster', items: titles });
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
    if (!q) text = this.indexError ? 'Search is limited: ' + PL.errorMessage(this.indexError) : 'Search movies, shows, episodes and people';
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
      if (shelf) {
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
        onFocusItem: function (item) { self.focusedItem(item); },
        onSelect: function (item) { self.open(item); },
      });
      shelf.sectionId = s.id;
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
    var keep = sameQuery && focusedId ? ids.indexOf(focusedId) : -1;
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
    if (item.plugin) {
      PL.plugins.select(item);
      return;
    }
    if (item.type === 'person') {
      var p = item.person;
      PL.app.push(screens.items(p.name, '/library/sections/' + p.section + '/all', { actor: p.id }));
      return;
    }
    PL.app.push(screens.details(item));
  };

  SearchScreen.prototype.focusResults = function () {
    if (!this.stack.zones.length) return;
    this.area = 'results';
    this.paintKeys();
    this.stack.focus(true);
  };

  SearchScreen.prototype.focusKeys = function () {
    this.area = 'keys';
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
    this.runServer.cancel();
    this.runPlugins.cancel();
    this.pluginSeq++;
    this.ambient.cancel();
    this.abortServer();
  };

  screens.search = function () { return new SearchScreen(); };
})();
