#!/usr/bin/env node
// Demo Plex server: runs Plex Lite on the desktop against a small library of openly licensed films
// (Blender open movies and public-domain classics), with no Plex account, server or token.
//
//   node tools/demo/fetch-media.mjs     # once: downloads the artwork listed in library.json
//   node tools/demo/server.mjs          # http://127.0.0.1:8930  (add ?signin for the sign-in screen)
//
// It serves the app, plus:
//   a mock Plex Media Server at the root (/identity, /library, /hubs, /photo, ...): sections, hubs,
//              metadata, search, collections, Live TV (lineup, guide, tuning; live playback is the
//              airing title's WebM), play queues, photo transcoding and direct play (the WebM files
//              on Wikimedia Commons), with watched state in memory.
//              The app's own files never collide with Plex paths, so one origin serves both.
//   /plextv/*  a mock plex.tv: user, Home users, resources (this server) and link-code pins
// The page gets window.PL_DEV pointing the app at both, the same hook tools/devserver.mjs uses.
//
// Settings (environment): PORT (8930), PLEXLITE_DEMO_MEDIA (artwork cache, default
// ~/.cache/plexlite/demo-media), PLEXLITE_DEMO_LIVETV=0 to hide Live TV, PLEXLITE_DEMO_TUNE_DELAY
// (ms before a tune answers, 600; 0 for none), PLEXLITE_DEMO_CHANNELS (pad the lineup to this many
// IPTV-style channels, e.g. 600).
// Content and licences: tools/demo/library.json and docs/screenshots/CREDITS.md.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as art from './art.mjs';
import { loadLibrary, slug } from './model.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.PORT || 8930);
const SELF = `127.0.0.1:${PORT}`;
const BASE = `http://${SELF}`;
const MEDIA_DIR = (process.env.PLEXLITE_DEMO_MEDIA || '~/.cache/plexlite/demo-media').replace(/^~\//, homedir() + '/');
const LIVETV = process.env.PLEXLITE_DEMO_LIVETV !== '0';
const MACHINE_ID = 'demo0000000000000000000000000000000000ff';
const SERVER_NAME = 'Demo Library';
const TOKEN = 'demo-token';
const PROVIDER = 'tv.plex.providers.epg.demo';
const PMS_PATH = /^\/(identity|library|hubs|photo|video|playQueues|:|livetv|media|transcode|tv\.plex\.providers\.[^/]+)(\/|$)/;

const model = loadLibrary(join(HERE, 'library.json'));
const lib = model.lib;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webm': 'video/webm', '.ico': 'image/x-icon' };

// ---- helpers -------------------------------------------------------------------------------------

function send(res, status, body, type, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type || 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

const container = (fields) => ({ MediaContainer: { size: 0, ...fields } });

// Internal fields (_*) never leave the server; lists drop the heavy parts like Plex does.
function clean(item, opts = {}) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (k.startsWith('_') || v === undefined) continue;
    if (opts.list && (k === 'Role' || k === 'Writer' || k === 'Extras' || k === 'Country')) continue;
    if (k === 'Extras') continue;
    out[k] = v;
  }
  if (opts.list && out.Director) out.Director = out.Director.slice(0, 1);
  return out;
}

function page(items, q, map = (i) => clean(i, { list: true })) {
  const start = Number(q.get('X-Plex-Container-Start') || 0);
  const size = q.has('X-Plex-Container-Size') ? Number(q.get('X-Plex-Container-Size')) : items.length;
  const slice = items.slice(start, start + size).map(map);
  return container({ size: slice.length, totalSize: items.length, offset: start, Metadata: slice });
}

// ---- images --------------------------------------------------------------------------------------

function mediaFile(id) {
  for (const ext of ['.jpg', '.png']) {
    const f = join(MEDIA_DIR, id + ext);
    if (existsSync(f)) return f;
  }
  return null;
}

const dataUriCache = new Map();
function dataUri(file) {
  if (!dataUriCache.has(file)) {
    const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    dataUriCache.set(file, `data:${type};base64,${readFileSync(file).toString('base64')}`);
  }
  return dataUriCache.get(file);
}

// Generated art for a "gen:<kind>/<key>" ref, or for a media ref whose file isn't downloaded yet.
function generated(ref) {
  const [kind, key] = ref.split('/');
  const item = [...model.items.values()].find((i) => i._id === key);
  const title = item ? item.title : key;
  if (kind === 'poster') return art.poster(title, item && item.year, key);
  if (kind === 'logo') return art.logo(title, item && item._src.logoStyle);
  if (kind === 'channel') {
    const ch = (lib.channels || [])[Number(key)];
    return ch ? art.channel(ch.short || ch.title, ch.title) : null;
  }
  if (kind === 'collection') {
    const col = model.items.get(key);
    if (!col) return null;
    // members' posters, real or generated, as data URIs (an SVG image can't fetch anything)
    const imgs = col._members.map((m) => {
      const file = imageFile(m.thumb);
      return file ? dataUri(file) : `data:image/svg+xml;base64,${Buffer.from(art.poster(m.title, m.year, m._id)).toString('base64')}`;
    });
    return imgs.length >= 2 ? art.collage(col.title, imgs, col.title) : art.poster(col.title, `${col.childCount} films`, col.title);
  }
  return art.still(key || ref);
}

function imageFile(path) {
  const ref = model.images.get(path);
  return ref && ref.startsWith('media:') ? mediaFile(ref.slice(6)) : null;
}

