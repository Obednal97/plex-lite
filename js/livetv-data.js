// Live TV guide data, shared by the Live TV tab and the live player's mini guide (PL.liveGuide).
// Channels come from the DVR's lineup (every channel, with or without guide data); programmes from
// the provider's /grid in three-hour blocks for every channel at once (one ~0.5-1 MB request per
// block on a 350-channel lineup, slimmed with excludeFields), so scrolling the guide never waits on
// the network. Favourites are kept per server. Pure parts are in js/livetv-logic.js.
'use strict';

(function () {
  var L = PL.liveLogic;
  var BLOCK = 3 * 3600;
  var STALE_MS = 30 * 60 * 1000; // the block on now is fetched again after this
  // (grandparentRatingKey stays: an episode's genres are on its show, looked up in batches for Browse)
  var SLIM = 'summary,guid,parentGuid,grandparentGuid,grandparentKey,parentKey,ratingKey,' +
    'parentRatingKey,titleSort,addedAt,originallyAvailableAt,skipParent,contentRating,parentTitle,onAir';

  function now() { return Math.floor(Date.now() / 1000); }

  var G = PL.liveGuide = {
    src: null,          // {dvrKey, provider}
    channels: [],       // [{identifier, id, vcn, title, name, thumb}] in number order
    byId: {},
    airings: {},        // identifier -> [airing] (js/livetv-logic.js parseGrid)
    base: 0,            // block k covers base + k*BLOCK .. +BLOCK
    blocks: {},         // k -> {at: ms fetched, pending: Promise}
    gen: 0,
    listeners: [],
    summaries: {},
    lineup: null,       // the lineup's channels, once read
    version: 0,         // bumps whenever channels, airings, favourites or categories change
    showCats: {},       // show ratingKey -> category id, or null (no genre we know)
    cats: null,         // identifier -> category id (Browse), computed from the loaded guide
    catsFor: null,      // the channel list cats was computed for
    famCache: null,     // {channels, families}
    browseSel: null,    // the guide's filter {base, refine}, shared with the live player
  };

  G.reset = function () {
    G.src = null;
    G.channels = [];
    G.byId = {};
    G.airings = {};
    G.blocks = {};
    G.base = 0;
    G.lineup = null;
    G.lineupPending = null;
    G.summaries = {};
    G.showCats = {};
    G.cats = null;
    G.catsFor = null;
    G.famCache = null;
    G.browseSel = null;
    G.gen++;
    G.version++;
  };

  var prevHook = PL.plex.onServerChange;
  PL.plex.onServerChange = function () {
    G.reset();
    if (prevHook) prevHook();
  };

  // fn() runs after the channels or airings change. Returns a function that removes it.
  G.listen = function (fn) {
    G.listeners.push(fn);
    return function () {
      var i = G.listeners.indexOf(fn);
      if (i !== -1) G.listeners.splice(i, 1);
    };
  };

  function emit() {
    G.version++;
    G.listeners.slice().forEach(function (fn) {
      try { fn(); } catch (e) { PL.warn('live guide listener', e && e.message); }
    });
  }

  G.discover = function () {
    if (G.src) return Promise.resolve(G.src);
    var gen = G.gen;
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
      if (gen === G.gen) G.src = { dvrKey: dvr.key, provider: provider.identifier };
      return { dvrKey: dvr.key, provider: provider.identifier };
    });
  };

  // The lineup: every channel the DVR has, including ones with no guide data. Optional (the guide
  // falls back to the channels the grid mentions).
  function readLineup(src) {
    return PL.plex.get('/' + src.provider + '/lineups/dvr/channels', null, { timeout: 15000 }).then(function (mc) {
      return (mc.Channel || []).map(function (c) {
        var vcn = String(c.vcn || c.id);
        return { identifier: String(c.id), id: null, vcn: vcn, title: L.stripNumber(c.title || c.callSign || '', vcn), thumb: c.thumb || null };
      });
    }, function (err) {
      PL.log('no lineup, using the grid\'s channels', err && err.status);
      return [];
    });
  }

  // One lineup request at a time, shared by load() and loadChannels().
  function lineupOnce(src) {
    if (G.lineup) return Promise.resolve(G.lineup);
    if (!G.lineupPending) {
      var gen = G.gen;
      G.lineupPending = readLineup(src).then(function (list) {
        if (gen === G.gen) G.lineupPending = null;
        return list;
      });
    }
    return G.lineupPending;
  }

  function useLineup(list) {
    if (G.lineup) return;
    G.lineup = list;
    rebuildChannels(null);
    emit();
  }

  // Rebuilds the channel list from the lineup plus whatever the grid has named.
  function rebuildChannels(fromGrid) {
    var byId = {};
    var list = [];
    var add = function (c) {
      var have = byId[c.identifier];
      if (have) {
        if (have.id == null && c.id != null) have.id = c.id;
        if (!have.thumb && c.thumb) have.thumb = c.thumb;
        return;
      }
      var ch = { identifier: c.identifier, id: c.id, vcn: c.vcn, title: c.title, name: c.title, thumb: c.thumb };
      byId[c.identifier] = ch;
      list.push(ch);
    };
    G.channels.forEach(add);
    (G.lineup || []).forEach(add);
    Object.keys(fromGrid || {}).forEach(function (id) { add(fromGrid[id]); });
    var strip = L.groupsInUse(list.map(function (c) { return c.title; }));
    list.forEach(function (c) { c.name = L.channelName(c.title, strip); });
    list.sort(L.byNumber);
    G.channels = list;
    G.byId = byId;
  }

  function blockOf(t) { return Math.floor((t - G.base) / BLOCK); }

  function fetchBlock(k) {
    var have = G.blocks[k];
    if (have && have.pending) return have.pending;
    var gen = G.gen;
    var from = G.base + k * BLOCK;
    var to = from + BLOCK;
    var t0 = Date.now();
    var p = PL.plex.get('/' + G.src.provider + '/grid', {
      type: '1,4',
      'beginsAt<': to,
      'endsAt>': from,
      excludeElements: 'Image,Channel',
      excludeFields: SLIM,
    }, { timeout: 30000 }).then(function (mc) {
      if (gen !== G.gen) return;
      var t1 = Date.now();
      var g = L.parseGrid(mc);
      Object.keys(g.airings).forEach(function (id) {
        G.airings[id] = L.merge(G.airings[id], g.airings[id]);
      });
      rebuildChannels(g.channels);
      G.blocks[k] = { at: Date.now() };
      PL.log('guide block', k, (mc.Metadata || []).length, 'programmes', (t1 - t0) + 'ms fetch', (Date.now() - t1) + 'ms parse');
      emit();
      genresSoon();
    }, function (err) {
      if (gen === G.gen) delete G.blocks[k];
      throw err;
    });
    G.blocks[k] = { pending: p };
    return p;
  }

  // Loads (once) the channels and the block on now. Resolves when there is something to show.
  G.load = function () {
    var gen = G.gen;
    return G.discover().then(function (src) {
      if (gen !== G.gen) return null;
      if (!G.base) G.base = L.floorTo(now(), L.HALF_HOUR);
      return Promise.all([lineupOnce(src), G.ensure(now(), now() + 3600)]).then(function (res) {
        if (gen !== G.gen) return null;
        useLineup(res[0]);
        return G;
      });
    });
  };

  // Just the channels (the lineup, one small request), without waiting for the guide: Search
  // matches channel names even when the guide can't be loaded.
  G.loadChannels = function () {
    var gen = G.gen;
    return G.discover().then(lineupOnce).then(function (list) {
      if (gen === G.gen) useLineup(list);
      return G;
    });
  };

  // Makes sure the blocks covering [from, to] are loaded (or loading). The block on now is fetched
  // again once it is half an hour old.
  G.ensure = function (from, to) {
    if (!G.src) return Promise.resolve();
    var t = now();
    var jobs = [];
    for (var k = blockOf(Math.max(from, t - 3600)); k <= blockOf(to); k++) {
      var b = G.blocks[k];
      var onNow = blockOf(t) === k;
      if (!b || b.pending || (onNow && Date.now() - b.at > STALE_MS)) jobs.push(fetchBlock(k));
    }
    return Promise.all(jobs);
  };

  // Drops what has ended (keeps memory flat when the app stays open for hours).
  G.prune = function () {
    var t = now() - 600;
    Object.keys(G.airings).forEach(function (id) { G.airings[id] = L.prune(G.airings[id], t); });
    Object.keys(G.blocks).forEach(function (k) {
      if (G.base + (Number(k) + 1) * BLOCK < t) delete G.blocks[k];
    });
  };

  var EMPTY = [];
  // (the same empty array every time, so callers can tell nothing changed)
  G.list = function (identifier) { return G.airings[identifier] || EMPTY; };

  G.nowNext = function (identifier, t) { return L.nowNext(G.airings[identifier], t == null ? now() : t); };

  // The programme's synopsis (not in the grid, to keep it small). Cached; resolves '' on failure.
  G.summary = function (a) {
    if (!a || !a.key) return Promise.resolve('');
    var have = G.summaries[a.key];
    if (have != null) return typeof have === 'string' ? Promise.resolve(have) : have;
    var p = PL.plex.get(a.key, null, { timeout: 10000 }).then(function (mc) {
      var m = mc && mc.Metadata && mc.Metadata[0];
      var text = (m && m.summary) || '';
      G.summaries[a.key] = text;
      return text;
    }, function () {
      delete G.summaries[a.key];
      return '';
    });
    G.summaries[a.key] = p;
    return p;
  };

  // ---- Favourites (per server) --------------------------------------------------------------------

  function favKey() { return 'livetv.favourites.' + ((PL.plex.server && PL.plex.server.machineId) || 'default'); }

  G.favourites = function () { return PL.storage.get(favKey(), []); };

  G.isFavourite = function (identifier) { return G.favourites().indexOf(identifier) !== -1; };

  // Returns the new state.
  G.toggleFavourite = function (identifier) {
    var list = G.favourites();
    var i = list.indexOf(identifier);
    if (i === -1) list.push(identifier);
    else list.splice(i, 1);
    PL.storage.set(favKey(), list);
    emit();
    return i === -1;
  };

  // ---- Last channel ---------------------------------------------------------------------------------

  G.lastChannel = null; // identifier of the channel watched before the current one

  // ---- Browse: categories, families and the shared filter (docs/LIVETV-browse-design.md) ------------
  // Categories come from programme genres. A film's genres are in the grid; an episode's are on its
  // show, so after a block arrives the shows it names are looked up 40 at a time
  // (/{provider}/metadata/<k1>,<k2>,…), the ones on now first, one request at a time, well after
  // the guide has drawn. A channel's category is the one with the most airtime in what is loaded,
  // plus what earlier sessions saw (kept per server), so the rail has counts the moment it opens.

  var B = PL.liveBrowse;
  var GENRE_BATCH = 40;
  var genreTimer = null;
  var genreJob = null;
  var prior = null;         // {identifier: {category: seconds}} saved by earlier sessions
  var priorFor = null;
  var saveTimer = null;

  function serverKey() { return (PL.plex.server && PL.plex.server.machineId) || 'default'; }
  function catsKey() { return 'livetv.cats.' + serverKey(); }

  function loadPrior() {
    if (priorFor === serverKey() && prior) return prior;
    priorFor = serverKey();
    var saved = PL.storage.get(catsKey(), null);
    prior = saved && saved.v === 1 && saved.t ? saved.t : {};
    return prior;
  }

  // An airing's category: its own genres, else its show's once looked up. undefined while the show
  // hasn't been looked up yet.
  G.airingCat = function (a) {
    if (a.cat !== undefined) return a.cat;
    var own = B.categoryOfGenres(a.genres);
    if (own || !a.show) {
      a.cat = own;
      return own;
    }
    var s = G.showCats[a.show];
    if (s === undefined) return undefined;
    a.cat = s;
    return s;
  };

  function genresSoon() {
    clearTimeout(genreTimer);
    genreTimer = setTimeout(function () { G.loadGenres(); }, 1200);
  }

  // Looks up the genres of the loaded programmes' shows (those on now first). Resolves when done.
  G.loadGenres = function () {
    if (genreJob) return genreJob;
    if (!G.src) return Promise.resolve();
    var gen = G.gen;
    var t = now();
    var first = [];
    var later = [];
    var seen = {};
    Object.keys(G.airings).forEach(function (id) {
      G.airings[id].forEach(function (a) {
        if (!a.show || seen[a.show] || G.airingCat(a) !== undefined) return;
        seen[a.show] = true;
        (a.b <= t && t < a.e ? first : later).push(a.show);
      });
    });
    var keys = first.concat(later);
    if (!keys.length) {
      G.refreshBrowse();
      return Promise.resolve();
    }
    var nowEnd = first.length;
    var i = 0;
    var t0 = Date.now();
    var next = function () {
      if (gen !== G.gen || i >= keys.length) return null;
      var batch = keys.slice(i, i + GENRE_BATCH);
      i += batch.length;
      return PL.plex.get('/' + G.src.provider + '/metadata/' + batch.join(','),
        { excludeFields: 'summary', excludeElements: 'Image' }, { timeout: 15000 }).then(function (mc) {
        if (gen !== G.gen) return null;
        (mc.Metadata || []).forEach(function (m) {
          G.showCats[m.ratingKey] = B.categoryOfGenres((m.Genre || []).map(function (g) { return g.tag; }));
        });
        batch.forEach(function (k) { if (G.showCats[k] === undefined) G.showCats[k] = null; });
        // the shows on now are in: the wall and the counts can use them already
        if (i >= nowEnd && i - batch.length < nowEnd && i < keys.length) G.refreshBrowse();
        return new Promise(function (ok) { setTimeout(ok, 150); }).then(next);
      });
    };
    genreJob = Promise.resolve().then(next).then(function () {
      genreJob = null;
      if (gen !== G.gen) return;
      PL.log('browse genres', keys.length, 'shows', Math.ceil(keys.length / GENRE_BATCH), 'requests', (Date.now() - t0) + 'ms');
      G.refreshBrowse();
    }, function (err) {
      genreJob = null;
      PL.warn('browse genres failed', err && err.message);
      if (gen === G.gen) G.refreshBrowse();
    });
    return genreJob;
  };

  function families() {
    if (!G.famCache || G.famCache.channels !== G.channels) {
      G.famCache = { channels: G.channels, families: B.families(G.channels) };
    }
    return G.famCache.families;
  }

  // Each channel's category from the loaded guide plus the saved tallies (B.pickCategory).
  function computeCats() {
    var saved = loadPrior();
    var live = {};
    Object.keys(G.airings).forEach(function (id) {
      var t = null;
      G.airings[id].forEach(function (a) {
        var k = G.airingCat(a);
        if (!k) return;
        t = t || {};
        t[k] = (t[k] || 0) + (a.e - a.b);
      });
      if (t) live[id] = t;
    });
    var cat = {};
    G.channels.forEach(function (c) {
      var id = c.identifier;
      var both = {};
      [live[id], saved[id]].forEach(function (t) {
        Object.keys(t || {}).forEach(function (k) { both[k] = (both[k] || 0) + t[k]; });
      });
      var k = B.pickCategory(both, c.title);
      if (k) cat[id] = k;
    });
    B.inherit(cat, G.channels, families());
    G.cats = cat;
    G.catsFor = G.channels;
    G.liveTally = live;
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var saved = loadPrior();
      var live = G.liveTally || {};
      var out = {};
      G.channels.forEach(function (c) {
        var t = B.blendTally(live[c.identifier], saved[c.identifier]);
        if (Object.keys(t).length) out[c.identifier] = t;
      });
      PL.storage.set(catsKey(), { v: 1, t: out });
    }, 4000);
  }

  // Recomputes the categories; tells the listeners only when one changed.
  G.refreshBrowse = function () {
    if (!G.channels.length) return;
    var before = G.cats;
    computeCats();
    saveSoon();
    var changed = !before;
    if (before) {
      for (var id in G.cats) if (G.cats[id] !== before[id]) { changed = true; break; }
      if (!changed) for (id in before) if (!G.cats[id]) { changed = true; break; }
    }
    if (changed) emit();
  };

  var ctxCache = null;
  // What the Browse rules need (js/livetv-browse.js "ctx"), cached until the data or the minute changes.
  G.browseCtx = function () {
    var t = now();
    var minute = Math.floor(t / 60);
    if (ctxCache && ctxCache.version === G.version && ctxCache.minute === minute && ctxCache.channels === G.channels) return ctxCache;
    if (!G.cats || G.catsFor !== G.channels) computeCats();
    var fav = {};
    G.favourites().forEach(function (id) { fav[id] = true; });
    var onNow = {};
    G.channels.forEach(function (c) { if (L.indexAt(G.list(c.identifier), t) >= 0) onNow[c.identifier] = true; });
    var f = families();
    ctxCache = { version: G.version, minute: minute, channels: G.channels, fav: fav, cat: G.cats, fam: f.of, families: f.list, onNow: onNow };
    return ctxCache;
  };

  // The guide's filter, shared with the live player (the mini guide and CH+/CH− follow it).
  function selKey() { return 'livetv.browse.' + serverKey(); }

  G.getBrowse = function () {
    if (G.browseSel) return G.browseSel;
    var saved = PL.storage.get(selKey(), null);
    if (!saved || !saved.base) saved = { base: B.fromLegacy(PL.storage.get('livetv.filter', 'all')), refine: null };
    G.browseSel = { base: saved.base, refine: saved.refine || null };
    return G.browseSel;
  };

  G.browseSeq = 0; // bumps on every change, so a parked guide can tell the player changed it
  G.setBrowse = function (sel, transient) {
    G.browseSel = { base: sel.base || 'all', refine: sel.refine || null };
    G.browseSeq++;
    if (!transient) PL.storage.set(selKey(), G.browseSel);
  };

  // The channels in a filter, in number order.
  G.channelsFor = function (sel) {
    return B.filter(G.channels, sel, G.browseCtx());
  };
})();
