// Live TV on phones and tablets (board P4): the pieces the guide, the On now feed and Live TV
// search share (PL.touch.live). Watching a channel (through PL.touch.playLive, the player's seam),
// "Last watched", logo plates, a programme's details sheet, the long-press actions, the filter
// sheet (the TV's Browse rail as a sheet) and the "Go to channel" number pad.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const G = PL.liveGuide;
  const L = PL.liveLogic;
  const B = PL.liveBrowse;
  const X = PL.touchLiveLogic;
  const LV = T.live = {};
  const now = () => Math.floor(Date.now() / 1000);
  LV.now = now;

  // ---- Icons the kit doesn't have (same 24 px stroke style; constant strings, parsed as SVG) ------

  const MORE_ICONS = {
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    dialpad: '<circle cx="6" cy="5" r="1.4" class="fill"/><circle cx="12" cy="5" r="1.4" class="fill"/><circle cx="18" cy="5" r="1.4" class="fill"/>' +
      '<circle cx="6" cy="11" r="1.4" class="fill"/><circle cx="12" cy="11" r="1.4" class="fill"/><circle cx="18" cy="11" r="1.4" class="fill"/>' +
      '<circle cx="6" cy="17" r="1.4" class="fill"/><circle cx="12" cy="17" r="1.4" class="fill"/><circle cx="18" cy="17" r="1.4" class="fill"/>' +
      '<circle cx="12" cy="22" r="1.4" class="fill"/>',
    del: '<path d="M9 5h10.5A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/>',
    starfill: '<path class="fill" d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9 6.7 19.6l1-5.8-4.2-4.1 5.9-.9z"/>',
    guide: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M9 9.5V20"/>',
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const parser = new DOMParser();
  LV.icon = (name, cls) => {
    if (!MORE_ICONS[name]) return ui.icon(name, cls);
    const doc = parser.parseFromString('<svg xmlns="' + SVG + '" viewBox="0 0 24 24">' + MORE_ICONS[name] + '</svg>', 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true);
    svg.setAttribute('class', 't-icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  };

  // A round glass icon button (44 px), the kit's .t-btn-round with one of these icons.
  LV.roundButton = (icon, label, action) => {
    const b = h('button.t-btn.t-btn-round', { type: 'button', 'aria-label': label }, LV.icon(icon));
    b.addEventListener('click', (e) => { e.stopPropagation(); action(e); });
    return b;
  };

  // ---- Logo plates (js/logos.js): a light plate, dark for white logos, else the channel's name -------

  // A plate. The image comes from the browser's cache after the first time, and its tone from
  // js/logos.js's (each logo is looked at once).
  LV.plate = (c, w, hgt, cls) => {
    const p = h('span.t-lv-plate' + (cls ? '.' + cls : ''));
    p.style.width = w + 'px';
    p.style.height = hgt + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // the image is asked for at the screen's density; CSS draws it at the plate's size
    PL.logos.fill(p, c, { w: Math.round((w - 8) * dpr), h: Math.round((hgt - 6) * dpr), textClass: 't-lv-plate-text', label: c.name });
    return p;
  };

  // The guide's channel column: one plate per channel, kept, since its rows come and go as it
  // scrolls. (A node can be in one place only: everything else makes its own with LV.plate.)
  const plates = new Map();
  LV.columnPlate = (c, w, hgt) => {
    const key = c.identifier + '|' + w + 'x' + hgt + '|' + (c.thumb || '');
    let p = plates.get(key);
    if (p) return p;
    p = LV.plate(c, w, hgt);
    if (plates.size > 1500) plates.clear();
    plates.set(key, p);
    return p;
  };
  LV.forgetPlates = () => plates.clear();

  // ---- Watching ---------------------------------------------------------------------------------------

  // Watches list[index]: the player's mini guide and channel up/down go through `list`.
  LV.watch = (list, index, label) => {
    const c = list && list[index];
    if (!c || !G.src) return;
    LV.noteWatched(c.identifier);
    T.playLive(G.liveSpec(list, index, label));
  };

  // Watches one channel: inside `list` when it's there (the guide's filter), else among all channels.
  LV.watchChannel = (c, list, label) => {
    const i = LV.indexOf(list, c);
    if (i >= 0) return LV.watch(list, i, label);
    const j = LV.indexOf(G.channels, c);
    // (a channel the lineup no longer has: nothing to play)
    if (j >= 0) LV.watch(G.channels, j, 'All channels');
  };

  // A channel's place in a list. By identifier: every guide block makes new channel objects.
  LV.indexOf = (list, c) => (list && c ? list.findIndex((x) => x.identifier === c.identifier) : -1);

  // ---- Last watched (per server, newest first) ---------------------------------------------------------

  const recentKey = () => 'livetv.recent.' + ((PL.plex.server && PL.plex.server.machineId) || 'default');
  LV.recent = () => PL.storage.get(recentKey(), []);
  LV.noteWatched = (identifier) => {
    if (identifier == null) return;
    PL.storage.set(recentKey(), X.noteRecent(LV.recent(), identifier, 6));
  };
  // The player (the TV's, and the touch player) leaves the channel that was on in G.watching.
  LV.takeWatching = () => {
    const id = G.watching;
    if (id == null) return null;
    G.watching = null;
    LV.noteWatched(id);
    return id;
  };

  // ---- Favourites ----------------------------------------------------------------------------------------

  LV.toggleFavourite = (c) => {
    const on = G.toggleFavourite(c.identifier);
    T.toast(on ? 'Added ' + c.name + ' to Favourites' : 'Removed ' + c.name + ' from Favourites');
    return on;
  };

  // ---- A programme's details ------------------------------------------------------------------------------

  // opts: {list, label (what Watch plays through), onGuide (a "Show in guide" button)}
  LV.details = (c, a, opts = {}) => {
    const t = now();
    const on = a && X.when(a, t) === 'now';
    const box = h('div.t-lv-det');
    const art = a && a.art && a.art !== c.thumb ? a.art : null;
    if (art) {
      const frame = h('div.t-lv-det-art');
      const img = ui.img(ui.imageUrl(art, 420, 236), null, true);
      // no art after all: no empty box
      img.addEventListener('error', () => frame.remove(), { once: true });
      frame.appendChild(img);
      box.appendChild(frame);
    }
    const chan = h('div.t-lv-det-chan');
    chan.appendChild(LV.plate(c, 58, 32, 't-lv-plate-sm'));
    chan.appendChild(h('span', { text: [c.vcn, c.name].filter(Boolean).join('  ') }));
    if (G.isFavourite(c.identifier)) chan.appendChild(LV.icon('starfill', 't-lv-fav'));
    box.appendChild(chan);
    box.appendChild(h('h2.t-lv-det-title', { text: a ? a.title : c.name }));
    if (a && a.sub) box.appendChild(h('div.t-lv-det-sub', { text: a.sub }));
    if (a) {
      box.appendChild(h('div.t-lv-det-when', { text: L.times(a, t) + ' · ' + (on ? X.left(a, t) : L.status(a, t)) }));
      if (on) box.appendChild(ui.progress(L.progress(a, t)));
      if (a.genres) box.appendChild(h('div.t-lv-det-genres', { text: a.genres }));
    }
    const summary = h('p.t-lv-det-summary');
    box.appendChild(summary);
    if (a) G.summary(a).then((text) => { summary.textContent = text; });
    const actions = h('div.t-lv-det-actions');
    let entry = null;
    const after = (fn) => () => entry.close(fn);
    actions.appendChild(ui.button({
      kind: on ? 'primary' : 'glass', icon: 'play', label: on ? 'Watch' : 'Watch ' + c.name + ' now',
      action: after(() => LV.watchChannel(c, opts.list, opts.label)),
    }));
    const fav = G.isFavourite(c.identifier);
    actions.appendChild(LV.roundButton(fav ? 'starfill' : 'star', fav ? 'Remove from Favourites' : 'Add to Favourites', after(() => LV.toggleFavourite(c))));
    if (opts.onGuide) actions.appendChild(LV.roundButton('guide', 'Show in guide', after(opts.onGuide)));
    box.appendChild(actions);
    entry = T.sheet({ content: box, cls: 't-lv-detsheet' });
    return entry;
  };

  // ---- Long press: watch, favourite, details ------------------------------------------------------------------

  LV.menu = (c, a, opts = {}) => {
    const t = now();
    const fav = G.isFavourite(c.identifier);
    const state = a ? X.when(a, t) : 'now';
    const rows = [
      { label: state === 'now' ? 'Watch' : 'Watch ' + c.name + ' now', sub: state === 'later' ? 'This is on ' + L.times(a, t) : state === 'past' ? 'This has ended' : null, icon: 'play',
        action: () => LV.watchChannel(c, opts.list, opts.label) },
      { label: fav ? 'Remove from Favourites' : 'Add to Favourites', icon: 'star', action: () => LV.toggleFavourite(c) },
    ];
    if (a) rows.push({ label: 'Details', icon: 'info', action: () => LV.details(c, a, opts) });
    return T.sheet({
      title: a ? a.title : c.name,
      sub: [c.vcn, c.name].filter(Boolean).join(' ') + (a ? ' · ' + L.times(a, t) : ''),
      rows, cls: 't-menu',
    });
  };

  // ---- The filter sheet (the TV's Browse rail): what to show, categories, channel families ------------------

  // sel: {base, refine}; onPick(sel)
  LV.filterSheet = (sel, onPick) => {
    const ctx = G.browseCtx();
    const entries = B.railEntries(G.channels, ctx);
    const sections = [];
    const pick = (s) => () => onPick(s);
    const subs = [];
    let cur = { heading: null, rows: [] };
    sections.push(cur);
    entries.forEach((e) => {
      if (e.kind === 'head') {
        cur = { heading: e.label, rows: [] };
        sections.push(cur);
        return;
      }
      subs.push(!!e.sub);
      cur.rows.push({ label: e.label, value: String(e.count), checked: sel.base === e.key, action: pick({ base: e.key, refine: null }) });
    });
    // the current choice narrowed by the other dimension (a category's families, a family's
    // categories, Favourites' categories), after the first choices (All channels' would repeat
    // the categories)
    if (sel.base !== 'now' && sel.base !== 'all') {
      const refine = B.chips(sel.base, G.channels, ctx);
      if (refine.length) {
        const n = B.filter(G.channels, { base: sel.base }, ctx).length;
        const rows = [{ label: B.allLabel(sel.base, ctx), value: String(n), checked: !sel.refine, action: pick({ base: sel.base, refine: null }) }]
          .concat(refine.map((r) => ({ label: r.label, value: String(r.count), checked: sel.refine === r.key, action: pick({ base: sel.base, refine: r.key }) })));
        sections.splice(1, 0, { heading: 'In ' + B.label(sel.base, ctx), rows });
        subs.splice(sections[0].rows.length, 0, ...rows.map(() => false));
      }
    }
    const count = G.channels.length;
    const onNow = Object.keys(ctx.onNow).length;
    const entry = T.sheet({ title: 'Browse channels', sub: count + ' channels · ' + onNow + ' on now', sections, cls: 't-lv-filtersheet' });
    // sub-families sit indented under their family (rows come out in the order given)
    entry.body.querySelectorAll('.t-sheet-row').forEach((n, i) => { if (subs[i]) n.classList.add('t-lv-subrow'); });
    const on = entry.body.querySelector('.t-sheet-row.on');
    if (on) requestAnimationFrame(() => on.scrollIntoView({ block: 'center' }));
    return entry;
  };

  // ---- Go to channel: a number pad ------------------------------------------------------------------------------

  // opts: {onGuide(channel), onWatch(channel)}
  LV.numberPad = (opts) => {
    const all = G.channels;
    const numbers = all.map((c) => c.vcn);
    const max = L.maxDigits(numbers);
    let digits = '';
    const box = h('div.t-lv-pad');
    const shown = h('div.t-lv-pad-digits', { 'aria-live': 'polite' });
    const match = h('div.t-lv-pad-match');
    box.appendChild(shown);
    box.appendChild(match);
    const keys = h('div.t-lv-pad-keys');
    let entry = null;
    let target = null;
    const paint = () => {
      let dashes = '';
      for (let i = digits.length; i < max; i++) dashes += '–';
      shown.replaceChildren(h('span', { text: digits }), h('span.t-lv-pad-dash', { text: dashes }));
      match.replaceChildren();
      const m = digits ? L.previewNumber(numbers, digits) : null;
      target = m ? all[m.index] : null;
      watchBtn.disabled = guideBtn.disabled = !target;
      if (!target) {
        match.appendChild(h('div.t-lv-pad-hint', { text: digits ? 'No channel' : 'Type a channel number' }));
        return;
      }
      const nn = G.nowNext(target.identifier);
      match.appendChild(LV.plate(target, 58, 32, 't-lv-plate-sm'));
      const text = h('div.t-lv-pad-text');
      text.appendChild(h('div.t-lv-pad-name', { text: (m.exact || m.prefix ? '' : 'Nearest: ') + target.vcn + '  ' + target.name }));
      text.appendChild(h('div.t-lv-pad-now', { text: nn.now ? nn.now.title + ' · ' + X.left(nn.now, now()) : 'No guide information' }));
      match.appendChild(text);
    };
    const press = (k) => { digits = X.padKey(digits, k, max); paint(); };
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'go'].forEach((k) => {
      let b;
      if (k === 'del') b = h('button.t-lv-key.t-lv-key-fn', { type: 'button', 'aria-label': 'Delete' }, LV.icon('del'));
      else if (k === 'go') b = h('button.t-lv-key.t-lv-key-fn', { type: 'button', 'aria-label': 'Show in guide' }, LV.icon('guide'));
      else b = h('button.t-lv-key', { type: 'button', text: k });
      b.addEventListener('click', () => {
        if (k === 'go') { if (target) finish(opts.onGuide); return; }
        press(k);
      });
      keys.appendChild(b);
    });
    const finish = (fn) => {
      const c = target;
      if (c && entry) entry.close(() => fn(c));
    };
    const watchBtn = ui.button({ kind: 'primary', icon: 'play', label: 'Watch', action: () => finish(opts.onWatch) });
    const guideBtn = ui.button({ kind: 'glass', icon: 'grid', label: 'Show in guide', action: () => finish(opts.onGuide) });
    const actions = h('div.t-lv-pad-actions', null, [watchBtn, guideBtn]);
    box.appendChild(keys);
    box.appendChild(actions);
    paint();
    entry = T.sheet({ title: 'Go to channel', content: box, cls: 't-lv-padsheet' });
    // A hardware keyboard types too. On the window, capturing: before the app's own key handling
    // (js/app.js), which reads Backspace as Back and would close the sheet.
    const onKey = (e) => {
      const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON' && box.contains(document.activeElement);
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key >= '0' && e.key <= '9') { press(e.key); stop(); }
      else if (e.key === 'Backspace') { press('del'); stop(); }
      // Enter on a focused key or button presses it; otherwise it shows the channel in the guide
      else if (e.key === 'Enter' && onButton) e.stopImmediatePropagation();
      else if (e.key === 'Enter' && target) { finish(opts.onGuide); stop(); }
    };
    window.addEventListener('keydown', onKey, true);
    const prevClose = entry.opts.onClose;
    entry.opts.onClose = () => { window.removeEventListener('keydown', onKey, true); if (prevClose) prevClose(); };
    return entry;
  };
})();
