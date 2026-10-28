// node --test test/ — Live TV Browse's pure rules (js/livetv-browse.js): categories from genres and
// names, channel families from names, the filter, the rail, the chips and the On now shelves.
// Every channel name here is invented.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const ctx = { window: {} };
vm.runInContext(readFileSync(here + '../js/livetv-browse.js', 'utf8'), vm.createContext(ctx));
const B = ctx.window.PL.liveBrowse;
const plain = (x) => JSON.parse(JSON.stringify(x));
const ch = (identifier, title) => ({ identifier: String(identifier), title });

test('categories from genres: priority, documentary features, unknown tags', () => {
  assert.equal(B.categoryOfGenres(['Children', 'Movie']), 'kids');
  assert.equal(B.categoryOfGenres('News, News & Documentary'), 'news');
  assert.equal(B.categoryOfGenres(['News & Documentary']), 'documentaries');
  assert.equal(B.categoryOfGenres(['News & Documentary', 'Religion']), 'religious');
  assert.equal(B.categoryOfGenres(['Feature', 'News & Documentary']), 'documentaries');
  assert.equal(B.categoryOfGenres(['Feature', 'Drama']), 'movies');
  assert.equal(B.categoryOfGenres(['Film', 'Factual']), 'movies');
  assert.equal(B.categoryOfGenres(['American Football', 'Sports']), 'sport');
  assert.equal(B.categoryOfGenres(['Shopping', 'Specialist']), 'shopping');
  assert.equal(B.categoryOfGenres(['Comedy', 'Entertainment']), 'entertainment');
  assert.equal(B.categoryOfGenres(['Rock&Pop']), 'music');
  assert.equal(B.categoryOfGenres(['sports']), 'sport'); // a proxy's own lower-case category
  assert.equal(B.categoryOfGenres(['Weird Tag']), null);
  assert.equal(B.categoryOfGenres([]), null);
  assert.equal(B.categoryOfGenres(''), null);
});

test('categories from names, when the guide says nothing', () => {
  assert.equal(B.categoryOfName('ZX - Harbour News HD'), 'news');
  assert.equal(B.categoryOfName('Comet Sports 2'), 'sport');
  assert.equal(B.categoryOfName('Bramble Kids'), 'kids');
  assert.equal(B.categoryOfName('Orbit Cinema Action'), 'movies');
  assert.equal(B.categoryOfName('Lantern Film4'), 'movies');
  assert.equal(B.categoryOfName('Granite Reality'), 'entertainment');
  assert.equal(B.categoryOfName('Velvet'), null);
});

test('a channel\'s category: most airtime, shopping counts a quarter, names below an hour', () => {
  assert.equal(B.pickCategory({ movies: 5400, entertainment: 3600 }, 'Velvet One'), 'movies');
  // three hours of overnight teleshopping don't make a film channel a shopping channel
  assert.equal(B.pickCategory({ shopping: 10800, movies: 5400 }, 'Velvet One'), 'movies');
  assert.equal(B.pickCategory({ shopping: 36000 }, 'Shop Direct'), 'shopping');
  // a tie goes to the genre rules' priority (sport before entertainment)
  assert.equal(B.pickCategory({ entertainment: 3600, sport: 3600 }, 'x'), 'sport');
  // too little guide data: the name decides when it can
  assert.equal(B.pickCategory({ entertainment: 600 }, 'Comet News'), 'news');
  assert.equal(B.pickCategory({ entertainment: 600 }, 'Velvet'), 'entertainment');
  assert.equal(B.pickCategory({}, 'Velvet'), null);
  assert.equal(B.pickCategory(null, 'Granite Sport'), 'sport');
});

test('saved tallies decay by half and add what was seen', () => {
  assert.deepEqual(plain(B.blendTally({ news: 3600 }, { news: 7200, sport: 100 })), { news: 7200 });
  assert.deepEqual(plain(B.blendTally(null, { movies: 4000 })), { movies: 2000 });
  assert.deepEqual(plain(B.blendTally({ kids: 1800 }, null)), { kids: 1800 });
});

const LINEUP = [
  ch(1, 'ZX - ORBIT ONE'), ch(2, 'ZX - ORBIT ONE +1'), ch(3, 'ZX - ORBIT MAX'),
  ch(4, 'ZX - ORBIT SPORTS MAIN EVENT'), ch(5, 'ZX - ORBIT SPORTS FOOTBALL'), ch(6, 'ZX - ORBIT SPORTS GOLF'), ch(7, 'ZX - Orbit Sport+ 1'),
  ch(8, 'ZX - ORBIT CINEMA ACTION'), ch(9, 'ZX - ORBIT CINEMA COMEDY'), ch(10, 'ZX - ORBIT CINEMA DRAMA HD'),
  ch(11, 'ZX - NLT1'), ch(12, 'ZX - NLT2'), ch(13, 'ZX - NLT3 HD'), ch(14, 'ZX - NLT4'),
  ch(15, 'QV - GA WAVE NEWS'), ch(16, 'QV - GA WAVE ARABIC'), ch(17, 'QV - GA WAVE DOCS'),
  ch(18, 'ZX - PIONEER'), ch(19, 'ZX - PIONEER +1'), ch(20, 'ZX - PIONEER HD'), // one channel, three versions
  ch(21, 'ZX - THE COMET CHANNEL'), ch(22, 'ZX - COMET KIDS'), ch(23, 'ZX - COMET GOLD'),
  ch(24, 'ZX - VELVET'), ch(25, 'ZX - SHOP DIRECT'), ch(26, 'ZX - NEWS ONE (EAST)'),
];

