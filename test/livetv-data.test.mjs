// node --test test/ — the Browse parts of the Live TV data module (js/livetv-data.js) against a
// stub Plex server: show genres looked up in the background, a block that arrives while they are
// being looked up, and a server change while a save is pending. Invented channels; ~15 s of timers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHANNELS = 150; // enough shows that looking them up outlasts the next block (12 requests)

function setup() {
  const store = {};
  const requests = [];
  const grid = (from) => {
    const Metadata = [];
    for (let c = 1; c <= CHANNELS; c++) {
      for (let t = from; t < from + 3 * 3600; t += 3600) {
        Metadata.push({ type: 'episode', grandparentRatingKey: `show-${c}-${t}`, title: 'Programme',
          Media: [{ channelIdentifier: String(c), channelVcn: String(c), channelTitle: `${c} ZX - Orbit ${c}`, beginsAt: t, endsAt: t + 3600 }] });
      }
    }
    return { Metadata };
  };
  const PL = {
    log() {}, warn() {},
    storage: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    plex: {
      server: { machineId: 'A' },
      get(path, q) {
        requests.push(path);
        return new Promise((ok) => setTimeout(() => {
          if (path === '/livetv/dvrs') return ok({ Dvr: [{ key: 1 }] });
          if (path === '/media/providers') return ok({ MediaProvider: [{ protocols: 'livetv', identifier: 'p' }] });
          if (path.includes('/lineups/')) {
            return ok({ Channel: Array.from({ length: CHANNELS }, (_, i) => ({ id: i + 1, vcn: i + 1, title: `ZX - Orbit ${i + 1}` })) });
          }
          if (path.includes('/grid')) return ok(grid(Math.max(q['endsAt>'], 0)));
          if (path.includes('/metadata/')) {
            return ok({ Metadata: path.split('/metadata/')[1].split(',').map((k) => ({ ratingKey: k, Genre: [{ tag: 'Sport' }] })) });
          }
          return ok({});
        }, path.includes('/metadata/') ? 60 : 30));
      },
    },
  };
  const ctx = vm.createContext({ window: { PL }, PL, setTimeout, clearTimeout, Promise, Date, Math, console });
  for (const f of ['js/livetv-logic.js', 'js/livetv-browse.js', 'js/livetv-data.js']) {
    vm.runInContext(readFileSync(here + '../' + f, 'utf8'), ctx);
  }
  return { G: PL.liveGuide, PL, store, requests };
}

const waiting = (G) => {
  let n = 0;
  Object.keys(G.airings).forEach((id) => G.airings[id].forEach((a) => { if (G.airingCat(a) === undefined) n++; }));
  return n;
};

test('show genres: a block that arrives while they are being looked up is looked up too', async () => {
  const { G, requests } = setup();
  await G.load();
  const now = Math.floor(Date.now() / 1000);
  // the next block lands while the first block's shows are being looked up
  await sleep(1300);
  await G.ensure(now + 3 * 3600, now + 5 * 3600);
  await sleep(7000);
  assert.equal(waiting(G), 0);
  assert.ok(requests.filter((p) => p.includes('/metadata/')).length >= 2);
  const ctx = G.browseCtx();
  assert.equal(Object.keys(ctx.cat).length, CHANNELS);
  assert.equal(ctx.cat['1'], 'sport');
});

test('a server change drops what was scheduled for the old server', async () => {
  const { G, PL, store } = setup();
  await G.load();
  await sleep(2600); // genres looked up, a save scheduled (4 s)
  assert.ok(G.cats && Object.keys(G.cats).length);
  PL.plex.server = { machineId: 'B' };
  G.reset();
  await sleep(4500);
  assert.equal(store['livetv.cats.B'], undefined);
  assert.equal(store['livetv.cats.A'], undefined);
});
