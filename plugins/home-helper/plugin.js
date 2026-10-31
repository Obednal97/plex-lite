// Home server helper: the shared setting (Settings → Plugins → Home server helper) for the helper on
// the home server, with its status from /healthz. The calls themselves live in helper.js
// (PL.homeHelper), which What's coming, Subtitles and Overseerr's Downloading use.
'use strict';

(function () {
  var H = PL.homeHelper;
  var STARTUP_CHECK_MS = 5000;

  function host(url) { return String(url || '').replace(/^https?:\/\//, ''); }

  function refresh(ctx) { if (ctx.refreshSettings) ctx.refreshSettings(); }

  // 'unset' | 'blocked' | 'ok' | 'down' | 'unknown' (not checked yet)
  function state() {
    var url = H.address();
    if (!url) return 'unset';
    if (H.blocked(url)) return 'blocked';
    var h = H.lastHealth();
    if (h) return 'ok';
    return H.checked() ? 'down' : 'unknown';
  }

  function value() {
    var s = state();
    if (s === 'unset') return 'Not set up';
    if (s === 'blocked') return 'Not available in this browser';
    if (s === 'ok') return 'Connected · ' + H.servicesLine(H.lastHealth());
    if (s === 'down') return 'Can\'t reach the helper';
    return host(H.address());
  }

  function check(ctx, then) {
    H.busy('Checking the helper…');
    H.health(0).then(function (h) {
      PL.toast(h ? 'Connected · ' + H.servicesLine(h) : 'Can\'t reach the helper at ' + host(H.address()), h ? 3500 : 5000);
      refresh(ctx);
      if (then) then(h);
    });
  }

  function editAddress(ctx) {
    ctx.textEntry('Home server helper address', H.address() || '', 'e.g. homeserver.local:8787 · empty removes it', function (raw) {
      if (!String(raw || '').trim()) {
        H.setUrl(null);
        ctx.toast('Home server helper removed');
        refresh(ctx);
        return true;
      }
      var url;
      try { url = H.normalizeUrl(raw); } catch (e) { ctx.toast(e.message); return false; }
      H.setUrl(url);
      if (H.blocked(url)) {
        ctx.toast('Saved · this browser can\'t reach an http address from here; the TV app can', 5000);
        refresh(ctx);
      } else {
        check(ctx);
      }
      return true;
    });
  }

  function openSheet(ctx) {
    var url = H.address();
    var rows = [];
    var s = state();
    if (s === 'unset') {
      rows.push({ label: 'Set up the helper', sub: 'Its address on your home network', action: function () { editAddress(ctx); } });
    } else {
      if (s === 'blocked') {
        rows.push({ label: 'Not available in this browser', sub: 'Browsers block http addresses on https pages · the TV app can use it', action: function () {} });
      } else if (s === 'ok') {
        var h = H.lastHealth();
        rows.push({ label: 'Connected', sub: H.servicesLine(h), action: function () { check(ctx); } });
        if (h.dryRun) rows.push({ label: 'Dry run: nothing is changed yet', action: function () {} });
        if (h.paused) rows.push({ label: 'Paused', sub: 'Problem reports wait', action: function () {} });
      } else {
        rows.push({ label: 'Can\'t reach the helper', sub: 'OK to try again', action: function () { check(ctx, function () { openSheet(ctx); }); } });
      }
      rows.push({ label: 'Change address', action: function () { editAddress(ctx); } });
      rows.push({
        label: 'Remove the helper',
        action: function () {
          H.setUrl(null);
          ctx.toast('Home server helper removed');
          refresh(ctx);
        },
      });
    }
    ctx.sheet([{ heading: url ? 'Home server helper · ' + host(url) : 'Home server helper', rows: rows }]);
  }

  PL.plugins.register({
    id: H.PLUGIN_ID,
    name: 'Home server helper',
    version: '1.0.0',
    apiVersion: 1,
    description: 'Connects Plex Lite to the helper on your home server, for What\'s coming, Subtitles and downloads.',
    settingsRows: function (ctx) {
      return [{
        label: 'Home server helper',
        value: value(),
        action: function () {
          // a fresh status first (a few seconds at most), then the sheet
          if (state() === 'unset' || state() === 'blocked') { openSheet(ctx); return; }
          check(ctx, function () { openSheet(ctx); });
        },
      }];
    },
  });

  // One /healthz shortly after start, so the plugins built on it know what to offer on the first
  // details page (their actions must answer at once).
  setTimeout(function () { if (H.url()) H.health(); }, STARTUP_CHECK_MS);
})();
