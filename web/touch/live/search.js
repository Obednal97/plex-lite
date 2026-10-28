// Live TV on phones and tablets: searching channels and programmes from the guide's header. The
// matching is the TV Search's (js/livetv-search.js): channel names and numbers, and the titles of
// what is on now and later. Before typing it lists the channels watched last.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.live) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const G = PL.liveGuide;
  const L = PL.liveLogic;
  const S = PL.liveSearch;
  const X = PL.touchLiveLogic;
  const LV = T.live;

  // A channel or programme as a row: the logo plate, two lines, a play glyph when it's on now.
  function row(c, line1, line2, on, tap, hold) {
    const n = h('button.t-lv-res', { type: 'button' });
    n.appendChild(LV.plate(c, 58, 32, 't-lv-plate-sm'));
    const text = h('span.t-lv-res-text');
    text.appendChild(h('span.t-lv-res-1', { text: line1 }));
    if (line2) text.appendChild(h('span.t-lv-res-2', { text: line2 }));
    n.appendChild(text);
    if (on) n.appendChild(h('span.t-lv-res-play', null, ui.icon('play')));
    n.addEventListener('click', tap);
    ui.onHold(n, hold);
    return n;
  }

  // opts: {onGuide(channel, time)}: "Show in guide" from a programme's details
  LV.searchPage = (opts = {}) => {
    const page = T.page('t-lv-search t-flow');
    const bar = h('div.t-lv-search-bar');
    bar.appendChild(ui.button({ kind: 'round', icon: 'back', label: 'Back', action: () => T.back() }));
    const field = h('label.t-lv-search-field');
    field.appendChild(ui.icon('search'));
    const input = h('input.t-lv-search-input', {
      type: 'search', placeholder: 'Channels and programmes', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
      enterkeyhint: 'search', 'aria-label': 'Search Live TV',
    });
    field.appendChild(input);
    bar.appendChild(field);
    page.el.appendChild(bar);
    const results = h('div.t-lv-results');
    page.el.appendChild(results);

    let chIndex = null;
    let guideIndex = null;
    let builtAt = -1;
    let cache = {};
    const index = () => {
      if (!chIndex || builtAt !== G.version) {
        chIndex = S.indexChannels(G.channels);
        cache = S.trimCache(cache);
        guideIndex = S.indexGuide(G.channels, (id) => G.list(id), LV.now(), cache);
        builtAt = G.version;
      }
    };

    const section = (title, nodes) => {
      if (!nodes.length) return;
      results.appendChild(h('h2.t-lv-res-head', { text: title }));
      const list = h('div.t-lv-res-list');
      nodes.forEach((n) => list.appendChild(n));
      results.appendChild(list);
    };

    const channelRow = (c) => {
      const nn = G.nowNext(c.identifier);
      const a = nn.now;
      return row(c, (c.vcn ? c.vcn + '  ' : '') + c.name, a ? a.title + ' · ' + X.left(a, LV.now()) : 'No guide information', true,
        () => LV.watchChannel(c, null), () => LV.menu(c, a));
    };

    const paint = () => {
      const text = input.value;
      results.replaceChildren();
      const q = S.query(text);
      if (!q) {
        const recent = LV.recent().map((id) => G.byId[id]).filter(Boolean);
        section(recent.length ? 'Watched lately' : '', recent.map(channelRow));
        if (!recent.length) results.appendChild(ui.empty('Search by channel name or number, or by programme.'));
        return;
      }
      index();
      const t = LV.now();
      const chans = S.matchChannels(chIndex, q, { limit: 20, isFavourite: (id) => G.isFavourite(id) });
      const progs = S.matchProgrammes(guideIndex, q, t, 30);
      section('Channels', chans.map(channelRow));
      section('On TV', progs.map((hit) => {
        const when = hit.onNow ? X.left(hit.a, t) : L.times(hit.a, t);
        return row(hit.c, hit.a.title, (hit.c.vcn ? hit.c.vcn + ' ' : '') + hit.c.name + ' · ' + when, hit.onNow,
          () => (hit.onNow ? LV.watchChannel(hit.c, null) : LV.details(hit.c, hit.a, { onGuide: opts.onGuide ? () => opts.onGuide(hit.c, hit.a.b) : null })),
          () => LV.menu(hit.c, hit.a));
      }));
      if (!chans.length && !progs.length) results.appendChild(ui.empty('Nothing on Live TV matches "' + text.trim() + '"'));
    };

    let timer = 0;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(paint, 90); });
    input.addEventListener('keydown', (e) => {
      // Enter puts the keyboard away (js/app.js leaves keys typed into a field alone)
      if (e.key === 'Enter') { input.blur(); e.preventDefault(); }
      e.stopPropagation();
    });
    // scrolling the results puts the keyboard away
    const dismiss = () => { if (document.activeElement === input && !page.el.hidden) input.blur(); };
    results.addEventListener('touchmove', dismiss, { passive: true });
    const unlisten = G.listen(() => { if (!page.el.hidden && input.value) paint(); });
    page.onShow = ({ back } = {}) => {
      paint();
      if (!back) setTimeout(() => input.focus(), 280);
    };
    page.destroy = () => { unlisten(); clearTimeout(timer); };
    return page;
  };
})();
