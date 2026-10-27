// node test/fuzzy.test.mjs — loads js/fuzzy.js into a sandbox with a stub PL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = readFileSync(here + '../js/fuzzy.js', 'utf8');

const store = {};
let quotaFull = false;
let warnings = 0;
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { if (quotaFull) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const PL = {
  storage: { get: () => null, set() {} },
  plex: { server: { machineId: 'm1' }, token: 'account-token-A', get: () => Promise.resolve({ totalSize: 0, Metadata: [] }) },
  app: { sections: [] },
  log() {},
  warn() { warnings++; },
};
const ctx = vm.createContext({ PL, console, Date, Math, Promise, setTimeout, clearTimeout, localStorage });
vm.runInContext(src, ctx);
const fuzzy = PL.fuzzy;
const query = (q, n) => JSON.parse(JSON.stringify(fuzzy.query(q, n)));

const titles = [
  ['1', 'movie', 'Interstellar', 2014],
  ['2', 'movie', 'The Godfather', 1972],
  ['3', 'movie', 'The Godfather Part II', 1974],
  ['4', 'movie', 'The Lord of the Rings: The Fellowship of the Ring', 2001],
  ['5', 'movie', 'Spider-Man: No Way Home', 2021],
  ['6', 'movie', 'Spider-Man', 2002],
  ['7', 'movie', 'Amélie', 2001, '', '', "Le Fabuleux Destin d'Amélie Poulain"],
  ['8', 'show', 'The Office (US)', 2005],
  ['9', 'show', 'The Big Bang Theory', 2007],
  ['10', 'movie', 'Inception', 2010],
  ['11', 'movie', 'Fast & Furious', 2009],
  ['12', 'movie', "Schindler's List", 1993],
  ['13', 'show', 'Office Space Stories', 2019],
  ['14', 'movie', 'Alien', 1979],
  ['15', 'movie', 'Aliens', 1986],
  ['16', 'movie', 'Up', 2009],
  ['17', 'show', 'Breaking Bad', 2008],
].map((r) => [r[0], r[1], r[2], r[3], r[4] || '', r[5] || '', r[6] || '']);

fuzzy.CHUNK = 5; // force several slices
const pending = fuzzy.setRows(titles);
assert.equal(fuzzy.ready, true);
assert.equal(fuzzy.complete, false);
assert.ok(fuzzy.entries.length === 5, 'first slice prepared synchronously');
fuzzy.query('godfather', 10); // searching a partly prepared index works
assert.equal(await pending, true);
assert.equal(fuzzy.complete, true);
const top = (q, n = 1) => query(q, 10).slice(0, n).map((i) => i.title);
const has = (q, title) => query(q, 10).some((i) => i.title === title);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok', name);
}

check('exact', () => assert.deepEqual(top('interstellar'), ['Interstellar']));
check('typo intersteller', () => assert.deepEqual(top('intersteller'), ['Interstellar']));
check('typo godfathr', () => assert.equal(top('godfathr')[0], 'The Godfather'));
check('partial while typing', () => assert.equal(top('interst')[0], 'Interstellar'));
check('initials lotr', () => assert.equal(top('lotr')[0], 'The Lord of the Rings: The Fellowship of the Ring'));
check('initials tbbt', () => assert.equal(top('tbbt')[0], 'The Big Bang Theory'));
check('spider man -> Spider-Man first (shorter)', () => assert.deepEqual(top('spider man', 2), ['Spider-Man', 'Spider-Man: No Way Home']));
check('spiderman without space', () => assert.ok(has('spiderman', 'Spider-Man')));
check('diacritics amelie', () => assert.equal(top('amelie')[0], 'Amélie'));
check('original title', () => assert.ok(has('fabuleux destin', 'Amélie')));
check('the office', () => assert.equal(top('the office')[0], 'The Office (US)'));
check('office ranks exact-ish before word match', () => assert.deepEqual(top('office', 2), ['The Office (US)', 'Office Space Stories']));
check('ampersand', () => assert.ok(has('fast and furious', 'Fast & Furious')));
check('apostrophe', () => assert.ok(has('schindlers', "Schindler's List")));
check('word order', () => assert.ok(has('bad breaking', 'Breaking Bad')));
check('single letter a', () => {
  const r = top('a', 3);
  assert.ok(r.length > 0 && r.every((t) => /^a/i.test(t.replace(/^the /i, ''))), JSON.stringify(r));
});
check('single letter u -> Up', () => assert.equal(top('u')[0], 'Up'));
check('alien before aliens', () => assert.deepEqual(top('alien', 2), ['Alien', 'Aliens']));
check('empty query', () => { assert.deepEqual(query('', 10), []); assert.deepEqual(query('   ', 10), []); });
check('punctuation only', () => assert.deepEqual(query('!!', 10), []));
check('nonsense', () => assert.deepEqual(query('zzqxv', 10), []));
check('no false fuzzy on short tokens', () => assert.ok(!has('upx', 'Up')));
check('items carry ratingKey and type', () => {
  const r = query('breaking', 1)[0];
  assert.equal(r.ratingKey, '17');
  assert.equal(r.type, 'show');
});

// ---- incremental preparation gives the same results as one big slice ------------------------------
const qs = ['interst', 'intersteller', 'godfathr', 'lotr', 'tbbt', 'spider man', 'spiderman', 'amelie', 'the office', 'a', 'u', 'alien', 'bad breaking', 'fast and furious'];
const sliced = qs.map((q) => query(q, 10));
fuzzy.CHUNK = 1e9;
await fuzzy.setRows(titles);
check('incremental == single-slice results', () => assert.deepEqual(qs.map((q) => query(q, 10)), sliced));
fuzzy.CHUNK = 150;

