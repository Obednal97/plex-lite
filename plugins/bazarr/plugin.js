// Subtitles (Bazarr) through the home server helper (PL.homeHelper).
//   - "Subtitles…" on movie and episode details pages and in the hold-OK menu: a sheet with the
//     subtitles the title has, "Find <language> subtitles" for each language its Bazarr profile
//     wants and it lacks (POST /subtitles/search, up to 45 s), and "Fix subtitle timing" for a
//     subtitle file that drifts (POST /subtitles/sync, a minute or two in the background).
//   - A "No English subtitles" badge on details when a profile language is missing, from the same
//     cached /subtitles answer the sheet uses (one helper request per title every few minutes).
// Hidden when the helper or Bazarr isn't available.
'use strict';

(function () {
  var SUBS_MS = 3 * 60 * 1000;
  var CACHE_MAX = 100;
  var SEARCH_TIMEOUT = 60000;

  var B = PL.bazarr = {};

  function H() { return PL.homeHelper; }

  function playable(item) { return item && (item.type === 'movie' || item.type === 'episode'); }

  // ids (from PL.homeHelper.titleIds) -> the query/body fields the contract uses
  B.params = function (ids) {
    if (ids.type === 'movie') return { type: 'movie', tmdbId: ids.tmdbId };
    return { type: 'episode', tvdbId: ids.tvdbId, season: ids.season, episode: ids.episode };
  };

  B.query = function (ids) {
    var p = B.params(ids);
    return Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
  };

  // ---- /subtitles, cached per title ------------------------------------------------------------------

  // (bounded: the least recently used titles go first)
  var cache = H().lru(CACHE_MAX);

  B.subtitles = function (ids, maxAge) {
    var key = B.query(ids);
    var hit = cache.get(key);
    if (hit && hit.pending) return hit.pending;
    if (hit && Date.now() - hit.at < (maxAge == null ? SUBS_MS : maxAge)) return Promise.resolve(hit.value);
    var p = H().get('/subtitles?' + key, { timeout: 8000 }).then(function (data) {
      cache.set(key, { at: Date.now(), value: data });
      return data;
    }, function (err) {
      cache.del(key);
      throw err;
    });
    cache.set(key, { at: 0, pending: p });
    return p;
  };

  B.forget = function (ids) { cache.del(B.query(ids)); };
  B.cacheSize = function () { return cache.size(); }; // (tests)

  // "English", "English (forced)", "English (SDH)"
  B.langName = function (l) {
    return (l.name || l.code || 'Unknown') + (l.forced ? ' (forced)' : l.hi ? ' (SDH)' : '');
  };

  // The language a details badge warns about: the first missing full (not forced, not SDH) language.
  B.badgeLanguage = function (data) {
    return ((data && data.missing) || []).filter(function (l) { return !l.forced && !l.hi; })[0] || null;
  };

  // ---- The sheet ---------------------------------------------------------------------------------

  var busy = {};

  // the Plex ratingKey lets the helper refresh that item after a download
  function body(ids, l) {
    var b = B.params(ids);
    if (ids.ratingKey) b.ratingKey = String(ids.ratingKey);
    b.language = l.code;
    b.forced = !!l.forced;
    b.hi = !!l.hi;
    return b;
  }

  B.search = function (ctx, ids, l) {
    var key = 's:' + B.query(ids) + ':' + l.code + (l.forced ? 'f' : '') + (l.hi ? 'h' : '');
    if (busy[key]) { ctx.toast('Still looking for ' + B.langName(l) + ' subtitles…'); return Promise.resolve(null); }
    busy[key] = true;
    H().busy('Finding ' + B.langName(l) + ' subtitles…');
    return H().post('/subtitles/search', body(ids, l), ctx, { timeout: SEARCH_TIMEOUT }).then(function (r) {
      delete busy[key];
      B.forget(ids);
      if (H().dryRun(r)) ctx.toast('Dry run: the helper would look for ' + B.langName(l) + ' subtitles', 5000);
      else if (r && r.status === 'downloaded') ctx.toast('Found ' + B.langName(l) + ' subtitles' + (r.plexRefreshed ? ' · they\'re in Plex now' : ' · restart playback to see them'), 6000);
      else ctx.toast('Bazarr couldn\'t find any', 5000);
      return r;
    }, function (err) {
      delete busy[key];
      ctx.toast(H().errorText(err, 'Bazarr'), 5000);
      return null;
    });
  };

  B.sync = function (ctx, ids, l) {
    return H().post('/subtitles/sync', body(ids, l), ctx, { timeout: 20000 }).then(function (r) {
      ctx.toast(H().dryRun(r) ? 'Dry run: the helper would re-time ' + B.langName(l) + ' subtitles' : 'Re-timing ' + B.langName(l) + ' subtitles · takes a minute or two', 5000);
    }, function (err) {
      ctx.toast(err.code === 'not_found' ? 'There\'s no ' + B.langName(l) + ' subtitle file to re-time' : H().errorText(err, 'Bazarr'), 5000);
    });
  };

  // [{heading, rows}] for a /subtitles answer
  B.sections = function (ctx, ids, data) {
    var noop = function () {};
    var have = (data && data.have) || [];
    var miss = (data && data.missing) || [];
    var out = [{
      heading: 'Subtitles · ' + ids.label,
      rows: have.length ? have.map(function (l) {
        return { label: B.langName(l), sub: l.external ? 'Subtitle file' : 'In the video file', action: noop };
      }) : [{ label: 'No subtitles yet', sub: miss.length ? '' : 'Bazarr has no languages to look for', action: noop }],
    }];
    if (miss.length) {
      out.push({
        heading: 'Missing',
        rows: miss.map(function (l) {
          return { label: 'Find ' + B.langName(l) + ' subtitles', sub: 'Up to a minute', action: function () { B.search(ctx, ids, l); } };
        }),
      });
    }
    // Bazarr can re-time subtitle files only (not ones inside the video)
    var files = have.filter(function (l) { return l.external; });
    if (files.length) {
      out.push({
        heading: 'Out of sync?',
        rows: files.map(function (l) {
          return {
            label: files.length === 1 ? 'Fix subtitle timing' : 'Fix ' + B.langName(l) + ' timing',
            sub: files.length === 1 ? B.langName(l) : 'Matched to the audio',
            action: function () { B.sync(ctx, ids, l); },
          };
        }),
      });
    }
    return out;
  };

  B.open = function (ctx, item) {
    H().busy('Checking subtitles…');
    H().titleIds(ctx, item).then(function (ids) {
      ids.ratingKey = item.ratingKey;
      return B.subtitles(ids, 30000).then(function (data) {
        H().idle();
        ctx.sheet(B.sections(ctx, ids, data));
      });
    }).then(null, function (err) {
      ctx.toast(err.code === 'no_id' ? err.message : H().errorText(err, 'Bazarr'), 5000);
    });
  };

  PL.plugins.register({
    id: 'bazarr',
    name: 'Subtitles',
    version: '1.0.0',
    apiVersion: 1,
    description: 'Find missing subtitles and fix their timing with Bazarr, through the home server helper.',

    actions: function (item, ctx) {
      var hh = H();
      if (!hh || !playable(item) || !hh.has('bazarr')) return [];
      return [{ label: 'Subtitles…', icon: 'tracks', run: function () { B.open(ctx, item); } }];
    },

    badges: function (item, ctx) {
      var hh = H();
      if (!hh || !hh.url() || !playable(item)) return null;
      return hh.health().then(function (h) {
        if (!h || !h.services.bazarr) return [];
        return hh.titleIds(ctx, item).then(B.subtitles).then(function (data) {
          var l = B.badgeLanguage(data);
          return l ? [{ label: 'No ' + l.name + ' subtitles' }] : [];
        });
      });
    },
  });
})();
