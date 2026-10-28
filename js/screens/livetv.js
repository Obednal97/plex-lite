// Live TV tab: a two-hour time grid of every channel (docs/LIVETV-v2-design.md). The focused
// programme's details and artwork sit above the grid; the chip row above that shows the Browse
// choice and its refinements (docs/LIVETV-browse-design.md: Blue, Left at the start of the grid or
// OK on the first chip open the Browse rail; its On now choice swaps the grid for the On now wall).
// Rows and cells are virtualised: only the rows near the focus exist, each with the cells of a few
// hours around the view, and scrolling is a transform on two tracks.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;
  var L = PL.liveLogic;
  var G = PL.liveGuide;
  var B = PL.liveBrowse;

  var STEP = L.HALF_HOUR;
  var SPAN = 4 * STEP;          // two hours in view
  var GRID_X = 412;             // where programmes start (the channel column is 96..396)
  var GRID_W = 1412;            // to 1824 (96 px right margin)
  var PPS = GRID_W / SPAN;      // px per second
  var PITCH = 84;               // row pitch (76 px cells, 8 px apart)
  var VISIBLE = 6;              // whole rows in view
  var LEAD = 2;                 // the focus rides this many rows down once the grid scrolls
  var KEEP = 3;                 // rows kept beyond the view each way
  var GAP = 6;                  // px between cells
  var BUCKET = 4 * 3600;        // cells are built for the view +- a bucket, rebuilt when it changes
  var ENTRY_MS = 2000;          // number entry commits after this pause

  var BROWSE_GLYPH = [['path', { d: 'M4 7h16M6.5 12h11M9 17h6' }]];
  var RAIL = '@rail';

  function now() { return Math.floor(Date.now() / 1000); }
  function pointing() { return document.body.classList.contains('pointer'); }

  function LiveTVScreen() {
    this.root = true;
    this.longPress = true;
    this.el = PL.el('div', 'livetv lg');
    this.list = [];             // channels in the current filter
    this.row = 0;               // focused row
    this.cur = null;            // focused airing (null on a row without guide data)
    this.origin = L.floorTo(now(), STEP);
    this.start = this.origin;   // view start
    this.anchor = now();        // the time Up/Down keep
    this.rows = {};             // index -> {chan, cells, track, nodes:[{a, node, label}], key, shifted}
    // opens on Favourites once there are some (the owner's choice); otherwise the last choice
    this.sel = G.favourites().length ? { base: 'fav', refine: null } : G.getBrowse();
    G.setBrowse(this.sel, true);
    this.seenSeq = G.browseSeq;
    this.area = 'grid';
    this.visible = false;
    this.alive = true;
    this.entry = null;          // {digits, timer}
    // Search asked to open on a channel and time ("On TV", "Show in guide"): done once it is loaded
    this.pendingOpen = G.openAt || null;
    G.openAt = null;
    this.build();
    var self = this;
    this.detailSoon = PL.debounce(function () { self.paintDetailSlow(); }, 350);
    this.unlisten = G.listen(function () { if (self.alive) self.onData(); });
    this.wantsBlue = true;
    this.buildChips();
    if (this.isWall()) this.syncMode();
    this.load();
  }

  // ---- DOM ------------------------------------------------------------------------------------------

  LiveTVScreen.prototype.build = function () {
    var el = this.el;
    // details of the focused programme
    var d = this.detail = PL.el('div', 'lg-detail');
    this.dEyebrow = PL.el('div', 'lg-eyebrow');
    this.dTitle = PL.el('div', 'lg-title');
    this.dSub = PL.el('div', 'lg-sub');
    this.dSummary = PL.el('div', 'lg-summary');
    [this.dEyebrow, this.dTitle, this.dSub, this.dSummary].forEach(function (n) { d.appendChild(n); });
    el.appendChild(d);
    this.art = PL.el('div', 'lg-art');
    this.artImg = PL.el('img');
    this.art.appendChild(this.artImg);
    el.appendChild(this.art);
    var self = this;
    this.artImg.onload = function () { self.art.classList.add('loaded'); };
    this.artImg.onerror = function () { self.art.classList.remove('loaded'); };

    // the time ruler
    var ruler = PL.el('div', 'lg-ruler');
    this.dayLabel = PL.el('div', 'lg-day');
    ruler.appendChild(this.dayLabel);
    var rclip = PL.el('div', 'lg-ruler-clip');
    this.rulerTrack = PL.el('div', 'lg-ruler-track');
    rclip.appendChild(this.rulerTrack);
    ruler.appendChild(rclip);
    el.appendChild(ruler);

    // channels (left) and programmes (right): each a clip with a track that scrolls
    var grid = PL.el('div', 'lg-grid');
    var cclip = PL.el('div', 'lg-chans');
    this.chanTrack = PL.el('div', 'lg-track');
    cclip.appendChild(this.chanTrack);
    var pclip = PL.el('div', 'lg-progs');
    // the now line scrolls with time only, under the (translucent) cells so it never crosses a title
    this.nowTrack = PL.el('div', 'lg-track');
    this.nowLine = PL.el('div', 'lg-now');
    this.nowTrack.appendChild(this.nowLine);
    pclip.appendChild(this.nowTrack);
    this.progTrack = PL.el('div', 'lg-track');
    pclip.appendChild(this.progTrack);
    grid.appendChild(cclip);
    grid.appendChild(pclip);
    grid.appendChild(PL.el('div', 'lg-fade'));
    el.appendChild(grid);

    // channel number entry
    this.entryEl = PL.el('div', 'lg-entry entry-hidden');
    this.entryDigits = PL.el('div', 'lg-entry-digits');
    this.entryName = PL.el('div', 'lg-entry-name');
    this.entryEl.appendChild(this.entryDigits);
    this.entryEl.appendChild(this.entryName);
    el.appendChild(this.entryEl);

    this.status = PL.el('div', 'lg-status');
    this.status.appendChild(ui.spinner());
    this.status.appendChild(PL.el('div', '', 'Loading the guide…'));
    el.appendChild(this.status);

    this.subnavHost = PL.el('div', 'livetv-subnav');
    el.appendChild(this.subnavHost);
    this.paintRuler();
  };

  // ---- Browse: the chip row, the filter, the rail and the On now wall --------------------------------

  LiveTVScreen.prototype.isWall = function () { return this.sel.base === 'now'; };

  // [≡ choice] | All … · the other dimension (a category's families, a family's categories); on the
  // wall, its shelves.
  LiveTVScreen.prototype.chipList = function () {
    var ctx = G.browseCtx();
    var base = this.sel.base;
    var first = { label: B.label(base, ctx), value: RAIL, cls: 'chip-browse', glyph: PL.glyph(BROWSE_GLYPH, 30, 2.2) };
    if (this.isWall()) {
      return [first].concat((this.wall ? this.wall.shelves : []).map(function (sh) { return { label: sh.label, value: sh.key }; }));
    }
    var all = { label: B.allLabel(base, ctx), value: '', count: G.channels.length ? B.filter(G.channels, { base: base }, ctx).length : null };
    return [first, all].concat(B.chips(base, G.channels, ctx).map(function (c) { return { label: c.label, value: c.key, count: c.count }; }));
  };

  // The chip that shows the current refinement (or the focused shelf on the wall).
  LiveTVScreen.prototype.chipWanted = function () {
    if (this.isWall()) {
      var sh = this.wall && this.wall.shelves[this.wall.shelfIndex()];
      return sh ? sh.key : null;
    }
    return this.sel.refine || '';
  };

  // Rebuilt only when the chips' labels or counts change; otherwise just reselected.
  LiveTVScreen.prototype.buildChips = function () {
    var self = this;
    var chips = this.chipList();
    var sig = chips.map(function (c) { return c.value + ':' + c.label + ':' + (c.count == null ? '' : c.count); }).join('|');
    var values = chips.map(function (c) { return c.value; });
    var want = values.indexOf(this.chipWanted());
    if (want < 0) want = values.length > 1 ? 1 : 0;
    if (sig === this.chipSig && this.subnav) {
      if (this.subnav.selected !== want) {
        this.subnav.selected = want;
        if (!this.subnav.focused) this.subnav.index = want;
        this.subnav.paint();
      }
      return;
    }
    this.chipSig = sig;
    PL.clear(this.subnavHost);
    this.chips = chips;
    this.subnav = new ui.ChipRow(chips, {
      selected: want,
      onChange: function (value) { self.chooseChip(value); },
    });
    this.subnav.el.style.top = '136px';
    this.subnavHost.appendChild(this.subnav.el);
    this.subnav.setFocused(this.area === 'subnav' && this.visible && !PL.app.tabsFocused && !this.railOpen);
  };

  LiveTVScreen.prototype.chooseChip = function (value) {
    if (value === RAIL) {
      this.openRail();
      return;
    }
    if (this.isWall()) {
      var keys = this.wall.shelves.map(function (sh) { return sh.key; });
      this.wall.focusShelf(Math.max(0, keys.indexOf(value)));
      return;
    }
    this.setSel({ base: this.sel.base, refine: value || null });
  };

  // Applies a filter. focusId: the channel to keep focused (else the first, on now). transient: a
  // preview from the rail (not saved).
  LiveTVScreen.prototype.setSel = function (sel, focusId, transient) {
    var wasWall = this.isWall();
    var next = G.channels.length ? B.normalise(sel, G.browseCtx()) : { base: sel.base, refine: sel.refine || null };
    if (next.base === 'now' && !wasWall && !transient) this.beforeWall = { base: this.sel.base, refine: this.sel.refine };
    this.sel = next;
    G.setBrowse(next, transient);
    this.seenSeq = G.browseSeq;
    this.syncMode();
    // a preview leaves the chips alone (they're behind the rail; saves a layout per preview)
    if (!transient || this.isWall()) this.buildChips();
    if (this.isWall()) return;
    if (this.area === 'wall') this.area = 'grid';
    this.applyFilter(false, focusId);
  };

  // The wall replaces the details, ruler and grid while "On now" is the choice.
  LiveTVScreen.prototype.syncMode = function () {
    var on = this.isWall();
    var self = this;
    if (on && !this.wall) {
      this.wall = new PL.LiveWall(this.el, {
        onTune: function (list, i, label) { self.playList(list, i, label); },
        onRail: function () { self.openRail(); },
        onTop: function () { self.focusArea('subnav'); },
        onFocusShelf: function () { self.buildChips(); },
        onMenu: function (c, play) { return self.menu(c, play); },
      });
    }
    this.el.classList.toggle('mode-wall', on);
    if (this.wall) this.wall.show(on);
    if (on) {
      this.list = [];
      this.row = 0;
      this.cur = null;
      this.clearRows();
      this.status.style.display = 'none';
      this.wall.refresh(true);
      if (this.area === 'grid') this.area = 'wall';
      this.focusArea(this.area);
    } else if (this.area === 'wall') {
      this.area = 'grid';
    }
  };

  // The Browse rail (Blue, Left at the start of the grid, OK on the first chip): the guide behind
  // follows the focus after a rest; OK applies, Back puts back what was there.
  LiveTVScreen.prototype.openRail = function () {
    if (!G.channels.length || this.railOpen) return;
    var self = this;
    var before = { base: this.sel.base, refine: this.sel.refine };
    var focusId = this.channel() ? this.channel().identifier : null;
    var area = this.area;
    var at = { anchor: this.anchor, start: this.start };
    this.cancelEntry();
    if (PL.app.tabsFocused) PL.app.blurTabs(true);
    this.railOpen = true;
    this.subnav.setFocused(false);
    if (this.wall) this.wall.setFocused(false);
    this.paintFocus();
    var done = function () {
      self.railOpen = false;
      self.focusArea(self.isWall() ? 'wall' : self.list.length ? 'grid' : 'subnav');
    };
    PL.app.push(screens.liveBrowse({
      current: this.sel.base,
      onPreview: function (key) { self.setSel({ base: key }, null, true); },
      onApply: function (key) {
        // (a preview may have shown the choice already: Back from the wall returns to `before`)
        self.setSel(key === before.base ? before : { base: key });
        if (key === 'now' && before.base !== 'now') self.beforeWall = before;
        done();
      },
      onCancel: function () {
        if (self.sel.base !== before.base || self.sel.refine !== before.refine) {
          self.setSel(before, focusId, true);
          // back where the guide was in time, not just on the channel
          if (!self.isWall() && self.list.length) {
            self.anchor = at.anchor;
            self.start = Math.max(at.start, self.origin);
            self.refocus();
            self.render();
          }
        } else {
          G.setBrowse(before, true);
        }
        self.buildChips();
        self.railOpen = false;
        self.focusArea(area === 'wall' && !self.isWall() ? 'grid' : area);
      },
      onForward: function (code, e) { self.key(code, e); },
    }));
  };

  LiveTVScreen.prototype.paintRuler = function () {
    PL.clear(this.rulerTrack);
    this.ticks = [];
    for (var t = this.origin; t <= this.origin + 24 * 3600; t += STEP) {
      var n = PL.el('div', 'lg-tick', L.clock(t));
      PL.translate(n, (t - this.origin) * PPS, 0);
      this.rulerTrack.appendChild(n);
      this.ticks.push({ x: (t - this.origin) * PPS, node: n, hidden: false });
    }
    this.nowPill = PL.el('div', 'lg-now-pill');
    this.rulerTrack.appendChild(this.nowPill);
    this.paintNow();
  };

  LiveTVScreen.prototype.paintNow = function () {
    var t = now();
    var x = Math.round((t - this.origin) * PPS);
    PL.translate(this.nowLine, x, 0);
    this.nowPill.textContent = L.clock(t);
    // the pill stays whole at the left edge, and the half-hour label it covers steps aside
    var px = Math.max(x, 44);
    PL.translate(this.nowPill, px, 0);
    (this.ticks || []).forEach(function (k) {
      var hide = k.x > px - 120 && k.x < px + 44;
      if (hide !== k.hidden) {
        k.hidden = hide;
        k.node.style.opacity = hide ? '0' : '';
      }
    });
  };

  // ---- Data -----------------------------------------------------------------------------------------

  LiveTVScreen.prototype.load = function () {
    var self = this;
    G.load().then(function () {
      if (!self.alive) return;
      self.loaded = true;
      self.onData();
      // the next block in the background, so scrolling right is instant
      setTimeout(function () { if (self.alive) G.ensure(now(), now() + 5 * 3600).catch(function () {}); }, 1500);
    }, function (err) {
      if (!self.alive) return;
      PL.warn('guide load failed', err && err.message);
      // (Search may have loaded the lineup alone: say why the guide is empty all the same)
      if (G.channels.length && self.list.length) return;
      self.showStatus(err && err.noDvr ? err.message : 'Couldn\'t load the guide: ' + PL.errorMessage(err));
    });
  };

  LiveTVScreen.prototype.showStatus = function (text) {
    PL.clear(this.status);
    this.status.appendChild(PL.el('div', '', text));
    this.status.style.display = '';
  };

  // The guide changed (a block arrived, a favourite was toggled): refilter, keep the focus.
  LiveTVScreen.prototype.onData = function () {
    if (!this.loaded && !G.channels.length) return;
    var ctx = G.browseCtx();
    var norm = B.normalise(this.sel, ctx);
    // Favourites with none left, or a family the lineup no longer has: All
    if (norm.base === 'fav' && !G.favourites().length) norm = { base: 'all', refine: null };
    if (norm.base !== this.sel.base || norm.refine !== this.sel.refine) {
      this.sel = norm;
      G.setBrowse(norm, true);
      this.seenSeq = G.browseSeq;
      this.syncMode();
    }
    if (this.isWall()) {
      if (!this.wall) this.syncMode();
      else this.wall.refresh();
      this.buildChips();
      return;
    }
    this.buildChips();
    this.applyFilter(true);
    if (this.pendingOpen && this.openAt(this.pendingOpen.identifier, this.pendingOpen.t)) this.pendingOpen = null;
  };

  // Focuses a channel at a time (switching to All when the filter hides it). False while the
  // channel isn't in the guide yet.
  LiveTVScreen.prototype.openAt = function (identifier, t) {
    var find = function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].identifier === identifier) return i;
      return -1;
    };
    if (find(G.channels) < 0) return false;
    if (find(this.list) < 0) this.setSel({ base: 'all' }, identifier);
    var row = find(this.list);
    if (row < 0) return false;
    this.row = row;
    this.anchor = Math.max(t || 0, now());
    this.start = this.origin;
    this.area = 'grid';
    this.waitingForGrid = false;
    this.subnav.setFocused(false);
    this.refocus();
    this.render();
    G.ensure(this.anchor, this.anchor + 3600).catch(function () {});
    return true;
  };

  // keep: stay on the same channel (data refresh); otherwise start at the top, on now.
  LiveTVScreen.prototype.applyFilter = function (keep, focusId) {
    var t = now();
    if (this.isWall()) return;
    var was = focusId || (keep && this.list[this.row] ? this.list[this.row].identifier : null);
    this.list = G.channelsFor(this.sel);
    var idx = 0;
    if (was) for (var i = 0; i < this.list.length; i++) if (this.list[i].identifier === was) { idx = i; break; }
    if (!keep) {
      this.anchor = t;
      this.start = this.origin;
    }
    this.row = idx;
    this.clearRows();
    if (!this.list.length) {
      this.cur = null;
      this.showStatus(!G.channels.length ? 'No channels found'
        : this.sel.base === 'fav' ? 'No channels here yet. Hold OK on a channel to add it to Favourites.'
          : 'No channels in ' + B.selLabel(this.sel, G.browseCtx()) + ' right now. Press Blue to browse.');
      if (this.area === 'grid') this.focusArea('subnav');
      this.paintDetail();
      return;
    }
    this.status.style.display = 'none';
    // the guide arrived while the filters held the focus only because it was empty: go to it
    if (this.waitingForGrid && this.area === 'subnav' && this.visible && !PL.app.tabsFocused) {
      this.area = 'grid';
      this.subnav.setFocused(false);
    }
    this.waitingForGrid = false;
    this.refocus();
    this.render();
  };

  LiveTVScreen.prototype.channel = function () { return this.list[this.row] || null; };

  // Picks the airing at the anchor on the focused row.
  LiveTVScreen.prototype.refocus = function () {
    var c = this.channel();
    var list = c ? G.list(c.identifier) : [];
    var i = L.pick(list, Math.max(this.anchor, now()));
    this.cur = i >= 0 && list[i].e > now() ? list[i] : null;
    if (this.cur) this.start = L.viewStart(this.start, this.cur, this.origin, SPAN, STEP);
  };

  // ---- Rendering ----------------------------------------------------------------------------------

  LiveTVScreen.prototype.clearRows = function () {
    var self = this;
    Object.keys(this.rows).forEach(function (k) { self.dropRow(k); });
    this.rows = {};
  };

  LiveTVScreen.prototype.dropRow = function (k) {
    var r = this.rows[k];
    if (!r) return;
    this.chanTrack.removeChild(r.chan);
    this.progTrack.removeChild(r.track);
    delete this.rows[k];
  };

  LiveTVScreen.prototype.render = function () {
    var first = L.firstRow(this.row, this.list.length, VISIBLE, LEAD);
    var y = -first * PITCH;
    PL.translate(this.chanTrack, 0, y);
    PL.translate(this.progTrack, -(this.start - this.origin) * PPS, y);
    PL.translate(this.rulerTrack, -(this.start - this.origin) * PPS, 0);
    PL.translate(this.nowTrack, -(this.start - this.origin) * PPS, 0);
    this.dayLabel.textContent = L.day(Math.max(this.start, now()), now());
    var lo = Math.max(0, first - KEEP);
    var hi = Math.min(this.list.length - 1, first + VISIBLE + KEEP);
    var self = this;
    Object.keys(this.rows).forEach(function (k) {
      var i = Number(k);
      if (i < lo || i > hi || self.rows[k].channel !== self.list[i]) self.dropRow(k);
    });
    var bucket = this.origin + L.floorTo(this.start - this.origin, BUCKET);
    var from = bucket - 3600;
    var to = bucket + BUCKET + SPAN + 3600;
    for (var i = lo; i <= hi; i++) {
      var r = this.rows[i] || this.makeRow(i);
      var list = G.list(r.channel.identifier);
      var key = from + ':' + to + ':' + this.origin;
      if (r.key !== key || r.list !== list) this.fillRow(r, list, from, to, key);
      this.shiftLabel(r);
    }
    this.paintFocus();
    G.ensure(this.start, this.start + SPAN + 3600).catch(function () {});
  };

  LiveTVScreen.prototype.makeRow = function (i) {
    var c = this.list[i];
    var chan = PL.el('div', 'lg-chan');
    var logo = PL.el('div', 'lg-logo');
    // a dark plate for white logos (js/logos.js)
    PL.logos.fill(logo, c, { w: 104, h: 56, textClass: 'lg-logo-text', label: c.name.slice(0, 10) });
    chan.appendChild(logo);
    var num = PL.el('div', 'lg-num', c.vcn);
    if (G.isFavourite(c.identifier)) num.appendChild(PL.el('span', 'lg-fav', '★'));
    chan.appendChild(num);
    chan.appendChild(PL.el('div', 'lg-name', c.name));
    PL.translate(chan, 0, i * PITCH);
    var track = PL.el('div', 'lg-row');
    PL.translate(track, 0, i * PITCH);
    this.chanTrack.appendChild(chan);
    this.progTrack.appendChild(track);
    var self = this;
    chan.addEventListener('click', function () { self.pointAt(i, null, true); });
    var r = { channel: c, chan: chan, track: track, nodes: [], key: null, list: null, shifted: null };
    this.rows[i] = r;
    return r;
  };

  // The row's cells for [from, to]; a row without guide data gets one long "no information" cell.
  LiveTVScreen.prototype.fillRow = function (r, list, from, to, key) {
    PL.clear(r.track);
    r.nodes = [];
    r.shifted = null;
    r.key = key;
    r.list = list;
    var self = this;
    var origin = this.origin;
    var t = now();
    var idx = this.indexOfRow(r);
    var add = function (a, text, cls) {
      var box = L.cell(a, origin, origin, PPS, GAP);
      if (box.w < 2) return;
      var n = PL.el('div', 'lg-cell' + (cls ? ' ' + cls : ''));
      n.style.width = Math.round(box.w) + 'px';
      PL.translate(n, box.x, 0);
      // too narrow for a word: left blank (the details above name it when focused)
      var label = PL.el('div', 'lg-label', box.w >= 110 ? text : '');
      n.appendChild(label);
      if (a.b <= t && t < a.e) n.classList.add('on-now');
      n.addEventListener('mouseenter', function () { if (pointing()) self.pointAt(idx, a, false); });
      n.addEventListener('click', function () { self.pointAt(idx, a, true); });
      r.track.appendChild(n);
      r.nodes.push({ a: a, node: n, label: label, box: box });
    };
    var any = false;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.e <= Math.max(from, origin) || a.b >= to) continue;
      any = true;
      add(a, a.title);
    }
    if (!any && !list.some(function (x) { return x.e > origin; })) {
      add({ b: origin, e: origin + 24 * 3600, empty: true }, 'No guide information', 'empty');
    }
  };

  LiveTVScreen.prototype.indexOfRow = function (r) {
    for (var i = 0; i < this.list.length; i++) if (this.list[i] === r.channel) return i;
    return -1;
  };

  // Keeps the title of the cell that started before the view start in sight.
  LiveTVScreen.prototype.shiftLabel = function (r) {
    var start = this.start;
    var hit = null;
    for (var i = 0; i < r.nodes.length; i++) {
      var n = r.nodes[i];
      var b = Math.max(n.a.b, this.origin);
      if (b < start && n.a.e > start) { hit = n; break; }
    }
    if (r.shifted && r.shifted !== hit) r.shifted.label.style.transform = '';
    if (hit) {
      var shift = L.cell(hit.a, this.origin, start, PPS, GAP).shift;
      hit.label.style.transform = 'translate3d(' + Math.round(shift) + 'px,0,0)';
    }
    r.shifted = hit;
  };

  // Only two cells and two channel plates change class per move.
  LiveTVScreen.prototype.paintFocus = function () {
    var on = this.area === 'grid' && this.visible && !PL.app.tabsFocused && !this.railOpen;
    var r = this.rows[this.row];
    var node = null;
    var chan = null;
    if (r) {
      chan = r.chan;
      for (var i = 0; i < r.nodes.length; i++) {
        var n = r.nodes[i];
        if ((this.cur && n.a === this.cur) || (!this.cur && n.a.empty)) { node = n.node; break; }
      }
    }
    if (this.focusNode !== node) {
      if (this.focusNode) this.focusNode.classList.remove('focused');
      this.focusNode = node;
    }
    if (this.focusChan !== chan) {
      if (this.focusChan) this.focusChan.classList.remove('current');
      this.focusChan = chan;
    }
    if (node) node.classList.toggle('focused', on);
    if (chan) chan.classList.add('current');
    this.el.classList.toggle('grid-focused', on);
    this.paintDetail();
  };

  LiveTVScreen.prototype.paintDetail = function () {
    var c = this.channel();
    var a = this.cur;
    var t = now();
    var key = (c ? c.identifier : '') + '|' + (a ? a.b : '') + '|' + Math.floor(t / 60);
    if (key === this.detailKey) return;
    this.detailKey = key;
    PL.clear(this.dEyebrow);
    if (!c) {
      this.dTitle.textContent = '';
      this.dSub.textContent = '';
      this.dSummary.textContent = '';
      this.art.classList.remove('loaded');
      return;
    }
    var onNow = a && a.b <= t && t < a.e;
    if (onNow) this.dEyebrow.appendChild(PL.el('span', 'lg-live', 'LIVE'));
    this.dEyebrow.appendChild(document.createTextNode(c.vcn + '  ' + c.name + (a ? '  ·  ' + L.times(a, t) : '')));
    if (a) {
      var st = PL.el('span', onNow ? 'lg-left' : 'lg-when', '  ·  ' + L.status(a, t));
      this.dEyebrow.appendChild(st);
    }
    this.dTitle.textContent = a ? a.title : c.name;
    this.dSub.textContent = a ? [a.sub, a.genres].filter(Boolean).join('  ·  ') : 'No guide information for this channel';
    var showing = this.summaryFor;
    if (!a || showing !== a.key) this.dSummary.textContent = '';
    if (!a || this.artFor !== a.art) this.art.classList.remove('loaded');
    this.detailSoon();
  };

  // Synopsis and artwork once the focus has rested.
  LiveTVScreen.prototype.paintDetailSlow = function () {
    if (!this.alive) return;
    var a = this.cur;
    var self = this;
    if (a && a.art !== this.artFor) {
      this.artFor = a.art;
      var src = a.art ? PL.plex.image(a.art, 448, 252) : null;
      if (src) this.artImg.src = src;
      else this.artImg.removeAttribute('src');
    } else if (a && a.art && this.artImg.complete && this.artImg.naturalWidth) {
      this.art.classList.add('loaded');
    }
    if (!a) return;
    this.summaryFor = a.key;
    G.summary(a).then(function (text) {
      if (self.cur === a) self.dSummary.textContent = text;
    });
  };

  // ---- Focus and keys -------------------------------------------------------------------------------

  LiveTVScreen.prototype.focusArea = function (area) {
    this.area = area;
    var active = !PL.app.tabsFocused && !this.railOpen;
    this.subnav.setFocused(area === 'subnav' && active);
    if (this.wall) this.wall.setFocused(area === 'wall' && active && this.isWall());
    this.paintFocus();
  };

  LiveTVScreen.prototype.moveRow = function (to) {
    if (!this.list.length) return;
    to = PL.clamp(to, 0, this.list.length - 1);
    if (to === this.row) return;
    this.row = to;
    this.refocus();
    this.render();
  };

  LiveTVScreen.prototype.moveTime = function (dir) {
    var c = this.channel();
    if (!c) return;
    var list = G.list(c.identifier);
    var t = now();
    if (!this.cur) {
      // Left at the start: the Browse rail (a fresh press, not a held Left running into it)
      if (dir < 0 && this.start === this.origin) {
        if (!this.repeat) this.openRail();
        return;
      }
      // a row without guide data: walk the view in half hours
      this.start = PL.clamp(this.start + dir * STEP, this.origin, this.origin + 3 * 86400);
      this.anchor = Math.max(this.start, t);
      this.render();
      return;
    }
    var i = list.indexOf(this.cur);
    var next = list[i + dir];
    if (!next || next.e <= t) {
      if (dir > 0) G.ensure(this.cur.e, this.cur.e + 3 * 3600).catch(function () {});
      // nothing earlier: Left opens the Browse rail
      else if (!this.repeat) this.openRail();
      return;
    }
    this.cur = next;
    this.anchor = Math.max(next.b, t);
    this.start = L.viewStart(this.start, next, this.origin, SPAN, STEP);
    this.render();
  };

  // Back in the grid: first return to now, then to the tab bar.
  LiveTVScreen.prototype.backToNow = function () {
    var t = now();
    if (this.start === this.origin && (!this.cur || this.cur.b <= t)) return false;
    this.anchor = t;
    this.start = this.origin;
    this.refocus();
    this.render();
    return true;
  };

  // Pointer: hover focuses, click (or a click on the channel) watches.
  LiveTVScreen.prototype.pointAt = function (i, a, play) {
    if (i < 0 || !this.list[i]) return;
    var t = now();
    this.area = 'grid';
    this.subnav.setFocused(false);
    if (PL.app.tabsFocused) PL.app.blurTabs(true);
    this.row = i;
    if (a && !a.empty && a.e > t) {
      this.cur = a;
      this.anchor = Math.max(a.b, t);
    } else if (!a) {
      this.anchor = t;
      this.refocus();
    }
    if (play) this.play();
    else this.paintFocus();
  };

  LiveTVScreen.prototype.play = function () {
    if (!this.channel()) return;
    this.playList(this.list, this.row, B.selLabel(this.sel, G.browseCtx()));
  };

  // Watches list[index]; the player's mini guide and CH+/CH− go through `list` (the filter).
  LiveTVScreen.prototype.playList = function (list, index, label) {
    var c = list[index];
    if (!c || !G.src) return;
    var shape = function (x) { return { identifier: x.identifier, id: x.id, vcn: x.vcn, title: x.name, thumb: x.thumb }; };
    this.cancelEntry();
    PL.app.push(screens.player(null, {
      live: {
        label: label || 'All channels',
        dvrKey: G.src.dvrKey,
        channel: shape(c),
        channels: list.map(shape),
        index: index,
      },
    }));
  };

  LiveTVScreen.prototype.favourite = function (chan) {
    var c = chan || this.channel();
    if (!c) return;
    var on = G.toggleFavourite(c.identifier);
    PL.toast(on ? 'Added ' + c.name + ' to Favourites' : 'Removed ' + c.name + ' from Favourites');
  };

  // chan, play: a wall card's channel and how to watch it (in its shelf)
  LiveTVScreen.prototype.menu = function (chan, play) {
    var c = chan || this.channel();
    if (!c) return false;
    var self = this;
    var fav = G.isFavourite(c.identifier);
    PL.app.push(screens.sheet([{
      heading: c.vcn + '  ' + c.name,
      rows: [
        { label: 'Watch ' + c.name, action: function () { if (play) play(); else self.play(); } },
        { label: fav ? 'Remove from Favourites' : 'Add to Favourites', action: function () { self.favourite(c); } },
      ],
    }], { focus: 0 }));
    return true;
  };

  // ---- Channel number entry -------------------------------------------------------------------------

  LiveTVScreen.prototype.typeDigit = function (d) {
    var all = G.channels;
    if (!all.length) return;
    var numbers = all.map(function (c) { return c.vcn; });
    var max = L.maxDigits(numbers);
    var e = this.entry || (this.entry = { digits: '' });
    e.digits = L.typeDigit(e.digits, d, max);
    var m = L.previewNumber(numbers, e.digits);
    var dashes = '';
    for (var i = e.digits.length; i < max; i++) dashes += '–';
    this.entryDigits.textContent = e.digits + dashes;
    this.entryName.textContent = m ? (m.exact ? '' : (m.prefix ? '' : 'Nearest: ') + all[m.index].vcn + '  ') + all[m.index].name : '';
    this.entryEl.classList.remove('entry-hidden');
    clearTimeout(e.timer);
    var self = this;
    if (L.entryDone(numbers, e.digits, max)) e.timer = setTimeout(function () { self.commitEntry(); }, 350);
    else e.timer = setTimeout(function () { self.commitEntry(); }, ENTRY_MS);
  };

  LiveTVScreen.prototype.cancelEntry = function () {
    if (!this.entry) return false;
    clearTimeout(this.entry.timer);
    this.entry = null;
    this.entryEl.classList.add('entry-hidden');
    return true;
  };

  LiveTVScreen.prototype.commitEntry = function () {
    var e = this.entry;
    if (!e) return;
    var all = G.channels;
    var m = L.matchNumber(all.map(function (c) { return c.vcn; }), e.digits);
    this.cancelEntry();
    if (!m || !this.alive) return;
    var target = all[m.index];
    var inList = this.list.indexOf(target) !== -1;
    this.anchor = now();
    this.start = this.origin;
    this.area = 'grid';
    this.subnav.setFocused(false);
    if (!inList) {
      this.setSel({ base: 'all' }, target.identifier);
      this.focusArea('grid');
      return;
    }
    this.row = this.list.indexOf(target);
    this.refocus();
    this.render();
  };

  LiveTVScreen.prototype.key = function (code, e) {
    // a held key repeats: Left that runs into the start of the guide must not open the rail
    this.repeat = !!(e && e.repeat);
    this.lastKeyAt = Date.now();
    if (code >= 48 && code <= 57) {
      this.typeDigit(code - 48);
      return true;
    }
    if (this.entry) {
      if (code === K.ENTER) { clearTimeout(this.entry.timer); this.commitEntry(); return true; }
      if (PL.isBack(code)) return this.cancelEntry();
    }
    if (code === K.BLUE) {
      this.openRail();
      return true;
    }
    if (this.area === 'subnav') {
      var onRail = this.chips[this.subnav.index] && this.chips[this.subnav.index].value === RAIL;
      if (code === K.ENTER && onRail) {
        this.openRail();
        return true;
      }
      if (code === K.DOWN) {
        if (!onRail) this.subnav.choose();
        if (this.isWall()) this.focusArea('wall');
        else if (this.list.length) this.focusArea('grid');
        return true;
      }
      if (code === K.UP) return PL.app.focusTabs();
      if (this.isWall() && PL.isBack(code)) return this.leaveWall();
      return this.subnav.key(code);
    }
    if (this.area === 'wall' && this.isWall()) {
      if (!this.wall) return false;
      if (this.wall.key(code, this.repeat)) return true;
      if (PL.isBack(code)) return this.leaveWall();
      return false;
    }
    if (!this.list.length) return false;
    switch (code) {
      case K.UP:
        if (this.row === 0) this.focusArea('subnav');
        else this.moveRow(this.row - 1);
        return true;
      case K.DOWN: this.moveRow(this.row + 1); return true;
      case K.CH_UP: this.moveRow(this.row - VISIBLE); return true;
      case K.CH_DOWN: this.moveRow(this.row + VISIBLE); return true;
      case K.LEFT: this.moveTime(-1); return true;
      case K.RIGHT: this.moveTime(1); return true;
      case K.ENTER:
      case K.PLAY:
      case K.PLAY_PAUSE:
        this.play();
        return true;
      case K.OK_LONG: return this.menu();
      case K.YELLOW: this.favourite(); return true;
      default:
        if (PL.isBack(code)) return this.backToNow();
        return false;
    }
  };

  // Back from the wall: the guide as it was before On now.
  LiveTVScreen.prototype.leaveWall = function () {
    this.setSel(this.beforeWall && this.beforeWall.base !== 'now' ? this.beforeWall : { base: 'all' });
    this.focusArea(this.list.length ? 'grid' : 'subnav');
    return true;
  };

  LiveTVScreen.prototype.focusFromTabs = function () {
    this.focusArea(this.isWall() ? 'wall' : this.list.length ? 'grid' : 'subnav');
  };

  LiveTVScreen.prototype.onTabsFocus = function () {
    this.subnav.setFocused(false);
    if (this.wall) this.wall.setFocused(false);
    this.paintFocus();
  };

  // Every 30 s: the now line; on a new half hour the guide moves on (nothing before now is shown).
  LiveTVScreen.prototype.tick = function () {
    var t = now();
    var origin = L.floorTo(t, STEP);
    if (this.isWall()) {
      // the wall rebuilds only when a programme ended or began
      if (origin !== this.origin) {
        this.origin = this.start = origin;
        G.prune();
        this.paintRuler();
      }
      // (not under a moving focus: a rebuild costs ~190 ms on the TV)
      if (this.wall && !(this.area === 'wall' && Date.now() - (this.lastKeyAt || 0) < 8000) && this.wall.refresh()) this.buildChips();
      G.ensure(t, t + 3600).catch(function () {});
      return;
    }
    if (origin !== this.origin) {
      var atStart = this.start === this.origin;
      this.origin = origin;
      this.start = atStart ? origin : Math.max(this.start, origin);
      G.prune();
      this.paintRuler();
      this.clearRows();
      if (this.cur && this.cur.e <= t) this.cur = null;
      if (!this.cur) {
        this.anchor = Math.max(this.anchor, t);
        this.refocus();
      }
      this.render();
    } else {
      this.paintNow();
      if (this.cur && this.cur.e <= t) {
        this.refocus();
        this.render();
      } else {
        this.paintDetail();
      }
    }
    G.ensure(t, t + 3600).catch(function () {});
  };

  LiveTVScreen.prototype.show = function () {
    var self = this;
    this.visible = true;
    PL.app.backdrop.set(null, 'none');
    clearInterval(this.timer);
    this.timer = setInterval(function () { self.tick(); }, 30000);
    // back from the player: focus the channel that was being watched
    var watched = G.watching;
    G.watching = null;
    // the Browse rail over the picture changed the filter: follow it
    if (this.seenSeq !== G.browseSeq) {
      var g = G.getBrowse();
      this.seenSeq = G.browseSeq;
      if (g.base !== this.sel.base || g.refine !== this.sel.refine) this.setSel(g, watched);
    }
    if (watched && this.list.length) {
      for (var i = 0; i < this.list.length; i++) {
        if (this.list[i].identifier === watched) {
          this.row = i;
          this.anchor = now();
          this.start = this.origin;
          this.refocus();
          break;
        }
      }
    }
    if (this.loaded) this.tick();
    if (!this.list.length && !this.loaded) this.waitingForGrid = true;
    if (!PL.app.tabsFocused) {
      if (this.isWall()) this.focusArea(this.area === 'subnav' ? 'subnav' : 'wall');
      else this.focusArea(this.list.length ? this.area : 'subnav');
    }
    if (this.list.length) this.render();
  };

  LiveTVScreen.prototype.hide = function () {
    this.visible = false;
    clearInterval(this.timer);
    this.timer = null;
    this.cancelEntry();
    this.paintFocus();
  };

  LiveTVScreen.prototype.destroy = function () {
    this.alive = false;
    this.visible = false;
    clearInterval(this.timer);
    this.timer = null;
    this.cancelEntry();
    this.detailSoon.cancel();
    if (this.unlisten) this.unlisten();
  };

  screens.livetv = function () { return new LiveTVScreen(); };
})();
