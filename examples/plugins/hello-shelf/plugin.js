// Example external plugin. Same register()/hook shape as a bundled Phase 1 plugin; every ctx call
// returns a Promise because it crosses into the host.
'use strict';

PlexLitePlugin.register({
  id: 'com.example.plexlite.hello',
  name: 'Hello Shelf',
  version: '1.0.0',
  apiVersion: 1,

  shelfRows: function (section, ctx) {
    if (!section || !section.key) return [];
    return ctx.plex.get('/library/sections/' + section.key + '/all', { sort: 'random', 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 8 })
      .then(function (mc) {
        var items = (mc.Metadata || []).map(function (m) {
          return {
            key: m.ratingKey,
            ratingKey: m.ratingKey,
            title: m.title,
            subtitle: m.year ? String(m.year) : '',
            image: m.thumb ? { plex: m.thumb } : null,
          };
        });
        return [{ title: 'Hello from a plugin', kind: 'poster', items: items }];
      });
  },

  actions: function (item, ctx) {
    return [{
      label: 'Say hello',
      icon: 'check',
      run: function () {
        return ctx.storage.get('greetings').then(function (n) {
          n = (n || 0) + 1;
          return ctx.storage.set('greetings', n).then(function () {
            return ctx.toast('Hello, ' + (item.title || 'there') + ' (#' + n + ')');
          });
        });
      },
    }];
  },

  // A whole tab: a declarative model Plex Lite renders with its own components.
  tabs: [{ id: 'hello', title: 'Hello' }],

  screen: function (tabId, ctx) {
    return ctx.plex.get('/library/sections', {}).then(function (mc) {
      var sections = (mc.Directory || []).slice(0, 2);
      return Promise.all(sections.map(function (sec) {
        return ctx.plex.get('/library/sections/' + sec.key + '/all', { sort: 'addedAt:desc', 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 12 })
          .then(function (all) {
            return {
              title: 'Newest in ' + sec.title,
              kind: 'poster',
              items: (all.Metadata || []).map(function (m) {
                return {
                  key: m.ratingKey,
                  title: m.title,
                  subtitle: m.year ? String(m.year) : '',
                  image: m.thumb ? { plex: m.thumb } : null,
                  // OK opens a plugin page (another model) instead of Plex details
                  onSelect: function () {
                    return {
                      type: 'page',
                      eyebrow: 'Hello Shelf',
                      title: m.title,
                      subtitle: [m.year, sec.title].filter(Boolean).join(' · '),
                      summary: m.summary || 'No summary.',
                      art: m.art ? { plex: m.art } : null,
                      actions: [{ label: 'Say hello', icon: 'check', run: function () { return ctx.toast('Hello, ' + m.title); } }],
                    };
                  },
                };
              }),
            };
          });
      })).then(function (shelves) {
        return { type: 'shelves', title: 'Hello', shelves: shelves };
      });
    });
  },

  settingsRows: function (ctx) {
    return [{ label: 'Hello Shelf', value: 'v1.0.0', action: function () { return ctx.toast('Hello Shelf is working'); } }];
  },
});
