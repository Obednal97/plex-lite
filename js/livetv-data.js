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
  var SLIM = 'summary,guid,parentGuid,grandparentGuid,grandparentKey,parentKey,ratingKey,grandparentRatingKey,' +
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
  };

  G.reset = function () {
    G.src = null;
    G.channels = [];
    G.byId = {};
    G.airings = {};
    G.blocks = {};
    G.base = 0;
    G.lineup = null;
    G.summaries = {};
    G.gen++;
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
      var lineup = G.lineup ? Promise.resolve(G.lineup) : readLineup(src);
      return Promise.all([lineup, G.ensure(now(), now() + 3600)]).then(function (res) {
        if (gen !== G.gen) return null;
        if (!G.lineup) {
          G.lineup = res[0];
          rebuildChannels(null);
          emit();
        }
        return G;
      });
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

  G.list = function (identifier) { return G.airings[identifier] || []; };

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
})();
