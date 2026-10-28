// Live TV on a phone or tablet, for now (docs/WEB.md, "Phones and tablets"): what's on each
// channel, favourites first, and a tap to watch it in the live player. The full guide (board P4)
// comes in a later phase; until then "TV guide" opens the TV's guide on the stage.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const G = PL.liveGuide;
  const L = PL.liveLogic;
  const now = () => Math.floor(Date.now() / 1000);

  // A channel's badge: its logo, else its number and name.
  function badge(c) {
    const b = h('span.t-ch-badge');
    if (c.thumb) {
      const img = ui.img(PL.plex.image(c.thumb, 120, 72, { format: 'png', minSize: 0 }), 't-ch-logo');
      img.addEventListener('error', () => b.appendChild(h('span.t-ch-name', { text: c.name || c.vcn })), { once: true });
      b.appendChild(img);
    } else {
      b.appendChild(h('span.t-ch-name', { text: c.name || c.vcn }));
    }
    return b;
  }

  T.screens.live = () => {
    const page = T.page('t-live t-flow');
    page.el.appendChild(ui.topBar({ title: 'Live TV' }));
    const intro = h('div.t-live-intro');
    intro.appendChild(ui.button({ kind: 'glass', icon: 'grid', label: 'TV guide', action: () => PL.app.push(PL.screens.livetv()) }));
    page.el.appendChild(intro);
    const list = h('div.t-ch-list');
    const status = h('div', null, ui.spinner());
    page.el.appendChild(status);
    page.el.appendChild(list);
    let alive = true;
    let channels = [];
    let painted = 0;

    function watch(i) {
      if (!G.src) return;
      const shape = (x) => ({ identifier: x.identifier, id: x.id, vcn: x.vcn, title: x.name, thumb: x.thumb });
      T.playLive({ label: 'All channels', dvrKey: G.src.dvrKey, channel: shape(channels[i]), channels: channels.map(shape), index: i });
    }

    function row(c, i) {
      const nn = G.nowNext(c.identifier);
      const a = nn.now;
      const n = h('button.t-ch', { type: 'button', on: { click: () => watch(i) } });
      n.appendChild(badge(c));
      const text = h('span.t-ch-text');
      const head = h('span.t-ch-head');
      head.appendChild(h('span.t-ch-num', { text: c.vcn || '' }));
      if (G.isFavourite(c.identifier)) head.appendChild(ui.icon('star', 't-ch-fav'));
      head.appendChild(h('span.t-ch-title', { text: a ? L.programme(a).title : (nn.next ? 'Nothing on until ' + L.clock(nn.next.b) : c.name || '') }));
      text.appendChild(head);
      if (a) {
        text.appendChild(h('span.t-ch-sub', { text: [c.name, Math.max(1, Math.round((a.e - now()) / 60)) + 'm left'].filter(Boolean).join(' · ') }));
        text.appendChild(ui.progress(L.progress(a, now())));
      } else {
        text.appendChild(h('span.t-ch-sub', { text: c.name || '' }));
      }
      n.appendChild(text);
      n.appendChild(h('span.t-ch-play', null, ui.icon('play')));
      ui.onHold(n, () => {
        const on = G.toggleFavourite(c.identifier);
        T.toast(on ? 'Added ' + c.name + ' to Favourites' : 'Removed ' + c.name + ' from Favourites');
        paint();
      });
      return n;
    }

    function paint() {
      if (!alive) return;
      const favs = G.favourites();
      const all = G.channels.slice();
      channels = all.filter((c) => favs.indexOf(c.identifier) >= 0).concat(all.filter((c) => favs.indexOf(c.identifier) < 0));
      list.replaceChildren();
      channels.forEach((c, i) => list.appendChild(row(c, i)));
      painted = Date.now();
      status.replaceChildren();
      if (!channels.length) status.appendChild(ui.empty('No channels'));
    }

    const unlisten = G.listen(() => { if (alive && Date.now() - painted > 1000) paint(); });
    function load() {
      G.load().then(() => paint(), (err) => {
        if (!alive) return;
        status.replaceChildren(ui.empty(err && err.noDvr ? err.message : PL.errorMessage(err)),
          ui.button({ label: 'Try again', action: () => { status.replaceChildren(ui.spinner()); load(); } }));
      });
    }
    load();
    // the times move on: repaint when the page comes back after a minute
    page.onShow = () => {
      if (painted && Date.now() - painted > 60000) G.ensure(now(), now() + 3600).then(paint, paint);
    };
    page.destroy = () => { alive = false; unlisten(); };
    return page;
  };
})();