test('families: shared leading words, 3+ different channels, sub-families, labels', () => {
  const f = B.families(LINEUP);
  const byLabel = Object.fromEntries(f.list.map((x) => [x.label, x]));
  assert.deepEqual(plain(f.list.map((x) => x.label)), ['Orbit', 'NLT', 'Comet', 'GA Wave']);
  const orbit = byLabel.Orbit;
  assert.equal(orbit.ids.length, 10);
  // SPORTS and Sport+ are one sub-family (a plural is its singular when both are in the lineup);
  // the label is the most common spelling; numbered siblings and two-channel groups don't split
  assert.deepEqual(plain(orbit.subs.map((s) => [s.label, s.ids.length])), [['Orbit Sports', 4], ['Orbit Cinema', 3]]);
  // glued numbers split off (NLT1 -> NLT 1): one family, no sub-families
  assert.equal(byLabel.NLT.ids.length, 4);
  assert.equal(byLabel.NLT.subs.length, 0);
  // a one- or two-letter first word keeps the next word in the key
  assert.equal(byLabel['GA Wave'].key, 'GA WAVE');
  // "THE … CHANNEL" stop words don't hide the brand
  assert.deepEqual(plain(byLabel.Comet.ids), ['21', '22', '23']);
  // the HD and +1 versions of one channel are not a family
  assert.equal(f.of['18'], undefined);
  assert.deepEqual(plain(f.of['5']), ['ORBIT', 'ORBIT SPORT']);
  assert.deepEqual(plain(f.of['1']), ['ORBIT', null]);
  assert.equal(f.of['24'], undefined);
  // a lower minimum finds more
  assert.ok(B.families(LINEUP, 2).list.length >= f.list.length);
});

test('label casing: acronyms stay, words get a capital', () => {
  assert.equal(B.caseWord('ORBIT'), 'Orbit');
  assert.equal(B.caseWord('NLT'), 'NLT');
  assert.equal(B.caseWord('ZBC'), 'ZBC');
  assert.equal(B.caseWord('SKY'.replace('S', 'R')), 'Rky');
  assert.equal(B.caseWord('QPNX'), 'QPNX');
  assert.equal(B.caseWord('Velvet'), 'Velvet');
  assert.equal(B.caseWord('4'), '4');
});

test('timeshifts and relatives lend a category to channels without one', () => {
  assert.equal(B.isTimeshift('ZX - ORBIT ONE +1'), true);
  assert.equal(B.isTimeshift('ZX - Orbit Sport+ 1'), false);
  const fams = B.families(LINEUP);
  const cat = { 1: 'entertainment', 4: 'sport', 5: 'sport', 8: 'movies', 9: 'movies', 11: 'entertainment', 12: 'news' };
  const gained = B.inherit(cat, LINEUP, fams);
  assert.equal(cat['2'], 'entertainment'); // ORBIT ONE +1 from ORBIT ONE
  assert.equal(cat['6'], 'sport');         // from its sub-family
  assert.equal(cat['10'], 'movies');
  assert.equal(cat['13'], undefined);       // NLT is split 1:1, no verdict
  assert.equal(cat['24'], undefined);       // no family
  assert.ok(gained >= 4);
});

function makeCtx(over = {}) {
  const fams = B.families(LINEUP);
  return {
    fav: { 5: true, 22: true },
    cat: { 1: 'entertainment', 2: 'entertainment', 3: 'entertainment', 4: 'sport', 5: 'sport', 6: 'sport', 7: 'sport',
      8: 'movies', 9: 'movies', 10: 'movies', 11: 'entertainment', 12: 'entertainment', 15: 'news', 22: 'kids', 26: 'news' },
    fam: fams.of,
    families: fams.list,
    onNow: { 1: true, 4: true, 5: true, 8: true, 15: true },
    ...over,
  };
}

