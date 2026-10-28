// Phone and tablet layer: browsing a library (docs/WEB.md, "Phones and tablets").
// - T.browse.library(section, page): the library tab's "Library" chip. Every title as a poster grid
//   with sort, genre, decade and unwatched filters (saved per library like the TV's), and an A–Z
//   rail on the right edge when sorted by title (tap or drag along it).
// - T.browse.collections(section, page): the "Collections" chip, a grid of the library's collections.
// - T.screens.collection(item): a collection's page (its art, its titles, Surprise Me).
// - T.browse.hub(hub): a shelf's "See all".
// - T.browse.surprise(source, filters): Surprise Me, a reveal page with Play, Details and Another.
// The data logic is the TV's (js/screens/library.js, js/screens/surprise.js: same endpoints, same
// parameters, PL.surprise for the pick, PL.az for the letters).
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

// ---- Pure decisions (test/touch-browse.test.mjs runs this part in Node) -------------------------------

(() => {
  const PL = window.PL = window.PL || {};

  // The TV's sorts (js/screens/library.js SORTS), with how each direction reads on a chip and in the sheet.
  const SORTS = {
    movie: [
      { key: 'titleSort', label: 'Title', dir: 'asc' },
      { key: 'addedAt', label: 'Date added', dir: 'desc' },
      { key: 'originallyAvailableAt', label: 'Release date', dir: 'desc' },
      { key: 'audienceRating', label: 'Audience rating', dir: 'desc' },
      { key: 'rating', label: 'Critic rating', dir: 'desc' },
      { key: 'lastViewedAt', label: 'Last watched', dir: 'desc' },
      { key: 'duration', label: 'Duration', dir: 'desc' },
      { key: 'random', label: 'Random', dir: 'asc' },
    ],
    show: [
      { key: 'titleSort', label: 'Title', dir: 'asc' },
      { key: 'episode.addedAt', label: 'New episodes', dir: 'desc' },
      { key: 'addedAt', label: 'Date added', dir: 'desc' },
      { key: 'originallyAvailableAt', label: 'First aired', dir: 'desc' },
      { key: 'audienceRating', label: 'Audience rating', dir: 'desc' },
      { key: 'lastViewedAt', label: 'Last watched', dir: 'desc' },
      { key: 'random', label: 'Random', dir: 'asc' },
    ],
  };
  // [ascending, descending]: long (the sheet) and short (the chip)
  const DIRS = {
    titleSort: [['A to Z', 'A–Z'], ['Z to A', 'Z–A']],
    date: [['Oldest first', 'Oldest'], ['Newest first', 'Newest']],
    score: [['Lowest first', 'Lowest'], ['Highest first', 'Highest']],
    duration: [['Shortest first', 'Shortest'], ['Longest first', 'Longest']],
  };
  const DIR_KIND = {
    titleSort: 'titleSort', addedAt: 'date', 'episode.addedAt': 'date', originallyAvailableAt: 'date',
    lastViewedAt: 'date', audienceRating: 'score', rating: 'score', duration: 'duration',
  };

  const sorts = (type) => SORTS[type === 'show' ? 'show' : 'movie'];

  // A sort direction in words: dirLabel('addedAt', 'desc') -> 'Newest first'; short -> 'Newest'.
  // Random has no direction ('').
  function dirLabel(sortKey, dir, short) {
    const kind = DIR_KIND[sortKey];
    if (!kind) return '';
    return DIRS[kind][dir === 'desc' ? 1 : 0][short ? 1 : 0];
  }

  // The saved filters (PL.storage 'filters.<section>', shared with the TV), checked: anything
  // unexpected falls back to the defaults (title A–Z, no filters).
  function normalFilters(saved, type) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const list = sorts(type);
    const def = list.filter((x) => x.key === s.sort)[0];
    const tag = (t) => (t && typeof t === 'object' && t.key != null ? { key: String(t.key), title: String(t.title || t.key) } : null);
    return {
      sort: def ? def.key : 'titleSort',
      dir: def ? (s.dir === 'desc' || s.dir === 'asc' ? s.dir : def.dir) : 'asc',
      genre: tag(s.genre),
      decade: tag(s.decade),
      unwatched: !!s.unwatched,
    };
  }

  const filtered = (f) => !!(f.genre || f.decade || f.unwatched);

  // The /all and /firstCharacter parameters for these filters (the TV's AllMode.filterParams), so the
  // grid and the A–Z counts agree.
  function filterParams(f, type) {
    const p = { type: type === 'show' ? 2 : 1, includeCollections: 0 };
    if (f.genre) p.genre = f.genre.key;
    if (f.decade) p.decade = f.decade.key;
    if (f.unwatched) p.unwatched = 1;
    return p;
  }

  // What Surprise Me honours from the Library view: the genre and decade, strictly unwatched if set.
  function surpriseFilters(f) {
    return {
      genre: f.genre, decade: f.decade, unwatched: f.unwatched,
      label: [f.genre && f.genre.title, f.decade && f.decade.title].filter(Boolean).join(' · '),
    };
  }

  const nounOf = (type, n) => (type === 'show' ? (n === 1 ? 'show' : 'shows') : type === 'collection'
    ? (n === 1 ? 'collection' : 'collections') : type === 'movie' ? (n === 1 ? 'movie' : 'movies') : (n === 1 ? 'title' : 'titles'));
  const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // '1,234 movies', '1 show'; '' for nothing.
  function countLabel(total, type) {
    if (!(total > 0)) return '';
    return fmtInt(total) + ' ' + nounOf(type, total);
  }

  // ---- The page-by-page grid's geometry ----

  // Which titles are on screen (plus `margin` px either side): geo {top (the grid's top in page px),
  // pitch (one row's height with its gap), cols, total}; viewTop/viewBottom in page px.
  // -> {first, last} indices (last inclusive), or null when nothing is.
  function visibleRange(geo, viewTop, viewBottom, margin) {
    if (!geo || !(geo.total > 0) || !(geo.pitch > 0) || !(geo.cols > 0)) return null;
    const rows = Math.ceil(geo.total / geo.cols);
    const r0 = Math.max(0, Math.floor((viewTop - margin - geo.top) / geo.pitch));
    const r1 = Math.min(rows - 1, Math.floor((viewBottom + margin - geo.top) / geo.pitch));
    if (r1 < r0) return null;
    return { first: r0 * geo.cols, last: Math.min(geo.total - 1, (r1 + 1) * geo.cols - 1) };
  }

  // The pages (of `size` titles) that hold a range.
  function pagesFor(range, size) {
    if (!range) return [];
    const out = [];
    for (let p = Math.floor(range.first / size); p <= Math.floor(range.last / size); p++) out.push(p);
    return out;
  }

  // The first title whose row starts at or below `y` (page px), e.g. just under the sticky filter bar.
  function firstIndexAt(geo, y) {
    if (!geo || !(geo.pitch > 0) || !(geo.total > 0)) return 0;
    const row = Math.max(0, Math.round((y - geo.top) / geo.pitch));
    return Math.min(geo.total - 1, row * geo.cols);
  }

  // ---- The A–Z rail ----

  // The letter under a finger at `y` on a rail of `n` letters from `top`, `height` px tall.
  function railIndexAt(y, top, height, n) {
    if (!(height > 0) || !(n > 0)) return 0;
    return Math.max(0, Math.min(n - 1, Math.floor(((y - top) / height) * n)));
  }

  // The letter to jump to for rail position i: its own when titles start with it, else the next one
  // down the rail that has some, else the nearest one up. model: PL.az.index(); order: PL.az.order().
  function railTarget(model, order, i) {
    if (!model || !order[i]) return null;
    const has = (s) => s in model.starts;
    if (has(order[i])) return order[i];
    for (let j = i + 1; j < order.length; j++) if (has(order[j])) return order[j];
    for (let j = i - 1; j >= 0; j--) if (has(order[j])) return order[j];
    return null;
  }

  // How the rail fits `height` px: 'full' (every letter), 'dense' (too little room for 27 legible
  // letters: every other one shows as a dot; dragging still reaches every letter) or 'none' (not
  // even that: a phone on its side before the filter bar has scrolled up; it shows once it has).
  function railFit(height, n) {
    const pitch = height / (n || 27);
    return pitch >= 14 ? 'full' : pitch >= 8 ? 'dense' : 'none';
  }

  // ---- Shelves' "See all" ----

  // Continue Watching and episode rows are wide 16:9 cards, everything else posters (as on the shelf).
  const wideHub = (hub) => !!hub && (hub.type === 'episode' || /inprogress|continue|ondeck/.test(hub.hubIdentifier || ''));

  // A hub page's items as the grid wants them: hubs don't say their total when they have "more", so
  // a full page means there may be another.
  function hubResult(hub, start, size, items) {
    const got = (items || []).length;
    if (got < size) return { total: start + got, items: items || [] };
    const known = hub && !hub.more && hub.size > 0 ? hub.size : 0;
    return { total: Math.max(known, start + got + 1), items };
  }

  // ---- Surprise Me ----

  // The reveal's eyebrow: "Surprise pick · From 12 unwatched movies · Comedy".
  function surpriseLine(pick, type, label) {
    const n = pick.total || 0;
    const from = pick.pool === 'rewatch'
      ? 'You’ve seen all ' + fmtInt(n) + ' ' + nounOf(type, n) + ', so here’s a rewatch'
      : 'From ' + fmtInt(n) + ' ' + (pick.pool === 'unwatched' ? 'unwatched ' : '') + nounOf(type, n);
    return 'Surprise pick · ' + from + (label ? ' · ' + label : '');
  }

  // A show's line under its title: "Next up S2 · E3 · The Title · 24m". ep: PL.fmt.episode(target).
  function surpriseEpisode(how, ep, title, left) {
    const lead = { resume: 'Resume', next: 'Next up', start: 'Starts with', again: 'Starts again with' }[how] || '';
    return [lead, [ep, title, left].filter(Boolean).join(' · ')].filter(Boolean).join(' ');
  }

  PL.touchBrowseLogic = {
    SORTS, sorts, dirLabel, normalFilters, filtered, filterParams, surpriseFilters, countLabel, nounOf,
    visibleRange, pagesFor, firstIndexAt, railIndexAt, railTarget, railFit, wideHub, hubResult,
    surpriseLine, surpriseEpisode,
  };
})();

