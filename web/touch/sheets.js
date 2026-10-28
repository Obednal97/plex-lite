// Sheets, menus and toasts for the phone and tablet layer (docs/WEB.md, "Phones and tablets"): a
// bottom sheet on a phone (drag it down or tap outside to close), a centred card on a tablet. Back
// closes the top one. A title's quick actions (long-press or "…") are a sheet too.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const open = [];

  // opts: {title, sub, rows: [{label, sub, value, icon, checked, danger, action, keepOpen}],
  //        sections: [{heading, rows}], content: node, onClose, cls}
  // A row's action runs after the sheet has closed, unless keepOpen.
  function sheet(opts) {
    const host = h('div.t-sheet-host' + (opts.cls ? '.' + opts.cls : ''));
    const scrim = h('div.t-scrim', { on: { click: () => close(entry) } });
    const card = h('div.t-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Options' });
    const grab = h('div.t-sheet-grab', null, h('span'));
    card.appendChild(grab);
    if (opts.title) {
      const head = h('div.t-sheet-head');
      head.appendChild(h('h2.t-sheet-title', { text: opts.title }));
      if (opts.sub) head.appendChild(h('div.t-sheet-sub', { text: opts.sub }));
      card.appendChild(head);
    }
    const body = h('div.t-sheet-body');
    const sections = opts.sections || (opts.rows ? [{ rows: opts.rows }] : []);
    sections.forEach((sec) => {
      if (sec.heading) body.appendChild(h('div.t-sheet-heading', { text: sec.heading }));
      const list = h('div.t-sheet-list');
      sec.rows.forEach((r) => list.appendChild(row(r)));
      body.appendChild(list);
    });
    if (opts.content) body.appendChild(opts.content);
    card.appendChild(body);
    host.appendChild(scrim);
    host.appendChild(card);

    function row(r) {
      const n = h('button.t-sheet-row' + (r.checked ? '.on' : '') + (r.danger ? '.t-danger' : ''), { type: 'button', role: r.checked != null ? 'menuitemradio' : 'menuitem' });
      if (r.checked != null) n.setAttribute('aria-checked', String(!!r.checked));
      if (r.icon) n.appendChild(ui.icon(r.icon, 't-sheet-icon'));
      const text = h('span.t-sheet-text', null, h('span.t-sheet-label', { text: r.label }));
      if (r.sub) text.appendChild(h('span.t-sheet-rowsub', { text: r.sub }));
      n.appendChild(text);
      if (r.value) n.appendChild(h('span.t-sheet-value', { text: r.value }));
      if (r.checked) n.appendChild(ui.icon('check', 't-sheet-tick'));
      else if (r.next) n.appendChild(ui.icon('chevron', 't-sheet-next'));
      n.addEventListener('click', () => {
        // the release of the long press that opened it is not a choice
        if (Date.now() - openedAt < 400) return;
        if (r.keepOpen) { if (r.action) r.action(n); return; }
        close(entry, () => { if (r.action) r.action(); });
      });
      return n;
    }

    const openedAt = Date.now();
    const entry = { host, card, opts, closing: false };
    open.push(entry);
    T.layer.appendChild(host);
    document.documentElement.classList.add('t-sheet-open');
    requestAnimationFrame(() => requestAnimationFrame(() => host.classList.add('t-in')));
    dragToClose(entry, grab);
    const first = card.querySelector('.t-sheet-row.on') || card.querySelector('button');
    if (first && PL.input.nav() === 'keys') first.focus({ preventScroll: true });
    entry.close = (then) => close(entry, then);
    entry.body = body;
    return entry;
  }

  function close(entry, then) {
    if (entry.closing) return;
    entry.closing = true;
    const i = open.indexOf(entry);
    if (i >= 0) open.splice(i, 1);
    entry.host.classList.remove('t-in');
    entry.host.classList.add('t-out');
    const done = () => { entry.host.remove(); };
    setTimeout(done, 240);
    if (!open.length) document.documentElement.classList.remove('t-sheet-open');
    if (entry.opts.onClose) entry.opts.onClose();
    if (then) then();
  }

  // Pull the sheet down by its grabber or its heading; let go past 80 px (or flicked) to close.
  function dragToClose(entry, grab) {
    const targets = [grab, entry.card.querySelector('.t-sheet-head')].filter(Boolean);
    let y0 = null;
    let t0 = 0;
    let dy = 0;
    const move = (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.clientY - y0);
      entry.card.style.transform = 'translate3d(0,' + dy + 'px,0)';
    };
    const up = () => {
      if (y0 == null) return;
      const fast = dy > 30 && Date.now() - t0 < 250;
      y0 = null;
      entry.card.classList.remove('t-dragging');
      entry.card.style.transform = '';
      if (dy > 80 || fast) close(entry);
      dy = 0;
    };
    targets.forEach((t) => {
      t.addEventListener('pointerdown', (e) => {
        if (document.documentElement.classList.contains('t-tablet')) return;
        y0 = e.clientY;
        t0 = Date.now();
        entry.card.classList.add('t-dragging');
        t.setPointerCapture(e.pointerId);
      });
      t.addEventListener('pointermove', move);
      t.addEventListener('pointerup', up);
      t.addEventListener('pointercancel', up);
    });
  }

  T.sheets = {
    closeTop: () => {
      const top = open[open.length - 1];
      if (!top) return false;
      close(top);
      return true;
    },
    closeAll: () => { open.slice().reverse().forEach((e) => close(e)); },
    count: () => open.length,
  };
  T.sheet = sheet;

  // ---- A title's quick actions ---------------------------------------------------------------------------

  // onDone(): the title's watched state changed (repaint its card). opts.onDetails: already on its page.
  T.menu = (item, onDone, opts = {}) => {
    const rows = PL.touchLogic.menuRows(item, { clock: (ms) => PL.fmt.clock(ms / 1000), onDetails: opts.onDetails });
    if (!rows.length) return false;
    const P = PL.ui;
    const mark = (on) => () => {
      PL.plex.setWatched(item.ratingKey, on).then(() => {
        if (on) {
          item.viewCount = (item.viewCount || 0) + 1;
          if (item.leafCount) item.viewedLeafCount = item.leafCount;
        } else {
          item.viewCount = 0;
          if (item.leafCount) item.viewedLeafCount = 0;
        }
        delete item.viewOffset;
        T.toast(on ? 'Marked as watched' : 'Marked as unwatched');
        if (onDone) onDone();
      }, (err) => T.toast(PL.errorMessage(err)));
    };
    const ICON = { resume: 'play', play: 'play', restart: 'restart', watched: 'check', unwatched: 'close', show: 'tv', details: 'info' };
    const act = {
      resume: () => T.play(item, { offset: item.viewOffset }),
      play: () => T.play(item, { offset: 0 }),
      restart: () => T.play(item, { offset: 0 }),
      watched: mark(true),
      unwatched: mark(false),
      show: () => T.open({ ratingKey: item.type === 'season' ? item.parentRatingKey : item.grandparentRatingKey, type: 'show',
        title: item.type === 'season' ? item.parentTitle : item.grandparentTitle }),
      details: () => T.open(item),
    };
    const list = rows.map((r) => ({ label: r.label, icon: ICON[r.id], action: act[r.id] }));
    const title = item.type === 'episode' ? (item.grandparentTitle || '') + ' · ' + PL.fmt.episode(item) : (P.itemTitle(item) || '');
    const sub = item.type === 'episode' ? item.title : P.metaLine(item);
    let shown = null;
    const finish = (extra) => {
      if (shown) return;
      // plugins (Overseerr: Request, Report a problem) add theirs before Details
      const plug = (extra || []).filter((a) => a && a.label && a.run).map((a) => ({ label: a.label, icon: 'sparkle', action: a.run }));
      const all = opts.onDetails ? list.concat(plug) : list.slice(0, -1).concat(plug, list.slice(-1));
      shown = sheet({ title, sub, rows: all, cls: 't-menu' });
    };
    const extra = PL.plugins && PL.plugins.actions ? PL.plugins.actions(item) : null;
    if (extra && typeof extra.then === 'function') {
      extra.then(finish, () => finish(null));
      setTimeout(() => finish(null), 600);
    } else {
      finish(extra);
    }
    return true;
  };

  // ---- Toasts ------------------------------------------------------------------------------------------------

  // The app's own toast (PL.toast), placed above the tab bar by touch.css while the layer shows.
  T.toast = (msg, ms) => PL.toast(msg, ms);

  // A yes/no question as a sheet. -> Promise<boolean>
  T.confirm = (title, text, yes, danger) => new Promise((resolve) => {
    let answered = false;
    sheet({
      title, sub: text,
      rows: [{ label: yes || 'OK', danger, action: () => { answered = true; resolve(true); } }, { label: 'Cancel', action: () => {} }],
      onClose: () => { setTimeout(() => { if (!answered) resolve(false); }); },
    });
  });
})();
