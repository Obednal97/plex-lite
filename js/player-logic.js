// The player's pure logic (no DOM): the segmented seek bar's geometry, track and time labels, and
// which action each remote key means in each state. Kept apart from js/screens/player.js so it can be
// tested in node (test/player-logic.test.mjs).
'use strict';

(function () {
  var PL = window.PL = window.PL || {};
  var L = PL.playerLogic = {};

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
  }
  L.clock = clock;

  // ---- The seek bar: one segment per chapter, `gap` px apart, widths in proportion to time --------

  // chapters: [{start, end?}] sorted by start (seconds). Fewer than two (or no duration) -> one
  // segment. Returns [{start, end, left, w}] in px within `width`.
  L.segments = function (chapters, dur, width, gap) {
    var bounds = [];
    if (dur > 0 && chapters && chapters.length > 1) {
      var prev = 0;
      chapters.forEach(function (c) {
        var s = clamp(c.start || 0, 0, dur);
        if (!bounds.length) bounds.push(0);
        else if (s - Math.max(prev, bounds[bounds.length - 1]) >= 1 && s < dur - 1) bounds.push(s);
        prev = Math.max(prev, s);
      });
    }
    if (bounds.length < 2) return [{ start: 0, end: dur || 0, left: 0, w: width }];
    var n = bounds.length;
    var avail = width - gap * (n - 1);
    var segs = [];
    var left = 0;
    for (var i = 0; i < n; i++) {
      var start = bounds[i];
      var end = i + 1 < n ? bounds[i + 1] : dur;
      // rounding drift goes into the last segment, so the bar always ends at `width`
      var w = i + 1 < n ? Math.max(2, Math.round((end - start) / dur * avail)) : Math.max(2, width - left);
      segs.push({ start: start, end: end, left: left, w: w });
      left += w + gap;
    }
    return segs;
  };

  L.segmentIndex = function (segs, sec) {
    for (var i = segs.length - 1; i > 0; i--) if (sec >= segs[i].start) return i;
    return 0;
  };

  // seconds -> px along the bar
  L.xAt = function (segs, sec) {
    var s = segs[L.segmentIndex(segs, sec)];
    var len = s.end - s.start;
    return s.left + (len > 0 ? clamp((sec - s.start) / len, 0, 1) : 0) * s.w;
  };

  // px along the bar -> seconds (a gap counts as the start of the segment after it)
  L.secAt = function (segs, x) {
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (x < s.left) return s.start;
      if (x <= s.left + s.w) return s.start + (s.end - s.start) * (x - s.left) / s.w;
    }
    var last = segs[segs.length - 1];
    return last.end;
  };

  // how much of a segment is filled at `sec`, 0..1
  L.fill = function (seg, sec) {
    var len = seg.end - seg.start;
    if (!(len > 0)) return sec >= seg.end ? 1 : 0;
    return clamp((sec - seg.start) / len, 0, 1);
  };

  L.chapterAt = function (chapters, sec) {
    var idx = -1;
    for (var i = 0; i < (chapters || []).length; i++) if (sec >= chapters[i].start) idx = i;
    return idx;
  };

  // ---- Labels -------------------------------------------------------------------------------------

  // Under the bar while paused or scrubbing: "Paused at 9:13 · jumping to Chapter 5".
  L.scrubLine = function (real, target, chapters) {
    var head = 'Paused at ' + clock(real);
    if (target == null || Math.abs(target - real) < 1) return head;
    var a = L.chapterAt(chapters, real);
    var b = L.chapterAt(chapters, target);
    if (b >= 0 && a !== b) return head + ' · jumping to ' + chapters[b].title;
    var d = Math.round(target - real);
    return head + ' · ' + (d > 0 ? 'ahead ' : 'back ') + clock(Math.abs(d));
  };

  // 150000 ms -> "3 min"; 6120000 -> "1 h 42 min"
  L.runtime = function (ms) {
    if (!(ms > 0)) return '';
    var m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  };

  var CODECS = {
    aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', dca: 'DTS', dts: 'DTS', 'dca-ma': 'DTS-HD MA', truehd: 'TrueHD',
    mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', pcm: 'PCM', alac: 'ALAC',
  };
  var SUB_CODECS = /\s*\(([^()]*\s)?(srt|subrip|ass|ssa|pgs|vobsub|dvd_subtitle|dvdsub|hdmv_pgs_subtitle|mov_text|tx3g|webvtt|vtt|smi|text)\)\s*$/i;
  var AUDIO_CODECS = /\s*\(([^()]*\s)?(aac|ac3|eac3|e-ac3|dts|dca|truehd|mp3|flac|opus|vorbis|pcm|alac)[^()]*\)\s*$/i;

  // A subtitle track's name for the menu: "English", "English (SDH)", "Français (Forced)"; the
  // codec Plex appends ("English [SDH] (SRT)") is dropped.
  L.subtitleLabel = function (s) {
    var t = String(s.extendedDisplayTitle || s.displayTitle || s.title || s.language || ('Track ' + (s.index != null ? s.index : ''))).trim();
    t = t.replace(SUB_CODECS, '').replace(/\s*\[([^\]]+)\]/g, ' ($1)').replace(/\s+/g, ' ').trim();
    if (s.forced && !/forced/i.test(t)) t += ' (Forced)';
    return t || 'Subtitles';
  };

  // Picture subtitles (PGS, VobSub) can't be drawn by the app: the server burns them into the video.
  L.isPictureSub = function (s) {
    return !!s && !/^(srt|subrip|ass|ssa|vtt|webvtt|mov_text|tx3g|text|smi)$/i.test(String(s.codec || ''));
  };

  L.channelsLabel = function (n) {
    if (!n) return '';
    if (n === 1) return 'Mono';
    if (n === 2) return 'Stereo';
    if (n === 6) return '5.1 surround';
    if (n === 8) return '7.1 surround';
    return n + ' channels';
  };

  L.codecLabel = function (codec) {
    var c = String(codec || '').toLowerCase();
    return CODECS[c] || c.toUpperCase();
  };

  // An audio track: {label: "English", detail: "5.1 surround · AC3"} (a commentary keeps its title).
  L.audioLabel = function (s) {
    var name = String(s.language || s.displayTitle || ('Track ' + (s.index != null ? s.index : ''))).trim();
    if (s.title && !/^(stereo|mono|surround|\d\.\d)/i.test(s.title) && s.title !== name) name += ' · ' + s.title;
    var parts = [];
    var ch = L.channelsLabel(s.channels);
    if (ch) parts.push(ch);
    if (s.codec) parts.push(L.codecLabel(s.codec));
    if (!parts.length && s.displayTitle) parts.push(String(s.displayTitle).replace(AUDIO_CODECS, ''));
    return { label: name, detail: parts.join(' · ') };
  };

  L.videoLabel = function (media) {
    if (!media) return '';
    var res = String(media.videoResolution || '');
    var r = /^\d+$/.test(res) ? res + 'p' : res === '4k' ? '4K' : res.toUpperCase();
    var c = String(media.videoCodec || '').toLowerCase();
    var codec = { h264: 'H.264', hevc: 'HEVC', h265: 'HEVC', vp9: 'VP9', av1: 'AV1', mpeg2video: 'MPEG-2', vc1: 'VC-1' }[c] || c.toUpperCase();
    return [r, codec].filter(Boolean).join(' · ');
  };

  // ---- Cast tab ------------------------------------------------------------------------------------

  var MAIN_BILLED = 10; // the show's top-billed roles count as main cast
  var MAX_CAST = 40;

  function personKey(r) {
    return r.id != null ? 'id' + r.id : 'name:' + String(r.tag || r.name || '').trim().toLowerCase();
  }

  // The Cast tab's people, as [{id, name, role, thumb, guest}]. A movie: its Role list. An episode:
  // its own Roles that aren't among the show's top-billed cast first, marked guest, then the show's
  // cast in billing order. Plex often gives an episode the show's leads as its Roles, so a role
  // counts as a guest only when the show's cast is known and the person isn't billed near the top.
  // One entry per person; at most MAX_CAST.
  L.castList = function (item, show) {
    var out = [];
    var seen = {};
    var add = function (r, guest) {
      var name = String(r.tag || r.name || '').trim();
      var k = personKey(r);
      if (!name || seen[k]) return;
      seen[k] = true;
      out.push({ id: r.id != null ? r.id : null, name: name, role: r.role || '', thumb: r.thumb || null, guest: !!guest });
    };
    var own = (item && item.Role) || [];
    if (item && item.type === 'episode') {
      var showRoles = (show && show.Role) || [];
      var main = {};
      showRoles.slice(0, MAIN_BILLED).forEach(function (r) { main[personKey(r)] = true; });
      var inShow = {};
      showRoles.forEach(function (r) { inShow[personKey(r)] = r; });
      own.forEach(function (r) { if (showRoles.length && !main[personKey(r)]) add(r, true); });
      // the show's cast, keeping the episode's character name when the show lacks one
      showRoles.forEach(function (r) {
        var mine = own.filter(function (o) { return personKey(o) === personKey(r); })[0];
        add(mine && !r.role ? { id: r.id, tag: r.tag, role: mine.role, thumb: r.thumb || mine.thumb } : r, false);
      });
      own.forEach(function (r) { add(r, false); }); // no show cast known
    } else {
      own.forEach(function (r) { add(r, false); });
    }
    return out.slice(0, MAX_CAST);
  };

  // ---- Remote keys -> actions -------------------------------------------------------------------

  // key: 'left' | 'right' | 'up' | 'down' | 'ok' | 'back'. c (the player's state):
  //   hidden      controls are not on screen
  //   zone        where the focus is while they are: 'bar' | 'icons' | 'cta' | 'tabs' | 'cards' | 'menu'
  //   cta         the call to action on screen: 'pill' (Skip Intro/Credits) | 'endcard' | null
  //   live, playable (playing or paused, metadata loaded), paused, scrubbing, held (the key is
  //   being held down), hasIcons, hasTabs, hasCards (the open tab has something to focus)
  // Returns an action name for Player.act, or null for nothing.
  L.keyAction = function (c, key) {
    var dir = key === 'left' ? 'back' : 'fwd';
    var arrowLR = key === 'left' || key === 'right';
    if (c.hidden) {
      if (c.cta === 'endcard') {
        return { left: 'cta-prev', right: 'cta-next', ok: 'cta-press', back: 'cta-dismiss', up: 'show-cta', down: 'show-cta' }[key] || null;
      }
      if (key === 'back') return c.cta === 'pill' ? 'cta-dismiss' : 'exit';
      if (key === 'ok' && c.cta === 'pill') return 'cta-press';
      if (arrowLR && !c.live && c.playable) return (c.paused ? 'scrub-' : 'jump-') + dir;
      return c.cta === 'pill' ? 'show-cta' : 'show';
    }
    switch (c.zone) {
      case 'menu':
        return { up: 'menu-up', down: 'menu-down', ok: 'menu-press', back: 'menu-back' }[key] || null;
      case 'cta':
        if (key === 'ok') return 'cta-press';
        if (key === 'down') return c.hasIcons ? 'zone-icons' : 'zone-bar';
        if (key === 'back') return 'hide';
        if (c.cta === 'endcard' && arrowLR) return key === 'left' ? 'cta-prev' : 'cta-next';
        return null;
      case 'icons':
        return {
          left: 'icon-prev', right: 'icon-next', ok: 'icon-press', down: 'zone-bar', back: 'hide',
          up: c.cta ? 'zone-cta' : null,
        }[key] || null;
      case 'tabs':
        if (key === 'left') return 'tab-prev';
        if (key === 'right') return 'tab-next';
        if (key === 'down' || key === 'ok') return c.hasCards ? 'zone-cards' : null;
        return 'zone-bar'; // up, back
      case 'cards':
        return { left: 'card-prev', right: 'card-next', ok: 'card-press', up: 'zone-tabs', back: 'zone-bar' }[key] || null;
      default: // the bar
        if (key === 'back') return c.scrubbing ? 'cancel' : 'hide';
        if (c.live) return key === 'ok' ? (c.paused ? 'play' : 'pause') : null;
        if (arrowLR) {
          if (!c.playable) return null;
          return (c.scrubbing || c.paused || c.held ? 'scrub-' : 'jump-') + dir;
        }
        if (key === 'ok') return c.scrubbing ? 'commit' : c.paused ? 'play' : 'pause';
        if (c.scrubbing) return null;
        if (key === 'up') return c.hasIcons ? 'zone-icons' : c.cta ? 'zone-cta' : null;
        if (key === 'down') return c.hasTabs ? 'zone-tabs' : null;
        return null;
    }
  };

  // Seconds a held Left/Right moves the scrub target per second, by how long it has been held.
  L.holdSpeed = function (heldMs, dur) {
    return heldMs < 1000 ? 20 : heldMs < 3000 ? 60 : heldMs < 5000 ? Math.max(120, dur / 40) : Math.max(240, dur / 15);
  };

  // The first card to show so that `focus` is visible in a row of `visible` cards.
  L.rowStart = function (first, focus, count, visible) {
    if (focus < first) first = focus;
    if (focus > first + visible - 1) first = focus - visible + 1;
    return clamp(first, 0, Math.max(0, count - visible));
  };
})();