// /photo/:/transcode?url=<plex image path>&width&height[&blur&opacity&background]. Real files are
// sent as they are (the browser scales them; cards use object-fit) except for blurred ambients.
function photo(res, q) {
  const path = q.get('url') || '';
  const ref = model.images.get(path.split('?')[0]);
  if (!ref) return send(res, 404, 'unknown image', 'text/plain');
  const file = imageFile(path.split('?')[0]);
  const w = Math.round(Number(q.get('width')) || 480);
  const h = Math.round(Number(q.get('height')) || 270);
  if (q.get('blur')) {
    const src = file ? dataUri(file) : `data:image/svg+xml;base64,${Buffer.from(generated(ref.startsWith('gen:') ? ref.slice(4) : 'art/' + ref)).toString('base64')}`;
    return send(res, 200, art.ambient(src, w, h, Number(q.get('blur')) / 2, Number(q.get('opacity') || 100), q.get('background') || '000000'), 'image/svg+xml');
  }
  if (file) return send(res, 200, readFileSync(file), TYPES[extname(file)]);
  if (ref.startsWith('media:')) {
    // not downloaded: logos fall back to the app's text title, everything else to generated art
    if (path.includes('/clearLogo/')) return send(res, 404, 'logo not downloaded', 'text/plain');
    const kind = path.includes('/thumb/') && !path.includes('/people/') ? 'poster' : 'art';
    const owner = [...model.items.values()].find((i) => i.thumb === path || i.art === path);
    if (path.includes('/people/')) return send(res, 404, 'photo not downloaded', 'text/plain');
    return send(res, 200, generated(`${owner && owner.type === 'episode' ? 'art' : kind}/${owner ? owner._id || owner.ratingKey : path}`), 'image/svg+xml');
  }
  const body = generated(ref.slice(4));
  return body ? send(res, 200, body, 'image/svg+xml') : send(res, 404, 'no image', 'text/plain');
}

// ---- video ---------------------------------------------------------------------------------------

// Placeholder captions for the demo's sidecar subtitle stream: one cue every 10 seconds.
function subtitles(res, streamId) {
  let dur = 0;
  for (const it of model.items.values()) {
    for (const m of it.Media || []) for (const p of m.Part) if ((p.Stream || []).some((s) => String(s.id) === String(streamId))) dur = p.duration / 1000;
  }
  if (!dur) return send(res, 404, 'no such stream', 'text/plain');
  const t = (sec) => new Date(sec * 1000).toISOString().slice(11, 23).replace('.', ',');
  const cues = [];
  for (let s = 2, n = 1; s < dur; s += 10, n++) cues.push(`${n}\n${t(s)} --> ${t(s + 4)}\nDemo captions\n(${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})\n`);
  return send(res, 200, cues.join('\n'), 'text/plain; charset=utf-8');
}

// Preview thumbnails (Plex's /library/parts/<id>/indexes/sd/<ms>): frames from
// PLEXLITE_DEMO_MEDIA/previews/<video>/<seconds>.jpg when someone has made them, else the title's
// backdrop for every time. Titles with neither answer 404, as a server without previews would.
const previewDirs = new Map();
function previewFrames(video) {
  if (!previewDirs.has(video)) {
    const dir = join(MEDIA_DIR, 'previews', video);
    const list = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f)).map((f) => ({ sec: Number(f.slice(0, -4)), file: join(dir, f) })) : [];
    previewDirs.set(video, list.sort((a, b) => a.sec - b.sec));
  }
  return previewDirs.get(video);
}

function preview(res, partId, ms) {
  const found = partById(partId);
  if (!found || !found.part.video) return send(res, 404, 'no such part', 'text/plain');
  const frames = previewFrames(found.part.video);
  const sec = Number(ms) / 1000;
  let file = null;
  for (const f of frames) if (f.sec <= sec + 1) file = f.file;
  if (!file && frames.length) file = frames[0].file;
  if (!file) file = imageFile(found.item.art || '');
  return file ? send(res, 200, readFileSync(file), TYPES[extname(file)]) : send(res, 404, 'no preview', 'text/plain');
}

function partById(id) {
  for (const it of model.items.values()) {
    for (const m of it.Media || []) for (const p of m.Part) if (String(p.id) === String(id)) return { item: it, part: p };
  }
  return null;
}

// A local copy (PLEXLITE_DEMO_MEDIA/videos/<id>.webm) is served with range support; otherwise the
// browser is redirected to the file on Wikimedia Commons.
function video(req, res, partId) {
  const found = partById(partId);
  const src = found && found.part.video && lib.videos[found.part.video];
  if (!src) return send(res, 404, 'this demo title has no video', 'text/plain');
  const local = join(MEDIA_DIR, 'videos', found.part.video + '.webm');
  if (!existsSync(local)) {
    res.writeHead(302, { Location: src.url });
    return res.end();
  }
  const size = statSync(local).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return createReadStream(local).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
  createReadStream(local, { start, end }).pipe(res);
}

// ---- Plex Media Server ------------------------------------------------------------------------

const queues = new Map();
let queueId = 100;
let queueItemId = 5000;

function metadataFor(item, q) {
  const out = clean(item);
  if (item.type === 'show' && q.get('includeOnDeck') === '1') {
    const deck = model.onDeck(item);
    if (deck) out.OnDeck = { Metadata: [clean(deck)] };
  }
  if (q.get('includeExtras') === '1' && item.Extras && item.Extras.length) {
    out.Extras = { size: item.Extras.length, Metadata: item.Extras.map((x) => clean(x)) };
    const trailer = item.Extras.find((x) => x.subtype === 'trailer');
    if (trailer) out.primaryExtraKey = trailer.key;
  }
  if (q.get('includeMarkers') === '1' && item._markers) {
    out.Marker = item._markers.map((m, i) => ({ id: i + 1, type: m.type, startTimeOffset: m.start * 1000,
      endTimeOffset: (m.end || item.duration / 1000) * 1000, final: m.type === 'credits' ? true : undefined }));
  }
  if (q.get('includeChapters') === '1' && item._src && item._src.chapters) {
    const ch = item._src.chapters;
    out.Chapter = ch.map((c, i) => ({ id: i + 1, tag: c.title, index: i + 1, startTimeOffset: c.start * 1000,
      endTimeOffset: (ch[i + 1] ? ch[i + 1].start : item.duration / 1000) * 1000 }));
  }
  return out;
}

