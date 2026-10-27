// The live player's controls (docs/LIVETV-v2-design.md): the channel banner (now/next, programme
// progress, the pause buffer when there is one), the mini guide over the picture, channel-number
// entry and last channel. The player (js/screens/player.js) owns tuning and the stream and hands
// every key to this when it plays a channel; this owns only the overlay.
'use strict';

(function () {
  var K = PL.KEY;
  var L = PL.liveLogic;
  var G = PL.liveGuide;

  var BANNER_MS = 5000;
  var GUIDE_IDLE_MS = 15000;
  var ENTRY_MS = 2000;
  var BAR_W = 1728;
  var ROW = 104;              // mini guide row pitch
  var ROWS_ABOVE = 3;         // rows shown above the focused one
  var ROWS_BELOW = 4;

  var GLYPHS = {
    star: [['path', { d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z' }]],
    starOn: { fill: true, parts: [['path', { d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z' }]] },
    list: [['path', { d: 'M8 6.5h12M8 12h12M8 17.5h12' }], ['path', { d: 'M4 6.5h.5M4 12h.5M4 17.5h.5' }]],
    last: [['path', { d: 'M9 7L4.5 11.5 9 16' }], ['path', { d: 'M5 11.5h9.5a5 5 0 0 1 0 10H12' }]],
    live: { fill: true, parts: [['path', { d: 'M4 5.5v13l9-6.5z' }], ['rect', { x: 15, y: 5.5, width: 3.4, height: 13, rx: 1 }]] },
    restart: [['path', { d: 'M4 12a8 8 0 1 0 2.5-5.8' }], ['path', { d: 'M4 4v4.5h4.5' }]],
    pause: { fill: true, parts: [['rect', { x: 6, y: 5, width: 4, height: 14, rx: 1 }], ['rect', { x: 14, y: 5, width: 4, height: 14, rx: 1 }]] },
  };

  function now() { return Math.floor(Date.now() / 1000); }
  function pointing() { return document.body.classList.contains('pointer'); }
  function glyph(name, size) { return PL.glyph(GLYPHS[name], size || 32, 1.8); }

  function hint(parent, key, label) {
    var h = PL.el('div', 'osd-hint');
    h.appendChild(PL.el('span', 'keycap', key));
    h.appendChild(PL.el('span', '', label));
    parent.appendChild(h);
    return h;
  }

  function logoPlate(cls, thumb, name, w, h) {
    var plate = PL.el('div', cls);
    var src = thumb ? PL.plex.image(thumb, w, h, { format: 'png' }) : null;
    if (src) {
      var img = PL.el('img');
      img.width = w;
      img.height = h;
      img.onload = function () { plate.classList.add('loaded'); };
      img.onerror = function () { img.style.visibility = 'hidden'; };
      img.src = src;
      plate.appendChild(img);
    } else {
      plate.appendChild(PL.el('span', 'live-logo-text', (name || '').slice(0, 10)));
    }
    return plate;
  }

  function LiveOsd(player) {
    this.p = player;
    this.view = 'none';       // none | banner | guide
    this.zone = 'bar';        // in the banner: bar | icons
    this.icons = [];
    this.iconIndex = 0;
    this.entry = null;
    this.behind = 0;          // seconds behind live (from the video's range, or counted while paused)
    this.pausedAt = 0;
    this.gIndex = 0;          // mini guide focus (index into the channel list)
    this.gRows = {};
    this.painted = {};
    this.build();
    var self = this;
    this.unlisten = G.listen(function () {
      if (self.view === 'banner') self.paintBanner();
      if (self.view === 'guide') self.renderGuide(true);
    });
    var v = player.video;
    v.addEventListener('pause', function () { if (!self.pausedAt) self.pausedAt = Date.now(); self.paintBanner(); });
    v.addEventListener('playing', function () {
      if (self.pausedAt) self.behind += (Date.now() - self.pausedAt) / 1000;
      self.pausedAt = 0;
      self.paintBanner();
    });
  }

  // ---- DOM -----------------------------------------------------------------------------------------

  LiveOsd.prototype.build = function () {
    var self = this;
    var root = this.el = PL.el('div', 'live view-none');
    this.p.el.classList.add('live-player');

    // the banner: the player's bottom block, with the programme's progress instead of a seek bar
    var b = this.banner = PL.el('div', 'live-banner');
    b.appendChild(PL.el('div', 'osd-scrim'));
    this.logoHost = PL.el('div', 'live-logo-host');
    b.appendChild(this.logoHost);
    var text = this.textBox = PL.el('div', 'osd-text live-text');
    this.eyebrow = PL.el('div', 'osd-eyebrow');
    this.title = PL.el('div', 'osd-title');
    text.appendChild(this.eyebrow);
    text.appendChild(this.title);
    b.appendChild(text);
    this.iconRow = PL.el('div', 'osd-icons live-icons');
    b.appendChild(this.iconRow);
    var bar = PL.el('div', 'live-bar');
    this.barAvail = PL.el('div', 'live-bar-avail');
    this.barFill = PL.el('div', 'live-bar-fill');
    this.barEdge = PL.el('div', 'live-bar-edge');
    this.barHead = PL.el('div', 'live-bar-head');
    this.barHead.appendChild(PL.el('div', 'bar-knob'));
    [this.barAvail, this.barFill, this.barEdge, this.barHead].forEach(function (n) { bar.appendChild(n); });
    b.appendChild(bar);
    var times = PL.el('div', 'osd-times');
    var left = PL.el('div', 'left');
    var pg = PL.el('span', 'osd-glyph');
    pg.appendChild(glyph('pause', 26));
    this.timesLeft = PL.el('span', '');
    this.timesNote = PL.el('span', 'osd-note');
    left.appendChild(pg);
    left.appendChild(this.timesLeft);
    left.appendChild(this.timesNote);
    this.timesRight = PL.el('div', 'right');
    times.appendChild(left);
    times.appendChild(this.timesRight);
    b.appendChild(times);
    var hints = PL.el('div', 'osd-hints live-hints');
    hint(hints, '▲▼', 'Channels');
    hint(hints, '0–9', 'Channel number');
    this.hintOk = hint(hints, 'OK', 'Pause');
    b.appendChild(hints);
    root.appendChild(b);

    // the mini guide: channels down the left over a wedge scrim; the picture keeps playing
    var g = this.guide = PL.el('div', 'live-guide');
    g.appendChild(PL.el('div', 'live-wedge'));
    this.guideHead = PL.el('div', 'live-guide-head');
    g.appendChild(this.guideHead);
    var clip = PL.el('div', 'live-guide-clip');
    this.guideTrack = PL.el('div', 'live-guide-track');
    clip.appendChild(this.guideTrack);
    g.appendChild(clip);
    var gh = PL.el('div', 'osd-hints live-guide-hints');
    hint(gh, 'OK', 'Watch');
    hint(gh, 'Back', 'Close');
    g.appendChild(gh);
    root.appendChild(g);

    // channel number entry, top right
    this.entryEl = PL.el('div', 'lg-entry live-entry entry-hidden');
    this.entryDigits = PL.el('div', 'lg-entry-digits');
    this.entryName = PL.el('div', 'lg-entry-name');
    this.entryEl.appendChild(this.entryDigits);
    this.entryEl.appendChild(this.entryName);
    root.appendChild(this.entryEl);

    this.p.el.appendChild(root);
    root.addEventListener('click', function (e) { if (self.view !== 'none') e.stopPropagation(); });
  };

  LiveOsd.prototype.setView = function (view) {
    if (this.view === view) return;
    this.el.classList.remove('view-' + this.view);
    this.view = view;
    this.el.classList.add('view-' + view);
  };

  // ---- State --------------------------------------------------------------------------------------

  LiveOsd.prototype.live = function () { return this.p.live; };
  LiveOsd.prototype.channel = function () { return this.p.live.channel; };
  LiveOsd.prototype.playing = function () { return this.p.state === 'playing' || this.p.state === 'paused'; };

  // The pause buffer the TV exposes (null when it doesn't), with how far behind live we are.
  LiveOsd.prototype.buffer = function () {
    var v = this.p.video;
    var s = v.seekable;
    if (!this.playing() || !s || !s.length) return null;
    // a live stream has no end; a file (the demo server's stand-in) is not a buffer
    if (isFinite(v.duration)) return null;
    try {
      return L.buffer(s.start(0), s.end(s.length - 1), v.currentTime || 0);
    } catch (e) {
      return null;
    }
  };

  // Seconds behind live: the video's range when it has one, else counted from pauses.
  LiveOsd.prototype.behindLive = function () {
    var buf = this.buffer();
    if (buf) return buf.behind;
    var paused = this.pausedAt ? (Date.now() - this.pausedAt) / 1000 : 0;
    return this.behind + paused;
  };

  // The airing being watched (at "now minus behind") and the one after it.
  LiveOsd.prototype.airings = function () {
    var c = this.channel();
    var at = now() - Math.round(this.behindLive());
    var nn = G.nowNext(c.identifier, at);
    // no guide data here, but the tuner said what is on: a title without times
    if (!nn.now && this.p.programme) nn = { now: { b: 0, e: 0, title: this.p.programme }, next: nn.next };
    return { at: at, now: nn.now, next: nn.next };
  };

  // ---- The banner ---------------------------------------------------------------------------------

  LiveOsd.prototype.showBanner = function () {
    if (this.view === 'guide') {
      this.armGuideIdle();
      return;
    }
    this.setView('banner');
    this.buildIcons();
    this.paintBanner();
    this.armHide();
  };

  LiveOsd.prototype.hide = function () {
    clearTimeout(this.hideTimer);
    clearTimeout(this.guideTimer);
    this.zone = 'bar';
    this.setView('none');
    this.paintZone();
  };

  LiveOsd.prototype.armHide = function () {
    var self = this;
    clearTimeout(this.hideTimer);
    if (this.view !== 'banner') return;
    // stays while paused, behind live, tuning or failed
    if (this.p.state !== 'playing' || !L.isLive(this.behindLive())) return;
    this.hideTimer = setTimeout(function () {
      if (self.view === 'banner' && self.p.state === 'playing' && L.isLive(self.behindLive())) self.hide();
    }, BANNER_MS);
  };

  LiveOsd.prototype.buildIcons = function () {
    var self = this;
    var buf = this.buffer();
    var behind = !L.isLive(this.behindLive());
    var c = this.channel();
    var list = [];
    if (behind && this.playing()) list.push({ id: 'live', label: 'Go live', glyph: 'live', action: function () { self.goLive(); } });
    var a = this.airings().now;
    if (buf && a && a.b && this.streamTimeOf(a.b, buf) >= buf.start + 1 && now() - a.b > 60) {
      list.push({ id: 'restart', label: 'Start over', glyph: 'restart', action: function () { self.startOver(); } });
    }
    var fav = G.isFavourite(c.identifier);
    list.push({ id: 'fav', label: fav ? 'Remove from Favourites' : 'Add to Favourites', glyph: fav ? 'starOn' : 'star', action: function () { self.favourite(c); } });
    list.push({ id: 'guide', label: 'Channels', glyph: 'list', action: function () { self.openGuide(); } });
    var last = this.lastChannel();
    if (last) list.push({ id: 'last', label: 'Back to ' + last.vcn, glyph: 'last', action: function () { self.tuneLast(); } });
    var sig = list.map(function (x) { return x.id + x.glyph; }).join();
    if (sig === this.iconSig) return;
    this.iconSig = sig;
    var was = this.icons[this.iconIndex] && this.icons[this.iconIndex].id;
    PL.clear(this.iconRow);
    this.icons = list.map(function (ic, i) {
      var n = PL.el('div', 'round');
      n.setAttribute('aria-label', ic.label);
      n.appendChild(glyph(ic.glyph, ic.glyph === 'live' ? 28 : 32));
      var tip = PL.el('div', 'live-tip', ic.label);
      n.appendChild(tip);
      n.addEventListener('mouseenter', function () {
        if (!pointing() || self.view !== 'banner') return;
        self.iconIndex = i;
        self.zone = 'icons';
        self.paintZone();
      });
      n.addEventListener('click', function (e) {
        e.stopPropagation();
        self.iconIndex = i;
        ic.action();
      });
      self.iconRow.appendChild(n);
      return { id: ic.id, node: n, action: ic.action };
    });
    var keep = list.map(function (x) { return x.id; }).indexOf(was);
    this.iconIndex = keep >= 0 ? keep : Math.min(this.iconIndex, list.length - 1);
    // Go live has just appeared: it is what Up should reach first
    if (list[0].id === 'live' && this.hadLive !== true) this.iconIndex = 0;
    this.hadLive = list[0].id === 'live';
    this.paintZone();
  };

  LiveOsd.prototype.paintZone = function () {
    var z = this.view === 'banner' ? this.zone : 'none';
    var cls = 'zone-' + z;
    if (this.zoneClass !== cls) {
      if (this.zoneClass) this.el.classList.remove(this.zoneClass);
      this.el.classList.add(cls);
      this.zoneClass = cls;
    }
    var self = this;
    this.icons.forEach(function (ic, i) { ic.node.classList.toggle('focused', z === 'icons' && i === self.iconIndex); });
  };

  LiveOsd.prototype.set = function (key, node, prop, value) {
    if (this.painted[key] === value) return;
    this.painted[key] = value;
    if (prop === 'text') node.textContent = value;
    else node.style[prop] = value;
  };

  // Channel, programme, progress and next. Cheap to call often: only changed values are written.
  LiveOsd.prototype.paintBanner = function () {
    if (this.view === 'none' && this.painted.ch) return;
    var c = this.channel();
    var t = now();
    if (this.painted.ch !== c.identifier) {
      this.painted.ch = c.identifier;
      PL.clear(this.logoHost);
      this.logoHost.appendChild(logoPlate('live-logo', c.thumb, c.title, 136, 72));
    }
    var behindSec = this.behindLive();
    var live = L.isLive(behindSec);
    var tuning = this.p.state === 'loading' || this.p.state === 'idle';
    var failed = this.p.state === 'error';
    var pill = failed ? 'NO SIGNAL' : tuning ? 'TUNING' : live ? 'LIVE' : L.behindLabel(behindSec);
    var eb = pill + '|' + c.vcn + '|' + c.title + '|' + (G.isFavourite(c.identifier) ? 1 : 0);
    if (this.painted.eb !== eb) {
      this.painted.eb = eb;
      PL.clear(this.eyebrow);
      this.eyebrow.appendChild(PL.el('span', 'osd-live' + (live && !tuning && !failed ? '' : ' osd-live-off'), pill));
      this.eyebrow.appendChild(document.createTextNode(c.vcn + '  ' + (c.title || '')));
      if (G.isFavourite(c.identifier)) this.eyebrow.appendChild(PL.el('span', 'live-fav', '  ★'));
    }
    var ai = this.airings();
    var a = ai.now;
    this.set('title', this.title, 'text', a ? a.title : (this.p.programme || c.title || ''));
    // the programme's bar: what has aired (light), where we are (teal), the live edge (a tick)
    var hasTimes = a && a.e > a.b;
    this.el.classList.toggle('no-times', !hasTimes);
    if (hasTimes) {
      var pos = L.progress(a, ai.at);
      var edge = L.progress(a, t);
      var buf = this.buffer();
      var availFrom = buf ? Math.max(0, L.progress(a, t - (buf.end - buf.start))) : pos;
      this.set('bf', this.barFill, 'transform', 'scaleX(' + pos.toFixed(4) + ')');
      this.set('ba', this.barAvail, 'transform', 'translate3d(' + Math.round(availFrom * BAR_W) + 'px,0,0) scaleX(' + Math.max(0, edge - availFrom).toFixed(4) + ')');
      this.set('be', this.barEdge, 'transform', 'translate3d(' + Math.round(edge * BAR_W) + 'px,0,0)');
      this.set('bh', this.barHead, 'transform', 'translate3d(' + Math.round(pos * BAR_W) + 'px,0,0)');
      this.set('tl', this.timesLeft, 'text', L.clock(a.b) + ' – ' + L.clock(a.e));
      this.set('tn', this.timesNote, 'text', '  ·  ' + (live ? L.span(a.e - t) + ' left' : L.behindText(behindSec)));
    } else {
      this.set('tl', this.timesLeft, 'text', failed ? '' : tuning ? 'Tuning…' : 'No guide information');
      this.set('tn', this.timesNote, 'text', '');
    }
    var next = ai.next;
    this.set('tr', this.timesRight, 'text', next ? 'Next  ' + L.clock(next.b) + '  ' + next.title : '');
    this.el.classList.toggle('behind', !live);
    this.el.classList.toggle('seekable', !!this.buffer());
    this.el.classList.toggle('is-paused', this.p.state === 'paused');
    this.set('ok', this.hintOk.lastChild, 'text', this.p.state === 'paused' ? 'Play' : 'Pause');
    this.hintOk.style.display = this.playing() ? '' : 'none';
    if (this.view === 'banner') this.buildIcons();
  };

  LiveOsd.prototype.onTime = function () {
    var t = Date.now();
    if (this.view !== 'banner' || t - (this.lastPaint || 0) < 900) return;
    this.lastPaint = t;
    this.paintBanner();
  };

  // ---- Buffer: pause, jumps, go live, start over --------------------------------------------------

  // Stream time for a wall-clock time (the live edge is now).
  LiveOsd.prototype.streamTimeOf = function (wall, buf) {
    return buf.end - (now() - wall);
  };

  LiveOsd.prototype.jump = function (sec) {
    var buf = this.buffer();
    if (!buf) return;
    var v = this.p.video;
    var to = PL.clamp((v.currentTime || 0) + sec, buf.start + 1, buf.end - 2);
    v.currentTime = to;
    this.behind = 0;
    this.showBanner();
  };

  LiveOsd.prototype.goLive = function () {
    var buf = this.buffer();
    this.behind = 0;
    this.pausedAt = 0;
    if (buf) {
      this.p.video.currentTime = buf.end - 2;
      if (this.p.video.paused) this.p.togglePause(true);
      this.iconIndex = 0;
      this.zone = 'bar';
      this.showBanner();
      return;
    }
    // no range to seek in: tune again (the stream starts at the live edge)
    this.zone = 'bar';
    this.p.tune(this.channel());
  };

  LiveOsd.prototype.startOver = function () {
    var buf = this.buffer();
    var a = this.airings().now;
    if (!buf || !a) return;
    this.p.video.currentTime = Math.max(buf.start + 1, this.streamTimeOf(a.b, buf));
    if (this.p.video.paused) this.p.togglePause(true);
    this.zone = 'bar';
    this.showBanner();
  };

  // Called by the player when a tune starts: the banner shows the new channel at once.
  LiveOsd.prototype.onTune = function () {
    this.behind = 0;
    this.pausedAt = 0;
    this.painted = {};
    this.iconSig = null;
    if (this.view !== 'guide') {
      this.zone = 'bar';
      this.showBanner();
    }
  };

  LiveOsd.prototype.onState = function () {
    this.paintBanner();
    if (this.view === 'banner') this.armHide();
  };

  // ---- Channels: favourite, last, number entry ------------------------------------------------------

  LiveOsd.prototype.favourite = function (c) {
    c = c || this.channel();
    var on = G.toggleFavourite(c.identifier);
    PL.toast(on ? 'Added ' + c.title + ' to Favourites' : 'Removed ' + c.title + ' from Favourites');
    this.painted.eb = null;
    this.paintBanner();
  };

  LiveOsd.prototype.lastChannel = function () {
    var last = this.p.lastChannel;
    return last && last.identifier !== this.channel().identifier ? last : null;
  };

  LiveOsd.prototype.tuneLast = function () {
    var last = this.lastChannel();
    if (last) this.p.tuneChannel(last, 0);
  };

  LiveOsd.prototype.numbers = function () {
    var list = this.live().channels || [];
    return list.map(function (c) { return c.vcn; });
  };

  LiveOsd.prototype.typeDigit = function (d) {
    var list = this.live().channels || [];
    if (!list.length) return;
    var numbers = this.numbers();
    var max = L.maxDigits(numbers);
    var e = this.entry || (this.entry = { digits: '' });
    e.digits = L.typeDigit(e.digits, d, max);
    var m = L.previewNumber(numbers, e.digits);
    var dashes = '';
    for (var i = e.digits.length; i < max; i++) dashes += '–';
    this.entryDigits.textContent = e.digits + dashes;
    this.entryName.textContent = m ? (m.exact ? '' : (m.prefix ? '' : 'Nearest: ') + list[m.index].vcn + '  ') + list[m.index].title : '';
    this.entryEl.classList.remove('entry-hidden');
    clearTimeout(e.timer);
    var self = this;
    e.timer = setTimeout(function () { self.commitEntry(); }, L.entryDone(numbers, e.digits, max) ? 350 : ENTRY_MS);
  };

  LiveOsd.prototype.cancelEntry = function () {
    if (!this.entry) return false;
    clearTimeout(this.entry.timer);
    this.entry = null;
    this.entryEl.classList.add('entry-hidden');
    return true;
  };

  LiveOsd.prototype.commitEntry = function () {
    var e = this.entry;
    if (!e) return;
    var list = this.live().channels || [];
    var m = L.matchNumber(this.numbers(), e.digits);
    this.cancelEntry();
    if (!m || this.p.state === 'stopped') return;
    if (this.view === 'guide') this.closeGuide();
    if (list[m.index].identifier === this.channel().identifier && this.p.state !== 'error') {
      this.showBanner();
      return;
    }
    this.p.tuneChannel(list[m.index], 0);
  };

  // ---- The mini guide -------------------------------------------------------------------------------

  LiveOsd.prototype.openGuide = function () {
    var list = this.live().channels || [];
    if (!list.length) return;
    clearTimeout(this.hideTimer);
    var idx = this.indexOf(this.channel().identifier);
    this.gIndex = idx >= 0 ? idx : 0;
    this.guideHead.textContent = this.live().label || 'Channels';
    this.clearGuide();
    this.setView('guide');
    this.paintZone();
    this.renderGuide(false);
    this.armGuideIdle();
  };

  LiveOsd.prototype.closeGuide = function () {
    clearTimeout(this.guideTimer);
    this.clearGuide();
    this.setView('none');
    this.showBanner();
  };

  LiveOsd.prototype.armGuideIdle = function () {
    var self = this;
    clearTimeout(this.guideTimer);
    this.guideTimer = setTimeout(function () {
      if (self.view === 'guide') {
        self.clearGuide();
        self.hide();
      }
    }, GUIDE_IDLE_MS);
  };

  LiveOsd.prototype.indexOf = function (identifier) {
    var list = this.live().channels || [];
    for (var i = 0; i < list.length; i++) if (list[i].identifier === identifier) return i;
    return -1;
  };

  LiveOsd.prototype.clearGuide = function () {
    PL.clear(this.guideTrack);
    this.gRows = {};
  };

  // Rows sit in slots around the focus (the list wraps); a move re-slots them, which the CSS
  // animates. Only rows within ROWS_ABOVE/ROWS_BELOW (+1 each way) exist.
  LiveOsd.prototype.renderGuide = function (refresh) {
    var list = this.live().channels || [];
    var n = list.length;
    if (!n) return;
    // a long list wraps round the focus; a short one (fits on screen) doesn't
    var wrap = n > ROWS_ABOVE + ROWS_BELOW + 3;
    var lo = wrap ? -ROWS_ABOVE - 1 : -this.gIndex;
    var hi = wrap ? ROWS_BELOW + 1 : n - 1 - this.gIndex;
    var want = {};
    var self = this;
    var t = now();
    var watching = this.channel().identifier;
    for (var slot = lo; slot <= hi; slot++) {
      var i = ((this.gIndex + slot) % n + n) % n;
      var c = list[i];
      want[c.identifier] = true;
      var r = this.gRows[c.identifier];
      if (!r || refresh) {
        var fresh = this.makeGuideRow(c, i, t);
        if (r) this.guideTrack.replaceChild(fresh.el, r.el);
        else this.guideTrack.appendChild(fresh.el);
        r = this.gRows[c.identifier] = fresh; // placed below without a glide (slot null)
      }
      if (r.slot !== slot) {
        // rows arriving at the edge appear in place; the rest glide
        if (r.slot == null) r.el.style.transition = 'none';
        PL.translate(r.el, 0, (slot + ROWS_ABOVE) * ROW);
        r.slot = slot;
      }
      r.el.classList.toggle('focused', slot === 0);
      r.el.classList.toggle('watching', c.identifier === watching);
    }
    Object.keys(this.gRows).forEach(function (id) {
      if (!want[id]) {
        self.guideTrack.removeChild(self.gRows[id].el);
        delete self.gRows[id];
      }
    });
    // the glide comes back once the new rows are placed
    requestAnimationFrame(function () {
      Object.keys(self.gRows).forEach(function (id) { self.gRows[id].el.style.transition = ''; });
    });
  };

  LiveOsd.prototype.makeGuideRow = function (c, i, t) {
    var el = PL.el('div', 'lmg-row');
    el.appendChild(logoPlate('lmg-logo', c.thumb, c.title, 104, 56));
    var head = PL.el('div', 'lmg-head');
    head.appendChild(PL.el('span', 'lmg-num', c.vcn));
    head.appendChild(document.createTextNode('  ' + (c.title || '')));
    if (G.isFavourite(c.identifier)) head.appendChild(PL.el('span', 'live-fav', '  ★'));
    el.appendChild(head);
    var nn = G.nowNext(c.identifier, t);
    el.appendChild(PL.el('div', 'lmg-now', nn.now ? nn.now.title : 'No guide information'));
    var foot = PL.el('div', 'lmg-foot');
    if (nn.now) {
      var bar = PL.el('div', 'lmg-bar');
      var fill = PL.el('div', 'lmg-fill');
      fill.style.transform = 'scaleX(' + L.progress(nn.now, t).toFixed(3) + ')';
      bar.appendChild(fill);
      foot.appendChild(bar);
      foot.appendChild(document.createTextNode(L.span(nn.now.e - t) + ' left' + (nn.next ? '  ·  Next ' + nn.next.title : '')));
    } else if (nn.next) {
      foot.appendChild(document.createTextNode('Next ' + L.clock(nn.next.b) + '  ' + nn.next.title));
    }
    el.appendChild(foot);
    var self = this;
    el.addEventListener('mouseenter', function () {
      if (!pointing() || self.view !== 'guide' || self.gIndex === i) return;
      self.gIndex = i;
      self.renderGuide(false);
      self.armGuideIdle();
    });
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      self.gIndex = i;
      self.guideTune();
    });
    return { el: el, slot: null };
  };

  LiveOsd.prototype.guideMove = function (d) {
    var n = (this.live().channels || []).length;
    if (!n) return;
    this.gIndex = ((this.gIndex + d) % n + n) % n;
    this.renderGuide(false);
    this.armGuideIdle();
  };

  LiveOsd.prototype.guideTune = function () {
    var list = this.live().channels || [];
    var c = list[this.gIndex];
    if (!c) return;
    this.clearGuide();
    this.setView('none');
    if (c.identifier === this.channel().identifier && this.p.state !== 'error') {
      this.showBanner();
      return;
    }
    this.p.tuneChannel(c, 0);
  };

  // ---- Keys ---------------------------------------------------------------------------------------

  var NAMES = {};
  NAMES[K.LEFT] = 'left';
  NAMES[K.RIGHT] = 'right';
  NAMES[K.UP] = 'up';
  NAMES[K.DOWN] = 'down';
  NAMES[K.ENTER] = 'ok';

  LiveOsd.prototype.key = function (code, held) {
    var p = this.p;
    if (code >= 48 && code <= 57) {
      if (!held) this.typeDigit(code - 48);
      return true;
    }
    if (this.entry) {
      if (code === K.ENTER) { this.commitEntry(); return true; }
      if (PL.isBack(code)) { this.cancelEntry(); return true; }
    }
    var playing = this.playing();
    switch (code) {
      case K.STOP: p.exit(); return true;
      case K.CH_UP:
      case K.CH_DOWN:
        if (this.view === 'guide') this.guideMove(code === K.CH_UP ? -(ROWS_ABOVE + ROWS_BELOW) : ROWS_ABOVE + ROWS_BELOW);
        else p.changeChannel(code === K.CH_UP ? 1 : -1);
        return true;
      case K.PLAY_PAUSE: if (playing && !held) p.togglePause(); return true;
      case K.PLAY: if (playing) p.togglePause(true); return true;
      case K.PAUSE: if (playing) p.togglePause(false); return true;
      case K.FF:
      case K.NEXT_TRACK:
        if (this.buffer()) this.jump(30);
        else if (!held && !L.isLive(this.behindLive())) this.goLive();
        else this.showBanner();
        return true;
      case K.REW:
      case K.PREV_TRACK:
        if (this.buffer()) this.jump(-10);
        else this.showBanner();
        return true;
      case K.INFO:
        if (this.view === 'banner') this.hide();
        else this.showBanner();
        return true;
      case K.YELLOW:
        if (!held) this.favourite(this.view === 'guide' ? (this.live().channels || [])[this.gIndex] : null);
        if (this.view === 'guide') this.renderGuide(true);
        return true;
      case K.RED:
        if (!held) this.tuneLast();
        return true;
      default:
        break;
    }
    var name = PL.isBack(code) ? 'back' : NAMES[code];
    if (!name) return true;
    // a failed tune keeps the banner up: Back leaves at once rather than just hiding it
    if (name === 'back' && this.p.state === 'error' && this.view === 'banner' && !held) {
      this.p.exit();
      return true;
    }
    if (held && !(this.view === 'guide' && (name === 'up' || name === 'down')) && name !== 'left' && name !== 'right') return true;
    var action = L.liveKey({
      view: this.view, zone: this.zone, canSeek: !!this.buffer(), playing: playing, hasIcons: this.icons.length > 0,
    }, name);
    this.act(action);
    return true;
  };

  LiveOsd.prototype.act = function (action) {
    switch (action) {
      case 'exit': this.p.exit(); return;
      case 'banner': this.showBanner(); return;
      case 'hide': this.hide(); return;
      case 'guide-open': this.openGuide(); return;
      case 'guide-close': this.closeGuide(); return;
      case 'guide-up': this.guideMove(-1); return;
      case 'guide-down': this.guideMove(1); return;
      case 'guide-tune': this.guideTune(); return;
      case 'jump-back': this.jump(-10); return;
      case 'jump-fwd': this.jump(30); return;
      case 'toggle-pause': this.p.togglePause(); return;
      case 'zone-icons': this.zone = 'icons'; break;
      case 'zone-bar': this.zone = 'bar'; break;
      case 'icon-prev': this.iconIndex = Math.max(0, this.iconIndex - 1); break;
      case 'icon-next': this.iconIndex = Math.min(this.icons.length - 1, this.iconIndex + 1); break;
      case 'icon-press':
        if (this.icons[this.iconIndex]) this.icons[this.iconIndex].action();
        return;
      default:
        if (this.view === 'banner') this.armHide();
        return;
    }
    this.paintZone();
    this.armHide();
  };

  LiveOsd.prototype.destroy = function () {
    clearTimeout(this.hideTimer);
    clearTimeout(this.guideTimer);
    this.cancelEntry();
    if (this.unlisten) this.unlisten();
  };

  PL.LiveOsd = LiveOsd;
})();
