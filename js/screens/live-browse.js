// Live TV Browse (docs/LIVETV-browse-design.md): the Browse rail, an overlay down the left over the
// guide or the picture (Favourites, All channels, On now, categories, channel families), and the
// On now wall, shelves of what is on now by category inside the Live TV tab. The rules (counts,
// families, chips, shelves) are in js/livetv-browse.js; the data in js/livetv-data.js.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;
  var B = PL.liveBrowse;
  var L = PL.liveLogic;
  var G = PL.liveGuide;

  var ROW = 64;               // rail row pitch
  var LIST_H = 768;           // the rail's list clip (12 rows)
  var LEAD = 4;               // rows kept above the focus once the list scrolls
  var PAGE = 8;               // CH+/CH− in the rail
  var PREVIEW_MS = 450;       // the guide behind follows the focus after this rest (a guide redraw
                              // costs ~100 ms on the TV, so not between quick presses)
  var CLOSE_MS = 140;

  function now() { return Math.floor(Date.now() / 1000); }
  function pointing() { return document.body.classList.contains('pointer'); }

  function hint(parent, key, label, cls) {
    var h = PL.el('div', 'lb-hint');
    h.appendChild(PL.el('span', 'keycap' + (cls ? ' ' + cls : ''), key));
    h.appendChild(PL.el('span', '', label));
    parent.appendChild(h);
    return h;
  }

  // ---- The rail ------------------------------------------------------------------------------------
  // opts: {current: key, overPlayer: bool, onPreview(key), onApply(key), onCancel(), onForward(code, event)}

  function BrowseRail(opts) {
    this.opts = opts || {};
    this.overlay = true;
    this.wantsBlue = true;
    this.el = PL.el('div', 'lb' + (opts.overPlayer ? ' lb-over-player' : ''));
    this.closing = false;
    this.previewed = opts.current;
    var self = this;
    this.previewSoon = PL.debounce(function () { self.preview(); }, PREVIEW_MS);
    this.build();
  }

  BrowseRail.prototype.build = function () {
    var self = this;
    var scrim = PL.el('div', 'lb-scrim');
    scrim.addEventListener('click', function () { self.close(false); });
    this.el.appendChild(scrim);
    var panel = this.panel = PL.el('div', 'lb-panel');
    panel.appendChild(PL.el('div', 'lb-title', 'Browse channels'));
    var ctx = G.browseCtx();
    var onNow = Object.keys(ctx.onNow).length;
    panel.appendChild(PL.el('div', 'lb-sub', G.channels.length + ' channels' + (onNow ? '  ·  ' + onNow + ' showing now' : '')));
    var clip = PL.el('div', 'lb-clip');
    this.track = PL.el('div', 'lb-track');
    this.plate = PL.el('div', 'lb-plate');
    this.track.appendChild(this.plate);
    clip.appendChild(this.track);
    this.fadeTop = PL.el('div', 'lb-fade lb-fade-top');
    this.fadeBottom = PL.el('div', 'lb-fade lb-fade-bottom');
    clip.appendChild(this.fadeTop);
    clip.appendChild(this.fadeBottom);
    panel.appendChild(clip);

    this.entries = B.railEntries(G.channels, ctx);
    this.rows = [];
    this.picks = [];
    var y = 0;
    this.entries.forEach(function (e) {
      var n = PL.el('div', 'lb-row' + (e.kind === 'head' ? ' lb-head' : '') + (e.sub ? ' lb-subrow' : ''));
      n.appendChild(PL.el('span', 'lb-label', e.label));
      if (e.key === 'fav') n.firstChild.appendChild(PL.el('span', 'lb-star', ' ★'));
      if (e.count != null) n.appendChild(PL.el('span', 'lb-count', String(e.count)));
      PL.translate(n, 0, y);
      self.track.appendChild(n);
      var row = { entry: e, node: n, y: y };
      self.rows.push(row);
      if (e.kind === 'pick') {
        var pi = self.picks.length;
        self.picks.push(row);
        if (e.key === self.opts.current) n.classList.add('selected');
        n.addEventListener('mouseenter', function () { if (pointing() && !self.closing) self.focusPick(pi); });
        n.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.index = pi;
          self.apply();
        });
      }
      y += ROW;
    });
    this.height = y;
    var start = 0;
    for (var i = 0; i < this.picks.length; i++) if (this.picks[i].entry.key === this.opts.current) start = i;
    this.index = start;
    this.lastY = null;

    var hints = PL.el('div', 'lb-hints');
    hint(hints, PL.keyLabel('OK'), 'Show');
    hint(hints, PL.keyLabel('Back'), 'Close');
    panel.appendChild(hints);
    this.el.appendChild(panel);
    this.paint(true);
  };

  BrowseRail.prototype.paint = function (instant) {
    var row = this.picks[this.index];
    if (!row) return;
    if (this.focusNode !== row.node) {
      if (this.focusNode) this.focusNode.classList.remove('focused');
      row.node.classList.add('focused');
      this.focusNode = row.node;
    }
    var scroll = PL.clamp(row.y - LEAD * ROW, 0, Math.max(0, this.height - LIST_H));
    if (instant) {
      this.plate.classList.add('instant');
      this.track.classList.add('instant');
    }
    PL.translate(this.plate, 0, row.y);
    if (scroll !== this.lastY) {
      PL.translate(this.track, 0, -scroll);
      this.lastY = scroll;
      this.fadeTop.classList.toggle('on', scroll > 0);
      this.fadeBottom.classList.toggle('on', scroll < this.height - LIST_H);
    }
    if (instant) {
      var plate = this.plate;
      var track = this.track;
      plate.offsetWidth; // lands at once
      plate.classList.remove('instant');
      track.classList.remove('instant');
    }
  };

  BrowseRail.prototype.focusPick = function (i) {
    i = PL.clamp(i, 0, this.picks.length - 1);
    if (i === this.index) return;
    this.index = i;
    this.paint(false);
    this.previewSoon();
  };

  BrowseRail.prototype.preview = function () {
    if (this.closing) return;
    var key = this.picks[this.index].entry.key;
    if (key === this.previewed) return;
    this.previewed = key;
    if (this.opts.onPreview) this.opts.onPreview(key);
  };

  BrowseRail.prototype.apply = function () {
    if (this.closing) return;
    var key = this.picks[this.index].entry.key;
    this.previewSoon.cancel();
    this.finish(function (o) { if (o.onApply) o.onApply(key); });
  };

  BrowseRail.prototype.close = function () {
    if (this.closing) return;
    this.previewSoon.cancel();
    this.finish(function (o) { if (o.onCancel) o.onCancel(); });
  };

  // The rail fades out over CLOSE_MS while the screen underneath already shows the result.
  BrowseRail.prototype.finish = function (then) {
    var self = this;
    this.closing = true;
    then(this.opts);
    this.el.classList.add('lb-closing');
    setTimeout(function () {
      if (PL.app.top() === self) PL.app.pop();
      else if (self.el.parentNode) self.el.parentNode.removeChild(self.el);
    }, CLOSE_MS);
  };

  BrowseRail.prototype.key = function (code, e) {
    // while it fades out, keys belong to the screen underneath (quick typing, OK then Down)
    if (this.closing) {
      if (this.opts.onForward && code !== K.BLUE) this.opts.onForward(code, e);
      return true;
    }
    var repeat = !!(e && e.repeat);
    if (code >= 48 && code <= 57 && this.opts.onForward) {
      // a channel number: close and let the guide (or the player) take it
      var fwd = this.opts.onForward;
      this.close();
      fwd(code, e);
      return true;
    }
    switch (code) {
      case K.UP: this.focusPick(this.index - 1); return true;
      case K.DOWN: this.focusPick(this.index + 1); return true;
      case K.CH_UP: this.focusPick(this.index - PAGE); return true;
      case K.CH_DOWN: this.focusPick(this.index + PAGE); return true;
      case K.ENTER:
      case K.RIGHT:
        this.apply();
        return true;
      case K.LEFT:
        // a held Left that opened the rail at the start of the guide doesn't close it again
        if (!repeat) this.close();
        return true;
      case K.BLUE:
        this.close();
        return true;
      default:
        if (PL.isBack(code)) {
          this.close();
          return true;
        }
        return true; // the rail is modal
    }
  };

  BrowseRail.prototype.show = function () {};
  BrowseRail.prototype.hide = function () {};
  BrowseRail.prototype.destroy = function () {
    this.previewSoon.cancel();
  };

  screens.liveBrowse = function (opts) { return new BrowseRail(opts); };

  // ---- The On now wall ---------------------------------------------------------------------------
  // Shelves (ui.VStack of ui.Shelf) of landscape cards, one per category: the programme's art, the
  // channel's logo plate, the title and a teal progress line; under the focused card its channel,
  // the time left and what's next. Cards exist only for the shelves near the focus.
  // opts: {onTune(channels, index, label), onRail(), onTop(), onFocusShelf(index)}

  var GEO = { w: 420, h: 236, pitch: 448, scale: 1.09 };
  var SHELF_H = 416;
  var TINTS = ['#2f5d46', '#2c4f7c', '#5a3d7a', '#7a4a2c', '#2f6b6f', '#6b2f3c', '#4c5a2a', '#3a4a6b'];

  function LiveWall(host, opts) {
    this.opts = opts || {};
    this.el = PL.el('div', 'lw');
    this.clip = PL.el('div', 'lw-clip');
    this.el.appendChild(this.clip);
    this.empty = PL.el('div', 'lw-empty', 'Nothing on now has guide information.');
    this.el.appendChild(this.empty);
    host.appendChild(this.el);
    this.shadow = new ui.FocusShadow();
    var self = this;
    this.stack = new ui.VStack(this.clip, {
      top: 0,
      keep: 2,
      anchor: function () { return 0; },
      onFocusZone: function (i) { if (self.opts.onFocusShelf) self.opts.onFocusShelf(i); },
    });
    this.shelves = [];
    this.sig = '';
    this.focused = false;
  }

  // What is on now: [{channel, airing, cat}] in channel order.
  LiveWall.prototype.items = function () {
    var t = now();
    var out = [];
    G.channels.forEach(function (c) {
      var a = G.nowNext(c.identifier, t).now;
      if (a) out.push({ channel: c, airing: a, cat: G.airingCat(a) || null });
    });
    return out;
  };

  // Rebuilds the shelves when what is on changed; keeps the focused shelf and channel.
  LiveWall.prototype.refresh = function (force) {
    var ctx = G.browseCtx();
    var shelves = B.shelves(this.items(), ctx);
    var sig = shelves.map(function (s) {
      return s.key + ':' + s.items.map(function (x) { return x.channel.identifier + '@' + x.airing.b; }).join(',');
    }).join('|');
    if (!force && sig === this.sig) return false;
    this.sig = sig;
    var cur = this.current();
    var curShelf = this.shelves[this.stack.index] && this.shelves[this.stack.index].key;
    // every shelf keeps the channel it was on
    var kept = {};
    var old = this.stack.zones || [];
    this.shelves.forEach(function (sh, i) {
      var it = old[i] && old[i].items && old[i].items[old[i].index];
      if (it) kept[sh.key] = it.ratingKey;
    });
    this.shelves = shelves;
    var self = this;
    var zones = shelves.map(function (s, si) {
      var shelf = new ui.Shelf({
        title: s.label,
        items: s.items.map(function (x) { return { ratingKey: x.channel.identifier, x: x }; }),
        kind: 'wide',
        geometry: GEO,
        shadow: self.shadow,
        makeCard: function (item) { return self.card(item.x); },
        onSelect: function (item, i) { self.tune(si, i); },
        onFocusItem: function () {},
        onLongPress: function (item, done) { return self.menu(item.x, done); },
      });
      shelf.el.firstChild.appendChild(PL.el('span', 'lw-count', s.items.length + ' on now'));
      shelf.height = SHELF_H;
      return shelf;
    });
    var index = 0;
    for (var i = 0; i < shelves.length; i++) {
      if (shelves[i].key === curShelf) index = i;
      var want = kept[shelves[i].key];
      var items = zones[i].items;
      for (var j = 0; want && j < items.length; j++) if (items[j].ratingKey === want) zones[i].index = j;
    }
    if (cur && zones[index]) {
      var its = zones[index].items;
      for (var k = 0; k < its.length; k++) if (its[k].ratingKey === cur.channel.identifier) zones[index].index = k;
    }
    this.stack.setZones(zones, index);
    this.empty.textContent = G.channels.length ? 'Nothing on now has guide information.' : 'Loading the guide…';
    this.empty.style.display = shelves.length ? 'none' : '';
    if (this.focused) this.stack.focus(true);
    return true;
  };

  LiveWall.prototype.card = function (x) {
    var c = x.channel;
    var a = x.airing;
    var t = now();
    var card = PL.el('div', 'card card-wide lw-card');
    var inner = PL.el('div', 'card-inner');
    inner.style.width = GEO.w + 'px';
    inner.style.height = GEO.h + 'px';
    // a channel logo standing in for programme art isn't art
    var art = a.art && a.art !== c.thumb ? PL.plex.image(a.art, GEO.w, GEO.h) : null;
    if (art) {
      var img = PL.el('img', 'card-img');
      img.width = GEO.w;
      img.height = GEO.h;
      img.onerror = function () { img.style.visibility = 'hidden'; inner.classList.add('lw-tinted'); };
      ui.fadeInImage(img, art);
      inner.appendChild(img);
    } else {
      inner.classList.add('lw-tinted');
      inner.style.backgroundColor = TINTS[(parseInt(c.vcn, 10) || 0) % TINTS.length];
      var word = (a.genres || '').split(',')[0] || B.categoryLabel(x.cat || '');
      if (word) inner.appendChild(PL.el('div', 'lw-genre', word.trim()));
    }
    var logo = PL.el('div', 'lw-logo');
    PL.logos.fill(logo, c, { w: 84, h: 44, textClass: 'lw-logo-text', label: c.name.slice(0, 8) });
    inner.appendChild(logo);
    var bar = PL.el('div', 'card-progress');
    var fill = PL.el('div', 'card-progress-fill');
    fill.style.transform = 'scaleX(' + L.progress(a, t).toFixed(3) + ')';
    bar.appendChild(fill);
    inner.appendChild(bar);
    inner.appendChild(PL.el('div', 'card-edge'));
    card.appendChild(inner);
    var meta = PL.el('div', 'card-meta');
    meta.style.width = GEO.w + 'px';
    meta.appendChild(PL.el('div', 'card-title', a.title));
    card.appendChild(meta);
    var nn = G.nowNext(c.identifier, t);
    var cap = PL.el('div', 'lw-caption');
    cap.appendChild(PL.el('div', 'lw-cap-1', c.vcn + '  ' + c.name + (G.isFavourite(c.identifier) ? '  ★' : '')));
    cap.appendChild(PL.el('div', 'lw-cap-2', L.span(a.e - t) + ' left' + (nn.next ? '  ·  Next: ' + nn.next.title : '')));
    card.appendChild(cap);
    return card;
  };

  LiveWall.prototype.current = function () {
    var z = this.stack.current();
    var item = z && z.current();
    return item ? item.x : null;
  };

  LiveWall.prototype.shelfIndex = function () { return this.stack.index; };

  LiveWall.prototype.focusShelf = function (i) {
    if (i === this.stack.index) return;
    if (this.focused) this.stack.moveTo(i);
    else {
      this.stack.index = i;
      this.stack.layout();
    }
  };

  LiveWall.prototype.tune = function (si, i) {
    var s = this.shelves[si];
    if (!s || !this.opts.onTune) return;
    this.opts.onTune(s.items.map(function (x) { return x.channel; }), i, 'On now › ' + s.label);
  };

  LiveWall.prototype.menu = function (x) {
    if (!this.opts.onMenu) return false;
    var self = this;
    var si = this.stack.index;
    var z = this.stack.current();
    var i = z ? z.index : 0;
    return this.opts.onMenu(x.channel, function () { self.tune(si, i); });
  };

  LiveWall.prototype.setFocused = function (on) {
    this.focused = on;
    this.stack.focus(on);
  };

  LiveWall.prototype.show = function (on) {
    this.el.classList.toggle('lw-on', on);
  };

  LiveWall.prototype.key = function (code, repeat) {
    var z = this.stack.current();
    if (!z) return false;
    if (code === K.UP && this.stack.index === 0) {
      if (this.opts.onTop) this.opts.onTop();
      return true;
    }
    if (code === K.LEFT && z.index === 0) {
      if (this.opts.onRail && !repeat) this.opts.onRail();
      return true;
    }
    if (code === K.YELLOW) {
      var x = this.current();
      if (x) {
        var on = G.toggleFavourite(x.channel.identifier);
        PL.toast(on ? 'Added ' + x.channel.name + ' to Favourites' : 'Removed ' + x.channel.name + ' from Favourites');
      }
      return true;
    }
    if (code === K.PLAY || code === K.PLAY_PAUSE) code = K.ENTER;
    return this.stack.key(code);
  };

  PL.LiveWall = LiveWall;
})();
