// Live TV on phones and tablets (board P4): On now, the TV's On now wall as a feed. Shelves of what
// is on now (Favourites first, then each category, a programme under its own category: the TV's
// rules, js/livetv-browse.js shelves), each a row of 16:9 cards that scrolls sideways. Cards get
// their art and logo only when they come near the screen, so ~400 channels on now cost little.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.live) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const G = PL.liveGuide;
  const L = PL.liveLogic;
  const B = PL.liveBrowse;
  const X = PL.touchLiveLogic;
  const LV = T.live;

  // tints for programmes without art (the TV wall's, muted)
  const TINTS = ['#3a4a5c', '#4a3a5c', '#5c4a3a', '#3a5c4f', '#5c3a48', '#4f5c3a', '#3a515c', '#57503a'];

  class OnNow {
    constructor() {
      this.el = h('div.t-lv-feed');
      this.sig = null;
      // a shelf near the screen (by the page's scroll) watches its own row for cards coming near
      // (by the row's sideways scroll): rootMargin only widens the root, not the row that clips
      this.rowObservers = [];
      this.io = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        this.io.unobserve(e.target);
        this.watchRow(e.target.row);
      }), { rootMargin: '400px 0px' });
    }

    watchRow(row) {
      const io = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        if (e.target._fill) e.target._fill();
      }), { root: row, rootMargin: '0px 600px' });
      Array.from(row.children).forEach((n) => { if (n._fill) io.observe(n); });
      this.rowObservers.push(io);
    }

    disconnect() {
      this.io.disconnect();
      this.rowObservers.forEach((io) => io.disconnect());
      this.rowObservers = [];
    }

    // Rebuilds the shelves when what is on changed (force: always).
    refresh(force) {
      const ctx = G.browseCtx();
      const shelves = B.shelves(G.onNow(LV.now()), ctx);
      const sig = shelves.map((s) => s.key + ':' + s.items.map((x) => x.channel.identifier + '@' + x.airing.b).join(',')).join('|');
      if (!force && sig === this.sig) return false;
      this.sig = sig;
      const keep = {};
      this.el.querySelectorAll('.t-row').forEach((r) => { keep[r.dataset.key] = r.scrollLeft; });
      this.disconnect();
      this.el.replaceChildren();
      if (!shelves.length) {
        this.el.appendChild(ui.empty(G.channels.length ? 'Nothing on now has guide information.' : 'Loading the guide…'));
        return true;
      }
      shelves.forEach((s) => {
        const channels = s.items.map((x) => x.channel);
        const label = 'On now › ' + s.label;
        const shelf = ui.shelf({
          title: s.label, kind: 'wide', items: s.items,
          card: (x) => this.card(x, channels, label),
        });
        shelf.querySelector('.t-shelf-head').appendChild(h('span.t-lv-shelf-count', { text: s.items.length + ' on now' }));
        shelf.row.dataset.key = s.key;
        this.el.appendChild(shelf);
        if (keep[s.key]) shelf.row.scrollLeft = keep[s.key];
        this.io.observe(shelf);
      });
      return true;
    }

    card(x, channels, label) {
      const c = x.channel;
      const a = x.airing;
      const t = LV.now();
      const n = h('button.t-card.t-wide.t-lv-card', { type: 'button', 'aria-label': c.name + ': ' + a.title });
      const frame = h('span.t-card-frame');
      n.appendChild(frame);
      const caption = h('span.t-lv-card-cap');
      caption.appendChild(h('span.t-card-title', { text: a.title }));
      const nn = G.nowNext(c.identifier, t);
      caption.appendChild(h('span.t-card-sub', { text: [c.vcn + ' ' + c.name, X.left(a, t)].join(' · ') + (nn.next ? ' · Next: ' + nn.next.title : '') }));
      n.appendChild(caption);
      const pr = ui.progress(L.progress(a, t));
      frame.appendChild(pr);
      // art and logo once near the screen
      n._fill = () => {
        const art = a.art && a.art !== c.thumb ? a.art : null;
        if (art) {
          // (eager: the card is near the screen already, and lazy images in nested scrollers wait in WebKit)
          const img = ui.img(ui.imageUrl(art, 260, 146), null, true);
          img.addEventListener('error', () => tint(), { once: true });
          frame.insertBefore(img, pr);
        } else {
          tint();
        }
        const logo = LV.plate(c, 58, 32, 't-lv-plate-card');
        frame.appendChild(logo);
      };
      const tint = () => {
        frame.classList.add('t-lv-tinted');
        frame.style.backgroundColor = TINTS[(parseInt(c.vcn, 10) || 0) % TINTS.length];
        const word = (a.genres || '').split(',')[0] || B.categoryLabel(x.cat || '');
        if (word && !frame.querySelector('.t-lv-genre')) frame.appendChild(h('span.t-lv-genre', { text: word.trim() }));
      };
      n.addEventListener('click', () => LV.watch(channels, LV.indexOf(channels, c), label));
      ui.onHold(n, () => LV.menu(c, a, { list: channels, label }));
      return n;
    }

    // Off the wall: nothing left behind, nothing loading.
    clear() {
      if (this.sig === null && !this.el.firstChild) return;
      this.disconnect();
      this.el.replaceChildren();
      this.sig = null;
    }

    destroy() { this.disconnect(); }
  }

  LV.OnNow = OnNow;
})();