function playQueue(q, items, selected) {
  const id = queueId++;
  const list = items.map((it) => ({ ...clean(it, { list: true }), playQueueItemID: queueItemId++ }));
  const sel = list.find((x) => x.ratingKey === selected.ratingKey) || list[0];
  const mc = container({ size: list.length, playQueueID: id, playQueueSelectedItemID: sel.playQueueItemID,
    playQueueSelectedItemOffset: list.indexOf(sel), playQueueTotalCount: list.length, playQueueShuffled: q.get('shuffle') === '1', Metadata: list });
  queues.set(String(id), mc);
  return mc;
}

// ---- Live TV ---------------------------------------------------------------------------------------
// Channels come from library.json "channels" (n = index there, channelID = n + 1, identifier and
// number = vcn). A channel with no items has no guide data: it is in the lineup but not the grid.

// PLEXLITE_DEMO_CHANNELS=600 makes an IPTV-sized lineup for testing (Search's channel matching, the
// guide with hundreds of rows): the demo channels get a group prefix ("DM - Open Movie Channel") as
// IPTV feeds do, and invented channels fill up to the count, two in three with guide data.
const PAD_TO = Number(process.env.PLEXLITE_DEMO_CHANNELS || 0);
if (LIVETV && PAD_TO > (lib.channels || []).length) brandChannels(lib);
if (LIVETV && PAD_TO > (lib.channels || []).length) padChannels(lib, PAD_TO);

// Invented channel brands for the padded lineup, numbered in genre blocks like a satellite
// lineup, so Browse has families (Orbit › Orbit Sports, Orbit Cinema…), +1 channels and a
// category for every block. All names are made up.
function brandChannels(l) {
  const gen = (genre, shows, minutes = [30, 60]) => shows.map((title, j) => ({ title, episode: `Episode ${j + 2}`, genre,
    minutes: minutes[j % minutes.length], summary: `${title}: an invented programme on an invented demo channel.` }));
  const films = (ids) => ids.map((id) => ({ id, minutes: 95 }));
  const sport = (shows) => gen('Sport', shows, [120, 60, 30]);
  const add = (vcn, title, short, items, offsetMin = 0) => l.channels.push({ vcn, title, short, items, offsetMin });
  add(1001, 'Northlight 1', 'NL 1', gen('Entertainment', ['Harbour Lights', 'The Quiz Hour', 'Garden Rescue', 'Evening News']));
  add(1002, 'Northlight 2', 'NL 2', gen('Comedy', ['Flatmates', 'Sketch Pad', 'The Office Party']), 15);
  add(1003, 'Northlight 3', 'NL 3', gen('Drama', ['The Inspector', 'Hospital Shift', 'The Crown Court']), 5);
  add(1004, 'Northlight 4', 'NL 4', gen('Entertainment', ['Bake Off Street', 'Antiques Road Trip', 'Home Swap']), 20);
  add(1005, 'Northlight 1 +1', 'NL 1+1', gen('Entertainment', ['Harbour Lights', 'The Quiz Hour', 'Garden Rescue', 'Evening News']), 60);
  add(1010, 'Orbit One', 'ORBIT 1', gen('Drama', ['Copper Creek', 'The Night Desk', 'Glass Houses']), 10);
  add(1011, 'Orbit Max', 'ORBIT MAX', gen('Action', ['Steel Horizon: The Series', 'Night Pursuit']), 25);
  add(1012, 'Orbit Comedy', 'ORBIT COM', gen('Comedy', ['Stand-up Shuffle', 'Quiz Night', 'Flatmates']), 0);
  add(1101, 'Pioneer', 'PIONEER', ['nasa-explorers', 'sciencecasts']);
  add(1102, 'Pioneer +1', 'PIONEER+1', ['nasa-explorers', 'sciencecasts'], 60);
  add(1103, 'Pioneer History', 'PIO HIST', gen('Historical', ['Engines of History', 'The Lost Canals', 'Castles of the North']), 10);
  add(1104, 'Pioneer Science', 'PIO SCI', ['sciencecasts', 'nasa-explorers'], 20);
  add(1201, 'Orbit Cinema Premiere', 'PREMIERE', films(['sintel', 'tears-of-steel', 'cosmos-laundromat']), 0);
  add(1202, 'Orbit Cinema Action', 'ACTION', films(['hero', 'charge', 'tears-of-steel']), 35);
  add(1203, 'Orbit Cinema Comedy', 'COMEDY', films(['his-girl-friday', 'glass-half', 'wing-it']), 20);
  add(1204, 'Orbit Cinema Greats', 'GREATS', films(['the-general', 'charade']), 50);
  add(1205, 'Orbit Cinema Family', 'FAMILY', films(['spring', 'big-buck-bunny', 'coffee-run']), 10);
  add(1206, 'Orbit Cinema Sci-Fi', 'SCI-FI', films(['night-of-the-living-dead', 'elephants-dream']), 40);
  add(1207, 'Orbit Cinema Drama', 'DRAMA', films(['nosferatu', 'charade']), 65);
  add(1301, 'Global 24', 'GLOBAL 24', gen('News', ['Headlines', 'World Report', 'Business Desk'], [30, 30, 15]));
  add(1302, 'Global Business', 'GLOBAL BIZ', gen('Business', ['Market Watch', 'The Close', 'Trade Talk'], [30]), 10);
  add(1303, 'Global Weather', 'WEATHER', gen('Weather', ['Forecast', 'Storm Watch'], [15]));
  add(1501, 'Bramble Kids', 'BRAMBLE', gen('Children', ['Robot Rangers', 'Space Pups', 'Dino Detectives']), 5);
  add(1502, 'Bramble Junior', 'BRAMBLE JR', gen('Children', ['The Puddle Club', 'Busy Bakers', 'Little Owls'], [15, 30]), 0);
  add(1503, 'Bramble Toons', 'TOONS', ['caminandes'], 10);
  add(1601, 'Orbit Sports Main Event', 'ORBIT SP', sport(['Live Super Sunday', 'The Football Show', 'Goals Express']), 0);
  add(1602, 'Orbit Sports Football', 'ORBIT FB', sport(['Live League: Rovers v City', 'Goals Express', 'The Tactics Board']), 15);
  add(1603, 'Orbit Sports Racing', 'RACING', sport(['Live from the Downs', 'Racing Roundup', 'Parade Ring']), 20);
  add(1604, 'Orbit Sports Golf', 'ORBIT GOLF', sport(['Live Golf: The Open Links', 'Golf Weekly']), 0);
  add(1605, 'Orbit Sports News', 'ORBIT SN', gen('Sports', ['Sports News at Eight', 'Sports News at Nine'], [60]), 0);
  add(1606, 'Orbit Sports Tennis', 'ORBIT TEN', sport(['Live Tennis: Harbour Open', 'Tennis Tonight']), 30);
  add(1650, 'Vista Sports 1', 'VISTA 1', sport(['Live Rugby: Premiership', 'Rugby Tonight']), 10);
  add(1651, 'Vista Sports 2', 'VISTA 2', sport(['Live Boxing', 'The Boxing Hour']), 40);
  add(1652, 'Vista Sports 3', 'VISTA 3', sport(['Live Netball', 'Super League Netball']), 20);
  add(1653, 'Vista Sports 4', 'VISTA 4', sport(['Live Darts', 'Darts Weekly']), 0);
  add(1801, 'Shop Direct', 'SHOP', gen('Shopping', ['Kitchen Hour', 'Gadget Show Live', 'Jewellery Box'], [60]));
  add(1802, 'Shop Direct Style', 'SHOP STYLE', gen('Shopping', ['Style Hour', 'Beauty Live'], [60]), 30);
  add(1803, 'Shop Direct Home', 'SHOP HOME', gen('Shopping', ['Home Hour', 'Garden Live'], [60]), 15);
  add(1901, 'Tempo Hits', 'TEMPO', gen('Music', ['Chart Countdown', 'Live Sessions', 'Classic Hits']), 0);
}

