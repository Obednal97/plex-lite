#!/usr/bin/env node
// Builds the web version of Plex Lite into dist/web/ (docs/WEB.md). Vercel runs this
// (vercel.json); it needs only Node, no packages.
//
//   node tools/build-web.mjs [out-dir]
//
// The same files as the TV app, plus web/ (platform glue, sign-in, browser playback, vendored
// hls.js). index.html is rewritten for the web: no inline scripts (the Content-Security-Policy in
// vercel.json allows none), web/env.js first so the shared code knows it's on the web, the web
// scripts and stylesheet added. The TV's dev-config hook and the plugins' webOS services are left out.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] || join(APP, 'dist/web'));
// the output folder is emptied first: never the app itself, a folder above it, or one of its sources
const appDir = resolve(APP);
if (appDir === OUT || appDir.startsWith(OUT + sep) || ['css', 'js', 'img', 'plugins', 'catalog', 'web', 'tools', 'docs', 'test']
  .some((d) => OUT === join(appDir, d) || OUT.startsWith(join(appDir, d) + sep))) {
  console.error(`build-web: refusing to build into ${OUT}`);
  process.exit(1);
}

// What ships. Plugin service/ folders are webOS background services (TV only).
const COPY = ['css', 'js', 'img', 'plugins', 'catalog'];
const SKIP = (rel) => /(^|\/)dev-config[^/]*\.js$/.test(rel) || /^plugins\/[^/]+\/service(\/|$)/.test(rel) || /\.DS_Store$/.test(rel);
// web/ files and where they're served (signed-in.* sit at the root: Plex's sign-in page sends the
// popup there)
const WEB = {
  'web/env.js': 'web/env.js', 'web/web.js': 'web/web.js', 'web/web-signin.js': 'web/web-signin.js',
  'web/web-media.js': 'web/web-media.js', 'web/web.css': 'web/web.css', 'web/plugin-frame.html': 'web/plugin-frame.html',
  'web/vendor/hls.js/hls.light.min.js': 'web/vendor/hls.js/hls.light.min.js', 'web/vendor/hls.js/LICENSE': 'web/vendor/hls.js/LICENSE',
  'web/signed-in.html': 'signed-in.html', 'web/signed-in.js': 'signed-in.js', 'web/signed-in.css': 'signed-in.css',
  'web/robots.txt': 'robots.txt',
};
// scripts after js/app.js, in order
const WEB_SCRIPTS = ['web/vendor/hls.js/hls.light.min.js', 'web/web.js', 'web/web-signin.js', 'web/web-media.js'];

const fail = (msg) => { console.error(`build-web: ${msg}`); process.exit(1); };

function walk(dir, base = dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let files = 0;
for (const dir of COPY) {
  for (const rel of walk(join(APP, dir)).map((r) => `${dir}/${r}`)) {
    if (SKIP(rel)) continue;
    mkdirSync(dirname(join(OUT, rel)), { recursive: true });
    cpSync(join(APP, rel), join(OUT, rel));
    files++;
  }
}
for (const [src, dest] of Object.entries(WEB)) {
  if (!existsSync(join(APP, src))) fail(`missing ${src}`);
  mkdirSync(dirname(join(OUT, dest)), { recursive: true });
  cpSync(join(APP, src), join(OUT, dest));
  files++;
}
// hls.js points at a source map that isn't shipped (a 404 in the browser's developer tools)
const hlsOut = join(OUT, 'web/vendor/hls.js/hls.light.min.js');
writeFileSync(hlsOut, readFileSync(hlsOut, 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'));

// ---- index.html --------------------------------------------------------------------------------

const version = (/PL\.VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(APP, 'js/core.js'), 'utf8')) || [])[1];
let html = readFileSync(join(APP, 'index.html'), 'utf8');
const before = html;
html = html.replace(/\s*<script>window\.PL_DEV = null;<\/script>/, '');
html = html.replace(/\s*<script src="js\/dev-config\.js"[^>]*><\/script>/, '');
html = html.replace('<title>Plex Lite</title>', [
  '<title>Plex Lite</title>',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <meta name="description" content="A fast, lightweight Plex client: sign in with Plex and watch from your own Plex Media Server.">',
  '  <meta name="theme-color" content="#0f0f0f">',
  '  <meta name="color-scheme" content="dark">',
  '  <link rel="icon" type="image/png" href="img/largeIcon.png">',
].join('\n'));
html = html.replace(/(\s*)<script src="js\/core\.js"><\/script>/, '$1<script src="web/env.js"></script>$1<script src="js/core.js"></script>');
html = html.replace(/(\s*)(<\/head>)/, '\n  <link rel="stylesheet" href="web/web.css">$1$2');
// the Overseerr plugin's browser path (instead of its webOS service), right after its shared core
html = html.replace(/(\s*)<script src="plugins\/overseerr\/seerr\.js"><\/script>/, (m, ws) => `${m}${ws}<script src="plugins/overseerr/seerr-web.js"></script>`);
html = html.replace(/(\s*)<script src="js\/app\.js"><\/script>/, (m, ws) => m + WEB_SCRIPTS.map((s) => `${ws}<script src="${s}"></script>`).join(''));
html = html.replace('<html lang="en">', `<html lang="en" data-version="${version}">`);
if (html === before) fail('index.html did not change: has its layout moved?');

// cache-busting: every local script and stylesheet gets ?v=<hash of its content>
html = html.replace(/(src|href)="((?:js|css|web|plugins|img)\/[^"?]+)"/g, (m, attr, ref) => {
  const file = join(OUT, ref);
  if (!existsSync(file)) fail(`index.html refers to ${ref}, which isn't in the build`);
  const h = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
  return `${attr}="${ref}?v=${h}"`;
});

// the CSP allows no inline script or handler: catch one before Vercel serves a broken page
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail('index.html has an inline <script>');
if (/\son[a-z]+\s*=/i.test(html)) fail('index.html has an inline event handler');
for (const s of ['web/env.js', 'js/core.js', 'web/web.js', 'web/web-media.js', 'plugins/overseerr/seerr-web.js']) if (!html.includes(`"${s}?v=`)) fail(`index.html lacks ${s}`);
if (html.indexOf('web/env.js') > html.indexOf('js/core.js')) fail('web/env.js must load before js/core.js');

writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(join(OUT, 'version.json'), JSON.stringify({ version, built: new Date().toISOString() }) + '\n');
console.log(`build-web: Plex Lite ${version}, ${files + 2} files -> ${relative(process.cwd(), OUT) || '.'}`);
