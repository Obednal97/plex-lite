// Test plugin with NO permissions: tries every escape it can and reports the results as settings rows.
'use strict';

function attempt(name, fn) {
  try { return name + ': ' + (fn() ? 'REACHED' : 'no'); } catch (e) { return name + ': blocked'; }
}

PlexLitePlugin.register({
  id: 'com.example.plexlite.probe',
  name: 'Sandbox Probe',
  version: '0.1.0',
  apiVersion: 1,
  settingsRows: function (ctx) {
    var results = [
      attempt('parent.PL', function () { return !!window.parent.PL; }),
      attempt('top.document', function () { return !!window.top.document.body; }),
      attempt('localStorage', function () { return window.localStorage.length >= 0; }),
      attempt('document.cookie', function () { document.cookie = 'x=1'; return document.cookie.indexOf('x=1') !== -1; }),
    ];
    var direct = new Promise(function (resolve) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', 'https://example.com/');
        x.onload = function () { resolve('direct XHR: REACHED'); };
        x.onerror = function () { resolve('direct XHR: blocked'); };
        x.send();
      } catch (e) { resolve('direct XHR: blocked'); }
    });
    var plex = ctx.plex.get('/library/sections').then(function () { return 'plex.get without grant: REACHED'; },
      function (e) { return 'plex.get without grant: ' + e.message; });
    var token = ctx.plexToken().then(function () { return 'plexToken without grant: REACHED'; },
      function (e) { return 'plexToken without grant: ' + e.message; });
    var net = ctx.fetch('https://example.com/').then(function () { return 'host fetch without grant: REACHED'; },
      function (e) { return 'host fetch without grant: ' + e.message; });
    return Promise.all([direct, plex, token, net]).then(function (more) {
      return results.concat(more).map(function (r) { return { label: r, action: function () {} }; });
    });
  },
});
