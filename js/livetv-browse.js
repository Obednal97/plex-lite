// Live TV Browse: the pure rules behind the Browse rail, its chips and the On now wall
// (docs/LIVETV-browse-design.md). Sky-style categories from guide genres (with a channel-name
// fallback), channel families from shared leading words in channel names, and the filter that the
// guide, the mini guide and CH+/CH- share. No DOM; tested in node (test/livetv-browse.test.mjs).
'use strict';

(function () {
  var PL = window.PL = window.PL || {};
  var B = PL.liveBrowse = {};

  // ---- Categories ---------------------------------------------------------------------------------

  // Rail order.
  B.CATEGORIES = [
    { id: 'entertainment', label: 'Entertainment' },
    { id: 'movies', label: 'Movies' },
    { id: 'sport', label: 'Sport' },
    { id: 'news', label: 'News' },
    { id: 'documentaries', label: 'Documentaries' },
    { id: 'kids', label: 'Kids' },
    { id: 'music', label: 'Music' },
    { id: 'shopping', label: 'Shopping' },
    { id: 'religious', label: 'Religious' },
  ];
  var LABEL = {};
  B.CATEGORIES.forEach(function (c) { LABEL[c.id] = c.label; });
  B.categoryLabel = function (id) { return LABEL[id] || ''; };

  // XMLTV / Plex genre tags -> a category. A programme takes the first rule any of its genres
  // matches, so a children's film is Kids and a news programme tagged "News & Documentary" is News;
  // "News & Documentary" on its own is a documentary (the UK listings' convention).
  var GENRE_RULES = [
    ['kids', /^(children'?s?|kids|under 5s?|pre-?school|cartoons?)$/],
    ['sport', new RegExp('^(sports?|sports? events?|football|soccer|tennis|cricket|golf|american football|baseball|basketball|' +
      'rugby( league| union)?|motor ?sports?|motor racing|darts|boxing|wrestling|racing|horse racing|athletics|snooker|cycling|' +
      '(ice )?hockey|martial arts|mma|equestrian|fishing|olympics|extreme sports?|winter sports?)$')],
    ['news', /^(news|news bulletins?|business|business & finance|finance|politics|world affairs|current affairs|weather)$/],
    ['movies', /^(movies?|films?|feature( films?)?)$/],
    ['music', /^(music|music & radio|rock ?& ?pop|pop|classical|folk( and country)?|country|jazz|dance|hip.hop|r&b|opera)$/],
    ['shopping', /^(shopping|tele-?shopping|home shopping|specialist)$/],
    ['religious', /^(religio(n|us)|faith|spiritual)$/],
    ['documentaries', new RegExp('^(factual|documentar(y|ies)|news & documentary|nature|natural history|wildlife|historical|history|' +
      'science|educational|education|war documentary|biography|technology|docu-?drama|true crime)$')],
    ['entertainment', new RegExp('^(entertainment|comedy|sitcom|drama|game ?show|quiz|soap|chat ?show|talk ?show|showbiz|lifestyles?|' +
      'home|cooking|food|magazine|gardening|gradening|travel|antiques|motors|detective|crime|sci-?fi|science fiction|action|' +
      'adventure|thriller|romance|horror|western|mystery|war|arts|world culture|family|animation|medical|transport|events|' +
      'fashion|musical|reality|series|review|fantasy|variety|consumer|property|health)$')],
  ];

  // genres: an array of tags or a comma-separated string. Returns a category id or null.
  B.categoryOfGenres = function (genres) {
    if (!genres) return null;
    var tags = (typeof genres === 'string' ? genres.split(',') : genres).map(function (g) {
      return String(g).trim().toLowerCase();
    }).filter(Boolean);
    if (!tags.length) return null;
    for (var r = 0; r < GENRE_RULES.length; r++) {
      for (var i = 0; i < tags.length; i++) {
        if (!GENRE_RULES[r][1].test(tags[i])) continue;
        // "Feature" next to a factual tag is a documentary feature, not a film
        if (GENRE_RULES[r][0] === 'movies' && !tags.some(isFilm) && tags.some(isFactual)) return 'documentaries';
        return GENRE_RULES[r][0];
      }
    }
    return null;
  };

  function isFilm(t) { return /^(movies?|films?|feature films?)$/.test(t); }
  function isFactual(t) { return /^(factual|documentar(y|ies)|news & documentary|true crime|biography|historical|nature)$/.test(t); }

  // A channel without categorised guide data: words in its name. Generic broadcast vocabulary only.
  var NAME_RULES = [
    ['news', /news|\bcnn\b|\bcnbc\b|bloomberg|al jazeera|\bmsnbc\b|euronews|parliament|c-?span|france 24|\bweather|\bbusiness\b/i],
    ['sport', /sport|\bespn|\bbein\b|\bdazn\b|racing|\bgolf|\bnfl\b|\bnba\b|\bnhl\b|\bmlb\b|\bufc\b|\bwwe\b|tennis|darts|league|redzone|olympic|football|cricket|rugby/i],
    ['kids', /kids|junior|\bnick|cartoon|\bdisney|\bcbbc\b|cbeebies|\bbaby|boomerang|toons|children/i],
    ['movies', /cinema|\bmovies?\b|\bfilms?\d*\b|\bflix\b|\btcm\b|\bamc\b|\bhbo\b|\bhorror\b|\bthriller/i],
    ['shopping', /\bqvc\b|\bhsn\b|\bshop|\btsc\b|ideal world|jewellery|jewelry/i],
    ['music', /\bmtv\b|\bvh1\b|\bmusic|\bhits\b|\bfuse\b|\bcmt\b|\bradio\b/i],
    ['documentaries', /documentar|discovery|history|\bnat ?geo|national geographic|\bscience|\bnature|\bwild/i],
    ['religious', /\bgod\b|\bfaith|gospel|christian|islam|\bdaystar|\bewtn|\brevelation/i],
    ['entertainment', /entertainment|\bdrama\b|\breality\b|\bcomedy\b|\blifestyle|\bshowcase\b|\blifetime\b/i],
  ];

  B.categoryOfName = function (name) {
    name = String(name || '');
    for (var i = 0; i < NAME_RULES.length; i++) if (NAME_RULES[i][1].test(name)) return NAME_RULES[i][0];
    return null;
  };

  var ORDER = {};
  // tie-break when two categories have the same airtime: the genre rules' priority
  GENRE_RULES.forEach(function (r, i) { ORDER[r[0]] = i; });

  // MIN_SECONDS of categorised airtime before the guide decides a channel's category (an hour);
  // less than that and the name decides, if it says anything.
  B.MIN_SECONDS = 3600;

  // Overnight teleshopping fills many general channels' small hours: it counts a quarter, so only
  // a channel that sells all day is a shopping channel.
  var WEIGHT = { shopping: 0.25 };

  // One category per channel: the one with the most airtime in `tally` ({category: seconds}, what
  // is loaded now plus what earlier sessions saw), else the name's, else null.
  B.pickCategory = function (tally, name) {
    var best = null;
    var bestSec = 0;
    var total = 0;
    Object.keys(tally || {}).forEach(function (k) {
      var s = tally[k] * (WEIGHT[k] || 1);
      if (!(s > 0) || ORDER[k] == null) return;
      total += s;
      if (s > bestSec || (s === bestSec && ORDER[k] < ORDER[best])) {
        best = k;
        bestSec = s;
      }
    });
    if (best && total >= B.MIN_SECONDS) return best;
    return B.categoryOfName(name) || best;
  };

  // The tally saved for next time: what is loaded now plus half of what was saved before, so the
  // category follows the channel over a few days without flipping with the time of day.
  B.blendTally = function (live, prior) {
    var out = {};
    Object.keys(prior || {}).forEach(function (k) { out[k] = Math.round(prior[k] / 2); });
    Object.keys(live || {}).forEach(function (k) { out[k] = (out[k] || 0) + Math.round(live[k]); });
    Object.keys(out).forEach(function (k) { if (out[k] < 60) delete out[k]; });
    return out;
  };

  // ---- Channel families ---------------------------------------------------------------------------
  // A family is a leading word (two when the first is one or two letters: "AL JAZEERA") that 3 or
  // more different channels share once group prefixes ("UK - ") and variant words (HD, +1, EAST…)
  // are dropped. Sub-families: the next word, when 3 or more members share it. Nothing is listed
  // by name: the same rule finds whatever brands a lineup has.

  B.MIN_FAMILY = 3;
  var GROUP = /^([A-Za-z0-9+]{2,6}) ?[-|:] +(.+)$/;
  var TAIL = /(?:\s*(?:\+1|\b(?:HD|FHD|UHD|4K|SD|EAST|WEST|PACIFIC)\b|\([^)]*\)|\[[^\]]*\]|\.))+\s*$/i;
  var TIMESHIFT = /\s?\+1\s*$/;
  var STOP = { CHANNEL: 1, TV: 1, THE: 1, NETWORK: 1 };

  // A title's words: [{w: normalised (upper case), o: as written}], with the group prefix and the
  // variant words dropped and glued numbers split off ("ITV1" -> ITV 1).
  function words(title) {
    var t = String(title || '').trim();
    var m = GROUP.exec(t);
    if (m) t = m[2];
    t = t.replace(TAIL, '');
    var out = [];
    (t.match(/[A-Za-z0-9&!']+/g) || []).forEach(function (w) {
      var split = /^([A-Za-z]{2,})(\d+)$/.exec(w);
      if (split) {
        out.push({ w: split[1].toUpperCase(), o: split[1] });
        out.push({ w: split[2], o: split[2] });
      } else {
        out.push({ w: w.toUpperCase(), o: w });
      }
    });
    return out;
  }

  B.isTimeshift = function (title) { return TIMESHIFT.test(String(title || '')); };

  function isNumber(w) { return /^\d+$/.test(w); }

  // Display casing for an all-capitals word: acronyms stay in capitals (BBC, ITV, ESPN, HBO), other
  // words get a capital first letter (SKY -> Sky, SPORTS -> Sports).
  B.caseWord = function (w) {
    if (/[a-z]/.test(w) || !/[A-Z]/.test(w)) return w;
    if (w.length <= 2) return w;
    var tail = w.slice(1);
    var acronym = w.length <= 3
      ? !/[AEIOU]/.test(w.slice(1, -1)) && !/Y/.test(tail)
      : !/[AEIOUY]/.test(tail);
    return acronym ? w : w.charAt(0) + w.slice(1).toLowerCase();
  };

  function keyOf(ws) {
    if (!ws.length) return null;
    return ws[0].w.length <= 2 && /^[A-Z]+$/.test(ws[0].w) && ws.length > 1 ? ws[0].w + ' ' + ws[1].w : ws[0].w;
  }

  // The label for members sharing their first n words: the most common spelling of those words,
  // cased as a mixed-case title in the family writes them, else by caseWord.
  function labelOf(members, n) {
    var seen = {};
    var best = null;
    members.forEach(function (m) {
      var k = m.ws.slice(0, n).map(function (x) { return x.o.toUpperCase(); }).join(' ');
      seen[k] = (seen[k] || 0) + 1;
      if (!best || seen[k] > seen[best]) best = k;
    });
    for (var i = 0; i < members.length; i++) {
      var o = members[i].ws.slice(0, n).map(function (x) { return x.o; });
      if (o.join(' ').toUpperCase() === best && /[a-z]/.test(o.join(''))) return o.join(' ');
    }
    return best.split(' ').map(B.caseWord).join(' ');
  }

  // The number of leading words every member shares (numbers don't count: ITV 1 / ITV 2 share ITV).
  function sharedWords(members) {
    var n = 0;
    for (;;) {
      var w = null;
      for (var i = 0; i < members.length; i++) {
        var x = members[i].ws[n];
        if (!x || isNumber(x.w) || (w != null && x.w !== w)) return n;
        w = x.w;
      }
      n++;
    }
  }

  function distinctNames(members) {
    var seen = {};
    var n = 0;
    members.forEach(function (m) {
      if (!seen[m.name]) {
        seen[m.name] = true;
        n++;
      }
    });
    return n;
  }

  // channels: [{identifier, title}]. Returns {list: [{key, label, ids, subs: [{key, label, ids}]}]
  // (largest first), of: {identifier: [familyKey, subKey|null]}}.
  B.families = function (channels, min) {
    min = min || B.MIN_FAMILY;
    var parsed = (channels || []).map(function (c) { return { id: c.identifier, ws: words(c.title) }; });
    // a plural counts as its singular when both are in the lineup (SPORTS = SPORT)
    var vocab = {};
    parsed.forEach(function (p) { p.ws.forEach(function (x) { vocab[x.w] = true; }); });
    parsed.forEach(function (p) {
      p.ws.forEach(function (x) {
        if (x.w.length >= 5 && x.w.charAt(x.w.length - 1) === 'S' && vocab[x.w.slice(0, -1)]) x.w = x.w.slice(0, -1);
      });
      while (p.ws.length && STOP[p.ws[0].w]) p.ws.shift();
      p.name = p.ws.map(function (x) { return x.w; }).join(' ');
    });
    var groups = {};
    var keys = [];
    parsed.forEach(function (p) {
      var k = keyOf(p.ws);
      if (!k) return;
      if (!groups[k]) {
        groups[k] = [];
        keys.push(k);
      }
      groups[k].push(p);
    });
    var list = [];
    var of = {};
    keys.forEach(function (k) {
      var members = groups[k];
      if (distinctNames(members) < min) return;
      var n = Math.max(1, sharedWords(members));
      var key = members[0].ws.slice(0, n).map(function (x) { return x.w; }).join(' ');
      var fam = { key: key, label: labelOf(members, n), ids: members.map(function (m) { return m.id; }), subs: [] };
      var subs = {};
      var subKeys = [];
      members.forEach(function (m) {
        of[m.id] = [key, null];
        var x = m.ws[n];
        if (!x || isNumber(x.w)) return;
        if (!subs[x.w]) {
          subs[x.w] = [];
          subKeys.push(x.w);
        }
        subs[x.w].push(m);
      });
      subKeys.forEach(function (w) {
        var sm = subs[w];
        // a sub-family that is the whole family says nothing new
        if (distinctNames(sm) < min || sm.length === members.length) return;
        var sn = n + Math.max(1, sharedWords(sm.map(function (m) { return { ws: m.ws.slice(n) }; })));
        var skey = sm[0].ws.slice(0, sn).map(function (x) { return x.w; }).join(' ');
        fam.subs.push({ key: skey, label: labelOf(sm, sn), ids: sm.map(function (m) { return m.id; }) });
        sm.forEach(function (m) { of[m.id] = [key, skey]; });
      });
      fam.subs.sort(bySize);
      list.push(fam);
    });
    list.sort(bySize);
    return { list: list, of: of };
  };

  function bySize(a, b) {
    return b.ids.length - a.ids.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  }

  // Channels the guide and the name say nothing about borrow a category from their relatives: a +1
  // from its channel, else a family member from its sub-family (or family) when 2+ categorised
  // members agree on it and they are at least 60% of those categorised. cat ({id: category}) is
  // filled in place; returns the number of channels that gained one.
  B.inherit = function (cat, channels, fams) {
    var base = {};
    channels.forEach(function (c) { if (!B.isTimeshift(c.title)) base[plainName(c.title)] = c.identifier; });
    var gained = 0;
    channels.forEach(function (c) {
      if (cat[c.identifier] || !B.isTimeshift(c.title)) return;
      var b = base[plainName(c.title.replace(TIMESHIFT, ''))];
      if (b && cat[b]) {
        cat[c.identifier] = cat[b];
        gained++;
      }
    });
    var groups = {};
    (fams.list || []).forEach(function (f) {
      groups[f.key] = f.ids;
      f.subs.forEach(function (s) { groups[s.key] = s.ids; });
    });
    var verdict = {};
    var decide = function (key) {
      if (verdict[key] !== undefined) return verdict[key];
      var n = {};
      var known = 0;
      (groups[key] || []).forEach(function (id) {
        var k = cat[id];
        if (!k) return;
        n[k] = (n[k] || 0) + 1;
        known++;
      });
      var best = null;
      Object.keys(n).forEach(function (k) { if (!best || n[k] > n[best]) best = k; });
      verdict[key] = best && n[best] >= 2 && n[best] >= known * 0.6 ? best : null;
      return verdict[key];
    };
    channels.forEach(function (c) {
      var f = fams.of && fams.of[c.identifier];
      if (cat[c.identifier] || !f) return;
      var k = (f[1] && decide(f[1])) || decide(f[0]);
      if (k) {
        cat[c.identifier] = k;
        gained++;
      }
    });
    return gained;
  };

  function plainName(title) {
    var t = String(title || '').trim();
    var m = GROUP.exec(t);
    return (m ? m[2] : t).replace(TIMESHIFT, '').trim().toUpperCase();
  }

  // ---- The filter ---------------------------------------------------------------------------------
  // A choice is a key: 'fav', 'all', 'now' (the On now wall), 'c:<category>' or 'f:<family key>'.
  // The guide's filter is {base, refine}: a rail choice plus, from the chips, the other dimension
  // (a category's family, or a family's category), or refine null.
  //
  // ctx (built by the data module): {fav: {id: true}, cat: {id: category}, fam: {id: [key, sub]},
  // onNow: {id: true}, families: [...] (B.families().list)}

  B.matches = function (key, c, ctx) {
    var id = c.identifier;
    if (!key || key === 'all') return true;
    if (key === 'fav') return !!ctx.fav[id];
    if (key === 'now') return !!ctx.onNow[id];
    if (key.indexOf('c:') === 0) return ctx.cat[id] === key.slice(2);
    if (key.indexOf('f:') === 0) {
      var f = ctx.fam[id];
      return !!f && (f[0] === key.slice(2) || f[1] === key.slice(2));
    }
    return false;
  };

  B.filter = function (channels, sel, ctx) {
    sel = sel || { base: 'all' };
    return channels.filter(function (c) {
      return B.matches(sel.base, c, ctx) && (!sel.refine || B.matches(sel.refine, c, ctx));
    });
  };

  function findFamily(ctx, key) {
    var list = ctx.families || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i];
      for (var j = 0; j < list[i].subs.length; j++) if (list[i].subs[j].key === key) return list[i].subs[j];
    }
    return null;
  }

  // A choice's name: "Favourites", "All channels", "On now", "Sport", "Sky Sports".
  B.label = function (key, ctx) {
    if (!key || key === 'all') return 'All channels';
    if (key === 'fav') return 'Favourites';
    if (key === 'now') return 'On now';
    if (key.indexOf('c:') === 0) return LABEL[key.slice(2)] || key.slice(2);
    var f = key.indexOf('f:') === 0 ? findFamily(ctx || {}, key.slice(2)) : null;
    return f ? f.label : key.slice(2);
  };

  // "Movies › Sky Cinema"
  B.selLabel = function (sel, ctx) {
    if (!sel) return 'All channels';
    return B.label(sel.base, ctx) + (sel.refine ? ' › ' + B.label(sel.refine, ctx) : '');
  };

  // True when the choice still exists (a family can vanish when the lineup changes).
  B.valid = function (key, ctx) {
    if (!key) return false;
    if (key === 'all' || key === 'fav' || key === 'now') return true;
    if (key.indexOf('c:') === 0) return !!LABEL[key.slice(2)];
    if (key.indexOf('f:') === 0) return !!findFamily(ctx, key.slice(2));
    return false;
  };

  // The rail: [{key, label, count, kind: 'pick' | 'head', sub: bool}]. Empty choices are left out
  // (All channels always stays).
  B.railEntries = function (channels, ctx) {
    var out = [];
    var favs = 0;
    var now = 0;
    var cats = {};
    channels.forEach(function (c) {
      var id = c.identifier;
      if (ctx.fav[id]) favs++;
      if (ctx.onNow[id]) now++;
      var k = ctx.cat[id];
      if (k) cats[k] = (cats[k] || 0) + 1;
    });
    if (favs) out.push({ key: 'fav', label: 'Favourites', count: favs, kind: 'pick' });
    out.push({ key: 'all', label: 'All channels', count: channels.length, kind: 'pick' });
    if (now) out.push({ key: 'now', label: 'On now', count: now, kind: 'pick' });
    var catList = B.CATEGORIES.filter(function (c) { return cats[c.id]; });
    if (catList.length) {
      out.push({ key: 'h:categories', label: 'Categories', kind: 'head' });
      catList.forEach(function (c) { out.push({ key: 'c:' + c.id, label: c.label, count: cats[c.id], kind: 'pick' }); });
    }
    var fams = ctx.families || [];
    if (fams.length) {
      out.push({ key: 'h:families', label: 'Channel families', kind: 'head' });
      fams.forEach(function (f) {
        out.push({ key: 'f:' + f.key, label: f.label, count: f.ids.length, kind: 'pick' });
        f.subs.forEach(function (s) { out.push({ key: 'f:' + s.key, label: s.label, count: s.ids.length, kind: 'pick', sub: true }); });
      });
    }
    return out;
  };

  // The chips under a rail choice: the other dimension. A category -> the families of its channels
  // (the sub-family when a channel has one); a family -> its channels' categories; All channels and
  // Favourites -> categories. [{key, label, count}], largest first (categories in rail order);
  // a refinement must hold 2+ channels and fewer than the whole choice.
  B.chips = function (base, channels, ctx) {
    var inBase = channels.filter(function (c) { return B.matches(base, c, ctx); });
    var counts = {};
    var order = [];
    var byFamily = base.indexOf('c:') === 0;
    inBase.forEach(function (c) {
      var k = null;
      if (byFamily) {
        var f = ctx.fam[c.identifier];
        if (f) k = 'f:' + (f[1] || f[0]);
      } else if (base !== 'now') {
        var cat = ctx.cat[c.identifier];
        if (cat) k = 'c:' + cat;
      }
      if (!k) return;
      if (!counts[k]) order.push(k);
      counts[k] = (counts[k] || 0) + 1;
    });
    var out = order.filter(function (k) { return counts[k] >= 2 && counts[k] < inBase.length; }).map(function (k) {
      return { key: k, label: B.label(k, ctx), count: counts[k] };
    });
    var rank = {};
    B.CATEGORIES.forEach(function (c, i) { rank['c:' + c.id] = i; });
    out.sort(function (a, b) {
      if (!byFamily) return rank[a.key] - rank[b.key];
      return b.count - a.count || (a.label < b.label ? -1 : 1);
    });
    return out;
  };

  // The "no refinement" chip: "All channels" / "All favourites" / "All sport" / "All Sky".
  B.allLabel = function (base, ctx) {
    if (!base || base === 'all') return 'All channels';
    if (base === 'fav') return 'All favourites';
    if (base.indexOf('c:') === 0) return 'All ' + B.label(base, ctx).toLowerCase();
    return 'All ' + B.label(base, ctx);
  };

  // Turns a stored filter into one that still works: unknown choices fall back to All.
  B.normalise = function (sel, ctx) {
    var base = sel && B.valid(sel.base, ctx) ? sel.base : 'all';
    var refine = sel && sel.refine && base !== 'now' && B.valid(sel.refine, ctx) ? sel.refine : null;
    return { base: base, refine: refine };
  };

  // Live TV v2 stored a filter name; this maps it onto a Browse choice.
  B.fromLegacy = function (v) {
    return { all: 'all', favourites: 'fav', movies: 'c:movies', sports: 'c:sport', news: 'c:news' }[v] || 'all';
  };

  // ---- On now wall --------------------------------------------------------------------------------
  // Shelves of what is on now: Favourites first, then each category in rail order. A programme sits
  // under its own category (a film on an entertainment channel is under Movies), else its channel's.
  // items: [{channel, airing, cat}] for channels with something on now, in channel order.
  // Returns [{key, label, items}] without empty shelves.
  B.shelves = function (items, ctx) {
    var out = [];
    var favs = items.filter(function (x) { return ctx.fav[x.channel.identifier]; });
    if (favs.length) out.push({ key: 'fav', label: 'Favourites', items: favs });
    var by = {};
    items.forEach(function (x) {
      var k = x.cat || ctx.cat[x.channel.identifier];
      if (!k) return;
      (by[k] = by[k] || []).push(x);
    });
    B.CATEGORIES.forEach(function (c) {
      if (by[c.id]) out.push({ key: 'c:' + c.id, label: c.label, items: by[c.id] });
    });
    return out;
  };
})();