// ---- a refresh of an existing index is built aside and swapped in whole ------------------------------
fuzzy.CHUNK = 3;
const refreshed = titles.concat([['99', 'movie', 'Interstellar Wars', 2030, '', '', '']]);
const swap = fuzzy.setRows(refreshed);
check('refresh keeps the old index searchable meanwhile', () => {
  assert.equal(fuzzy.complete, true);
  assert.equal(fuzzy.entries.length, titles.length);
  assert.deepEqual(top('interstellar', 5), ['Interstellar']);
});
await swap;
check('refresh swaps in when complete', () => assert.deepEqual(top('interstellar', 5), ['Interstellar', 'Interstellar Wars']));
fuzzy.CHUNK = 150;

// ---- reset, per-account cache, quota ----------------------------------------------------------------
const cacheRows = titles.map((r) => r.slice());
store['pl.fuzzy.v2'] = 'stale';
fuzzy.reset();
check('reset clears memory and storage', () => {
  assert.equal(fuzzy.ready, false);
  assert.deepEqual(query('interstellar', 10), []);
  assert.ok(!('pl.fuzzy.v2' in store));
});
// a cache written for account A
fuzzy.setRows(cacheRows, Date.now());
const h = (t) => { let x = 0x811c9dc5; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = (x + ((x << 1) + (x << 4) + (x << 7) + (x << 8) + (x << 24))) >>> 0; } return x.toString(36); };
store['pl.fuzzy.v2'] = JSON.stringify({ a: Date.now(), s: 'm1:' + h('account-token-A'), r: cacheRows });
fuzzy.reset();
store['pl.fuzzy.v2'] = JSON.stringify({ a: Date.now(), s: 'm1:' + h('account-token-A'), r: cacheRows });
check('cache never stores the token', () => assert.ok(!store['pl.fuzzy.v2'].includes('account-token-A')));
await fuzzy.ensure();
await new Promise((r) => setTimeout(r, 20));
check('same account loads the cache', () => assert.equal(top('interstellar')[0], 'Interstellar'));
fuzzy.reset();
store['pl.fuzzy.v2'] = JSON.stringify({ a: Date.now(), s: 'm1:' + h('account-token-A'), r: cacheRows });
PL.plex.token = 'account-token-B';
await fuzzy.ensure(); // builds from the (stub, empty) server instead
check('other account ignores the cache', () => assert.deepEqual(query('interstellar', 10), []));
check('compact rows: type letters, trailing blanks dropped', () => {
  fuzzy.reset();
  fuzzy.setRows([['1', 'm', 'Up', 2009], ['2', 's', 'Lost']]);
  const r = query('lost', 1)[0];
  assert.equal(r.type, 'show');
  assert.equal(query('up', 1)[0].type, 'movie');
});
// quota failure: index stays in memory, warning logged once
fuzzy.reset();
quotaFull = true;
warnings = 0;
PL.plex.get = () => Promise.resolve({ totalSize: 1, Metadata: [{ ratingKey: '1', title: 'Interstellar', year: 2014 }] });
PL.app.sections = [{ key: '1', type: 'movie' }];
await fuzzy.ensure();
await new Promise((r) => setTimeout(r, 2200));
check('quota failure keeps the in-memory index', () => {
  assert.equal(top('interstellar')[0], 'Interstellar');
  assert.ok(!('pl.fuzzy.v2' in store));
  assert.equal(warnings, 1);
});
quotaFull = false;
PL.app.sections = [];

// ---- micro-benchmark: 2.5k synthetic titles -----------------------------------------------------
const words = 'night dark star love war man return last king city blood river house dead secret life story black world lost time girl game fire heart shadow ghost wild road moon'.split(' ');
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const synth = [];
for (let i = 0; i < 2500; i++) {
  const n = 1 + rnd(4);
  const t = [];
  for (let j = 0; j < n; j++) t.push(words[rnd(words.length)]);
  synth.push([String(100 + i), i % 4 ? 'movie' : 'show', (rnd(3) ? 'The ' : '') + t.join(' ').replace(/^\w/, (c) => c.toUpperCase()), 1950 + rnd(75), '', '', '']);
}
synth.push(...titles);
let t0 = performance.now();
fuzzy.CHUNK = 1e9;
await fuzzy.setRows(synth);
const buildMs = performance.now() - t0;
fuzzy.CHUNK = 150;
const queries = ['s', 'sh', 'sha', 'shad', 'shado', 'shadow', 'shadw', 'dark nigt', 'intersteller', 'lotr', 'the', 'xq'];
for (const q of queries) fuzzy.query(q, 40); // warm up
const runs = 20;
t0 = performance.now();
for (let r = 0; r < runs; r++) for (const q of queries) fuzzy.query(q, 40);
const perQuery = (performance.now() - t0) / (runs * queries.length);
let worst = 0;
for (const q of queries) {
  const s = performance.now();
  for (let r = 0; r < 10; r++) fuzzy.query(q, 40);
  worst = Math.max(worst, (performance.now() - s) / 10);
}
console.log(`\n${passed} checks passed`);
console.log(`benchmark (${synth.length} titles, node): index build ${buildMs.toFixed(1)}ms, avg query ${perQuery.toFixed(2)}ms, worst query ${worst.toFixed(2)}ms`);
