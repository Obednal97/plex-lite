// A person's page: their work across every library (Movies, TV Shows, ...), one shelf per library.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var ui = PL.ui;

  // person: {id, name, thumb, role?}; opts.filter: 'actor' (default) | 'director' | 'writer'
  screens.person = function (person, opts) {
    opts = opts || {};
    var filter = opts.filter || 'actor';
    var el = PL.el('div', 'person-screen');
    var shadow = new ui.FocusShadow();
    var alive = true;
    var visible = false;

    var head = { skip: true, el: PL.el('div', 'person-head'), height: 300 };
    head.el.style.width = '1920px';
    var portrait = PL.el('div', 'person-portrait');
    if (person.thumb) {
      var img = PL.el('img', 'card-img');
      img.width = 200;
      img.height = 200;
      img.onerror = function () { img.style.visibility = 'hidden'; };
      img.src = PL.plex.image(person.thumb, 200, 200);
      portrait.appendChild(img);
    }
    head.el.appendChild(portrait);
    var text = PL.el('div', 'person-text');
    text.appendChild(PL.el('div', 'hero-title', person.name || ''));
    var summary = PL.el('div', 'hero-meta', 'Loading…');
    text.appendChild(summary);
    head.el.appendChild(text);
    head.setFocused = function () {};
    head.key = function () { return false; };

    var status = PL.el('div', 'grid-empty');
    status.style.top = '420px';
    var stack = new ui.VStack(el, {
      top: 40,
      keep: 2,
      anchor: function (i, top, zone) { return Math.min(top, 1040 - zone.height); },
    });
    el.appendChild(status);

    var ambient = PL.debounce(function (item) {
      if (item && visible) PL.app.backdrop.set(ui.ambient(ui.artPath(item)), 'ambient');
    }, 400);

    // one request per video library; a person with nothing in a library gets no shelf there
    var sections = (PL.app.sections || []).filter(function (s) { return s.type === 'movie' || s.type === 'show'; });
    var params = function (s) {
      var p = { type: s.type === 'show' ? 2 : 1, sort: 'originallyAvailableAt:desc', 'X-Plex-Container-Size': 200, excludeFields: 'summary' };
      p[filter] = person.id;
      return p;
    };
    Promise.all(sections.map(function (s) {
      return PL.plex.get('/library/sections/' + s.key + '/all', params(s)).then(function (mc) {
        return { section: s, items: mc.Metadata || [] };
      }, function () { return { section: s, items: [] }; });
    })).then(function (results) {
      if (!alive) return;
      var found = results.filter(function (r) { return r.items.length; });
      // "15 movies · 1 show"
      summary.textContent = found.map(function (r) {
        var n = r.items.length;
        var noun = r.section.type === 'show' ? (n === 1 ? 'show' : 'shows') : (n === 1 ? 'movie' : 'movies');
        return n + ' ' + noun;
      }).join(' · ');
      if (!found.length) {
        status.textContent = 'Nothing with ' + (person.name || 'this person') + ' in your libraries';
        stack.setZones([head], 0);
        return;
      }
      var zones = [head].concat(found.map(function (r) {
        return new ui.Shelf({
          title: r.section.title,
          items: r.items,
          kind: 'poster',
          shadow: shadow,
          onFocusItem: ambient,
          onSelect: function (item) { PL.app.push(screens.details(item)); },
        });
      }));
      stack.setZones(zones, 1);
      stack.enter();
      if (visible) stack.focus(true);
      ambient(found[0].items[0]);
    });

    return {
      el: el,
      longPress: true,
      show: function () {
        visible = true;
        if (stack.zones.length > 1) stack.focus(true);
        var z = stack.current();
        ambient(z && z.current && z.current());
      },
      hide: function () { visible = false; ambient.cancel(); stack.focus(false); shadow.hide(); },
      destroy: function () { alive = false; ambient.cancel(); },
      key: function (code) { return stack.zones.length > 1 && stack.key(code); },
    };
  };
})();
