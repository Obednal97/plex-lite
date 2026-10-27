// Overseerr plugin: "Report a problem" with a Plex title. Creates an Overseerr/Seerr issue under the
// viewer's own Overseerr account (so the server owner is notified, and a server-side helper can act
// on it). Flow: reason -> (TV) which episodes -> confirm -> POST /api/v1/issue.
'use strict';

(function () {
  var O = PL.overseerr;

  // issueType: 1 video, 2 audio, 3 subtitles, 4 other (server/constants/issue.ts). The reason id goes
  // into the issue message so a helper can tell e.g. "wrong language" from "out of sync".
  O.REASONS = [
    { id: 'video-quality', label: 'Poor video quality', type: 1 },
    { id: 'audio-language', label: 'Wrong audio language', type: 2 },
    { id: 'out-of-sync', label: 'Audio out of sync', type: 2 },
    { id: 'corrupt', label: 'Stutters or looks corrupt', type: 1 },
    { id: 'wrong-item', label: 'Wrong film', tvLabel: 'Wrong episode', type: 4 },
    { id: 'subtitles', label: 'Subtitles missing or burned in', type: 3 },
    { id: 'other', label: 'Something else…', type: 4, note: true },
  ];

  function epLabel(season, episode) {
    if (!season) return 'The whole show';
    if (!episode) return 'All of Season ' + season;
    return 'S' + season + ' E' + episode;
  }

  function fileName(item) {
    var part = item && item.Media && item.Media[0] && item.Media[0].Part && item.Media[0].Part[0];
    var f = part && part.file ? String(part.file) : '';
    return f ? f.split(/[\\/]/).pop() : '';
  }

  // Human text first (it is what the notification shows), then one machine-readable line.
  function message(reason, scope, note, item) {
    var lines = [reason.label.replace(/…$/, '') + (note ? ': ' + note : '')];
    lines.push('');
    lines.push('Reported from Plex Lite' + (scope.season ? ' (' + epLabel(scope.season, scope.episode) + ')' : '') + '.');
    var tag = ['reason=' + reason.id, 'scope=' + (scope.episode ? 'episode' : scope.season ? 'season' : item.type === 'movie' ? 'movie' : 'show')];
    if (scope.season) tag.push('season=' + scope.season);
    if (scope.episode) tag.push('episode=' + scope.episode);
    if (scope.plexItem) {
      tag.push('plex=' + scope.plexItem.ratingKey);
      var versions = (scope.plexItem.Media || []).length;
      if (versions > 1) tag.push('versions=' + versions);
      var f = fileName(scope.plexItem);
      if (f) tag.push('file=' + f.replace(/;/g, ','));
    }
    lines.push('plexlite: ' + tag.join('; '));
    return lines.join('\n');
  }

  // The issue's Overseerr media id plus the title's open issues; started as soon as the sheet opens.
  function resolveMedia(ctx, item) {
    return O.plexTitle(ctx, item).then(function (pt) {
      return O.tmdbFor(ctx, pt).then(function (tmdb) {
        return O.lookup(ctx, pt.type, tmdb).then(function (r) {
          if (!r.media || !r.media.mediaId) throw new Error('Overseerr doesn\'t track ' + (pt.title || 'this title') + ' yet');
          return { pt: pt, media: r.media, title: r.title || pt.title };
        });
      });
    });
  }

  function sameScope(issue, scope) {
    return (issue.problemSeason || 0) === (scope.season || 0) && (issue.problemEpisode || 0) === (scope.episode || 0);
  }

  function ago(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!(ms >= 0)) return '';
    var h = Math.round(ms / 3600000);
    if (h < 1) return 'just now';
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }

  function send(ctx, item, reason, scope, note, r) {
    ctx.toast('Sending your report…');
    // the file name helps whoever fixes it pick the right file; list rows often come without it
    var plexItem = scope.plexItem;
    var full = plexItem && !fileName(plexItem) ? ctx.plex.metadata(plexItem.ratingKey).then(null, function () { return plexItem; }) : Promise.resolve(plexItem);
    full.then(function (pi) {
      var withFile = {};
      Object.keys(scope).forEach(function (k) { withFile[k] = scope[k]; });
      withFile.plexItem = pi;
      return O.api(ctx, 'POST', '/issue', {
        issueType: reason.type,
        message: message(reason, withFile, note, item),
        mediaId: r.media.mediaId,
        problemSeason: scope.season || 0,
        problemEpisode: scope.episode || 0,
      });
    }).then(function (issue) {
      ctx.log('reported issue ' + (issue && issue.id) + ' (' + reason.id + ')');
      ctx.toast('Thanks — your report was sent', 4000);
    }, function (err) {
      ctx.toast(err.status === 403 ? 'Your Overseerr account can\'t report problems' : (err.message || 'The report failed'), 5000);
    });
  }

  // Waits for the Overseerr match (usually done by now); a failed match was already shown as a toast.
  function confirm(ctx, item, reason, scope, note, resolved) {
    resolved.then(function (r) {
      var user = O.account(ctx) || {};
      var heading = 'Report: ' + (item.type === 'movie' ? reason.label : (reason.tvLabel || reason.label)).replace(/…$/, '');
      var what = item.type === 'movie' ? (r.title || item.title || 'this film') : epLabel(scope.season, scope.episode);
      // an already-open report for the same episodes is worth knowing about before sending another
      var dup = (r.media.issues || []).filter(function (i) { return sameScope(i, scope); })[0];
      ctx.sheet([{ heading: heading, rows: [
        {
          label: dup ? 'Send another report' : 'Send report',
          sub: dup ? 'Already reported ' + ago(dup.createdAt) : what + ' · as ' + user.displayName,
          action: function () { send(ctx, item, reason, scope, note, r); },
        },
        { label: 'Cancel', action: function () {} },
      ] }], { focus: 0 });
    }, function () {});
  }

  function askNote(ctx, item, reason, scope, resolved) {
    ctx.textEntry('What\'s wrong?', '', 'A few words, e.g. "no sound after 20 minutes"', function (value) {
      var note = String(value || '').trim().slice(0, 300);
      if (!note) { ctx.toast('Type a few words, or press Back to cancel'); return false; }
      setTimeout(function () { confirm(ctx, item, reason, scope, note, resolved); }, 0);
      return true;
    });
  }

  function next(ctx, item, reason, scope, resolved) {
    if (reason.note) askNote(ctx, item, reason, scope, resolved);
    else confirm(ctx, item, reason, scope, null, resolved);
  }

  // A season's episodes as a sheet: "All of Season N" then each episode.
  function pickEpisode(ctx, item, reason, season, resolved) {
    ctx.plex.children(season.ratingKey).then(function (eps) {
      var n = season.index;
      var rows = [{ label: 'All of Season ' + n, action: function () { next(ctx, item, reason, { season: n, episode: 0 }, resolved); } }];
      eps.forEach(function (ep) {
        rows.push({
          label: 'E' + ep.index + (ep.title ? ' · ' + ep.title : ''),
          action: function () { next(ctx, item, reason, { season: n, episode: ep.index, plexItem: ep }, resolved); },
        });
      });
      ctx.sheet([{ heading: (season.title || 'Season ' + n) + ' · which episode?', rows: rows }], { focus: 0 });
    }, function (err) { ctx.toast(err.message || 'Couldn\'t load the episodes', 5000); });
  }

  // Which episodes are affected (shows, seasons, episodes). Movies skip this.
  function pickScope(ctx, item, reason, resolved) {
    var go = function (scope) { return function () { next(ctx, item, reason, scope, resolved); }; };
    if (item.type === 'episode') {
      var s = item.parentIndex;
      ctx.sheet([{ heading: 'Which episodes?', rows: [
        { label: 'Just this episode', sub: epLabel(s, item.index), action: go({ season: s, episode: item.index, plexItem: item }) },
        { label: 'All of Season ' + s, action: go({ season: s, episode: 0 }) },
        { label: 'The whole show', action: go({ season: 0, episode: 0 }) },
      ] }], { focus: 0 });
      return;
    }
    if (item.type === 'season') {
      pickEpisode(ctx, item, reason, item, resolved);
      return;
    }
    ctx.plex.children(item.ratingKey).then(function (seasons) {
      var rows = [{ label: 'The whole show', action: go({ season: 0, episode: 0 }) }];
      seasons.filter(function (x) { return x.index > 0; }).forEach(function (season) {
        rows.push({
          label: season.title || ('Season ' + season.index),
          sub: season.leafCount ? season.leafCount + ' episodes' : '',
          action: function () { pickEpisode(ctx, item, reason, season, resolved); },
        });
      });
      ctx.sheet([{ heading: 'Which episodes?', rows: rows }], { focus: 0 });
    }, function (err) { ctx.toast(err.message || 'Couldn\'t load the seasons', 5000); });
  }

  // Entry point: the details pill and the hold-OK menu.
  O.report = function (item, ctx) {
    if (!O.canReport(ctx)) {
      ctx.toast('Your Overseerr account can\'t report problems yet');
      return;
    }
    var resolved = resolveMedia(ctx, item);
    // a title Overseerr can't match fails here, before the viewer has picked anything
    resolved.then(null, function (err) { ctx.toast(err.message || 'Couldn\'t find this on Overseerr', 5000); });
    var isTv = item.type !== 'movie';
    var heading = 'Report a problem' + (item.title ? ' · ' + (item.type === 'episode' ? (item.grandparentTitle || item.title) : item.title) : '');
    ctx.sheet([{
      heading: heading,
      rows: O.REASONS.map(function (reason) {
        return {
          label: isTv ? (reason.tvLabel || reason.label) : reason.label,
          action: function () {
            if (isTv) pickScope(ctx, item, reason, resolved);
            else next(ctx, item, reason, { season: 0, episode: 0, plexItem: item }, resolved);
          },
        };
      }),
    }], { focus: 0 });
  };

  O.message = message; // for tests
})();
