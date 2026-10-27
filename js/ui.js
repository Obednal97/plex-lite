// UI building blocks: shelves (virtualised horizontal rows), the poster grid, button and chip rows,
// a vertical stack that scrolls between them, and the shared focus shadow.
//
// Performance rules: only cards near the screen exist in the DOM; scrolling and focus are
// transform/opacity only; one shadow element per screen follows the focus instead of a
// box-shadow per card.
'use strict';

(function () {
  var ui = PL.ui = {};

  ui.SCREEN_W = 1920;
  ui.SCREEN_H = 1080;
  ui.MARGIN = 96;

  // Shelf opts.geometry overrides these (custom card kinds such as cast portraits use it with
  // opts.makeCard(item, kind, geo) -> node with .card and .card-inner).
  ui.GEOMETRY = {
    // fewer, larger cards with more air (docs/DESIGN.md); scale is the focus pop
    poster: { w: 250, h: 375, pitch: 280, scale: 1.09 },
    wide: { w: 420, h: 236, pitch: 448, scale: 1.09 },
    season: { w: 200, h: 300, pitch: 228, scale: 1.09 },
    // people: square photo shown as a circle (ui.makePersonCard); circles need a bigger pop to read
    person: { w: 190, h: 190, pitch: 230, scale: 1.13, round: true },
  };

  // ---- Item helpers ------------------------------------------------------------------------------

  ui.itemTitle = function (item) {
    if (item.type === 'episode') return item.grandparentTitle || item.title;
    if (item.type === 'season') return item.parentTitle ? item.parentTitle : item.title;
    return item.title;
  };

  ui.itemSubtitle = function (item) {
    if (item.type === 'collection') return item.childCount ? item.childCount + ' items' : '';
    if (item.type === 'episode') {
      var ep = PL.fmt.episode(item);
      return (ep ? ep + ' · ' : '') + item.title;
    }
    if (item.type === 'season') return item.title;
    if (item.type === 'show') return item.childCount ? item.childCount + (item.childCount === 1 ? ' season' : ' seasons') : (item.year || '');
    return item.year ? String(item.year) : '';
  };

  ui.progress = function (item) {
    if (!item.viewOffset || !item.duration) return 0;
    return PL.clamp(item.viewOffset / item.duration, 0, 1);
  };

  ui.isWatched = function (item) {
    if (item.type === 'show' || item.type === 'season') return item.leafCount > 0 && item.viewedLeafCount === item.leafCount;
    return item.viewCount > 0 && !item.viewOffset;
  };

  ui.posterPath = function (item) {
    if (item.type === 'episode') return item.grandparentThumb || item.parentThumb || item.thumb;
    if (item.type === 'season') return item.thumb || item.parentThumb;
    return item.thumb;
  };

  ui.widePath = function (item) {
    if (item.type === 'episode') return item.thumb || item.grandparentArt || item.art;
    return item.art || item.thumb;
  };

  ui.artPath = function (item) {
    if (!item) return null;
    if (item.type === 'episode') return item.grandparentArt || item.art || item.thumb;
    if (item.type === 'season') return item.art || item.parentArt;
    return item.art || item.thumb;
  };

  ui.ambient = function (path) {
    return PL.plex.image(path, 480, 270, { blur: 28, opacity: 50, background: '2b2b2e', format: 'jpeg', quality: 70 });
  };

  // ---- Shared focus shadow ---------------------------------------------------------------------

  // One per screen. Re-parented into whichever track holds the focused card, so it rides the
  // track's transform and only its own transform changes when focus moves.
  function FocusShadow() {
    this.el = PL.el('div', 'focus-shadow');
  }

  // On a jump to another track the shadow is placed without a transition (re-enabled next frame)
  // rather than forcing a synchronous layout.
  // round: circular cards (people) get a circular shadow
  FocusShadow.prototype.place = function (parent, x, y, w, h, scale, round) {
    this.el.style.borderRadius = round ? '50%' : '';
    if (this.el.parentNode !== parent) {
      var el = this.el;
      el.classList.add('instant');
      parent.appendChild(el);
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove('instant'); }); });
    }
    this.el.style.width = w + 'px';
    this.el.style.height = h + 'px';
    this.el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + scale + ')';
    this.el.style.opacity = '1';
  };

  FocusShadow.prototype.hide = function () {
    this.el.style.opacity = '0';
  };

  ui.FocusShadow = FocusShadow;

  // ---- Cards -----------------------------------------------------------------------------------

  // cardOpts.episodeTitles: inside a show's own page, title episode cards by episode, not show
  function makeCard(item, kind, geo, cardOpts) {
    var card = PL.el('div', 'card card-' + kind);
    var inner = PL.el('div', 'card-inner');
    inner.style.width = geo.w + 'px';
    inner.style.height = geo.h + 'px';
    var path = kind === 'wide' ? ui.widePath(item) : ui.posterPath(item);
    var src = path ? PL.plex.image(path, geo.w, geo.h) : null;
    if (src) {
      var img = PL.el('img', 'card-img');
      img.width = geo.w;
      img.height = geo.h;
      img.onerror = function () { img.style.visibility = 'hidden'; inner.classList.add('no-art'); };
      ui.fadeInImage(img, src);
      inner.appendChild(img);
    } else {
      inner.classList.add('no-art');
    }
    inner.appendChild(PL.el('div', 'card-fallback', ui.itemTitle(item)));
    var p = ui.progress(item);
    if (p > 0) {
      var bar = PL.el('div', 'card-progress');
      var fill = PL.el('div', 'card-progress-fill');
      fill.style.transform = 'scaleX(' + p.toFixed(3) + ')';
      bar.appendChild(fill);
      inner.appendChild(bar);
    } else if (ui.isWatched(item)) {
      inner.appendChild(PL.el('div', 'card-check'));
    }
    inner.appendChild(PL.el('div', 'card-edge'));
    card.appendChild(inner);
    var meta = PL.el('div', 'card-meta');
    meta.style.width = geo.w + 'px';
    if (kind === 'wide' && cardOpts && cardOpts.episodeTitles && item.type === 'episode') {
      meta.appendChild(PL.el('div', 'card-title', item.title));
      var bits = [PL.fmt.episode(item), PL.fmt.remaining(item) || PL.fmt.duration(item.duration)].filter(Boolean);
      meta.appendChild(PL.el('div', 'card-sub', bits.join(' · ')));
    } else if (kind === 'wide') {
      meta.appendChild(PL.el('div', 'card-title', ui.itemTitle(item)));
      var sub = ui.itemSubtitle(item);
      var rem = PL.fmt.remaining(item);
      meta.appendChild(PL.el('div', 'card-sub', rem ? sub + ' · ' + rem : sub));
    } else {
      meta.appendChild(PL.el('div', 'card-title', kind === 'season' ? item.title : ui.itemTitle(item)));
      meta.appendChild(PL.el('div', 'card-sub', kind === 'season' ? (item.leafCount ? item.leafCount + ' episodes' : '') : ui.itemSubtitle(item)));
    }
    card.appendChild(meta);
    return card;
  }

  function makePlaceholder(kind, geo) {
    var card = PL.el('div', 'card card-' + kind + ' card-placeholder');
    var inner = PL.el('div', 'card-inner');
    inner.style.width = geo.w + 'px';
    inner.style.height = geo.h + 'px';
    card.appendChild(inner);
    return card;
  }

  ui.makeCard = makeCard;

  // Round portrait cards (details Cast & Crew, Search People). Accepts a Plex role/person
  // ({name|tag|title, thumb, role|sub}) so both callers can pass what they already have.
  ui.PERSON_GEO = ui.GEOMETRY.person;

  function initials(name) {
    var parts = String(name || '').split(/\s+/).filter(Boolean);
    var first = parts[0] ? parts[0].charAt(0) : '';
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
  }

  ui.makePersonCard = function (person, kind, geo) {
    geo = geo || ui.PERSON_GEO;
    var name = person.name || person.tag || person.title || '';
    var role = person.role || person.sub || '';
    var card = PL.el('div', 'card card-person');
    var inner = PL.el('div', 'card-inner');
    inner.style.width = geo.w + 'px';
    inner.style.height = geo.h + 'px';
    inner.appendChild(PL.el('div', 'person-initials', initials(name)));
    if (person.thumb) {
      var img = PL.el('img', 'card-img');
      img.width = geo.w;
      img.height = geo.h;
      img.onerror = function () { img.style.visibility = 'hidden'; };
      ui.fadeInImage(img, PL.plex.image(person.thumb, geo.w, geo.h));
      inner.appendChild(img);
    }
    inner.appendChild(PL.el('div', 'card-edge'));
    card.appendChild(inner);
    var meta = PL.el('div', 'card-meta person-meta');
    meta.appendChild(PL.el('div', 'card-title', name));
    if (role) meta.appendChild(PL.el('div', 'card-sub', role));
    card.appendChild(meta);
    return card;
  };

  // ---- Shelf: a virtualised horizontal row ---------------------------------------------------

  // opts: {title, items, kind, total, loadMore(start) -> Promise<items>, onSelect(item, index),
  //        onFocusItem(item, index), shadow}
  function Shelf(opts) {
    this.opts = opts;
    this.kind = opts.kind || 'poster';
    this.geo = opts.geometry || ui.GEOMETRY[this.kind];
    this.items = opts.items.slice();
    this.total = Math.max(opts.total || 0, this.items.length);
    this.index = PL.clamp(opts.index || 0, 0, Math.max(0, this.items.length - 1));
    this.focused = false;
    this.nodes = {};
    this.loading = false;
    this.el = PL.el('div', 'shelf shelf-' + this.kind);
    if (opts.title) this.el.appendChild(PL.el('div', 'shelf-title', opts.title));
    this.track = PL.el('div', 'shelf-track');
    this.el.appendChild(this.track);
    // landscape cards carry their title on the art, so they only need room for the focus pop
    this.height = (opts.title ? 60 : 0) + this.geo.h + (this.kind === 'wide' ? 56 : 124);
    this.left = opts.left != null ? opts.left : ui.MARGIN;
    this.attached = false;
  }

  Shelf.prototype.maxShift = function () {
    var visible = ui.SCREEN_W - ui.MARGIN - this.left;
    var width = this.total * this.geo.pitch - (this.geo.pitch - this.geo.w);
    return Math.max(0, width - visible);
  };

  Shelf.prototype.shift = function () {
    return Math.min(this.index * this.geo.pitch, this.maxShift());
  };

  Shelf.prototype.attach = function () {
    this.attached = true;
    this.render();
  };

  // Drops every card node (the shelf is far off screen); state is kept for when it comes back.
  Shelf.prototype.detach = function () {
    this.attached = false;
    var self = this;
    Object.keys(this.nodes).forEach(function (k) { self.track.removeChild(self.nodes[k]); });
    this.nodes = {};
  };

  Shelf.prototype.render = function () {
    if (!this.attached) return;
    var shift = this.shift();
    if (shift !== this.lastShift) {
      ui.glide(this.track, this);
      this.lastShift = shift;
    }
    PL.translate(this.track, this.left - shift, 0);
    var pitch = this.geo.pitch;
    var first = Math.max(0, Math.floor((shift - this.left) / pitch) - 1);
    var last = Math.min(this.total - 1, Math.ceil((shift + ui.SCREEN_W) / pitch) + 1);
    var self = this;
    Object.keys(this.nodes).forEach(function (k) {
      var i = Number(k);
      if (i < first || i > last) {
        self.track.removeChild(self.nodes[k]);
        delete self.nodes[k];
      }
    });
    for (var i = first; i <= last; i++) {
      var node = this.nodes[i];
      var item = this.items[i];
      if (node && item && node.classList.contains('card-placeholder')) {
        this.track.removeChild(node);
        node = null;
      }
      if (!node) {
        node = item ? (this.opts.makeCard || makeCard)(item, this.kind, this.geo, this.opts.cardOpts) : makePlaceholder(this.kind, this.geo);
        node.style.left = (i * pitch) + 'px';
        node.addEventListener('click', this.onClick.bind(this, i));
        this.track.appendChild(node);
        this.nodes[i] = node;
      }
      node.classList.toggle('focused', this.focused && i === this.index);
    }
    if (this.focused && this.opts.shadow) {
      this.opts.shadow.place(this.track, this.index * pitch, 0, this.geo.w, this.geo.h, this.geo.scale, this.geo.round);
    }
    if (last >= this.items.length - 4 && this.items.length < this.total) this.loadMore();
  };

  Shelf.prototype.onClick = function (i) {
    this.index = i;
    if (this.opts.onSelect && this.items[i]) this.opts.onSelect(this.items[i], i);
  };

  Shelf.prototype.loadMore = function () {
    if (this.loading || !this.opts.loadMore) return;
    this.loading = true;
    var self = this;
    this.opts.loadMore(this.items.length).then(function (more) {
      self.loading = false;
      if (!more.length) {
        self.total = self.items.length;
      } else {
        self.items = self.items.concat(more);
        self.total = Math.max(self.total, self.items.length);
      }
      self.render();
    }, function (err) {
      self.loading = false;
      PL.warn('shelf loadMore failed', err && err.message);
    });
  };

  Shelf.prototype.setFocused = function (on) {
    this.focused = on;
    if (!on && this.opts.shadow && this.opts.shadow.el.parentNode === this.track) this.opts.shadow.hide();
    this.el.classList.toggle('shelf-focused', on);
    this.render();
    if (on && this.opts.onFocusItem && this.items[this.index]) this.opts.onFocusItem(this.items[this.index], this.index);
  };

  Shelf.prototype.current = function () {
    return this.items[this.index];
  };

  // Long-press OK on a card opens its quick actions (PL.screens.itemMenu); onDone repaints the card.
  ui.longPress = function (item, onDone) {
    return !!(PL.screens && PL.screens.itemMenu && PL.screens.itemMenu(item, onDone));
  };

  Shelf.prototype.refreshItem = function (ratingKey) {
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i] && this.items[i].ratingKey === ratingKey && this.nodes[i]) {
        this.track.removeChild(this.nodes[i]);
        delete this.nodes[i];
      }
    }
    this.render();
  };

  Shelf.prototype.key = function (code) {
    var K = PL.KEY;
    if (code === K.OK_LONG) {
      var held = this.items[this.index];
      var self = this;
      return !!held && (this.opts.onLongPress || ui.longPress)(held, function () { self.refreshItem(held.ratingKey); });
    }
    if (code === K.LEFT || code === K.RIGHT) {
      var next = this.index + (code === K.RIGHT ? 1 : -1);
      if (next < 0 || next >= this.items.length) return false;
      this.index = next;
      this.render();
      if (this.opts.onFocusItem) this.opts.onFocusItem(this.items[next], next);
      return true;
    }
    if (code === K.ENTER) {
      var item = this.items[this.index];
      if (item && this.opts.onSelect) this.opts.onSelect(item, this.index);
      return true;
    }
    return false;
  };

  Shelf.prototype.replaceItems = function (items, total) {
    var key = this.items[this.index] && this.items[this.index].ratingKey;
    this.items = items.slice();
    this.total = Math.max(total || 0, this.items.length);
    var found = -1;
    for (var i = 0; i < this.items.length; i++) if (this.items[i].ratingKey === key) { found = i; break; }
    this.index = PL.clamp(found >= 0 ? found : this.index, 0, Math.max(0, this.items.length - 1));
    var self = this;
    Object.keys(this.nodes).forEach(function (k) { self.track.removeChild(self.nodes[k]); });
    this.nodes = {};
    this.render();
  };

  ui.Shelf = Shelf;

  // ---- Motion helpers (docs/MOTION.md) -----------------------------------------------------------

  // A value that is retargeted while it is still moving keeps its speed (PlxNative's springs do;
  // a CSS transition would restart from rest), so the next move takes the "glide" curve.
  ui.glide = function (el, owner) {
    var now = Date.now();
    el.classList.toggle('glide', now - (owner.movedAt || 0) < 380);
    owner.movedAt = now;
  };

  // Plays a one-shot entrance (CSS animation class) after `delay` ms and removes the class when it
  // ends, so no layer lingers once the element is at rest.
  ui.enter = function (el, cls, delay) {
    el.style.animationDelay = Math.min(delay || 0, 320) + 'ms';
    el.classList.add(cls);
    var done = function () {
      el.removeEventListener('animationend', done);
      el.classList.remove(cls);
      el.style.animationDelay = '';
    };
    el.addEventListener('animationend', done);
  };

  // Art that arrives after its placeholder dissolves in; art already in memory is drawn at once.
  ui.fadeInImage = function (img, src) {
    img.src = src;
    if (img.complete && img.naturalWidth) return;
    img.classList.add('img-wait');
    img.addEventListener('load', function () { img.classList.remove('img-wait'); });
  };

  // One selection plate and one focus capsule per bar, each a single element that travels between
  // the measured pills (PlxNative's TabStrip: "OK moves the plate", the capsule follows focus).
  function Glider(container) {
    this.container = container;
    this.plateEl = PL.el('div', 'glide-plate');
    this.capEl = PL.el('div', 'glide-cap');
    container.insertBefore(this.capEl, container.firstChild);
    container.insertBefore(this.plateEl, container.firstChild);
    this.rects = null;
  }

  Glider.prototype.measure = function (nodes) {
    if (this.rects && this.rects.length === nodes.length && this.rects.w) return this.rects;
    var rects = nodes.map(function (n) { return { x: n.offsetLeft, w: n.offsetWidth }; });
    var total = rects.reduce(function (a, r) { return a + r.w; }, 0);
    if (!total) return null; // not laid out yet (screen still parked)
    rects.w = total;
    this.rects = rects;
    return rects;
  };

  Glider.prototype.invalidate = function () { this.rects = null; };

  Glider.prototype.place = function (el, r, on, land) {
    if (!r) {
      el.classList.remove('on');
      return;
    }
    var first = !el.style.width || land;
    if (first) el.classList.add('instant');
    el.style.width = r.w + 'px';
    el.style.transform = 'translate3d(' + r.x + 'px,0,0)';
    if (on) el.classList.add('on');
    if (first) {
      el.offsetWidth; // the first placement lands; later ones travel
      el.classList.remove('instant');
    }
  };

  Glider.prototype.plate = function (r) { this.place(this.plateEl, r, true); };
  // a capsule that was not showing LANDS on its pill rather than flying in from where it last was
  Glider.prototype.cap = function (r) { this.place(this.capEl, r, true, !this.capEl.classList.contains('on')); };

  ui.Glider = Glider;

  // ---- Title art (Plex clearLogo) ------------------------------------------------------------------

  // The item's clearLogo path, or for an episode/season its show's (hub items carry the show's).
  ui.logoPath = function (item) {
    var imgs = (item && item.Image) || [];
    for (var i = 0; i < imgs.length; i++) if (imgs[i].type === 'clearLogo' && imgs[i].url) return imgs[i].url;
    return null;
  };

  // A reserved box holding the logo, sized by CONSTANT AREA (PlxNative's rule: a square emblem and
  // a wide wordmark carry the same weight), bottom-left aligned; the text title shows instead if the
  // logo is missing or fails. opts: {area, minH, maxH, boxW, small, textClass}
  ui.titleArt = function (item, title, opts) {
    opts = opts || {};
    var path = ui.logoPath(item);
    if (!path) return null;
    var box = PL.el('div', 'title-art' + (opts.small ? ' small' : ''));
    var text = PL.el('div', 'title-art-text ' + (opts.textClass || 'hero-title'), title || '');
    box.appendChild(text);
    var img = PL.el('img', '');
    img.alt = '';
    var settled = false;
    var fallback = function () {
      if (settled) return;
      settled = true;
      box.classList.add('fallback');
    };
    img.onload = function () {
      if (settled) return;
      settled = true;
      var aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
      var area = opts.area || 72000;
      var h = PL.clamp(Math.sqrt(area / aspect), opts.minH || 70, opts.maxH || 200);
      var w = h * aspect;
      var boxW = opts.boxW || 760;
      if (w > boxW) { w = boxW; h = w / aspect; }
      img.style.width = Math.round(w) + 'px';
      img.style.height = Math.round(h) + 'px';
      box.classList.add('loaded');
    };
    img.onerror = fallback;
    setTimeout(fallback, 2500);
    img.src = PL.plex.image(path, 800, 300, { format: 'png', minSize: 0, upscale: 0 });
    box.appendChild(img);
    return box;
  };

  // ---- Icons: Phosphor (js/icons.js, generated) as inline SVG -------------------------------

  var SVG = 'http://www.w3.org/2000/svg';

  ui.icon = function (name) {
    var parts = PL.ICONS && PL.ICONS[name];
    if (!parts) return null;
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('fill', 'currentColor');
    parts.forEach(function (p) {
      var n = document.createElementNS(SVG, p[0]);
      Object.keys(p[1]).forEach(function (k) { n.setAttribute(k, p[1][k]); });
      svg.appendChild(n);
    });
    return svg;
  };

  // ---- Button row: a primary pill, then labelled secondary pills ---------------------------

  // buttons: [{label, icon, kind:'primary'|'round', action()}]
  function ButtonRow(buttons) {
    this.el = PL.el('div', 'button-row');
    this.height = 112;
    this.index = 0;
    this.focused = false;
    this.setButtons(buttons);
  }

  ButtonRow.prototype.setButtons = function (buttons) {
    PL.clear(this.el);
    this.buttons = buttons;
    this.nodes = buttons.map(function (b) {
      var n = PL.el('div', 'btn btn-' + (b.kind === 'primary' ? 'primary' : 'secondary'));
      var ico = b.icon && ui.icon(b.icon);
      if (ico) n.appendChild(ico);
      if (b.label) n.appendChild(PL.el('span', 'btn-label', b.label));
      return n;
    });
    var self = this;
    this.nodes.forEach(function (n, i) {
      n.addEventListener('click', function () { self.index = i; self.press(); });
      self.el.appendChild(n);
    });
    this.index = PL.clamp(this.index, 0, buttons.length - 1);
    this.paint();
  };

  ButtonRow.prototype.paint = function () {
    var self = this;
    this.nodes.forEach(function (n, i) { n.classList.toggle('focused', self.focused && i === self.index); });
    this.hint();
  };

  ButtonRow.prototype.hint = function () {
    var b = this.buttons[this.index];
    if (this.onHint) this.onHint(this.focused && b ? b.hint || '' : '');
  };

  ButtonRow.prototype.setFocused = function (on) {
    this.focused = on;
    this.paint();
  };

  ButtonRow.prototype.press = function () {
    var b = this.buttons[this.index];
    if (b && b.action) b.action();
  };

  ButtonRow.prototype.key = function (code) {
    var K = PL.KEY;
    if (code === K.LEFT || code === K.RIGHT) {
      var next = this.index + (code === K.RIGHT ? 1 : -1);
      if (next < 0 || next >= this.buttons.length) return false;
      this.index = next;
      this.paint();
      return true;
    }
    if (code === K.ENTER) {
      this.press();
      return true;
    }
    return false;
  };

  ui.ButtonRow = ButtonRow;

  // ---- Chip row (seasons, sort options) -------------------------------------------------------

  // chips: [{label, value}], opts: {selected, onChange(value, index), title}
  function ChipRow(chips, opts) {
    this.opts = opts || {};
    this.el = PL.el('div', 'chip-row sliding');
    this.track = PL.el('div', 'chip-track');
    this.el.appendChild(this.track);
    this.glider = new Glider(this.track);
    this.height = 88;
    this.focused = false;
    this.chips = chips;
    this.selected = PL.clamp(this.opts.selected || 0, 0, chips.length - 1);
    this.index = this.selected;
    var self = this;
    this.nodes = chips.map(function (c, i) {
      var n = PL.el('div', 'chip', c.label);
      n.addEventListener('click', function () { self.index = i; self.choose(); });
      self.track.appendChild(n);
      return n;
    });
    this.paint();
  }

  ChipRow.prototype.paint = function () {
    var self = this;
    this.nodes.forEach(function (n, i) {
      n.classList.toggle('focused', self.focused && i === self.index);
      n.classList.toggle('selected', i === self.selected);
    });
    var rects = this.glider.measure(this.nodes);
    if (!rects) return;
    this.glider.plate(rects[this.selected]);
    this.glider.cap(this.focused ? rects[this.index] : null);
    // keep the focused chip on screen when there are many (long-running shows)
    var r = rects[this.index];
    if (r) {
      var limit = ui.SCREEN_W - ui.MARGIN * 2;
      var shift = r.x + r.w > limit ? r.x + r.w - limit : 0;
      PL.translate(this.track, -shift, 0);
    }
  };

  ChipRow.prototype.setFocused = function (on) {
    this.focused = on;
    if (!on) this.index = this.selected;
    this.paint();
  };

  ChipRow.prototype.choose = function () {
    if (this.selected === this.index) return;
    this.selected = this.index;
    this.paint();
    if (this.opts.onChange) this.opts.onChange(this.chips[this.index].value, this.index);
  };

  ChipRow.prototype.key = function (code) {
    var K = PL.KEY;
    if (code === K.LEFT || code === K.RIGHT) {
      var next = this.index + (code === K.RIGHT ? 1 : -1);
      if (next < 0 || next >= this.chips.length) return false;
      this.index = next;
      if (this.opts.selectOnFocus) this.choose();
      else this.paint();
      return true;
    }
    if (code === K.ENTER) {
      this.choose();
      return true;
    }
    return false;
  };

  ui.ChipRow = ChipRow;

  // ---- Vertical stack ---------------------------------------------------------------------------

  // Stacks zones (shelves, button rows, chip rows) and scrolls so the focused one sits at
  // anchor(index). Zones more than `keep` away from focus are detached to save memory.
  // opts: {top, anchor(index, zoneTop) -> y, keep, onFocusZone(index)}
  function VStack(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.zones = [];
    this.index = 0;
    this.active = false;
    this.inner = PL.el('div', 'vstack');
    container.appendChild(this.inner);
  }

  // Zones with skip: true (text blocks) are laid out but never focused. A zone without a height
  // is measured once after it is in the DOM.
  VStack.prototype.setZones = function (zones, index) {
    PL.clear(this.inner);
    this.zones = zones;
    var self = this;
    zones.forEach(function (z) {
      z.el.style.position = 'absolute';
      self.inner.appendChild(z.el);
    });
    var y = this.opts.top || 0;
    zones.forEach(function (z) {
      if (z.height == null) z.height = z.el.offsetHeight;
      z.top = y;
      z.el.style.top = y + 'px';
      y += z.height;
    });
    this.index = PL.clamp(index || 0, 0, Math.max(0, zones.length - 1));
    if (zones[this.index] && zones[this.index].skip) this.index = this.nextFocusable(this.index, 1);
    this.layout();
  };

  // A fresh page: its first rows rise in one after another (only rows on screen, capped).
  VStack.prototype.enter = function () {
    var n = 0;
    this.zones.forEach(function (z) {
      if (n < 4 && z.top < ui.SCREEN_H + 200) ui.enter(z.el, 'zone-enter', n++ * 60);
    });
  };

  VStack.prototype.nextFocusable = function (from, dir) {
    for (var i = from; i >= 0 && i < this.zones.length; i += dir) if (!this.zones[i].skip) return i;
    return -1;
  };

  VStack.prototype.layout = function () {
    var z = this.zones[this.index];
    var keep = this.opts.keep || 3;
    var self = this;
    var cur = this.zones[this.index];
    var shiftY = cur ? (this.opts.anchor ? this.opts.anchor(this.index, cur.top, cur) : cur.top) - cur.top : 0;
    this.zones.forEach(function (zone, i) {
      // text blocks (skip zones) only fade once scrolling pushes them off the top of the screen
      if (zone.skip) {
        zone.el.classList.toggle('zone-clipped', zone.top + shiftY < 0);
        return;
      }
      zone.el.classList.toggle('zone-above', i < self.index);
      var near = Math.abs(i - self.index) <= keep;
      if (zone.attach) {
        if (near && !zone.attached) zone.attach();
        else if (!near && zone.attached) zone.detach();
      }
    });
    if (!z) return;
    var y = this.opts.anchor ? this.opts.anchor(this.index, z.top, z) : z.top;
    if (y - z.top !== this.lastY) {
      ui.glide(this.inner, this);
      this.lastY = y - z.top;
    }
    PL.translate(this.inner, 0, y - z.top);
  };

  VStack.prototype.focus = function (on) {
    this.active = on;
    var z = this.zones[this.index];
    if (z) z.setFocused(on);
  };

  VStack.prototype.current = function () {
    return this.zones[this.index];
  };

  VStack.prototype.moveTo = function (i) {
    if (i < 0 || i >= this.zones.length || i === this.index) return false;
    var old = this.zones[this.index];
    if (old) old.setFocused(false);
    this.index = i;
    this.layout();
    this.zones[i].setFocused(true);
    if (this.opts.onFocusZone) this.opts.onFocusZone(i);
    return true;
  };

  VStack.prototype.key = function (code) {
    var K = PL.KEY;
    var z = this.zones[this.index];
    if (z && z.key(code)) return true;
    if (code === K.DOWN) return this.moveTo(this.nextFocusable(this.index + 1, 1));
    if (code === K.UP) return this.moveTo(this.nextFocusable(this.index - 1, -1));
    return false;
  };

  ui.VStack = VStack;

  // ---- Poster grid (library) ---------------------------------------------------------------------

  // opts: {columns, total, fetchPage(start, size) -> Promise<{items,total}>, onSelect(item),
  //        onFocusItem(item, index), top, shadow, pageSize}
  function Grid(opts) {
    this.opts = opts;
    this.cols = opts.columns || 7;
    // captions show under the focused poster only, so a row needs room for one caption + air
    this.geo = { w: 250, h: 375, pitch: 296, rowPitch: 500, scale: 1.09 };
    this.items = [];
    this.total = opts.total || 0;
    this.index = 0;
    this.focused = false;
    this.nodes = {};
    this.pages = {};
    this.pageSize = opts.pageSize || 70;
    this.el = PL.el('div', 'grid');
    this.inner = PL.el('div', 'grid-inner');
    this.el.appendChild(this.inner);
    this.generation = 0;
  }

  Grid.prototype.reset = function (total) {
    var self = this;
    Object.keys(this.nodes).forEach(function (k) { self.inner.removeChild(self.nodes[k]); });
    this.nodes = {};
    this.items = [];
    this.pages = {};
    this.total = total || 0;
    this.index = 0;
    this.generation++;
    this.loaded = false;
    this.entering = true;
    this.ensurePage(0);
    this.render();
  };

  Grid.prototype.setPage = function (start, items, total) {
    for (var i = 0; i < items.length; i++) this.items[start + i] = items[i];
    if (total != null) this.total = total;
  };

  Grid.prototype.ensurePage = function (page) {
    if (this.pages[page]) return;
    this.pages[page] = 'loading';
    var self = this;
    var gen = this.generation;
    this.opts.fetchPage(page * this.pageSize, this.pageSize).then(function (res) {
      if (gen !== self.generation) return;
      self.pages[page] = 'done';
      self.setPage(page * self.pageSize, res.items, res.total);
      if (!self.loaded) {
        self.loaded = true;
        if (self.opts.onLoaded) self.opts.onLoaded(self.total);
      }
      self.render();
      self.entering = false;
      if (self.focused) self.notify();
    }, function (err) {
      if (gen !== self.generation) return;
      delete self.pages[page];
      PL.warn('grid page failed', err && err.message);
      if (self.opts.onError) self.opts.onError(err);
    });
  };

  Grid.prototype.rowOf = function (i) { return Math.floor(i / this.cols); };

  // Row 0 sits at the grid's top; deeper rows are pinned `anchor` px below it (the header hides).
  Grid.prototype.scrollY = function () {
    var row = this.rowOf(this.index);
    return row === 0 ? 0 : row * this.geo.rowPitch - (this.opts.anchor != null ? this.opts.anchor : 90);
  };

  Grid.prototype.render = function () {
    var scroll = this.scrollY();
    if (scroll !== this.lastScroll) {
      ui.glide(this.inner, this);
      this.lastScroll = scroll;
    }
    PL.translate(this.inner, ui.MARGIN, -scroll);
    var row = this.rowOf(this.index);
    var firstRow = Math.max(0, row - 2);
    var lastRow = row + 3;
    var first = firstRow * this.cols;
    var last = Math.min(this.total - 1, (lastRow + 1) * this.cols - 1);
    var self = this;
    Object.keys(this.nodes).forEach(function (k) {
      var i = Number(k);
      if (i < first || i > last) {
        self.inner.removeChild(self.nodes[k]);
        delete self.nodes[k];
      }
    });
    for (var i = first; i <= last; i++) {
      var item = this.items[i];
      if (!item) this.ensurePage(Math.floor(i / this.pageSize));
      var node = this.nodes[i];
      if (node && item && node.classList.contains('card-placeholder')) {
        this.inner.removeChild(node);
        node = null;
      }
      if (!node) {
        node = item ? makeCard(item, 'poster', this.geo) : makePlaceholder('poster', this.geo);
        node.classList.add('grid-card');
        node.style.left = ((i % this.cols) * this.geo.pitch) + 'px';
        node.style.top = (this.rowOf(i) * this.geo.rowPitch) + 'px';
        // a fresh grid's first two rows rise in, row by row and left to right (capped at ~0.3 s)
        if (item && this.entering && i < this.cols * 2) ui.enter(node, 'card-enter', this.rowOf(i) * 70 + (i % this.cols) * 28);
        node.addEventListener('click', this.onClick.bind(this, i));
        this.inner.appendChild(node);
        this.nodes[i] = node;
      }
      node.classList.toggle('focused', this.focused && i === this.index);
    }
    // prefetch the next page before the user reaches it
    var ahead = Math.min(this.total - 1, (lastRow + 4) * this.cols);
    if (ahead >= 0 && !this.items[ahead]) this.ensurePage(Math.floor(ahead / this.pageSize));
    if (this.focused && this.opts.shadow && this.total > 0) {
      this.opts.shadow.place(this.inner, (this.index % this.cols) * this.geo.pitch, row * this.geo.rowPitch,
        this.geo.w, this.geo.h, this.geo.scale);
    }
  };

  Grid.prototype.onClick = function (i) {
    this.index = i;
    if (this.items[i]) this.opts.onSelect(this.items[i]);
  };

  Grid.prototype.setFocused = function (on) {
    this.focused = on;
    if (!on && this.opts.shadow) this.opts.shadow.hide();
    this.render();
    this.notify();
  };

  Grid.prototype.notify = function () {
    if (this.opts.onFocusItem) this.opts.onFocusItem(this.items[this.index], this.index);
  };

  Grid.prototype.move = function (next) {
    if (next < 0 || next >= this.total || next === this.index) return false;
    this.index = next;
    this.render();
    this.notify();
    return true;
  };

  Grid.prototype.refreshItem = function (ratingKey) {
    var self = this;
    Object.keys(this.nodes).forEach(function (k) {
      var it = self.items[Number(k)];
      if (it && it.ratingKey === ratingKey) {
        self.inner.removeChild(self.nodes[k]);
        delete self.nodes[k];
      }
    });
    this.render();
  };

  Grid.prototype.key = function (code) {
    var K = PL.KEY;
    if (code === K.OK_LONG) {
      var held = this.items[this.index];
      var self = this;
      return !!held && (this.opts.onLongPress || ui.longPress)(held, function () { self.refreshItem(held.ratingKey); });
    }
    var col = this.index % this.cols;
    if (code === K.LEFT) return col > 0 && this.move(this.index - 1);
    if (code === K.RIGHT) return col < this.cols - 1 && this.move(this.index + 1);
    if (code === K.UP) return this.index >= this.cols && this.move(this.index - this.cols);
    if (code === K.DOWN) {
      if (this.rowOf(this.index) >= this.rowOf(this.total - 1)) return false;
      return this.move(Math.min(this.total - 1, this.index + this.cols));
    }
    if (code === K.CH_DOWN) return this.move(Math.min(this.total - 1, this.index + this.cols * 5)) || true;
    if (code === K.CH_UP) return this.move(Math.max(0, this.index - this.cols * 5)) || true;
    if (code === K.ENTER) {
      var item = this.items[this.index];
      if (item) this.opts.onSelect(item);
      return true;
    }
    return false;
  };

  ui.Grid = Grid;

  // ---- Small pieces -----------------------------------------------------------------------------

  ui.spinner = function () {
    return PL.el('div', 'spinner');
  };

  ui.badges = function (item) {
    var out = [];
    var media = item.Media && item.Media[0];
    if (media) {
      var res = String(media.videoResolution || '');
      if (res === '4k') out.push('4K');
      else if (res === '1080' || res === '720') out.push('HD');
      if (media.videoDynamicRange === 'HDR' || /hdr|dolby/i.test(media.videoProfile || '')) out.push('HDR');
      if (media.audioChannels >= 6) out.push(media.audioChannels === 8 ? '7.1' : '5.1');
    }
    if (item.contentRating) out.push(item.contentRating);
    var parts = media && media.Part && media.Part[0];
    var hasSubs = parts && (parts.Stream || []).some(function (s) { return s.streamType === 3; });
    if (hasSubs) out.push('CC');
    var wrap = PL.el('div', 'badges');
    out.forEach(function (b) { wrap.appendChild(PL.el('span', 'badge', b)); });
    return wrap;
  };

  // opts.skipEpisode: the caller already shows "S1 · E2" elsewhere (hero eyebrow)
  ui.metaLine = function (item, opts) {
    var bits = [];
    if (item.type === 'episode') {
      var ep = opts && opts.skipEpisode ? '' : PL.fmt.episode(item);
      if (ep) bits.push(ep);
      if (item.originallyAvailableAt) bits.push(item.originallyAvailableAt.slice(0, 4));
    } else if (item.year) {
      bits.push(String(item.year));
    }
    if (item.Genre && item.Genre.length) bits.push(item.Genre.slice(0, 2).map(function (g) { return g.tag; }).join(', '));
    if (item.duration && item.type !== 'show' && item.type !== 'season') bits.push(PL.fmt.duration(item.duration));
    if (item.type === 'show' && item.childCount) bits.push(item.childCount + (item.childCount === 1 ? ' season' : ' seasons'));
    return bits.join(' · ');
  };
})();
