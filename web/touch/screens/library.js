// A library tab on a phone or tablet (Movies, TV Shows): board P1. The logo and profile on top,
// chips for Recommended, Library, Collections and Surprise Me, then on Recommended a full-bleed
// hero and shelves that scroll sideways. Library and Collections are in browse.js
// (T.browse.library / T.browse.collections), Surprise Me in browse.js too (T.browse.surprise).
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const P = PL.ui;

  const STALE_MS = 15000; // coming back after this long, the shelves are fetched again

  // Continue Watching and episode rows are wide 16:9 cards, everything else posters (as on the TV)
  const shelfKind = (hub) => (hub.type === 'episode' || /inprogress|continue|ondeck/.test(hub.hubIdentifier || '') ? 'wide' : 'poster');

  // ---- The hero: the first title of the first shelf ------------------------------------------------

  // Plays a title: films and episodes from where they were left; a show or season from its next
  // episode (Plex's On Deck), else its page.
  T.playItem = (item) => {
    if (item.type === 'movie' || item.type === 'episode') return T.play(item, { offset: item.viewOffset || 0 });
    PL.plex.metadata(item.ratingKey).then((full) => {
      const next = PL.plex.onDeck(full);
      if (next) T.play(next, { offset: next.viewOffset || 0 });
      else T.open(item);
    }, (err) => T.toast(PL.errorMessage(err)));
  };

  function hero(item, onChange) {
    const n = h('section.t-hero');
    const art = h('div.t-hero-art', { on: { click: () => T.open(item) } });
    art.appendChild(ui.img(ui.imageUrl(P.artPath(item), 960, 540, { quality: 80 }), null, true));
    n.appendChild(art);
    n.appendChild(h('div.t-hero-shade'));
    const body = h('div.t-hero-body');
    if (item.type === 'episode') {
      body.appendChild(h('div.t-eyebrow', { text: [PL.fmt.episode(item), item.title].filter(Boolean).join(' · ') }));
    }
    body.appendChild(ui.titleArt(item, 't-hero-title'));
    const meta = h('div.t-hero-meta', { text: P.metaLine(item, { skipEpisode: true }) });
    const left = PL.fmt.remaining(item);
    if (left) meta.appendChild(h('span.t-hi', { text: (meta.textContent ? ' · ' : '') + left }));
    body.appendChild(meta);
    const actions = h('div.t-hero-actions');
    const resume = item.viewOffset > 0;
    actions.appendChild(ui.button({ kind: 'primary', icon: 'play', label: resume ? 'Resume' : 'Play', action: () => T.playItem(item) }));
    actions.appendChild(ui.button({ kind: 'round', icon: 'info', label: 'Details', action: () => T.open(item) }));
    actions.appendChild(ui.button({ kind: 'round', icon: 'more', label: 'More options', action: () => T.menu(item, onChange) }));
    body.appendChild(actions);
    const pr = P.progress(item);
    if (pr > 0) body.appendChild(h('div.t-hero-progress', null, ui.progress(pr)));
    n.appendChild(body);
    ui.onHold(art, () => T.menu(item, onChange));
    return n;
  }

  // ---- Recommended -----------------------------------------------------------------------------------

  function recommended(section, page) {
    const el = h('div.t-rec');
    const heroHost = h('div.t-hero-host');
    const shelves = h('div.t-shelves');
    const status = h('div.t-rec-status', null, ui.spinner());
    el.appendChild(heroHost);
    el.appendChild(status);
    el.appendChild(shelves);
    let loadedAt = 0;
    let hubs = [];
    let alive = true;
    let busy = false;

    const seeAll = (hub) => () => T.push(T.browse && T.browse.hub ? T.browse.hub(hub) : T.stagePage(() => PL.screens.items(hub.title, hub.key, {})));

    function render(list) {
      hubs = list;
      heroHost.replaceChildren();
      shelves.replaceChildren();
      const first = list[0] && list[0].Metadata && list[0].Metadata[0];
      page.el.classList.toggle('t-has-hero', !!first);
      if (first) heroHost.appendChild(hero(first, () => load(true)));
      list.forEach((hub) => {
        const more = !!hub.more || (hub.size || 0) > hub.Metadata.length;
        shelves.appendChild(ui.shelf({
          title: hub.title,
          kind: shelfKind(hub),
          items: hub.Metadata,
          total: hub.more ? hub.size + 100 : hub.size,
          loadMore: hub.more ? (start) => PL.plex.hubPage(hub, start, 20) : null,
          onMore: more ? seeAll(hub) : null,
          card: (item) => (shelfKind(hub) === 'wide' ? ui.wide : ui.poster)(item, {
            onChange: () => load(true),
            // Continue Watching and Recently Released Episodes play at once (PL.ui.playsOnSelect)
            onSelect: P.playsOnSelect(hub, item) ? T.playItem : null,
          }),
        }));
      });
      addPluginShelves();
    }

    // Plugins may add shelves after Plex's (e.g. "Trending on Trakt"); a failure never shows.
    function addPluginShelves() {
      if (!PL.plugins || !PL.plugins.shelfRows) return;
      PL.plugins.shelfRows(section).then((list) => {
        if (!alive || !list) return;
        list.filter((sh) => sh && sh.items && sh.items.length).forEach((sh) => {
          shelves.appendChild(ui.shelf({
            title: sh.title,
            kind: sh.kind === 'wide' ? 'wide' : 'poster',
            items: sh.items,
            card: (item) => (sh.kind === 'wide' ? ui.wide : ui.poster)(item, { onSelect: sh.onSelect || T.open, caption: sh.kind !== 'wide' && !item.ratingKey }),
          }));
        });
      }, () => {});
    }

    function load(force) {
      if (busy || (!force && loadedAt && Date.now() - loadedAt < STALE_MS)) return;
      busy = true;
      loadedAt = Date.now();
      PL.plex.get('/hubs/sections/' + section.key, { count: 20, excludeFields: 'file' }).then((mc) => {
        busy = false;
        if (!alive) return;
        const list = (mc.Hub || []).filter(PL.plex.isVideoHub);
        status.replaceChildren();
        if (!list.length && !hubs.length) status.appendChild(ui.empty('Nothing to recommend yet'));
        if (list.length) {
          const y = window.scrollY;
          render(list);
          if (hubs.length && T.top() === page) window.scrollTo(0, y);
        }
      }, (err) => {
        busy = false;
        if (!alive || hubs.length) return;
        status.replaceChildren(ui.empty(PL.errorMessage(err)), ui.button({ label: 'Try again', action: () => { status.replaceChildren(ui.spinner()); load(true); } }));
      });
    }

    load(true);
    return {
      el,
      show: () => load(false),
      destroy: () => { alive = false; },
    };
  }

  // ---- The page ----------------------------------------------------------------------------------------

  T.screens.library = (section) => {
    const page = T.page('t-lib');
    const top = ui.topBar({ over: true });
    page.el.appendChild(top);
    const modes = [
      { id: 'rec', label: 'Recommended' },
      { id: 'all', label: 'Library' },
      { id: 'col', label: 'Collections' },
      { id: 'surprise', label: 'Surprise Me', icon: 'sparkle', toggle: true },
    ];
    const saved = PL.storage.get('touch.mode.' + section.key, 'rec');
    let current = null;
    const made = {};
    const host = h('div.t-lib-modes');
    const chips = ui.chips(modes, saved, (id) => pick(id), 't-lib-chips');
    page.el.appendChild(chips);
    page.el.appendChild(host);

    function make(id) {
      if (id === 'rec') return recommended(section, page);
      const B = T.browse || {};
      if (id === 'all' && B.library) return B.library(section, page);
      if (id === 'col' && B.collections) return B.collections(section, page);
      // not built yet: the TV's version
      return { el: h('div'), show() {}, stage: () => PL.screens.library(section) };
    }

    function pick(id) {
      if (id === 'surprise') {
        const filters = current && made[current] && made[current].surpriseFilters ? made[current].surpriseFilters() : {};
        if (T.browse && T.browse.surprise) T.browse.surprise(section, filters);
        else PL.app.push(PL.screens.surprise(section, filters));
        return;
      }
      if (id === current) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (current && made[current]) {
        made[current].scrollY = window.scrollY;
        made[current].el.hidden = true;
        if (made[current].hide) made[current].hide();
      }
      current = id;
      PL.storage.set('touch.mode.' + section.key, id);
      chips.select(id);
      if (!made[id]) {
        made[id] = make(id);
        host.appendChild(made[id].el);
        if (made[id].stage) { PL.app.push(made[id].stage()); }
      }
      made[id].el.hidden = false;
      page.el.classList.toggle('t-mode-rec', id === 'rec');
      window.scrollTo(0, made[id].scrollY || 0);
      if (made[id].show) made[id].show();
    }

    page.onShow = () => { if (current && made[current] && made[current].show) made[current].show(); };
    page.onHide = () => { if (current && made[current] && made[current].hide) made[current].hide(); };
    page.onReselect = () => { if (current !== 'rec') pick('rec'); };
    page.destroy = () => Object.keys(made).forEach((k) => made[k].destroy && made[k].destroy());
    pick(modes.some((m) => m.id === saved && !m.toggle) ? saved : 'rec');
    return page;
  };
})();