function padChannels(l, count) {
  const groups = ['DM', 'WX', 'ZY', 'QV'];
  const names = ['Harbour', 'Granite', 'Velvet', 'Comet', 'Orchard', 'Lantern', 'Meadow', 'Summit', 'Copper', 'Willow',
    'Juniper', 'Beacon', 'Marble', 'Cascade', 'Ember', 'Falcon', 'Glacier', 'Hazel', 'Indigo', 'Kestrel'];
  const kinds = [
    { kind: 'News', genre: 'News', shows: ['Morning Briefing', 'The Daily Desk', 'World Tonight', 'Market Watch', 'Headline Hour'] },
    { kind: 'Movies', genre: 'Drama', shows: ['The Long Road Home', 'Midnight Express Lane', 'A Quiet Harbour', 'The Glass Orchard', 'Paper Lanterns'] },
    { kind: 'Sport', genre: 'Sport', shows: ['Matchday Live', 'Racing Roundup', 'Golf Weekly', 'The Boxing Hour', 'Tennis Tonight'] },
    { kind: 'Kids', genre: 'Children', shows: ['Robot Rangers', 'The Puddle Club', 'Space Pups', 'Dino Detectives', 'Busy Bakers'] },
    { kind: 'Music', genre: 'Music', shows: ['Chart Countdown', 'Live Sessions', 'Unplugged Nights', 'Classic Hits', 'Dance Floor'] },
    { kind: 'Drama', genre: 'Drama', shows: ['Harbour Lights', 'The Inspector', 'Hospital Shift', 'Family Ties Street', 'The Crown Court'] },
    { kind: 'Comedy', genre: 'Comedy', shows: ['Flatmates', 'The Office Party', 'Stand-up Shuffle', 'Quiz Night', 'Sketch Pad'] },
    { kind: 'Docs', genre: 'Documentary', shows: ['Wild Coastlines', 'Engines of History', 'Deep Ocean', 'Mountain Rescue', 'The Food Trail'] },
  ];
  const tags = ['', ' HD', '', ' FHD', '', ' 2', ' One', ''];
  for (const ch of l.channels) ch.title = `DM - ${ch.title}`;
  for (let i = 0; l.channels.length < count; i++) {
    const k = kinds[i % kinds.length];
    const title = `${groups[i % groups.length]} - ${names[Math.floor(i / kinds.length) % names.length]} ${k.kind}${tags[i % tags.length]}`;
    const items = i % 3 === 2 ? [] : k.shows.map((show, j) => ({
      title: show, episode: `Episode ${1 + ((i + j) % 9)}`, minutes: [30, 60, 30, 45, 90][(i + j) % 5], genre: k.genre,
      summary: `${show}: an invented programme on an invented demo channel.`,
    }));
    l.channels.push({ vcn: 201 + i, title, short: title.split(' - ')[1].slice(0, 8).toUpperCase(), items, offsetMin: (i * 7) % 30 });
  }
}

const CHANNELS = LIVETV ? lib.channels || [] : [];
const TUNE_DELAY_MS = Number(process.env.PLEXLITE_DEMO_TUNE_DELAY ?? 600);
const liveSessions = new Map(); // transcode session uuid -> { uuid, consumer, n, startedAt }

const channelThumb = (n) => model.imagePath(`/library/channels/${n + 1}/thumb`, `gen:channel/${n}`);
const channelByIdentifier = (s) => CHANNELS.findIndex((ch) => String(ch.vcn) === String(s));

function airing(n, slot, t) {
  const ch = CHANNELS[n];
  return { channelIdentifier: String(ch.vcn), channelID: n + 1, channelVcn: String(ch.vcn), channelTitle: `${ch.vcn} ${ch.title}`,
    channelCallSign: ch.title, channelThumb: channelThumb(n), beginsAt: slot.beginsAt, endsAt: slot.endsAt,
    onAir: slot.beginsAt <= t && t < slot.endsAt ? true : undefined };
}

