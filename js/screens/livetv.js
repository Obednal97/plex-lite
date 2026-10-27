// Live TV: "On now" channel list from the Plex DVR guide, with filters and lazily fetched "Next".
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;

  var ROW_PITCH = 120;
  var LIST_TOP = 230;
  var SCROLL_LIFT = 170; // how far the list moves up once the header hides

  var FILTERS = [
    { label: 'All', value: 'all', test: function () { return true; } },
    { label: 'Movies', value: 'movies', test: function (c) { return c.now.type === 'movie'; } },
    { label: 'Shows', value: 'shows', test: function (c) { return c.now.type === 'episode'; } },
    {
      label: 'Sports', value: 'sports', test: function (c) {
        return /sport|football|soccer|golf|tennis|cricket|rugby|boxing|racing|wrestling|nfl|nba|nhl|mlb/i.test(c.genres) ||
          /sport|espn|bein|dazn|eurosport|premier|racing|golf|nfl|nba/i.test(c.title);
      },
    },
    {
      label: 'News', value: 'news', test: function (c) {
        return /news/i.test(c.genres) || /news|cnn|cnbc|bloomberg|al jazeera|msnbc|euronews/i.test(c.title);
      },
    },
  ];

  var source = null; // {dvrKey, provider}, discovered once per session

  function discover() {
    if (source) return Promise.resolve(source);
    return Promise.all([PL.plex.get('/livetv/dvrs'), PL.plex.get('/media/providers')]).then(function (res) {
      var dvr = (res[0].Dvr || [])[0];
      var provider = (res[1].MediaProvider || []).filter(function (p) {
        return (p.protocols || '').indexOf('livetv') !== -1;
      })[0];
      if (!dvr || !provider) {
        var err = new Error('Live TV isn\'t set up on this Plex server');
        err.noDvr = true;
        throw err;
      }
      source = { dvrKey: dvr.key, provider: provider.identifier };
      return source;
    });
  }

  function now() { return Math.floor(Date.now() / 1000); }

  function hhmm(sec) {
    var d = new Date(sec * 1000);
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function programmeTitle(p) {
    if (p.type === 'episode') {
      var t = p.grandparentTitle || p.title || '';
      if (p.parentIndex != null && p.index != null) t += '  ·  S' + p.parentIndex + ' E' + p.index;
      return t;
    }
    return p.title || '';
  }

  function cleanChannelName(media) {
    var title = media.channelTitle || media.channelCallSign || '';
    var vcn = String(media.channelVcn || '');
    if (vcn && title.indexOf(vcn + ' ') === 0) title = title.slice(vcn.length + 1);
    return title;
  }

  // One entry per channel airing something now; an item can list several channels (Media entries).
  function buildChannels(items) {
    var byId = {};
    items.forEach(function (p) {
      var genres = (p.Genre || []).map(function (g) { return g.tag; }).join(' ');
      (p.Media || []).forEach(function (m) {
        var id = String(m.channelIdentifier);
        if (byId[id]) return;
        byId[id] = {
          identifier: id,
          id: m.channelID,
          vcn: String(m.channelVcn || id),
          title: cleanChannelName(m),
          thumb: m.channelThumb || null,
          genres: genres,
          now: {
            type: p.type,
            title: programmeTitle(p),
            art: p.thumb || p.grandparentThumb || null,
            beginsAt: m.beginsAt,
            endsAt: m.endsAt,
          },
        };
      });
    });
    var list = Object.keys(byId).map(function (k) { return byId[k]; });
    list.sort(function (a, b) {
      var d = (parseFloat(a.vcn) || 0) - (parseFloat(b.vcn) || 0);
      return d || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    });
    return list;
  }

  function LiveTVScreen() {
    this.root = true;
    this.el = PL.el('div', 'livetv');
    this.guide = PL.el('div', 'guide');
    this.inner = PL.el('div', 'guide-inner');
    this.guide.appendChild(this.inner);
    this.el.appendChild(this.guide);
    this.status = PL.el('div', 'loading');
    this.status.appendChild(ui.spinner());
    this.status.appendChild(PL.el('div', '', 'Loading the guide…'));
    this.el.appendChild(this.status);
    this.subnavHost = PL.el('div', 'livetv-subnav');
    this.el.appendChild(this.subnavHost);
    this.all = [];
    this.list = [];
    this.index = 0;
    this.nodes = {};
    this.nextCache = {};
    this.nextQueue = [];
    this.nextActive = 0;
    this.filter = PL.storage.get('livetv.filter', 'all');
    this.area = 'list';
    this.visible = false;
    this.alive = true;
    this.loadedAt = 0;
    this.loading = false;
    this.loadGen = 0;
    this.byId = {};
    var self = this;
    this.ambient = PL.debounce(function (c) {
      if (c && self.visible) PL.app.backdrop.set(c.now.art ? ui.ambient(c.now.art) : null, 'ambient');
    }, 500);
    this.buildSubnav([FILTERS[0]]);
    this.load();
  }

  LiveTVScreen.prototype.buildSubnav = function (filters) {
    var self = this;
    PL.clear(this.subnavHost);
    this.filters = filters;
    var selected = Math.max(0, filters.map(function (f) { return f.value; }).indexOf(this.filter));
    this.subnav = new ui.ChipRow(filters.map(function (f) { return { label: f.label, value: f.value }; }), {
      selected: selected,
      onChange: function (value) { self.setFilter(value); },
    });
    this.subnav.el.classList.add('fade');
    this.subnav.el.style.top = '136px';
    this.subnavHost.appendChild(this.subnav.el);
    this.subnav.setFocused(this.area === 'subnav' && this.visible && !PL.app.tabsFocused);
  };

  LiveTVScreen.prototype.load = function () {
    var self = this;
    if (this.loading) return;
    this.loading = true;
    var gen = ++this.loadGen;
    var t = now();
    discover().then(function (src) {
      self.src = src;
      return PL.plex.get('/' + src.provider + '/grid', {
        type: '1,4',
        'beginsAt<': t,
        'endsAt>': t,
        excludeElements: 'Image,Channel',
        excludeFields: 'summary',
      }, { timeout: 20000 });
    }).then(function (mc) {
      if (gen !== self.loadGen) return;
      self.loading = false;
      if (!self.alive) return;
      self.loadedAt = Date.now();
      self.all = buildChannels(mc.Metadata || []);
      self.byId = {};
      self.all.forEach(function (c) { self.byId[c.identifier] = c; });
      self.pruneNext(now());
      var available = FILTERS.filter(function (f) { return self.all.some(f.test); });
      if (available.map(function (f) { return f.value; }).indexOf(self.filter) === -1) self.filter = 'all';
      var values = available.map(function (f) { return f.value; }).join(',');
      if (values !== (self.filters || []).map(function (f) { return f.value; }).join(',')) self.buildSubnav(available);
      self.applyFilter(true);
    }, function (err) {
      if (gen !== self.loadGen) return;
      self.loading = false;
      if (!self.alive) return;
      PL.warn('guide load failed', err && err.message);
      if (self.all.length) return; // keep the last guide on screen; try again next tick
      self.showStatus(err && err.noDvr ? err.message : 'Couldn\'t load the guide: ' + PL.errorMessage(err));
    });
  };

  LiveTVScreen.prototype.showStatus = function (text) {
    PL.clear(this.status);
    this.status.appendChild(PL.el('div', '', text));
    this.status.style.display = '';
  };

  LiveTVScreen.prototype.setFilter = function (value) {
    this.filter = value;
    PL.storage.set('livetv.filter', value);
    this.applyFilter(false);
  };

  // Keeps "Next" entries that are still in the future and still follow the channel's current programme.
  LiveTVScreen.prototype.pruneNext = function (t) {
    var self = this;
    Object.keys(this.nextCache).forEach(function (id) {
      var n = self.nextCache[id];
      var c = self.byId[id];
      if (n.pending) return; // its response is checked against the current programme when it lands
      if (!c || !n.beginsAt || n.beginsAt <= t || n.beginsAt < c.now.endsAt - 60) delete self.nextCache[id];
    });
  };

  function sameProgramme(a, b) {
    return a.now.beginsAt === b.now.beginsAt && a.now.endsAt === b.now.endsAt && a.now.title === b.now.title;
  }

  // keepFocus: stay on the same channel (guide refresh); otherwise start at the top. When a refresh
  // leaves the channel order unchanged, only rows whose programme changed are rebuilt.
  LiveTVScreen.prototype.applyFilter = function (keepFocus) {
    var focusedId = keepFocus && this.list[this.index] ? this.list[this.index].identifier : null;
    var f = FILTERS.filter(function (x) { return x.value === this.filter; }, this)[0] || FILTERS[0];
    var old = this.list;
    var list = this.all.filter(f.test);
    var sameOrder = keepFocus && old.length === list.length && list.every(function (c, i) { return old[i].identifier === c.identifier; });
    this.list = list;
    if (sameOrder && list.length) {
      this.updateRowsInPlace();
      return;
    }
    var idx = 0;
    if (focusedId) {
      for (var i = 0; i < this.list.length; i++) if (this.list[i].identifier === focusedId) { idx = i; break; }
    }
    this.index = idx;
    this.clearRows();
    if (!this.list.length) {
      this.showStatus(this.all.length ? 'Nothing on these channels right now' : 'No channels are airing anything right now');
      if (this.area === 'list') this.focusArea('subnav');
    } else {
      this.status.style.display = 'none';
    }
    this.render();
    this.updateHeader();
    if (this.area === 'list') this.ambient(this.list[this.index]);
  };

  LiveTVScreen.prototype.updateRowsInPlace = function () {
    var self = this;
    Object.keys(this.nodes).forEach(function (k) {
      var i = Number(k);
      var row = self.nodes[k];
      var fresh = self.list[i];
      if (sameProgramme(row.channel, fresh)) {
        row.channel = fresh;
        self.paintProgress(row);
        self.paintNext(row);
        return;
      }
      var replacement = self.makeRow(fresh, i);
      PL.translate(replacement.el, 0, i * ROW_PITCH);
      self.inner.replaceChild(replacement.el, row.el);
      self.nodes[k] = replacement;
      self.requestNext(fresh);
    });
    this.render();
    if (this.area === 'list') this.ambient(this.list[this.index]);
  };

  LiveTVScreen.prototype.clearRows = function () {
    var self = this;
    Object.keys(this.nodes).forEach(function (k) { self.inner.removeChild(self.nodes[k].el); });
    this.nodes = {};
  };

  LiveTVScreen.prototype.scrollY = function () {
    return this.index <= 2 ? 0 : (this.index - 2) * ROW_PITCH + SCROLL_LIFT;
  };

  LiveTVScreen.prototype.render = function () {
    PL.translate(this.inner, 0, LIST_TOP - this.scrollY());
    var first = Math.max(0, this.index - 4);
    var last = Math.min(this.list.length - 1, this.index + 8);
    var self = this;
    Object.keys(this.nodes).forEach(function (k) {
      var i = Number(k);
      if (i < first || i > last) {
        self.inner.removeChild(self.nodes[k].el);
        delete self.nodes[k];
      }
    });
    for (var i = first; i <= last; i++) {
      var row = this.nodes[i];
      if (!row) {
        row = this.makeRow(this.list[i], i);
        PL.translate(row.el, 0, i * ROW_PITCH);
        this.inner.appendChild(row.el);
        this.nodes[i] = row;
      }
      this.requestNext(row.channel); // no-op when cached or in flight
      row.el.classList.toggle('focused', this.area === 'list' && this.visible && !PL.app.tabsFocused && i === this.index);
    }
  };

  LiveTVScreen.prototype.makeRow = function (c, i) {
    var el = PL.el('div', 'channel');
    var logo = PL.el('div', 'channel-logo');
    var src = c.thumb ? PL.plex.image(c.thumb, 112, 60, { format: 'png' }) : null;
    if (src) {
      var img = PL.el('img');
      img.width = 112;
      img.height = 60;
      img.onload = function () { logo.classList.add('loaded'); };
      img.onerror = function () { img.style.visibility = 'hidden'; };
      img.src = src;
      logo.appendChild(img);
    }
    el.appendChild(logo);
    el.appendChild(PL.el('div', 'channel-num', c.vcn));
    el.appendChild(PL.el('div', 'channel-name', c.title));
    el.appendChild(PL.el('div', 'channel-now', c.now.title));
    var time = PL.el('div', 'channel-time');
    el.appendChild(time);
    var bar = PL.el('div', 'channel-bar');
    var fill = PL.el('div', 'channel-bar-fill');
    bar.appendChild(fill);
    el.appendChild(bar);
    var next = PL.el('div', 'channel-next');
    el.appendChild(next);
    var self = this;
    el.addEventListener('click', function () {
      self.index = i;
      self.focusArea('list');
      self.play();
    });
    var row = { el: el, time: time, fill: fill, next: next, channel: c };
    this.paintProgress(row);
    this.paintNext(row);
    return row;
  };

  LiveTVScreen.prototype.paintProgress = function (row) {
    var p = row.channel.now;
    row.time.textContent = hhmm(p.beginsAt) + ' – ' + hhmm(p.endsAt);
    var span = Math.max(1, p.endsAt - p.beginsAt);
    var frac = PL.clamp((now() - p.beginsAt) / span, 0, 1);
    row.fill.style.transform = 'scaleX(' + frac.toFixed(3) + ')';
  };

  LiveTVScreen.prototype.paintNext = function (row) {
    var n = this.nextCache[row.channel.identifier];
    PL.clear(row.next);
    if (!n || !n.title) return;
    row.next.appendChild(document.createTextNode('Next  ' + hhmm(n.beginsAt)));
    row.next.appendChild(PL.el('b', '', n.title));
  };

  // "Next" is fetched per visible channel (a whole-guide window is megabytes), at most 2 at a time.
  // The grid's channel filter matches programmes linked to a channel, not airings on it, so the
  // request is a narrow time window just after the current programme ends.
  LiveTVScreen.prototype.requestNext = function (c, tries) {
    if (!c || c.id == null || !this.src) return;
    var entry = this.nextCache[c.identifier];
    if (entry && !(tries && entry.retry)) return;
    this.nextCache[c.identifier] = { pending: true, tries: tries || 0 };
    this.nextQueue.push(c);
    this.pumpNext();
  };

  LiveTVScreen.prototype.fetchNext = function (c, spanSec) {
    return PL.plex.get('/' + this.src.provider + '/grid', {
      type: '1,4',
      channel: c.id,
      'beginsAt>': c.now.endsAt - 60,
      'beginsAt<': c.now.endsAt + spanSec,
      excludeElements: 'Image,Channel',
      excludeFields: 'summary',
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': 10,
    }, { timeout: 10000 }).then(function (mc) {
      var best = null;
      (mc.Metadata || []).forEach(function (p) {
        (p.Media || []).forEach(function (m) {
          if (String(m.channelIdentifier) !== c.identifier || m.beginsAt < c.now.endsAt - 60) return;
          if (!best || m.beginsAt < best.beginsAt) best = { title: programmeTitle(p), beginsAt: m.beginsAt };
        });
      });
      return best;
    });
  };

  LiveTVScreen.prototype.pumpNext = function () {
    var self = this;
    while (this.nextActive < 2 && this.nextQueue.length) {
      var c = this.nextQueue.shift();
      if (!this.isRendered(c.identifier)) {
        delete this.nextCache[c.identifier]; // asked again if the row comes back
        continue;
      }
      this.nextActive++;
      (function (c, tries) {
        self.fetchNext(c, 1800).then(function (n) {
          // a gap in the guide: look further ahead once
          return n || (self.alive ? self.fetchNext(c, 4 * 3600) : null);
        }).then(function (n) {
          if (!self.alive) return;
          var cur = self.byId[c.identifier];
          if (!cur || cur.now.endsAt !== c.now.endsAt) {
            delete self.nextCache[c.identifier]; // the guide moved on while this was in flight
            if (cur && self.isRendered(c.identifier)) self.requestNext(cur);
            return;
          }
          self.nextCache[c.identifier] = n || { title: '', beginsAt: 0 };
          self.paintNextFor(c.identifier);
        }, function () {
          if (!self.alive) return;
          if (tries >= 1) {
            self.nextCache[c.identifier] = { title: '', beginsAt: 0 };
            return;
          }
          self.nextCache[c.identifier] = { retry: true };
          setTimeout(function () {
            if (self.alive && self.isRendered(c.identifier)) self.requestNext(self.byId[c.identifier] || c, 1);
            else if (self.alive) delete self.nextCache[c.identifier];
          }, 1500);
        }).then(function () {
          self.nextActive--;
          if (self.alive) self.pumpNext();
        });
      })(c, (this.nextCache[c.identifier] || {}).tries || 0);
    }
  };

  LiveTVScreen.prototype.isRendered = function (identifier) {
    var nodes = this.nodes;
    return Object.keys(nodes).some(function (k) { return nodes[k].channel.identifier === identifier; });
  };

  LiveTVScreen.prototype.paintNextFor = function (identifier) {
    var self = this;
    Object.keys(this.nodes).forEach(function (k) {
      if (self.nodes[k].channel.identifier === identifier) self.paintNext(self.nodes[k]);
    });
  };

  // Every minute: advance progress bars. Re-read the guide every 5 minutes, or sooner when a
  // programme on a row that is on screen (or the focused one) has ended.
  LiveTVScreen.prototype.tick = function () {
    var self = this;
    var t = now();
    var focused = this.list[this.index];
    var ended = (focused && focused.now.endsAt <= t) ||
      Object.keys(this.nodes).some(function (k) { return self.nodes[k].channel.now.endsAt <= t; });
    Object.keys(this.nodes).forEach(function (k) { self.paintProgress(self.nodes[k]); });
    if (ended || Date.now() - this.loadedAt >= 5 * 60 * 1000) this.load();
  };

  LiveTVScreen.prototype.updateHeader = function () {
    var scrolled = this.area === 'list' && !PL.app.tabsFocused && this.index > 2;
    if (this.visible) PL.app.tabs.show(!scrolled);
    this.subnav.el.classList.toggle('faded', scrolled);
  };

  LiveTVScreen.prototype.focusArea = function (area) {
    this.area = area;
    this.subnav.setFocused(area === 'subnav');
    this.render();
    this.updateHeader();
    if (area === 'list') this.ambient(this.list[this.index]);
  };

  LiveTVScreen.prototype.move = function (next) {
    next = PL.clamp(next, 0, this.list.length - 1);
    if (next === this.index) return;
    this.index = next;
    this.render();
    this.updateHeader();
    this.ambient(this.list[this.index]);
  };

  LiveTVScreen.prototype.play = function () {
    var c = this.list[this.index];
    if (!c || !this.src) return;
    var shape = function (x) { return { identifier: x.identifier, id: x.id, vcn: x.vcn, title: x.title, thumb: x.thumb }; };
    PL.app.push(screens.player(null, {
      live: {
        dvrKey: this.src.dvrKey,
        channel: shape(c),
        channels: this.list.map(shape),
        index: this.index,
      },
    }));
  };

  LiveTVScreen.prototype.key = function (code) {
    if (this.area === 'subnav') {
      if (code === K.DOWN) {
        this.subnav.choose();
        if (this.list.length) this.focusArea('list');
        return true;
      }
      if (code === K.UP) return PL.app.focusTabs();
      return this.subnav.key(code);
    }
    if (!this.list.length) return false;
    if (code === K.UP) {
      if (this.index === 0) {
        this.focusArea('subnav');
        return true;
      }
      this.move(this.index - 1);
      return true;
    }
    if (code === K.DOWN) {
      this.move(this.index + 1);
      return true;
    }
    if (code === K.CH_DOWN) {
      this.move(this.index + 6);
      return true;
    }
    if (code === K.CH_UP) {
      this.move(this.index - 6);
      return true;
    }
    if (code === K.ENTER) {
      this.play();
      return true;
    }
    return code === K.LEFT || code === K.RIGHT;
  };

  LiveTVScreen.prototype.focusFromTabs = function () {
    this.focusArea('subnav');
  };

  LiveTVScreen.prototype.onTabsFocus = function () {
    this.subnav.setFocused(false);
    this.render();
    this.updateHeader();
  };

  LiveTVScreen.prototype.show = function () {
    var self = this;
    this.visible = true;
    var c = this.list[this.index];
    PL.app.backdrop.set(c && c.now.art ? ui.ambient(c.now.art) : null, 'ambient');
    clearInterval(this.timer);
    this.timer = setInterval(function () { self.tick(); }, 60000);
    if (this.loadedAt) this.tick();
    if (!PL.app.tabsFocused) this.focusArea(this.list.length ? this.area : 'subnav');
  };

  LiveTVScreen.prototype.hide = function () {
    this.visible = false;
    clearInterval(this.timer);
    this.timer = null;
    this.ambient.cancel();
    this.render();
  };

  LiveTVScreen.prototype.destroy = function () {
    this.alive = false;
    this.visible = false;
    this.loadGen++;
    clearInterval(this.timer);
    this.timer = null;
    this.ambient.cancel();
    this.nextQueue = [];
  };

  screens.livetv = function () { return new LiveTVScreen(); };
})();
