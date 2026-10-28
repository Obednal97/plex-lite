// The Search tab on a phone or tablet (board P5): a rounded field with the system keyboard, filter
// chips, then the results in rows: Movies & Shows (posters), Channels and On TV (with Live TV),
// People and Episodes, then plugin rows. Before typing: recent searches and Continue Watching.
//
// The matching is the TV's (js/screens/search.js): titles from the local fuzzy index (PL.fuzzy) on
// every keystroke, Plex's /hubs/search for episodes, people and titles the index missed (debounced),
// and channels and programmes from the guide in memory (PL.liveGuide, matched by js/livetv-search.js).
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

// ---- Pure decisions (no DOM: test/touch-search.test.mjs runs them in Node) -------------------------

(() => {
  const PL = window.PL = window.PL || {};
  const MAX_QUERY = 60;
  const RECENT_MAX = 8;

  // "  star   wars " -> "star wars"
  const clean = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);

  // A search to remember: newest first, no repeats (whatever the case), at most `max`.
  function addRecent(list, q, max = RECENT_MAX) {
    const c = clean(q);
    const old = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
    if (!c) return old.slice(0, max);
    return [c].concat(old.filter((x) => x.toLowerCase() !== c.toLowerCase())).slice(0, max);
  }

  // /hubs/search -> {titles, people, episodes}, as the TV reads it: one card per person (Plex
  // returns one entry per library; tag ids are global, the name is the fallback when ids differ).
  function parseHubs(mc) {
    const out = { titles: [], people: [], episodes: [] };
    ((mc && mc.Hub) || []).forEach((hub) => {
      if ((hub.type === 'movie' || hub.type === 'show') && hub.Metadata) {
        out.titles = out.titles.concat(hub.Metadata);
      } else if (hub.type === 'episode' && hub.Metadata) {
        out.episodes = hub.Metadata.slice(0, 30);
      } else if (hub.type === 'actor' && hub.Directory) {
        const seen = {};
        out.people = [];
        hub.Directory.forEach((d) => {
          const known = seen['id:' + d.id] || seen['name:' + d.tag];
          if (known) {
            if (!known.thumb && d.thumb) known.thumb = d.thumb;
            return;
          }
          const p = { id: d.id, tag: d.tag, name: d.tag, thumb: d.thumb || null, filter: 'actor' };
          seen['id:' + d.id] = p;
          seen['name:' + d.tag] = p;
          out.people.push(p);
        });
      }
    });
    return out;
  }

  // Local matches first, then the server's titles the index missed.
  function mergeTitles(local, server, limit = 40) {
    const seen = {};
    const out = [];
    (local || []).concat(server || []).forEach((it) => {
      if (!it || seen[it.ratingKey]) return;
      seen[it.ratingKey] = true;
      out.push(it);
    });
    return out.slice(0, limit);
  }

  // The rows, in order. cat: the chip a row belongs to. tvFirst: Channels and On TV above Movies &
  // Shows (the query is about a channel: PL.liveSearch.channelsFirst).
  // d: {titles, channels, shows, people, episodes, plugins: [{id, title, kind, items}], tvFirst}
  function sections(d) {
    const out = [];
    const add = (s) => { if (s.items && s.items.length) out.push(s); };
    const titles = { id: 'titles', cat: 'titles', title: 'Movies & Shows', kind: 'poster', items: d.titles };
    const tv = [
      { id: 'channels', cat: 'live', title: 'Channels', kind: 'channel', items: d.channels },
      { id: 'ontv', cat: 'live', title: 'On TV', kind: 'airing', items: d.shows },
    ];
    if (!d.tvFirst) add(titles);
    tv.forEach(add);
    if (d.tvFirst) add(titles);
    add({ id: 'people', cat: 'people', title: 'People', kind: 'person', items: d.people });
    add({ id: 'episodes', cat: 'titles', title: 'Episodes', kind: 'wide', items: d.episodes });
    (d.plugins || []).forEach((r, i) => add({ id: 'plugin.' + (r.id || i), cat: 'titles', title: r.title, kind: r.kind === 'wide' ? 'wide' : 'poster', items: r.items, plugin: r }));
    return out;
  }

  const CHIPS = [
    { id: 'titles', label: 'Movies & Shows' },
    { id: 'live', label: 'Live TV' },
    { id: 'people', label: 'People' },
  ];

  // The filter chips for these rows: All, then each kind that has results, with its count. None
  // without results. (Shown even for a single kind, so the rows don't jump down when the server's
  // or the guide's results add a second one a moment later.)
  function chips(list) {
    const counts = {};
    list.forEach((s) => { counts[s.cat] = (counts[s.cat] || 0) + s.items.length; });
    const have = CHIPS.filter((c) => counts[c.id] > 0);
    if (!have.length) return [];
    return [{ id: 'all', label: 'All' }].concat(have.map((c) => ({ id: c.id, label: c.label, value: String(counts[c.id]) })));
  }

  // The filter in force: the one picked if it still has results, else All.
  function pickFilter(chipList, wanted) {
    return chipList.some((c) => c.id === wanted) ? wanted : 'all';
  }

  const visible = (list, filter) => (filter && filter !== 'all' ? list.filter((s) => s.cat === filter) : list);

  // What to say instead of (or above) the rows.
  // -> 'idle' | 'indexing' | 'searching' | 'none' | 'error' | null (just the rows)
  function status(s) {
    if (!clean(s.query)) return 'idle';
    if (s.count) return null;
    if (s.indexBuilding && !s.indexReady) return 'indexing';
    if (!s.serverDone) return 'searching';
    if (s.serverError) return 'error';
    return 'none';
  }

  // Before typing: Continue Watching from the home hubs (every library's, without repeats), else
  // what was added lately. -> {title, items} | null
  function suggestions(hubs, max = 6) {
    const list = hubs || [];
    const from = (re, title) => {
      const seen = {};
      const items = [];
      list.filter((h) => re.test(h.hubIdentifier || '') && h.Metadata).forEach((h) => h.Metadata.forEach((it) => {
        if (it && it.ratingKey && !seen[it.ratingKey] && items.length < max) {
          seen[it.ratingKey] = true;
          items.push(it);
        }
      }));
      return items.length ? { title, items } : null;
    };
    return from(/continue|ondeck|inprogress/i, 'Continue Watching') || from(/recent/i, 'Recently Added');
  }

  // A channel to watch, as js/screens/livetv.js playList builds it: every channel in guide order,
  // so channel up and down go along all of them (as from the guide's All filter).
  function liveFor(channels, identifier, dvrKey) {
    const list = channels || [];
    const shape = (x) => ({ identifier: x.identifier, id: x.id, vcn: x.vcn, title: x.name, thumb: x.thumb });
    let index = list.findIndex((x) => x.identifier === identifier);
    if (index < 0) index = 0;
    return { label: 'All channels', dvrKey, channel: list[index] ? shape(list[index]) : null, channels: list.map(shape), index };
  }

  // A programme: on now plays its channel; one still to come opens the guide at it.
  const airingAction = (a, now) => (a && a.b > now ? 'guide' : 'watch');

  PL.touchSearchLogic = { clean, addRecent, parseHubs, mergeTitles, sections, chips, pickFilter, visible, status, suggestions, liveFor, airingAction, RECENT_MAX };
})();