// A grid programme: one per programme and channel, with a Media entry for each of its airings.
function programme(n, slots, opts = {}) {
  const ch = CHANNELS[n];
  const { item: it, key } = slots[0];
  const t = Math.floor(Date.now() / 1000);
  const prog = it.type === 'episode'
    ? { type: 'episode', title: it.title, grandparentTitle: it.grandparentTitle, parentIndex: it.parentIndex, index: it.index,
      thumb: it.thumb, grandparentThumb: it.grandparentThumb }
    : { type: 'movie', title: it.title, year: it.year, thumb: it.art };
  prog.ratingKey = `live-${n + 1}-${key}`;
  prog.key = `/${PROVIDER}/metadata/${prog.ratingKey}`;
  prog.duration = (slots[0].endsAt - slots[0].beginsAt) * 1000;
  if (opts.summary) {
    const show = model.items.get(it.grandparentRatingKey);
    prog.summary = it.summary || (show && show.summary) || `${prog.grandparentTitle || prog.title} on ${ch.title}.`;
  }
  const genres = (ch.genres || []).concat((it.Genre || (model.items.get(it.grandparentRatingKey) || {}).Genre || []).map((g) => g.tag));
  // as on a real Plex DVR: a film's genres are on the airing (XMLTV files tag films "Film"); an
  // episode's are on its show (grandparentRatingKey), which clients look up separately
  if (it.type === 'episode') {
    prog.grandparentRatingKey = liveShowKey(n, it, genres);
  } else {
    prog.Genre = [...new Set(['Film', ...genres])].map((g) => ({ tag: g }));
  }
  prog.Media = slots.map((s) => airing(n, s, t));
  return prog;
}

// Shows of guide programmes, by key: /{provider}/metadata/<key>[,<key>…] answers with their genres.
const liveShows = new Map();
function liveShowKey(n, it, genres) {
  const key = `show-${n + 1}-${slug(it.grandparentTitle || it.title)}`;
  if (!liveShows.has(key)) liveShows.set(key, { ratingKey: key, key: `/${PROVIDER}/metadata/${key}`, type: 'show',
    title: it.grandparentTitle || it.title, Genre: [...new Set(genres)].map((g) => ({ tag: g })) });
  return key;
}

const currentSlot = (n, t = Math.floor(Date.now() / 1000)) => model.schedule(CHANNELS[n]).find((s) => s.beginsAt <= t && t < s.endsAt) || null;

// /{provider}/grid?beginsAt<=T1&endsAt>=T0[&beginsAt>=X][&channel=<channelID>]: the URL keys are
// literally "beginsAt<", "endsAt>" and "beginsAt>". excludeFields/excludeElements are ignored.
function guide(q) {
  if (!LIVETV) return container({});
  const before = Number(q.get('beginsAt<') || Infinity);
  const after = Number(q.get('endsAt>') || -Infinity);
  const startAfter = Number(q.get('beginsAt>') || -Infinity);
  const channelId = q.get('channel');
  const out = [];
  CHANNELS.forEach((ch, n) => {
    if (channelId && String(channelId) !== String(n + 1) && String(channelId) !== String(ch.vcn)) return;
    const groups = new Map();
    for (const slot of model.schedule(ch)) {
      if (!(slot.beginsAt < before && slot.endsAt > after && slot.beginsAt > startAfter)) continue;
      if (!groups.has(slot.key)) groups.set(slot.key, []);
      groups.get(slot.key).push(slot);
    }
    for (const slots of groups.values()) out.push(programme(n, slots));
  });
  return page(out, q, (x) => x);
}

// /{provider}/metadata/live-<channelID>-<key>: the programme with its summary and coming airings.
function liveMetadata(res, ratingKey) {
  if (/^show-/.test(ratingKey)) {
    const shows = decodeURIComponent(ratingKey).split(',').map((k) => liveShows.get(k)).filter(Boolean);
    return send(res, 200, container({ size: shows.length, Metadata: shows }));
  }
  const m = /^live-(\d+)-(.+)$/.exec(ratingKey);
  const n = m ? Number(m[1]) - 1 : -1;
  const slots = n >= 0 && n < CHANNELS.length ? model.schedule(CHANNELS[n]).filter((s) => s.key === m[2]) : [];
  if (!slots.length) return send(res, 404, 'no such programme', 'text/plain');
  const t = Math.floor(Date.now() / 1000);
  const coming = slots.filter((s) => s.endsAt > t).slice(0, 20);
  return send(res, 200, container({ size: 1, Metadata: [programme(n, coming.length ? coming : slots.slice(-1), { summary: true })] }));
}

function lineup() {
  const list = CHANNELS.map((ch, n) => ({ id: String(ch.vcn), gridKey: String(ch.vcn), vcn: String(ch.vcn), title: ch.title, callSign: ch.title, thumb: channelThumb(n) }));
  return container({ size: list.length, Channel: list });
}

// POST /livetv/dvrs/<dvr>/channels/<identifier>/tune. Plex binds the stream to the
// X-Plex-Session-Identifier sent with the tune: it comes back as the consumer in the stream path.
function tune(req, res, q, identifier) {
  const n = channelByIdentifier(identifier);
  const answer = (status, body, type) => (TUNE_DELAY_MS > 0 ? setTimeout(() => send(res, status, body, type), TUNE_DELAY_MS) : send(res, status, body, type));
  if (n < 0) return answer(404, `no channel ${identifier} in the demo lineup`, 'text/plain');
  const ch = CHANNELS[n];
  if (ch.tuneFails) return answer(503, `Could not tune channel ${ch.vcn} (${ch.title}): no signal. The demo always fails this channel, to show the error.`, 'text/plain');
  const uuid = randomUUID();
  const consumer = q.get('X-Plex-Session-Identifier') || req.headers['x-plex-session-identifier'] || randomUUID();
  liveSessions.set(uuid, { uuid, consumer, n, startedAt: Date.now() });
  while (liveSessions.size > 50) liveSessions.delete(liveSessions.keys().next().value);
  const slot = currentSlot(n);
  const now = slot && programme(n, [slot]);
  const key = `/livetv/sessions/${uuid}/${consumer}/index.m3u8`;
  const meta = { ratingKey: now ? now.ratingKey : `live-${n + 1}`, key, type: now ? now.type : 'episode',
    title: now ? now.title : ch.title, grandparentTitle: now ? now.grandparentTitle : undefined,
    Media: [{ uuid, channelIdentifier: String(ch.vcn), Part: [{ key: `${key}?offset=-1.000000` }] }] };
  const timeline = now ? [{ ratingKey: now.ratingKey, type: now.type, title: now.title, grandparentTitle: now.grandparentTitle, beginsAt: slot.beginsAt, endsAt: slot.endsAt }] : [];
  return answer(200, container({ size: 1, MediaSubscription: [{ key: '1', channelIdentifier: String(ch.vcn),
    MediaGrabOperation: [{ Metadata: meta }], Timeline: { Metadata: timeline } }] }));
}

