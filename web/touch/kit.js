// The phone and tablet layer's building blocks (docs/WEB.md, "Phones and tablets"): icons, buttons,
// chips, poster and wide cards, shelves that scroll sideways with the next card peeking in, an
// endless grid, the top bar and the Back chevron. Screens in web/touch/screens/ are made of these.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb) return;
  const T = PL.touch = PL.touch || { screens: {} };
  const L = PL.touchLogic;
  const ui = T.ui = {};

  // ---- Elements -----------------------------------------------------------------------------------

  // h('div.cls.other', {attrs, on: {click}}, children | text)
  const h = ui.h = (spec, props, kids) => {
    const [tag, ...cls] = spec.split('.');
    const n = document.createElement(tag || 'div');
    if (cls.length) n.className = cls.join(' ');
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null) continue;
        if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
        else if (k === 'text') n.textContent = v;
        // a property of the same type (type, src, hidden: false, spellcheck: false...); otherwise an
        // attribute (aria-*, role, autocorrect="off" where the property is a boolean...)
        else if (k in n && k !== 'role' && !k.startsWith('aria-') && !k.startsWith('data-') && typeof n[k] === typeof v) n[k] = v;
        else if (v !== false) n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (kids != null) {
      for (const c of [].concat(kids)) {
        if (c == null || c === false) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  };

  // ---- Icons: 24 px stroke icons (the mockups' set) -----------------------------------------------

  const ICONS = {
    film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    tv: '<rect x="3" y="5" width="18" height="12.5" rx="2.5"/><path d="M8.5 21h7"/>',
    live: '<circle cx="12" cy="12" r="2"/><path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20.5 20.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
    more: '<circle cx="5.5" cy="12" r="1.3" class="fill"/><circle cx="12" cy="12" r="1.3" class="fill"/><circle cx="18.5" cy="12" r="1.3" class="fill"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" class="fill"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4.5h4.5"/>',
    trailer: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
    cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10a2.5 2.5 0 1 0 0 4M17 10a2.5 2.5 0 1 0 0 4"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    shuffle: '<path d="M3 7h3.5c4.5 0 6.5 10 11 10H21M3 17h3.5c1.6 0 2.8-1.3 3.9-3M14 9.8C15 8.2 16.2 7 17.5 7H21M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/>',
    sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9 6.7 19.6l1-5.8-4.2-4.1 5.9-.9z"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.4-3.6 4.5-5.5 8-5.5s6.6 1.9 8 5.5"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    signout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const parser = new DOMParser();
  // Built from our own constant strings (never from data), parsed as SVG: no innerHTML on the page.
  ui.icon = (name, cls) => {
    const doc = parser.parseFromString('<svg xmlns="' + SVG + '" viewBox="0 0 24 24">' + (ICONS[name] || '') + '</svg>', 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true);
    svg.setAttribute('class', 't-icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  };

  // ---- Images ----------------------------------------------------------------------------------------

  // A Plex image at the size it is shown (CSS px), sharp on the screen's density.
  ui.imageUrl = (path, w, hgt, extra) => {
    if (!path) return null;
    const dpr = window.devicePixelRatio || 1;
    const W = L.imageWidth(w, dpr);
    return PL.plex.image(path, W, Math.round((W * hgt) / w), extra);
  };

  // An <img> that fades in once loaded and never shows a broken-image icon.
  ui.img = (src, cls, eager) => {
    const n = h('img.t-img' + (cls ? '.' + cls : ''), { alt: '', draggable: false, decoding: 'async' });
    if (!eager) n.setAttribute('loading', 'lazy');
    if (!src) { n.classList.add('t-img-none'); return n; }
    n.addEventListener('load', () => n.classList.add('t-in'), { once: true });
    n.addEventListener('error', () => n.classList.add('t-img-none'), { once: true });
    n.src = src;
    return n;
  };

  // ---- Buttons and chips -----------------------------------------------------------------------------

  // {label, icon, kind: 'primary' | 'glass' | 'round' | 'text' | 'action', action, aria}
  // 'action': an icon in a glass circle with its label under it (P2's From start / Trailer / ...).
  ui.button = (b) => {
    const kind = b.kind || 'glass';
    const n = h('button.t-btn.t-btn-' + kind, { type: 'button', 'aria-label': b.aria || (kind === 'round' ? b.label : null) });
    if (kind === 'action') {
      const disc = h('span.t-btn-disc', null, ui.icon(b.icon));
      n.appendChild(disc);
      n.appendChild(h('span.t-btn-label', { text: b.label }));
    } else {
      if (b.icon) n.appendChild(ui.icon(b.icon));
      if (kind !== 'round' && b.label) n.appendChild(h('span.t-btn-label', { text: b.label }));
    }
    if (b.action) n.addEventListener('click', (e) => { e.stopPropagation(); b.action(e); });
    return n;
  };

  // Chips that pick one of several: items [{id, label, icon}], selected id, onPick(id).
  ui.chips = (items, selected, onPick, cls) => {
    const row = h('div.t-chips' + (cls ? '.' + cls : ''), { role: 'tablist' });
    const nodes = items.map((it) => {
      const n = h('button.t-chip', { type: 'button', role: it.toggle ? null : 'tab' });
      if (it.icon) n.appendChild(ui.icon(it.icon));
      n.appendChild(h('span', { text: it.label }));
      if (it.value) n.appendChild(h('span.t-chip-value', { text: it.value }));
      n.addEventListener('click', () => onPick(it.id, n));
      row.appendChild(n);
      return n;
    });
    row.select = (id) => items.forEach((it, i) => {
      nodes[i].classList.toggle('on', it.id === id);
      if (!it.toggle) nodes[i].setAttribute('aria-selected', String(it.id === id));
    });
    row.nodes = nodes;
    row.select(selected);
    return row;
  };

  // ---- Long press (and right-click): a title's quick actions ------------------------------------------

  // web/web.js turns a 550 ms press into a contextmenu event (and swallows the click that follows),
  // Android sends its own; marking it handled stops the stage acting on it too.
  ui.onHold = (node, fn) => {
    node.addEventListener('contextmenu', (e) => {
      // (it must reach web/web.js, which then swallows the click that ends the press)
      if (e.plHandled) return;
      e.preventDefault();
      e.plHandled = true;
      fn(e);
    });
  };

  // ---- Cards -------------------------------------------------------------------------------------

  const P = PL.ui;
  ui.progress = (frac) => {
    const bar = h('span.t-progress');
    const fill = h('span.t-progress-fill');
    fill.style.width = Math.round(PL.clamp(frac, 0, 1) * 1000) / 10 + '%';
    bar.appendChild(fill);
    return bar;
  };

  // The item's own caption: "Title · 2019", "S1 · E2 · 6m left"...
  ui.caption = (item) => {
    const left = PL.fmt.remaining(item);
    if (item.type === 'episode') return [PL.fmt.episode(item), left].filter(Boolean).join(' · ');
    if (left) return left;
    return P.itemSubtitle(item);
  };

  function wire(n, item, opts) {
    n.addEventListener('click', () => (opts.onSelect || T.open)(item));
    ui.onHold(n, () => (opts.onHold || T.menu)(item, () => opts.onChange && opts.onChange(item)));
  }

  // A 2:3 poster. opts: {caption: true (title and year under it), onSelect, onHold, onChange}
  ui.poster = (item, opts = {}) => {
    const n = h('button.t-card.t-poster', { type: 'button', 'aria-label': P.itemTitle(item) || '' });
    const frame = h('span.t-card-frame');
    const path = item.type === 'person' || item.type === 'tag' ? item.thumb : P.posterPath(item);
    frame.appendChild(ui.img(ui.imageUrl(path, opts.w || 120, (opts.w || 120) * 1.5)));
    if (!path || item.type === 'collection') frame.appendChild(h('span.t-card-alt', { text: P.itemTitle(item) || '' }));
    if (P.isWatched(item)) frame.appendChild(h('span.t-watched', null, ui.icon('check')));
    const pr = P.progress(item);
    if (pr > 0) frame.appendChild(ui.progress(pr));
    n.appendChild(frame);
    if (opts.caption) {
      n.appendChild(h('span.t-card-title', { text: P.itemTitle(item) || '' }));
      const sub = item.type === 'episode' ? PL.fmt.episode(item) : P.itemSubtitle(item);
      if (sub) n.appendChild(h('span.t-card-sub', { text: sub }));
    }
    wire(n, item, opts);
    return n;
  };

  // A 16:9 card with its title on the art (Continue Watching, episodes).
  ui.wide = (item, opts = {}) => {
    const n = h('button.t-card.t-wide', { type: 'button', 'aria-label': P.itemTitle(item) || '' });
    const frame = h('span.t-card-frame');
    frame.appendChild(ui.img(ui.imageUrl(P.widePath(item), opts.w || 240, (opts.w || 240) * 9 / 16)));
    frame.appendChild(h('span.t-card-shade'));
    const text = h('span.t-card-text');
    text.appendChild(h('span.t-card-title', { text: opts.title || P.itemTitle(item) || '' }));
    const cap = opts.sub != null ? opts.sub : ui.caption(item);
    if (cap) text.appendChild(h('span.t-card-sub', { text: cap }));
    frame.appendChild(text);
    const pr = P.progress(item);
    if (pr > 0) frame.appendChild(ui.progress(pr));
    else if (P.isWatched(item)) frame.appendChild(h('span.t-watched', null, ui.icon('check')));
    n.appendChild(frame);
    wire(n, item, opts);
    return n;
  };

  // A person: round photo, name, role.
  ui.personCard = (p, opts = {}) => {
    const n = h('button.t-card.t-personcard', { type: 'button' });
    const photo = h('span.t-person-photo');
    if (p.thumb) photo.appendChild(ui.img(ui.imageUrl(p.thumb, 88, 88)));
    else photo.appendChild(h('span.t-person-initials', { text: (p.tag || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('') }));
    n.appendChild(photo);
    n.appendChild(h('span.t-card-title', { text: p.tag || '' }));
    if (p.role) n.appendChild(h('span.t-card-sub', { text: p.role }));
    n.addEventListener('click', () => (opts.onSelect || ((x) => T.openPerson(x)))(p));
    return n;
  };

  // ---- Shelves: a heading, then cards that scroll sideways (natively) --------------------------------

  // opts: {title, items, kind: 'poster' | 'wide' | 'person', onMore (heading opens the full list),
  //        loadMore(start) -> Promise<items>, total, card(item) -> node, caption}
  ui.shelf = (opts) => {
    const sec = h('section.t-shelf.t-shelf-' + (opts.kind || 'poster'));
    const head = h('div.t-shelf-head');
    head.appendChild(h('h2.t-shelf-title', { text: opts.title || '' }));
    if (opts.onMore) {
      const more = h('button.t-shelf-more', { type: 'button', on: { click: opts.onMore } }, ['See all', ui.icon('chevron')]);
      head.appendChild(more);
    }
    sec.appendChild(head);
    const row = h('div.t-row');
    sec.appendChild(row);
    const make = opts.card || ((item) => (opts.kind === 'wide' ? ui.wide(item, { onChange: () => {} })
      : opts.kind === 'person' ? ui.personCard(item) : ui.poster(item, { caption: opts.caption })));
    let count = 0;
    const add = (items) => items.forEach((it) => { if (it) { row.appendChild(make(it)); count++; } });
    add(opts.items || []);
    // more items when the row nears its end
    if (opts.loadMore && opts.total > count) {
      let busy = false;
      row.addEventListener('scroll', () => {
        if (busy || count >= opts.total || row.scrollLeft + row.clientWidth < row.scrollWidth - row.clientWidth) return;
        busy = true;
        opts.loadMore(count).then((items) => {
          busy = false;
          if (!items.length) opts.total = count;
          add(items);
        }, () => { busy = false; });
      }, { passive: true });
    }
    sec.row = row;
    sec.replace = (items) => { PL.clear(row); count = 0; add(items); };
    return sec;
  };

  // ---- Grid: posters that load page by page as you scroll ---------------------------------------------

  // opts: {fetch(start, size) -> Promise<{total, items}>, card(item), page (size), empty: text,
  //        onTotal(total)}. Returns a node with .reset().
  ui.grid = (opts) => {
    const wrap = h('div.t-grid-wrap');
    const grid = h('div.t-grid' + (opts.cls ? '.' + opts.cls : ''));
    const foot = h('div.t-grid-foot');
    wrap.appendChild(grid);
    wrap.appendChild(foot);
    const size = opts.page || 60;
    let gen = 0;
    let dead = false;
    let loaded = 0;
    let total = Infinity;
    let busy = false;
    const more = () => {
      if (dead || busy || loaded >= total) return;
      busy = true;
      const g = gen;
      foot.replaceChildren(ui.spinner());
      opts.fetch(loaded, size).then((res) => {
        if (g !== gen) return;
        busy = false;
        total = res.total;
        res.items.forEach((it) => grid.appendChild((opts.card || ui.poster)(it)));
        loaded += res.items.length;
        if (!res.items.length) total = loaded;
        foot.replaceChildren();
        if (!loaded) foot.appendChild(h('div.t-empty', { text: opts.empty || 'Nothing here yet' }));
        if (opts.onTotal) opts.onTotal(total);
        // a short first page leaves the sentinel on screen: keep going
        requestAnimationFrame(() => { if (seen) more(); });
      }, (err) => {
        if (g !== gen) return;
        busy = false;
        foot.replaceChildren(h('div.t-empty', { text: PL.errorMessage(err) }), ui.button({ label: 'Try again', action: more }));
      });
    };
    let seen = false;
    const io = new IntersectionObserver((entries) => {
      seen = entries.some((e) => e.isIntersecting);
      if (seen) more();
    }, { rootMargin: '0px 0px 900px 0px' });
    io.observe(foot);
    wrap.reset = () => { gen++; loaded = 0; total = Infinity; busy = false; grid.replaceChildren(); more(); };
    wrap.grid = grid;
    wrap.loaded = () => loaded;
    wrap.destroy = () => { dead = true; gen++; io.disconnect(); };
    more();
    return wrap;
  };

  ui.spinner = () => h('div.t-spinner', { role: 'status', 'aria-label': 'Loading' });
  ui.empty = (text) => h('div.t-empty', { text });

  // ---- Chrome: the top bar of a tab, the Back chevron of a pushed page ---------------------------------

  ui.logo = () => h('div.t-logo', null, [
    h('img.t-logo-mark', { src: 'web/touch/mark.svg', alt: '', draggable: false }),
    h('span.t-logo-name', null, ['Plex ', h('span', { text: 'Lite' })]),
  ]);

  // The profile picture (or initial) that opens Settings.
  ui.avatar = () => {
    const n = h('button.t-avatar', { type: 'button', 'aria-label': 'Profile and settings', on: { click: () => T.openSettings() } });
    let seen = false;
    let off = null;
    const fill = () => {
      // the page holding it has gone: stop listening
      if (n.isConnected) seen = true;
      else if (seen) { if (off) off(); return; }
      const p = T.profile || {};
      n.replaceChildren();
      if (p.thumb) {
        const img = ui.img(p.thumb, null, true);
        n.appendChild(img);
      } else {
        n.appendChild(h('span', { text: (p.title || '?').slice(0, 1).toUpperCase() }));
      }
    };
    fill();
    off = T.onProfile(fill);
    return n;
  };

  // A tab's top bar: logo left, avatar right. over: drawn over artwork (no fill until scrolled).
  ui.topBar = (opts = {}) => {
    const bar = h('header.t-top' + (opts.over ? '.t-top-over' : ''));
    bar.appendChild(opts.title ? h('h1.t-top-title', { text: opts.title }) : ui.logo());
    const right = h('div.t-top-right');
    (opts.actions || []).forEach((a) => right.appendChild(ui.button(Object.assign({ kind: 'round' }, a))));
    right.appendChild(ui.avatar());
    bar.appendChild(right);
    return bar;
  };

  // A pushed page's glass Back chevron (and an optional "…" on the right).
  ui.backBar = (opts = {}) => {
    const bar = h('div.t-backbar');
    bar.appendChild(ui.button({ kind: 'round', icon: 'back', label: 'Back', action: () => T.back() }));
    if (opts.title) bar.appendChild(h('div.t-backbar-title', { text: opts.title }));
    if (opts.more) bar.appendChild(ui.button({ kind: 'round', icon: 'more', label: 'More options', action: opts.more }));
    return bar;
  };

  // A title as its clearLogo, or as text when there isn't one (or it fails to load).
  ui.titleArt = (item, cls) => {
    const title = P.itemTitle(item) || item.title || '';
    const box = h('div.t-titleart' + (cls ? '.' + cls : ''));
    const text = h('h1.t-titletext', { text: title });
    box.appendChild(text);
    const logo = P.logoPath(item);
    if (logo) {
      const img = h('img.t-titlelogo', { alt: title, draggable: false });
      img.addEventListener('load', () => box.classList.add('t-has-logo'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = P.logoUrl(logo);
      box.appendChild(img);
    }
    return box;
  };
})();
