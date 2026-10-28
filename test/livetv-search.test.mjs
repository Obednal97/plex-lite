// node --test test/ — Search's Live TV matching (js/livetv-search.js): channel names (IPTV group
// prefixes, quality tags, numbers as digits or words), channel numbers, and guide programmes.
// Made-up channels and programmes only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const PL = { plex: {}, storage: { get: () => null, set() {} }, log() {}, warn() {} };
const ctx = vm.createContext({ window: { PL }, PL, console, Date, Math, Promise, setTimeout, clearTimeout });
for (const f of ['fuzzy.js', 'livetv-logic.js', 'livetv-search.js']) vm.runInContext(readFileSync(here + '../js/' + f, 'utf8'), ctx);
const S = PL.liveSearch;
const plain = (x) => JSON.parse(JSON.stringify(x)); // arrays from the vm are another realm's

const ch = (vcn, title) => ({ identifier: String(vcn), vcn: String(vcn), title, name: title });
const CHANNELS = [
  ch(101, 'XY - Harbour News HD'),
  ch(102, 'XY - Harbour News 2'),
  ch(103, 'XY - Granite One'),
  ch(104, 'XY - Granite2'),
  ch(105, 'XY - Velvet Movies'),
  ch(106, 'ZZ - Velvet Movies +1'),
  ch(107, 'XY - Comet Kids'),
  ch(110, 'XY - Orchard Sport 1 FHD'),
  ch(111, 'XY - Orchard Sport 2'),
  ch(1001, 'Lantern Shopping'),
];
const index = S.indexChannels(CHANNELS);
const names = (text, opts) => plain(S.matchChannels(index, S.query(text), opts).map((c) => c.vcn));

test('channel names lose the group prefix and quality tags', () => {
  assert.equal(S.cleanName('XY - Harbour News HD'), 'Harbour News');
  assert.equal(S.cleanName('XY | Orchard Sport 1 FHD'), 'Orchard Sport 1');
  assert.equal(S.cleanName('Comet Kids (HD)'), 'Comet Kids');
  assert.equal(S.cleanName('HD'), 'HD', 'never empties a name');
  assert.equal(S.cleanName('Lantern Shopping'), 'Lantern Shopping');
});

test('numbers match as digits or words', () => {
  assert.equal(S.swapNumbers('granite one'), 'granite 1');
  assert.equal(S.swapNumbers('orchard sport 2'), 'orchard sport two');
  assert.equal(S.swapNumbers('route 66'), 'route 66');
  assert.deepEqual(names('granite 1'), ['103']);
  assert.deepEqual(names('granite one'), ['103']);
  assert.equal(names('granite two')[0], '104', '"Granite2" splits into "granite 2"');
  assert.equal(names('orchard sport one')[0], '110');
});

test('name matches: prefix, word start, group, typo', () => {
  assert.deepEqual(names('harbour'), ['101', '102']);
  assert.deepEqual(names('harbour news'), ['101', '102'], 'the quality tag does not stop an exact match');
  assert.deepEqual(names('news'), ['101', '102'], 'word start');
  assert.deepEqual(names('velvet'), ['105', '106']);
  assert.equal(names('xy granite')[0], '103', 'the whole title, group included, still matches');
  assert.deepEqual(names('harbuor news'), ['101', '102'], 'typo');
  assert.deepEqual(names('nothing like it'), []);
});

test('typo matches are dropped when there are real ones', () => {
  // "comet" is an exact word; "conet" style near misses of other names must not join it
  const idx = S.indexChannels([ch(1, 'Comet Kids'), ch(2, 'Comic Gold')]);
  assert.deepEqual(plain(S.matchChannels(idx, S.query('comet'))).map((c) => c.vcn), ['1']);
  assert.deepEqual(plain(S.matchChannels(idx, S.query('comec'))).map((c) => c.vcn), ['1', '2'], 'with only typo matches, they all count');
});

test('channel numbers: exact first, then numbers that start with the digits', () => {
  assert.equal(names('105')[0], '105');
  assert.deepEqual(names('11'), ['110', '111']);
  assert.equal(names('1001')[0], '1001');
  assert.ok(names('1').length >= 9, 'one digit lists the channels starting with it');
});

test('favourites win ties', () => {
  const fav = (id) => id === '102';
  assert.deepEqual(names('harbour', { isFavourite: fav }), ['102', '101']);
  assert.equal(names('xy', { limit: 3 }).length, 3, 'limit');
});

test('empty queries and empty indexes', () => {
  assert.equal(S.query('   '), null);
  assert.equal(S.matchChannels(index, null).length, 0);
  assert.equal(S.matchChannels([], S.query('news')).length, 0);
  assert.equal(S.matchProgrammes(S.indexGuide([], () => [], 0), S.query('news'), 0).length, 0);
});

