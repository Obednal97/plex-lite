#!/usr/bin/env node
// Builds the first-run "poster wall" images (Direction A of the sign-in redesign) from the demo
// library's free-licence posters:
//
//   node tools/demo/fetch-media.mjs   # once: downloads the posters into the demo media cache
//   node tools/make-wall.mjs [--out <dir>]
//
// Writes, into img/firstrun/ (or --out):
//   wall.jpg        2400x1417, desktop and TV (shown dimmed under scrims, so lightly softened)
//   wall-phone.jpg  1152x680, phones
//   wall-soft.jpg   720x425, heavily blurred at build time for the later steps (no CSS filter)
//
// The wall is a dark ground with tilted columns of rounded posters, every other column offset by
// half a poster, matching the designer's 2880x1700 mock: the same posters sit in the same places,
// so the boards' crops (the image drawn at 1786x1054, left -13, top -77, in a 1440x900 window)
// still line up. The layout is computed at that 2880x1700 design size and then scaled down.
//
// Only posters that are free to reuse are used: Blender open-movie posters (CC BY) and posters of
// public-domain films. POSTERS below records each file, film, licence and author (as in
// tools/demo/library.json "media"); the script checks them against library.json and prints them.
// Credits for the images are in THIRD-PARTY-NOTICES.md.
//
// Needs ImageMagick 7 (`magick`) and Node 18+. No npm packages. PLEXLITE_DEMO_MEDIA sets the
// poster cache (default ~/.cache/plexlite/demo-media), as for tools/demo/fetch-media.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const MEDIA = (process.env.PLEXLITE_DEMO_MEDIA || '~/.cache/plexlite/demo-media').replace(/^~\//, homedir() + '/');
const outIdx = process.argv.indexOf('--out');
const OUT = resolve(outIdx > 0 ? process.argv[outIdx + 1] : join(ROOT, 'img/firstrun'));

// In wall order: column k, row j shows POSTERS[(3k + j) mod 12].
const POSTERS = [
  { id: 'sprite-fright-poster', file: 'File:Sprite Fright-movie poster.jpg', film: 'Sprite Fright (2021)', license: 'CC BY 4.0', author: 'Blender Studio' },
  { id: 'night-of-the-living-dead-poster', file: 'File:Night Of The Living Dead (1968) - Poster.jpg', film: 'Night of the Living Dead (1968)', license: 'Public domain', author: 'Unknown author' },
  { id: 'spring-poster', file: 'File:Spring2019AlphaPosterBlender.jpg', film: 'Spring (2019)', license: 'CC BY 4.0', author: 'Blender Foundation' },
  { id: 'his-girl-friday-poster', file: 'File:His Girl Friday (1940 poster).jpg', film: 'His Girl Friday (1940)', license: 'Public domain', author: 'Columbia Pictures ("Copyrighted by Columbia Pictures Corp, New York, N. Y. 1939", not renewed)' },
  { id: 'sintel-poster', file: 'File:Sintel poster.jpg', film: 'Sintel (2010)', license: 'CC BY 3.0', author: '(c) copyright Blender Foundation | durian.blender.org' },
  { id: 'cosmos-laundromat-poster', file: 'File:CosmosLaundromatPoster.jpg', film: 'Cosmos Laundromat (2015)', license: 'CC BY 4.0', author: 'Andy Goralczyk and the Blender Foundation' },
  { id: 'elephants-dream-poster', file: 'File:ElephantsDreamPoster.jpg', film: 'Elephants Dream (2006)', license: 'CC BY 4.0', author: 'Bassam Kurdali, Andy Goralczyk, and the Blender Foundation' },
  { id: 'the-general-poster', file: 'File:The general movie poster.jpg', film: 'The General (1926)', license: 'Public domain', author: 'Alvan "Hap" Hadley (1895–1976) (signed)' },
  { id: 'charge-poster', file: 'File:Charge-movie poster.jpg', film: 'Charge (2022)', license: 'CC BY 4.0', author: 'Blender Studio' },
  { id: 'charade-poster', file: 'File:Charade (1963 poster).jpg', film: 'Charade (1963)', license: 'Public domain', author: 'Universal Pictures ("Copyright © 1963 by Universal Pictures Co., Inc.", no valid notice)' },
  { id: 'big-buck-bunny-poster', file: 'File:Big buck bunny poster big.jpg', film: 'Big Buck Bunny (2008)', license: 'CC BY 3.0', author: '(c) copyright Blender Foundation | peach.blender.org' },
  { id: 'tears-of-steel-poster', file: 'File:Tos-poster.png', film: 'Tears of Steel (2012)', license: 'CC BY 3.0', author: '(CC) Blender Foundation | Project Mango' },
];

// Geometry at the 2880x1700 design size, fitted to the designer's mock (least squares on a
// greyscale 1440x850 copy).
const DESIGN = { w: 2880, h: 1700 };
const GROUND = '#141416';
const TILT = 7;              // degrees, anticlockwise: columns lean right going down
const PW = 302, PH = 447;    // poster size (cover-cropped)
const RADIUS = 19;           // corner radius
const COL = 328.5;           // column pitch (poster width + gap), across the tilted columns
const ROW = 473;             // row pitch (poster height + gap), down a column
const ORIGIN = [199, 278.5]; // centre of column 0, row 0 (Sprite Fright, left edge of the mock)
const ODD = -235.5;          // odd columns sit this far up their column (about half a row)