// The live session a /livetv/sessions/<uuid>/<consumer>/... path names, if it is still open.
function liveSessionFor(path) {
  const m = /^\/livetv\/sessions\/([^/]+)\//.exec(path || '');
  return m ? liveSessions.get(m[1]) || null : null;
}

// Desktop Chrome can't play HLS, so a live stream is the WebM of whatever the channel airs now, or
// (for a generated programme) of the channel's first library title with a video, else any video.
function liveVideoPart(n) {
  const partOf = (it) => { const p = it && it.Media && it.Media[0] && it.Media[0].Part[0]; return p && p.video && lib.videos[p.video] ? p : null; };
  const slot = currentSlot(n);
  const own = (slot && partOf(slot.item)) || model.programmes(CHANNELS[n]).map((p) => partOf(p.item)).find(Boolean);
  if (own) return own;
  const all = model.movies.concat(...model.shows.map((s) => model.episodesOf(s))).map(partOf).filter(Boolean);
  return all[n % all.length];
}

function liveStream(res, session, token) {
  if (!session) return send(res, 404, 'no such live TV session (tune the channel again)', 'text/plain');
  const part = liveVideoPart(session.n);
  const local = existsSync(join(MEDIA_DIR, 'videos', part.video + '.webm'));
  res.writeHead(302, { Location: local ? `${part.key}?X-Plex-Token=${encodeURIComponent(token)}` : lib.videos[part.video].url, 'Cache-Control': 'no-store' });
  return res.end();
}

