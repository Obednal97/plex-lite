// A title's page on a phone or tablet (board P2): full-bleed art under a glass Back chevron and a
// "…", the title (its clearLogo or text), the meta line and badges, a white Play / Resume button with
// the progress under it, round actions (From start, Shuffle, Trailer, Watched, Audio & subs), the
// synopsis clamped to three lines, then the lists: a show's or season's episodes (a season picker and
// rows), an episode's season, More Like This, Cast & crew, Extras. Tablets put the poster beside the
// text under a wide hero. The data logic follows the TV's js/screens/details.js.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

// ---- Pure decisions (test/touch-details.test.mjs runs these in Node) ---------------------------------

(() => {
  const PL = window.PL = window.PL || {};

  const watched = (it) => (it.type === 'show' || it.type === 'season'
    ? it.leafCount > 0 && it.viewedLeafCount === it.leafCount
    : it.viewCount > 0 && !it.viewOffset);

  // "1h 42m" / "24m" (as PL.fmt.duration)
  const duration = (ms) => {
    if (!ms) return '';
    const m = Math.round(ms / 60000);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  };
  const clock = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    const two = (n) => (n < 10 ? '0' : '') + n;
    return hh ? hh + ':' + two(mm) + ':' + two(ss) : mm + ':' + two(ss);
  };
  const episodeCode = (it) => {
    if (it.parentIndex == null || it.index == null) return '';
    if (it.parentIndex === 0) return 'Special ' + it.index;
    return 'S' + it.parentIndex + ' · E' + it.index;
  };

  // The Play button: {label, resume, frac, left}. target: what it plays; type: the page's type.
  function playButton(target, type) {
    if (!target) return null;
    const resume = target.viewOffset > 0;
    let label;
    if (type === 'show' || type === 'season') label = (resume ? 'Resume ' : 'Play ') + episodeCode(target);
    else label = resume ? 'Resume from ' + clock(target.viewOffset / 1000) : 'Play';
    const frac = resume && target.duration ? Math.min(1, target.viewOffset / target.duration) : 0;
    const left = resume && target.duration ? duration(target.duration - target.viewOffset) + ' left' : '';
    return { label: label.trim(), resume, frac, left };
  }

  // A season's next episode: the one in progress, else the first not watched, else the first.
  function nextInSeason(eps) {
    const list = eps || [];
    return list.filter((e) => e.viewOffset > 0)[0] || list.filter((e) => !watched(e))[0] || list[0] || null;
  }

  // The season to open on: the one asked for (a season page), else the On Deck episode's, else the first.
  function seasonIndex(seasons, wantKey, deck) {
    let idx = 0;
    (seasons || []).forEach((s, i) => {
      if (wantKey ? String(s.ratingKey) === String(wantKey) : deck && String(s.ratingKey) === String(deck.parentRatingKey)) idx = i;
    });
    return idx;
  }

  // The trailer: the primary extra, else the first trailer (films and shows only).
  function trailer(full, extras) {
    if (!full || (full.type !== 'movie' && full.type !== 'show')) return null;
    const list = extras || [];
    const main = full.primaryExtraKey && list.filter((e) => e.key === full.primaryExtraKey)[0];
    return main || list.filter((e) => e.subtype === 'trailer')[0] || null;
  }

  // Watched choices for the Watched action: one runs at once, several open a sheet (as on the TV).
  // subject: the film, episode, show or season; season: a show page's selected season.
  // -> [{id: 'watched' | 'unwatched' | 'season', label, on}]
  function watchedChoices(subject, season) {
    const w = watched(subject);
    const partial = !w && (subject.viewOffset > 0 || (subject.viewedLeafCount > 0 && subject.viewedLeafCount < subject.leafCount));
    const noun = subject.type === 'show' ? 'show ' : subject.type === 'season' ? 'season ' : '';
    const out = [];
    if (!w) out.push({ id: 'watched', label: 'Mark ' + noun + 'watched', on: true });
    if (w || partial) out.push({ id: 'unwatched', label: 'Mark ' + noun + 'unwatched', on: false });
    if (subject.type === 'show' && season) {
      const sw = watched(Object.assign({}, season, { type: 'season' }));
      out.push({ id: 'season', label: 'Mark ' + (season.title || 'season') + (sw ? ' unwatched' : ' watched'), on: !sw });
    }
    return out;
  }

  // The round actions under Play, in order. ctx: {type, target, trailer, tracks, shuffle}
  // -> ['restart', 'shuffle', 'trailer', 'watched', 'tracks']
  function actions(ctx) {
    const out = [];
    if (ctx.target && ctx.target.viewOffset > 0) out.push('restart');
    if (ctx.type === 'show') out.push('shuffle');
    if (ctx.trailer) out.push('trailer');
    out.push('watched');
    if ((ctx.type === 'movie' || ctx.type === 'episode') && ctx.tracks) out.push('tracks');
    return out;
  }

  // Whether Audio & subs has anything to offer: several versions, or audio or subtitle tracks.
  function hasTracks(full) {
    const media = (full && full.Media) || [];
    if (media.length > 1) return true;
    const part = media[0] && media[0].Part && media[0].Part[0];
    return !!(part && (part.Stream || []).some((s) => s.streamType === 2 || s.streamType === 3));
  }

  // Cast first, then directors and writers, as person tags {id, tag, role, thumb, filter}.
  const MAX_CAST = 30;
  function people(full) {
    const out = [];
    ((full && full.Role) || []).slice(0, MAX_CAST).forEach((r) => out.push({ id: r.id, tag: r.tag, role: r.role || '', thumb: r.thumb, filter: 'actor' }));
    ((full && full.Director) || []).forEach((d) => out.push({ id: d.id, tag: d.tag, role: 'Director', thumb: d.thumb, filter: 'director' }));
    ((full && full.Writer) || []).slice(0, 3).forEach((w) => out.push({ id: w.id, tag: w.tag, role: 'Writer', thumb: w.thumb, filter: 'writer' }));
    return out.filter((p) => p.id != null && p.tag);
  }

  // Which library filter lists a person's titles: their own (Plex's tags carry "actor=35"), else
  // from their role on the page they came from. -> 'actor' | 'director' | 'writer'
  function personFilter(p) {
    const f = String((p && p.filter) || '');
    const m = /^(actor|director|writer)\b/.exec(f);
    if (m) return m[1];
    const role = String((p && p.role) || '');
    if (role === 'Director') return 'director';
    if (role === 'Writer') return 'writer';
    return 'actor';
  }

  // A person's id: the tag's own, else the number in its filter ("actor=35").
  function personId(p) {
    if (!p) return null;
    if (p.id != null && p.id !== '') return p.id;
    const m = /=(\d+)/.exec(String(p.filter || ''));
    return m ? Number(m[1]) : null;
  }

  // "15 movies · 1 show" from [{section: {type}, items}]
  function personSummary(results) {
    return (results || []).filter((r) => r.items.length).map((r) => {
      const n = r.items.length;
      const noun = r.section.type === 'show' ? (n === 1 ? 'show' : 'shows') : (n === 1 ? 'movie' : 'movies');
      return n + ' ' + noun;
    }).join(' · ');
  }

  const EXTRA = {
    trailer: 'Trailer', behindTheScenes: 'Behind the scenes', deletedScene: 'Deleted scene', interview: 'Interview',
    featurette: 'Featurette', sceneOrSample: 'Scene', short: 'Short',
  };
  const extraLabel = (x) => [EXTRA[x.subtype] || 'Extra', duration(x.duration)].filter(Boolean).join(' · ');

  // "1080p · VP9 · 0.4 GB · 4.2 Mbps"
  function versionLabel(media) {
    const bits = [];
    const res = String(media.videoResolution || '');
    if (res) bits.push(/^\d+$/.test(res) ? res + 'p' : res.toUpperCase());
    if (media.videoCodec) bits.push(String(media.videoCodec).toUpperCase());
    const part = media.Part && media.Part[0];
    if (part && part.size) bits.push((part.size / 1073741824).toFixed(1) + ' GB');
    if (media.bitrate) bits.push((media.bitrate / 1000).toFixed(1) + ' Mbps');
    return bits.join(' · ') || 'Version';
  }

  // Rating[] entries {image: 'imdb://image.rating', value, type} -> "IMDb 7.5", "RT 91%"
  function ratings(item) {
    return ((item && item.Rating) || []).map((r) => {
      const img = r.image || '';
      const v = Number(r.value);
      if (!v) return null;
      if (img.indexOf('imdb://') === 0) return 'IMDb ' + v.toFixed(1);
      if (img.indexOf('rottentomatoes://') === 0) return (r.type === 'critic' ? 'RT ' : 'RT Audience ') + Math.round(v * 10) + '%';
      if (img.indexOf('themoviedb://') === 0) return 'TMDb ' + Math.round(v * 10) + '%';
      return null;
    }).filter(Boolean);
  }

  // An episode row's title: "1. Pilot" (no number when Plex has none)
  const episodeTitle = (ep) => (ep.index != null ? ep.index + '. ' : '') + (ep.title || '');
  // ... and its second line: "11m left" while in progress, else its length
  const episodeSub = (ep) => (ep.viewOffset > 0 && ep.duration ? duration(ep.duration - ep.viewOffset) + ' left' : duration(ep.duration));

  PL.touchDetailsLogic = {
    playButton, nextInSeason, seasonIndex, trailer, watchedChoices, actions, hasTracks, people, personFilter,
    personId, personSummary, extraLabel, versionLabel, ratings, episodeTitle, episodeSub, isWatched: watched,
  };
})();