// ---- programmes ----------------------------------------------------------------------------------

const NOW = 1_800_000_000;
const air = (b, e, title) => ({ b: NOW + b * 60, e: NOW + e * 60, title, sub: '', type: 'episode' });
const AIRINGS = {
  101: [air(-30, 30, 'Harbour Headlines'), air(30, 60, 'Weather Watchers'), air(60, 120, 'Harbour Headlines')],
  102: [air(-90, -30, 'Old Bulletin'), air(-30, 10, 'Weather Watchers'), air(10, 40, 'Harbour Headlines')],
  105: [air(-60, 60, 'The Lighthouse Keeper'), air(60, 180, 'Lighthouse Keeper II')],
  107: [air(0, 30, 'Comet Crew'), air(30, 60, 'Comet Crew'), air(240, 270, 'Lighthouse Kids')],
};
const guide = S.indexGuide(CHANNELS, (id) => AIRINGS[id] || [], NOW, {});
const shows = (text, now = NOW) => plain(S.matchProgrammes(guide, S.query(text), now)).map((h) => `${h.c.vcn} ${h.a.title} ${h.onNow ? 'now' : (h.a.b - NOW) / 60}`);

test('the guide index keeps the first airing of each title per channel, on now or later', () => {
  assert.equal(guide.titles.length, 6, 'Old Bulletin has ended; repeats are one title');
  const headlines = guide.titles.find((t) => t.title === 'Harbour Headlines');
  assert.deepEqual(plain(headlines.hits).map((h) => h.c.vcn + '@' + (h.a.b - NOW) / 60), ['101@-30', '102@10']);
  assert.equal(guide.airings, 8);
});

test('programmes: on now first within a score, then the soonest', () => {
  assert.deepEqual(shows('harbour'), ['101 Harbour Headlines now', '102 Harbour Headlines 10']);
  assert.deepEqual(shows('weather'), ['102 Weather Watchers now', '101 Weather Watchers 30']);
  assert.deepEqual(shows('comet'), ['107 Comet Crew now'], 'one airing per channel');
});

test('programmes: article, word start and typo, best match first', () => {
  assert.deepEqual(shows('lighthouse keeper'), ['105 The Lighthouse Keeper now', '105 Lighthouse Keeper II 60']);
  assert.deepEqual(shows('lighthouse'), ['105 The Lighthouse Keeper now', '105 Lighthouse Keeper II 60', '107 Lighthouse Kids 240']);
  assert.deepEqual(shows('keeper'), ['105 The Lighthouse Keeper now', '105 Lighthouse Keeper II 60']);
  assert.deepEqual(shows('ligthouse keeper').slice(0, 1), ['105 The Lighthouse Keeper now']);
});

test('programmes: letters across words don\'t join word matches', () => {
  const a3 = { 101: [air(0, 60, 'Star Quiz'), air(60, 120, 'The Lost Art')] };
  const g = S.indexGuide(CHANNELS, (id) => a3[id] || [], NOW, {});
  assert.deepEqual(plain(S.matchProgrammes(g, S.query('star'), NOW)).map((h) => h.a.title), ['Star Quiz']);
});

test('programmes that ended since the index was built are skipped', () => {
  assert.deepEqual(shows('weather', NOW + 15 * 60), ['101 Weather Watchers 30']);
});

test('the title cache is reused between builds', () => {
  const cache = {};
  S.indexGuide(CHANNELS, (id) => AIRINGS[id] || [], NOW, cache);
  const p = cache['$Comet Crew'];
  const again = S.indexGuide(CHANNELS, (id) => AIRINGS[id] || [], NOW, cache);
  assert.equal(again.titles.find((t) => t.title === 'Comet Crew').p, p);
  assert.equal(S.trimCache(cache), cache);
  assert.notEqual(S.trimCache({ size: 7000 }), cache);
});

