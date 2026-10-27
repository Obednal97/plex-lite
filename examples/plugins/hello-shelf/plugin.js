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

  settingsRows: function (ctx) {
    return [{ label: 'Hello Shelf', value: 'v1.0.0', action: function () { return ctx.toast('Hello Shelf is working'); } }];
  },
});
