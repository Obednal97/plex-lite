#!/usr/bin/env node
// Visual regression pass on the TV: opens each page and screenshots it on first load, after 3 s
// and after 10 s (catches late image pops, layout shifts, timeouts). Needs the DevTools tunnel
// (ssh -f -N -L 19998:127.0.0.1:9998 "$PLEXLITE_TV_SSH") and the app in the foreground.
//
//   node tools/shots.mjs <out-dir> [page ...]      pages default to all
//
// Uses the first movie and TV library and their most recently watched titles, unless
// PLEXLITE_SHOTS_MOVIES / PLEXLITE_SHOTS_SHOWS (section keys) or PLEXLITE_SHOTS_MOVIE (a ratingKey)
// pin them (tools/local.env.example). Screenshots show your own library: don't publish them.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';

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
// In-app expression for a library section key: the pinned one, else the first of that type.
const section = (type, pinned) => pinned ? JSON.stringify(String(pinned))
  : `(PL.app.sections.filter(function(s){return s.type===${JSON.stringify(type)};})[0]||{}).key`;
const MOVIES = section('movie', config.PLEXLITE_SHOTS_MOVIES);
const SHOWS = section('show', config.PLEXLITE_SHOTS_SHOWS);
const goTab = (sectionExpr) => `PL.app.blurTabs(true);PL.app.selectTab(PL.app.tabs.tabs.map(function(t){return t.id;}).indexOf(${sectionExpr}));`;
const goSection = (sec) => goTab(`'section.'+${sec}`);
const goNamed = (id) => goTab(JSON.stringify(id));
const goMode = (sec, m) => goSection(sec) + `var s=PL.app.top();s.subnav.selected=s.subnav.index=${m};s.subnav.paint();s.setMode(${m});s.focusArea('content');`;
const surprise = "var lib=PL.app.top();var r=PL.screens.surprise(lib.section,lib.surpriseFilters());" +
  "r.play=function(){r.stopCountdown();};PL.app.push(r);";
const collection = (after) => "PL.plex.get('/library/sections/'+" + MOVIES + "+'/collections',{}).then(function(mc){" +
  "var it=(mc.Metadata||[]).filter(function(x){return x.childCount>=2;})[0];var c=PL.screens.details(it);PL.app.push(c);" +
  "setTimeout(function(){" + after + "},1500);return it.childCount+' titles';})";
const run = (body, ret) => `(function(){${body}return ${ret || "'ok'"};})()`;
// Opens the details page of the section's most recently watched item (Plex type 1 movie, 2 show),
// or of PLEXLITE_SHOTS_MOVIE; `after` runs with the screen as d.
const details = (sec, plexType, pinnedKey, after) => {
  const open = `var d=PL.screens.details(it);PL.app.push(d);${after || ''}return it.title||it.ratingKey;`;
  if (pinnedKey) return run(goSection(sec), `(function(){var it={ratingKey:${JSON.stringify(String(pinnedKey))},type:'movie'};${open}})()`);
  return run(goSection(sec),
    `PL.plex.get('/library/sections/'+${sec}+'/all',{type:${plexType},sort:'lastViewedAt:desc','X-Plex-Container-Size':1}).then(function(mc){var it=mc.Metadata[0];${open}})`);
};
const scroll = (n) => `setTimeout(function(){${'d.key(40);'.repeat(n)}},2500);`;
const PAGES = {
  'movies-rec': run(goMode(MOVIES, 0)),
  'movies-library': run(goMode(MOVIES, 1)),
  'movies-collections': run(goMode(MOVIES, 2)),
  'shows-rec': run(goMode(SHOWS, 0)),
  'shows-library': run(goMode(SHOWS, 1)),
  'movie-details': details(MOVIES, 1, config.PLEXLITE_SHOTS_MOVIE),
  'show-details': details(SHOWS, 2, null),
  'movie-details-scrolled': details(MOVIES, 1, config.PLEXLITE_SHOTS_MOVIE, scroll(3)),
  'show-details-scrolled': details(SHOWS, 2, null, scroll(4)),
  'search': run(goNamed('search')),
  'livetv': run(goNamed('livetv')),
  'settings': run(goNamed('settings')),
  'sort-sheet': run(goMode(MOVIES, 1) + 'PL.app.top().mode.pickSort();'),
  'shows-surprise-pill': run(goMode(SHOWS, 0) + "s.focusArea('surprise');"),
  'movies-library-surprise-pill': run(goMode(MOVIES, 1) + "s.focusArea('surprise');"),
  // the reveal's countdown runs to the end (10 s shot) but its play() is stubbed, so nothing plays
  'surprise-shows': run(goSection(SHOWS) + surprise),
  'surprise-movies': run(goSection(MOVIES) + surprise),
  // the first movie collection with 2+ titles: its page with the pill focused, then its reveal
  'collection-surprise-pill': run(goSection(MOVIES), collection("c.key(38);")),
  'collection-surprise': run(goSection(MOVIES), collection("setTimeout(function(){c.key(38);c.key(13);" +
    "var r=PL.app.top();if(r.stopCountdown)r.play=function(){r.stopCountdown();};},1500);")),
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
