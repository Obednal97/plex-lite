#!/usr/bin/env node
// Chrome 53 (webOS 4.5) compatibility check for the app's JS and CSS, plus a few release checks.
// Needs acorn + acorn-walk: `npm install --prefix ~/.cache/plexlite-tools acorn acorn-walk`
// (or set PLEXLITE_TOOLS_DIR to another folder holding them, or install them in the repo).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const TOOLS_DIRS = [process.env.PLEXLITE_TOOLS_DIR, join(homedir(), '.cache/plexlite-tools'), APP].filter(Boolean);
const toolsDir = TOOLS_DIRS.find((d) => existsSync(join(d, 'node_modules/acorn')));
if (!toolsDir) {
  console.error('acorn not found: npm install --prefix ~/.cache/plexlite-tools acorn acorn-walk');
  process.exit(2);
}
const require = createRequire(join(toolsDir, 'package.json'));
const acorn = require('acorn');
const walk = require('acorn-walk');

const BAD_MEMBERS = {
  entries: 'Object.entries (Chrome 54)', values: 'Object.values (Chrome 54)', fromEntries: 'Object.fromEntries (73)',
  getOwnPropertyDescriptors: 'Object.getOwnPropertyDescriptors (54)', padStart: 'padStart (57)', padEnd: 'padEnd (57)',
  flat: 'Array.flat (69)', flatMap: 'Array.flatMap (69)', finally: 'Promise.finally (63)', trimStart: 'trimStart (66)',
  trimEnd: 'trimEnd (66)', matchAll: 'matchAll (73)', replaceAll: 'replaceAll (85)', allSettled: 'Promise.allSettled (76)',
  any: 'Promise.any (85)', append: 'ParentNode.append (54)', prepend: 'ParentNode.prepend (54)', toggleAttribute: 'toggleAttribute (69)',
  replaceWith: 'replaceWith (54)', before: 'ChildNode.before (54)', after: 'ChildNode.after (54)', at: 'Array.at (92)',
};
const STATIC_ON = { entries: 'Object', values: 'Object', fromEntries: 'Object', getOwnPropertyDescriptors: 'Object', allSettled: 'Promise', any: 'Promise' };
const BAD_GLOBALS = {
  AbortController: 'AbortController (66)', globalThis: 'globalThis (71)', ResizeObserver: 'ResizeObserver (64)',
  queueMicrotask: 'queueMicrotask (71)', structuredClone: 'structuredClone (98)', BigInt: 'BigInt (67)',
};
const BAD_CSS = [
  [/display\s*:\s*(inline-)?grid/, 'CSS grid (57)'], [/(^|[;{\s])(row-|column-)?gap\s*:/, 'flex/grid gap (84)'],
  [/position\s*:\s*sticky/, 'position: sticky (56)'], [/aspect-ratio/, 'aspect-ratio (88)'], [/(^|[;{\s])inset\s*:/, 'inset (87)'],
  [/\bclamp\(/, 'clamp() (79)'], [/\bmin\(/, 'min() (79)'], [/\bmax\(/, 'max() (79)'], [/backdrop-filter/, 'backdrop-filter (76)'],
  [/:is\(|:where\(/, ':is/:where (88)'], [/:focus-visible/, ':focus-visible (86)'], [/place-items|place-content/, 'place-* (59)'],
  [/\bfit-content\b/, 'fit-content'],
];

// web/vendor holds third-party code shipped only in the web build (hls.js, see
// THIRD-PARTY-NOTICES.md): it isn't ours to rewrite for Chrome 53, and the TV never loads it.
function files(dir, ext) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (relative(APP, p) === join('web', 'vendor')) continue;
    if (statSync(p).isDirectory()) out = out.concat(files(p, ext));
    else if (p.endsWith(ext) && !name.startsWith('dev-config')) out.push(p);
  }
  return out;
}

let problems = 0;
const report = (file, line, msg) => { problems++; console.log(`${relative(APP, file)}:${line}  ${msg}`); };

for (const file of [...files(join(APP, 'js'), '.js'), ...files(join(APP, 'plugins'), '.js'), ...files(join(APP, 'catalog'), '.js'), ...files(join(APP, 'examples'), '.js'),
  // the web build's own modules stay ES2015 too, so one set of rules covers all our code
  ...files(join(APP, 'web'), '.js')]) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2016, sourceType: 'script', locations: true });
  } catch (e) {
    report(file, e.loc ? e.loc.line : '?', `syntax not supported in ES2016: ${e.message}`);
    continue;
  }
  walk.full(ast, (node) => {
    // only calls count: `fuzzy.entries` (a property) is fine, `Object.entries(x)` is not
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const name = node.callee.property.name;
      const obj = node.callee.object;
      const isStatic = STATIC_ON[name];
      if (Object.hasOwn(BAD_MEMBERS, name) && (!isStatic || (obj.type === 'Identifier' && obj.name === isStatic))) {
        report(file, node.loc.start.line, BAD_MEMBERS[name]);
      }
    }
    if (node.type === 'Identifier' && Object.hasOwn(BAD_GLOBALS, node.name)) report(file, node.loc.start.line, BAD_GLOBALS[node.name]);
  });
  if (!/^\s*(\/\/.*\n)*\s*'use strict';/m.test(src)) report(file, 1, "missing 'use strict'");
}

// web-only stylesheets the TV never loads: the first-run screens' full-window layout (modern CSS
// on purpose, docs/FIRSTRUN.md) and the font faces
const WEB_ONLY_CSS = new Set([join('web', 'firstrun-web.css'), join('web', 'fonts', 'inter.css')]);
for (const file of [...files(join(APP, 'css'), '.css'), ...files(join(APP, 'plugins'), '.css'), ...files(join(APP, 'web'), '.css')]) {
  if (WEB_ONLY_CSS.has(relative(APP, file))) continue;
  // blank out comments but keep line numbers
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  text.split('\n').forEach((code, i) => {
    for (const [re, msg] of BAD_CSS) if (re.test(code)) report(file, i + 1, msg);
  });
}

const html = readFileSync(join(APP, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (ref.includes('dev-config')) continue;
  try { statSync(join(APP, ref)); } catch { report(join(APP, 'index.html'), '-', `missing file ${ref}`); }
}

// the version the app reports to Plex must match the package version (see CHANGELOG.md)
const appinfo = JSON.parse(readFileSync(join(APP, 'appinfo.json'), 'utf8'));
const coreVersion = (/PL\.VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(APP, 'js/core.js'), 'utf8')) || [])[1];
if (!/^\d+\.\d+\.\d+$/.test(appinfo.version)) report(join(APP, 'appinfo.json'), '-', `version ${appinfo.version} is not x.y.z (webOS needs plain semver)`);
if (coreVersion !== appinfo.version) report(join(APP, 'js/core.js'), '-', `PL.VERSION ${coreVersion} != appinfo.json version ${appinfo.version}`);

console.log(problems ? `\n${problems} problem(s)` : 'Chrome 53 check: OK');
process.exit(problems ? 1 : 0);