// ---- The page ----------------------------------------------------------------------------------------

(() => {
  const PL = window.PL;
  if (!PL || !PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const P = PL.ui;
  const S = PL.touchSearchLogic;
  const LS = PL.liveSearch;
  const LL = PL.liveLogic;

  const LOCAL_LIMIT = 40;
  const SERVER_MS = 300;    // the server's search follows the typing by this much
  const TV_MS = 150;        // and the Channels / On TV rows by this much (as on the TV)
  const PLUGIN_MS = 450;
  const GUIDE_AHEAD = 6 * 3600;
  const SUGGEST_STALE_MS = 60000;
  const now = () => Math.floor(Date.now() / 1000);
  const liveTv = () => !!(PL.app && PL.app.hasLiveTv && PL.liveGuide && LS);
  const recentKey = () => {
    const p = PL.storage.get('profile', null);
    return 'touch.search.recent' + (p && p.uuid ? '.' + p.uuid : '');
  };

  // ---- Live TV cards ------------------------------------------------------------------------------

  // A channel's logo on a light plate, else its name.
  function plate(c, cls) {
    const b = h('span.t-search-plate' + (cls ? '.' + cls : ''));
    const name = () => b.appendChild(h('span.t-search-plate-name', { text: c.name || c.vcn || '' }));
    if (c.thumb) {
      const img = ui.img(PL.plex.image(c.thumb, 120, 64, { format: 'png', minSize: 0 }), 't-search-logo');
      img.addEventListener('error', name, { once: true });
      b.appendChild(img);
    } else {
      name();
    }
    return b;
  }

  // Channels: the logo plate, number (a star for a favourite), name, what's on and how far through.
  function channelCard(item, act) {
    const c = item.liveChannel;
    const a = item.airing;
    const t = now();
    const n = h('button.t-card.t-search-chan', { type: 'button', 'aria-label': [c.vcn, c.name].filter(Boolean).join(' ') });
    n.appendChild(plate(c));
    const num = h('span.t-search-chan-num');
    if (PL.liveGuide.isFavourite(c.identifier)) num.appendChild(ui.icon('star', 't-search-fav'));
    num.appendChild(document.createTextNode(c.vcn || ''));
    n.appendChild(num);
    n.appendChild(h('span.t-card-title', { text: c.name || '' }));
    let sub;
    if (a) sub = a.title + ' · ' + LL.span(a.e - t) + ' left';
    else if (item.next) sub = item.next.title + ' · ' + LL.clock(item.next.b);
    else sub = 'No guide information';
    n.appendChild(h('span.t-card-sub', { text: sub }));
    n.appendChild(ui.progress(a ? LL.progress(a, t) : 0));
    n.addEventListener('click', () => act.watch(c));
    ui.onHold(n, () => act.menu(item));
    return n;
  }

  // On TV: the programme's art, LIVE or its start in the corner, the channel's logo, a progress line
  // while it's on; the title, channel and time left (or when it starts) under it.
  function airingCard(item, act) {
    const c = item.liveChannel;
    const a = item.airing;
    const t = now();
    const n = h('button.t-card.t-wide.t-search-air', { type: 'button', 'aria-label': a.title + ', ' + (c.name || '') });
    const frame = h('span.t-card-frame');
    frame.appendChild(ui.img(a.art ? ui.imageUrl(a.art, 240, 135) : null));
    frame.appendChild(plate(c, 't-search-plate-sm'));
    const day = LL.day(a.b, t);
    frame.appendChild(item.onNow ? h('span.t-search-pill.t-live', { text: 'LIVE' })
      : h('span.t-search-pill', { text: (day === 'Today' ? '' : day.slice(0, 3) + ' ') + LL.clock(a.b) }));
    if (item.onNow) frame.appendChild(ui.progress(LL.progress(a, t)));
    n.appendChild(frame);
    n.appendChild(h('span.t-card-title', { text: a.title }));
    const when = item.onNow || a.b - t <= 3600 ? LL.status(a, t) : LL.span(a.e - a.b);
    n.appendChild(h('span.t-card-sub', { text: [c.vcn, c.name].filter(Boolean).join(' ') + ' · ' + when }));
    n.addEventListener('click', () => (S.airingAction(a, now()) === 'guide' ? act.guide(c, a.b) : act.watch(c)));
    ui.onHold(n, () => act.menu(item));
    return n;
  }

  // ---- The page ----------------------------------------------------------------------------------------

  T.screens.search = () => {
    const page = T.page('t-search');
    let alive = true;
    let shown = false;
    let query = '';

    // the field: magnifier, the input, clear; Cancel beside it while searching
    const input = h('input.t-search-input', { type: 'search', placeholder: 'Search', maxLength: 60, 'aria-label': 'Search' });
    // as attributes: ui.h would set the boolean properties (autocorrect = 'off' is true) or skip false
    [['enterkeyhint', 'search'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['autocomplete', 'off'], ['spellcheck', 'false']]
      .forEach(([k, v]) => input.setAttribute(k, v));
    const clearBtn = h('button.t-search-clear', { type: 'button', 'aria-label': 'Clear', hidden: true }, h('span', null, ui.icon('close')));
    const field = h('label.t-search-field', null, [ui.icon('search', 't-search-mag'), input, clearBtn]);
    const cancel = h('button.t-search-cancel', { type: 'button', text: 'Cancel', hidden: true });
    const head = h('header.t-search-head', null, h('div.t-search-bar', null, [field, cancel]));
    const chipHost = h('div.t-search-chips');
    const statusEl = h('div.t-search-status');
    const results = h('div.t-search-results');
    const idle = h('div.t-search-idle');
    const body = h('div.t-search-body', null, [chipHost, statusEl, results, idle]);
    page.el.appendChild(head);
    page.el.appendChild(body);

    // ---- The field ----------------------------------------------------------------------------------

    const focused = () => document.activeElement === input;
    const paintField = () => {
      clearBtn.hidden = !input.value;
      cancel.hidden = !(input.value || focused());
      page.el.classList.toggle('t-search-active', !cancel.hidden);
    };
    const dropKeyboard = () => { if (focused()) input.blur(); };

    function remember(q) {
      const c = S.clean(q == null ? query : q);
      if (!c) return;
      PL.storage.set(recentKey(), S.addRecent(PL.storage.get(recentKey(), []), c));
    }

    let frame = 0;
    input.addEventListener('input', () => {
      paintField();
      // one search a frame however fast the keys come
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setQuery(input.value); });
    });
    input.addEventListener('focus', paintField);
    input.addEventListener('blur', () => setTimeout(paintField, 0));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      remember(input.value);
      // the keyboard's Search key: put the keyboard away to see the results
      if (PL.input.mode() === 'touch') input.blur();
    });
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      input.value = '';
      setQuery('');
      input.focus();
      paintField();
    });
    // keep the focus in the field when the clear button is pressed (a label would hand it back late)
    clearBtn.addEventListener('pointerdown', (e) => { if (focused()) e.preventDefault(); });
    cancel.addEventListener('click', () => {
      input.value = '';
      setQuery('');
      input.blur();
      paintField();
    });

    // Esc in the field clears it, then puts the keyboard away; it doesn't leave the tab. The stage
    // (js/app.js, document capture) would take it as Back, so this goes first (window capture).
    const onEsc = (e) => {
      if (e.target !== input || (e.key !== 'Escape' && e.keyCode !== 27)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (input.value) {
        input.value = '';
        setQuery('');
        paintField();
      } else {
        input.blur();
      }
    };
    window.addEventListener('keydown', onEsc, true);

    // a touch on the results puts the keyboard away (scrolling them, or tapping one: the tap still
    // lands, since the page doesn't move when the keyboard goes)
    body.addEventListener('touchstart', (e) => { if (!chipHost.contains(e.target)) dropKeyboard(); }, { passive: true });

    // ---- State ----------------------------------------------------------------------------------------

    let local = [];
    let server = { titles: [], people: [], episodes: [] };
    let serverDone = false;
    let serverError = null;
    let tv = { channels: [], shows: [], first: false };
    let pluginRows = [];
    let filter = 'all';
    let pending = null;
    let seq = 0;
    let pluginSeq = 0;

    function setQuery(raw) {
      const q = S.clean(raw);
      if (q === query) return;
      const was = query;
      query = q;
      if (!q) {
        runServer.cancel();
        runTv.cancel();
        runPlugins.cancel();
        abortServer();
        pluginSeq++;
        local = [];
        server = { titles: [], people: [], episodes: [] };
        serverDone = false;
        serverError = null;
        tv = { channels: [], shows: [], first: false };
        pluginRows = [];
        filter = 'all';
        render();
        return;
      }
      if (!was && window.scrollY) window.scrollTo(0, 0);
      searchLocal();
      serverDone = false;
      serverError = null;
      runServer();
      if (liveTv()) runTv();
      if (PL.plugins && PL.plugins.hasSearch && PL.plugins.hasSearch()) {
        pluginSeq++;
        runPlugins();
      }
      render();
    }

    function searchLocal() {
      local = query && PL.fuzzy.ready ? PL.fuzzy.query(query, LOCAL_LIMIT) : [];
    }

    // ---- The server -------------------------------------------------------------------------------------

    function abortServer() {
      if (pending) pending.abort();
      pending = null;
    }

    function serverSearch() {
      const q = query;
      if (!q) return;
      abortServer();
      const mine = ++seq;
      // PL.http directly (not PL.plex.search) so the request can be dropped when the query changes
      const req = PL.http('GET', PL.plex.url('/hubs/search', { query: q, limit: 20, includeCollections: 0 }), { timeout: 10000 });
      pending = req;
      req.then((res) => {
        if (!alive || mine !== seq) return;
        pending = null;
        server = S.parseHubs((res && res.MediaContainer) || {});
        serverDone = true;
        serverError = null;
        render();
      }, (err) => {
        if (!alive || mine !== seq || (err && err.aborted)) return;
        pending = null;
        serverDone = true;
        serverError = err || new Error('Search failed');
        server = { titles: [], people: [], episodes: [] }; // (the last query's: not for this one)
        PL.warn('server search failed', err && err.message);
        if (err && err.status === 401 && PL.plex.onUnauthorized) PL.plex.onUnauthorized(err);
        render();
      });
    }
    const runServer = PL.debounce(serverSearch, SERVER_MS);

    function pluginSearch() {
      const q = query;
      const mine = ++pluginSeq;
      PL.plugins.searchRows(q).then((rows) => {
        if (!alive || mine !== pluginSeq || q !== query) return;
        pluginRows = (rows || []).filter((r) => r && r.items && r.items.length);
        render();
      }, () => {});
    }
    const runPlugins = PL.debounce(pluginSearch, PLUGIN_MS);

    // the local index finished (or refreshed): the titles again, without asking the server
    const offIndex = PL.fuzzy.onChange(() => {
      if (!alive || !query) return;
      searchLocal();
      render();
    });

    // ---- Live TV: channels and programmes from the guide in memory ---------------------------------------

    let guideAsked = false;
    let tvGen = 0;
    let tvIndex = null;
    let tvCache = {};

    // The lineup first (small), so channel names match even if the guide then fails. Quiet on errors.
    function loadGuide() {
      if (!liveTv() || guideAsked) return;
      guideAsked = true;
      const G = PL.liveGuide;
      const quiet = (what) => (err) => { guideAsked = false; PL.log('search: no live TV ' + what, err && (err.status || err.message)); };
      G.loadChannels().then(() => {
        if (!alive) return null;
        return G.load().then(() => (alive ? G.ensure(now(), now() + GUIDE_AHEAD) : null)).then(null, quiet('guide'));
      }, quiet('lineup'));
    }

    // rebuilt when the guide changed or a minute has passed (programmes end, what's on moves on)
    function indexTv() {
      const G = PL.liveGuide;
      const t = now();
      const have = tvIndex;
      if (have && have.gen === tvGen && t - have.at < LS.REBUILD_MS / 1000) return have;
      tvCache = LS.trimCache(tvCache);
      tvIndex = {
        list: G.channels,
        channels: have && have.list === G.channels ? have.channels : LS.indexChannels(G.channels),
        guide: LS.indexGuide(G.channels, G.list, t, tvCache),
        gen: tvGen,
        at: t,
      };
      return tvIndex;
    }

    function searchTv() {
      const G = PL.liveGuide;
      const empty = { channels: [], shows: [], first: false };
      if (!query || !liveTv() || !G.channels.length) return empty;
      const q = LS.query(query);
      if (!q) return empty;
      const idx = indexTv();
      const t = now();
      const matched = LS.matchChannels(idx.channels, q, { limit: 30, isFavourite: G.isFavourite });
      const first = LS.channelsFirst(q, matched.best, LS.titleScore(local[0], q));
      const channels = matched.map((c) => {
        const nn = G.nowNext(c.identifier, t);
        return { key: 'ch-' + c.identifier, liveChannel: c, airing: nn.now, next: nn.next };
      });
      const shows = LS.matchProgrammes(idx.guide, q, t, 30).map((x) => ({ key: 'air-' + x.c.identifier + '-' + x.a.b, liveChannel: x.c, airing: x.a, onNow: x.onNow }));
      return { channels, shows, first };
    }
    const runTv = PL.debounce(() => {
      if (!alive) return;
      tv = searchTv();
      render();
    }, TV_MS);
    const offGuide = liveTv() ? PL.liveGuide.listen(() => {
      tvGen++;
      if (alive && shown && query) runTv();
    }) : null;

    const live = {
      watch(c) {
        const G = PL.liveGuide;
        if (!G.src) return;
        dropKeyboard();
        remember();
        T.playLive(S.liveFor(G.channels, c.identifier, G.src.dvrKey));
      },
      // the phone guide (web/touch/live/guide.js), at that channel and time
      guide(c, t) {
        dropKeyboard();
        remember();
        PL.liveGuide.openAt = { identifier: c.identifier, t: t || now() };
        if (T.tabs.some((x) => x.id === 'livetv')) T.selectTab('livetv');
        else PL.app.push(PL.screens.livetv());
      },
      menu(item) {
        const G = PL.liveGuide;
        const c = item.liveChannel;
        const a = item.key.indexOf('air-') === 0 ? item.airing : null;
        const later = a && a.b > now();
        const fav = G.isFavourite(c.identifier);
        const rows = [];
        if (!later) rows.push({ label: 'Watch ' + c.name, icon: 'play', action: () => live.watch(c) });
        rows.push({ label: 'Show in guide', icon: 'grid', action: () => live.guide(c, a ? a.b : now()) });
        rows.push({
          label: fav ? 'Remove from Favourites' : 'Add to Favourites',
          icon: 'star',
          action: () => {
            const on = G.toggleFavourite(c.identifier);
            T.toast(on ? 'Added ' + c.name + ' to Favourites' : 'Removed ' + c.name + ' from Favourites');
            tv = searchTv();
            render();
          },
        });
        dropKeyboard();
        T.sheet({ title: a ? a.title : c.name, sub: [c.vcn, c.name].filter(Boolean).join(' ') + (a ? ' · ' + LL.times(a, now()) : ''), rows });
      },
    };

    // ---- Rendering ------------------------------------------------------------------------------------

    const opener = (fn) => (x) => {
      dropKeyboard();
      remember();
      fn(x);
    };
    const openTitle = opener((item) => (item.plugin ? PL.plugins.select(item) : T.open(item)));
    const openPerson = opener((p) => T.openPerson(p));
    const changed = () => { if (query) serverSearch(); };

    function caption(item) {
      const title = P.itemTitle(item) || '';
      return item.year ? title + ' · ' + item.year : title;
    }

    function card(s) {
      if (s.kind === 'channel') return (item) => channelCard(item, live);
      if (s.kind === 'airing') return (item) => airingCard(item, live);
      if (s.kind === 'person') return (p) => ui.personCard(p, { onSelect: openPerson });
      const pick = s.plugin && s.plugin.onSelect ? opener(s.plugin.onSelect) : openTitle;
      if (s.kind === 'wide') {
        return (item) => ui.wide(item, { onSelect: pick, onChange: changed, sub: item.type === 'episode' ? P.itemSubtitle(item) : null });
      }
      return (item) => {
        const n = ui.poster(item, { onSelect: pick, onChange: changed });
        n.appendChild(h('span.t-search-cap', { text: caption(item) }));
        return n;
      };
    }

    // shelves are kept while their cards would be the same (the server's rows until it answers, the
    // TV rows until their debounce), so a row being scrolled isn't rebuilt under the finger
    const built = {};
    const sig = (items) => items.map((it) => {
      if (it.liveChannel) {
        const a = it.airing;
        return it.key + (a ? '@' + a.b : '') + (PL.liveGuide.isFavourite(it.liveChannel.identifier) ? '*' : '');
      }
      return [it.ratingKey || it.id || it.key || it.title, it.viewOffset || 0, it.viewCount || 0, it.viewedLeafCount || 0].join(':');
    }).join('|');

    function render() {
      if (!alive) return;
      const titles = S.mergeTitles(local, server.titles, LOCAL_LIMIT);
      const all = query ? S.sections({
        titles, channels: tv.channels, shows: tv.shows, people: server.people, episodes: server.episodes,
        plugins: pluginRows, tvFirst: tv.first,
      }) : [];
      const chipList = S.chips(all);
      filter = S.pickFilter(chipList, filter);
      renderChips(chipList);
      const list = S.visible(all, filter);
      const keep = {};
      list.forEach((s) => {
        let b = built[s.id];
        const key = sig(s.items);
        if (!b) {
          const node = ui.shelf({ title: s.title, kind: s.kind === 'person' ? 'person' : s.kind === 'poster' ? 'poster' : 'wide', items: s.items, card: card(s) });
          node.classList.add('t-search-shelf', 't-search-' + s.kind);
          b = built[s.id] = { node, key };
        } else if (b.key !== key) {
          // new cards in the same row: where it was scrolled to stays for the same query (the
          // server's titles add to the index's), a new query starts at its first card
          const x = b.node.row.scrollLeft;
          b.node.replace(s.items);
          b.node.row.scrollLeft = query === b.query ? x : 0;
          b.key = key;
        }
        b.query = query;
        keep[s.id] = true;
      });
      Object.keys(built).forEach((id) => {
        if (!keep[id] && built[id]) {
          built[id].node.remove();
          delete built[id];
        }
      });
      // in order, moving only what is out of place (a moved row forgets its sideways scroll)
      list.forEach((s, i) => {
        const node = built[s.id].node;
        const at = results.children[i];
        if (at !== node) results.insertBefore(node, at || null);
      });
      // a single kind picked: its rows wrap into a grid instead of scrolling sideways
      results.classList.toggle('t-search-grid', filter !== 'all');
      renderStatus(list.length);
      idle.hidden = !!query;
      if (!query) renderIdle();
    }

    let chipKey = '';
    let chipRow = null;
    function renderChips(list) {
      const key = list.map((c) => c.id + ':' + c.value).join(',');
      if (key !== chipKey) {
        chipKey = key;
        chipHost.replaceChildren();
        chipRow = list.length ? ui.chips(list, filter, (id) => {
          if (id === filter) return;
          filter = id;
          render();
          if (window.scrollY > chipHost.offsetTop) window.scrollTo(0, 0);
        }, 't-search-chiprow') : null;
        if (chipRow) chipHost.appendChild(chipRow);
      }
      if (chipRow) chipRow.select(filter);
      chipHost.hidden = !chipRow;
    }

    function renderStatus(count) {
      const st = S.status({
        query, count, indexReady: PL.fuzzy.ready, indexBuilding: PL.fuzzy.isBuilding(), serverDone, serverError,
      });
      statusEl.replaceChildren();
      statusEl.hidden = !st || st === 'idle';
      if (st === 'indexing') statusEl.append(ui.spinner(), h('p.t-search-note', { text: 'Getting your library ready to search…' }));
      else if (st === 'searching') statusEl.append(ui.spinner());
      else if (st === 'none') {
        statusEl.append(
          h('p.t-search-none', { text: 'No results for “' + query + '”' }),
          h('p.t-search-note', { text: liveTv() ? 'Try another spelling, a person, or a channel name or number.' : 'Try another spelling, or a person’s name.' }),
        );
      } else if (st === 'error') {
        statusEl.append(
          h('p.t-search-none', { text: 'Couldn’t search' }),
          h('p.t-search-note', { text: PL.errorMessage(serverError) }),
          ui.button({ label: 'Try again', action: () => { serverDone = false; serverError = null; render(); serverSearch(); } }),
        );
      }
    }

    // ---- Before typing: recent searches and suggestions ---------------------------------------------------

    let sugg = null;
    let suggAt = 0;
    let suggBusy = false;
    const recentBox = h('section.t-search-recent');
    const suggBox = h('section.t-search-sugg');
    const hint = h('p.t-search-hint');
    idle.append(recentBox, suggBox, hint);

    function renderIdle() {
      const recent = PL.storage.get(recentKey(), []);
      recentBox.replaceChildren();
      recentBox.hidden = !recent.length;
      if (recent.length) {
        const top = h('div.t-search-idle-head', null, [
          h('h2.t-shelf-title', { text: 'Recent searches' }),
          h('button.t-search-textbtn', { type: 'button', text: 'Clear', on: { click: () => { PL.storage.set(recentKey(), []); renderIdle(); } } }),
        ]);
        const rows = h('div.t-search-recent-list');
        recent.slice(0, 6).forEach((q) => {
          rows.appendChild(h('button.t-search-recent-row', { type: 'button', on: { click: () => {
            input.value = q;
            paintField();
            setQuery(q);
            remember(q);
          } } }, [ui.icon('search', 't-search-recent-icon'), h('span.t-search-recent-text', { text: q }), ui.icon('chevron', 't-search-recent-go')]));
        });
        recentBox.append(top, rows);
      }
      suggBox.replaceChildren();
      suggBox.hidden = !sugg;
      if (sugg) {
        suggBox.appendChild(h('div.t-search-idle-head', null, h('h2.t-shelf-title', { text: sugg.title })));
        const list = h('div.t-search-sugg-list');
        sugg.items.forEach((item) => list.appendChild(suggestionRow(item)));
        suggBox.appendChild(list);
      }
      hint.textContent = liveTv() ? 'Search for films, shows, episodes, people and channels.' : 'Search for films, shows, episodes and people.';
      hint.hidden = !!(recent.length || sugg);
    }

    // A row in the spirit of Netflix's "Recommended" list: a 16:9 still, the title, a play button.
    function suggestionRow(item) {
      const n = h('div.t-search-sugg-row');
      const main = h('button.t-search-sugg-main', { type: 'button', 'aria-label': P.itemTitle(item) || '', on: { click: () => T.open(item) } });
      const thumb = h('span.t-search-sugg-thumb');
      thumb.appendChild(ui.img(ui.imageUrl(P.widePath(item), 128, 72)));
      const pr = P.progress(item);
      if (pr > 0) thumb.appendChild(ui.progress(pr));
      main.appendChild(thumb);
      const text = h('span.t-search-sugg-text');
      text.appendChild(h('span.t-search-sugg-title', { text: P.itemTitle(item) || '' }));
      const sub = ui.caption(item);
      if (sub) text.appendChild(h('span.t-search-sugg-sub', { text: sub }));
      main.appendChild(text);
      n.appendChild(main);
      const play = () => (T.playItem ? T.playItem(item) : T.play(item, { offset: item.viewOffset || 0 }));
      n.appendChild(ui.button({ kind: 'round', icon: 'play', label: (item.viewOffset > 0 ? 'Resume ' : 'Play ') + (P.itemTitle(item) || ''), action: play }));
      ui.onHold(main, () => T.menu(item, () => loadSuggestions(true)));
      return n;
    }

    function loadSuggestions(force) {
      if (suggBusy || (!force && suggAt && Date.now() - suggAt < SUGGEST_STALE_MS)) return;
      suggBusy = true;
      suggAt = Date.now();
      PL.plex.hubs().then((hubs) => {
        suggBusy = false;
        if (!alive) return;
        sugg = S.suggestions(hubs, 6);
        if (!query) renderIdle();
      }, () => { suggBusy = false; });
    }

    // ---- Page life -------------------------------------------------------------------------------------

    let guideTimer = 0;
    page.onShow = (o = {}) => {
      const first = !shown;
      shown = true;
      PL.fuzzy.ensure().then(() => {
        if (alive && query) { searchLocal(); render(); }
      }, (err) => {
        PL.warn('search index failed', err && err.message);
        if (alive) render();
      });
      if (liveTv()) {
        clearTimeout(guideTimer);
        guideTimer = setTimeout(() => { if (alive && shown) loadGuide(); }, first ? 0 : 400);
      }
      loadSuggestions(!!o.back);
      // back from a title or the player: progress and watched marks may have changed
      if (o.back && query) serverSearch();
      if (o.back && liveTv() && query) runTv();
      render();
      paintField();
      // opened by a tap on the tab (not at start-up, not coming back): ready to type. iOS shows the
      // keyboard only for a focus inside the tap's own handler, which this is.
      const act = navigator.userActivation;
      if (!o.back && (act ? act.isActive : !first)) input.focus({ preventScroll: true });
    };
    page.onReselect = () => input.focus({ preventScroll: true });
    page.onHide = () => {
      shown = false;
      dropKeyboard();
      clearTimeout(guideTimer);
    };
    page.destroy = () => {
      alive = false;
      window.removeEventListener('keydown', onEsc, true);
      cancelAnimationFrame(frame);
      runServer.cancel();
      runTv.cancel();
      runPlugins.cancel();
      abortServer();
      offIndex();
      if (offGuide) offGuide();
      clearTimeout(guideTimer);
    };
    page.input = input; // (tests)
    render();
    return page;
  };
})();
