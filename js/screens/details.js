// Title page for a movie, show, season or episode.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;

  // A non-focusable text block that lives in the VStack, so the page scrolls as one.
  function HeadZone(item) {
    this.skip = true;
    this.el = PL.el('div', 'details-head-zone');
    // sized to its text (VStack measures zones whose height is null), bottom-aligned, min 360
    var head = PL.el('div', 'details-text');
    head.style.marginLeft = '96px';
    head.style.width = '900px';
    var st = this.el.style;
    st.width = '1920px';
    st.minHeight = '360px';
    st.paddingBottom = '24px';
    st.display = 'flex';
    st.flexDirection = 'column';
    st.justifyContent = 'flex-end';
    this.height = null;
    this.head = head;
    this.el.appendChild(head);
    this.fill(item);
  }

  HeadZone.prototype.fill = function (item) {
    var h = this.head;
    PL.clear(h);
    var eyebrow = '';
    if (item.type === 'episode') eyebrow = item.grandparentTitle || '';
    if (item.type === 'season') eyebrow = item.parentTitle || '';
    if (eyebrow) h.appendChild(PL.el('div', 'hero-eyebrow', eyebrow));
    var title = item.title || '';
    var t = PL.el('div', 'hero-title' + (title.length > 26 ? ' long' : ''), title);
    h.appendChild(t);
    var meta = PL.el('div', 'hero-meta');
    meta.appendChild(document.createTextNode(ui.metaLine(item)));
    meta.appendChild(ui.badges(item));
    var ratings = ratingBadges(item);
    if (ratings) meta.appendChild(ratings);
    h.appendChild(meta);
    if (item.summary) {
      var s = PL.el('div', 'hero-summary', item.summary);
      s.style.webkitLineClamp = '4';
      h.appendChild(s);
    }
    var people = [];
    var dir = (item.Director || []).slice(0, 1).map(function (d) { return d.tag; });
    var cast = (item.Role || []).slice(0, 3).map(function (r) { return r.tag; });
    if (dir.length) people.push('Director ' + dir.join(', '));
    if (cast.length) people.push('Starring ' + cast.join(', '));
    if (people.length) h.appendChild(PL.el('div', 'details-extra', people.join('   ·   ')));
  };

  HeadZone.prototype.setFocused = function () {};
  HeadZone.prototype.key = function () { return false; };

  // Rating[] entries look like {image: 'imdb://image.rating', value: 7.5, type: 'audience'}.
  function ratingText(r) {
    var img = r.image || '';
    var v = Number(r.value);
    if (!v) return null;
    if (img.indexOf('imdb://') === 0) return 'IMDb ' + v.toFixed(1);
    if (img.indexOf('rottentomatoes://') === 0) {
      return (r.type === 'critic' ? 'RT ' : 'RT Audience ') + Math.round(v * 10) + '%';
    }
    if (img.indexOf('themoviedb://') === 0) return 'TMDb ' + Math.round(v * 10) + '%';
    return null;
  }

  function ratingBadges(item) {
    var texts = (item.Rating || []).map(ratingText).filter(Boolean);
    if (!texts.length) return null;
    var wrap = PL.el('span', 'rating-badges');
    texts.forEach(function (t) { wrap.appendChild(PL.el('span', 'rating-badge', t)); });
    return wrap;
  }

  function versionLabel(media) {
    var bits = [];
    var res = String(media.videoResolution || '');
    if (res) bits.push(/^\d+$/.test(res) ? res + 'p' : res.toUpperCase());
    if (media.videoCodec) bits.push(String(media.videoCodec).toUpperCase());
    var part = media.Part && media.Part[0];
    if (part && part.size) bits.push((part.size / 1073741824).toFixed(1) + ' GB');
    if (media.bitrate) bits.push((media.bitrate / 1000).toFixed(1) + ' Mbps');
    return bits.join(' · ') || 'Version';
  }

  var MAX_CAST = 30;
  var PERSON_GEO = { w: 180, h: 180, pitch: 212, scale: 1.08 };
  var EXTRA_LABEL = {
    trailer: 'Trailer', behindTheScenes: 'Behind the scenes', deletedScene: 'Deleted scene', interview: 'Interview',
    featurette: 'Featurette', sceneOrSample: 'Scene', short: 'Short',
  };

  function fetchFull(ratingKey) {
    return PL.plex.get('/library/metadata/' + ratingKey, { includeOnDeck: 1, includeExtras: 1, checkFiles: 0 }).then(function (mc) {
      var item = (mc.Metadata || [])[0];
      if (!item) throw new Error('This item is no longer on the server');
      return item;
    });
  }

  // Cast first, then crew, as {id, name, role, thumb, filter}. `filter` is the library filter
  // that lists this person's titles.
  function people(item) {
    var out = [];
    (item.Role || []).slice(0, MAX_CAST).forEach(function (r) {
      out.push({ id: r.id, name: r.tag, role: r.role || '', thumb: r.thumb, filter: 'actor' });
    });
    (item.Director || []).forEach(function (d) { out.push({ id: d.id, name: d.tag, role: 'Director', thumb: d.thumb, filter: 'director' }); });
    (item.Writer || []).slice(0, 3).forEach(function (w) { out.push({ id: w.id, name: w.tag, role: 'Writer', thumb: w.thumb, filter: 'writer' }); });
    return out.filter(function (p) { return p.id != null && p.name; });
  }

  function initials(name) {
    var parts = String(name).split(/\s+/).filter(Boolean);
    var first = parts[0] ? parts[0].charAt(0) : '';
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
  }

  function makePersonCard(person, kind, geo) {
    var card = PL.el('div', 'card card-person');
    var inner = PL.el('div', 'card-inner');
    inner.style.width = geo.w + 'px';
    inner.style.height = geo.h + 'px';
    inner.appendChild(PL.el('div', 'person-initials', initials(person.name)));
    if (person.thumb) {
      var img = PL.el('img', 'card-img');
      img.width = geo.w;
      img.height = geo.h;
      img.onerror = function () { img.style.visibility = 'hidden'; };
      img.src = PL.plex.image(person.thumb, geo.w, geo.h);
      inner.appendChild(img);
    }
    inner.appendChild(PL.el('div', 'card-edge'));
    card.appendChild(inner);
    var meta = PL.el('div', 'card-meta person-meta');
    meta.appendChild(PL.el('div', 'card-title', person.name));
    if (person.role) meta.appendChild(PL.el('div', 'card-sub', person.role));
    card.appendChild(meta);
    return card;
  }

  function extraLabel(extra) {
    var bits = [EXTRA_LABEL[extra.subtype] || 'Extra'];
    if (extra.duration) bits.push(PL.fmt.duration(extra.duration));
    return bits.join(' · ');
  }

  function makeExtraCard(extra, kind, geo) {
    var card = ui.makeCard(extra, kind, geo);
    var sub = card.querySelector('.card-sub');
    if (sub) sub.textContent = extraLabel(extra);
    return card;
  }


  function DetailsScreen(item) {
    this.item = item;
    this.el = PL.el('div', 'details');
    this.shadow = new ui.FocusShadow();
    this.status = PL.el('div', 'loading');
    this.status.appendChild(ui.spinner());
    this.el.appendChild(this.status);
    var self = this;
    this.stack = new ui.VStack(this.el, {
      top: 120,
      keep: 2,
      anchor: function (i, top, zone) { return Math.min(top, 1040 - zone.height); },
    });
    this.seasonEpisodes = {};
    this.alive = true;
    this.load();
    this.backdropUrl = PL.plex.image(ui.artPath(item), 1920, 1080, { quality: 70 });
    this.refreshOnShow = false;
  }

  DetailsScreen.prototype.load = function () {
    var self = this;
    var item = this.item;
    var key = item.type === 'season' ? item.parentRatingKey : item.ratingKey;
    var p = fetchFull(key).then(function (full) {
      self.full = full;
      self.extras = (full.Extras && full.Extras.Metadata) || [];
      self.cast = people(full);
      if (full.type === 'show') {
        return PL.plex.children(full.ratingKey).then(function (seasons) {
          self.seasons = seasons;
          var want = item.type === 'season' ? item.ratingKey : null;
          var deck = full.OnDeck && full.OnDeck.Metadata && full.OnDeck.Metadata[0];
          self.onDeck = deck || null;
          var idx = 0;
          seasons.forEach(function (s, i) {
            if (want ? s.ratingKey === want : deck && s.ratingKey === deck.parentRatingKey) idx = i;
          });
          self.seasonIndex = idx;
          return seasons.length ? self.episodesFor(seasons[idx]) : [];
        });
      }
      if (full.type === 'episode') {
        var siblings = PL.plex.children(full.parentRatingKey).then(function (eps) {
          self.siblings = eps;
        }, function () { self.siblings = []; });
        // episodes without their own cast borrow the show's
        var showCast = self.cast.length || !full.grandparentRatingKey ? null : fetchFull(full.grandparentRatingKey).then(function (show) {
          self.cast = people(show);
        }, function () {});
        return Promise.all([siblings, showCast]);
      }
      if (full.type === 'movie') {
        return PL.plex.get('/library/metadata/' + full.ratingKey + '/related', { count: 20 }).then(function (mc) {
          self.related = (mc.Hub || []).filter(PL.plex.isVideoHub)[0] || null;
        }, function () { self.related = null; });
      }
      return null;
    });
    return p.then(function () {
      if (!self.alive) return;
      self.status.style.display = 'none';
      self.build();
    }, function (err) {
      if (!self.alive) return;
      PL.clear(self.status);
      self.status.appendChild(PL.el('div', '', PL.errorMessage(err)));
    });
  };

  DetailsScreen.prototype.episodesFor = function (season) {
    var self = this;
    if (this.seasonEpisodes[season.ratingKey]) return Promise.resolve(this.seasonEpisodes[season.ratingKey]);
    return PL.plex.children(season.ratingKey).then(function (eps) {
      self.seasonEpisodes[season.ratingKey] = eps;
      return eps;
    });
  };

  // What Play does: resume/start this movie or episode, or the show's next episode.
  DetailsScreen.prototype.playTarget = function () {
    var f = this.full;
    if (f.type === 'movie' || f.type === 'episode') return f;
    if (this.onDeck) return this.onDeck;
    var first = this.seasons && this.seasons[0] && this.seasonEpisodes[this.seasons[0].ratingKey];
    return first && first[0] ? first[0] : null;
  };

  DetailsScreen.prototype.trailer = function () {
    var f = this.full;
    var extras = this.extras || [];
    if (f.type !== 'movie' && f.type !== 'show') return null;
    var primary = f.primaryExtraKey;
    var main = primary && extras.filter(function (e) { return e.key === primary; })[0];
    return main || extras.filter(function (e) { return e.subtype === 'trailer'; })[0] || null;
  };

  // Trailers and extras play in the normal player but do not change this item's progress.
  DetailsScreen.prototype.playExtra = function (extra) {
    PL.app.push(screens.player(extra, { offset: 0 }));
  };

  DetailsScreen.prototype.buttons = function () {
    var self = this;
    var f = this.full;
    var target = this.playTarget();
    var out = [];
    if (target) {
      var resume = target.viewOffset > 0;
      var label = resume ? 'Resume' : 'Play';
      if (f.type === 'show') label += ' ' + PL.fmt.episode(target);
      if (resume) label += ' from ' + PL.fmt.clock(target.viewOffset / 1000);
      out.push({ kind: 'primary', icon: 'play', label: label, action: function () { self.play(target, resume ? target.viewOffset : 0, self.mediaIndex); } });
      if (resume) out.push({ icon: 'restart', label: 'From start', hint: 'Play from the beginning', action: function () { self.play(target, 0, self.mediaIndex); } });
    }
    if ((f.type === 'movie' || f.type === 'episode') && f.Media && f.Media.length > 1) {
      out.push({ icon: 'versions', label: 'Versions', hint: 'Choose version (' + f.Media.length + ')', action: function () { self.pickVersion(); } });
    }
    if (f.type === 'show') {
      out.push({ icon: 'shuffle', label: 'Shuffle', hint: 'Shuffle all episodes', action: function () { self.shuffle(); } });
    }
    var trailer = this.trailer();
    if (trailer) {
      out.push({ icon: 'trailer', label: 'Trailer', hint: 'Watch trailer', action: function () { self.playExtra(trailer); } });
    }
    var watched = ui.isWatched(f);
    out.push({
      icon: watched ? 'watched' : 'check',
      label: (watched ? 'Mark ' + (f.type === 'show' ? 'show ' : '') + 'unwatched' : 'Mark ' + (f.type === 'show' ? 'show ' : '') + 'watched'),
      hint: watched ? 'Mark as unwatched' : 'Mark as watched',
      action: function () { self.toggleWatched(); },
    });
    var season = f.type === 'show' && this.seasons && this.seasons[this.seasonIndex];
    if (season) {
      var seasonWatched = ui.isWatched(season);
      out.push({
        icon: 'season',
        label: 'Mark ' + (season.title || 'season') + (seasonWatched ? ' unwatched' : ' watched'),
        hint: (seasonWatched ? 'Mark ' : 'Mark ') + season.title + (seasonWatched ? ' unwatched' : ' watched'),
        action: function () { self.toggleSeasonWatched(season); },
      });
    }
    if (f.type === 'movie' || f.type === 'episode') {
      out.push({ icon: 'tracks', label: 'Audio & subtitles', hint: 'Audio and subtitles', action: function () { screens.trackSheet(f); } });
    }
    if (f.type === 'episode' && f.grandparentRatingKey) {
      out.push({
        icon: 'show', label: 'Go to show', hint: 'Go to ' + (f.grandparentTitle || 'show'),
        action: function () { PL.app.push(screens.details({ ratingKey: f.grandparentRatingKey, type: 'show', title: f.grandparentTitle, art: f.grandparentArt })); },
      });
    }
    return out;
  };

  DetailsScreen.prototype.build = function () {
    var self = this;
    var f = this.full;
    this.backdropUrl = PL.plex.image(ui.artPath(f), 1920, 1080, { quality: 70 }) || this.backdropUrl;
    if (this.visible) PL.app.backdrop.set(this.backdropUrl, 'detail');
    this.head = new HeadZone(f);
    this.buttonRow = new ui.ButtonRow(this.buttons());
    var hint = PL.el('div', 'btn-hint');
    hint.style.top = '84px';
    this.buttonRow.el.appendChild(hint);
    this.buttonRow.onHint = function (text) { hint.textContent = text; };
    var buttonZone = { el: PL.el('div', 'button-zone'), height: 132, row: this.buttonRow };
    buttonZone.el.appendChild(this.buttonRow.el);
    buttonZone.setFocused = function (on) { self.buttonRow.setFocused(on); };
    buttonZone.key = function (code) { return self.buttonRow.key(code); };
    var zones = [this.head, buttonZone];

    if (f.type === 'show' && this.seasons && this.seasons.length) {
      this.chips = new ui.ChipRow(this.seasons.map(function (s) { return { label: s.title, value: s }; }), {
        selected: this.seasonIndex,
        selectOnFocus: true,
        onChange: function (season, i) { self.selectSeason(i); },
      });
      zones.push(this.chips);
      this.episodes = this.makeEpisodeShelf(this.seasonEpisodes[this.seasons[this.seasonIndex].ratingKey] || [], this.onDeck);
      zones.push(this.episodes);
    } else if (f.type === 'episode' && this.siblings && this.siblings.length) {
      this.episodes = this.makeEpisodeShelf(this.siblings, f, 'More in ' + (f.parentTitle || 'this season'));
      zones.push(this.episodes);
    } else if (this.related) {
      var hub = this.related;
      zones.push(new ui.Shelf({
        title: hub.title,
        items: hub.Metadata,
        kind: 'poster',
        total: hub.size,
        shadow: this.shadow,
        onSelect: function (item) { PL.app.push(screens.details(item)); },
      }));
    }
    if (this.extras && this.extras.length > 1 && f.type !== 'episode') {
      zones.push(new ui.Shelf({
        title: 'Extras',
        items: this.extras,
        kind: 'wide',
        shadow: this.shadow,
        makeCard: makeExtraCard,
        onSelect: function (extra) { self.playExtra(extra); },
      }));
    }
    if (this.cast && this.cast.length) {
      // no shared shadow here: it is a rounded rectangle; the focused portrait carries its own
      zones.push(new ui.Shelf({
        title: 'Cast & Crew',
        items: this.cast,
        kind: 'person',
        geometry: PERSON_GEO,
        makeCard: makePersonCard,
        onSelect: function (person) { self.openPerson(person); },
      }));
    }
    this.stack.setZones(zones, 1);
    if (this.visible) this.stack.focus(true);
  };

  DetailsScreen.prototype.openPerson = function (person) {
    var section = this.full.librarySectionID;
    if (section == null) {
      PL.toast('Can\'t list titles for ' + person.name);
      return;
    }
    var params = {};
    params[person.filter] = person.id;
    PL.app.push(screens.items(person.name, '/library/sections/' + section + '/all', params));
  };

  DetailsScreen.prototype.makeEpisodeShelf = function (episodes, focusItem, title) {
    var self = this;
    var idx = 0;
    if (focusItem) episodes.forEach(function (e, i) { if (e.ratingKey === focusItem.ratingKey) idx = i; });
    return new ui.Shelf({
      title: title || 'Episodes',
      items: episodes,
      kind: 'wide',
      index: idx,
      cardOpts: { episodeTitles: true },
      shadow: this.shadow,
      onSelect: function (ep) {
        if (self.full.type === 'episode' && ep.ratingKey === self.full.ratingKey) {
          self.play(ep, ep.viewOffset || 0);
        } else {
          PL.app.push(screens.details(ep));
        }
      },
    });
  };

  DetailsScreen.prototype.selectSeason = function (i) {
    var self = this;
    this.seasonIndex = i;
    var season = this.seasons[i];
    this.buttonRow.setButtons(this.buttons());
    this.episodesFor(season).then(function (eps) {
      if (!self.alive || self.seasonIndex !== i) return;
      self.episodes.replaceItems(eps, eps.length);
      self.episodes.index = 0;
      self.episodes.render();
    }, function (err) { PL.toast(PL.errorMessage(err)); });
  };

  DetailsScreen.prototype.play = function (item, offset, mediaIndex, queue) {
    this.refreshOnShow = true;
    var opts = { offset: offset || 0 };
    if (mediaIndex) opts.mediaIndex = mediaIndex;
    if (queue) opts.queue = queue;
    PL.app.push(screens.player(item, opts));
  };

  DetailsScreen.prototype.pickVersion = function () {
    var self = this;
    var f = this.full;
    var current = this.mediaIndex || 0;
    PL.app.push(screens.sheet([{
      heading: 'Versions',
      rows: f.Media.map(function (media, i) {
        return {
          label: versionLabel(media), checked: i === current,
          action: function () {
            self.mediaIndex = i;
            self.play(f, f.viewOffset || 0, i);
          },
        };
      }),
    }]));
  };

  // A shuffled play queue of the whole show; the player gets the queue so "next" follows it.
  DetailsScreen.prototype.shuffle = function () {
    var self = this;
    var f = this.full;
    PL.plex.request('POST', '/playQueues', {
      type: 'video',
      uri: 'server://' + PL.plex.server.machineId + '/com.plexapp.plugins.library/library/metadata/' + f.ratingKey,
      shuffle: 1,
      continuous: 0,
      own: 1,
    }).then(function (mc) {
      if (!self.alive) return;
      var items = (mc && mc.Metadata) || [];
      if (!items.length) throw new Error('Nothing to shuffle');
      self.play(items[0], 0, 0, { items: items, index: 0, id: mc.playQueueID });
    }).catch(function (err) { if (self.alive) PL.toast(PL.errorMessage(err)); });
  };

  DetailsScreen.prototype.toggleSeasonWatched = function (season) {
    var self = this;
    var watched = !ui.isWatched(season);
    PL.plex.setWatched(season.ratingKey, watched).then(function () {
      if (!self.alive) return;
      PL.toast(season.title + (watched ? ' marked as watched' : ' marked as unwatched'));
      self.reload();
    }, function (err) { PL.toast(PL.errorMessage(err)); });
  };

  DetailsScreen.prototype.toggleWatched = function () {
    var self = this;
    var f = this.full;
    var watched = !ui.isWatched(f);
    PL.plex.setWatched(f.ratingKey, watched).then(function () {
      PL.toast(watched ? 'Marked as watched' : 'Marked as unwatched');
      self.reload();
    }, function (err) { PL.toast(PL.errorMessage(err)); });
  };

  // Re-reads progress after playback or a watched change, keeping the focus where it was.
  DetailsScreen.prototype.reload = function () {
    var self = this;
    var stackIndex = this.stack.index;
    var buttonIndex = this.buttonRow ? this.buttonRow.index : 0;
    var episodeIndex = this.episodes ? this.episodes.index : 0;
    var item = this.full || this.item;
    if (this.seasons) this.item = { ratingKey: this.seasons[this.seasonIndex].ratingKey, parentRatingKey: item.ratingKey, type: 'season' };
    this.seasonEpisodes = {};
    this.stack.focus(false);
    return this.load().then(function () {
      if (!self.alive || !self.stack.zones.length) return;
      self.stack.focus(false);
      if (self.buttonRow) {
        self.buttonRow.index = PL.clamp(buttonIndex, 0, self.buttonRow.buttons.length - 1);
        self.buttonRow.paint();
      }
      if (self.episodes) {
        self.episodes.index = PL.clamp(episodeIndex, 0, Math.max(0, self.episodes.items.length - 1));
        self.episodes.render();
      }
      self.stack.index = PL.clamp(stackIndex, 1, self.stack.zones.length - 1);
      self.stack.layout();
      if (self.visible) self.stack.focus(true);
    });
  };

  DetailsScreen.prototype.show = function () {
    this.visible = true;
    PL.app.backdrop.set(this.backdropUrl, 'detail');
    if (this.refreshOnShow && this.full) {
      this.refreshOnShow = false;
      this.reload();
      return;
    }
    if (this.stack.zones.length) this.stack.focus(true);
  };

  DetailsScreen.prototype.hide = function () {
    this.visible = false;
    this.stack.focus(false);
    this.shadow.hide();
  };

  DetailsScreen.prototype.destroy = function () { this.alive = false; };

  DetailsScreen.prototype.key = function (code) {
    if (!this.stack.zones.length) return false;
    return this.stack.key(code);
  };

  screens.details = function (item) {
    if (item.type === 'collection') {
      return screens.items(item.title, '/library/collections/' + item.ratingKey + '/children', {});
    }
    return new DetailsScreen(item);
  };
})();
