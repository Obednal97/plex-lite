// Overseerr plugin, TV screens: the Overseerr page (Settings → Plugins → Overseerr) and Your
// requests. The page's rows come from plugin.js (O.pageModel), so the touch page (touch.js) shows
// the same; Your requests is a list like Downloading (downloads.js O.listScreen).
'use strict';

(function () {
  var O = PL.overseerr;
  var ROW = 108;
  var HEAD = 72;
  var VIEW_H = 690;

  function el(tag, cls, text) { return PL.el(tag, cls, text); }

  // ---- The Overseerr page ------------------------------------------------------------------------

  // Settings' look: a title, a line about the account, then quiet rows in groups under headings
  // that the focus skips; the focused row is the white plate. Rows carry a sub line.
  O.pageScreen = function (ctx) {
    var root = el('div', 'osp-screen');
    var title = el('div', 'page-title osp-title', 'Overseerr');
    root.appendChild(title);
    var line = el('div', 'osp-line', '');
    root.appendChild(line);
    var box = el('div', 'panel osp-panel');
    var panel = el('div', 'panel-rows');
    box.appendChild(panel);
    root.appendChild(box);
    var rows = [];
    var stops = [];
    var height = 0;
    var index = 0;
    var focusId = null;
    var visible = false;
    var alive = true;

    function build() {
      if (!alive) return;
      var m = O.pageModel(ctx);
      line.textContent = [m.host, m.intro].filter(Boolean).join('  ·  ');
      PL.clear(panel);
      rows = [];
      stops = [];
      height = 0;
      m.groups.forEach(function (g) {
        if (!g.rows.length) return;
        if (g.heading) {
          panel.appendChild(el('div', 'settings-heading', g.heading));
          stops.push(height);
          height += HEAD;
        }
        g.rows.forEach(function (d) {
          var i = rows.length;
          var n = el('div', 'row osp-row' + (d.danger ? ' osp-danger' : '') + (d.tone ? ' osp-' + d.tone : ''));
          n.appendChild(el('div', 'osp-label', d.label));
          if (d.sub) n.appendChild(el('div', 'osp-sub', d.sub));
          if (d.value) n.appendChild(el('span', 'row-value osp-value', d.value));
          n.addEventListener('click', function () { index = i; paint(); d.action(); });
          panel.appendChild(n);
          rows.push({ node: n, def: d, top: height });
          stops.push(height);
          height += ROW;
        });
      });
      // the same row after a rebuild (a sign-in adds and removes rows above it)
      var keep = -1;
      rows.forEach(function (r, i) { if (r.def.id === focusId) keep = i; });
      index = keep >= 0 ? keep : Math.max(0, Math.min(index, rows.length - 1));
      paint();
    }

    // As Settings: the focused row's bottom edge stays within the panel, and the list stops on a
    // heading or a row, so a group's heading shows above its first row.
    function paint() {
      rows.forEach(function (r, i) { r.node.classList.toggle('focused', visible && i === index); });
      var r = rows[index];
      if (r) focusId = r.def.id;
      var need = r ? r.top + ROW - VIEW_H + ROW / 2 : 0;
      var shift = 0;
      for (var i = 0; need > 0 && i < stops.length; i++) {
        if (stops[i] >= need) { shift = stops[i]; break; }
      }
      PL.translate(panel, 0, -shift);
      box.classList.toggle('more', height - shift > VIEW_H);
    }

    var off = O.onChange(build);
    build();
    return {
      el: root,
      show: function () {
        visible = true;
        ctx.backdrop(null);
        build();
        // the Your requests and Downloads values, fetched in the background
        O.warmPage(ctx, function () { if (alive && visible) build(); });
      },
      hide: function () { visible = false; paint(); },
      destroy: function () { alive = false; off(); },
      key: function (code) {
        var K = ctx.ui.KEY;
        if (code === K.UP || code === K.DOWN) {
          if (rows.length) {
            index = PL.clamp(index + (code === K.DOWN ? 1 : -1), 0, rows.length - 1);
            paint();
          }
          return true;
        }
        if (code === K.ENTER) {
          if (rows[index]) rows[index].def.action();
          return true;
        }
        return code === K.LEFT || code === K.RIGHT;
      },
    };
  };

  // ---- Your requests -------------------------------------------------------------------------------

  function clock(at) {
    var d = new Date(at);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // "Seasons 1–2 · requested 3 days ago"
  O.requestLine = function (e) {
    return [e.what, e.when ? 'requested ' + e.when : '', e.is4k ? '4K' : ''].filter(Boolean).join(' · ');
  };

  // OK on a request: the title in Plex when it's there, else its request sheet.
  O.openRequestEntry = function (ctx, e) {
    if (e.ratingKey && /^\d+$/.test(e.ratingKey)) {
      ctx.openItem({ ratingKey: e.ratingKey, type: e.mediaType === 'tv' ? 'show' : 'movie', title: e.title });
      return;
    }
    O.openRequest({ osType: e.mediaType, tmdbId: e.tmdbId, title: e.title, year: e.year, status: e.state === 'declined' || e.state === 'failed' ? 1 : 2 }, ctx);
  };

  // What the Your requests list shows (the TV screen here, the touch page in touch.js)
  O.requestsSpec = function (ctx) {
    return {
      title: 'Your requests',
      refreshMs: 30000,
      load: function (maxAge) {
        return O.requests(ctx, maxAge).then(function (res) {
          var n = res.list.length;
          return { entries: res.list, meta: (n ? n + (n === 1 ? ' request' : ' requests') + ' · ' : '') + 'updated ' + clock(res.at) };
        });
      },
      fill: function (e) {
        return { title: e.title, sub: O.requestLine(e), state: e.label, tone: e.tone, size: '', progress: e.progress };
      },
      open: function (e) { O.openRequestEntry(ctx, e); },
      empty: ['No requests yet', 'Titles you request from Search or the Trending rows show up here.'],
      failed: 'Couldn\'t load your requests',
    };
  };

  O.requestsScreen = function (ctx) { return O.listScreen(ctx, O.requestsSpec(ctx)); };
})();