// ---- The screens ----------------------------------------------------------------------------------------

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const P = PL.ui;
  const B = PL.touchBrowseLogic;
  const browse = T.browse = T.browse || {};

  const PAGE = 60;          // titles per request (as the TV's grid)
  const POSTER_W = 150;     // the poster image's CSS width (one size for every grid: the server caches it)
  const STALE_MS = 4000;    // back on a grid after this long: what's on screen is fetched again
  const SPIN_MIN_MS = 650;  // Surprise Me's dice rolls at least this long
  const PRELOAD_MS = 2500;  // ... and reveals anyway if the art is slower than this

  const listOf = (mc) => ({ total: mc.totalSize != null ? mc.totalSize : (mc.size || 0), items: mc.Metadata || [] });
  const isShown = (node) => T.visible && node.isConnected && node.offsetParent !== null;

  // A poster with its title and year under it (the kit's caption shows a show's seasons instead).
  function posterCard(item, onChange) {
    const n = ui.poster(item, { w: POSTER_W, onChange });
    n.appendChild(h('span.t-card-title', { text: P.itemTitle(item) || '' }));
    const sub = item.type === 'collection' ? B.countLabel(item.childCount, item.subtype || 'movie') : item.year ? String(item.year) : '';
    n.appendChild(h('span.t-card-sub', { text: sub }));
    return n;
  }

  // Images into the cache so a reveal draws complete; gives up after `ms`.
  function preload(urls, ms) {
    return new Promise((done) => {
      let left = urls.length;
      if (!left) return done();
      const timer = setTimeout(done, ms);
      urls.forEach((u) => {
        const img = new Image();
        img.onload = img.onerror = () => { if (--left <= 0) { clearTimeout(timer); done(); } };
        img.src = u;
      });
    });
  }

  // While a page shows: a scroll and resize listener (rAF-throttled), off when it hides.
  function onScroll(fn) {
    let raf = 0;
    const tick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); };
    let on = false;
    return {
      on() { if (on) return; on = true; window.addEventListener('scroll', tick, { passive: true }); window.addEventListener('resize', tick); tick(); },
      off() { on = false; window.removeEventListener('scroll', tick); window.removeEventListener('resize', tick); },
      tick,
    };
  }

  // ---- A grid of thousands: a slot per title, filled page by page where you look -------------------------

  // Every title has a slot from the start (an empty placeholder the size of a card), so the page is as
  // tall as the whole library, the scroll bar is honest, and a jump to any title scrolls straight
  // there and loads just that page. Pages load where the screen is (900 px ahead), not in order.
  // opts: {fetch(start, size) -> Promise<{total, items}>, card(item, index, repaint),
  //        empty() -> text, onTotal(total), onView(firstIndex, columns), headerH() -> px covered at the top}
  // (local kit addition: a candidate for ui.grid's big brother)
  function sparseGrid(opts) {
    const wrap = h('div.t-grid-wrap.t-bw-sparse');
    const grid = h('div.t-grid.t-bw-grid');
    const foot = h('div.t-grid-foot');
    wrap.appendChild(grid);
    wrap.appendChild(foot);
    let gen = 0;
    let total = -1;
    let slots = [];
    let items = [];
    const done = new Set();
    const pending = new Map();
    const failed = new Map();
    let geo = null;
    let held = false;
    let errorShownAt = 0;
    let fetchedAt = 0;

    const card = (i) => {
      const n = opts.card(items[i], i, () => repaint(i));
      return n;
    };
    function repaint(i) {
      if (!items[i] || !slots[i]) return;
      const n = card(i);
      grid.replaceChild(n, slots[i]);
      slots[i] = n;
    }
    function fill(start, list) {
      list.forEach((it, k) => {
        const i = start + k;
        if (i >= total || !it) return;
        items[i] = it;
        const n = card(i);
        grid.replaceChild(n, slots[i]);
        slots[i] = n;
      });
    }
    function setTotal(t) {
      if (t === total) return;
      if (t > slots.length) {
        const frag = document.createDocumentFragment();
        for (let i = slots.length; i < t; i++) {
          const ph = h('div.t-bw-ph');
          slots.push(ph);
          frag.appendChild(ph);
        }
        grid.appendChild(frag);
      }
      while (slots.length > t) slots.pop().remove();
      if (items.length > t) items.length = t;
      total = t;
      geo = null;
      foot.replaceChildren();
      if (!t) foot.appendChild(ui.empty(opts.empty ? opts.empty() : 'Nothing here yet'));
      if (opts.onTotal) opts.onTotal(t);
    }

    function load(p) {
      if (done.has(p)) return Promise.resolve();
      if (pending.has(p)) return pending.get(p);
      const g = gen;
      const pr = opts.fetch(p * PAGE, PAGE).then((res) => {
        if (g !== gen) return;
        pending.delete(p);
        failed.delete(p);
        done.add(p);
        fetchedAt = Date.now();
        setTotal(res.total);
        fill(p * PAGE, res.items);
        check();
      }, (err) => {
        if (g !== gen) return;
        pending.delete(p);
        failed.set(p, Date.now());
        if (total < 0) {
          foot.replaceChildren(ui.empty(PL.errorMessage(err)), ui.button({ label: 'Try again', action: () => wrap.reset() }));
        } else if (Date.now() - errorShownAt > 5000) {
          errorShownAt = Date.now();
          T.toast(PL.errorMessage(err));
        }
      });
      pending.set(p, pr);
      return pr;
    }

    function measure() {
      if (!slots.length || !isShown(grid)) return null;
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
      const r0 = slots[0].getBoundingClientRect();
      if (!r0.height) return null;
      const pitch = slots.length > cols ? slots[cols].getBoundingClientRect().top - r0.top : r0.height;
      return pitch > 0 ? { cols, pitch, top: r0.top + window.scrollY, total } : null;
    }

    // what's on screen: load it, and tell the caller where the view starts (measured every time: a
    // few rectangles on a clean layout, and what's above the grid may have changed height)
    function check() {
      if (total <= 0 || !isShown(grid)) return;
      geo = measure();
      if (!geo) return;
      const top = window.scrollY;
      const head = opts.headerH ? opts.headerH() : 0;
      if (opts.onView) opts.onView(B.firstIndexAt(geo, top + head), geo.cols);
      if (held) return;
      const range = B.visibleRange(geo, top, top + window.innerHeight, 900);
      B.pagesFor(range, PAGE).forEach((p) => {
        if (failed.has(p) && Date.now() - failed.get(p) < 3000) return;
        load(p);
      });
    }
    const scroller = onScroll(check);

    wrap.reset = () => {
      gen++;
      total = -1;
      slots = [];
      items = [];
      done.clear();
      pending.clear();
      failed.clear();
      geo = null;
      grid.replaceChildren();
      foot.replaceChildren(ui.spinner());
      return load(0);
    };
    // Scrolls title i to the top (under the sticky bar) and loads its page. While held (a finger on
    // the A–Z rail) only the scroll happens; the pages load when it lets go.
    wrap.jump = (i) => {
      if (!(i >= 0) || i >= total || !slots[i]) return;
      const head = opts.headerH ? opts.headerH() : 0;
      const y = slots[i].getBoundingClientRect().top + window.scrollY - head - 10;
      window.scrollTo(0, Math.max(0, y));
      if (!held) load(Math.floor(i / PAGE));
      check();
    };
    wrap.hold = (on) => { held = on; if (!on) check(); };
    // The pages on screen again (watched marks and progress after the player or a details page). A
    // changed total (an Unwatched filter, a title gone) starts over where the view was.
    wrap.refresh = () => {
      geo = measure();
      if (total <= 0 || !geo) return;
      fetchedAt = Date.now();
      const top = window.scrollY;
      const pages = B.pagesFor(B.visibleRange(geo, top, top + window.innerHeight, 0), PAGE).filter((p) => done.has(p));
      const g = gen;
      pages.forEach((p) => {
        opts.fetch(p * PAGE, PAGE).then((res) => {
          if (g !== gen) return;
          if (res.total !== total) {
            const y = window.scrollY;
            wrap.reset().then(() => { window.scrollTo(0, y); check(); });
            return;
          }
          fill(p * PAGE, res.items);
        }, () => { /* keep what is on screen */ });
      });
    };
    wrap.activate = (on) => { if (on) scroller.on(); else scroller.off(); };
    wrap.fetchedAt = () => fetchedAt;
    wrap.destroy = () => { gen++; scroller.off(); };
    wrap.total = () => total;
    wrap.grid = grid;
    return wrap;
  }

  // ---- The A–Z rail: tap a letter or drag along the edge ---------------------------------------------------

  // opts: {onPick(slot, letterShown), onRelease()}. Lives in T.layer (fixed, above the page) so a
  // page's push animation never moves it.
  function azRail(opts) {
    const el = h('div.t-bw-rail', { role: 'navigation', 'aria-label': 'Jump to a letter' });
    const col = h('div.t-bw-rail-col');
    const nodes = PL.az.LETTERS.map((s) => {
      const n = h('span.t-bw-rail-l', { text: s });
      col.appendChild(n);
      return n;
    });
    el.appendChild(col);
    const flash = h('div.t-bw-flash', { 'aria-hidden': 'true' });
    const flashText = h('span');
    flash.appendChild(flashText);
    let order = PL.az.LETTERS.slice();
    let model = null;
    let rect = null;
    let last = -1;
    let dragging = false;
    let current = null;
    let flashTimer = 0;
    let top = -1;

    const rail = { el, flash };
    rail.setModel = (m) => {
      model = m;
      order = PL.az.order(m);
      nodes.forEach((n, i) => {
        n.textContent = order[i];
        n.classList.toggle('t-empty-l', !m || !(order[i] in m.starts));
      });
      current = null;
      rail.setCurrent(null);
    };
    rail.usable = () => !!model && Object.keys(model.starts).length > 1;
    rail.show = (on) => {
      el.classList.toggle('on', !!on);
      if (!on) { flash.classList.remove('on'); dragging = false; }
    };
    rail.shown = () => el.classList.contains('on');
    // the rail runs from `y` (under the filter bar) down to above the tab bar; frozen under a finger
    rail.place = (y) => {
      if (dragging) return;
      const t = Math.round(y);
      if (t === top) return;
      top = t;
      el.style.top = t + 'px';
      const fit = B.railFit(el.getBoundingClientRect().height, order.length);
      el.classList.toggle('t-dense', fit === 'dense');
      el.classList.toggle('t-cramped', fit === 'none');
    };
    rail.setCurrent = (slot) => {
      if (slot === current) return;
      const was = order.indexOf(current);
      if (was >= 0) nodes[was].classList.remove('on');
      current = slot;
      const at = order.indexOf(slot);
      if (at >= 0) nodes[at].classList.add('on');
    };
    const showFlash = (slot) => {
      flashText.textContent = slot;
      flash.classList.add('on');
      clearTimeout(flashTimer);
    };
    const hideFlash = (ms) => {
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove('on'), ms);
    };
    const pick = (y) => {
      const i = B.railIndexAt(y, rect.top, rect.height, order.length);
      if (i === last) return;
      last = i;
      const slot = B.railTarget(model, order, i);
      if (!slot) return;
      showFlash(slot);
      rail.setCurrent(slot);
      opts.onPick(slot);
      if (navigator.vibrate && dragging && slot !== order[i - 1]) { try { navigator.vibrate(1); } catch (e) { /* not allowed */ } }
    };
    el.addEventListener('pointerdown', (e) => {
      if (!model) return;
      e.preventDefault();
      dragging = true;
      last = -1;
      rect = col.getBoundingClientRect();
      el.classList.add('t-active');
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      pick(e.clientY);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) pick(e.clientY); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('t-active');
      hideFlash(550);
      if (opts.onRelease) opts.onRelease();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    // a long press here is a drag, never a title's quick actions or the system menu
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.plHandled = true; });
    rail.holding = () => dragging;
    rail.destroy = () => { clearTimeout(flashTimer); el.remove(); flash.remove(); };
    return rail;
  }

  // ---- Library: every title, sorted and filtered -------------------------------------------------------------

  browse.library = (section, page) => {
    const type = section.type === 'show' ? 'show' : 'movie';
    const sorts = B.sorts(type);
    const storeKey = 'filters.' + section.key;
    let f = B.normalFilters(PL.storage.get(storeKey, null), type);
    let alive = true;
    let visible = false;
    let letters = null;
    let lettersGen = 0;
    const tags = {}; // genre / decade lists, read once

    const el = h('div.t-bw.t-bw-lib');
    const bar = h('div.t-bw-bar');
    const chips = h('div.t-chips.t-bw-chips');
    bar.appendChild(chips);
    const count = h('div.t-bw-count', { 'aria-live': 'polite' });
    el.appendChild(bar);
    el.appendChild(count);

    const barH = () => bar.getBoundingClientRect().height + (parseFloat(getComputedStyle(bar).top) || 0);
    const grid = sparseGrid({
      fetch: (start, size) => {
        const params = B.filterParams(f, type);
        params.sort = f.sort + (f.dir === 'desc' ? ':desc' : '');
        params.excludeFields = 'summary';
        params['X-Plex-Container-Start'] = start;
        params['X-Plex-Container-Size'] = size;
        return PL.plex.get('/library/sections/' + section.key + '/all', params).then(listOf);
      },
      card: (item, i, repaint) => posterCard(item, repaint),
      empty: () => (B.filtered(f) ? 'Nothing matches these filters' : 'This library is empty'),
      onTotal: (total) => {
        count.textContent = B.countLabel(total, type);
        paintRail();
      },
      onView: (i, cols) => {
        // the letter of the first row's last title: a row that starts with the end of L and goes
        // on into M is M's
        if (letters && !rail.holding()) rail.setCurrent(PL.az.slotAt(letters, Math.min(grid.total() - 1, i + cols - 1)));
        const r = bar.getBoundingClientRect();
        bar.classList.toggle('t-stuck', window.scrollY > 0 && r.top <= (parseFloat(getComputedStyle(bar).top) || 0) + 0.5);
        if (rail.shown()) rail.place(r.bottom + 4);
      },
      headerH: barH,
    });
    el.appendChild(grid);

    // ---- the A–Z rail (title sort only) ----
    const rail = azRail({
      onPick: (slot) => {
        const at = PL.az.target(letters, slot);
        if (at < 0) return;
        grid.hold(true);
        grid.jump(at);
      },
      onRelease: () => grid.hold(false),
    });
    T.layer.appendChild(rail.el);
    T.layer.appendChild(rail.flash);

    function placeRail() {
      if (rail.shown()) rail.place(bar.getBoundingClientRect().bottom + 4);
    }
    function paintRail() {
      const on = visible && f.sort === 'titleSort' && !!letters && rail.usable() && grid.total() > 0;
      if (letters && grid.total() > 0 && letters.total !== grid.total()) PL.warn('A-Z counts differ from the listing', letters.total, grid.total());
      el.classList.toggle('t-bw-has-rail', on);
      rail.show(on);
      if (on) placeRail();
    }
    function loadLetters() {
      const gen = ++lettersGen;
      letters = null;
      rail.show(false);
      el.classList.remove('t-bw-has-rail');
      if (f.sort !== 'titleSort') return;
      PL.plex.get('/library/sections/' + section.key + '/firstCharacter', B.filterParams(f, type)).then((mc) => {
        if (gen !== lettersGen || !alive) return;
        letters = PL.az.index(mc.Directory || [], f.dir === 'desc');
        rail.setModel(letters);
        paintRail();
      }, (err) => PL.warn('firstCharacter failed', err && err.message));
    }

    // ---- the filter chips and their sheets ----
    function chip(label, opts) {
      const n = h('button.t-chip' + (opts.on ? '.on' : ''), { type: 'button', 'aria-pressed': opts.toggle ? String(!!opts.on) : null, 'aria-haspopup': opts.menu ? 'dialog' : null });
      if (opts.icon) n.appendChild(ui.icon(opts.icon));
      n.appendChild(h('span', { text: label }));
      if (opts.value) n.appendChild(h('span.t-chip-value', { text: opts.value }));
      if (opts.menu) n.appendChild(ui.icon('down', 't-bw-caret'));
      n.addEventListener('click', opts.action);
      return n;
    }
    function paintChips() {
      const sort = sorts.filter((s) => s.key === f.sort)[0] || sorts[0];
      const x = chips.scrollLeft;
      chips.replaceChildren(
        chip(sort.label, { icon: 'sort', value: B.dirLabel(f.sort, f.dir, true), menu: true, action: pickSort }),
        chip(f.genre ? f.genre.title : 'Genre', { on: !!f.genre, menu: true, action: () => pickTag('genre') }),
        chip(f.decade ? f.decade.title : 'Decade', { on: !!f.decade, menu: true, action: () => pickTag('decade') }),
        chip('Unwatched', { on: f.unwatched, toggle: true, icon: f.unwatched ? 'check' : null, action: () => { f.unwatched = !f.unwatched; apply(); } }),
      );
      if (B.filtered(f)) {
        chips.appendChild(chip('Clear', { icon: 'close', action: () => { f.genre = f.decade = null; f.unwatched = false; apply(); } }));
      }
      chips.scrollLeft = x;
    }

    function apply() {
      PL.storage.set(storeKey, f);
      paintChips();
      count.textContent = '';
      // back to the top of the list (the filter bar stays where it is)
      const top = el.getBoundingClientRect().top + window.scrollY - 14;
      if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
      grid.reset();
      loadLetters();
    }

    function pickSort() {
      const rows = sorts.map((s) => ({
        label: s.label, checked: s.key === f.sort,
        action: () => {
          if (s.key === f.sort) return;
          f.sort = s.key;
          f.dir = s.dir;
          apply();
        },
      }));
      const sections = [{ heading: 'Sort by', rows }];
      if (B.dirLabel(f.sort, 'asc')) {
        sections.push({
          heading: 'Order',
          rows: ['asc', 'desc'].map((d) => ({
            label: B.dirLabel(f.sort, d), checked: f.dir === d,
            action: () => { if (f.dir !== d) { f.dir = d; apply(); } },
          })),
        });
      }
      T.sheet({ title: 'Sort', sections, cls: 't-bw-sheet' });
    }

    let picking = false;
    function pickTag(kind) {
      if (picking) return;
      const open = (dirs) => {
        const cur = f[kind];
        const rows = [{ label: kind === 'genre' ? 'All genres' : 'All decades', checked: !cur, action: () => { if (cur) { f[kind] = null; apply(); } } }]
          .concat(dirs.map((d) => ({
            label: d.title, checked: !!cur && String(cur.key) === String(d.key),
            action: () => { f[kind] = { key: String(d.key), title: d.title }; apply(); },
          })));
        T.sheet({ title: kind === 'genre' ? 'Genre' : 'Decade', rows, cls: 't-bw-sheet' });
      };
      if (tags[kind]) return open(tags[kind]);
      picking = true;
      PL.plex.get('/library/sections/' + section.key + '/' + kind, { type: type === 'show' ? 2 : 1 }).then((mc) => {
        picking = false;
        tags[kind] = mc.Directory || [];
        if (alive && visible) open(tags[kind]);
      }, (err) => { picking = false; T.toast(PL.errorMessage(err)); });
    }

    paintChips();
    grid.reset();
    loadLetters();

    return {
      el,
      show() {
        visible = true;
        grid.activate(true);
        paintRail();
        // back from the player or a title's page: watched marks and progress may have changed
        if (grid.fetchedAt() && Date.now() - grid.fetchedAt() > STALE_MS) requestAnimationFrame(() => grid.refresh());
      },
      hide() {
        visible = false;
        grid.activate(false);
        rail.show(false);
      },
      destroy() {
        alive = false;
        grid.destroy();
        rail.destroy();
      },
      surpriseFilters: () => B.surpriseFilters(f),
    };
  };

  // ---- Collections ------------------------------------------------------------------------------------------

  browse.collections = (section) => {
    const el = h('div.t-bw.t-bw-cols');
    const count = h('div.t-bw-count.t-bw-count-top');
    el.appendChild(count);
    const grid = ui.grid({
      fetch: (start, size) => PL.plex.get('/library/sections/' + section.key + '/collections', {
        'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size,
      }).then(listOf),
      card: (item) => posterCard(item),
      empty: 'No collections in this library',
      onTotal: (total) => { count.textContent = B.countLabel(total, 'collection'); },
      cls: 't-bw-grid',
    });
    el.appendChild(grid);
    return {
      el,
      show() {},
      hide() {},
      destroy() { grid.destroy(); },
      surpriseFilters: () => ({}),
    };
  };

  // Fetches a kit grid's loaded titles again and repaints them in place (when the count is unchanged).
  function refreshKitGrid(wrap, fetch, card) {
    const n = wrap.loaded();
    if (!n) return;
    fetch(0, n).then((res) => {
      if (res.items.length !== wrap.grid.children.length) { wrap.reset(); return; }
      res.items.forEach((it, i) => wrap.grid.replaceChild(card(it), wrap.grid.children[i]));
    }, () => { /* keep what is on screen */ });
  }

  // A pushed page's Back bar turns solid (with its title) once the page's own heading scrolls away.
  function solidOnScroll(bar, heading) {
    return onScroll(() => {
      const r = heading.getBoundingClientRect();
      bar.classList.toggle('t-solid', r.bottom < bar.getBoundingClientRect().bottom + 4);
    });
  }

  // ---- A collection's page ------------------------------------------------------------------------------------

  T.screens.collection = (item) => {
    const page = T.page('t-bw-page.t-bw-colpage');
    let col = item;
    let alive = true;
    let loadedAt = 0;
    const bar = ui.backBar({ title: col.title || '' });
    const head = h('header.t-bw-head');
    const art = h('div.t-bw-head-art');
    const text = h('div.t-bw-head-text');
    const title = h('h1.t-bw-title', { text: col.title || '' });
    const meta = h('div.t-bw-meta');
    const summary = h('p.t-bw-summary');
    const actions = h('div.t-bw-actions');
    const surpriseBtn = ui.button({ kind: 'glass', icon: 'sparkle', label: 'Surprise Me', action: () => surprise() });
    surpriseBtn.hidden = true;
    actions.appendChild(surpriseBtn);
    text.appendChild(title);
    text.appendChild(meta);
    text.appendChild(summary);
    text.appendChild(actions);
    head.appendChild(art);
    head.appendChild(text);
    page.el.appendChild(bar);
    page.el.appendChild(head);
    // a long summary opens up when tapped
    summary.addEventListener('click', () => summary.classList.toggle('t-open'));

    function paintHead() {
      const barTitle = bar.querySelector('.t-backbar-title');
      if (barTitle) barTitle.textContent = col.title || '';
      title.textContent = col.title || '';
      summary.textContent = col.summary || '';
      summary.hidden = !col.summary;
      const path = col.art;
      art.replaceChildren();
      page.el.classList.toggle('t-bw-has-art', !!path);
      if (path) {
        art.appendChild(ui.img(ui.imageUrl(path, 960, 540, { quality: 80 }), null, true));
        art.appendChild(h('div.t-bw-head-shade'));
      }
    }
    paintHead();
    // opened from search or a details page: the list entry may lack the art and summary
    if (col.ratingKey && (col.summary == null || col.art == null)) {
      PL.plex.metadata(col.ratingKey).then((full) => {
        if (!alive) return;
        col = Object.assign({}, col, full);
        paintHead();
      }, () => { /* the list's fields will do */ });
    }

    const fetch = (start, size) => PL.plex.get('/library/collections/' + col.ratingKey + '/children', {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size,
    }).then((mc) => { loadedAt = Date.now(); return listOf(mc); });
    const card = (it) => posterCard(it, () => refreshKitGrid(grid, fetch, card));
    const grid = ui.grid({
      fetch,
      card,
      empty: 'This collection is empty',
      onTotal: (total) => {
        const kind = col.subtype === 'show' ? 'show' : col.subtype === 'movie' ? 'movie' : 'title';
        meta.textContent = B.countLabel(total, kind);
        surpriseBtn.hidden = total < 2;
      },
      cls: 't-bw-grid',
    });
    page.el.appendChild(grid);

    function surprise() {
      browse.surprise({
        key: String(col.librarySectionID || ''),
        type: col.subtype === 'show' ? 'show' : 'movie',
        collection: String(col.ratingKey),
      }, { label: col.title || '' });
    }

    const solid = solidOnScroll(bar, title);
    page.title = col.title;
    page.onShow = (o) => {
      solid.on();
      if (o && o.back && loadedAt && Date.now() - loadedAt > STALE_MS) refreshKitGrid(grid, fetch, card);
    };
    page.onHide = () => solid.off();
    page.destroy = () => { alive = false; solid.off(); grid.destroy(); };
    return page;
  };

  // ---- A shelf's "See all" ---------------------------------------------------------------------------------------

  browse.hub = (hub) => {
    const page = T.page('t-bw-page.t-bw-hubpage');
    const bar = ui.backBar({ title: hub.title || '' });
    const title = h('h1.t-bw-title', { text: hub.title || '' });
    const head = h('header.t-bw-head', null, h('div.t-bw-head-text', null, title));
    page.el.appendChild(bar);
    page.el.appendChild(head);
    const wide = B.wideHub(hub);
    let loadedAt = 0;
    const fetch = (start, size) => PL.plex.hubPage(hub, start, size).then((items) => {
      loadedAt = Date.now();
      return B.hubResult(hub, start, size, items);
    });
    const onChange = () => refreshKitGrid(grid, fetch, card);
    const card = wide ? (it) => ui.wide(it, { w: 320, onChange }) : (it) => posterCard(it, onChange);
    const grid = ui.grid({ fetch, card, page: 40, empty: 'Nothing here yet', cls: wide ? 't-bw-wides' : 't-bw-grid' });
    page.el.appendChild(grid);
    const solid = solidOnScroll(bar, title);
    page.title = hub.title;
    page.onShow = (o) => {
      solid.on();
      if (o && o.back && loadedAt && Date.now() - loadedAt > STALE_MS) refreshKitGrid(grid, fetch, card);
    };
    page.onHide = () => solid.off();
    page.destroy = () => { solid.off(); grid.destroy(); };
    return page;
  };

  // ---- Surprise Me ------------------------------------------------------------------------------------------------

  // source: a library section ({key, type}) or a collection ({key, type, collection}); filters: the
  // Library view's (genre, decade, unwatched, label) or {label} for a collection. The pick is the TV's
  // (PL.surprise: unwatched first, recent picks skipped, a show's next episode).
  browse.surprise = (source, filters) => {
    if (!PL.surprise || !PL.surprise.pick) return;
    const src = source.collection ? source : { key: String(source.key), type: source.type === 'show' ? 'show' : 'movie' };
    T.push(surprisePage(src, filters || {}));
  };

  function surprisePage(source, filters) {
    const page = T.page('t-bw-surprise.is-spinning');
    const type = source.type === 'show' ? 'show' : 'movie';
    let gen = 0;
    let alive = true;
    let pick = null;
    let spinning = false;

    const art = h('div.t-bw-sp-art');
    const shade = h('div.t-bw-sp-shade');
    const dice = h('div.t-bw-sp-dice', { role: 'status' }, [
      h('div.t-bw-sp-disc', null, ui.icon('sparkle')),
      h('div.t-bw-sp-label', { text: type === 'show' ? 'Picking a show…' : 'Picking a movie…' }),
    ]);
    const body = h('div.t-bw-sp-body');
    const eyebrow = h('div.t-eyebrow.t-bw-sp-eyebrow');
    const titleHost = h('div.t-bw-sp-title');
    const meta = h('div.t-bw-sp-meta');
    const episode = h('div.t-bw-sp-episode');
    const summary = h('p.t-bw-sp-summary');
    const play = ui.button({ kind: 'primary', icon: 'play', label: 'Play', action: () => doPlay() });
    const details = ui.button({ kind: 'action', icon: 'info', label: 'Details', action: () => { if (pick && !spinning) T.open(pick.item); } });
    const again = ui.button({ kind: 'action', icon: 'shuffle', label: 'Another', action: () => spin() });
    const actions = h('div.t-bw-sp-actions', null, [play, h('div.t-bw-sp-more', null, [details, again])]);
    [eyebrow, titleHost, meta, episode, actions, summary].forEach((n) => body.appendChild(n));
    page.el.appendChild(art);
    page.el.appendChild(shade);
    page.el.appendChild(dice);
    page.el.appendChild(body);
    page.el.appendChild(ui.backBar({}));

    function spin() {
      if (spinning || !alive) return;
      const g = ++gen;
      const started = Date.now();
      spinning = true;
      page.el.classList.add('is-spinning');
      again.disabled = true;
      PL.surprise.pick(source, filters).then((p) => {
        if (g !== gen || !alive) return null;
        PL.surprise.remember(source, p.item.ratingKey);
        const url = ui.imageUrl(P.artPath(p.item), 960, 540, { quality: 80 });
        const logo = P.logoPath(p.item);
        return preload([url, logo && P.logoUrl(logo)].filter(Boolean), PRELOAD_MS).then(() => {
          const wait = Math.max(0, SPIN_MIN_MS - (Date.now() - started));
          setTimeout(() => { if (g === gen && alive) reveal(p, url); }, wait);
        });
      }).catch((err) => {
        if (g !== gen || !alive) return;
        spinning = false;
        again.disabled = false;
        PL.warn('surprise failed', err && err.message);
        T.toast(err && err.empty ? err.message : PL.errorMessage(err));
        if (!pick) { if (T.top() === page) T.back(); return; }
        page.el.classList.remove('is-spinning');
      });
    }

    function reveal(p, url) {
      pick = p;
      spinning = false;
      again.disabled = false;
      const item = p.item;
      const target = p.target;
      const img = ui.img(url, null, true);
      art.replaceChildren(img);
      eyebrow.textContent = B.surpriseLine(p, type, filters.label);
      titleHost.replaceChildren(ui.titleArt(item));
      let line = P.metaLine(item);
      if (item.type !== 'show' && p.how === 'resume' && target.duration) line += ' · ' + PL.fmt.remaining(target);
      meta.textContent = line;
      if (item.type === 'show') {
        const left = p.how === 'resume' ? PL.fmt.remaining(target) : PL.fmt.duration(target.duration);
        episode.textContent = B.surpriseEpisode(p.how, PL.fmt.episode(target), target.title, left);
        episode.hidden = false;
      } else {
        episode.hidden = true;
      }
      summary.textContent = item.summary || '';
      summary.hidden = !item.summary;
      play.querySelector('.t-btn-label').textContent = p.how === 'resume' ? 'Resume' : 'Play';
      page.el.classList.remove('is-spinning');
      page.el.classList.add('t-bw-picked');
      // the reveal animation runs again on every pick
      body.classList.remove('t-bw-in');
      void body.offsetWidth;
      body.classList.add('t-bw-in');
    }

    // The player takes the reveal's place: Back from it returns to the library.
    function doPlay() {
      if (!pick || spinning) return;
      const target = pick.target;
      if (T.top() === page) T.back();
      T.playItem(target);
    }

    page.onShow = (o) => { if (!o || !o.back) window.scrollTo(0, 0); };
    page.destroy = () => { alive = false; gen++; };
    page.title = 'Surprise Me';
    spin();
    return page;
  }
})();
