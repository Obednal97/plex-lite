// Overseerr plugin, phones and tablets (the web build's touch layer, web/touch/; loaded only by
// tools/build-web.mjs, after seerr-web.js). The Overseerr page, Your requests and Downloading as
// touch pages, from the same data as the TV screens (O.pageModel, O.requestsSpec, O.downloadsSpec).
// The touch layer loads after the plugins, so PL.touch is only looked at when a page opens.
// Chrome 53-safe like the rest of plugins/ (tools/check.mjs), though only browsers run it.
'use strict';

(function () {
  var O = PL.overseerr;
  if (!O || !PL.isWeb) return;

  function T() { return PL.touch; }

  // A page with a Back chevron whose title shows once the heading has scrolled away.
  function basePage(cls, title) {
    var ui = T().ui;
    var h = ui.h;
    var page = T().page('ost-page' + (cls ? '.' + cls : ''));
    var bar = ui.backBar({ title: title });
    page.el.appendChild(bar);
    var head = h('header.ost-head', null, [h('h1.ost-title', { text: title }), h('p.ost-line')]);
    page.el.appendChild(head);
    var body = h('div.ost-body');
    page.el.appendChild(body);
    var onScroll = function () { bar.classList.toggle('t-solid', window.scrollY > 44); };
    return { page: page, head: head, line: head.lastChild, body: body, bar: bar, onScroll: onScroll };
  }

  function listen(p, extraShow, extraHide) {
    p.page.onShow = function (o) {
      window.addEventListener('scroll', p.onScroll, { passive: true });
      p.onScroll();
      if (extraShow) extraShow(o || {});
    };
    p.page.onHide = function () {
      window.removeEventListener('scroll', p.onScroll);
      if (extraHide) extraHide();
    };
  }

  // A settings-style row (web/touch/screens/settings.js): label, sub, value, a switch or a chevron.
  function row(d) {
    var ui = T().ui;
    var h = ui.h;
    var n = h('button.t-sheet-row.ost-row' + (d.danger ? '.t-danger' : '') + (d.tone ? '.ts-' + d.tone : ''), { type: 'button' });
    var text = h('span.t-sheet-text', null, h('span.t-sheet-label', { text: d.label }));
    if (d.sub) text.appendChild(h('span.t-sheet-rowsub', { text: d.sub }));
    n.appendChild(text);
    if (d.toggle != null) {
      n.setAttribute('role', 'switch');
      n.setAttribute('aria-checked', String(!!d.toggle));
      n.appendChild(h('span.ts-switch' + (d.toggle ? '.on' : ''), null, h('span.ts-knob')));
    } else {
      if (d.value) n.appendChild(h('span.t-sheet-value', { text: d.value }));
      if (d.next) n.appendChild(ui.icon('chevron', 't-sheet-next'));
    }
    n.addEventListener('click', function () { d.action(); });
    return n;
  }

  // ---- The Overseerr page ------------------------------------------------------------------------

  function overseerrPage(ctx) {
    var h = T().ui.h;
    var p = basePage('ost-main', 'Overseerr');
    var alive = true;
    function build() {
      if (!alive) return;
      var m = O.pageModel(ctx);
      p.line.textContent = [m.host, m.intro].filter(Boolean).join(' · ');
      var parts = [];
      m.groups.forEach(function (g) {
        if (!g.rows.length) return;
        if (g.heading) parts.push(h('div.t-sheet-heading', { text: g.heading }));
        var list = h('div.t-sheet-list.ost-list');
        g.rows.forEach(function (d) { list.appendChild(row(d)); });
        parts.push(list);
      });
      while (p.body.firstChild) p.body.removeChild(p.body.firstChild);
      parts.forEach(function (n) { p.body.appendChild(n); });
    }
    var off = O.onChange(build);
    listen(p, function () {
      build();
      O.warmPage(ctx, function () { if (alive) build(); });
    });
    p.page.destroy = function () { alive = false; off(); };
    build();
    return p.page;
  }

  // ---- Lists: Your requests, Downloading -------------------------------------------------------------

  // spec: as O.listScreen's (downloads.js)
  function listPage(ctx, spec, cls) {
    var ui = T().ui;
    var h = ui.h;
    var p = basePage(cls, spec.title);
    var list = h('div.ost-items');
    var status = h('div.ost-status', null, ui.spinner());
    p.body.appendChild(status);
    p.body.appendChild(list);
    var alive = true;
    var shown = false;
    var timer = 0;
    var refreshMs = spec.refreshMs || 10000;
    var rows = {};

    function make(e) {
      var n = h('button.ost-item', { type: 'button' });
      var poster = h('span.ost-poster');
      poster.appendChild(ui.img(e.poster ? ui.imageUrl(e.poster, 48, 72) : null));
      n.appendChild(poster);
      var text = h('span.ost-text');
      var title = h('span.ost-item-title');
      var sub = h('span.ost-item-sub');
      text.appendChild(title);
      text.appendChild(sub);
      n.appendChild(text);
      var side = h('span.ost-side');
      var state = h('span.ost-state');
      var size = h('span.ost-size');
      side.appendChild(state);
      side.appendChild(size);
      n.appendChild(side);
      var rail = ui.progress(0);
      rail.classList.add('ost-rail');
      n.appendChild(rail);
      var r = { node: n, title: title, sub: sub, state: state, size: size, rail: rail, entry: e };
      n.addEventListener('click', function () { spec.open(r.entry); });
      return r;
    }

    function update(r, e) {
      var f = spec.fill(e);
      r.entry = e;
      r.title.textContent = f.title;
      r.sub.textContent = f.sub || '';
      r.state.textContent = f.state || '';
      r.state.className = 'ost-state ost-tone-' + (f.tone || 'plain');
      r.size.textContent = f.size || '';
      r.rail.hidden = f.progress == null;
      if (f.progress != null) r.rail.firstChild.style.width = Math.round(f.progress * 1000) / 10 + '%';
    }

    function render(res) {
      if (!alive) return;
      p.line.textContent = res.meta || '';
      while (status.firstChild) status.removeChild(status.firstChild);
      status.hidden = !!res.entries.length;
      if (!res.entries.length) {
        status.appendChild(h('p.ost-empty-title', { text: spec.empty[0] }));
        if (spec.empty[1]) status.appendChild(h('p.ost-empty-sub', { text: spec.empty[1] }));
      }
      var next = {};
      res.entries.forEach(function (e, i) {
        var r = rows[e.id] || make(e);
        next[e.id] = r;
        update(r, e);
        if (list.children[i] !== r.node) list.insertBefore(r.node, list.children[i] || null);
      });
      Object.keys(rows).forEach(function (id) { if (!next[id]) list.removeChild(rows[id].node); });
      rows = next;
    }

    function load(maxAge) {
      return spec.load(maxAge).then(render, function (err) {
        if (!alive) return;
        if (!Object.keys(rows).length) {
          while (status.firstChild) status.removeChild(status.firstChild);
          status.hidden = false;
          status.appendChild(h('p.ost-empty-title', { text: spec.failed }));
          if (err && err.message) status.appendChild(h('p.ost-empty-sub', { text: err.message }));
        }
      });
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (!alive || !shown) return;
        load(refreshMs - 2000).then(schedule, schedule);
      }, refreshMs);
    }

    listen(p, function () {
      shown = true;
      var first = !Object.keys(rows).length;
      load(first ? 60000 : refreshMs - 2000).then(function () {
        if (first && alive && shown) load(refreshMs - 2000).then(schedule, schedule);
        else schedule();
      }, schedule);
    }, function () { shown = false; clearTimeout(timer); });
    p.page.destroy = function () { alive = false; clearTimeout(timer); };
    return p.page;
  }

  O.touchUi = {
    // the touch layer is showing (not the TV stage, and not a stage screen over it)
    active: function () { var t = T(); return !!(t && t.visible && t.ui && t.push); },
    page: function (ctx) { T().push(overseerrPage(ctx)); },
    requests: function (ctx) { T().push(listPage(ctx, O.requestsSpec(ctx), 'ost-requests')); },
    downloads: function (ctx, focusId) { T().push(listPage(ctx, O.downloadsSpec(ctx, { focusId: focusId }), 'ost-downloads')); },
  };
})();
