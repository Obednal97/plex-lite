// Surprise Me: picks something to watch from a Movies or TV Shows library, reveals it full screen
// for a few seconds, then plays it. "What do you want to watch?" "I don't know." -> this.
//
// Picking (PL.surprise.pick):
// - unwatched titles first; if there are none, anything (a rewatch). Settings can include watched.
// - in the Library view the active genre/decade filters apply, and the Unwatched filter is strict.
// - movies play from where they were left; shows play their next episode (Plex's On Deck, which is
//   S1 E1 for a show that was never started), or the first regular episode for a finished show.
// - the last picks are remembered per profile and library (in memory), so Spin again doesn't
//   bring the same title straight back.
// Watched state is the current Plex Home profile's: every request carries that profile's token.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;

  var COUNTDOWN_SEC = 8;
  var BATCH = 12;          // random candidates per request (lets us skip recent picks without a 2nd call)
  var HISTORY = 15;        // recent picks remembered per library
  var SPIN_MIN_MS = 650;   // the dice rolls at least this long, even when the pick is instant
  var PRELOAD_MS = 2500;   // reveal anyway if the art is slower than this

  var surprise = PL.surprise = { history: {} };

  function historyFor(section) {
    var profile = (PL.storage.get('profile', null) || {}).uuid || 'owner';
    var key = profile + ':' + section.key;
    return surprise.history[key] || (surprise.history[key] = []);
  }

  surprise.remember = function (section, ratingKey) {
    var h = historyFor(section);
    var i = h.indexOf(ratingKey);
    if (i !== -1) h.splice(i, 1);
    h.unshift(ratingKey);
    if (h.length > HISTORY) h.length = HISTORY;
  };

  // A random page of the library (sort=random is done by the server).
  function query(section, filters, unwatched) {
    var params = {
      type: section.type === 'show' ? 2 : 1,
      sort: 'random',
      includeCollections: 0,
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': BATCH,
    };
    if (filters.genre) params.genre = filters.genre.key;
    if (filters.decade) params.decade = filters.decade.key;
    if (unwatched) params.unwatched = 1;
    return PL.plex.get('/library/sections/' + section.key + '/all', params).then(function (mc) {
      return { total: mc.totalSize != null ? mc.totalSize : (mc.size || 0), items: mc.Metadata || [] };
    });
  }

  // Prefers titles that weren't picked lately; in a tiny pool, at least not the last one again.
  function choose(items, section, unwatchedOnly) {
    var recent = historyFor(section);
    var pool = unwatchedOnly ? items.filter(function (it) { return !ui.isWatched(it); }) : items;
    if (!pool.length) pool = items;
    var fresh = pool.filter(function (it) { return recent.indexOf(it.ratingKey) === -1; });
    if (fresh.length) return fresh[0];
    return pool.filter(function (it) { return it.ratingKey !== recent[0]; })[0] || pool[0] || null;
  }

  // What actually plays: the movie itself, or the show's next episode.
  function resolve(item) {
    if (item.type !== 'show') return Promise.resolve({ item: item, target: item, how: item.viewOffset > 0 ? 'resume' : 'start' });
    return PL.plex.metadata(item.ratingKey).then(function (show) {
      var deck = PL.plex.onDeck(show);
      if (deck) {
        var how = deck.viewOffset > 0 ? 'resume' : (show.viewedLeafCount > 0 ? 'next' : 'start');
        return { item: show, target: deck, how: how };
      }
      // nothing on deck (every episode watched): the first regular episode, specials last
      return PL.plex.children(show.ratingKey).then(function (seasons) {
        var regular = seasons.filter(function (s) { return s.index > 0; });
        var season = regular[0] || seasons[0];
        if (!season) throw new Error(show.title + ' has no episodes');
        return PL.plex.children(season.ratingKey).then(function (eps) {
          if (!eps[0]) throw new Error(show.title + ' has no episodes');
          return { item: show, target: eps[0], how: 'again' };
        });
      });
    });
  }

  surprise.resolve = resolve;

  // filters (Library view): {genre, decade, unwatched}. Resolves {item, target, how, total, pool}.
  surprise.pick = function (section, filters) {
    filters = filters || {};
    var strict = !!filters.unwatched;
    var includeWatched = !strict && !!PL.storage.get('surprise.includeWatched', false);
    return query(section, filters, !includeWatched).then(function (res) {
      if (res.items.length || includeWatched || strict) return { res: res, pool: includeWatched ? 'all' : 'unwatched' };
      return query(section, filters, false).then(function (all) { return { res: all, pool: 'rewatch' }; });
    }).then(function (r) {
      var item = choose(r.res.items, section, r.pool === 'unwatched');
      if (!item) {
        var err = new Error(filters.genre || filters.decade || strict ? 'Nothing matches these filters' : 'This library is empty');
        err.empty = true;
        throw err;
      }
      return resolve(item).then(function (p) {
        p.total = r.res.total;
        p.pool = r.pool;
        return p;
      });
    });
  };

  // Loads images into the cache so the reveal draws complete; gives up after `ms`.
  function preload(urls, ms) {
    return new Promise(function (done) {
      var left = urls.length;
      var timer = setTimeout(done, ms);
      var one = function () {
        if (--left > 0) return;
        clearTimeout(timer);
        done();
      };
      if (!left) return one();
      urls.forEach(function (u) {
        var img = new Image();
        img.onload = img.onerror = one;
        img.src = u;
      });
    });
  }

  function plural(n, one, many) { return n.toLocaleString() + ' ' + (n === 1 ? one : many); }

  // ---- The reveal ------------------------------------------------------------------------------

  // section: the library; filters: from the Library view (or {}).
  function SurpriseScreen(section, filters) {
    this.section = section;
    this.filters = filters || {};
    this.el = PL.el('div', 'surprise is-spinning');
    this.gen = 0;
    this.alive = true;
    // OK acts on release (like the library), so a held OK can't repeat into Spin again, or on
    // into the details page or the player that a press opens
    this.longPress = true;
    this.pick = null;

    var dice = PL.el('div', 'surprise-dice');
    var face = PL.el('div', 'surprise-dice-face');
    face.appendChild(ui.icon('dice'));
    dice.appendChild(face);
    this.diceLabel = PL.el('div', 'surprise-dice-label');
    dice.appendChild(this.diceLabel);
    this.el.appendChild(dice);

    var content = this.content = PL.el('div', 'surprise-content');
    this.info = PL.el('div', 'surprise-info');
    this.eyebrow = PL.el('div', 'hero-eyebrow surprise-eyebrow');
    this.titleHost = PL.el('div', 'surprise-title');
    this.meta = PL.el('div', 'hero-meta');
    this.episode = PL.el('div', 'surprise-episode');
    this.summary = PL.el('div', 'hero-summary surprise-summary');
    [this.eyebrow, this.titleHost, this.meta, this.episode, this.summary].forEach(function (n) { this.info.appendChild(n); }, this);
    content.appendChild(this.info);

    var self = this;
    this.buttons = new ui.ButtonRow([
      { kind: 'primary', icon: 'play', label: 'Play now', action: function () { self.play(); } },
      { icon: 'dice', label: 'Spin again', action: function () { self.spin(); } },
      { icon: 'info', label: 'Details', action: function () { self.details(); } },
      { icon: 'close', label: 'Cancel', action: function () { PL.app.pop(); } },
    ]);
    this.buttons.nodes[0].classList.add('needs-pick');
    this.buttons.nodes[2].classList.add('needs-pick');
    var playBtn = this.buttons.nodes[0];
    this.playLabel = playBtn.querySelector('.btn-label');
    this.rail = PL.el('div', 'surprise-rail');
    this.railFill = PL.el('div', 'surprise-rail-fill');
    this.rail.appendChild(this.railFill);
    playBtn.appendChild(this.rail);
    content.appendChild(this.buttons.el);
    this.el.appendChild(content);
    this.buttons.setFocused(true);
    this.spin();
  }

  SurpriseScreen.prototype.noun = function (n) {
    return this.section.type === 'show' ? (n === 1 ? 'show' : 'shows') : (n === 1 ? 'movie' : 'movies');
  };

  SurpriseScreen.prototype.spin = function () {
    if (this.spinning) return;
    var self = this;
    var gen = ++this.gen;
    var started = Date.now();
    this.spinning = true;
    this.stopCountdown();
    this.diceLabel.textContent = this.section.type === 'show' ? 'Picking a show…' : 'Picking a movie…';
    this.el.classList.add('is-spinning');
    PL.app.backdrop.dim(this.pick ? 0.5 : 0.35);
    surprise.pick(this.section, this.filters).then(function (pick) {
      if (gen !== self.gen || !self.alive) return null;
      surprise.remember(self.section, pick.item.ratingKey);
      var art = PL.plex.image(ui.artPath(pick.item), 1280, 720, { quality: 75 });
      var logo = ui.logoPath(pick.item);
      return preload([art, logo && ui.logoUrl(logo)].filter(Boolean), PRELOAD_MS).then(function () {
        var wait = Math.max(0, SPIN_MIN_MS - (Date.now() - started));
        setTimeout(function () { if (gen === self.gen && self.alive) self.reveal(pick, art); }, wait);
      });
    }).catch(function (err) {
      if (gen !== self.gen || !self.alive) return;
      self.spinning = false;
      PL.warn('surprise failed', err && err.message);
      PL.toast(err && err.empty ? err.message : PL.errorMessage(err));
      if (!self.pick) {
        if (PL.app.top() === self) PL.app.pop();
        return;
      }
      // keep showing the previous pick
      self.el.classList.remove('is-spinning');
      PL.app.backdrop.dim(1);
    });
  };

  SurpriseScreen.prototype.reveal = function (pick, art) {
    this.pick = pick;
    this.art = art;
    this.spinning = false;
    var item = pick.item;
    var target = pick.target;
    if (this.visible) {
      PL.app.backdrop.set(art, 'detail');
      PL.app.backdrop.dim(1);
    }

    var from = pick.pool === 'rewatch'
      ? 'You\'ve seen all ' + plural(pick.total, this.noun(1), this.noun(2)) + ', so here\'s a rewatch'
      : 'From ' + pick.total.toLocaleString() + ' ' + (pick.pool === 'unwatched' ? 'unwatched ' : '') + this.noun(pick.total);
    var context = this.filters.label ? ' · ' + this.filters.label : '';
    this.eyebrow.textContent = 'Surprise pick · ' + from + context;

    var title = item.title || '';
    PL.clear(this.titleHost);
    var logo = ui.titleArt(item, title, { area: 72000, maxH: 190, boxW: 760 });
    this.titleHost.appendChild(logo || PL.el('div', 'hero-title' + (title.length > 26 ? ' long' : ''), title));

    this.meta.textContent = ui.metaLine(item);
    if (item.type === 'show') {
      var lead = { resume: 'Resume', next: 'Next up', start: 'Starts with', again: 'Starts again with' }[pick.how] || '';
      var bits = [PL.fmt.episode(target), target.title].filter(Boolean);
      var left = pick.how === 'resume' ? PL.fmt.remaining(target) : PL.fmt.duration(target.duration);
      if (left) bits.push(left);
      this.episode.textContent = lead + ' ' + bits.join(' · ');
      this.episode.style.display = '';
    } else {
      if (pick.how === 'resume' && target.duration) this.meta.textContent += ' · ' + PL.fmt.remaining(target);
      this.episode.style.display = 'none';
    }
    this.summary.textContent = item.summary || '';
    this.summary.style.display = item.summary ? '' : 'none';

    this.el.classList.remove('is-spinning');
    ui.enter(this.info, 'surprise-in', 0);
    if (this.visible) this.startCountdown();
    else this.setPlayLabel();
  };

  SurpriseScreen.prototype.setPlayLabel = function (secondsLeft) {
    var resume = this.pick && this.pick.how === 'resume';
    this.playLabel.textContent = secondsLeft ? (resume ? 'Resuming in ' : 'Playing in ') + secondsLeft : (resume ? 'Resume' : 'Play now');
  };

  // The rail under Play fills over the countdown (one linear transform transition); the label
  // counts down against a deadline so a slow frame never stretches it.
  SurpriseScreen.prototype.startCountdown = function () {
    this.stopCountdown();
    // never count down unseen (the app went to the background, or another screen is on top)
    if (!PL.storage.get('surprise.autoplay', true) || document.hidden || !this.visible || !this.alive) {
      this.setPlayLabel();
      return;
    }
    var self = this;
    var end = Date.now() + COUNTDOWN_SEC * 1000;
    var fill = this.railFill;
    this.rail.classList.add('on');
    fill.style.transition = 'none';
    fill.style.transform = 'scaleX(0)';
    fill.offsetWidth; // start from empty
    fill.style.transition = 'transform ' + COUNTDOWN_SEC + 's linear';
    fill.style.transform = 'scaleX(1)';
    this.counting = true;
    var tick = function () {
      var left = Math.ceil((end - Date.now()) / 1000);
      if (document.hidden || !self.visible) {
        self.stopCountdown();
        return;
      }
      if (left <= 0) {
        self.play();
        return;
      }
      self.setPlayLabel(left);
      self.timer = setTimeout(tick, Math.max(50, (end - Date.now()) % 1000 || 1000));
    };
    tick();
  };

  SurpriseScreen.prototype.stopCountdown = function () {
    clearTimeout(this.timer);
    if (!this.counting) return;
    this.counting = false;
    this.rail.classList.remove('on');
    this.setPlayLabel();
  };

  // The player takes this screen's place, so Back from the player returns to the library.
  SurpriseScreen.prototype.play = function () {
    if (!this.pick || this.spinning) return;
    var target = this.pick.target;
    this.stopCountdown();
    PL.app.replaceTop(screens.player(target, { offset: target.viewOffset || 0 }));
  };

  SurpriseScreen.prototype.details = function () {
    if (!this.pick || this.spinning) return;
    this.stopCountdown();
    PL.app.push(screens.details(this.pick.item));
  };

  SurpriseScreen.prototype.show = function () {
    this.visible = true;
    if (this.pick) {
      PL.app.backdrop.set(this.art, 'detail');
      PL.app.backdrop.dim(1);
    } else if (this.spinning) {
      PL.app.backdrop.dim(0.35); // the library just un-dimmed it as it was parked
    }
  };

  SurpriseScreen.prototype.hide = function () {
    this.visible = false;
    this.stopCountdown();
  };

  // the app went to the background: never start playing unseen
  SurpriseScreen.prototype.onHidden = function () { this.stopCountdown(); };

  SurpriseScreen.prototype.destroy = function () {
    this.alive = false;
    this.gen++;
    this.stopCountdown();
    PL.app.backdrop.dim(1);
  };

  SurpriseScreen.prototype.key = function (code) {
    if (PL.isBack(code)) {
      PL.app.pop();
      return true;
    }
    if (code === K.PLAY || code === K.PLAY_PAUSE) {
      this.play();
      return true;
    }
    if (code === K.LEFT || code === K.RIGHT) {
      // choosing something else stops the countdown
      this.stopCountdown();
      this.buttons.key(code);
      return true;
    }
    if (code === K.ENTER || code === K.OK_LONG) {
      this.buttons.press();
      return true;
    }
    return true;
  };

  screens.surprise = function (section, filters) { return new SurpriseScreen(section, filters); };
})();
