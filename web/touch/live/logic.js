// Live TV on phones and tablets (board P4): the pure parts. The guide's geometry, which rows and
// which stretch of time to build while it scrolls, the chips, the "Last watched" list, the number
// pad and the labels on a cell. No DOM, so test/touch-live.test.mjs runs it in Node. The guide data
// and its rules are the TV's (js/livetv-data.js, js/livetv-logic.js, js/livetv-browse.js).
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  const PL = window.PL = window.PL || {};

  // ---- Geometry -----------------------------------------------------------------------------------
  // col: the channel column's width (the logo plate and number); pitch: one row; cell: a programme's
  // height; ppm: px per minute; ruler: the time ruler's height. A phone shows ~80 minutes across, a
  // tablet two hours or more in bigger cells.
  const GEOMETRY = {
    phone: { col: 88, pitch: 68, cell: 64, ppm: 3.6, ruler: 34, gap: 4, plateW: 58, plateH: 32 },
    short: { col: 88, pitch: 60, cell: 56, ppm: 4.4, ruler: 32, gap: 4, plateW: 58, plateH: 30 },
    tablet: { col: 120, pitch: 84, cell: 78, ppm: 6, ruler: 38, gap: 6, plateW: 84, plateH: 44 },
  };
  // short: a phone on its side (under 500 px tall; the shell calls it a tablet by its width) gets
  // short rows whatever its width.
  function geometry(kind, short) {
    const g = GEOMETRY[short ? 'short' : kind === 'tablet' ? 'tablet' : 'phone'];
    return Object.assign({ pps: g.ppm / 60 }, g);
  }

  // The rows to build: those in view plus `over` each way. top: the scroller's scrollTop measured
  // from the first row; view: the height in view. -> {from, to} (to exclusive), empty when count is 0.
  function rowRange(top, view, pitch, count, over) {
    if (!(count > 0)) return { from: 0, to: 0 };
    const first = Math.floor(Math.max(0, top) / pitch);
    const last = Math.ceil(Math.max(0, top + view) / pitch);
    return { from: Math.max(0, first - over), to: Math.min(count, last + over) };
  }

  // The stretch of time each built row holds cells for: the time in view, widened by `pad` seconds
  // each way and snapped outwards to `step`, so it only changes every `step` of scrolling.
  // left: px scrolled past the channel column; width: px of programmes in view. -> {from, to} (unix s)
  function timeWindow(origin, left, width, pps, pad, step) {
    const a = origin + Math.max(0, left) / pps - pad;
    const b = origin + (Math.max(0, left) + width) / pps + pad;
    return { from: Math.max(origin, Math.floor(a / step) * step), to: Math.ceil(b / step) * step };
  }

  // The airings of a sorted list that overlap [from, to), as indexes {from, to} (to exclusive).
  function airingsIn(list, from, to) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].e <= from) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < list.length && list[end].b < to) end++;
    return { from: lo, to: end };
  }

  // The ruler's labels: every half hour from origin for `hours`. -> [{t, x}]
  function ticks(origin, hours, pps) {
    const out = [];
    for (let t = origin; t <= origin + hours * 3600; t += 1800) out.push({ t, x: Math.round((t - origin) * pps) });
    return out;
  }

  // Where the page scroller goes to show row i just under the sticky ruler, half a row down.
  // bodyTop: where the rows start in the scroller; stick: the ruler's sticky top (the status bar).
  function rowTop(i, bodyTop, g, stick) {
    return Math.max(0, Math.round(bodyTop + i * g.pitch - stick - g.ruler - g.pitch * 0.5));
  }

  // Where it goes sideways to show time t near the left edge (a little of what came before shows).
  function timeLeft(t, origin, pps) {
    return Math.max(0, Math.round((t - origin) * pps - 24));
  }

  // ---- Labels ---------------------------------------------------------------------------------------

  // "11m left", "1h 5m left" (a cell is narrow); "Ended" once over.
  function left(a, now) {
    const m = Math.max(1, Math.round((a.e - now) / 60));
    if (now >= a.e) return 'Ended';
    if (m < 60) return m + 'm left';
    return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') + ' left';
  }

  // A cell's state: 'past' (ended), 'now' (on), 'later'.
  function when(a, now) {
    return now >= a.e ? 'past' : now >= a.b ? 'now' : 'later';
  }

  // ---- Chips ----------------------------------------------------------------------------------------
  // Favourites (always: it says where favourites go, and opens on them once there are some), All,
  // On now, then the categories that have channels, in the rail's order. A family (from the filter
  // sheet) or anything else the chips don't have gets a chip of its own at the front while chosen.
  // entries: B.railEntries(); base: the current choice; label(key): its name.
  // -> [{id, label, icon}]
  function chips(entries, base, label) {
    const out = [{ id: 'fav', label: 'Favourites', icon: 'star' }, { id: 'all', label: 'All' }];
    entries.forEach((e) => {
      if (e.kind !== 'pick') return;
      if (e.key === 'now') out.push({ id: 'now', label: 'On now' });
      else if (e.key.indexOf('c:') === 0) out.push({ id: e.key, label: e.label });
    });
    if (base && !out.some((c) => c.id === base)) out.unshift({ id: base, label: label(base), icon: 'filter', extra: true });
    return out;
  }

  // ---- Last watched -------------------------------------------------------------------------------

  // The channels watched most recently, newest first, without repeats, at most `max`.
  function noteRecent(list, identifier, max) {
    const out = [String(identifier)].concat((list || []).filter((id) => id !== String(identifier)));
    return out.slice(0, max || 6);
  }

  // ---- Number pad -----------------------------------------------------------------------------------

  // digits so far + a key ('0'-'9' or 'del') -> the new digits. A full entry starts over, as on the
  // TV (L.typeDigit).
  function padKey(digits, key, max) {
    const d = String(digits || '');
    if (key === 'del') return d.slice(0, -1);
    if (!/^\d$/.test(key)) return d;
    return d.length >= max ? key : d + key;
  }

  PL.touchLiveLogic = { geometry, rowRange, rowTop, timeLeft, timeWindow, airingsIn, ticks, left, when, chips, noteRecent, padKey, GEOMETRY };
})();