test('600 channels and a day of guide: a keystroke stays cheap', () => {
  const many = [];
  const airings = {};
  const words = ['Harbour', 'Granite', 'Velvet', 'Comet', 'Orchard', 'Lantern', 'Meadow', 'Summit', 'Copper', 'Willow'];
  const kinds = ['News', 'Movies', 'Sport', 'Kids', 'Music', 'Drama', 'Comedy', 'Docs'];
  for (let i = 0; i < 600; i++) {
    const c = ch(1000 + i, `G${i % 5} - ${words[i % 10]} ${kinds[i % 8]} ${1 + (i % 4)}${i % 3 ? ' HD' : ''}`);
    many.push(c);
    if (i % 3 === 2) continue; // a third without guide data
    airings[c.identifier] = [];
    for (let k = 0; k < 24; k++) airings[c.identifier].push(air(k * 60 - 30, k * 60 + 30, `${words[(i + k) % 10]} ${kinds[(i * 7 + k) % 8]} Show ${k % 12}`));
  }
  const t0 = performance.now();
  const ci = S.indexChannels(many);
  const gi = S.indexGuide(many, (id) => airings[id] || [], NOW, {});
  const built = performance.now() - t0;
  const qs = ['h', 'ha', 'har', 'harb', 'harbo', 'harbou', 'harbour', 'harbour n', 'harbour ne', 'harbour new', 'harbour news'];
  const t1 = performance.now();
  for (const text of qs) {
    const q = S.query(text);
    S.matchChannels(ci, q);
    S.matchProgrammes(gi, q, NOW);
  }
  const per = (performance.now() - t1) / qs.length;
  console.log(`  600 channels, ${gi.titles.length} titles, ${gi.airings} airings: index ${built.toFixed(1)} ms, ${per.toFixed(2)} ms a keystroke (node)`);
  assert.ok(per < 15, `a keystroke took ${per} ms in node`);
  assert.equal(S.matchChannels(ci, S.query('harbour news 1'))[0].title.indexOf('Harbour News 1') !== -1, true);
});

// ---- order: TV rows first when the query is about channels ---------------------------------------

test('TV rows first: a channel word or number starts with the query, and no title is exactly it', () => {
  const first = (text, titleBest = 0) => {
    const q = S.query(text);
    return S.channelsFirst(q, S.matchChannels(index, q).best, titleBest);
  };
  assert.equal(first('harbour'), true, 'channel name prefix');
  assert.equal(first('news'), true, 'channel word start');
  assert.equal(first('news', 900), true, 'even when a title starts with it');
  assert.equal(first('news', 1000), false, 'an exact title wins');
  assert.equal(first('105'), true, 'a channel number');
  assert.equal(first('11'), true, 'two digits starting channel numbers');
  assert.equal(first('1'), false, 'one digit says too little');
  assert.equal(first('ha'), false, 'two letters say too little');
  assert.equal(first('harbuor'), false, 'a typo match is not enough');
  assert.equal(first('arbour'), false, 'inside a word is not enough');
  assert.equal(first('lighthouse'), false, 'no channel');
});

test('titleScore: the fuzzy score of a library title or its original title', () => {
  const q = S.query('newsroom');
  assert.equal(S.titleScore({ title: 'The Newsroom' }, q), 1000);
  assert.equal(S.titleScore({ title: 'Other', originalTitle: 'Newsroom Stories' }, q), 895);
  assert.equal(S.titleScore(null, q), 0);
});

test('guide filler and channel numbers are not programmes', () => {
  const air2 = { 101: [air(0, 60, '..programmes start at 7.00pm'), air(60, 120, 'Harbour 100 Club')] };
  const g = S.indexGuide(CHANNELS, (id) => air2[id] || [], NOW, {});
  assert.deepEqual(plain(g.titles.map((t) => t.title)), ['Harbour 100 Club']);
  assert.equal(S.matchProgrammes(g, S.query('1001'), NOW).length, 0, 'no near misses for digits');
  assert.equal(S.matchProgrammes(g, S.query('100'), NOW).length, 1, 'a number in the title still matches');
});

// ---- logo plates (js/logos.js) -------------------------------------------------------------------

test('logo tone: white logos on transparent backgrounds need the dark plate', () => {
  const lctx = vm.createContext({ PL: { el() {} }, document: {}, Math });
  vm.runInContext(readFileSync(here + '../js/logos.js', 'utf8'), lctx);
  const tone = lctx.PL.logos.tone;
  const img = (fill) => { const d = new Uint8ClampedArray(32 * 16 * 4); for (let i = 0; i < 32 * 16; i++) d.set(fill(i), i * 4); return d; };
  const CLEAR = [0, 0, 0, 0];
  assert.equal(tone(img((i) => (i % 3 ? CLEAR : [255, 255, 255, 255]))), 'light', 'white text on transparent');
  assert.equal(tone(img((i) => (i % 3 ? CLEAR : [230, 232, 236, 255]))), 'light', 'light grey / silver');
  assert.equal(tone(img((i) => (i % 3 ? CLEAR : [20, 30, 120, 255]))), 'dark', 'dark blue text');
  assert.equal(tone(img((i) => (i % 3 ? CLEAR : (i % 2 ? [255, 255, 255, 255] : [200, 20, 20, 255])))), 'dark', 'half white, half red: the light plate still shows the red');
  assert.equal(tone(img(() => [255, 255, 255, 255])), 'dark', 'an opaque logo brings its own background');
  assert.equal(tone(img(() => CLEAR)), 'dark', 'nothing drawn');
});
