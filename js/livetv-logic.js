// Live TV's pure logic (no DOM): turning Plex guide responses into channels and airings, the guide
// grid's time maths and focus rules, channel-number entry, labels, and the live player's remote map.
// Kept apart from the screens so it can be tested in node (test/livetv-logic.test.mjs).
// Layout and remote tables: docs/LIVETV-v2-design.md.
'use strict';

(function () {
  var PL = window.PL = window.PL || {};
  var L = PL.liveLogic = {};

  var HALF_HOUR = 1800;
  L.HALF_HOUR = HALF_HOUR;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function two(n) { return (n < 10 ? '0' : '') + n; }

  L.floorTo = function (t, step) { return Math.floor(t / step) * step; };
  L.ceilTo = function (t, step) { return Math.ceil(t / step) * step; };

  // ---- Labels -------------------------------------------------------------------------------------

  // guide filler such as "..programmes start at 7.00pm" is not a programme
  var FILLER = /^\s*(\.\.|…)/;
  L.isFiller = function (title) { return FILLER.test(title || ''); };

  // unix seconds -> "21:05" (the TV's local time)
  L.clock = function (t) {
    var d = new Date(t * 1000);
    return two(d.getHours()) + ':' + two(d.getMinutes());
  };

  function dayIndex(t) {
    var d = new Date(t * 1000);
    return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // "Today", "Tomorrow", or the weekday, for t as seen at `now`.
  L.day = function (t, now) {
    var diff = dayIndex(t) - dayIndex(now);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return DAYS[new Date(t * 1000).getDay()];
  };

  // minutes -> "45 min", "1 hr", "1 hr 20 min"
  L.span = function (sec) {
    var m = Math.max(1, Math.round(sec / 60));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' hr' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  };

  // An airing's time, as seen at `now`: "21:00 – 22:00", with the day when it isn't today.
  L.times = function (a, now) {
    var day = L.day(a.b, now);
    return (day === 'Today' ? '' : day + ' ') + L.clock(a.b) + ' – ' + L.clock(a.e);
  };

  // "25 min left" while on, "Starts in 10 min" soon, "Starts 22:00" later, "Ended" after.
  L.status = function (a, now) {
    if (now >= a.e) return 'Ended';
    if (now >= a.b) return L.span(a.e - now) + ' left';
    if (a.b - now <= 3600) return 'Starts in ' + L.span(a.b - now);
    return 'Starts ' + (L.day(a.b, now) === 'Today' ? '' : L.day(a.b, now) + ' ') + L.clock(a.b);
  };

  L.progress = function (a, now) {
    return clamp((now - a.b) / Math.max(1, a.e - a.b), 0, 1);
  };

  // ---- Guide data ---------------------------------------------------------------------------------

  // Guide titles from an XMLTV feed are often "<number> <group> - <name>" ("1001 UK - News One"). The
  // number is shown on its own, so it is dropped; a group prefix ("UK - ") is dropped only when most
  // channels have one (then it says nothing).
  L.GROUP = /^([A-Za-z0-9+]{2,6}) ?[-|:] (.+)$/;

  L.stripNumber = function (title, vcn) {
    title = String(title || '');
    vcn = String(vcn || '');
    if (vcn && title.indexOf(vcn + ' ') === 0) title = title.slice(vcn.length + 1);
    return title;
  };

  L.groupsInUse = function (titles) {
    if (!titles.length) return false;
    var n = titles.filter(function (t) { return L.GROUP.test(t); }).length;
    return n >= titles.length / 2;
  };

  L.channelName = function (title, stripGroup) {
    var m = stripGroup ? L.GROUP.exec(title) : null;
    return m ? m[2] : title;
  };

  function badSeason(n) { return n == null || n > 1900; }

  // A programme's display title and second line.
  //   episode: title = the show, sub = "S3 E2 · Episode title" (dropping XMLTV's dated placeholders)
  //   movie:   title = the film, sub = the year
  L.programme = function (p) {
    var title = p.title || '';
    var sub = '';
    if (p.type === 'episode' && p.grandparentTitle) {
      var ep = !badSeason(p.parentIndex) && p.index != null ? 'S' + p.parentIndex + ' E' + p.index : '';
      var name = /^Episode [\d-]+$/i.test(title) || title === p.grandparentTitle ? '' : title;
      title = p.grandparentTitle;
      sub = [ep, name].filter(Boolean).join(' · ');
    } else if (p.type === 'movie' && p.year) {
      sub = String(p.year);
    }
    return { title: title, sub: sub };
  };

  // A /grid MediaContainer -> {channels: {identifier: {identifier, id, vcn, title, thumb}},
  // airings: {identifier: [airing]}}. One programme can air on several channels or several times.
  // airing: {b, e, title, sub, type, art, key, genres, show (the show's ratingKey, for its genres)}
  L.parseGrid = function (mc) {
    var channels = {};
    var airings = {};
    ((mc && mc.Metadata) || []).forEach(function (p) {
      var name = L.programme(p);
      var genres = (p.Genre || []).map(function (g) { return g.tag; }).join(', ');
      (p.Media || []).forEach(function (m) {
        if (m.channelIdentifier == null || !(m.endsAt > m.beginsAt)) return;
        var id = String(m.channelIdentifier);
        if (!channels[id]) {
          var vcn = String(m.channelVcn || id);
          channels[id] = {
            identifier: id, id: m.channelID != null ? m.channelID : null, vcn: vcn,
            title: L.stripNumber(m.channelTitle || m.channelCallSign || '', vcn), thumb: m.channelThumb || null,
          };
        }
        (airings[id] = airings[id] || []).push({
          b: m.beginsAt, e: m.endsAt, title: name.title, sub: name.sub, type: p.type,
          art: p.thumb || p.grandparentThumb || null, key: p.key || null, genres: genres,
          show: p.grandparentRatingKey || null,
        });
      });
    });
    Object.keys(airings).forEach(function (id) { airings[id] = L.tidy(airings[id]); });
    return { channels: channels, airings: airings };
  };

  // Sorted by start, duplicates (the same airing from two fetches) dropped, overlaps trimmed so
  // cells never cover each other.
  L.tidy = function (list) {
    list = list.slice().sort(function (a, b) { return a.b - b.b || b.e - a.e; });
    var out = [];
    list.forEach(function (a) {
      var last = out[out.length - 1];
      if (last && a.b === last.b) return;
      if (last && a.b < last.e) {
        if (a.e <= last.e) return; // inside the one before
        last = out[out.length - 1] = copy(last);
        last.e = a.b;
      }
      out.push(a);
    });
    return out;
  };

  function copy(a) {
    var o = {};
    Object.keys(a).forEach(function (k) { o[k] = a[k]; });
    return o;
  }

  L.merge = function (old, add) {
    if (!old || !old.length) return add ? add.slice() : [];
    if (!add || !add.length) return old;
    return L.tidy(old.concat(add));
  };

  // Drops airings that ended before `t`.
  L.prune = function (list, t) {
    var i = 0;
    while (i < list.length && list[i].e <= t) i++;
    return i ? list.slice(i) : list;
  };

  // Index of the airing on at t, or -1.
  L.indexAt = function (list, t) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].b <= t && t < list[i].e) return i;
      if (list[i].b > t) return -1;
    }
    return -1;
  };

  // {now, next}: the airing on at t and the one after it (either may be null).
  L.nowNext = function (list, t) {
    list = list || [];
    var i = L.indexAt(list, t);
    if (i >= 0) return { now: list[i], next: list[i + 1] || null };
    for (var j = 0; j < list.length; j++) if (list[j].b > t) return { now: null, next: list[j] };
    return { now: null, next: null };
  };

  // Channel order: by number (numerically, "2.1" after "2"), then title.
  L.byNumber = function (a, b) {
    var d = (parseFloat(a.vcn) || 0) - (parseFloat(b.vcn) || 0);
    return d || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  };

  // ---- The guide grid -----------------------------------------------------------------------------
  // Time runs from `origin` (the half hour the guide opened in; nothing earlier is shown). The view
  // shows `span` seconds from `start` (a multiple of the step after origin).

  // A cell's box in px from origin: {x, w, shift}. Airings that began before origin start at it;
  // shift is how far to move the title right so it stays in view when the cell starts before the
  // view does.
  L.cell = function (a, origin, start, pps, gap) {
    var b = Math.max(a.b, origin);
    var x = (b - origin) * pps;
    var w = Math.max(0, (a.e - b) * pps - gap);
    var shift = Math.max(0, (start - b) * pps);
    return { x: x, w: w, shift: Math.min(shift, Math.max(0, w - 120)) };
  };

  // Where the view should start so the focused airing's (visible) start is on screen with at least
  // one step to its right. Scrolls as little as possible, in whole steps, never before origin.
  L.viewStart = function (start, a, origin, span, step) {
    if (!a) return start;
    var b = Math.max(a.b, origin);
    if (b < start) return Math.max(origin, L.floorTo(b - origin, step) + origin);
    if (b > start + span - step) return origin + L.ceilTo(b - origin - span + step, step);
    return start;
  };

  // The airing to focus on a row when arriving at time `anchor` (Up/Down keep the time): the one on
  // at the anchor, else the next one after it, else the last one before. -1 for an empty row.
  L.pick = function (list, anchor) {
    if (!list || !list.length) return -1;
    var i = L.indexAt(list, anchor);
    if (i >= 0) return i;
    for (var j = 0; j < list.length; j++) if (list[j].b > anchor) return j;
    return list.length - 1;
  };

  // The first row to show so that the focused row sits `lead` rows from the top once scrolling
  // starts, without leaving empty space under the last row.
  L.firstRow = function (focus, count, visible, lead) {
    return clamp(focus - lead, 0, Math.max(0, count - visible));
  };

  // ---- Channel number entry -----------------------------------------------------------------------
  // Digits pile up (up to the longest channel number); the entry commits on OK, after a pause, or
  // at once when no other channel number starts with what was typed.

  L.maxDigits = function (numbers) {
    var n = 1;
    numbers.forEach(function (v) { n = Math.max(n, String(v).replace(/\D/g, '').length); });
    return Math.min(n, 5);
  };

  // digits so far + a new digit -> the new digits (a full entry starts over)
  L.typeDigit = function (digits, d, max) {
    digits = String(digits || '');
    return digits.length >= max ? String(d) : digits + d;
  };

  // The channel the digits mean: an exact number, else the nearest higher, else the highest.
  // numbers: channel numbers (strings) in guide order. Returns {index, exact} or null.
  L.matchNumber = function (numbers, digits) {
    if (!digits || !numbers.length) return null;
    var want = parseInt(digits, 10);
    var best = -1;
    var bestVal = Infinity;
    var top = -1;
    var topVal = -Infinity;
    for (var i = 0; i < numbers.length; i++) {
      var s = String(numbers[i]);
      if (s === digits || s.replace(/\D/g, '') === digits) return { index: i, exact: true };
      var v = parseFloat(s);
      if (isNaN(v)) continue;
      if (v === want) return { index: i, exact: true };
      if (v > want && v < bestVal) { best = i; bestVal = v; }
      if (v > topVal) { top = i; topVal = v; }
    }
    if (best >= 0) return { index: best, exact: false };
    return top >= 0 ? { index: top, exact: false } : null;
  };

  // While typing: the first channel whose number starts with the digits ("13" -> 130), else what
  // the digits would mean now.
  L.previewNumber = function (numbers, digits) {
    if (!digits) return null;
    for (var i = 0; i < numbers.length; i++) {
      var s = String(numbers[i]).replace(/\D/g, '');
      if (s.indexOf(digits) === 0) return { index: i, exact: s === digits, prefix: s !== digits };
    }
    return L.matchNumber(numbers, digits);
  };

  // True when waiting for more digits can't change the answer.
  L.entryDone = function (numbers, digits, max) {
    if (!digits) return false;
    if (digits.length >= max) return true;
    for (var i = 0; i < numbers.length; i++) {
      var s = String(numbers[i]).replace(/\D/g, '');
      if (s.length > digits.length && s.indexOf(digits) === 0) return false;
    }
    return true;
  };

  // ---- The live buffer (pause / rewind) -----------------------------------------------------------

  // From the video's seekable range: {start, end, behind} in stream seconds, or null when the TV
  // doesn't expose one (then there is nothing to seek in). behind: seconds behind the live edge.
  L.buffer = function (seekStart, seekEnd, cur) {
    if (!(seekEnd > seekStart) || !isFinite(seekEnd) || seekEnd - seekStart < 20) return null;
    return { start: seekStart, end: seekEnd, behind: Math.max(0, seekEnd - cur) };
  };

  // Within this of the edge counts as live (segments arrive a few seconds late anyway).
  L.LIVE_SLACK = 12;
  L.isLive = function (behind) { return !(behind > L.LIVE_SLACK); };

  // "−4:12" for being 252 s behind live.
  L.behindLabel = function (sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return '−' + (h ? h + ':' + two(m) : m) + ':' + two(s);
  };

  // "12 sec behind live", "4 min behind live"
  L.behindText = function (sec) {
    sec = Math.round(sec);
    return (sec < 60 ? Math.max(1, sec) + ' sec' : L.span(sec)) + ' behind live';
  };

  // ---- Live player remote -------------------------------------------------------------------------
  // key: 'left' | 'right' | 'up' | 'down' | 'ok' | 'back'. c:
  //   view     what is up: 'none' | 'banner' | 'guide' (the mini guide)
  //   zone     in the banner: 'bar' | 'icons'
  //   canSeek  the TV exposes a buffer to seek in
  //   playing  a stream is playing or paused (not tuning, not failed)
  // Returns an action name for LiveOsd.act, or null.
  L.liveKey = function (c, key) {
    if (c.view === 'guide') {
      return { up: 'guide-up', down: 'guide-down', ok: 'guide-tune', back: 'guide-close', left: 'guide-close', right: null }[key] || null;
    }
    if (c.view === 'none') {
      if (key === 'back') return 'exit';
      if (key === 'up' || key === 'down') return 'guide-open';
      if ((key === 'left' || key === 'right') && c.canSeek) return key === 'left' ? 'jump-back' : 'jump-fwd';
      return 'banner';
    }
    // the banner
    if (key === 'back') return 'hide';
    if (c.zone === 'icons') {
      return { left: 'icon-prev', right: 'icon-next', ok: 'icon-press', down: 'zone-bar', up: null }[key] || null;
    }
    if (key === 'up') return c.hasIcons ? 'zone-icons' : null;
    if (key === 'down') return 'guide-open';
    if (key === 'ok') return c.playing ? 'toggle-pause' : null;
    if ((key === 'left' || key === 'right') && c.canSeek) return key === 'left' ? 'jump-back' : 'jump-fwd';
    return null;
  };
})();
