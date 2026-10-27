#!/usr/bin/env node
// Visual regression pass on the TV: opens each page and screenshots it on first load, after 3 s
// and after 10 s (catches late image pops, layout shifts, timeouts). Needs the DevTools tunnel
// (ssh -f -N -L 19998:127.0.0.1:9998 lgtv) and the app in the foreground.
//
//   node tools/shots.mjs <out-dir> [page ...]      pages default to all
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TVDEBUG = fileURLToPath(new URL('./tvdebug.mjs', import.meta.url));
const [outDir, ...only] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: shots.mjs <out-dir> [page ...]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const tv = (...args) => execFileSync('node', [TVDEBUG, ...args], { encoding: 'utf8' }).trim();
const evalJs = (js) => tv('eval', js);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each page: JS (run in the app) that navigates there from wherever the app is.
const goTab = (id) => `PL.app.blurTabs(true);PL.app.selectTab(PL.app.tabs.tabs.map(function(t){return t.id;}).indexOf(${JSON.stringify(id)}));`;
const goMode = (id, m) => goTab(id) + `var s=PL.app.top();s.subnav.selected=s.subnav.index=${m};s.subnav.paint();s.setMode(${m});s.focusArea('content');`;
const run = (body, ret) => `(function(){${body}return ${ret || "'ok'"};})()`;
const PAGES = {
  'movies-rec': run(goMode('section.1', 0)),
  'movies-library': run(goMode('section.1', 1)),
  'movies-collections': run(goMode('section.1', 2)),
  'shows-rec': run(goMode('section.2', 0)),
  'shows-library': run(goMode('section.2', 1)),
  'movie-details': run(goTab('section.1') + "PL.app.push(PL.screens.details({ratingKey:'13492',type:'movie'}));"),
  'show-details': run(goTab('section.2'),
    "PL.plex.get('/library/sections/2/all',{type:2,sort:'lastViewedAt:desc','X-Plex-Container-Size':1}).then(function(mc){var it=mc.Metadata[0];PL.app.push(PL.screens.details(it));return it.title;})"),
  'movie-details-scrolled': run(goTab('section.1') + "var d=PL.screens.details({ratingKey:'13492',type:'movie'});PL.app.push(d);" +
    "setTimeout(function(){d.key(40);d.key(40);},2500);"),
  'show-details-scrolled': run(goTab('section.2'),
    "PL.plex.get('/library/sections/2/all',{type:2,sort:'lastViewedAt:desc','X-Plex-Container-Size':1}).then(function(mc){var d=PL.screens.details(mc.Metadata[0]);PL.app.push(d);setTimeout(function(){d.key(40);d.key(40);d.key(40);},2500);return mc.Metadata[0].title;})"),
  'search': run(goTab('search')),
  'livetv': run(goTab('livetv')),
  'settings': run(goTab('settings')),
  'sort-sheet': run(goMode('section.1', 1) + 'PL.app.top().mode.pickSort();'),
};

const pages = only.length ? only : Object.keys(PAGES);
for (const name of pages) {
  const js = PAGES[name];
  if (!js) { console.error(`unknown page ${name}`); continue; }
  const result = evalJs(js);
  const t0 = Date.now();
  for (const at of [0, 3000, 10000]) {
    await sleep(Math.max(0, at - (Date.now() - t0)));
    const file = join(outDir, `${name}-${String(at / 1000).padStart(2, '0')}s.png`);
    tv('shot', file);
  }
  const health = evalJs('(function(){return {nodes:document.getElementsByTagName("*").length, stack:PL.app.stack.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null};})()');
  console.log(`${name}: ${result} ${health.replace(/\s+/g, ' ')}`);
}