test('the filter: a rail choice, optionally refined by the other dimension', () => {
  const c = makeCtx();
  const ids = (sel) => plain(B.filter(LINEUP, sel, c).map((x) => x.identifier));
  assert.equal(ids({ base: 'all' }).length, LINEUP.length);
  assert.deepEqual(ids({ base: 'fav' }), ['5', '22']);
  assert.deepEqual(ids({ base: 'now' }), ['1', '4', '5', '8', '15']);
  assert.deepEqual(ids({ base: 'c:sport' }), ['4', '5', '6', '7']);
  assert.deepEqual(ids({ base: 'f:ORBIT CINEMA' }), ['8', '9', '10']);
  assert.deepEqual(ids({ base: 'f:ORBIT', refine: 'c:sport' }), ['4', '5', '6', '7']);
  assert.deepEqual(ids({ base: 'c:entertainment', refine: 'f:NLT' }), ['11', '12']);
  assert.deepEqual(ids({ base: 'c:news', refine: 'f:ORBIT' }), []);
});

test('labels, validity and stored filters', () => {
  const c = makeCtx();
  assert.equal(B.label('c:sport', c), 'Sport');
  assert.equal(B.label('f:ORBIT SPORT', c), 'Orbit Sports');
  assert.equal(B.selLabel({ base: 'c:movies', refine: 'f:ORBIT CINEMA' }, c), 'Movies › Orbit Cinema');
  assert.equal(B.selLabel({ base: 'all' }, c), 'All channels');
  assert.equal(B.allLabel('c:sport', c), 'All sport');
  assert.equal(B.allLabel('f:ORBIT', c), 'All Orbit');
  assert.equal(B.valid('f:GONE', c), false);
  assert.deepEqual(plain(B.normalise({ base: 'f:GONE', refine: 'c:sport' }, c)), { base: 'all', refine: 'c:sport' });
  assert.deepEqual(plain(B.normalise({ base: 'now', refine: 'c:sport' }, c)), { base: 'now', refine: null });
  assert.equal(B.fromLegacy('sports'), 'c:sport');
  assert.equal(B.fromLegacy('favourites'), 'fav');
  assert.equal(B.fromLegacy('nonsense'), 'all');
});

test('the rail: counts, headings, sub-families indented, empty choices left out', () => {
  const rail = B.railEntries(LINEUP, makeCtx());
  const keys = rail.map((e) => e.key);
  assert.deepEqual(plain(keys.slice(0, 4)), ['fav', 'all', 'now', 'h:categories']);
  assert.deepEqual(plain(rail.slice(0, 3).map((e) => e.count)), [2, 26, 5]);
  const cats = rail.filter((e) => e.key.startsWith('c:')).map((e) => [e.label, e.count]);
  assert.deepEqual(plain(cats), [['Entertainment', 5], ['Movies', 3], ['Sport', 4], ['News', 2], ['Kids', 1]]);
  const i = keys.indexOf('f:ORBIT');
  assert.ok(i > keys.indexOf('h:families'));
  assert.deepEqual(plain(rail.slice(i, i + 3).map((e) => [e.label, !!e.sub])), [['Orbit', false], ['Orbit Sports', true], ['Orbit Cinema', true]]);
  const none = B.railEntries(LINEUP, makeCtx({ fav: {}, onNow: {} }));
  assert.equal(none[0].key, 'all');
  assert.equal(none.some((e) => e.key === 'now' || e.key === 'fav'), false);
});

test('chips: a category\'s families, a family\'s categories, All\'s categories', () => {
  const c = makeCtx();
  // Entertainment: Orbit (1, 2, 3) and NLT (11, 12): families with 2+ channels, largest first
  assert.deepEqual(plain(B.chips('c:entertainment', LINEUP, c)), [
    { key: 'f:ORBIT', label: 'Orbit', count: 3 }, { key: 'f:NLT', label: 'NLT', count: 2 },
  ]);
  // Sport: all four are Orbit Sports, i.e. the whole choice: nothing to refine
  assert.deepEqual(plain(B.chips('c:sport', LINEUP, c)), []);
  // Orbit: its categories in rail order
  assert.deepEqual(plain(B.chips('f:ORBIT', LINEUP, c).map((x) => [x.label, x.count])), [['Entertainment', 3], ['Movies', 3], ['Sport', 4]]);
  // All channels: the categories
  assert.deepEqual(plain(B.chips('all', LINEUP, c).map((x) => x.key)), ['c:entertainment', 'c:movies', 'c:sport', 'c:news']);
  assert.deepEqual(plain(B.chips('now', LINEUP, c)), []);
});

test('On now shelves: Favourites first, then by the programme\'s own category', () => {
  const c = makeCtx();
  const items = [
    { channel: LINEUP[0], airing: { title: 'a' }, cat: 'movies' }, // a film on an entertainment channel
    { channel: LINEUP[3], airing: { title: 'b' }, cat: null },     // no genre: its channel's
    { channel: LINEUP[4], airing: { title: 'c' }, cat: 'sport' },
    { channel: LINEUP[23], airing: { title: 'd' }, cat: null },    // nothing known: no shelf
  ];
  const shelves = B.shelves(items, c);
  assert.deepEqual(plain(shelves.map((s) => [s.key, s.items.length])), [['fav', 1], ['c:movies', 1], ['c:sport', 2]]);
});