const SIZES = [
  { name: 'wall.jpg', width: 2400, quality: 64, soften: 0.6, maxKB: 450 },
  { name: 'wall-phone.jpg', width: 1152, quality: 66, soften: 0.5, maxKB: 150 },
  { name: 'wall-soft.jpg', width: 720, quality: 72, maxKB: 40, blur: 16, dim: 74, sat: 80 },
];

const magick = (args) => execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });

function posterPath(id) {
  for (const ext of ['.jpg', '.png']) if (existsSync(join(MEDIA, id + ext))) return join(MEDIA, id + ext);
  throw new Error(`missing ${id} in ${MEDIA}: run node tools/demo/fetch-media.mjs first`);
}

function checkLibrary() {
  const media = JSON.parse(readFileSync(join(HERE, 'demo/library.json'), 'utf8')).media;
  for (const p of POSTERS) {
    const m = media[p.id];
    if (!m) throw new Error(`${p.id} is not in tools/demo/library.json`);
    if (m.file !== p.file || m.license !== p.license) {
      console.warn(`warning: ${p.id} differs from library.json (${m.file}, ${m.license})`);
    }
    if (!/^(CC BY [\d.]+|Public domain)$/.test(m.license)) throw new Error(`${p.id}: ${m.license} is not allowed on the wall`);
  }
}

function main() {
  checkLibrary();
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'plexlite-wall-'));
  try {
    // One rounded, cover-cropped, tilted tile per poster (transparent outside the poster).
    const tiles = POSTERS.map((p, i) => {
      const tile = join(tmp, `tile${i}.png`);
      magick([posterPath(p.id), '-colorspace', 'sRGB', '-resize', `${PW}x${PH}^`, '-gravity', 'center', '-extent', `${PW}x${PH}`,
        '(', '-size', `${PW}x${PH}`, 'xc:none', '-fill', 'white', '-draw', `roundrectangle 0,0 ${PW - 1},${PH - 1} ${RADIUS},${RADIUS}`, ')',
        '-alpha', 'set', '-compose', 'DstIn', '-composite', '-compose', 'Over',
        '-background', 'none', '-rotate', String(-TILT), tile]);
      return tile;
    });

    // Lay the columns out on the tilted grid and keep every tile that reaches the canvas.
    const a = TILT * Math.PI / 180;
    const u = [Math.cos(a), -Math.sin(a)];  // across the columns
    const v = [Math.sin(a), Math.cos(a)];   // down a column
    const reach = Math.hypot(PW, PH) / 2;
    const args = ['-size', `${DESIGN.w}x${DESIGN.h}`, `xc:${GROUND}`, '-gravity', 'center'];
    let count = 0;
    for (let k = -4; k <= 12; k++) {
      for (let j = -6; j <= 8; j++) {
        const t = j * ROW + (k & 1 ? ODD : 0);
        const cx = ORIGIN[0] + k * COL * u[0] + t * v[0];
        const cy = ORIGIN[1] + k * COL * u[1] + t * v[1];
        if (cx < -reach || cx > DESIGN.w + reach || cy < -reach || cy > DESIGN.h + reach) continue;
        const dx = Math.round(cx - DESIGN.w / 2), dy = Math.round(cy - DESIGN.h / 2);
        const idx = (((3 * k + j) % 12) + 12) % 12;
        args.push(tiles[idx], '-geometry', `${dx >= 0 ? '+' : ''}${dx}${dy >= 0 ? '+' : ''}${dy}`, '-composite');
        count++;
      }
    }
    const full = join(tmp, 'wall-full.png');
    magick([...args, full]);

    for (const s of SIZES) {
      const height = Math.round(s.width * DESIGN.h / DESIGN.w);
      const ops = ['-resize', `${s.width}x${height}!`];
      // a touch of softening costs nothing under the scrims and saves ~20% of the bytes
      if (s.soften) ops.push('-blur', `0x${s.soften}`);
      if (s.blur) ops.push('-blur', `0x${s.blur}`, '-modulate', `${s.dim},${s.sat}`);
      const file = join(OUT, s.name);
      magick([full, '-filter', 'Lanczos', ...ops, '-strip', '-interlace', 'Plane', '-sampling-factor', '4:2:0', '-quality', String(s.quality), file]);
      const kb = statSync(file).size / 1024;
      console.log(`${s.name.padEnd(15)} ${s.width}x${height}  ${kb.toFixed(1)} KB${kb > s.maxKB ? `  (over the ${s.maxKB} KB target)` : ''}`);
    }
    console.log(`\n${count} tiles from ${POSTERS.length} posters:`);
    for (const p of POSTERS) console.log(`  ${p.film.padEnd(32)} ${p.license.padEnd(14)} ${p.author}  [${p.file}]`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
