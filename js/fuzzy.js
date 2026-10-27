// Client-side fuzzy title search over every movie and show. The index is small (one row per title),
// cached in localStorage, and scored without allocating per keystroke so it keeps up with typing on
// the TV's CPU.
'use strict';

(function () {
  var STORE_KEY = 'pl.fuzzy.v2';
  var OLD_KEYS = ['pl.fuzzy.v1'];
  var STALE_MS = 6 * 3600 * 1000;
  var PAGE = 500;
  var WRITE_DELAY_MS = 2000;
  var LIST_TRIM = {
    excludeElements: 'Media,Role,Genre,Country,Director,Writer,Collection,Image,UltraBlurColors,Guid',
    excludeFields: 'summary,tagline,guid,slug,studio,primaryExtraKey,ratingImage,audienceRatingImage,contentRatingAge,loudnessAnalysisVersion',
  };

  var fuzzy = PL.fuzzy = {
    ready: false, // some titles are searchable (preparation may still be running)
    complete: false, // every title is prepared
    entries: [],
    builtAt: 0,
    CHUNK: 150,
  };

  var listeners = [];
  var building = null;
  var gen = 0; // bumped by reset(): stale builds, preparations and writes check it
  var writeTimer = null;
  var quotaLogged = false;

  // ---- Normalising ------------------------------------------------------------------------------

  function base(s) {
    s = String(s || '').toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function stripArticle(s) {
    return s.replace(/^(the|a|an) /, '');
  }

  fuzzy.normalize = function (s) { return stripArticle(base(s)); };

  function initials(words) {
    var out = '';
    for (var i = 0; i < words.length; i++) out += words[i].charAt(0);
    return out;
  }

  function prepName(name) {
    var full = base(name);
    if (!full) return null;
    var n = stripArticle(full);
    var words = full.split(' ');
    return {
      n: n,
      c: n.replace(/ /g, ''),
      w: words,
      i1: initials(words),
      i2: initials(n.split(' ')),
    };
  }

  // row: [ratingKey, type, title, year, thumb, art, originalTitle]
  function prep(row) {
    var type = row[1] === 's' ? 'show' : row[1] === 'm' ? 'movie' : row[1];
    var item = { ratingKey: row[0], type: type, title: row[2], year: row[3] || undefined, thumb: row[4] || undefined, art: row[5] || undefined };
    if (row[6]) item.originalTitle = row[6];
    var e = { item: item, p: prepName(row[2]) || { n: '', c: '', w: [], i1: '', i2: '' }, alt: null, year: row[3] || 0 };
    if (row[6] && row[6] !== row[2]) e.alt = prepName(row[6]);
    e.len = e.p.n.length;
    return e;
  }

  // ---- Scoring ----------------------------------------------------------------------------------

  var r0 = [];
  var r1 = [];
  var r2 = [];

  // Smallest optimal-string-alignment distance between `a` and any prefix of `b`; > k means no match.
  function prefixDistance(a, b, k) {
    var n = a.length;
    var m = b.length;
    var j;
    for (j = 0; j <= m; j++) r1[j] = j;
    var prev2 = r0;
    var prev = r1;
    var cur = r2;
    for (var i = 1; i <= n; i++) {
      cur[0] = i;
      var rowMin = i;
      var ac = a.charCodeAt(i - 1);
      for (j = 1; j <= m; j++) {
        var bc = b.charCodeAt(j - 1);
        var v = prev[j - 1] + (ac === bc ? 0 : 1);
        var t = prev[j] + 1;
        if (t < v) v = t;
        t = cur[j - 1] + 1;
        if (t < v) v = t;
        if (i > 1 && j > 1 && ac === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bc) {
          t = prev2[j - 2] + 1;
          if (t < v) v = t;
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > k) return k + 1;
      var tmp = prev2;
      prev2 = prev;
      prev = cur;
      cur = tmp;
    }
    var best = k + 1;
    for (j = 0; j <= m; j++) if (prev[j] < best) best = prev[j];
    return best;
  }

  function allowed(len) {
    return len <= 3 ? 0 : len <= 6 ? 1 : 2;
  }

  // Cost of the cheapest title word this token matches (prefix = 0), or -1.
  function tokenCost(tok, k, words) {
    var best = k + 1;
    var c0 = tok.charCodeAt(0);
    var c1 = tok.charCodeAt(1);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.lastIndexOf(tok, 0) === 0) return 0;
      if (k === 0) continue;
      var w0 = w.charCodeAt(0);
      // a typo in the very first letter is rare; allow only a swapped first pair
      if (w0 !== c0 && !(w0 === c1 && w.charCodeAt(1) === c0)) continue;
      if (w.length < tok.length - k) continue;
      var d = prefixDistance(tok, w.length > tok.length + k ? w.slice(0, tok.length + k) : w, k);
      if (d < best) {
        best = d;
        if (d === 1 && k === 1) break;
      }
    }
    return best <= k ? best : -1;
  }

  function scoreName(p, q) {
    var n = p.n;
    if (!n) return 0;
    var qn = q.n;
    if (n === qn) return 1000;
    if (n.lastIndexOf(qn, 0) === 0) return 900;
    if ((' ' + n).indexOf(' ' + qn) !== -1) return 800;
    if (q.c.length > 1 && p.c.lastIndexOf(q.c, 0) === 0) return 760;
    if (qn.length > 1) {
      if (n.indexOf(qn) !== -1) return 700;
      if (p.c.indexOf(q.c) !== -1) return 680;
    }
    if (q.single && q.c.length > 1 && (p.i1.lastIndexOf(q.c, 0) === 0 || p.i2.lastIndexOf(q.c, 0) === 0)) return 650;
    if (!q.fuzzy) return 0;
    var cost = 0;
    for (var t = 0; t < q.tokens.length; t++) {
      var c = tokenCost(q.tokens[t], q.k[t], p.w);
      if (c < 0) return 0;
      cost += c;
    }
    return 500 - 40 * cost;
  }

  function prepQuery(text) {
    var full = base(text);
    var n = stripArticle(full);
    if (!n) n = full;
    if (!n) return null;
    var tokens = n.split(' ');
    var k = tokens.map(function (t) { return allowed(t.length); });
    return {
      n: n,
      c: n.replace(/ /g, ''),
      tokens: tokens,
      k: k,
      single: tokens.length === 1,
      fuzzy: tokens.length > 1 || k[0] > 0,
    };
  }

  // Best matches for `text`, most relevant first. Returns plain items (ratingKey, type, title, ...).
  fuzzy.query = function (text, limit) {
    var q = prepQuery(text);
    if (!q || !fuzzy.entries.length) return [];
    var hits = [];
    var entries = fuzzy.entries;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var s = scoreName(e.p, q);
      if (e.alt && s < 1000) {
        var s2 = scoreName(e.alt, q) - 5;
        if (s2 > s) s = s2;
      }
      if (s > 0) hits.push({ s: s, e: e });
    }
    hits.sort(function (a, b) {
      return (b.s - a.s) || (a.e.len - b.e.len) || (b.e.year - a.e.year);
    });
    var out = [];
    var max = Math.min(hits.length, limit || 30);
    for (var j = 0; j < max; j++) out.push(hits[j].e.item);
    return out;
  };

  // ---- Index --------------------------------------------------------------------------------------

  // Prepares rows in small slices so the UI keeps responding. With no index yet, queries search the
  // prepared part as it grows; a refresh is built aside and swapped in whole, so results never blank.
  // Resolves true when every row is prepared (false if superseded or reset).
  fuzzy.setRows = function (rows, builtAt) {
    var myGen = ++gen;
    var entries = [];
    var live = !fuzzy.ready || !fuzzy.complete;
    if (live) {
      fuzzy.entries = entries;
      fuzzy.builtAt = builtAt || Date.now();
      fuzzy.ready = true;
      fuzzy.complete = false;
    }
    var chunk = Math.max(1, fuzzy.CHUNK);
    return new Promise(function (resolve) {
      var i = 0;
      function slice() {
        if (myGen !== gen) return resolve(false);
        var end = Math.min(rows.length, i + chunk);
        for (; i < end; i++) entries.push(prep(rows[i]));
        if (i < rows.length) {
          setTimeout(slice, 0);
          return;
        }
        fuzzy.entries = entries;
        fuzzy.builtAt = builtAt || Date.now();
        fuzzy.ready = true;
        fuzzy.complete = true;
        listeners.slice().forEach(function (fn) { fn(); });
        resolve(true);
      }
      slice();
    });
  };

  fuzzy.onChange = function (fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  };

  // Identifies server + account without storing the token: a 32-bit FNV-1a hash of it.
  function cacheId() {
    var server = PL.plex.server && PL.plex.server.machineId;
    var token = PL.plex.token || (PL.plex.server && PL.plex.server.token) || '';
    var h = 0x811c9dc5;
    for (var i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return (server || '') + ':' + h.toString(36);
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function scheduleWrite(rows, at, id) {
    clearTimeout(writeTimer);
    var myGen = gen;
    writeTimer = setTimeout(function () {
      writeTimer = null;
      if (myGen !== gen) return;
      try {
        OLD_KEYS.forEach(function (k) { localStorage.removeItem(k); });
        localStorage.setItem(STORE_KEY, JSON.stringify({ a: at, s: id, r: rows }));
      } catch (e) {
        if (!quotaLogged) {
          quotaLogged = true;
          PL.warn('search index not cached (storage full?); keeping it in memory only:', e && e.name);
        }
        try { localStorage.removeItem(STORE_KEY); } catch (e2) { /* ignore */ }
      }
    }, WRITE_DELAY_MS);
  }

  // Trailing empty fields are dropped to keep the cached index small.
  function toRow(m, type) {
    var row = [m.ratingKey, type === 'show' ? 's' : 'm', m.title || '', m.year || 0, m.thumb || '', m.art || '',
      m.originalTitle && m.originalTitle !== m.title ? m.originalTitle : ''];
    while (row.length > 3 && !row[row.length - 1]) row.pop();
    return row;
  }

  function fetchSection(section, rows) {
    var type = section.type === 'show' ? 'show' : 'movie';
    function page(start) {
      var params = {
        type: type === 'show' ? 2 : 1,
        sort: 'titleSort',
        includeCollections: 0,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PAGE,
      };
      Object.keys(LIST_TRIM).forEach(function (k) { params[k] = LIST_TRIM[k]; });
      return PL.plex.get('/library/sections/' + section.key + '/all', params, { timeout: 30000 }).then(function (mc) {
        var items = mc.Metadata || [];
        for (var i = 0; i < items.length; i++) rows.push(toRow(items[i], type));
        var total = mc.totalSize != null ? mc.totalSize : start + items.length;
        if (items.length && start + items.length < total) return page(start + items.length);
        return null;
      });
    }
    return page(0);
  }

  function build() {
    if (building) return building;
    var myGen = gen;
    var id = cacheId();
    var sections = ((PL.app && PL.app.sections) || []).filter(function (s) { return s.type === 'movie' || s.type === 'show'; });
    var rows = [];
    var chain = Promise.resolve();
    sections.forEach(function (s) {
      chain = chain.then(function () { return fetchSection(s, rows); });
    });
    var p = chain.then(function () {
      if (building === p) building = null;
      if (myGen !== gen) return;
      var at = Date.now();
      return fuzzy.setRows(rows, at).then(function (done) {
        if (!done) return;
        PL.log('search index built:', rows.length, 'titles');
        scheduleWrite(rows, at, id);
      });
    }, function (err) {
      if (building === p) building = null;
      throw err;
    });
    building = p;
    return p;
  }

  fuzzy.rebuild = build;

  // Resolves as soon as there is something to search. A cached index (same server and account) is
  // used straight away and refreshed in the background when it is older than six hours.
  fuzzy.ensure = function () {
    if (fuzzy.ready) {
      if (Date.now() - fuzzy.builtAt > STALE_MS && !building) build().then(null, function () {});
      return Promise.resolve();
    }
    var cached = readCache();
    if (cached && cached.r && cached.s === cacheId()) {
      fuzzy.setRows(cached.r, cached.a);
      if (Date.now() - cached.a > STALE_MS) build().then(null, function () {});
      return Promise.resolve();
    }
    return build();
  };

  // Forgets the index (sign-out): nothing from the previous account stays in memory or storage.
  fuzzy.reset = function () {
    gen++;
    building = null;
    clearTimeout(writeTimer);
    writeTimer = null;
    fuzzy.entries = [];
    fuzzy.ready = false;
    fuzzy.complete = false;
    fuzzy.builtAt = 0;
    try {
      localStorage.removeItem(STORE_KEY);
      OLD_KEYS.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  };

  fuzzy.isBuilding = function () { return !!building; };
})();
