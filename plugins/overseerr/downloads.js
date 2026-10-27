// Overseerr plugin: what is downloading. A "Downloading" screen (one row per title, live while it is
// open), a Downloading shelf on each library's Recommended view, and a badge on details pages.
// Data comes from PL.overseerr.downloads(): the home server's queue helper when one is set up,
// otherwise Overseerr's own download status (synced from Sonarr/Radarr every minute).
'use strict';

(function () {
  var O = PL.overseerr;
  var REFRESH_MS = 10000;
  var ROW_PITCH = 136;
  var LIST_TOP = 236;
  var VIEW_H = 1080 - LIST_TOP - 54;

  function el(tag, cls, text) { return PL.el(tag, cls, text); }

  function subtitle(e) {
    if (e.mediaType === 'movie') return [e.year, 'Film'].filter(Boolean).join(' · ');
    var eps = O.episodeLabel(e.episodes);
    var n = e.episodes.length;
    return [eps, n > 1 ? n + ' episodes' : (n === 1 && e.episodes[0].title ? e.episodes[0].title : '')].filter(Boolean).join(' · ') || 'Series';
  }

  function sizeLine(e) {
    if (!(e.size > 0)) return '';
    return O.fmtSize(e.size - e.sizeLeft) + ' of ' + O.fmtSize(e.size);
  }

  // ---- The Downloading screen ---------------------------------------------------------------------

  // opts: {focusId}
  O.downloadsScreen = function (ctx, opts) {
    opts = opts || {};
    var root = el('div', 'osdl-screen');
    root.appendChild(el('div', 'osdl-title', 'Downloading'));
    var meta = el('div', 'osdl-meta', '');
    root.appendChild(meta);
    var status = el('div', 'loading');
    status.appendChild(ctx.ui.spinner());
    root.appendChild(status);
    var view = el('div', 'osdl-view');
    var list = el('div', 'osdl-list');
    view.appendChild(list);
    root.appendChild(view);
    var rows = [];
    var index = 0;
    var focusId = opts.focusId || null;
    var visible = false;
    var alive = true;
    var timer = null;

    function setStatus(title, sub) {
      PL.clear(status);
      status.style.display = '';
      status.appendChild(el('div', 'osdl-empty-title', title));
      if (sub) status.appendChild(el('div', 'osdl-empty-sub', sub));
    }

    function makeRow(e) {
      var n = el('div', 'osdl-row');
      var poster = el('div', 'osdl-poster');
      if (e.poster) {
        var img = PL.el('img', 'osdl-img');
        img.width = 72;
        img.height = 108;
        img.onerror = function () { img.style.visibility = 'hidden'; };
        ctx.ui.fadeInImage(img, ctx.plex.image(e.poster, 72, 108) || e.poster);
        poster.appendChild(img);
      }
      n.appendChild(poster);
      var title = el('div', 'osdl-row-title', e.title);
      var sub = el('div', 'osdl-row-sub', '');
      var state = el('div', 'osdl-state', '');
      var size = el('div', 'osdl-size', '');
      var rail = el('div', 'osdl-rail');
      var fill = el('div', 'osdl-fill');
      rail.appendChild(fill);
      [title, sub, state, size, rail].forEach(function (x) { n.appendChild(x); });
      var r = { node: n, entry: e, title: title, sub: sub, state: state, size: size, fill: fill };
      n.addEventListener('click', function () { index = rows.indexOf(r); paint(); open(r.entry); });
      update(r, e);
      return r;
    }

    function update(r, e) {
      r.entry = e;
      r.title.textContent = e.title;
      r.sub.textContent = subtitle(e);
      r.state.textContent = O.progressLine(e);
      r.state.className = 'osdl-state tone-' + e.state;
      r.size.textContent = sizeLine(e);
      r.fill.style.transform = 'scaleX(' + e.progress.toFixed(3) + ')';
    }

    function paint() {
      rows.forEach(function (r, i) { r.node.classList.toggle('focused', visible && i === index); });
      var total = rows.length * ROW_PITCH;
      var shift = Math.max(0, Math.min(index * ROW_PITCH - (VIEW_H - ROW_PITCH) / 2, total - VIEW_H));
      PL.translate(list, 0, -Math.max(0, shift));
      var cur = rows[index];
      focusId = cur ? cur.entry.id : focusId;
    }

    function render(res) {
      if (!alive) return;
      var entries = res.list;
      var when = new Date(res.at);
      meta.textContent = (entries.length ? entries.length + (entries.length === 1 ? ' title' : ' titles') + ' · ' : '') +
        (res.source === 'helper' ? 'from the download queue' : 'from Overseerr') + ' · updated ' +
        ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2);
      if (!entries.length) {
        PL.clear(list);
        rows = [];
        setStatus('Nothing is downloading', 'Requests and replacements show up here while they download.');
        return;
      }
      status.style.display = 'none';
      var same = entries.length === rows.length && entries.every(function (e, i) { return rows[i].entry.id === e.id; });
      if (same) {
        entries.forEach(function (e, i) { update(rows[i], e); });
        return;
      }
      // the set changed: rebuild, keeping focus on the same title when it is still there
      PL.clear(list);
      rows = entries.map(function (e, i) {
        var r = makeRow(e);
        r.node.style.top = (i * ROW_PITCH) + 'px';
        list.appendChild(r.node);
        return r;
      });
      var keep = -1;
      rows.forEach(function (r, i) { if (r.entry.id === focusId) keep = i; });
      index = keep >= 0 ? keep : Math.min(index, rows.length - 1);
      paint();
    }

    function load(fresh) {
      return O.downloads(ctx, fresh ? 0 : 8000).then(render, function (err) {
        if (!alive) return;
        if (!rows.length) setStatus('Couldn\'t load downloads', err && err.message);
        else ctx.warn('downloads refresh failed: ' + (err && err.message));
      });
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (!alive || !visible) return;
        load(false).then(schedule, schedule);
      }, REFRESH_MS);
    }

    function open(e) {
      if (e.ratingKey && /^\d+$/.test(e.ratingKey)) {
        ctx.openItem({ ratingKey: e.ratingKey, type: e.mediaType === 'tv' ? 'show' : 'movie', title: e.title });
        return;
      }
      var rows2 = e.releases.map(function (t) { return { label: t, action: function () {} }; });
      if (!rows2.length) rows2.push({ label: O.progressLine(e), action: function () {} });
      ctx.sheet([{ heading: e.title + ' · not in your library yet', rows: rows2 }]);
    }

    return {
      el: root,
      show: function () {
        visible = true;
        ctx.backdrop(null);
        paint();
        load(!rows.length).then(schedule, schedule);
      },
      hide: function () { visible = false; clearTimeout(timer); paint(); },
      destroy: function () { alive = false; clearTimeout(timer); },
      key: function (code) {
        var K = ctx.ui.KEY;
        if (code === K.UP || code === K.DOWN) {
          if (!rows.length) return true;
          index = PL.clamp(index + (code === K.DOWN ? 1 : -1), 0, rows.length - 1);
          paint();
          return true;
        }
        if (code === K.ENTER) {
          if (rows[index]) open(rows[index].entry);
          return true;
        }
        return false;
      },
    };
  };

  O.openDownloads = function (ctx, focusId) {
    ctx.push(O.downloadsScreen(ctx, { focusId: focusId }));
  };

  // ---- Shelf on Recommended -------------------------------------------------------------------------

  // Movies in movie libraries, shows in TV libraries; null when nothing is downloading.
  O.shelf = function (section, ctx) {
    if (!O.ready(ctx)) return null;
    var type = section && section.type === 'show' ? 'tv' : section && section.type === 'movie' ? 'movie' : null;
    if (!type) return null;
    O.refreshUser(ctx);
    return O.downloads(ctx).then(function (res) {
      var items = res.list.filter(function (e) { return e.mediaType === type; }).slice(0, 20).map(function (e) {
        var sub = subtitle(e);
        return {
          ratingKey: 'osdl-' + e.id,
          type: 'download',
          title: e.title,
          year: e.year,
          thumb: e.poster,
          art: e.backdrop,
          summary: (e.mediaType === 'tv' && sub ? sub + ' — ' : '') + O.STATE_LABEL[e.state] + (e.state === 'downloading' ? ', ' + O.progressLine(e) : ''),
          download: e,
        };
      });
      if (!items.length) return null;
      return {
        id: 'downloading',
        title: 'Downloading',
        kind: 'poster',
        items: items,
        makeCard: function (item, kind, geo) {
          var node = ctx.ui.makeCard(item, kind, geo);
          var inner = node.querySelector('.card-inner');
          var e = item.download;
          if (inner) {
            var bar = el('div', 'card-progress');
            var fill = el('div', 'card-progress-fill');
            fill.style.transform = 'scaleX(' + e.progress.toFixed(3) + ')';
            bar.appendChild(fill);
            inner.appendChild(bar);
          }
          var label = e.state === 'downloading' ? O.pct(e.progress) : O.STATE_LABEL[e.state];
          return ctx.ui.badge(node, 'os-badge os-dl tone-' + e.state, label);
        },
        onSelect: function (item) { O.openDownloads(ctx, item.download.id); },
      };
    });
  };

  // ---- Details badge ----------------------------------------------------------------------------------

  function badgeText(e, ep) {
    var st = ep ? ep.state : e.state;
    var p = ep ? ep.progress : e.progress;
    if (st === 'downloading') return 'Downloading ' + O.pct(p);
    if (st === 'importing') return 'Almost ready';
    if (st === 'stalled') return 'Download stalled';
    return O.STATE_LABEL[st];
  }

  // The Plex title a details item belongs to, enough to match a download (Guids when available).
  function titleKey(ctx, item, needGuids) {
    var t = item.type;
    if (t === 'movie' || t === 'show') {
      var g = {};
      (item.Guid || []).forEach(function (x) { var m = /^(\w+):\/\/(.+)$/.exec(String(x.id || '')); if (m) g[m[1]] = m[2]; });
      return Promise.resolve({ type: t === 'show' ? 'tv' : 'movie', ratingKey: String(item.ratingKey), tmdb: g.tmdb, tvdb: g.tvdb });
    }
    var showKey = t === 'episode' ? item.grandparentRatingKey : item.parentRatingKey;
    if (!showKey) return Promise.resolve(null);
    if (!needGuids) return Promise.resolve({ type: 'tv', ratingKey: String(showKey) });
    return O.plexTitle(ctx, item).then(null, function () { return null; });
  }

  O.badges = function (item, ctx) {
    if (!O.ready(ctx) || ['movie', 'show', 'season', 'episode'].indexOf(item.type) === -1) return null;
    O.refreshUser(ctx);
    return O.downloads(ctx).then(function (res) {
      var type = item.type === 'movie' ? 'movie' : 'tv';
      var candidates = res.list.filter(function (e) { return e.mediaType === type; });
      if (!candidates.length) return [];
      // helper rows carry no Plex ratingKey, so episodes and seasons need the show's Guids then
      var needGuids = candidates.some(function (e) { return !e.ratingKey; });
      return titleKey(ctx, item, needGuids).then(function (pt) {
        var e = pt && O.matchDownload(candidates, pt);
        if (!e) return [];
        if (item.type === 'movie' || item.type === 'show') {
          var text = badgeText(e);
          if (item.type === 'show' && e.episodes.length) text += ' · ' + O.episodeLabel(e.episodes);
          return [{ label: text, tone: 'accent' }];
        }
        var eps = e.episodes.filter(function (x) {
          return item.type === 'season' ? x.season === item.index : x.season === item.parentIndex && x.episode === item.index;
        });
        if (!eps.length) return [];
        if (item.type === 'episode') return [{ label: badgeText(e, eps[0]), tone: 'accent' }];
        return [{ label: (eps.length === 1 ? badgeText(e, eps[0]) + ' · E' + eps[0].episode : 'Downloading ' + eps.length + ' episodes'), tone: 'accent' }];
      });
    });
  };
})();
