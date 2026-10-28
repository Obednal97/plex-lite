// Overseerr plugin (works with Overseerr and Seerr): request titles that aren't in the library
// (Search), see what is downloading (Downloading screen, a shelf on Recommended, a badge on details
// pages) and report a problem with a title (details pill and hold-OK menu).
//
// Overseerr's session cookie is HttpOnly + SameSite=Lax, so the app (a file:// page) can sign in but
// can't send the cookie back. The bundled service (service/service.js) signs in with the Plex token
// ("Sign in with Plex"), keeps one session per Plex profile and proxies API calls to that one
// Overseerr server. In the web build seerr-web.js does the same from the browser (the page must be
// on the same site as Overseerr, whose proxy must allow it). Shared code: seerr.js; flows:
// report.js, downloads.js.
'use strict';

(function () {
  var O = PL.overseerr;
  var STATUS = { 2: 'Requested', 3: 'Processing', 4: 'Partly available', 5: 'Available' };

  function statusLabel(s) { return STATUS[s] || ''; }

  function config(ctx) { return O.config(ctx); }

  function api(ctx, method, path, body) { return O.api(ctx, method, path, body); }

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
      thumb: r.posterPath ? O.TMDB_IMG + 'w342' + r.posterPath : null,
      art: r.backdropPath ? O.TMDB_IMG + 'w780' + r.backdropPath : null,
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

  function refresh(ctx) { if (ctx.refreshSettings) ctx.refreshSettings(); }

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

  // Optional: the home server's read-only download queue (full Sonarr/Radarr queue). Empty = Overseerr.
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

  function settings(ctx) {
    var cfg = config(ctx);
    var user = O.account(ctx);
    var who = O.profileName(ctx);
    var value = !cfg || !cfg.url ? 'Not set up' : user ? user.displayName : 'Not signed in · ' + who;
    return [{
      label: 'Overseerr',
      value: value,
      action: function () {
        var rows = [];
        var problem = O.web && O.web.problem;
        if (problem) {
          rows.push({ label: problem.explain.title, sub: 'Why Overseerr doesn\'t work on this site yet', action: function () { O.web.explain(ctx, problem); } });
        }
        if (!cfg || !cfg.url) {
          rows.push({ label: 'Set up Overseerr', sub: 'Signs in with your Plex account', action: function () { editAddress(ctx); } });
        } else if (!user) {
          // first sign-in for this profile is a deliberate step: Overseerr may create an account for it
          rows.push({ label: 'Sign in as ' + who, sub: 'With this Plex profile', action: function () { doSignIn(ctx, cfg.url); } });
        } else {
          rows.push({ label: 'Downloads', sub: 'What\'s downloading now', action: function () { O.openDownloads(ctx); } });
          rows.push({
            label: 'Signed in as ' + user.displayName,
            sub: O.canReport(ctx) ? 'Can report problems' : 'Can\'t report problems',
            action: function () {
              O.refreshUser(ctx, true).then(function () {
                ctx.toast(O.canReport(ctx) ? 'You can report problems' : 'Your Overseerr account can\'t report problems — ask the server owner');
                refresh(ctx);
              });
            },
          });
        }
        if (cfg && cfg.url) {
          rows.push({ label: 'Download queue address', sub: cfg.helperUrl ? cfg.helperUrl.replace(/^https?:\/\//, '') : 'Optional', action: function () { editHelper(ctx); } });
          rows.push({ label: 'Change Overseerr address', action: function () { editAddress(ctx); } });
          if (user) {
            rows.push({ label: 'Sign in again', action: function () { doSignIn(ctx, cfg.url); } });
            rows.push({
              label: 'Sign out of Overseerr', sub: 'This profile only',
              action: function () {
                O.forget(ctx).then(function () {
                  ctx.toast('Signed out of Overseerr');
                  refresh(ctx);
                });
              },
            });
          }
        }
        ctx.sheet([{ heading: cfg && cfg.url ? 'Overseerr · ' + cfg.url.replace(/^https?:\/\//, '') : 'Overseerr', rows: rows }]);
      },
    }];
  }

  PL.plugins.register({
    id: 'overseerr',
    name: 'Overseerr',
    version: '1.1.0',
    apiVersion: 1,
    description: 'Request titles from Search, see what is downloading and report problems with a title.',
    services: ['com.bednal.plexlite.service'],
    // the web build runs it without the service (seerr-web.js)
    web: true,
    settingsRows: settings,

    // "Report a problem" for viewers whose Overseerr account may create issues
    actions: function (item, ctx) {
      if (['movie', 'show', 'season', 'episode'].indexOf(item.type) === -1 || !O.canReport(ctx)) return [];
      return [{ label: 'Report a problem', icon: 'report', run: function () { O.report(item, ctx); } }];
    },

    badges: O.badges,
    shelfRows: O.shelf,

    // TMDB matches that aren't already available in Plex, badged by request status.
    searchRows: function (q, ctx) {
      if (!O.ready(ctx)) return null;
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
            var label = item.downloading != null ? 'Downloading ' + item.downloading + '%' : statusLabel(item.status);
            return label ? ctx.ui.badge(node, 'os-badge os-status-' + item.status, label) : node;
          },
        };
      });
    },

    onSelect: openRequest,
  });
})();
