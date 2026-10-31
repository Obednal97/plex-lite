// Overseerr plugin: what Overseerr (Seerr) suggests. Trending, Popular and Upcoming rows among Plex's
// own shelves on a library's Recommended view (films in movie libraries, shows in TV libraries), and a
// few of them on Search before anything is typed. Titles already in Plex open their Plex page; the
// others open the request sheet (plugin.js). Answers come from the service's compact `discover`
// method and are kept for 30 minutes per profile, shared by Search and every library.
// The What's coming plugin's rows ("New episodes this week", "Films arriving soon") are different
// rows with different names.
'use strict';

(function () {
  var O = PL.overseerr;
  var MAX_AGE = 30 * 60 * 1000;
  var STATUS = { 2: 'Requested', 3: 'Processing', 4: 'Partly available' };

  // Row, title, and where it sits among the library's own rows (after that many of them).
  O.DISCOVER_ROWS = {
    movie: [
      { list: 'trending-movie', title: 'Trending films', at: 2 },
      { list: 'popular-movie', title: 'Popular films', at: 4 },
      { list: 'upcoming-movie', title: 'Upcoming films', at: 6 },
    ],
    show: [
      { list: 'trending-tv', title: 'Trending shows', at: 2 },
      { list: 'popular-tv', title: 'Popular shows', at: 4 },
      { list: 'upcoming-tv', title: 'Upcoming shows', at: 6 },
    ],
  };

  // Settings → Overseerr → "Trending, Popular and Upcoming" (this TV or browser; on by default)
  O.discoverOn = function (ctx) { return ctx.storage.get('discover', true) !== false; };
  O.setDiscover = function (ctx, on) { ctx.storage.set('discover', !!on); };

  // A compact discover result (service.js trimResult) -> a shelf item. Search's request items have
  // the same shape (plugin.js toItem).
  O.discoverItem = function (r) {
    return {
      ratingKey: 'os-' + r.mediaType + '-' + r.id,
      type: 'request',
      osType: r.mediaType,
      tmdbId: r.id,
      title: r.title || '',
      year: r.year || '',
      summary: r.overview || '',
      thumb: O.img(r.posterPath, 'w342'),
      art: O.img(r.backdropPath, 'w780'),
      status: r.status > 1 ? r.status : r.requested ? 2 : 1,
      downloading: r.downloading != null ? r.downloading : null,
      plexKey: r.ratingKey && /^\d+$/.test(String(r.ratingKey)) ? String(r.ratingKey) : null,
    };
  };

  // Promise<[item]> for one list, cached 30 min (a failure isn't kept).
  O.discover = function (ctx, list) {
    return O.cached(ctx, 'discover', list, MAX_AGE, function () {
      return O.svc(ctx, 'discover', { list: list }).then(function (r) {
        return (r.items || []).map(O.discoverItem);
      });
    });
  };

  // "Downloading 45%", "Requested", "Processing", "Partly available"; nothing for an available title
  // or one nobody has asked for.
  O.badgeText = function (item) {
    if (item.status === 5) return '';
    if (item.downloading != null) return 'Downloading ' + item.downloading + '%';
    return STATUS[item.status] || '';
  };

  O.requestCard = function (ctx) {
    return function (item, kind, geo) {
      var node = ctx.ui.makeCard(item, kind, geo);
      var label = O.badgeText(item);
      return label ? ctx.ui.badge(node, 'os-badge os-status-' + item.status, label) : node;
    };
  };

  // For the touch layout, which draws an item's badge itself (it doesn't use makeCard).
  function withBadge(item) {
    var label = O.badgeText(item);
    item.badge = label ? { label: label, tone: item.downloading != null ? 'accent' : 'status-' + item.status } : null;
    return item;
  }

  // OK on a discover card: a title in the library opens in Plex (checked first: Overseerr's
  // ratingKey is from the Plex server it watches), anything else the request sheet.
  O.selectDiscover = function (item, ctx) {
    if (item.plexKey && item.status >= 4) {
      ctx.plex.metadata(item.plexKey).then(function (m) {
        ctx.openItem({ ratingKey: String(m.ratingKey), type: m.type, title: m.title });
      }, function () { O.openRequest(item, ctx); });
      return;
    }
    O.openRequest(item, ctx);
  };

  function shelf(ctx, id, title, items, at) {
    return {
      id: id,
      title: title,
      kind: 'poster',
      at: at,
      items: items.map(withBadge),
      makeCard: O.requestCard(ctx),
      onSelect: function (item) { O.selectDiscover(item, ctx); },
    };
  }

  // shelfRows: this section's three rows (none when off, not signed in, or a failed list).
  O.discoverShelves = function (section, ctx) {
    var rows = section && O.DISCOVER_ROWS[section.type];
    if (!rows || !O.ready(ctx) || !O.discoverOn(ctx)) return Promise.resolve([]);
    return Promise.all(rows.map(function (row) {
      return O.discover(ctx, row.list).then(function (items) {
        return items.length ? shelf(ctx, 'discover-' + row.list, row.title, items.slice(0, 20), row.at) : null;
      }, function (err) {
        ctx.warn('discover ' + row.list + ' failed: ' + (err && err.message));
        return null;
      });
    })).then(function (list) { return list.filter(Boolean); });
  };

  // Every other item of a and b, without repeats: one row of films and shows.
  function interleave(a, b, max) {
    var out = [];
    for (var i = 0; out.length < max && (i < a.length || i < b.length); i++) {
      if (i < a.length) out.push(a[i]);
      if (i < b.length && out.length < max) out.push(b[i]);
    }
    return out;
  }

  // searchIdleRows: Search before anything is typed. The same cached lists as Recommended.
  O.searchIdle = function (ctx) {
    if (!O.ready(ctx) || !O.discoverOn(ctx)) return null;
    var get = function (list) { return O.discover(ctx, list).then(null, function () { return []; }); };
    return Promise.all([get('trending-movie'), get('trending-tv'), get('popular-movie'), get('popular-tv')]).then(function (l) {
      return [
        l[0].length || l[1].length ? shelf(ctx, 'idle-trending', 'Trending', interleave(l[0], l[1], 20)) : null,
        l[2].length ? shelf(ctx, 'idle-popular-movie', 'Popular films', l[2].slice(0, 20)) : null,
        l[3].length ? shelf(ctx, 'idle-popular-tv', 'Popular shows', l[3].slice(0, 20)) : null,
      ].filter(Boolean);
    });
  };

  O.interleave = interleave; // (tests)
})();
