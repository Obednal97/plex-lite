// Live TV on phones and tablets (board P4): the Live TV tab's page (PL.touch.screens.live). The
// header (search, Go to channel, the filter sheet), the chips (Favourites, All, On now and the
// categories), "Last watched", then the time grid (web/touch/live/grid.js) or, on On now, the feed
// of shelves (onnow.js). The page is one scroller that scrolls both ways: the header scrolls away
// upwards and stays put sideways, the time ruler sticks under the status bar.
// Opens on Favourites whenever there are some (the owner's choice, as on the TV).
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.live) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const G = PL.liveGuide;
  const B = PL.liveBrowse;
  const X = PL.touchLiveLogic;
  const LV = T.live;
  const html = document.documentElement;

  T.screens.live = () => {
    const page = T.page('t-lv');
    const scroller = h('div.t-lv-scroll');
    const canvas = h('div.t-lv-canvas');
    scroller.appendChild(canvas);
    page.el.appendChild(scroller);

    // ---- Header ------------------------------------------------------------------------------------
    const head = h('div.t-lv-head');
    const top = ui.topBar({ title: 'Live TV' });
    const right = top.querySelector('.t-top-right');
    right.insertBefore(LV.roundButton('search', 'Search Live TV', () => openSearch()), right.firstChild);
    right.insertBefore(LV.roundButton('dialpad', 'Go to channel', () => openPad()), right.children[1]);
    right.insertBefore(LV.roundButton('filter', 'Browse channels', () => openFilter()), right.children[2]);
    head.appendChild(top);
    const chipHost = h('div.t-lv-chiprow');
    head.appendChild(chipHost);
    const recentHost = h('div.t-lv-recent');
    head.appendChild(recentHost);
    canvas.appendChild(head);

    const grid = new LV.Grid({
      onTap: (c, a) => tapCell(c, a),
      onHold: (c, a) => LV.menu(c, a, watchOpts()),
      onChannel: (c) => LV.watchChannel(c, list, label()),
      onChannelHold: (c) => LV.menu(c, G.nowNext(c.identifier).now, watchOpts()),
    });
    canvas.appendChild(grid.ruler);
    canvas.appendChild(grid.body);
    const pane = h('div.t-lv-pane');
    const status = h('div.t-lv-status');
    pane.appendChild(status);
    const feed = new LV.OnNow();
    pane.appendChild(feed.el);
    canvas.appendChild(pane);
    grid.attach(scroller);
    LV.page = page;
    page.grid = grid;

    // ---- State ---------------------------------------------------------------------------------------
    let alive = true;
    let shown = false;
    let loaded = false;
    let failed = null;
    let sel = G.openingSel();
    G.setBrowse(sel, true);
    let seenSeq = G.browseSeq; // the player's Browse rail can change the filter: followed on return
    let list = [];
    let geoKey = null;
    let saved = { top: 0, left: 0 };

    const isWall = () => sel.base === 'now';
    const label = () => B.selLabel(sel, G.channels.length ? G.browseCtx() : {});
    const watchOpts = () => ({ list, label: label() });

    // ---- Layout: phone, phone on its side, tablet ---------------------------------------------------
    function layout() {
      const geo = X.geometry(T.kind, html.classList.contains('t-short'));
      const key = T.kind + (html.classList.contains('t-short') ? 's' : '');
      canvas.style.setProperty('--lv-w', scroller.clientWidth + 'px');
      if (key !== geoKey) {
        // (rotating the phone changes the px per minute: keep the same time at the left edge)
        const t = geoKey && grid.geo ? grid.leftTime() : null;
        geoKey = key;
        grid.setGeometry(geo);
        canvas.style.width = isWall() || !list.length ? '' : grid.width() + 'px';
        if (t != null) grid.showTime(t + 24 / geo.pps);
      }
      canvas.style.width = isWall() || !list.length ? '' : grid.width() + 'px';
      grid.measure();
    }
    const onResize = PL.debounce(() => { if (alive && shown) layout(); }, 120);
    window.addEventListener('resize', onResize);

    // ---- Chips and the filter ---------------------------------------------------------------------------
    let chipSig = null;
    let chips = null;
    function paintChips() {
      const ctx = G.channels.length ? G.browseCtx() : null;
      const entries = ctx ? B.railEntries(G.channels, ctx) : [];
      const items = X.chips(entries, sel.base, (k) => B.label(k, ctx || {}));
      // a refinement from the filter sheet shows on the chip of its choice
      if (sel.refine && ctx) items.forEach((it) => { if (it.id === sel.base) it.value = '› ' + B.label(sel.refine, ctx); });
      const sig = items.map((it) => it.id + ':' + it.label + ':' + (it.value || '')).join('|');
      if (sig === chipSig && chips) {
        chips.select(sel.base);
        return;
      }
      chipSig = sig;
      chips = ui.chips(items.map((it) => Object.assign({}, it, { icon: it.icon === 'filter' ? null : it.icon })), sel.base, (id) => {
        if (id === sel.base && !sel.refine) return;
        setSel({ base: id, refine: null });
      }, 't-lv-chips');
      // the kit's chips know only its own icons: the family chip gets the filter glyph here
      items.forEach((it, i) => { if (it.icon === 'filter') chips.nodes[i].insertBefore(LV.icon('filter'), chips.nodes[i].firstChild); });
      chipHost.replaceChildren(chips);
      // the chosen chip in view (only the chip row moves: scrollIntoView would move the page too)
      const on = chips.querySelector('.t-chip.on');
      if (on && (on.offsetLeft + on.offsetWidth > chips.clientWidth || on.offsetLeft < chips.scrollLeft)) {
        chips.scrollLeft = Math.max(0, on.offsetLeft - 24);
      }
      grid.measure();
    }

    function setSel(next, focusId) {
      const ctx = G.channels.length ? G.browseCtx() : null;
      sel = ctx ? B.normalise(next, ctx) : { base: next.base, refine: next.refine || null };
      // Favourites with none yet stays chosen (it says how to add some) but isn't saved
      G.setBrowse(sel, sel.base === 'fav' && !G.favourites().length);
      seenSeq = G.browseSeq;
      paintChips();
      paintBody(false);
      // a new list starts at its top (when the rows had been scrolled to)
      if (!isWall() && list.length && scroller.scrollTop > grid.rowsTop()) scroller.scrollTop = grid.rowsTop();
      if (focusId) {
        const i = list.findIndex((c) => c.identifier === focusId);
        if (i >= 0) grid.showRow(i, true);
      }
    }

    function openFilter() {
      if (!G.channels.length) return;
      LV.filterSheet(sel, (s) => setSel(s));
    }

    // ---- Last watched ---------------------------------------------------------------------------------
    let recentSig = null;
    function paintRecent() {
      const t = LV.now();
      const chans = LV.recent().map((id) => G.byId[id]).filter(Boolean);
      const parts = chans.map((c) => {
        const a = G.nowNext(c.identifier, t).now;
        return { c, a, text: a ? a.title + ' · ' + X.left(a, t) : 'No guide information' };
      });
      const sig = parts.map((p) => p.c.identifier + p.text).join('|');
      if (sig === recentSig) return;
      recentSig = sig;
      recentHost.replaceChildren();
      if (!parts.length) { grid.measure(); return; }
      const row = h('div.t-lv-recent-row' + (parts.length > 1 ? '.t-lv-recent-many' : ''));
      parts.forEach((p, i) => {
        const n = h('button.t-lv-last', { type: 'button', 'aria-label': 'Watch ' + p.c.name });
        n.appendChild(h('span.t-lv-live', { text: 'LIVE' }));
        const text = h('span.t-lv-last-text');
        text.appendChild(h('span.t-lv-last-1', { text: (i === 0 ? 'Last watched: ' : '') + p.c.name }));
        text.appendChild(h('span.t-lv-last-2', { text: p.text }));
        n.appendChild(text);
        n.appendChild(h('span.t-lv-last-play', null, ui.icon('play')));
        n.addEventListener('click', () => LV.watchChannel(p.c, list, label()));
        ui.onHold(n, () => LV.menu(p.c, p.a, watchOpts()));
        row.appendChild(n);
      });
      recentHost.appendChild(row);
      grid.measure();
    }

    // ---- The grid or the feed ------------------------------------------------------------------------------
    function paintStatus() {
      status.replaceChildren();
      if (failed) {
        status.appendChild(ui.empty(failed));
        status.appendChild(ui.button({ label: 'Try again', action: () => { failed = null; paintStatus(); load(); } }));
        return;
      }
      if (!loaded && !G.channels.length) { status.appendChild(ui.spinner()); return; }
      if (isWall() || list.length) return;
      if (sel.base === 'fav') {
        const box = h('div.t-lv-nofav');
        box.appendChild(LV.icon('star', 't-lv-nofav-icon'));
        box.appendChild(h('div.t-lv-nofav-title', { text: 'No favourites yet' }));
        box.appendChild(h('div.t-lv-nofav-text', { text: 'Press and hold a channel or a programme to add it to Favourites.' }));
        box.appendChild(ui.button({ label: 'Show all channels', action: () => setSel({ base: 'all' }) }));
        status.appendChild(box);
        return;
      }
      status.appendChild(ui.empty('No channels here'));
    }

    // keep: fresh data for the same filter (the rows stay where they are)
    function paintBody(keep) {
      const wall = isWall();
      page.el.classList.toggle('t-lv-wall', wall);
      list = wall || !G.channels.length ? [] : G.channelsFor(sel);
      grid.setList(list, keep);
      if (wall) feed.refresh(!keep);
      else {
        feed.clear();
        if (keep) grid.refresh();
      }
      page.el.classList.toggle('t-lv-empty', !wall && !list.length);
      paintStatus();
      layout();
    }

    function onData() {
      if (!alive) return;
      if (G.channels.length) {
        const norm = B.normalise(sel, G.browseCtx());
        if (norm.base !== sel.base || norm.refine !== sel.refine) {
          sel = norm;
          G.setBrowse(sel, true);
          seenSeq = G.browseSeq;
        }
      }
      paintChips();
      paintRecent();
      paintBody(true);
      takeOpenAt();
    }

    function load() {
      G.load().then(() => {
        if (!alive) return;
        loaded = true;
        onData();
        // the next hours in the background, so scrolling right finds them loaded
        setTimeout(() => { if (alive) G.ensure(LV.now(), LV.now() + 5 * 3600).catch(() => {}); }, 1500);
      }, (err) => {
        if (!alive) return;
        failed = err && err.noDvr ? err.message : 'Couldn\'t load the guide: ' + PL.errorMessage(err);
        paintStatus();
      });
    }

    // ---- Taps ---------------------------------------------------------------------------------------------
    function tapCell(c, a) {
      if (!a || X.when(a, LV.now()) === 'now') return LV.watchChannel(c, list, label());
      LV.details(c, a, watchOpts());
    }

    // Shows a channel in the guide (switching to All channels when the filter hides it).
    function goToChannel(c, t) {
      if (isWall() || LV.indexOf(list, c) < 0) setSel({ base: 'all', refine: null });
      const i = LV.indexOf(list, c);
      if (i < 0) return;
      grid.showTime(t ? Math.max(t, LV.now()) : grid.origin);
      grid.showRow(i, true);
    }

    // Search (the app's, or ours) asked for a channel at a time
    function takeOpenAt() {
      const want = G.openAt;
      if (!want || !G.channels.length) return;
      const c = G.byId[want.identifier];
      if (!c) return;
      G.openAt = null;
      goToChannel(c, want.t);
    }

    function openSearch() {
      T.push(LV.searchPage({
        onGuide: (c, t) => {
          // back to the guide first, then show the channel there
          G.openAt = { identifier: c.identifier, t };
          T.back();
        },
      }));
    }

    function openPad() {
      if (!G.channels.length) return;
      LV.numberPad({
        onGuide: (c) => goToChannel(c),
        onWatch: (c) => LV.watchChannel(c, list, label()),
      });
    }

    // ---- The status bar band, the minute -------------------------------------------------------------------
    let scrolled = false;
    scroller.addEventListener('scroll', () => {
      saved = { top: scroller.scrollTop, left: scroller.scrollLeft };
      const on = scroller.scrollTop > 8;
      if (on !== scrolled) {
        scrolled = on;
        html.classList.toggle('t-scrolled', on);
      }
    }, { passive: true });

    let timer = 0;
    let minute = 0;
    function tick() {
      // (nothing to do while the player has the screen: onShow catches up)
      if (!T.visible || T.covered || !shown) return;
      grid.paintNow();
      const m = Math.floor(Date.now() / 60000);
      if (m === minute) return;
      minute = m;
      grid.tick();
      paintRecent();
      if (isWall()) feed.refresh();
      G.ensure(LV.now(), LV.now() + 3600).catch(() => {});
    }

    // ---- Page life ---------------------------------------------------------------------------------------------
    page.onShow = () => {
      shown = true;
      grid.hidden = false;
      grid.measure();
      const watched = LV.takeWatching();
      // back after a long time away: start the guide again at the current half hour
      if (LV.now() - grid.origin > 90 * 60 && grid.rebase()) saved.left = 0;
      layout();
      if (scroller.scrollTop !== saved.top || scroller.scrollLeft !== saved.left) scroller.scrollTo({ top: saved.top, left: saved.left });
      scrolled = saved.top > 8;
      html.classList.toggle('t-scrolled', scrolled);
      // the player's Browse rail changed the filter: follow it, on the channel that was on
      if (seenSeq !== G.browseSeq) {
        const g = G.getBrowse();
        seenSeq = G.browseSeq;
        if (g.base !== sel.base || g.refine !== sel.refine) setSel(g, watched);
      }
      if (loaded) onData();
      // the shell's own scroll listener may clear the status bar band after this (its window moved)
      requestAnimationFrame(() => requestAnimationFrame(() => { if (shown) html.classList.toggle('t-scrolled', scrolled); }));
      clearInterval(timer);
      minute = Math.floor(Date.now() / 60000);
      timer = setInterval(tick, 15000);
    };
    page.onHide = () => {
      shown = false;
      grid.hidden = true;
      clearInterval(timer);
      timer = 0;
      html.classList.remove('t-scrolled');
    };
    page.onReselect = () => scroller.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    page.destroy = () => {
      alive = false;
      clearInterval(timer);
      unlisten();
      window.removeEventListener('resize', onResize);
      grid.destroy();
      feed.destroy();
      LV.forgetPlates();
      if (LV.page === page) LV.page = null;
    };

    // (not while the player has the screen: onShow catches up)
    const unlisten = G.listen(() => { if (alive && loaded && shown && T.visible && !T.covered) onData(); });
    paintChips();
    paintStatus();
    load();
    return page;
  };
})();