function pms(req, res, path, q) {
  const method = req.method;
  if (path === '/identity') return send(res, 200, container({ machineIdentifier: MACHINE_ID, version: '1.41.0.0-demo', claimed: true }));
  const token = q.get('X-Plex-Token') || req.headers['x-plex-token'] || '';
  if (!token.startsWith('demo')) return send(res, 401, 'unauthorised', 'text/plain');
  let m;
  if (path === '/photo/:/transcode') return photo(res, q);
  if ((m = /^\/library\/parts\/(\d+)\/\d+\/file\.webm$/.exec(path))) return video(req, res, m[1]);
  if (method === 'PUT' && /^\/library\/parts\/\d+$/.test(path)) return send(res, 200, '');
  if ((m = /^\/library\/streams\/(\d+)$/.exec(path))) return subtitles(res, m[1]);
  if ((m = /^\/library\/parts\/(\d+)\/indexes\/sd\/(\d+)$/.exec(path))) return preview(res, m[1], m[2]);
  if (path === '/library/sections') {
    return send(res, 200, container({ size: 2, title1: 'Plex Library', Directory: model.sections.map((s) => ({ ...s, allowSync: false, art: '', thumb: '' })) }));
  }
  if ((m = /^\/library\/sections\/(\d+)\/all$/.exec(path))) {
    return send(res, 200, page(model.filter(model.sectionItems(m[1], q.get('type')), q), q));
  }
  if ((m = /^\/library\/sections\/(\d+)\/firstCharacter$/.exec(path))) {
    const dirs = model.firstCharacter(model.filter(model.sectionItems(m[1], q.get('type')), q));
    return send(res, 200, container({ size: dirs.length, title2: 'By First Letter', Directory: dirs }));
  }
  if ((m = /^\/library\/sections\/(\d+)\/(genre|decade|actor|director|writer|country)$/.exec(path))) {
    const dirs = model.tagDirectory(m[1], m[2]);
    return send(res, 200, container({ size: dirs.length, Directory: dirs }));
  }
  if ((m = /^\/library\/sections\/(\d+)\/collections$/.exec(path))) {
    return send(res, 200, page(m[1] === '1' ? model.collections : [], q));
  }
  if ((m = /^\/library\/collections\/(\d+)\/children$/.exec(path))) {
    const col = model.items.get(m[1]);
    return col ? send(res, 200, page(col._members, q)) : send(res, 404, 'no such collection', 'text/plain');
  }
  if ((m = /^\/hubs\/sections\/(\d+)$/.exec(path))) {
    const hubs = model.sectionHubs(m[1]).map((h) => ({ ...h, Metadata: h.Metadata.map((i) => clean(i, { list: true })) }));
    return send(res, 200, container({ size: hubs.length, Hub: hubs }));
  }
  if (path === '/hubs') {
    const hubs = ['1', '2'].reduce((a, k) => a.concat(model.sectionHubs(k)), []).map((h) => ({ ...h, Metadata: h.Metadata.map((i) => clean(i, { list: true })) }));
    return send(res, 200, container({ size: hubs.length, Hub: hubs }));
  }
  if (path === '/hubs/search') {
    const hubs = model.search(q.get('query')).map((h) => (h.Metadata ? { ...h, Metadata: h.Metadata.map((i) => clean(i, { list: true })) } : h));
    return send(res, 200, container({ size: hubs.length, Hub: hubs }));
  }
  if ((m = /^\/library\/metadata\/(\d+)(\/children|\/related)?$/.exec(path))) {
    const item = model.items.get(m[1]);
    if (!item) return send(res, 404, 'no such item', 'text/plain');
    if (m[2] === '/children') {
      if (item.type === 'show') return send(res, 200, page(item._seasons, q));
      if (item.type === 'season') return send(res, 200, page(item._episodes, q));
      return send(res, 200, container({}));
    }
    if (m[2] === '/related') {
      const hubs = model.related(item).map((h) => ({ ...h, Metadata: h.Metadata.map((i) => clean(i, { list: true })) }));
      return send(res, 200, container({ size: hubs.length, Hub: hubs }));
    }
    return send(res, 200, container({ size: 1, Metadata: [metadataFor(item, q)] }));
  }
  if (path === '/:/scrobble' || path === '/:/unscrobble') {
    const item = model.items.get(q.get('key'));
    const on = path === '/:/scrobble';
    const leaves = !item ? [] : item.type === 'show' ? model.episodesOf(item) : item.type === 'season' ? item._episodes : [item];
    leaves.forEach((e) => { e.viewCount = on ? 1 : undefined; e.viewOffset = undefined; e.lastViewedAt = on ? Math.floor(Date.now() / 1000) : undefined; });
    refreshCounts();
    return send(res, 200, '');
  }
  if (path === '/:/timeline') {
    const item = model.items.get(q.get('ratingKey'));
    const time = Number(q.get('time') || 0);
    if (item && item.duration && (q.get('state') === 'stopped' || q.get('state') === 'paused')) {
      if (time > item.duration * 0.9) { item.viewCount = 1; item.viewOffset = undefined; } else if (time > 60000) item.viewOffset = time;
      item.lastViewedAt = Math.floor(Date.now() / 1000);
      refreshCounts();
    }
    return send(res, 200, container({}));
  }
  if (path === '/playQueues' && method === 'POST') {
    const rk = (/\/library\/metadata\/(\d+)/.exec(q.get('uri') || '') || [])[1];
    const item = model.items.get(rk);
    if (!item) return send(res, 404, 'no such item', 'text/plain');
    const show = item.type === 'show' ? item : item.type === 'episode' ? model.items.get(item.grandparentRatingKey) : null;
    let items = show ? model.episodesOf(show) : [item];
    if (q.get('shuffle') === '1') items = model.sort(items, 'random');
    return send(res, 200, playQueue(q, items, item.type === 'show' ? items[0] : item));
  }
  if ((m = /^\/playQueues\/(\d+)$/.exec(path))) {
    return queues.has(m[1]) ? send(res, 200, queues.get(m[1])) : send(res, 404, 'no such queue', 'text/plain');
  }
  if (path === '/video/:/transcode/universal/decision' && /^\/livetv\/sessions\//.test(q.get('path') || '')) {
    const session = liveSessionFor(q.get('path'));
    if (!session) return send(res, 200, container({ generalDecisionCode: 2000, generalDecisionText: 'This live TV session has ended. Tune the channel again.' }));
    const slot = currentSlot(session.n);
    const now = slot ? programme(session.n, [slot]) : { type: 'episode', title: CHANNELS[session.n].title };
    delete now.Media;
    return send(res, 200, container({ size: 1, generalDecisionCode: 1001, generalDecisionText: 'Direct play not available; Conversion OK.',
      Metadata: [{ ...now, Media: [{ container: 'mpegts', videoCodec: 'h264', audioCodec: 'aac', Part: [{ decision: 'transcode',
        key: `/video/:/transcode/universal/session/${session.consumer}/base/index.m3u8` }] }] }] }));
  }
  // start.webm: the same, for desktop Chromium builds that hand any .m3u8 URL to their own HLS
  // player (the screenshot scripts rewrite the video's src to it)
  if (/^\/video\/:\/transcode\/universal\/start\.(m3u8|webm)$/.test(path) && /^\/livetv\/sessions\//.test(q.get('path') || '')) {
    return liveStream(res, liveSessionFor(q.get('path')), token);
  }
  if (path === '/video/:/transcode/universal/decision') {
    const rk = (/\/library\/metadata\/(\d+)/.exec(q.get('path') || '') || [])[1];
    const item = model.items.get(rk);
    const media = item && item.Media && (item.Media[Number(q.get('mediaIndex') || 0)] || item.Media[0]);
    const part = media && media.Part[0];
    if (!part || !part.video) {
      return send(res, 200, container({ generalDecisionCode: 2000, generalDecisionText: 'This demo title has no video file. Try Big Buck Bunny, Sintel or Tears of Steel.' }));
    }
    return send(res, 200, container({ generalDecisionCode: 1000, generalDecisionText: 'Direct play OK.',
      Metadata: [{ ...clean(item, { list: true }), Media: [{ ...media, Part: [{ ...part, decision: 'directplay' }] }] }] }));
  }
  if ((m = /^\/transcode\/sessions\/([^/]+)$/.exec(path)) && method === 'DELETE') liveSessions.delete(m[1]);
  if (path === '/video/:/transcode/universal/stop' || /^\/transcode\/sessions\//.test(path)) return send(res, 200, '');
  if (path === '/livetv/dvrs') {
    return send(res, 200, container(LIVETV ? { size: 1, Dvr: [{ key: '1', uuid: 'demo-dvr', title: 'Demo tuner', lineupTitle: 'Demo channels' }] } : {}));
  }
  if (path === '/media/providers') {
    return send(res, 200, container({ MediaProvider: [{ identifier: 'com.plexapp.plugins.library', protocols: 'stream,download' }]
      .concat(LIVETV ? [{ identifier: PROVIDER, protocols: 'livetv', title: 'Live TV & DVR' }] : []) }));
  }
  if (path === `/${PROVIDER}/grid`) return send(res, 200, guide(q));
  if (path === `/${PROVIDER}/lineups/dvr/channels`) return send(res, 200, lineup());
  if (path.startsWith(`/${PROVIDER}/metadata/`)) return liveMetadata(res, path.slice(PROVIDER.length + 11));
  if (LIVETV && (m = /^\/livetv\/dvrs\/\d+\/channels\/(.+)\/tune$/.exec(path))) return tune(req, res, q, m[1]);
  if (path === '/livetv/sessions') {
    const list = [...liveSessions.values()].map((s) => {
      const ch = CHANNELS[s.n];
      const slot = currentSlot(s.n);
      return { key: `/livetv/sessions/${s.uuid}/${s.consumer}/index.m3u8`, sessionKey: s.uuid, type: slot ? (slot.item.type === 'episode' ? 'episode' : 'movie') : 'episode',
        title: slot ? slot.item.title : ch.title, grandparentTitle: slot ? slot.item.grandparentTitle : undefined,
        Media: [{ uuid: s.uuid, channelIdentifier: String(ch.vcn), channelTitle: `${ch.vcn} ${ch.title}` }],
        Session: { id: s.consumer, startedAt: Math.floor(s.startedAt / 1000) } };
    });
    return send(res, 200, container({ size: list.length, Metadata: list }));
  }
  if (/^\/livetv\/sessions\/[^/]+\/[^/]+\/index\.m3u8$/.test(path)) return liveStream(res, liveSessionFor(path), token);
  return send(res, 404, `the demo server does not implement ${method} ${path}`, 'text/plain');
}

function refreshCounts() {
  for (const show of model.shows) {
    for (const s of show._seasons) s.viewedLeafCount = s._episodes.filter((e) => e.viewCount).length;
    show.viewedLeafCount = show._seasons.reduce((a, s) => a + s.viewedLeafCount, 0);
  }
}

// ---- plex.tv -------------------------------------------------------------------------------------

const pins = new Map();
const user = lib.user || { title: 'Demo' };
const homeUsers = lib.homeUsers || [{ title: user.title, admin: true }];

function plextv(req, res, path) {
  let m;
  if (path === '/api/v2/user') {
    return send(res, 200, { id: 1, uuid: 'demo-user-0', username: user.title.toLowerCase(), title: user.title, email: 'demo@example.com', authToken: TOKEN });
  }
  if (path === '/api/v2/home/users') {
    return send(res, 200, { id: 1, name: `${user.title}'s Home`, users: homeUsers.map((u, i) => ({ id: i + 1, uuid: `demo-user-${i}`, title: u.title,
      username: u.admin ? user.title.toLowerCase() : '', admin: !!u.admin, restricted: !!u.restricted, protected: !!u.protected, home: true, thumb: '' })) });
  }
  if ((m = /^\/api\/v2\/home\/users\/([\w-]+)\/switch$/.exec(path)) && req.method === 'POST') {
    return send(res, 200, { authToken: `demo-${m[1]}` });
  }
  if (path === '/api/v2/resources') {
    return send(res, 200, [{
      name: SERVER_NAME, product: 'Plex Media Server', productVersion: '1.41.0.0-demo', platform: 'Demo', clientIdentifier: MACHINE_ID,
      provides: 'server', owned: true, accessToken: TOKEN, httpsRequired: false, presence: true,
      connections: [{ protocol: 'http', address: '127.0.0.1', port: PORT, uri: BASE, local: true, relay: false }],
    }]);
  }
  if (path === '/api/v2/pins' && req.method === 'POST') {
    const pin = { id: 4242 + pins.size, code: 'DEMO', createdAt: Date.now() };
    pins.set(String(pin.id), pin);
    return send(res, 201, { id: pin.id, code: pin.code, authToken: null, expiresIn: 900 });
  }
  if ((m = /^\/api\/v2\/pins\/(\d+)$/.exec(path))) {
    const pin = pins.get(m[1]);
    if (!pin) return send(res, 404, { errors: [{ message: 'not found' }] });
    // the demo "approves" a code after 30 seconds, so the whole sign-in flow can be tried
    return send(res, 200, { id: pin.id, code: pin.code, authToken: Date.now() - pin.createdAt > 30000 ? TOKEN : null });
  }
  return send(res, 404, { errors: [{ message: `the demo plex.tv does not implement ${path}` }] });
}

// ---- HTTP ------------------------------------------------------------------------------------------

createServer(async (req, res) => {
  // same DNS-rebinding guard as tools/devserver.mjs
  const origin = req.headers.origin;
  if (req.headers.host !== SELF || (origin && origin !== BASE)) return send(res, 403, '', 'text/plain');
  const url = new URL(req.url, BASE);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return send(res, 400, '', 'text/plain'); }
  try {
    if (path === '/js/dev-config.js') {
      // ?signin on the page: start signed out, to see (and try) the plex.tv/link flow
      const signin = /[?&]signin\b/.test(req.headers.referer || '');
      const server = { name: SERVER_NAME, machineId: MACHINE_ID, uri: BASE, token: TOKEN, kind: 'lan-http' };
      const dev = signin ? { clientId: 'demo-client', plexTv: `${BASE}/plextv` } : { token: TOKEN, clientId: 'demo-client', server, plexTv: `${BASE}/plextv` };
      return send(res, 200, `window.PL_DEV = ${JSON.stringify(dev)};\n`, 'text/javascript');
    }
    if (PMS_PATH.test(path)) return pms(req, res, path, url.searchParams);
    if (path.startsWith('/plextv/')) return plextv(req, res, path.slice(7));
    const file = normalize(join(APP, path === '/' ? 'index.html' : path));
    if (!file.startsWith(APP) || file.includes('/tools/') || file.includes('/.git')) return send(res, 403, '', 'text/plain');
    const body = await readFile(file);
    return send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, 'not found', 'text/plain');
    console.error(e);
    return send(res, 500, 'demo server error', 'text/plain');
  }
}).listen(PORT, '127.0.0.1', () => {
  const missing = Object.keys(lib.media || {}).filter((id) => !mediaFile(id)).length;
  console.log(`Plex Lite demo on ${BASE}  (${model.movies.length} movies, ${model.shows.length} shows)`);
  if (missing) console.log(`${missing} artwork files not downloaded yet: run node tools/demo/fetch-media.mjs (placeholders until then)`);
});