// ---- The page ----------------------------------------------------------------------------------------

(() => {
  if (!window.PL || !window.PL.isWeb || !PL.touch || !PL.touch.ui) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const P = PL.ui;
  const D = PL.touchDetailsLogic;
  const TYPES = ['movie', 'show', 'season', 'episode'];

  // ui.img, but an image the browser already has shows at once (no fade on a refresh)
  const img = (src, cls, eager) => {
    const n = ui.img(src, cls, eager);
    if (src && n.complete && n.naturalWidth) n.classList.add('t-in');
    return n;
  };

  const fetchFull = (ratingKey) => PL.plex.get('/library/metadata/' + ratingKey, { includeOnDeck: 1, includeExtras: 1, checkFiles: 0 }).then((mc) => {
    const it = (mc.Metadata || [])[0];
    if (!it) throw new Error('This item is no longer on the server');
    return it;
  });
  const related = (ratingKey) => PL.plex.get('/library/metadata/' + ratingKey + '/related', { count: 20 })
    .then((mc) => (mc.Hub || []).filter(PL.plex.isVideoHub)[0] || null, () => null);

  // Badge texts from the shared helper (HD, 4K, HDR, 5.1, rating, CC), plus review scores.
  const badgeTexts = (item) => Array.from(P.badges(item).children).map((n) => n.textContent).filter(Boolean);

  T.screens.details = (item) => {
    if (!item || TYPES.indexOf(item.type) < 0) return T.stagePage(() => PL.screens.details(item));
    return detailsPage(item);
  };

  function detailsPage(item) {
    const page = T.page('t-det.t-det-' + item.type);
    // st.full: the film or episode, or the show (show and season pages)
    const st = {
      type: item.type, full: null, seasons: null, seasonIdx: 0, eps: {}, onDeck: null, extras: [], cast: [],
      related: null, siblings: null, mediaIndex: 0, plugins: [], alive: true, loaded: false, busy: false, gen: 0,
      wantSeason: item.type === 'season' ? item.ratingKey : null,
    };

    const bar = ui.backBar({ title: barTitle(item), more: () => openMenu() });
    const hero = h('div.t-det-hero');
    const heroImg = h('div.t-det-art');
    hero.appendChild(heroImg);
    hero.appendChild(h('div.t-det-shade'));
    const body = h('div.t-det-body');
    const side = h('div.t-det-side');
    const main = h('div.t-det-main');
    body.appendChild(side);
    body.appendChild(main);
    const lists = h('div.t-det-lists');
    const status = h('div.t-det-status', null, ui.spinner());
    page.el.appendChild(bar);
    page.el.appendChild(hero);
    page.el.appendChild(body);
    page.el.appendChild(status);
    page.el.appendChild(lists);

    // ---- Art and the title block --------------------------------------------------------------------

    let artPath = null;
    function setArt(it) {
      const path = it.type === 'episode' ? (it.thumb || P.artPath(it)) : P.artPath(it);
      if (!path || path === artPath) return;
      artPath = path;
      const w = Math.min(1000, Math.max(window.innerWidth, 640));
      heroImg.replaceChildren(img(ui.imageUrl(path, w, (w * 9) / 16, { quality: 80 }), null, true));
    }

    function setPoster(it) {
      const path = P.posterPath(it);
      side.replaceChildren();
      if (!path) return;
      const frame = h('div.t-det-poster', null, img(ui.imageUrl(path, 240, 360), null, true));
      side.appendChild(frame);
    }

    // What the "…" acts on and Watched marks: the season on a season page, else the page's title.
    const subject = () => (st.type === 'season' && st.seasons ? st.seasons[st.seasonIdx] : st.full);

    function head(it) {
      const box = h('div.t-det-head');
      box.appendChild(ui.titleArt(it, 't-det-title'));
      if (st.type === 'episode') {
        box.appendChild(h('div.t-det-subtitle', { text: [PL.fmt.episode(it), it.title].filter(Boolean).join(' · ') }));
      } else if (st.type === 'season' && st.seasons) {
        const s = st.seasons[st.seasonIdx];
        if (s) box.appendChild(h('div.t-det-subtitle', { text: s.title || '' }));
      }
      const meta = h('div.t-det-meta');
      const line = P.metaLine(it, { skipEpisode: true });
      if (line) meta.appendChild(h('span.t-det-metatext', { text: line }));
      const badges = h('span.t-det-badges');
      badgeTexts(it).concat(D.ratings(it)).forEach((b) => badges.appendChild(h('span.t-badge', { text: b })));
      meta.appendChild(badges);
      box.appendChild(meta);
      st.badges = badges;
      return box;
    }

    // ---- Play and the round actions ---------------------------------------------------------------------

    function playTarget() {
      const f = st.full;
      if (!f) return null;
      if (f.type === 'movie' || f.type === 'episode') return f;
      if (st.type === 'season') return D.nextInSeason(currentEps());
      if (st.onDeck) return st.onDeck;
      const first = st.seasons && st.seasons[0] && st.eps[st.seasons[0].ratingKey];
      return (first && first[0]) || D.nextInSeason(currentEps());
    }

    function play(it, offset, queue) {
      const opts = { offset: offset || 0 };
      if (st.mediaIndex && it === st.full) opts.mediaIndex = st.mediaIndex;
      if (queue) opts.queue = queue;
      st.played = true;
      T.play(it, opts);
    }

    function playBlock() {
      const box = h('div.t-det-play');
      const target = playTarget();
      const pb = D.playButton(target, st.type);
      if (!pb) return box;
      box.appendChild(ui.button({ kind: 'primary', icon: 'play', label: pb.label, action: () => play(target, pb.resume ? target.viewOffset : 0) }));
      if (pb.resume) {
        const prog = h('div.t-det-progress');
        const track = h('div.t-det-track', null, ui.progress(pb.frac));
        prog.appendChild(track);
        if (pb.left) prog.appendChild(h('span.t-det-left', { text: pb.left }));
        box.appendChild(prog);
      }
      return box;
    }

    function actionsRow() {
      const row = h('div.t-det-actions');
      const f = st.full;
      const target = playTarget();
      const tr = D.trailer(f, st.extras);
      const ids = D.actions({ type: st.type, target, trailer: tr, tracks: D.hasTracks(f) });
      const sub = subject();
      const btns = {
        restart: () => ui.button({ kind: 'action', icon: 'restart', label: 'From start', action: () => play(target, 0) }),
        shuffle: () => ui.button({ kind: 'action', icon: 'shuffle', label: 'Shuffle', action: shuffle }),
        trailer: () => ui.button({ kind: 'action', icon: 'trailer', label: 'Trailer', action: () => T.play(tr, { offset: 0 }) }),
        watched: () => {
          const b = ui.button({ kind: 'action', icon: 'check', label: 'Watched', action: () => watchedAction() });
          const on = D.isWatched(sub);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
          return b;
        },
        tracks: () => ui.button({ kind: 'action', icon: 'cc', label: 'Audio & subs', action: tracksSheet }),
      };
      ids.forEach((id) => row.appendChild(btns[id]()));
      // plugin actions (e.g. Overseerr's "Report a problem") join the row while it has room (four
      // across a phone, as P2; a fifth would cut the labels short); the "…" menu always lists them
      const room = (document.documentElement.classList.contains('t-phone') ? 4 : 7) - ids.length;
      st.plugins.slice(0, Math.max(0, room)).forEach((a) => {
        row.appendChild(ui.button({ kind: 'action', icon: 'sparkle', label: a.label, action: () => a.run() }));
      });
      row.classList.toggle('t-det-actions-many', row.children.length > 4);
      return row;
    }

    function watchedAction() {
      const sub = subject();
      const season = st.type === 'show' && st.seasons ? st.seasons[st.seasonIdx] : null;
      const choices = D.watchedChoices(sub, season);
      const run = (c) => {
        const key = c.id === 'season' ? season.ratingKey : sub.ratingKey;
        PL.plex.setWatched(key, c.on).then(() => {
          T.toast(c.id === 'season' ? season.title + (c.on ? ' marked as watched' : ' marked as unwatched') : (c.on ? 'Marked as watched' : 'Marked as unwatched'));
          reload();
        }, (err) => T.toast(PL.errorMessage(err)));
      };
      if (choices.length === 1) return run(choices[0]);
      T.sheet({ title: 'Watched status', rows: choices.map((c) => ({ label: c.label, icon: c.on ? 'check' : 'close', action: () => run(c) })) });
    }

    // Audio, subtitles and (with several files) the version: Plex remembers the choice per file.
    function tracksSheet() {
      const f = st.full;
      const media = f.Media || [];
      const sections = [];
      if (media.length > 1) {
        sections.push({
          heading: 'Version',
          rows: media.map((m, i) => ({
            label: D.versionLabel(m), checked: i === st.mediaIndex,
            action: () => { st.mediaIndex = i; T.toast('Plays ' + D.versionLabel(m)); },
          })),
        });
      }
      const m = media[st.mediaIndex] || media[0];
      const part = m && m.Part && m.Part[0];
      const streams = (part && part.Stream) || [];
      const audio = streams.filter((s) => s.streamType === 2);
      const subs = streams.filter((s) => s.streamType === 3);
      const label = (s) => s.displayTitle || s.extendedDisplayTitle || s.language || 'Track ' + s.index;
      const pick = (choice, apply) => () => PL.plex.selectStreams(part.id, choice).then(apply, (err) => T.toast(PL.errorMessage(err)));
      if (audio.length) {
        sections.push({
          heading: 'Audio',
          rows: audio.map((s) => ({ label: label(s), checked: !!s.selected, action: pick({ audioStreamID: s.id }, () => audio.forEach((a) => { a.selected = a === s; })) })),
        });
      }
      if (part) {
        const rows = [{ label: 'Off', checked: !subs.some((s) => s.selected), action: pick({ subtitleStreamID: 0 }, () => subs.forEach((x) => { x.selected = false; })) }];
        subs.forEach((s) => rows.push({
          label: label(s), sub: s.forced ? 'Forced' : (s.title || ''), checked: !!s.selected,
          action: pick({ subtitleStreamID: s.id }, () => subs.forEach((x) => { x.selected = x === s; })),
        }));
        sections.push({ heading: 'Subtitles', rows });
      }
      if (!sections.length) return T.toast('No audio or subtitle options for this title');
      T.sheet({ title: 'Audio & subtitles', sub: P.itemTitle(f) || '', sections, cls: 't-det-tracks' });
    }

    // A shuffled play queue of the whole show (as on the TV): the player gets the queue.
    function shuffle() {
      const f = st.full;
      if (st.shuffling) return;
      st.shuffling = true;
      PL.plex.request('POST', '/playQueues', {
        type: 'video', uri: 'server://' + PL.plex.server.machineId + '/com.plexapp.plugins.library/library/metadata/' + f.ratingKey,
        shuffle: 1, continuous: 0, own: 1,
      }).then((mc) => {
        const items = (mc && mc.Metadata) || [];
        if (!items.length) throw new Error('Nothing to shuffle');
        if (!(mc.playQueueTotalCount > items.length)) return mc;
        return PL.plex.get('/playQueues/' + mc.playQueueID, { window: 200, center: mc.playQueueSelectedItemID, own: 1 })
          .then((all) => (all && all.Metadata && all.Metadata.length ? all : mc), () => mc);
      }).then((mc) => {
        st.shuffling = false;
        if (!st.alive || T.top() !== page) return;
        let index = 0;
        mc.Metadata.forEach((it, i) => { if (it.playQueueItemID === mc.playQueueSelectedItemID) index = i; });
        play(mc.Metadata[index], 0, { items: mc.Metadata, index, id: mc.playQueueID });
      }).catch((err) => {
        st.shuffling = false;
        if (st.alive) T.toast(PL.errorMessage(err));
      });
    }

    function openMenu() {
      const sub = subject() || item;
      T.menu(sub, () => reload(), { onDetails: true });
    }

    // ---- The synopsis: three lines, "More" opens it ------------------------------------------------------

    function synopsis(text) {
      const box = h('div.t-det-sum');
      const p = h('p.t-det-sumtext', { text });
      const more = h('button.t-det-more', { type: 'button', text: 'More', hidden: true });
      more.addEventListener('click', () => {
        const open = box.classList.toggle('t-open');
        more.textContent = open ? 'Less' : 'More';
      });
      box.appendChild(p);
      box.appendChild(more);
      box.measure = () => {
        if (box.classList.contains('t-open')) return;
        more.hidden = !(p.scrollHeight > p.clientHeight + 2);
      };
      return box;
    }

    // ---- Episodes: a season picker and rows -------------------------------------------------------------

    const currentEps = () => (st.seasons && st.seasons[st.seasonIdx] ? st.eps[st.seasons[st.seasonIdx].ratingKey] || [] : []);

    function episodesFor(season) {
      if (st.eps[season.ratingKey]) return Promise.resolve(st.eps[season.ratingKey]);
      return PL.plex.children(season.ratingKey).then((eps) => { st.eps[season.ratingKey] = eps; return eps; });
    }

    function episodeRow(ep) {
      const row = h('div.t-ep', { role: 'button', tabIndex: 0, 'aria-label': D.episodeTitle(ep) });
      const thumb = h('span.t-ep-thumb', null, img(ui.imageUrl(ep.thumb || P.widePath(ep), 160, 90)));
      const pr = P.progress(ep);
      if (pr > 0) thumb.appendChild(ui.progress(pr));
      else if (P.isWatched(ep)) thumb.appendChild(h('span.t-watched', null, ui.icon('check')));
      row.appendChild(thumb);
      const text = h('span.t-ep-text');
      text.appendChild(h('span.t-ep-title', { text: D.episodeTitle(ep) }));
      const sub = D.episodeSub(ep);
      if (sub) text.appendChild(h('span.t-ep-sub', { text: sub }));
      row.appendChild(text);
      const playBtn = ui.button({ kind: 'round', icon: 'play', label: (ep.viewOffset > 0 ? 'Resume ' : 'Play ') + D.episodeTitle(ep), action: () => play(ep, ep.viewOffset || 0) });
      playBtn.classList.add('t-ep-play');
      row.appendChild(playBtn);
      if (ep.summary) row.appendChild(h('span.t-ep-sum', { text: ep.summary }));
      row.addEventListener('click', () => T.open(ep));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) T.open(ep); });
      ui.onHold(row, () => T.menu(ep, () => reload()));
      return row;
    }

    function episodesSection() {
      const sec = h('section.t-det-eps');
      const headRow = h('div.t-det-epshead');
      const season = st.seasons[st.seasonIdx];
      if (st.seasons.length > 1) {
        const pickBtn = h('button.t-btn.t-btn-glass.t-det-seasonpick', { type: 'button', 'aria-haspopup': 'dialog' },
          [h('span.t-btn-label', { text: season.title || 'Season' }), ui.icon('down')]);
        pickBtn.addEventListener('click', pickSeason);
        headRow.appendChild(pickBtn);
      } else {
        headRow.appendChild(h('h2.t-shelf-title', { text: season.title || 'Episodes' }));
      }
      const eps = currentEps();
      headRow.appendChild(h('span.t-det-epcount', { text: eps.length ? eps.length + (eps.length === 1 ? ' episode' : ' episodes') : '' }));
      sec.appendChild(headRow);
      const list = h('div.t-ep-list');
      eps.forEach((ep) => list.appendChild(episodeRow(ep)));
      if (!eps.length) list.appendChild(ui.empty('No episodes in this season'));
      sec.appendChild(list);
      return sec;
    }

    function pickSeason() {
      T.sheet({
        title: P.itemTitle(st.full) || 'Seasons',
        rows: st.seasons.map((s, i) => ({
          label: s.title || 'Season ' + s.index,
          sub: [s.leafCount ? s.leafCount + (s.leafCount === 1 ? ' episode' : ' episodes') : '', s.viewedLeafCount ? s.viewedLeafCount + ' watched' : ''].filter(Boolean).join(' · '),
          checked: i === st.seasonIdx,
          action: () => selectSeason(i),
        })),
      });
    }

    function selectSeason(i) {
      if (i === st.seasonIdx) return;
      st.seasonIdx = i;
      const season = st.seasons[i];
      const done = () => {
        if (!st.alive || st.seasonIdx !== i) return;
        // a season page follows the picked season (its Play, Watched and subtitle)
        if (st.type === 'season') render();
        else if (st.epSection) {
          const next = episodesSection();
          st.epSection.replaceWith(next);
          st.epSection = next;
          // Watched's choices name the season
          const row = actionsRow();
          st.actions.replaceWith(row);
          st.actions = row;
        }
      };
      if (st.eps[season.ratingKey]) return done();
      if (st.epSection) st.epSection.classList.add('t-loading');
      episodesFor(season).then(done, (err) => {
        if (st.epSection) st.epSection.classList.remove('t-loading');
        T.toast(PL.errorMessage(err));
      });
    }

    // ---- Shelves ---------------------------------------------------------------------------------------------

    function shelves() {
      const out = [];
      const f = st.full;
      if (st.type === 'episode' && st.siblings && st.siblings.length > 1) {
        const sh = ui.shelf({
          title: 'More in ' + (f.parentTitle || 'this season'),
          kind: 'wide',
          items: st.siblings,
          card: (ep) => {
            const c = ui.wide(ep, {
              title: D.episodeTitle(ep), sub: D.episodeSub(ep),
              onSelect: (x) => (x.ratingKey === f.ratingKey ? play(f, f.viewOffset || 0) : T.open(x)),
              onChange: () => reload(),
            });
            if (ep.ratingKey === f.ratingKey) c.classList.add('t-current');
            return c;
          },
        });
        sh.dataset.key = 'siblings';
        out.push(sh);
      }
      if (st.related && st.related.Metadata && st.related.Metadata.length) {
        const hub = st.related;
        const sh = ui.shelf({
          title: hub.title || 'More Like This',
          items: hub.Metadata,
          total: hub.size,
          card: (it) => ui.poster(it, { onChange: () => reload() }),
        });
        sh.dataset.key = 'related';
        out.push(sh);
      }
      if (st.cast.length) {
        const sh = ui.shelf({ title: 'Cast & Crew', kind: 'person', items: st.cast, card: (p) => ui.personCard(p) });
        sh.dataset.key = 'cast';
        out.push(sh);
      }
      if (st.extras.length > 1 && f.type !== 'episode') {
        const sh = ui.shelf({
          title: 'Extras',
          kind: 'wide',
          items: st.extras,
          card: (x) => ui.wide(x, { title: x.title, sub: D.extraLabel(x), onSelect: (e) => T.play(e, { offset: 0 }), onHold: () => {} }),
        });
        sh.dataset.key = 'extras';
        out.push(sh);
      }
      return out;
    }

    // ---- Render ----------------------------------------------------------------------------------------------

    // The partial item (from a shelf) at once, while the full one loads.
    function preview() {
      setArt(item);
      setPoster(item);
      main.replaceChildren(head(item));
    }

    function render() {
      const f = st.full;
      const sub = subject();
      // keep the sideways scroll of each shelf across a refresh
      const rowsX = {};
      lists.querySelectorAll('[data-key]').forEach((s) => { if (s.row) rowsX[s.dataset.key] = s.row.scrollLeft; });
      setArt(f);
      setPoster(st.type === 'season' && sub ? sub : f);
      const headBox = head(f);
      st.actions = actionsRow();
      const kids = [headBox, playBlock(), st.actions];
      const summary = (st.type === 'season' && sub && sub.summary) || f.summary;
      let sumBox = null;
      if (summary) {
        sumBox = synopsis(summary);
        kids.push(sumBox);
      }
      main.replaceChildren(...kids);
      bar.querySelector('.t-backbar-title').textContent = barTitle(st.type === 'season' ? Object.assign({}, sub || item, { parentTitle: f.title }) : f);
      const parts = [];
      st.epSection = null;
      if ((st.type === 'show' || st.type === 'season') && st.seasons && st.seasons.length) {
        st.epSection = episodesSection();
        parts.push(st.epSection);
      }
      lists.replaceChildren(...parts.concat(shelves()));
      lists.querySelectorAll('[data-key]').forEach((s) => { if (s.row && rowsX[s.dataset.key]) s.row.scrollLeft = rowsX[s.dataset.key]; });
      st.summary = sumBox;
      requestAnimationFrame(() => { if (sumBox) sumBox.measure(); });
      pluginBadges(f);
    }

    function pluginBadges(f) {
      if (!PL.plugins || !PL.plugins.badges) return;
      const wrap = st.badges;
      PL.plugins.badges(f).then((list) => {
        if (!st.alive || st.badges !== wrap || !list) return;
        list.forEach((b) => wrap.appendChild(h('span.t-badge.t-badge-plugin' + (b.tone ? '.t-tone-' + b.tone : ''), { text: b.label })));
      }, () => {});
    }

    function pluginActions(f) {
      if (!PL.plugins || !PL.plugins.actions) return;
      const apply = (list) => {
        if (!st.alive || !list || !list.length || st.full !== f) return;
        st.plugins = list.filter((a) => a && a.label && a.run);
        if (st.actions) {
          const row = actionsRow();
          st.actions.replaceWith(row);
          st.actions = row;
        }
      };
      const got = PL.plugins.actions(f);
      if (got && typeof got.then === 'function') got.then(apply, () => {});
      else apply(got);
    }

    // ---- Loading -------------------------------------------------------------------------------------------

    function showKeyFor() {
      if (item.type !== 'season') return Promise.resolve(item.ratingKey);
      if (item.parentRatingKey) return Promise.resolve(item.parentRatingKey);
      return PL.plex.metadata(item.ratingKey).then((s) => s.parentRatingKey);
    }

    function load() {
      const gen = ++st.gen;
      st.busy = true;
      return showKeyFor().then((key) => fetchFull(key)).then((full) => {
        const next = { full, extras: (full.Extras && full.Extras.Metadata) || [], cast: D.people(full), eps: {} };
        const jobs = [];
        if (full.type === 'show') {
          jobs.push(PL.plex.children(full.ratingKey).then((seasons) => {
            next.seasons = seasons;
            next.onDeck = PL.plex.onDeck(full) || null;
            // a refresh stays on the season shown; the first load opens the asked-for or On Deck one
            const keep = st.seasons && st.seasons[st.seasonIdx] ? st.seasons[st.seasonIdx].ratingKey : null;
            next.seasonIdx = D.seasonIndex(seasons, keep || st.wantSeason, next.onDeck);
            const loads = [];
            const add = (s) => { if (s) loads.push(PL.plex.children(s.ratingKey).then((eps) => { next.eps[s.ratingKey] = eps; })); };
            add(seasons[next.seasonIdx]);
            // Play with nothing On Deck starts the show's first episode
            if (!next.onDeck && next.seasonIdx !== 0 && st.type === 'show') add(seasons[0]);
            return Promise.all(loads);
          }));
          jobs.push(related(full.ratingKey).then((r) => { next.related = r; }));
        } else if (full.type === 'episode') {
          if (full.parentRatingKey) jobs.push(PL.plex.children(full.parentRatingKey).then((eps) => { next.siblings = eps; }, () => { next.siblings = []; }));
          // episodes without their own cast borrow the show's
          if (!next.cast.length && full.grandparentRatingKey) {
            jobs.push(fetchFull(full.grandparentRatingKey).then((show) => { next.cast = D.people(show); }, () => {}));
          }
        } else if (full.type === 'movie') {
          jobs.push(related(full.ratingKey).then((r) => { next.related = r; }));
        }
        return Promise.all(jobs).then(() => next);
      }).then((next) => {
        st.busy = false;
        if (!st.alive || gen !== st.gen) return;
        const first = !st.loaded;
        Object.assign(st, next);
        st.loaded = true;
        if (first && st.type !== 'season') st.type = st.full.type;
        status.replaceChildren();
        const y = window.scrollY;
        render();
        if (!first && T.top() === page) window.scrollTo(0, y);
        if (first) pluginActions(st.full);
        else if (st.plugins.length) { /* the row was rebuilt with them */ }
      }, (err) => {
        st.busy = false;
        if (!st.alive || gen !== st.gen) return;
        if (st.loaded) return T.toast(PL.errorMessage(err));
        status.replaceChildren(ui.empty(PL.errorMessage(err)), ui.button({ label: 'Try again', action: () => { status.replaceChildren(ui.spinner()); load(); } }));
      });
    }

    // After playback, a watched change or a page above it: progress, Resume and ticks are fetched again.
    function reload() {
      if (!st.loaded) return;
      // the episode lists come again (their progress changed); the On Deck one too
      load();
    }

    // ---- The Back bar turns solid once the art has scrolled away ---------------------------------------------

    const onScroll = () => {
      const solid = hero.getBoundingClientRect().bottom < 120;
      if (solid !== bar.classList.contains('t-solid')) bar.classList.toggle('t-solid', solid);
    };
    const onResize = PL.debounce(() => { if (st.summary) st.summary.measure(); onScroll(); }, 150);

    page.onShow = (o) => {
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize);
      requestAnimationFrame(onScroll);
      // back from the player, or from a page above this one: progress may have moved
      if (o && o.back && st.loaded && !st.busy) {
        st.played = false;
        reload();
      }
    };
    page.onHide = () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
    page.destroy = () => { st.alive = false; onResize.cancel && onResize.cancel(); };
    page.title = P.itemTitle(item) || '';
    page.details = st; // for tests and debugging

    preview();
    load();
    return page;
  }

  function barTitle(it) {
    if (!it) return '';
    if (it.type === 'episode') return it.title || it.grandparentTitle || '';
    if (it.type === 'season') return [it.parentTitle, it.title].filter(Boolean).join(' · ');
    return it.title || '';
  }
})();
