// Overseerr plugin: request titles that aren't in the library, from Search.
//
// Overseerr's session cookie is HttpOnly + SameSite=Lax, so the app (a file:// page) can sign in but
// can't send the cookie back. The bundled service (service/service.js) signs in with the Plex token
// ("Sign in with Plex"), keeps the session and proxies API calls to that one Overseerr server.
'use strict';

(function () {
  var TMDB_IMG = 'https://image.tmdb.org/t/p/';
  var STATUS = { 2: 'Requested', 3: 'Processing', 4: 'Partly available', 5: 'Available' };

  function statusLabel(s) { return STATUS[s] || ''; }

  function config(ctx) { return ctx.storage.get('config', null); }

  // "overseerr.example.com" -> "https://overseerr.example.com"; paths are dropped.
  function normalizeUrl(raw) {
    var s = String(raw || '').trim();
    if (!s) throw new Error('Enter your Overseerr address');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    var m = /^(https?):\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(?:[\/?#].*)?$/i.exec(s);
    if (!m) throw new Error('That doesn\'t look like an Overseerr address');
    return m[1].toLowerCase() + '://' + m[2] + (m[3] || '');
  }

  function signIn(ctx, url) {
    var token = ctx.plexToken();
    if (!token) return Promise.reject(new Error('Sign in to Plex first'));
    return ctx.service('login', { url: url, plexToken: token }).then(function (r) {
      ctx.storage.set('config', { url: r.url, user: r.user });
      return r.user;
    });
  }

  // One automatic re-sign-in if the service lost its session (it keeps it in /tmp).
  function api(ctx, method, path, body) {
    var once = function () {
      return ctx.service('request', { method: method, path: path, body: body == null ? null : body }).then(function (r) {
        if (r.status >= 400) {
          var err = new Error((r.data && r.data.message) || ('Overseerr error (HTTP ' + r.status + ')'));
          err.status = r.status;
          throw err;
        }
        return r.data;
      });
    };
    return once().then(null, function (err) {
      var cfg = config(ctx);
      if (err.code !== 'unauthenticated' || !cfg) throw err;
      return signIn(ctx, cfg.url).then(once);
    });
  }

  function toItem(r) {
    return {
      ratingKey: 'os-' + r.mediaType + '-' + r.id,
      type: 'request',
      osType: r.mediaType,
      tmdbId: r.id,
      title: r.title || r.name || '',
      year: (r.releaseDate || r.firstAirDate || '').slice(0, 4),
      summary: r.overview || '',
      thumb: r.posterPath ? TMDB_IMG + 'w342' + r.posterPath : null,
      art: r.backdropPath ? TMDB_IMG + 'w780' + r.backdropPath : null,
      status: r.mediaInfo ? r.mediaInfo.status : 1,
    };
  }

  function submit(ctx, item, seasons) {
    var body = { mediaType: item.osType, mediaId: item.tmdbId };
    if (item.osType === 'tv') body.seasons = seasons;
    ctx.toast('Requesting ' + item.title + '…');
    api(ctx, 'POST', '/request', body).then(function () {
      item.status = 2;
      ctx.toast('Requested ' + item.title);
    }, function (err) { ctx.toast(err.message || 'The request failed', 5000); });
  }

  // Movies get one row; shows list "All/remaining seasons" plus each season with its status.
  function openRequest(item, ctx) {
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
    api(ctx, 'GET', '/tv/' + item.tmdbId).then(function (tv) {
      var known = {};
      ((tv.mediaInfo && tv.mediaInfo.seasons) || []).forEach(function (s) { known[s.seasonNumber] = s.status; });
      var seasons = (tv.seasons || []).filter(function (s) { return s.seasonNumber > 0; });
      var open = seasons.filter(function (s) { return !known[s.seasonNumber] || known[s.seasonNumber] < 2; })
        .map(function (s) { return s.seasonNumber; });
      var rows = [];
      if (open.length) {
        rows.push({
          label: open.length === seasons.length ? 'Request all seasons' : 'Request remaining seasons',
          action: function () { submit(ctx, item, open); },
        });
      }
      seasons.forEach(function (s) {
        var st = statusLabel(known[s.seasonNumber]);
        rows.push({
          label: s.name || ('Season ' + s.seasonNumber),
          sub: st || (s.episodeCount ? s.episodeCount + ' episodes' : ''),
          action: st ? noop : function () { submit(ctx, item, [s.seasonNumber]); },
        });
      });
      if (!rows.length) rows.push({ label: 'Nothing to request', action: noop });
      ctx.sheet([{ heading: heading, rows: rows }]);
    }, function (err) { ctx.toast(err.message, 5000); });
  }

  function settings(ctx) {
    var cfg = config(ctx);
    var signedIn = cfg && cfg.user;
    var doSignIn = function (url) {
      ctx.toast('Signing in to Overseerr…');
      signIn(ctx, url).then(function (user) {
        ctx.toast('Signed in to Overseerr as ' + user.displayName);
        if (ctx.refreshSettings) ctx.refreshSettings();
      }, function (err) {
        ctx.toast(err.message, 5000);
        if (ctx.refreshSettings) ctx.refreshSettings();
      });
    };
    var edit = function () {
      ctx.textEntry('Overseerr address', cfg ? cfg.url : '', 'e.g. https://overseerr.example.com', function (value) {
        var url;
        try { url = normalizeUrl(value); } catch (e) { ctx.toast(e.message); return false; }
        doSignIn(url);
        return true;
      });
    };
    return [{
      label: 'Overseerr requests',
      value: signedIn ? cfg.user.displayName : 'Not set up',
      action: function () {
        var rows = [{ label: cfg ? 'Change Overseerr address' : 'Set up Overseerr', action: edit }];
        if (cfg) {
          rows.push({ label: 'Sign in again', action: function () { doSignIn(cfg.url); } });
          rows.push({
            label: 'Sign out of Overseerr',
            action: function () {
              var clear = function () {
                ctx.storage.del('config');
                ctx.toast('Signed out of Overseerr');
                if (ctx.refreshSettings) ctx.refreshSettings();
              };
              ctx.service('logout').then(clear, clear);
            },
          });
        }
        ctx.sheet([{ heading: signedIn ? 'Overseerr · ' + cfg.url.replace(/^https?:\/\//, '') : 'Overseerr', rows: rows }]);
      },
    }];
  }

  PL.plugins.register({
    id: 'overseerr',
    name: 'Overseerr',
    version: '1.0.0',
    apiVersion: 1,
    description: 'Request movies and shows that are not in your library, from Search.',
    services: ['com.bednal.plexlite.overseerr'],
    settingsRows: settings,

    // TMDB matches that aren't already available in Plex, badged by request status.
    searchRows: function (q, ctx) {
      if (!config(ctx)) return null;
      return api(ctx, 'GET', '/search?query=' + encodeURIComponent(q) + '&page=1').then(function (data) {
        var items = ((data && data.results) || []).filter(function (r) {
          return (r.mediaType === 'movie' || r.mediaType === 'tv') && !(r.mediaInfo && r.mediaInfo.status === 5);
        }).slice(0, 20).map(toItem);
        return {
          id: 'requests',
          title: 'Request on Overseerr',
          kind: 'poster',
          items: items,
          makeCard: function (item, kind, geo) {
            var node = ctx.ui.makeCard(item, kind, geo);
            var label = statusLabel(item.status);
            return label ? ctx.ui.badge(node, 'os-badge os-status-' + item.status, label) : node;
          },
        };
      });
    },

    onSelect: openRequest,
  });
})();
