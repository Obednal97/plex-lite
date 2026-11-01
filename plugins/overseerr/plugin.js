// Overseerr plugin (works with Overseerr and Seerr): request titles that aren't in the library
// (Search, Trending/Popular/Upcoming rows, missing seasons of a show), follow your requests and what
// is downloading (Your requests, Downloading, a shelf on Recommended, a badge on details pages) and
// report a problem with a title (details pill and hold-OK menu).
//
// Overseerr's session cookie is HttpOnly + SameSite=Lax, so the app (a file:// page) can sign in but
// can't send the cookie back. The bundled service (service/service.js) signs in with the Plex token
// ("Sign in with Plex"), keeps one session per Plex profile and proxies API calls to that one
// Overseerr server. In the web build seerr-web.js does the same from the browser (the page must be
// on the same site as Overseerr, whose proxy must allow it). Shared code: seerr.js; flows:
// report.js, downloads.js, discover.js; pages: screens.js (TV), touch.js (phones and tablets, web).
'use strict';

(function () {
  var O = PL.overseerr;
  var STATUS = { 2: 'Requested', 3: 'Processing', 4: 'Partly available', 5: 'Available' };
  // a list item in the hold-OK menu: answer within this, the menu waits at most 600 ms for plugins
  var MENU_WAIT_MS = 450;
  var DETAILS_WAIT_MS = 5000;
  var MISSING_MAX_AGE = 10 * 60 * 1000;

  function statusLabel(s) { return STATUS[s] || ''; }

  function config(ctx) { return O.config(ctx); }

  function api(ctx, method, path, body) { return O.api(ctx, method, path, body); }

  // ---- Something changed (sign-in, a toggle): Settings and open pages redraw -----------------------

  var listeners = [];
  O.onChange = function (fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };
  O.changed = function (ctx) {
    if (ctx.refreshSettings) ctx.refreshSettings();
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { ctx.warn('page refresh failed: ' + e.message); } });
  };
  function refresh(ctx) { O.changed(ctx); }

  // ---- Requests ----------------------------------------------------------------------------------

  // An Overseerr search result -> a Search item (same shape as discover.js's items)
  function toItem(r) {
    var mi = r.mediaInfo;
    var dl = mi && mi.downloadStatus && mi.downloadStatus.length ? mi.downloadStatus : null;
    var size = 0;
    var left = 0;
    (dl || []).forEach(function (d) { size += d.size || 0; left += Math.min(d.sizeLeft || 0, d.size || 0); });
    return {
      downloading: dl && size > 0 ? Math.floor(((size - left) / size) * 100) : null,
      ratingKey: 'os-' + r.mediaType + '-' + r.id,
      type: 'request',
      osType: r.mediaType,
      tmdbId: r.id,
      title: r.title || r.name || '',
      year: (r.releaseDate || r.firstAirDate || '').slice(0, 4),
      summary: r.overview || '',
      thumb: O.img(r.posterPath, 'w342'),
      art: O.img(r.backdropPath, 'w780'),
      status: r.mediaInfo ? r.mediaInfo.status : 1,
    };
  }

  // After a request: the title's cached state is out of date everywhere it is kept.
  function requested(item) {
    O.forgetCached('show', String(item.tmdbId));
    O.forgetCached('missing');
    O.forgetCached('requests');
  }

  function submit(ctx, item, seasons) {
    var body = { mediaType: item.osType, mediaId: item.tmdbId };
    if (item.osType === 'tv') body.seasons = seasons;
    ctx.toast('Requesting ' + item.title + '…');
    api(ctx, 'POST', '/request', body).then(function () {
      if (item.status < 2) item.status = 2;
      requested(item);
      ctx.toast('Requested ' + item.title + (item.osType === 'tv' ? ' · ' + O.seasonsLabel(seasons) : ''));
    }, function (err) {
      ctx.toast(err.status === 403 ? 'Your Overseerr account can\'t request this' : (err.message || 'The request failed'), 5000);
    });
  }

  function seasonText(s) {
    if (s.requested === 'pending') return 'Requested · waiting for approval';
    if (s.requested === 'approved' && s.status < 3) return 'Requested';
    return statusLabel(s.status);
  }

  // Movies get one row; shows list "All/remaining seasons" plus each season with its status.
  // item: {osType: 'movie'|'tv', tmdbId, title, year, status}
  O.openRequest = function (item, ctx) {
    var heading = item.title + (item.year ? ' (' + item.year + ')' : '');
    var noop = function () {};
    if (item.osType === 'movie') {
      var label = statusLabel(item.status);
      ctx.sheet([{
        heading: heading,
        rows: label ? [{ label: label + ' on Overseerr', action: noop }]
          : [{ label: 'Request ' + item.title, action: function () { submit(ctx, item); } }],
      }]);
      return;
    }
    // the compact lookup (a few hundred bytes, not Overseerr's whole /tv answer), a moment old at most
    O.show(ctx, item.tmdbId, 30000).then(function (show) {
      var seasons = show.seasons;
      var open = O.openSeasons(seasons).map(function (s) { return s.season; });
      var rows = [];
      if (open.length) {
        rows.push({
          // "Request all seasons", "Request Season 3", "Request Seasons 4 and 5"
          label: open.length === seasons.length ? 'Request all seasons' : 'Request ' + O.seasonsLabel(open),
          action: function () { submit(ctx, item, open); },
        });
      }
      var today = new Date().toISOString().slice(0, 10);
      seasons.forEach(function (s) {
        var st = seasonText(s);
        var soon = s.airDate && s.airDate > today ? 'Starts ' + O.date(s.airDate) : '';
        rows.push({
          label: s.name || ('Season ' + s.season),
          sub: st || soon || (s.episodes ? s.episodes + (s.episodes === 1 ? ' episode' : ' episodes') : ''),
          action: st ? noop : function () { submit(ctx, item, [s.season]); },
        });
      });
      if (!rows.length) rows.push({ label: 'Nothing to request', action: noop });
      ctx.sheet([{ heading: heading, rows: rows }]);
    }, function (err) { ctx.toast(err.message, 5000); });
  };

  // ---- Missing seasons of a show that is in Plex ---------------------------------------------------

  // Promise<{item, open: [season]}> for a show or season page (cached 10 min per show). A show
  // Overseerr can't match answers "nothing open", so it isn't asked again on every visit; a failure
  // that may pass (no network, a session that ended, Plex not answering) isn't kept, so the next
  // visit asks again.
  function missing(ctx, item, showKey) {
    return O.cached(ctx, 'missing', showKey, MISSING_MAX_AGE, function () {
      return O.plexTitle(ctx, item.type === 'season' ? { type: 'season', parentRatingKey: showKey } : item).then(function (pt) {
        return O.tmdbFor(ctx, pt).then(function (tmdb) {
          return O.show(ctx, tmdb).then(function (show) {
            return {
              item: { osType: 'tv', tmdbId: tmdb, title: pt.title || show.title, year: pt.year || show.year, status: show.media ? show.media.status : 1 },
              open: O.openSeasons(show.seasons, true).map(function (s) { return s.season; }),
            };
          });
        });
      }).then(null, function (err) {
        ctx.log('no missing seasons for ' + showKey + ': ' + (err && err.message));
        if (!(err && (err.permanent || err.status === 404))) throw err;
        return { item: null, open: [] };
      });
    });
  }

  function requestSeasons(m, ctx) {
    if (!m || !m.item || !m.open.length) return [];
    return [{ label: 'Request seasons', icon: 'download', run: function () { O.openRequest(m.item, ctx); } }];
  }

  function within(p, ms, fallback) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(fallback); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function () { clearTimeout(t); resolve(fallback); });
    });
  }

  // Report a problem (viewers whose Overseerr account may create issues) and, on a show or season
  // that Overseerr says is missing aired seasons, Request seasons. That needs a lookup: answered at
  // once when it's cached, else as a promise. A details page passes the full item (with Guids) and
  // waits for it (5 s at most); a list item (the hold-OK menu, which waits 600 ms at most) gets what is known
  // within 450 ms, and the lookup carries on into the cache for next time.
  function actions(item, ctx) {
    var t = item.type;
    var report = ['movie', 'show', 'season', 'episode'].indexOf(t) !== -1 && O.canReport(ctx)
      ? [{ label: 'Report a problem', icon: 'report', run: function () { O.report(item, ctx); } }] : [];
    if ((t !== 'show' && t !== 'season') || !O.ready(ctx)) return report;
    var showKey = String((t === 'show' ? item.ratingKey : item.parentRatingKey) || '');
    if (!/^\d+$/.test(showKey)) return report;
    var known = O.peek(ctx, 'missing', showKey);
    if (known) return requestSeasons(known, ctx).concat(report);
    var p = missing(ctx, item, showKey);
    // (the host drops an answer after 8 s, Report a problem with it: give up on the lookup first)
    var wait = within(p, item.Guid ? DETAILS_WAIT_MS : MENU_WAIT_MS, null);
    return wait.then(function (m) { return requestSeasons(m, ctx).concat(report); });
  }

  // ---- Sign-in and settings ----------------------------------------------------------------------

  function doSignIn(ctx, url) {
    ctx.toast('Signing in to Overseerr…');
    O.signIn(ctx, url).then(function (user) {
      ctx.toast('Signed in to Overseerr as ' + user.displayName);
      refresh(ctx);
    }, function (err) {
      // web: Overseerr doesn't allow this site yet; say why instead of a bare error
      if (!(O.web && O.web.explain(ctx, err))) ctx.toast(err.message, 5000);
      refresh(ctx);
    });
  }

  function editAddress(ctx) {
    var cfg = config(ctx);
    ctx.textEntry('Overseerr address', cfg ? cfg.url : '', 'e.g. https://overseerr.example.com', function (value) {
      var url;
      try { url = O.normalizeUrl(value, 'Overseerr'); } catch (e) { ctx.toast(e.message); return false; }
      doSignIn(ctx, url);
      return true;
    });
  }

  // Until the shared Home server helper setting exists (plugins/home-helper): the home server's
  // read-only download queue (full Sonarr/Radarr queue). Empty = Overseerr.
  function editHelper(ctx) {
    var cfg = config(ctx);
    ctx.textEntry('Download queue address (optional)', cfg.helperUrl || '', 'e.g. http://helper.example.com:8787 · empty uses Overseerr', function (value) {
      var c = config(ctx);
      if (!String(value || '').trim()) {
        delete c.helperUrl;
        ctx.storage.set('config', c);
        ctx.toast('Downloads come from Overseerr');
        refresh(ctx);
        return true;
      }
      var url;
      try { url = O.normalizeUrl(value, 'download queue'); } catch (e) { ctx.toast(e.message); return false; }
      c.helperUrl = url;
      ctx.storage.set('config', c);
      ctx.toast('Downloads come from ' + url.replace(/^https?:\/\//, ''));
      refresh(ctx);
      return true;
    });
  }

  function signOut(ctx) {
    O.forget(ctx).then(function () {
      ctx.toast('Signed out of Overseerr');
      refresh(ctx);
    });
  }

  function checkAccount(ctx) {
    O.refreshUser(ctx, true).then(function () {
      ctx.toast(O.canReport(ctx) ? 'You can report problems' : 'Your Overseerr account can\'t report problems — ask the server owner');
      refresh(ctx);
    });
  }

  function hostOf(url) { return String(url || '').replace(/^https?:\/\//, ''); }

  // "12 · 2 waiting for approval"
  function requestsValue(ctx) {
    var known = O.peek(ctx, 'requests', 'mine');
    if (!known) return '';
    var pending = known.list.filter(function (e) { return e.state === 'pending'; }).length;
    // the list holds the newest 50 (O.REQUESTS_TAKE): a full page means there may be more
    var n = known.list.length >= O.REQUESTS_TAKE ? O.REQUESTS_TAKE + '+' : String(known.list.length);
    return known.list.length ? n + (pending ? ' · ' + pending + ' waiting' : '') : 'None yet';
  }

  function downloadsValue(ctx) {
    var known = O.downloadsKnown(ctx);
    if (!known) return '';
    var n = known.length;
    return n ? n + (n === 1 ? ' title' : ' titles') : 'Nothing';
  }

  // The Overseerr page (TV: screens.js, touch: touch.js) as data: a heading and groups of rows.
  // Row: {id, label, sub, value, toggle (true/false: a switch), danger, action}
  O.pageModel = function (ctx) {
    var cfg = config(ctx);
    var user = O.account(ctx);
    var who = O.profileName(ctx);
    var groups = [];
    var problem = O.web && O.web.problem;
    if (problem) {
      groups.push({ heading: '', rows: [{ id: 'problem', label: problem.explain.title, sub: 'Why Overseerr doesn\'t work on this site yet', tone: 'warn', action: function () { O.web.explain(ctx, problem); } }] });
    }
    var intro;
    if (!cfg || !cfg.url) {
      intro = 'Request films and shows that aren\'t in your library, and see what is on its way.';
      groups.push({ heading: 'Set up', rows: [{ id: 'setup', label: 'Set up Overseerr', sub: 'Signs in with your Plex account', action: function () { editAddress(ctx); } }] });
    } else if (!user) {
      intro = who + ' isn\'t signed in to Overseerr on this device.';
      groups.push({ heading: 'Account', rows: [
        // first sign-in for this profile is a deliberate step: Overseerr may create an account for it
        { id: 'signin', label: 'Sign in as ' + who, sub: 'With this Plex profile', action: function () { doSignIn(ctx, cfg.url); } },
      ] });
    } else {
      intro = 'Signed in as ' + user.displayName + (O.canReport(ctx) ? ' · can report problems' : ' · can\'t report problems');
      groups.push({ heading: 'Requests', rows: [
        { id: 'requests', label: 'Your requests', sub: 'What you\'ve asked for and how far it has got', value: requestsValue(ctx), next: true, action: function () { O.openRequests(ctx); } },
        { id: 'downloads', label: 'Downloads', sub: 'What\'s downloading now', value: downloadsValue(ctx), next: true, action: function () { O.openDownloads(ctx); } },
      ] });
      groups.push({ heading: 'Discover', rows: [
        {
          id: 'discover', label: 'Trending, Popular and Upcoming', sub: 'Rows on Movies, TV Shows and Search',
          toggle: O.discoverOn(ctx), value: O.discoverOn(ctx) ? 'On' : 'Off',
          action: function () {
            O.setDiscover(ctx, !O.discoverOn(ctx));
            ctx.toast(O.discoverOn(ctx) ? 'Overseerr rows are on' : 'Overseerr rows are off');
            refresh(ctx);
          },
        },
      ] });
      groups.push({ heading: 'Account', rows: [
        { id: 'account', label: 'Signed in as ' + user.displayName, sub: O.canReport(ctx) ? 'Can report problems' : 'Can\'t report problems', action: function () { checkAccount(ctx); } },
        { id: 'again', label: 'Sign in again', sub: 'With this Plex profile (' + who + ')', action: function () { doSignIn(ctx, cfg.url); } },
        { id: 'signout', label: 'Sign out of Overseerr', sub: 'This profile only', danger: true, action: function () { signOut(ctx); } },
      ] });
    }
    if (cfg && cfg.url) {
      var server = [{ id: 'address', label: 'Overseerr address', value: hostOf(cfg.url), action: function () { editAddress(ctx); } }];
      // the shared Home server helper setting replaces this row once it exists
      if (!PL.homeHelper) {
        server.push({ id: 'helper', label: 'Download queue address', value: cfg.helperUrl ? hostOf(cfg.helperUrl) : 'Optional', action: function () { editHelper(ctx); } });
      }
      groups.push({ heading: 'Server', rows: server });
    }
    return { title: 'Overseerr', host: cfg && cfg.url ? hostOf(cfg.url) : '', intro: intro, groups: groups };
  };

  // Fetches what the page's values show (requests, downloads); onDone when they've arrived.
  O.warmPage = function (ctx, onDone) {
    if (!O.ready(ctx)) return;
    var done = function () { if (onDone) onDone(); };
    Promise.all([O.requests(ctx).then(null, function () {}), O.downloads(ctx).then(null, function () {})]).then(done, done);
  };

  // Settings → Plugins → Overseerr: a page of its own (the touch layer's when it is showing)
  O.openPage = function (ctx) {
    if (O.touchUi && O.touchUi.active()) O.touchUi.page(ctx);
    else ctx.push(O.pageScreen(ctx));
  };

  O.openRequests = function (ctx) {
    if (O.touchUi && O.touchUi.active()) O.touchUi.requests(ctx);
    else ctx.push(O.requestsScreen(ctx));
  };

  function settings(ctx) {
    var cfg = config(ctx);
    var user = O.account(ctx);
    var value = !cfg || !cfg.url ? 'Not set up' : user ? user.displayName : 'Not signed in · ' + O.profileName(ctx);
    return [{ label: 'Overseerr', value: value, action: function () { O.openPage(ctx); } }];
  }

  PL.plugins.register({
    id: 'overseerr',
    name: 'Overseerr',
    version: '1.2.0',
    apiVersion: 1,
    description: 'Request titles, follow your requests and downloads, and report problems with a title.',
    services: ['com.bednal.plexlite.service'],
    // the web build runs it without the service (seerr-web.js)
    web: true,
    settingsRows: settings,
    actions: actions,
    badges: O.badges,

    // Trending, Popular and Upcoming among the library's own rows, and Downloading at the end
    shelfRows: function (section, ctx) {
      return Promise.all([
        O.discoverShelves(section, ctx).then(null, function () { return []; }),
        Promise.resolve(O.shelf(section, ctx)).then(null, function () { return null; }),
      ]).then(function (r) { return r[0].concat(r[1] ? [r[1]] : []); });
    },

    // TMDB matches that aren't already available in Plex, badged by request status.
    searchRows: function (q, ctx) {
      if (!O.ready(ctx)) return null;
      return api(ctx, 'GET', '/search?query=' + encodeURIComponent(q) + '&page=1').then(function (data) {
        var items = ((data && data.results) || []).filter(function (r) {
          return (r.mediaType === 'movie' || r.mediaType === 'tv') && !(r.mediaInfo && r.mediaInfo.status === 5);
        }).slice(0, 20).map(toItem);
        items.forEach(O.withBadge);
        return {
          id: 'requests',
          title: 'Request on Overseerr',
          kind: 'poster',
          items: items,
          makeCard: O.requestCard(ctx),
        };
      });
    },

    // Search before anything is typed: Trending, Popular films, Popular shows
    searchIdleRows: function (ctx) { return O.searchIdle(ctx); },

    onSelect: O.openRequest,
  });

  O.actions = actions; // (tests)
})();
