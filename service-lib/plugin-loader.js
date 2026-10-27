// Reference implementation of the two service methods the plugin host needs on the TV:
// listPlugins and readPlugin. WAM only lets a web app read its own folder, so Plex Lite's JS service
// (Node 0.12 on webOS 4.5 — ES5 only) reads installed plugin packages for it. Wire these into the
// service's Luna methods; they are pure functions over a directory so they can be tested on a Mac.
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var MAX_SOURCE = 512 * 1024;
var ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Installed apps whose appinfo.json declares a "plexlitePlugin" block.
function listPlugins(appsRoot) {
  var out = [];
  var names = [];
  try { names = fs.readdirSync(appsRoot); } catch (e) { return out; }
  names.forEach(function (name) {
    if (!ID_RE.test(name)) return;
    var info = readJson(path.join(appsRoot, name, 'appinfo.json'));
    if (info && info.id === name && info.plexlitePlugin && typeof info.plexlitePlugin === 'object') out.push(name);
  });
  return out.sort();
}

// The plugin's appinfo and entry source, plus the entry's SHA-256 (for catalogue pinning).
function readPlugin(appsRoot, id) {
  if (!ID_RE.test(String(id))) throw new Error('Invalid plugin id');
  var dir = path.join(appsRoot, id);
  var info = readJson(path.join(dir, 'appinfo.json'));
  if (!info || info.id !== id || !info.plexlitePlugin) throw new Error('Not a Plex Lite plugin');
  var entry = String(info.plexlitePlugin.entry || '');
  var file = path.resolve(dir, entry);
  // the entry must stay inside the plugin's own folder
  if (!entry || entry.indexOf('..') !== -1 || file.indexOf(path.resolve(dir) + path.sep) !== 0) throw new Error('Invalid entry path');
  var stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_SOURCE) throw new Error('Entry missing or too large');
  var source = fs.readFileSync(file, 'utf8');
  return {
    appinfo: info,
    source: source,
    sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
  };
}

module.exports = { listPlugins: listPlugins, readPlugin: readPlugin, MAX_SOURCE: MAX_SOURCE };
