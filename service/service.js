// Plex Lite core service. Runs on the TV's Node (v0.12 on webOS 4.5: ES5 only).
// WAM only lets the web app read its own folder, so this service finds installed external plugins
// (apps whose appinfo.json has a "plexlitePlugin" block) and reads their entry code for the plugin
// host (js/plugin-host.js), which runs it in a sandboxed frame. Developer services run jailed (they
// only see their own folder), so on rooted TVs the app elevates this service once per install with
// Homebrew Channel's elevate-service; `whoami` reports whether that has happened (`info` is a built-in webos-service method).
// Read-only by design: fixed paths, no arguments reach a shell.
'use strict';

var Service = require('webos-service');
var loader = require('./plugin-loader');

var APPS_ROOT = '/media/developer/apps/usr/palm/applications';
var service = new Service('com.bednal.plexlite.service');

function fail(msg, err) {
  msg.respond({ returnValue: false, errorText: String((err && err.message) || err) });
}

service.register('listPlugins', function (msg) {
  try {
    msg.respond({ returnValue: true, plugins: loader.listPlugins(APPS_ROOT) });
  } catch (e) { fail(msg, e); }
});

service.register('whoami', function (msg) {
  msg.respond({ returnValue: true, uid: typeof process.getuid === 'function' ? process.getuid() : -1, node: process.version });
});

service.register('readPlugin', function (msg) {
  try {
    var r = loader.readPlugin(APPS_ROOT, msg.payload && msg.payload.id);
    msg.respond({ returnValue: true, appinfo: r.appinfo, source: r.source, sha256: r.sha256 });
  } catch (e) { fail(msg, e); }
});
