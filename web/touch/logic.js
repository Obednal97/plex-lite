// The phone and tablet layer's pure decisions (docs/WEB.md, "Phones and tablets"): when the layer
// takes over from the TV stage, which layout it uses, which tabs it shows, what a title's quick
// actions are. No DOM here, so test/touch.test.mjs runs it in Node. Web build only (web/touch/ may
// use modern JS: the TV never loads it).
'use strict';

(() => {
  const PL = window.PL = window.PL || {};

  // Under this width the layer always takes over (phones, portrait tablets, narrow windows); up to
  // WIDE_TOUCH a touch-first device (an iPad in landscape) keeps it too, since the TV layout
  // doesn't scroll by touch. Above that, or with Controls pinned to Remote, it's the TV stage.
  const NARROW = 1100;
  const WIDE_TOUCH = 1400;
  const PHONE = 600;
  const SHORT = 500;

  // env: {width, setting: 'auto'|'remote'|'touch'|'pointer', detected: 'remote'|'touch'|'pointer'}
  function wanted(env) {
    if (env.setting === 'remote') return false;
    if (!(env.width > 0)) return false;
    if (env.width < NARROW) return true;
    const touchy = env.setting === 'touch' || (env.setting === 'auto' && env.detected === 'touch');
    return touchy && env.width <= WIDE_TOUCH;
  }

  // 'phone' (one column, under 600 px) or 'tablet' (two columns); short: a phone on its side.
  function layout(width, height) {
    return { kind: width < PHONE ? 'phone' : 'tablet', short: height > 0 && height < SHORT };
  }

  // The bottom tabs: Movies, TV Shows (each film or TV library, films first), Live TV, Search.
  // At most MAX_LIBS libraries get a tab; the rest are listed under the profile menu.
  const MAX_LIBS = 3;
  function tabs(sections, hasLiveTv) {
    const libs = (sections || []).filter((s) => s.type === 'movie' || s.type === 'show');
    // the first film and the first TV library always get a tab, then the others in the server's order
    const firsts = ['movie', 'show'].map((t) => libs.filter((s) => s.type === t)[0]).filter(Boolean);
    const picked = firsts.concat(libs.filter((s) => firsts.indexOf(s) < 0)).slice(0, MAX_LIBS);
    const ordered = libs.filter((s) => s.type === 'movie').concat(libs.filter((s) => s.type === 'show'));
    const out = ordered.filter((s) => picked.indexOf(s) >= 0).map((s) => ({
      id: 'section.' + s.key, label: s.title, icon: s.type === 'movie' ? 'film' : 'tv', section: s,
    }));
    if (hasLiveTv) out.push({ id: 'livetv', label: 'Live TV', icon: 'live' });
    out.push({ id: 'search', label: 'Search', icon: 'search' });
    return { tabs: out, more: ordered.filter((s) => picked.indexOf(s) < 0) };
  }

  // The tab to open on: the stage's choice (TV Shows at launch) if it has one here, else the first.
  function startTab(list, stageId) {
    const i = list.map((t) => t.id).indexOf(stageId);
    return i >= 0 ? i : 0;
  }

  // Back at the top of a tab: go to the start tab first, then let the browser leave.
  // -> 'pop' | 'start' | 'leave'
  function backAction(depth, tabIndex, startIndex) {
    if (depth > 1) return 'pop';
    if (tabIndex !== startIndex) return 'start';
    return 'leave';
  }

  // The width to ask Plex's image transcoder for: CSS pixels times the screen's density (at most
  // 2x: 3x phones gain nothing visible for posters and pay in data), rounded up to a step of 20
  // so neighbouring sizes share the server's cache.
  function imageWidth(cssWidth, dpr) {
    const d = Math.min(Math.max(dpr || 1, 1), 2);
    return Math.ceil((cssWidth * d) / 20) * 20;
  }

  // A title's quick actions (long-press or "…"), as on the TV (js/screens/common.js itemMenu).
  // -> [{id, label}] ids: resume, play, restart, watched, unwatched, show, details
  function menuRows(item, opts) {
    const t = item && item.type;
    if (['movie', 'episode', 'show', 'season'].indexOf(t) === -1) return [];
    const o = opts || {};
    const rows = [];
    const clock = o.clock || ((ms) => String(Math.round(ms / 1000)));
    if (t === 'movie' || t === 'episode') {
      if (item.viewOffset > 0) {
        rows.push({ id: 'resume', label: 'Resume from ' + clock(item.viewOffset) });
        rows.push({ id: 'restart', label: 'Play from the beginning' });
      } else {
        rows.push({ id: 'play', label: 'Play' });
      }
    }
    const watched = (t === 'show' || t === 'season')
      ? item.leafCount > 0 && item.viewedLeafCount === item.leafCount
      : item.viewCount > 0 && !item.viewOffset;
    const partial = item.viewOffset > 0 || (item.viewedLeafCount > 0 && !watched);
    if (!watched) rows.push({ id: 'watched', label: 'Mark as watched' });
    if (watched || partial) rows.push({ id: 'unwatched', label: 'Mark as unwatched' });
    if (t === 'episode' && item.grandparentRatingKey) rows.push({ id: 'show', label: 'Go to show' });
    if (t === 'season' && item.parentRatingKey) rows.push({ id: 'show', label: 'Go to show' });
    if (!o.onDetails) rows.push({ id: 'details', label: 'Details' });
    return rows;
  }

  // Cards across a row so the next one peeks in: the card width for a row `width` wide with a
  // left gutter, `gap` between cards and `across` cards (a fraction: 3.25 shows a quarter of the
  // fourth). Whole CSS pixels.
  function cardWidth(width, gutter, gap, across) {
    return Math.floor((width - gutter - gap * Math.floor(across)) / across);
  }

  PL.touchLogic = { wanted, layout, tabs, startTab, backAction, imageWidth, menuRows, cardWidth, NARROW, WIDE_TOUCH, PHONE };
})();
