// Search's Live TV matching (no DOM): channels by name or number, and the guide's programmes by
// title. It scores with the library search's matcher (js/fuzzy.js), so word starts, initials and
// typos behave the same in every row. Kept apart from the screen so it can be tested in node
// (test/livetv-search.test.mjs).
//
// Cost per keystroke: one prepared query, then a score per channel name (up to four per channel)
// and one per distinct programme title in the loaded guide. The indexes are built once per guide
// change, not per keystroke.
'use strict';

(function () {
  var PL = window.PL = window.PL || {};
  var S = PL.liveSearch = {};

  // matches at or above this are "real" (exact, prefix, word start, substring, initials); when
  // there are some, typo matches (500 and below) are left out so they don't bury them
  S.STRONG = 600;
  S.REBUILD_MS = 60 * 1000;
  // Channels and On TV go above Movies & Shows when a channel matches at least at a word start (800;
  // see channelsFirst)
  S.TV_FIRST = 800;
  // guide filler such as "..programmes start at 7.00pm" is not a programme
  var FILLER = /^\s*(\.\.|…)/;

  var QUALITY = /[\s|:-]*[[(]?\b(uhd|fhd|hd|sd|4k|hevc|h265|h264|1080p|1080|720p|720|50fps|60fps|raw|backup)\b[\])]?\s*$/i;
  var WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  var EMPTY = { n: '', c: '', w: [], i1: '', i2: '' };

  function F() { return PL.fuzzy; }

  // "UK - News One HD" -> "News One". The guide drops a group prefix only when most channels have
  // one; for matching it always goes, and quality tags at the end go too (they are noise in a query).
  S.cleanName = function (title) {
    var t = String(title || '');
    var m = PL.liveLogic.GROUP.exec(t);
    if (m) t = m[2];
    for (var i = 0; i < 2; i++) {
      var u = t.replace(QUALITY, '');
      if (u === t || !u.trim()) break;
      t = u;
    }
    return t.trim();
  };

  // "news1" -> "news 1" (IPTV names often glue the number on)
  function splitDigits(n) {
    return n.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  }

  // "news 1" <-> "news one", so either spelling finds the channel
  S.swapNumbers = function (n) {
    return n.split(' ').map(function (w) {
      var i = WORDS.indexOf(w);
      if (i >= 0) return String(i);
      if (/^\d+$/.test(w) && String(Number(w)) === w && Number(w) <= 10) return WORDS[Number(w)];
      return w;
    }).join(' ');
  };

  // The spellings a channel answers to, best first: the clean name, with glued digits split, with
  // numbers swapped, and the whole title (so a group like "uk news" still finds it).
  S.channelNames = function (c) {
    var base = F().base;
    var clean = base(S.cleanName(c.title || c.name));
    var split = splitDigits(clean);
    var out = [];
    [clean, split, S.swapNumbers(split), base(c.title || '')].forEach(function (n) {
      if (n && out.indexOf(n) === -1) out.push(n);
    });
    return out;
  };

  // channels: [{identifier, vcn, title, name, ...}] -> the channel index.
  S.indexChannels = function (channels) {
    return channels.map(function (c) {
      return {
        c: c,
        names: S.channelNames(c).map(function (n) { return F().prepName(n) || EMPTY; }),
        num: String(c.vcn || '').replace(/\D/g, ''),
      };
    });
  };

  // The typed text, prepared once for both rows. null when there is nothing to match.
  S.query = function (text) {
    var t = String(text || '').trim();
    var q = F().prepQuery(t);
    if (!q) return null;
    q.digits = /^\d+$/.test(t) ? t : null;
    return q;
  };

  function keepStrong(hits) {
    var strong = false;
    for (var i = 0; i < hits.length; i++) if (hits[i].s >= S.STRONG) { strong = true; break; }
    return strong ? hits.filter(function (h) { return h.s >= S.STRONG; }) : hits;
  }

  function byNumber(a, b) { return PL.liveLogic.byNumber(a, b); }

  // Channels for the query, best first: a channel number typed exactly (1100), a number it starts
  // with (850), else the best of its names (other spellings 5 below the clean name). Ties: favourites,
  // then channel order. opts: {limit, isFavourite(identifier)}
  S.matchChannels = function (index, q, opts) {
    opts = opts || {};
    if (!q || !index || !index.length) return [];
    var score = F().score;
    var hits = [];
    for (var i = 0; i < index.length; i++) {
      var e = index[i];
      var s = 0;
      for (var j = 0; j < e.names.length; j++) {
        var v = score(e.names[j], q);
        if (v > 0 && j > 0 && v < 1000) v -= 5;
        if (v > s) s = v;
      }
      if (q.digits && e.num) {
        if (e.num === q.digits) s = 1100;
        else if (s < 850 && e.num.lastIndexOf(q.digits, 0) === 0) s = 850;
      }
      if (s > 0) hits.push({ s: s, c: e.c, fav: opts.isFavourite && opts.isFavourite(e.c.identifier) ? 1 : 0 });
    }
    hits = keepStrong(hits);
    hits.sort(function (a, b) { return (b.s - a.s) || (b.fav - a.fav) || byNumber(a.c, b.c); });
    var out = [];
    for (var k = 0; k < hits.length && k < (opts.limit || 30); k++) out.push(hits[k].c);
    out.best = hits.length ? hits[0].s : 0; // the top score, for channelsFirst
    return out;
  };

  // How well a library title (fuzzy index item) matches: the score of its title or original title.
  S.titleScore = function (item, q) {
    if (!item || !q) return 0;
    var s = F().score(F().prepName(item.title) || EMPTY, q);
    if (item.originalTitle && s < 1000) s = Math.max(s, F().score(F().prepName(item.originalTitle) || EMPTY, q) - 5);
    return s;
  };

  // Whether the TV rows go first: the query is about channels. True when a word of a channel's name
  // starts with the query, or a channel number does (best channel score >= S.TV_FIRST), unless a
  // library title is exactly the query (1000), and the query says enough: three or more characters,
  // or two or more digits. Only local results count, so the server's late answers can't change it.
  S.channelsFirst = function (q, channelBest, titleBest) {
    if (!q || !(channelBest >= S.TV_FIRST)) return false;
    if (q.c.length < (q.digits ? 2 : 3)) return false;
    return !(titleBest >= 1000);
  };

  // The guide index: one entry per distinct programme title that is on now or later, with the
  // first such airing of it on each channel. airingsOf(identifier) -> sorted airings
  // (js/livetv-logic.js parseGrid). cache: an object kept between builds, so each title is
  // prepared once.
  S.indexGuide = function (channels, airingsOf, now, cache) {
    cache = cache || {};
    var byTitle = {};
    var titles = [];
    var count = 0;
    for (var i = 0; i < channels.length; i++) {
      var c = channels[i];
      var list = airingsOf(c.identifier) || [];
      var seen = {};
      for (var j = 0; j < list.length; j++) {
        var a = list[j];
        if (a.e <= now || !a.title || a.empty || FILLER.test(a.title)) continue;
        var key = '$' + a.title;
        if (seen[key]) continue;
        seen[key] = true;
        var t = byTitle[key];
        if (!t) {
          var p = cache[key];
          if (!p) {
            p = cache[key] = F().prepName(a.title) || EMPTY;
            cache.size = (cache.size || 0) + 1;
          }
          t = byTitle[key] = { title: a.title, p: p, hits: [] };
          titles.push(t);
        }
        t.hits.push({ c: c, a: a });
        count++;
      }
    }
    return { titles: titles, airings: count, at: now };
  };

  // A fresh cache once it holds far more titles than any guide window would.
  S.trimCache = function (cache) {
    return cache && cache.size > 6000 ? {} : (cache || {});
  };

  // Programmes for the query: [{c, a, s, onNow}], best match first; within a score, what is on now,
  // then what starts soonest, then channel order. Airings that ended since the index was built are
  // skipped.
  S.matchProgrammes = function (index, q, now, limit) {
    if (!q || !index || !index.titles.length) return [];
    var score = F().score;
    var hits = [];
    var titles = index.titles;
    // a channel number isn't a programme title: no near misses ("1001" is not "PL 100")
    var min = q.digits ? S.STRONG : 1;
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      var s = score(t.p, q);
      if (s < min) continue;
      for (var j = 0; j < t.hits.length; j++) {
        var h = t.hits[j];
        if (h.a.e <= now) continue;
        hits.push({ s: s, c: h.c, a: h.a, onNow: h.a.b <= now });
      }
    }
    hits = keepStrong(hits);
    // with word-start matches, letters that only meet across words ("star" in "Lost Art", 680) or
    // initials (650) are noise in a guide full of titles
    var top = 0;
    for (var k = 0; k < hits.length; k++) if (hits[k].s > top) top = hits[k].s;
    if (top >= 800) hits = hits.filter(function (h) { return h.s >= 700; });
    hits.sort(function (x, y) {
      return (y.s - x.s) || ((y.onNow ? 1 : 0) - (x.onNow ? 1 : 0)) || (x.a.b - y.a.b) || byNumber(x.c, y.c);
    });
    return hits.slice(0, limit || 30);
  };
})();
