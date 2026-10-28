// Cards and rows with a mouse (docs/WEB.md, "Cards and rows with a mouse"): a hovered card grows
// with its shadow and shows ▶ (play or resume at once) and "…" (the hold-OK menu), rows page with
// ‹ › at their edges, the Recommended hero follows the card the mouse rests on, and the details
// page's buttons name what they do in a tooltip. Only in the mouse layout (PL.input.mode() is
// 'pointer') while the mouse is the last input; keys bring back the TV's focus plate, and remote and
// touch modes are left exactly as they were. Web build only, after web/web-desktop.js; the TV never
// loads it. ES2015 like the rest.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var ui = PL.ui;
  var web = PL.web;
  var app = PL.app;

  // how long the mouse rests on a card before the hero follows it (the TV's focus debounce)
  var HERO_REST = 350;
  // a hovered card's lift (web-cards.css; D1 mock-up); round and custom cards keep their own
  var HOVER_SCALE = { poster: 1.07, season: 1.07, wide: 1.07 };
  // titles ▶ can start, and the ones with a hold-OK menu (PL.screens.itemMenu)
  var PLAYABLE = { movie: 1, episode: 1, show: 1, season: 1 };

  // 24-unit glyphs (PL.glyph): {fill: true, parts} is filled, an array is stroked
  var G = {
    play: { fill: true, parts: [['path', { d: 'M7 4.5v15l12.5-7.5z' }]] },
    more: { fill: true, parts: [['circle', { cx: 5.5, cy: 12, r: 2 }], ['circle', { cx: 12, cy: 12, r: 2 }], ['circle', { cx: 18.5, cy: 12, r: 2 }]] },
    next: [['path', { d: 'M9 5l7 7-7 7' }]],
    prev: [['path', { d: 'M15 5l-7 7 7 7' }]],
  };

  // the mouse layout, driven by the mouse right now
  function mouse() { return PL.input.mode() === 'pointer' && PL.input.nav() === 'pointer'; }

  // ---- Which list a card belongs to ---------------------------------------------------------------

  // Shelves and grids tag their card nodes (and a shelf its element) so one delegated listener can
  // tell which title the mouse is over. Cards are made inside render(), so tag them after it.
  function tagNodes(list) {
    var nodes = list.nodes;
    for (var k in nodes) {
      if (nodes[k].webList !== list) {
        nodes[k].webList = list;
        nodes[k].webIndex = Number(k);
      }
    }
  }

  // Walks up from an event target: the card under the mouse, and the shelf it is in.
  function under(t) {
    var card = null;
    var shelf = null;
    while (t && t.nodeType === 1) {
      if (!card && t.webList && t.webIndex != null) card = t;
      if (t.webShelf) { shelf = t.webShelf; break; }
      t = t.parentNode;
    }
    return { card: card, shelf: shelf };
  }

  // ---- The hover shadow ---------------------------------------------------------------------------

  // One element for the whole page, like the TV's focus shadow (docs/MOTION.md: no box-shadow per
  // card): re-parented into the hovered card's track so it rides the track's transform.
  var shadow = PL.el('div', 'web-hover-shadow');

  function placeShadow(card, list) {
    var geo = list.geo;
    var parent = card.parentNode;
    if (!parent || !geo || card.classList.contains('card-placeholder')) return hideShadow();
    if (shadow.parentNode !== parent) {
      shadow.classList.add('instant');
      parent.appendChild(shadow);
    }
    shadow.style.width = geo.w + 'px';
    shadow.style.height = geo.h + 'px';
    shadow.style.borderRadius = geo.round ? '50%' : '';
    var x = parseFloat(card.style.left) || 0;
    var y = parseFloat(card.style.top) || 0;
    var scale = HOVER_SCALE[list.kind || 'poster'] || geo.scale || 1.07;
    shadow.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + scale + ')';
    if (shadow.classList.contains('instant')) {
      shadow.offsetWidth; // lands under the card, then fades in
      shadow.classList.remove('instant');
    }
    shadow.classList.add('on');
  }

  function hideShadow() { shadow.classList.remove('on'); }

  // ---- ▶ and "…" on a hovered card ------------------------------------------------------------------

  function menuFor(list, item) {
    var top = app.top();
    return !!(top && top.longPress && !list.opts.onLongPress && PLAYABLE[item.type]);
  }

  // Only the standard Plex cards: custom ones (channels, extras, plugin rows, people) keep their own.
  function decorate(card, list, item) {
    if (card.webActs || list.opts.makeCard || !item.ratingKey || !PLAYABLE[item.type]) return;
    var inner = card.querySelector('.card-inner');
    if (!inner) return;
    var acts = PL.el('div', 'web-acts');
    var play = PL.el('div', 'web-card-play');
    play.appendChild(web.glyph(G.play, 30));
    play.addEventListener('click', function (e) {
      e.stopPropagation();
      var it = list.items[card.webIndex];
      if (it) playItem(it);
    });
    acts.appendChild(play);
    if (menuFor(list, item)) {
      var more = PL.el('div', 'web-card-more');
      more.appendChild(web.glyph(G.more, 24));
      web.tip(more, 'More options', 'Hold OK', 'above');
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        var it = list.items[card.webIndex];
        web.tip.hide();
        if (it) ui.longPress(it, function () { list.refreshItem(it.ratingKey); });
      });
      acts.appendChild(more);
    }
    inner.appendChild(acts);
    card.webActs = acts;
    card.classList.add('web-card');
  }

  // ▶: a movie or episode resumes where it was left (or starts); a show plays what its details page
  // would (the next episode on deck, else the first), a season its first unfinished episode.
  var starting = false;

  function start(target) {
    starting = false;
    if (!target) {
      PL.toast('Nothing to play yet');
      return;
    }
    PL.app.push(PL.screens.player(target, { offset: target.viewOffset || 0 }));
  }

  function playItem(item) {
    if (item.type === 'movie' || item.type === 'episode') return start(item);
    if (starting) return;
    starting = true;
    var from = app.top();
    var go = function (target) {
      if (app.top() !== from) { starting = false; return; } // the user went elsewhere meanwhile
      start(target);
    };
    var fail = function (err) {
      starting = false;
      PL.toast(PL.errorMessage(err));
    };
    if (item.type === 'season') {
      PL.plex.children(item.ratingKey).then(function (eps) {
        var next = eps.filter(function (e) { return e.viewOffset > 0 || !e.viewCount; })[0];
        go(next || eps[0] || null);
      }).catch(fail);
      return;
    }
    PL.plex.get('/library/metadata/' + item.ratingKey, { includeOnDeck: 1, checkFiles: 0 }).then(function (mc) {
      var show = (mc.Metadata || [])[0];
      var deck = show && PL.plex.onDeck(show);
      if (deck) return deck;
      return PL.plex.children(item.ratingKey).then(function (seasons) {
        if (!seasons.length) return null;
        return PL.plex.children(seasons[0].ratingKey).then(function (eps) { return eps[0] || null; });
      });
    }).then(go).catch(fail);
  }

  // ---- The hero follows the card the mouse rests on (Recommended) ---------------------------------

  // The Recommended mode's hero, when this list is one of its shelves.
  function heroFor(list) {
    var top = app.top();
    var mode = top && top.mode;
    return mode && mode.hero && mode.el && mode.el.contains(list.el) ? mode.hero : null;
  }

  // ---- Hover state --------------------------------------------------------------------------------

  var hov = { card: null, shelf: null, timer: null };

  function leaveCard() {
    clearTimeout(hov.timer);
    hov.timer = null;
    if (hov.card) hov.card.classList.remove('web-hover');
    hov.card = null;
    hideShadow();
  }

  function enterCard(card) {
    leaveCard();
    var list = card && card.webList;
    var item = list && list.items[card.webIndex];
    if (!item || !card.parentNode) return;
    hov.card = card;
    card.classList.add('web-hover');
    decorate(card, list, item);
    placeShadow(card, list);
    var hero = heroFor(list);
    if (hero && (item.ratingKey || item.art)) {
      // a sweep across the row never stops long enough: only the card the mouse settles on counts
      hov.timer = setTimeout(function () {
        hov.timer = null;
        if (hov.card !== card || !mouse()) return;
        hero.update.cancel();
        hero.apply(item);
      }, HERO_REST);
    }
  }

  function setShelf(shelf) {
    if (shelf === hov.shelf) return;
    if (hov.shelf) hov.shelf.el.classList.remove('web-hot');
    hov.shelf = shelf;
    if (!shelf) return;
    shelf.el.classList.add('web-hot');
    arrows(shelf);
  }

  function clear() {
    leaveCard();
    setShelf(null);
    lastTarget = null;
  }

  // What is under the mouse. Moves count as well as mouseover: after the keys or a mode change the
  // mouse may carry on over the same element, which sends no new mouseover.
  var lastTarget = null;
  function pointed(e) {
    if (!mouse() || e.target === lastTarget) return;
    lastTarget = e.target;
    var at = under(e.target);
    setShelf(at.shelf);
    if (at.card !== hov.card) enterCard(at.card);
  }
  document.addEventListener('mouseover', pointed);
  document.addEventListener('mousemove', pointed, { passive: true });
  // the mouse left the window
  document.addEventListener('mouseout', function (e) { if (!e.relatedTarget) clear(); });
  // the wheel moves the rows under a mouse that stays still: start again from its next move
  document.addEventListener('wheel', function () { leaveCard(); lastTarget = null; }, { passive: true });
  PL.input.on(function () { if (!mouse()) clear(); });
  ['push', 'pop', 'replaceTop', 'setRoot'].forEach(function (name) {
    var orig = app[name];
    app[name] = function () {
      clear();
      return orig.apply(this, arguments);
    };
  });

  // ---- ‹ › at a row's edges -------------------------------------------------------------------------

  // Made the first time the mouse is over the row. The fades and arrows sit above the track; they
  // show only while the row is hovered (CSS: .web-hot) and there is more that way.
  function arrows(shelf) {
    if (!shelf.webArrows) {
      if (!(shelf.maxShift() > 0)) return;
      var top = shelf.track.offsetTop;
      var h = shelf.geo.h;
      var make = function (dir) {
        var fade = PL.el('div', 'web-row-fade web-row-fade-' + dir);
        fade.style.top = (top - 24) + 'px';
        fade.style.height = (h + 48) + 'px';
        var btn = PL.el('div', 'web-row-arrow web-row-arrow-' + dir);
        btn.appendChild(web.glyph(dir === 'next' ? G.next : G.prev, 32, 2.4));
        btn.style.top = Math.round(top + h / 2 - 32) + 'px';
        if (dir === 'prev') {
          fade.style.left = (shelf.left - ui.MARGIN) + 'px';
          btn.style.left = (shelf.left - 64) + 'px';
        }
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          page(shelf, dir === 'next' ? 1 : -1);
        });
        // a held press on an arrow is not a hold OK on the card underneath
        btn.addEventListener('contextmenu', function (e) { e.stopPropagation(); e.preventDefault(); });
        shelf.el.appendChild(fade);
        shelf.el.appendChild(btn);
        return { fade: fade, btn: btn };
      };
      shelf.webArrows = { prev: make('prev'), next: make('next') };
    }
    paintArrows(shelf);
  }

  function paintArrows(shelf) {
    var a = shelf.webArrows;
    if (!a) return;
    var shift = shelf.shift();
    var prev = shift > 0;
    var next = shift < shelf.maxShift() - 1;
    a.prev.btn.classList.toggle('on', prev);
    a.prev.fade.classList.toggle('on', prev);
    a.next.btn.classList.toggle('on', next);
    a.next.fade.classList.toggle('on', next);
  }

  // A page is the cards that fit whole: the card cut off at the edge leads the next page. The row
  // moves by its focus index (shift() follows it), so keys carry on from the page on screen.
  function page(shelf, dir) {
    var pitch = shelf.geo.pitch;
    var visible = ui.SCREEN_W - ui.MARGIN - shelf.left;
    var per = Math.max(1, Math.floor((visible + pitch - shelf.geo.w) / pitch));
    var max = shelf.maxShift();
    var target = PL.clamp(shelf.shift() + dir * per * pitch, 0, max);
    var index = dir > 0 ? Math.ceil(target / pitch - 0.001) : Math.floor(target / pitch + 0.001);
    index = PL.clamp(index, 0, Math.max(0, shelf.items.length - 1));
    if (index === shelf.index) return;
    leaveCard();
    web.tip.hide();
    shelf.index = index;
    shelf.render();
  }

  // ---- Hooks into the shared lists ------------------------------------------------------------------

  var shelfRender = ui.Shelf.prototype.render;
  ui.Shelf.prototype.render = function () {
    shelfRender.apply(this, arguments);
    if (!this.attached) return;
    if (!this.webHit) {
      // the row's band, so the mouse between two cards is still over the row (its arrows stay)
      this.el.webShelf = this;
      // (its top is in web-cards.css: reading the track's here would force a layout per row)
      this.webHit = PL.el('div', 'web-row-hit');
      this.webHit.style.height = (this.geo.h + 48) + 'px';
      this.el.insertBefore(this.webHit, this.track);
    }
    tagNodes(this);
    if (this.webArrows) paintArrows(this);
  };

  var gridRender = ui.Grid.prototype.render;
  ui.Grid.prototype.render = function () {
    gridRender.apply(this, arguments);
    tagNodes(this);
  };

  // A card repainted under the mouse (watched state changed from its menu) is a new node.
  ['refreshItem', 'replaceItems'].forEach(function (name) {
    var orig = ui.Shelf.prototype[name];
    ui.Shelf.prototype[name] = function () {
      if (hov.card && hov.card.webList === this) leaveCard();
      return orig.apply(this, arguments);
    };
  });

  // ---- Tooltips on button rows (details: "Shuffle all episodes" under Shuffle) ---------------------

  var setButtons = ui.ButtonRow.prototype.setButtons;
  ui.ButtonRow.prototype.setButtons = function (buttons) {
    setButtons.apply(this, arguments);
    this.nodes.forEach(function (n, i) {
      var b = buttons[i] || {};
      var text = b.hint && b.hint !== b.label ? b.hint : !b.label && b.title ? b.title : '';
      if (text) web.tip(n, text);
    });
  };
})();
