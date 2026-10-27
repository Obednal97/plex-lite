#!/usr/bin/env node
// Downloads the demo library's artwork (Wikimedia Commons thumbnails, all freely licensed; see
// library.json "media" and docs/screenshots/CREDITS.md) into the media cache, outside the repo:
//
//   node tools/demo/fetch-media.mjs [--videos]
//
// PLEXLITE_DEMO_MEDIA sets the cache (default ~/.cache/plexlite/demo-media). --videos also keeps
// local copies of the demo WebM files (large); without them the server redirects to Commons.
// Downloads are treated as data: only JPEG/PNG/WebM files with matching magic bytes are kept.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIR = (process.env.PLEXLITE_DEMO_MEDIA || '~/.cache/plexlite/demo-media').replace(/^~\//, homedir() + '/');
const UA = 'PlexLiteDemo/1.0 (https://github.com/Obednal97/plex-lite; demo library for screenshots)';
const lib = JSON.parse(readFileSync(join(HERE, 'library.json'), 'utf8'));
const MAX = 12 * 1024 * 1024;

const kind = (b) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? '.jpg'
  : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? '.png' : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 6) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    // Wikimedia rate-limits bursts of requests (and renders video frames on demand): back off
    if ((r.status === 429 || r.status >= 500) && i < tries) { await sleep(8000 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
}

async function image(id, entry) {
  if (existsSync(join(DIR, id + '.jpg')) || existsSync(join(DIR, id + '.png'))) return 'cached';
  const r = await get(entry.url);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX) throw new Error('too large');
  const ext = kind(buf);
  if (!ext) throw new Error('not a JPEG or PNG');
  writeFileSync(join(DIR, id + ext), buf);
  return `${Math.round(buf.length / 1024)} KB`;
}

async function video(id, entry) {
  const dir = join(DIR, 'videos');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, id + '.webm');
  if (existsSync(file)) return 'cached';
  const r = await get(entry.url);
  const tmp = file + '.part';
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp));
  const head = readFileSync(tmp).subarray(0, 4);
  if (!(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) {
    unlinkSync(tmp);
    throw new Error('not a WebM file');
  }
  renameSync(tmp, file);
  return 'downloaded';
}

mkdirSync(DIR, { recursive: true });
const jobs = Object.entries(lib.media || {}).map(([id, e]) => [id, () => image(id, e)]);
if (process.argv.includes('--videos')) {
  for (const [id, e] of Object.entries(lib.videos || {})) jobs.push([`video ${id}`, () => video(id, e)]);
}
let failed = 0;
// one at a time with a pause, as Wikimedia asks of scripts
for (const [id, run] of jobs) {
  try {
    const what = await run();
    if (what !== 'cached') {
      console.log(`${id}: ${what}`);
      await sleep(1500);
    }
  } catch (e) {
    failed++;
    console.error(`${id}: ${e.message}`);
  }
}
console.log(`${jobs.length - failed}/${jobs.length} in ${DIR}`);
process.exit(failed ? 1 : 0);
