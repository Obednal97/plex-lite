// Plugin screens: a plugin tab (or a screen a plugin opens) is a declarative model that Plex Lite
// renders with its own components, so plugins never draw visible UI and the look and performance
// stay consistent. Models:
//   {type: 'shelves', title?, shelves: [{title, kind: 'poster'|'wide', items}]}
//   {type: 'grid', title, items}
//   {type: 'page', title, eyebrow?, subtitle?, summary?, art?, actions: [{label, icon?, run()}], shelves?}
// Items: {title, subtitle?|year?, thumb? (Plex path or URL), ratingKey? (a Plex item: OK opens its
// details), onSelect?() -> optional model or Promise<model> (pushed as a new plugin screen)}.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;
  var K = PL.KEY;
  var TYPES = { shelves: 1, grid: 1, page: 1 };

  function isModel(m) { return !!m && typeof m === 'object' && TYPES[m.type] === 1; }

  function selectItem(item) {
    if (item && typeof item.onSelect === 'function') {
      Promise.resolve(item.onSelect()).then(function (next) {
        if (isModel(next)) PL.app.push(screens.pluginScreen(next, { title: next.title }));
      }, function (err) { PL.toast(PL.errorMessage(err)); });
      return;
    }
    if (item && /^\d+$/.test(String(item.ratingKey || ''))) PL.app.push(screens.details(item));
  }

  function shelfFrom(s, shadow, left) {
    return new ui.Shelf({
      title: s.title,
      items: s.items || [],
      kind: s.kind === 'wide' ? 'wide' : 'poster',
      shadow: shadow,
      left: left,
      onSelect: selectItem,
      onLongPress: function () { return false; },
    });
  }

  // source: a model, or {plugin, tab} for a tab (the model is loaded). opts: {root, title}
  screens.pluginScreen = function (source, opts) {
    opts = opts || {};
    var el = PL.el('div', 'plugin-screen');
    var shadow = new ui.FocusShadow();
    var status = PL.el('div', 'loading');
    status.appendChild(ui.spinner());
    el.appendChild(status);
    var title = PL.el('div', 'page-title fade', opts.title || '');
    if (!opts.root) el.appendChild(title);
    var top = opts.root ? 160 : 240;
    var zoneHost = PL.el('div', 'plugin-zones');
    el.appendChild(zoneHost);
    var stack = null;
    var grid = null;
    var buttons = null;
    var visible = false;
    var alive = true;
    var area = 'content';

    function fail(text) {
      PL.clear(status);
      status.style.display = '';
      status.appendChild(PL.el('div', '', text));
    }

    function render(model) {
      if (!alive) return;
      if (!isModel(model)) { fail('This plugin has nothing to show'); return; }
      status.style.display = 'none';
      if (model.title && !opts.root) title.textContent = model.title;
      if (model.type === 'grid') {
        var items = (model.items || []).slice(0, 500);
        grid = new ui.Grid({
          columns: 7, shadow: shadow, anchor: 90,
          fetchPage: function (start, size) { return Promise.resolve({ total: items.length, items: items.slice(start, start + size) }); },
          onSelect: selectItem,
          onLongPress: function () { return false; },
        });
        grid.el.style.top = top + 'px';
        zoneHost.appendChild(grid.el);
        grid.reset(items.length);
        if (visible) grid.setFocused(true);
        return;
      }
      stack = new ui.VStack(zoneHost, {
        top: top, keep: 2,
        anchor: function (i, zoneTop, zone) { return Math.min(zoneTop, 1040 - zone.height); },
      });
      var zones = [];
      if (model.type === 'page') {
        var head = { skip: true, el: PL.el('div', 'details-text'), height: null, setFocused: function () {}, key: function () { return false; } };
        head.el.style.cssText = 'position:absolute;left:96px;width:900px;padding-bottom:24px';
        if (model.eyebrow) head.el.appendChild(PL.el('div', 'hero-eyebrow', String(model.eyebrow)));
        head.el.appendChild(PL.el('div', 'hero-title' + (String(model.title || '').length > 26 ? ' long' : ''), String(model.title || '')));
        if (model.subtitle) head.el.appendChild(PL.el('div', 'hero-meta', String(model.subtitle)));
        if (model.summary) head.el.appendChild(PL.el('div', 'hero-summary', String(model.summary)));
        zones.push(head);
        var acts = (model.actions || []).filter(function (a) { return a && a.label && a.run; }).slice(0, 5);
        if (acts.length) {
          buttons = new ui.ButtonRow(acts.map(function (a, i) {
            return {
              kind: i === 0 ? 'primary' : 'secondary', icon: a.icon, label: a.label,
              action: function () {
                Promise.resolve(a.run()).then(function (next) {
                  if (isModel(next)) PL.app.push(screens.pluginScreen(next, { title: next.title }));
                }, function (err) { PL.toast(PL.errorMessage(err)); });
              },
            };
          }));
          zones.push({ el: buttons.el, height: 132, setFocused: function (on) { buttons.setFocused(on); }, key: function (c) { return buttons.key(c); } });
        }
        if (model.art) PL.app.backdrop.set(PL.plex.image(model.art, 1920, 1080, { quality: 70 }), 'detail');
      }
      (model.shelves || []).slice(0, 8).forEach(function (s) {
        if (s && s.items && s.items.length) zones.push(shelfFrom(s, shadow));
      });
      if (!zones.some(function (z) { return !z.skip; })) {
        if (!zones.length) fail('This plugin has nothing to show');
        stack.setZones(zones, 0);
        return;
      }
      stack.setZones(zones, 0);
      if (visible) stack.focus(true);
    }

    var load = isModel(source) ? Promise.resolve(source)
      : PL.plugins && PL.plugins.screen ? PL.plugins.screen(source.plugin, source.tab) : Promise.resolve(null);
    load.then(render, function () { fail('This plugin could not load its screen'); });

    function focusContent(on) {
      if (grid) grid.setFocused(on);
      if (stack && stack.zones.length) stack.focus(on);
      if (!on) shadow.hide();
    }

    return {
      root: !!opts.root,
      el: el,
      longPress: false,
      show: function () {
        visible = true;
        if (!stack || !stack.zones.some(function (z) { return z.el && z.el.className === 'details-text'; })) PL.app.backdrop.set(null, 'ambient');
        if (!PL.app.tabsFocused) focusContent(area === 'content');
      },
      hide: function () { visible = false; focusContent(false); },
      destroy: function () { alive = false; },
      focusFromTabs: function () { area = 'content'; focusContent(true); },
      onTabsFocus: function () { focusContent(false); },
      key: function (code) {
        var handled = grid ? grid.key(code) : stack && stack.zones.length ? stack.key(code) : false;
        if (!handled && code === K.UP && opts.root) {
          focusContent(false);
          return PL.app.focusTabs();
        }
        return handled;
      },
    };
  };
})();
