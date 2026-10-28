// Live TV on phones and tablets (board P4): the guide's time grid. It scrolls natively both ways in
// the page's scroller; the channel column, the time ruler and each programme's title stay in view
// with position: sticky, so scrolling never waits on script. Rows are virtualised: only the rows
// near the view exist, each with the programmes of a few hours around it, rebuilt (once per frame
// at most) when the view moves past a row or an hour. Logo plates are made once per channel.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.live) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const G = PL.liveGuide;
  const L = PL.liveLogic;
  const X = PL.touchLiveLogic;
  const LV = T.live;

  const HOURS = 24;    // the guide runs this far from the half hour it opened in
  const OVER = 6;      // rows built beyond the view each way
  const PAD = 3600;    // and an hour of programmes either side of the view
  const STEP = 3600;   // the hours built change in whole hours
  const MIN_TEXT = 26; // narrower cells are drawn without text
  const STICK_W = 150; // wider ones keep their title in view while they scroll off to the left

  class Grid {
    // opts: {onTap(c, a, i), onHold(c, a, i), onChannel(c, i), onChannelHold(c, i)}
    constructor(opts) {
      this.opts = opts;
      this.list = [];
      this.rows = new Map(); // index -> {c, list, key, row, ch}
      this.origin = L.floorTo(LV.now(), L.HALF_HOUR);
      this.ruler = h('div.t-lv-ruler', { 'aria-hidden': 'true' });
      this.corner = h('div.t-lv-corner');
      this.ticks = h('div.t-lv-ticks');
      this.nowChip = h('div.t-lv-nowchip');
      this.ruler.appendChild(this.corner);
      this.ruler.appendChild(this.ticks);
      this.body = h('div.t-lv-body');
      this.chans = h('div.t-lv-chans');
      this.progs = h('div.t-lv-progs');
      this.nowLine = h('div.t-lv-nowline');
      this.progs.appendChild(this.nowLine);
      this.body.appendChild(this.chans);
      this.body.appendChild(this.progs);
      this.pending = 0;
      this.win = null;
      this.stats = { renders: 0, ms: 0, max: 0, built: 0 };
      this.wire();
    }

    // ---- Set up --------------------------------------------------------------------------------------

    attach(scroller) {
      this.scroller = scroller;
      this.onScroll = () => this.schedule();
      scroller.addEventListener('scroll', this.onScroll, { passive: true });
    }

    setGeometry(geo) {
      this.geo = geo;
      this.pps = geo.pps;
      this.timeW = Math.round(HOURS * 3600 * this.pps);
      const s = this.body.style;
      this.body.parentNode && this.body.parentNode.style.setProperty('--lv-col', geo.col + 'px');
      s.setProperty('--lv-col', geo.col + 'px');
      s.setProperty('--lv-cell', geo.cell + 'px');
      this.ruler.style.setProperty('--lv-col', geo.col + 'px');
      this.ruler.style.height = geo.ruler + 'px';
      this.progs.style.width = this.timeW + 'px';
      this.ticks.style.width = this.timeW + 'px';
      this.paintRuler();
      this.clear();
      this.setHeight();
      this.schedule();
    }

    // The channels to show. keep: the same filter with fresh data (rows that didn't change stay).
    setList(list, keep) {
      // (each guide block rebuilds the channel objects: the same channels are the same identifiers)
      const same = keep && list.length === this.list.length && list.every((c, i) => c.identifier === this.list[i].identifier);
      this.list = list;
      if (!same) this.clear();
      else this.rows.forEach((r, i) => { r.c = list[i]; });
      this.setHeight();
      this.schedule();
    }

    setHeight() {
      if (!this.geo) return;
      this.body.style.height = Math.max(1, this.list.length) * this.geo.pitch + 'px';
    }

    // The width the page needs for the grid (the scroller's content).
    width() { return this.geo ? this.geo.col + this.timeW + 16 : 0; }

    clear() {
      this.rows.forEach((r) => { r.row.remove(); r.ch.remove(); });
      this.rows.clear();
      this.win = null;
      this.winKey = null;
    }

    // ---- Taps ------------------------------------------------------------------------------------------

    wire() {
      const cellOf = (e) => {
        const n = e.target.closest && e.target.closest('.t-lv-cell');
        if (!n || !n.parentNode) return null;
        const r = this.rows.get(n.parentNode._i);
        return r ? { c: r.c, a: n._a || null, i: n.parentNode._i } : null;
      };
      this.progs.addEventListener('click', (e) => {
        const hit = cellOf(e);
        if (hit) this.opts.onTap(hit.c, hit.a, hit.i);
      });
      ui.onHold(this.progs, (e) => {
        const hit = cellOf(e);
        if (hit) this.opts.onHold(hit.c, hit.a, hit.i);
      });
      const chanOf = (e) => {
        const n = e.target.closest && e.target.closest('.t-lv-ch');
        return n ? this.rows.get(n._i) : null;
      };
      this.chans.addEventListener('click', (e) => {
        const r = chanOf(e);
        if (r) this.opts.onChannel(r.c, r.ch._i);
      });
      ui.onHold(this.chans, (e) => {
        const r = chanOf(e);
        if (r) this.opts.onChannelHold(r.c, r.ch._i);
      });
    }

    // ---- The ruler and the now line -------------------------------------------------------------------

    paintRuler() {
      this.ticks.replaceChildren();
      const t0 = LV.now();
      X.ticks(this.origin, HOURS, this.pps).forEach((k, i) => {
        if (i === 0) return; // the half hour the guide opened in sits under the column's edge
        const day = L.day(k.t, t0);
        const n = h('div.t-lv-tick', { text: (L.clock(k.t) === '00:00' && day !== 'Today' ? day.slice(0, 3) + ' ' : '') + L.clock(k.t) });
        n.style.left = k.x + 'px';
        this.ticks.appendChild(n);
      });
      this.ticks.appendChild(this.nowChip);
      this.tickNodes = Array.from(this.ticks.querySelectorAll('.t-lv-tick'));
      this.paintNow();
    }

    paintNow() {
      const t = LV.now();
      const x = Math.round((t - this.origin) * this.pps);
      this.nowLine.style.transform = 'translate3d(' + x + 'px,0,0)';
      this.nowChip.textContent = L.clock(t);
      this.nowChip.style.transform = 'translate3d(' + x + 'px,0,0)';
      // the half-hour label the chip covers steps aside
      (this.tickNodes || []).forEach((n, i) => {
        const tx = (i + 1) * 1800 * this.pps;
        n.classList.toggle('t-lv-tick-hid', Math.abs(tx - x) < 52);
      });
    }

    // Every minute: the now line, the "left" times, what has ended.
    tick() {
      this.paintNow();
      this.rows.forEach((r) => { r.stale = true; });
      this.schedule();
    }

    // The guide has been open a long time: start it again at the current half hour.
    rebase() {
      const o = L.floorTo(LV.now(), L.HALF_HOUR);
      if (o === this.origin) return false;
      this.origin = o;
      this.paintRuler();
      this.clear();
      this.schedule();
      return true;
    }

    // ---- Rendering --------------------------------------------------------------------------------------

    schedule() {
      if (this.pending || !this.scroller) return;
      this.pending = requestAnimationFrame(() => {
        this.pending = 0;
        this.render();
      });
    }

    render() {
      const sc = this.scroller;
      // (nor under the touch player: the shell shows the page again, onShow, when it closes)
      if (!sc || !this.geo || this.hidden || T.covered) return;
      // nothing has a size while the stage covers the layer (a size of 0 would stick), or for a
      // moment while the page animates in: try again next frame, unless the stage has the screen
      if (!sc.clientHeight) {
        if (T.visible) this.schedule();
        return;
      }
      const t0 = performance.now();
      const g = this.geo;
      // (positions are left/top, not transforms: a layer per cell would cost the phone more than it saves)
      // where the rows start in the scroller (the header above them can change height)
      if (this.bodyTop == null) this.bodyTop = this.body.offsetTop;
      const range = X.rowRange(sc.scrollTop - this.bodyTop, sc.clientHeight, g.pitch, this.list.length, OVER);
      const win = X.timeWindow(this.origin, sc.scrollLeft, sc.clientWidth - g.col, this.pps, PAD, STEP);
      const winKey = win.from + '-' + win.to;
      if (winKey !== this.winKey) {
        this.winKey = winKey;
        this.win = win;
        G.ensure(win.from, win.to + 3600).catch(() => {});
        this.paintCorner(win);
      }
      // rows that left the range go
      this.rows.forEach((r, i) => {
        if (i < range.from || i >= range.to) {
          r.row.remove();
          r.ch.remove();
          this.rows.delete(i);
        }
      });
      let built = 0;
      for (let i = range.from; i < range.to; i++) {
        let r = this.rows.get(i);
        if (!r) {
          r = this.makeRow(i);
          this.rows.set(i, r);
        }
        const list = G.list(r.c.identifier);
        if (r.key !== winKey || r.list !== list || r.stale) {
          this.fillRow(r, list, winKey);
          built++;
        }
      }
      const ms = performance.now() - t0;
      const st = this.stats;
      st.renders++;
      st.ms += ms;
      st.built += built;
      if (ms > st.max) st.max = ms;
    }

    paintCorner(win) {
      const left = Math.max(this.origin, win.from + PAD);
      this.corner.textContent = L.day(left, LV.now());
    }

    makeRow(i) {
      const g = this.geo;
      const c = this.list[i];
      const top = i * g.pitch;
      const ch = h('div.t-lv-ch', { role: 'button', 'aria-label': 'Watch ' + c.vcn + ' ' + c.name });
      ch._i = i;
      ch.style.top = top + 'px';
      ch.appendChild(LV.columnPlate(c, g.plateW, g.plateH));
      if (G.isFavourite(c.identifier)) ch.appendChild(LV.icon('starfill', 't-lv-ch-fav'));
      ch.appendChild(h('span.t-lv-num', { text: c.vcn || '' }));
      this.chans.appendChild(ch);
      const row = h('div.t-lv-row');
      row._i = i;
      row.style.top = top + 'px';
      this.progs.appendChild(row);
      return { c, row, ch, key: null, list: null, cells: null, stale: false };
    }

    // A row's cells for the hours built. When only the hours moved (scrolling sideways), the cells
    // still in them stay and only the new hours are added; new data or the minute rebuilds the row.
    fillRow(r, list, winKey) {
      const t = LV.now();
      const win = this.win;
      const full = r.list !== list || r.stale || !r.cells;
      r.key = winKey;
      r.list = list;
      r.stale = false;
      const span = X.airingsIn(list, win.from, win.to);
      const frag = document.createDocumentFragment();
      if (!full) {
        const keep = new Set();
        for (let k = span.from; k < span.to; k++) keep.add(list[k]);
        r.cells.forEach((cell, a) => {
          if (!keep.has(a)) {
            cell.remove();
            r.cells.delete(a);
          }
        });
      } else {
        r.cells = new Map();
      }
      for (let k = span.from; k < span.to; k++) {
        const a = list[k];
        if (r.cells.has(a)) continue;
        const cell = this.makeCell(a, t);
        if (!cell) continue;
        r.cells.set(a, cell);
        frag.appendChild(cell);
      }
      if (!full) {
        r.row.appendChild(frag);
        return;
      }
      // a channel without guide information: one cell across the row, so it can still be watched
      if (!frag.childNodes.length && !list.some((a) => a.e > this.origin)) {
        const cell = h('button.t-lv-cell.t-lv-none', { type: 'button' }, h('span.t-lv-cell-in.t-lv-stick', null, h('span.t-lv-cell-title', { text: 'No guide information' })));
        cell.style.width = (this.timeW - this.geo.gap) + 'px';
        frag.appendChild(cell);
      }
      r.row.replaceChildren(frag);
    }

    makeCell(a, t) {
      if (a.e <= this.origin) return null;
      const box = L.cell(a, this.origin, this.origin, this.pps, this.geo.gap);
      if (box.w < 2) return null;
      const state = X.when(a, t);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 't-lv-cell t-lv-' + state;
      cell._a = a;
      cell.style.left = Math.round(box.x) + 'px';
      cell.style.width = Math.round(box.w) + 'px';
      if (box.w < MIN_TEXT) {
        cell.setAttribute('aria-label', a.title);
        return cell;
      }
      const inner = document.createElement('span');
      // only long programmes keep their title in view (a sticky title per cell costs WebKit a frame
      // in three when scrolling sideways; a short cell's title barely moves anyway)
      inner.className = box.w >= STICK_W ? 't-lv-cell-in t-lv-stick' : 't-lv-cell-in';
      const title = document.createElement('span');
      title.className = 't-lv-cell-title';
      title.textContent = a.title;
      inner.appendChild(title);
      const sub = document.createElement('span');
      sub.className = 't-lv-cell-sub';
      sub.textContent = state === 'now' ? X.left(a, t) : L.clock(a.b);
      inner.appendChild(sub);
      cell.appendChild(inner);
      if (state === 'now') {
        const bar = document.createElement('span');
        bar.className = 't-lv-cell-bar';
        const fill = document.createElement('span');
        fill.style.transform = 'scaleX(' + L.progress(a, t).toFixed(3) + ')';
        bar.appendChild(fill);
        cell.appendChild(bar);
      }
      return cell;
    }

    // Data changed (a block arrived, a favourite): rebuild the rows whose programmes changed.
    refresh() {
      this.rows.forEach((r) => {
        const fav = G.isFavourite(r.c.identifier);
        const star = r.ch.querySelector('.t-lv-ch-fav');
        if (fav && !star) r.ch.insertBefore(LV.icon('starfill', 't-lv-ch-fav'), r.ch.lastChild);
        else if (!fav && star) star.remove();
      });
      this.schedule();
    }

    // The header above the rows changed height.
    measure() {
      this.bodyTop = null;
      this.stickTop = null;
      this.schedule();
    }

    // ---- Moving -----------------------------------------------------------------------------------------

    // Scrolls so row i sits just under the ruler (sideways it stays put), and flashes it.
    showRow(i, flash) {
      const sc = this.scroller;
      if (!sc || i < 0 || i >= this.list.length) return;
      if (this.bodyTop == null) this.bodyTop = this.body.offsetTop;
      if (this.stickTop == null) this.stickTop = parseFloat(getComputedStyle(this.ruler).top) || 0;
      sc.scrollTo({ top: X.rowTop(i, this.bodyTop, this.geo, this.stickTop) });
      this.render();
      if (flash) {
        const r = this.rows.get(i);
        if (r) {
          [r.row, r.ch].forEach((n) => {
            n.classList.remove('t-lv-flash');
            void n.offsetWidth;
            n.classList.add('t-lv-flash');
          });
          setTimeout(() => [r.row, r.ch].forEach((n) => n.classList.remove('t-lv-flash')), 1800);
        }
      }
    }

    // The top of the rows (the header scrolled away), for a new filter.
    rowsTop() {
      if (this.bodyTop == null) this.bodyTop = this.body.offsetTop;
      if (this.stickTop == null) this.stickTop = parseFloat(getComputedStyle(this.ruler).top) || 0;
      return Math.max(0, this.bodyTop - this.stickTop - this.geo.ruler);
    }

    // Scrolls sideways so time t is near the left edge.
    showTime(t) {
      this.scroller.scrollTo({ left: X.timeLeft(t, this.origin, this.pps) });
    }

    // The time at the left edge, and back there after the sizes change (rotating the phone).
    leftTime() { return this.origin + (this.scroller ? this.scroller.scrollLeft : 0) / this.pps; }

    destroy() {
      if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll);
      cancelAnimationFrame(this.pending);
      this.clear();
    }
  }

  LV.Grid = Grid;
})();
