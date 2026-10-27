// Video player: library items (direct play or server stream) and Live TV channels.
// Layout and remote: docs/PLAYER-v2-design.md. The bar's geometry, labels and the key map are in
// js/player-logic.js (pure, tested); this file owns the DOM, playback and timing.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var K = PL.KEY;
  var L = PL.playerLogic;
  var BAR_W = 1728;
  var BAR_GAP = 6;
  var PREVIEW_W = 464;     // preview thumbnail (with its time pill under it)
  var TIME_ONLY_W = 400;   // no preview thumbnails (the usual case): a large time and the chapter
  var OSD_HIDE_MS = 5000;
  var JUMP_RESTART_MS = 400; // server streams restart per seek, so taps this close together add up
  var HOLD_GAP_MS = 600;   // key-downs closer than this without a key-up count as a held key
  var TIMELINE_MS = 10000;
  var CARD_STEP = 352;     // 320 px card + 32 px gap
  var ROW_VISIBLE = 5;
  var CAST_GEO = { w: 160, h: 160 }; // round people cards, as on the details page but smaller
  var CAST_STEP = 200;
  var CAST_VISIBLE = 8;
  var showCasts = {};      // grandparentRatingKey -> Promise<show metadata>, for the session
  var MENU_W = 540;
  var MENU_MAX_LIST = 560; // the subtitle list scrolls beyond this
  var SUB_SIZES = { small: 'Small', medium: 'Medium', large: 'Large' };

  // Line icons drawn like the mockups (24-unit grid). [tag, attrs] lists; stroke unless fill: true.
  var GLYPHS = {
    subtitles: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }], ['path', { d: 'M7 15h4M14 15h3M7 11h2M12 11h5' }]],
    audio: [['path', { d: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
    chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
    restart: [['path', { d: 'M4 12a8 8 0 1 0 2.5-5.8' }], ['path', { d: 'M4 4v4.5h4.5' }]],
    pause: { fill: true, parts: [['rect', { x: 6, y: 5, width: 4, height: 14, rx: 1 }], ['rect', { x: 14, y: 5, width: 4, height: 14, rx: 1 }]] },
    skip: { fill: true, parts: [['path', { d: 'M3 5.5v13l9-6.5z' }], ['path', { d: 'M12 5.5v13l9-6.5z' }]] },
    play: { fill: true, parts: [['path', { d: 'M6 4.5v15l13-7.5z' }]] },
    next: { fill: true, parts: [['path', { d: 'M4 5.5v13l10-6.5z' }], ['rect', { x: 16, y: 5, width: 3.2, height: 14, rx: 1 }]] },
  };

  // name: a key of GLYPHS, or a glyph definition of the same shape (Live TV draws its own).
  function glyph(name, size, weight) {
    var g = typeof name === 'string' ? GLYPHS[name] : name;
    var fill = !!g.parts; // {fill: true, parts} (an array's .fill is Array.prototype.fill)
    var parts = g.parts || g;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'glyph');
    if (fill) {
      svg.setAttribute('fill', 'currentColor');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', weight || 1.8);
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    parts.forEach(function (p) {
      var n = document.createElementNS('http://www.w3.org/2000/svg', p[0]);
      Object.keys(p[1]).forEach(function (k) { n.setAttribute(k, p[1][k]); });
      svg.appendChild(n);
    });
    return svg;
  }

  PL.glyph = glyph;

  // "S1 E2" (Special 3 for season 0)
  function episodeCode(it) {
    if (it.parentIndex == null || it.index == null) return '';
    return it.parentIndex === 0 ? 'Special ' + it.index : 'S' + it.parentIndex + ' E' + it.index;
  }

  // Hover moves the focus only while the Magic Remote's pointer is showing (rows sliding under a
  // hidden cursor must not steal it).
  // "Ann Lee" -> "AL" (the monogram for a person without a photo)
  function initialsOf(name) {
    var parts = String(name || '').split(/\s+/).filter(Boolean);
    return ((parts[0] ? parts[0].charAt(0) : '') + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }

  function pointing() { return document.body.classList.contains('pointer'); }

  // the width of an element's text (not of its box)
  function textWidth(node) {
    var r = document.createRange();
    r.selectNodeContents(node);
    return Math.min(node.clientWidth || 1100, Math.ceil(r.getBoundingClientRect().width));
  }

  function indexOfKey(list, ratingKey) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].ratingKey === ratingKey) return i;
    return -1;
  }

  // What this TV decodes in hardware. The decision call must not send hasMDE, otherwise the
  // server trusts the client and "direct plays" DTS. Only AC3/E-AC3 in the transcode target
  // keeps 5.1 for the soundbar (with AAC listed the server picks AAC).
  var PROFILE_EXTRA = [
    'add-direct-play-profile(type=videoProfile&container=mkv,mp4,mov,m4v,mpegts,ts&videoCodec=h264,hevc,mpeg2video,vp9&audioCodec=aac,ac3,eac3,mp3,flac,opus)',
    'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264,hevc&audioCodec=ac3,eac3)',
    'add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10)',
  ].join('+');

  // With a text subtitle the server streams the video as a copy and serves WebVTT segments.
  var PROFILE_EXTRA_VTT = PROFILE_EXTRA +
    '+add-transcode-target(type=subtitleProfile&context=streaming&protocol=hls&container=webvtt&subtitleCodec=webvtt)';

  var TEXT_SUBS = { srt: 1, subrip: 1, ass: 1, ssa: 1, vtt: 1, webvtt: 1, mov_text: 1, tx3g: 1, text: 1, smi: 1 };

  function streamsOf(item, mediaIndex) {
    var media = item && item.Media && (item.Media[mediaIndex || 0] || item.Media[0]);
    var part = media && media.Part && media.Part[0];
    return part ? part.Stream || [] : [];
  }

  function selectedSubtitle(item, mediaIndex) {
    return streamsOf(item, mediaIndex).filter(function (s) { return s.streamType === 3 && s.selected; })[0] || null;
  }

  function selectedAudioId(item, mediaIndex) {
    var a = streamsOf(item, mediaIndex).filter(function (s) { return s.streamType === 2 && s.selected; })[0];
    return a ? a.id : null;
  }

  // 'none' | 'external' (text file on the server) | 'embedded' (text inside the video) | 'image' (PGS/VobSub)
  function subtitleKind(stream) {
    if (!stream) return 'none';
    if (!TEXT_SUBS[String(stream.codec || '').toLowerCase()]) return 'image';
    return stream.key ? 'external' : 'embedded';
  }

  // Direct play always gets the file's first audio track, so another choice needs a server stream.
  function hasAlternateAudio(item, mediaIndex) {
    var audio = streamsOf(item, mediaIndex).filter(function (s) { return s.streamType === 2; });
    var chosen = audio.filter(function (s) { return s.selected; })[0];
    return !!chosen && audio.indexOf(chosen) > 0;
  }

  function parseClock(t) {
    var m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(t);
    if (!m) return null;
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] + '00').slice(0, 3)) / 1000;
  }

  function cleanCueText(t) {
    return t.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
  }

  // SRT, WebVTT and ASS/SSA (styling stripped) -> [{start, end, text}] sorted by start.
  function parseSubtitles(text) {
    var cues = [];
    text = String(text || '').replace(/\r\n?/g, '\n');
    if (/^\s*\[Script Info\]/i.test(text) || /^Dialogue:/m.test(text)) {
      text.split('\n').forEach(function (line) {
        if (line.indexOf('Dialogue:') !== 0) return;
        var f = line.slice(9).split(',');
        if (f.length < 10) return;
        var start = parseClock(f[1].trim() + '0');
        var end = parseClock(f[2].trim() + '0');
        var body = cleanCueText(f.slice(9).join(','));
        if (start != null && end != null && body) cues.push({ start: start, end: end, text: body });
      });
    } else {
      text.split(/\n{2,}/).forEach(function (block) {
        var lines = block.split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('-->') === -1) continue;
          var parts = lines[i].split('-->');
          var start = parseClock(parts[0]);
          var end = parseClock(parts[1]);
          var body = cleanCueText(lines.slice(i + 1).join('\n'));
          if (start != null && end != null && body) cues.push({ start: start, end: end, text: body });
          return;
        }
      });
    }
    cues.sort(function (a, b) { return a.start - b.start; });
    return cues;
  }

  function endsAt(secondsLeft) {
    var d = new Date(Date.now() + secondsLeft * 1000);
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }

  var PILL_MS = 10000;
  var CREDITS_FALLBACK_SEC = 30;

  function setting(key, dflt) {
    var v = PL.storage.get(key, dflt);
    return typeof v === 'boolean' ? v : dflt;
  }

  // Intro markers, plus the end-credits start. Some shows carry several mid-episode "credits"
  // markers, so only the final one (or the last one in the last 30% of the runtime) counts.
  function parseMarkers(item) {
    var list = item.Marker || [];
    var intros = list.filter(function (m) { return m.type === 'intro' && m.endTimeOffset > m.startTimeOffset; })
      .map(function (m) { return { start: m.startTimeOffset / 1000, end: m.endTimeOffset / 1000 }; });
    var credits = list.filter(function (m) { return m.type === 'credits'; })
      .sort(function (a, b) { return a.startTimeOffset - b.startTimeOffset; });
    var fin = credits.filter(function (m) { return m.final; })[0] || credits[credits.length - 1];
    var creditsStart = null;
    var fromMarker = false;
    if (fin && (fin.final || !item.duration || fin.startTimeOffset >= item.duration * 0.7)) {
      creditsStart = fin.startTimeOffset / 1000;
      fromMarker = true;
    } else if (item.type === 'episode' && item.duration) {
      creditsStart = Math.max(0, item.duration / 1000 - CREDITS_FALLBACK_SEC);
    }
    return { intros: intros, creditsStart: creditsStart, creditsFromMarker: fromMarker };
  }

  function Player(item, opts) {
    opts = opts || {};
    this.item = item;
    this.full = null;
    this.live = opts.live || null;
    this.startOffset = opts.offset || 0;
    this.mediaIndex = opts.mediaIndex || 0;
    this.chapters = [];
    this.segs = L.segments([], 0, BAR_W, BAR_GAP);
    this.subs = { kind: 'none', id: null, cues: [], shown: '', segs: {}, timer: null };
    this.gen = 0;
    this.state = 'idle';
    this.mode = null;
    this.base = 0;
    this.session = null;
    this.queue = opts.queue && opts.queue.items && opts.queue.items.length ? opts.queue : null;
    this.retried = false;
    this.scrubState = null;   // {real, target, wasPlaying} while the paused-look scrub is on
    this.jumpTarget = null;   // a jump not sent to the TV yet (a seek in flight, or a stream restart)
    this.lastJump = null;     // {from, at}: where the last tap jumped from (a hold scrubs from there)
    this.seekPresses = 0;
    this.lastSeekAt = 0;
    this.lastReported = null;
    this.osdHidden = true;
    this.zone = 'bar';        // focus while the controls are up: bar | icons | cta | tabs | cards | menu
    this.icons = [];          // [{id, node, action}]
    this.iconIndex = 0;
    this.tabs = [];           // [{id, label, node, pane, cards, index, first}]
    this.tabIndex = 0;
    this.menu = null;         // the open Subtitles / Audio menu
    this.ecIndex = 1;         // end card: 0 Watch Credits, 1 Next Episode
    this.held = {};           // keys down without a key-up yet
    this.hold = null;         // {dir, since, last} while Left/Right is held on the bar
    this.hoverSec = null;     // pointer over the bar: the time under it
    this.painted = {};        // last values written to the DOM, so unchanged ones aren't rewritten
    this.preview = { part: null, ok: false, want: null, loading: false, shown: null };
    this.build();
    // a channel: the live controls (js/screens/live-osd.js) replace the bottom block
    if (this.live) this.liveOsd = new PL.LiveOsd(this);
  }

  Player.prototype.build = function () {
    var self = this;
    var el = this.el = PL.el('div', 'player');
    this.video = PL.el('video');
    el.appendChild(this.video);

    this.status = PL.el('div', 'player-status');
    this.statusText = PL.el('div', 'player-status-text');
    this.status.appendChild(PL.ui.spinner());
    this.status.appendChild(this.statusText);
    el.appendChild(this.status);

    this.subEl = PL.el('div', 'subs');
    this.applySubSize();
    el.appendChild(this.subEl);

    // ---- the controls: one bottom block over a scrim --------------------------------------
    // paused / scrubbing: a 30% veil over the picture (its own layer, outside the fading block)
    el.appendChild(PL.el('div', 'player-veil'));
    // the end card's corner scrim sits under the controls, so they stay crisp over it
    el.appendChild(PL.el('div', 'corner-scrim endcard-scrim'));
    var osd = this.osd = PL.el('div', 'osd faded');
    osd.appendChild(PL.el('div', 'osd-scrim'));
    osd.appendChild(PL.el('div', 'osd-scrim-tall'));

    // title, icons, bar and times: slide up together when a tab opens
    var upper = this.upper = PL.el('div', 'osd-upper');
    var text = PL.el('div', 'osd-text');
    this.eyebrow = PL.el('div', 'osd-eyebrow');
    this.title = PL.el('div', 'osd-title');
    text.appendChild(this.eyebrow);
    text.appendChild(this.title);
    upper.appendChild(text);

    this.iconRow = PL.el('div', 'osd-icons');
    upper.appendChild(this.iconRow);

    var bar = this.bar = PL.el('div', 'bar');
    this.segRow = PL.el('div', 'bar-segs');
    bar.appendChild(this.segRow);
    this.tick = PL.el('div', 'bar-tick');
    bar.appendChild(this.tick);
    this.head = PL.el('div', 'bar-head');
    this.head.appendChild(PL.el('div', 'bar-knob'));
    bar.appendChild(this.head);
    var pv = this.previewEl = PL.el('div', 'bar-preview');
    this.thumbBox = PL.el('div', 'bar-thumb');
    this.thumbImg = PL.el('img');
    this.thumbBox.appendChild(this.thumbImg);
    var label = PL.el('div', 'bar-label');
    this.previewTime = PL.el('div', 'bar-time');
    this.previewChapter = PL.el('div', 'bar-chapter');
    label.appendChild(this.previewTime);
    label.appendChild(this.previewChapter);
    pv.appendChild(this.thumbBox);
    pv.appendChild(label);
    bar.appendChild(pv);
    var hit = PL.el('div', 'bar-hit');
    bar.appendChild(hit);
    upper.appendChild(bar);

    var times = PL.el('div', 'osd-times');
    var left = PL.el('div', 'left');
    var pauseGlyph = PL.el('span', 'osd-glyph');
    pauseGlyph.appendChild(glyph('pause', 26));
    this.elapsed = PL.el('span', 'osd-elapsed');
    this.note = PL.el('span', 'osd-note');
    left.appendChild(pauseGlyph);
    left.appendChild(this.elapsed);
    left.appendChild(this.note);
    this.remaining = PL.el('div', 'right');
    times.appendChild(left);
    times.appendChild(this.remaining);
    upper.appendChild(times);
    osd.appendChild(upper);

    // while scrubbing: what OK and Back do
    var hints = PL.el('div', 'osd-hints');
    var hint = function (key, label) {
      var h = PL.el('div', 'osd-hint');
      h.appendChild(PL.el('span', 'keycap', key));
      var t = PL.el('span', '', label);
      h.appendChild(t);
      hints.appendChild(h);
      return t;
    };
    hint('OK', 'Jump here');
    this.hintBack = hint('Back', 'Return');
    osd.appendChild(hints);

    this.tabRow = PL.el('div', 'osd-tabs');
    osd.appendChild(this.tabRow);
    this.panel = PL.el('div', 'osd-panel');
    osd.appendChild(this.panel);

    this.menuEl = PL.el('div', 'osd-menu');
    osd.appendChild(this.menuEl);
    el.appendChild(osd);

    // ---- Skip Intro / Skip Credits ------------------------------------------------------------
    this.skip = PL.el('div', 'skip skip-hidden');
    this.skip.appendChild(PL.el('div', 'corner-scrim skip-scrim'));
    this.pill = PL.el('div', 'skip-pill');
    this.pill.appendChild(glyph('skip', 30));
    this.pillLabel = PL.el('span', '', '');
    this.pill.appendChild(this.pillLabel);
    this.pillLine = PL.el('div', 'cta-line');
    this.pill.appendChild(this.pillLine);
    this.skip.appendChild(this.pill);
    el.appendChild(this.skip);
    this.pillVisible = false;
    this.pill.addEventListener('click', function (e) { e.stopPropagation(); self.activatePill(); });

    // ---- End of episode ---------------------------------------------------------------------
    var ec = this.endcard = PL.el('div', 'endcard endcard-hidden');
    var body = this.ecBody = PL.el('div', 'endcard-body');
    var top = PL.el('div', 'endcard-top');
    var info = PL.el('div', 'endcard-text');
    this.ecLabel = PL.el('div', 'endcard-label');
    this.ecTitle = PL.el('div', 'endcard-title');
    this.ecMeta = PL.el('div', 'endcard-meta');
    [this.ecLabel, this.ecTitle, this.ecMeta].forEach(function (n) { info.appendChild(n); });
    this.ecThumb = PL.el('div', 'endcard-thumb');
    top.appendChild(info);
    top.appendChild(this.ecThumb);
    body.appendChild(top);
    var btns = PL.el('div', 'endcard-btns');
    this.ecWatch = PL.el('div', 'cta-btn', 'Watch Credits');
    this.ecNext = PL.el('div', 'cta-btn cta-next');
    this.ecNext.appendChild(glyph('play', 26));
    this.ecNext.appendChild(PL.el('span', '', 'Next Episode'));
    this.ecCount = PL.el('span', 'cta-count', '');
    this.ecNext.appendChild(this.ecCount);
    this.ecLine = PL.el('div', 'cta-line');
    this.ecNext.appendChild(this.ecLine);
    btns.appendChild(this.ecWatch);
    btns.appendChild(this.ecNext);
    body.appendChild(btns);
    ec.appendChild(body);
    el.appendChild(ec);
    this.ecWatch.addEventListener('click', function (e) { e.stopPropagation(); self.ecIndex = 0; self.pressCta(); });
    this.ecNext.addEventListener('click', function (e) { e.stopPropagation(); self.ecIndex = 1; self.pressCta(); });
    [this.ecWatch, this.ecNext].forEach(function (n, i) {
      n.addEventListener('mouseenter', function () { if (pointing()) { self.ecIndex = i; self.paintCta(); } });
    });

    this.paintSoon = PL.rafThrottle(function () { self.paintBar(); });
    this.thumbImg.onerror = function () { self.preview.ok = false; self.preview.loading = false; self.paintBar(); };
    this.bindPointer(hit);
    this.buildSegments();

    var v = this.video;
    var on = function (name, fn) { v.addEventListener(name, fn); };
    on('loadedmetadata', function () {
      if (self.mode === 'direct' && self.directStartSec > 0) {
        self.directSeek(self.directStartSec);
        self.directStartSec = 0;
      }
    });
    on('seeked', function () { self.onSeeked(); });
    on('playing', function () {
      var was = self.state;
      self.setStatus(null);
      self.state = 'playing';
      self.report();
      self.paintState();
      // a new stream or a resume brings the controls up; recovering from a stall doesn't
      if (was !== 'playing' || !self.osdHidden) self.showOsd();
    });
    on('pause', function () {
      if (v.ended || (self.state !== 'playing' && self.state !== 'paused')) return;
      self.state = 'paused';
      if (!self.statusText.textContent) self.setStatus(null); // no buffering spinner over a paused picture
      self.report();
      self.paintState();
      self.showOsd();
    });
    on('waiting', function () {
      if (self.state === 'playing') self.setStatus('', true);
    });
    on('timeupdate', function () {
      if (self.liveOsd) {
        self.liveOsd.onTime();
        return;
      }
      self.verifySeek();
      if (!self.osdHidden) self.paintBar();
      self.renderSubs();
      self.checkMarkers();
      self.paintCtaLine();
    });
    on('progress', function () { if (!self.osdHidden) self.paintBar(); });
    on('ended', function () { self.onEnded(); });
    on('error', function () { self.onVideoError(); });
  };

  // Magic Remote / mouse: moving wakes the controls; hovering focuses what is under the pointer and
  // clicking presses it; the bar shows the time (and preview) under the pointer and seeks on click.
  Player.prototype.bindPointer = function (hit) {
    var self = this;
    var lastMove = 0;
    this.el.addEventListener('mousemove', function () {
      var now = Date.now();
      if (now - lastMove < 250 || self.state === 'stopped' || self.state === 'ended') return;
      lastMove = now;
      self.showOsd();
    });
    this.el.addEventListener('click', function () { if (self.osdHidden) self.showOsd(); });
    var rect = null;
    var secAt = function (e) {
      if (!rect) rect = hit.getBoundingClientRect();
      var dur = self.durationSec();
      if (!dur) return null;
      return PL.clamp(L.secAt(self.segs, (e.clientX - rect.left) / rect.width * BAR_W), 0, dur);
    };
    hit.addEventListener('mouseenter', function () {
      rect = hit.getBoundingClientRect();
      if (pointing() && !self.osdHidden && !self.live && self.zone !== 'menu') self.setZone('bar');
    });
    hit.addEventListener('mousemove', function (e) {
      if (self.live || self.osdHidden) return;
      self.hoverSec = secAt(e);
      self.osd.classList.add('hovering');
      self.paintSoon();
    });
    hit.addEventListener('mouseleave', function () {
      self.hoverSec = null;
      self.osd.classList.remove('hovering');
      self.paintSoon();
    });
    hit.addEventListener('click', function (e) {
      e.stopPropagation();
      if (self.live || !self.canSeek() || self.osdHidden) return;
      var sec = secAt(e);
      if (sec == null) return;
      sec = PL.clamp(sec, 0, Math.max(0, self.durationSec() - 5));
      if (self.scrubState) {
        self.scrubState.target = sec;
        self.scrubCommit();
      } else {
        self.seekNow(sec);
        self.showOsd('bar');
      }
    });
  };

  // ---- Status / controls ---------------------------------------------------------------------

  // text === null hides it; '' shows only the spinner (buffering).
  Player.prototype.setStatus = function (text, spinning) {
    if (text === null) {
      this.status.classList.add('player-status-hidden');
      return;
    }
    this.status.classList.remove('player-status-hidden');
    this.status.classList.toggle('player-status-error', !spinning);
    this.statusText.textContent = text;
  };

  // The controls stay up while paused, scrubbing, or with a menu or tab open.
  Player.prototype.mayAutoHide = function () {
    return this.state === 'playing' && !this.scrubState && !this.menu && !this.tabOpen();
  };

  // Shows the controls (or keeps them up) and re-arms the auto-hide. zone: where the focus lands;
  // by default the Skip / Up Next button when one is showing (it keeps the focus), else the bar.
  Player.prototype.showOsd = function (zone) {
    if (this.liveOsd) {
      this.liveOsd.showBanner();
      return;
    }
    var self = this;
    var wasHidden = this.osdHidden;
    if (wasHidden) {
      this.osdHidden = false;
      this.osd.classList.remove('faded');
      this.el.classList.add('osd-open');
      this.zone = zone || (this.cta() ? 'cta' : 'bar');
    } else if (zone) {
      this.zone = zone;
    }
    this.paintZone();
    if (wasHidden) this.paintBar();
    clearTimeout(this.osdTimer);
    if (this.mayAutoHide()) {
      this.osdTimer = setTimeout(function () {
        if (self.state === 'stopped') return;
        if (self.mayAutoHide()) self.hideOsd();
        else self.showOsd();
      }, OSD_HIDE_MS);
    }
  };

  Player.prototype.hideOsd = function () {
    clearTimeout(this.osdTimer);
    if (this.osdHidden) return;
    this.osdHidden = true;
    this.closeMenu(true);
    this.closeTab(true);
    this.osd.classList.add('faded');
    this.el.classList.remove('osd-open');
    this.hoverSec = null;
    this.osd.classList.remove('hovering');
    this.zone = 'bar';
    this.paintZone();
  };

  Player.prototype.setZone = function (zone) {
    this.showOsd(zone);
  };

  // Keeps the zone valid (the thing it points at may have gone) and paints every focus state. Only
  // classes on small elements change, so a zone move never repaints the picture area.
  Player.prototype.paintZone = function () {
    var z = this.zone;
    if (z === 'cta' && !this.cta()) z = 'bar';
    if (z === 'icons' && !this.icons.length) z = 'bar';
    if (z === 'menu' && !this.menu) z = this.icons.length ? 'icons' : 'bar';
    if ((z === 'tabs' || z === 'cards') && !this.tabs.length) z = 'bar';
    if (this.live && z !== 'bar' && z !== 'cta') z = 'bar';
    this.zone = z;
    var up = !this.osdHidden;
    var cls = 'zone-' + (up ? z : 'none');
    if (this.zoneClass !== cls) {
      if (this.zoneClass) this.osd.classList.remove(this.zoneClass);
      this.osd.classList.add(cls);
      this.zoneClass = cls;
    }
    var self = this;
    this.icons.forEach(function (ic, i) {
      ic.node.classList.toggle('focused', up && (z === 'icons' || (z === 'menu' && self.menu && self.menu.icon === i)) && i === self.iconIndex);
    });
    this.tabs.forEach(function (t, i) {
      t.node.classList.toggle('focused', up && z === 'tabs' && i === self.tabIndex);
      t.node.classList.toggle('selected', up && z === 'cards' && i === self.tabIndex);
    });
    var tab = this.tabs[this.tabIndex];
    if (tab && tab.cards) {
      tab.cards.forEach(function (c, i) { if (c.node) c.node.classList.toggle('focused', up && z === 'cards' && i === tab.index); });
    }
    this.el.classList.toggle('tab-open', up && this.tabOpen());
    this.el.classList.toggle('menu-open', up && !!this.menu);
    this.paintCta();
  };

  // Paused look (veil, pause glyph) and scrubbing look (taller bar, preview, hints).
  Player.prototype.paintState = function () {
    this.el.classList.toggle('paused', this.state === 'paused' || !!this.scrubState);
    this.el.classList.toggle('scrubbing', !!this.scrubState);
    if (this.scrubState) this.hintBack.textContent = 'Return to ' + PL.fmt.clock(this.scrubState.real);
  };

  // ---- Round icons, tabs and the seek bar's segments: rebuilt when the item, its queue or its
  // chapters change -----------------------------------------------------------------------------

  Player.prototype.buildControls = function () {
    this.buildIcons();
    this.buildTabs();
    this.buildSegments();
    this.paintZone();
  };

  Player.prototype.buildIcons = function () {
    var self = this;
    var list = [];
    if (!this.live && this.full) {
      var streams = streamsOf(this.full, this.mediaIndex);
      var subs = streams.filter(function (s) { return s.streamType === 3; });
      var audio = streams.filter(function (s) { return s.streamType === 2; });
      if (subs.length) list.push({ id: 'subtitles', label: 'Subtitles', glyph: 'subtitles', action: function () { self.openMenu('subtitles'); } });
      if (audio.length > 1) list.push({ id: 'audio', label: 'Audio', glyph: 'audio', action: function () { self.openMenu('audio'); } });
      if (this.nextItem()) list.push({ id: 'next', label: 'Next episode', glyph: 'next', action: function () { self.playNext(true); } });
    }
    var was = this.icons[this.iconIndex] && this.icons[this.iconIndex].id;
    if (list.map(function (b) { return b.id; }).join() === this.icons.map(function (b) { return b.id; }).join()) return;
    PL.clear(this.iconRow);
    this.icons = list.map(function (b, i) {
      var n = PL.el('div', 'round');
      n.setAttribute('aria-label', b.label);
      n.appendChild(glyph(b.glyph, b.glyph === 'next' ? 28 : 32, 1.8));
      n.addEventListener('mouseenter', function () {
        if (!pointing() || self.osdHidden || self.menu) return;
        self.iconIndex = i;
        self.setZone('icons');
      });
      n.addEventListener('click', function (e) {
        e.stopPropagation();
        self.iconIndex = i;
        self.setZone('icons');
        b.action();
      });
      self.iconRow.appendChild(n);
      return { id: b.id, node: n, action: b.action };
    });
    var keep = list.map(function (b) { return b.id; }).indexOf(was);
    this.iconIndex = keep >= 0 ? keep : 0;
  };

  Player.prototype.buildSegments = function () {
    var self = this;
    var dur = this.durationSec();
    this.segs = L.segments(this.live ? [] : this.chapters, dur, BAR_W, BAR_GAP);
    PL.clear(this.segRow);
    this.segNodes = this.segs.map(function (s) {
      var n = PL.el('div', 'seg');
      n.style.left = s.left + 'px';
      n.style.width = s.w + 'px';
      var target = PL.el('div', 'seg-target');
      var fill = PL.el('div', 'seg-fill');
      n.appendChild(target);
      n.appendChild(fill);
      self.segRow.appendChild(n);
      return { target: target, fill: fill };
    });
    Object.keys(this.painted).forEach(function (k) { if (/^s[ab]\d/.test(k)) delete self.painted[k]; });
    this.paintBar();
  };

  Player.prototype.icon = function (id) {
    for (var i = 0; i < this.icons.length; i++) if (this.icons[i].id === id) return i;
    return -1;
  };

  Player.prototype.paintText = function () {
    if (this.liveOsd) {
      this.liveOsd.paintBanner();
      return;
    }
    PL.clear(this.eyebrow);
    if (this.live) {
      var ch = this.live.channel;
      this.eyebrow.appendChild(PL.el('span', 'osd-live', 'LIVE'));
      this.eyebrow.appendChild(document.createTextNode((ch.vcn ? ch.vcn + '  ' : '') + (ch.title || '')));
      this.title.textContent = this.programme || ch.title || '';
      return;
    }
    var f = this.full || this.item;
    if (f.type === 'episode') {
      var ep = episodeCode(f);
      this.eyebrow.textContent = (f.grandparentTitle || '') + (ep ? ' · ' + ep : '');
    } else {
      this.eyebrow.textContent = f.year ? String(f.year) : '';
    }
    this.title.textContent = f.title || '';
    this.textRight = null; // measured again on the next scrub
  };

  Player.prototype.durationSec = function () {
    var f = this.full || this.item;
    if (f && f.duration) return f.duration / 1000;
    var d = this.video.duration;
    return isFinite(d) ? d + (this.mode === 'transcode' ? this.base : 0) : 0;
  };

  // Where playback is meant to be: during a (re)start currentTime is still 0.
  Player.prototype.intendedPosition = function () {
    var pos = this.position();
    if (!(this.video.currentTime > 0)) pos = Math.max(pos, this.lastOffsetSec || 0);
    if (this.seekReq) pos = Math.max(pos, this.seekReq.target);
    return pos;
  };

  Player.prototype.position = function () {
    var t = this.video.currentTime || 0;
    return this.mode === 'transcode' ? this.base + t : t;
  };

  // Where the bar shows playback: a jump that hasn't reached the TV yet counts as done.
  Player.prototype.shownPosition = function () {
    if (this.jumpTarget != null) return this.jumpTarget;
    if (this.seekReq && this.mode === 'direct') return this.seekReq.target;
    return this.state === 'loading' ? this.intendedPosition() : this.position();
  };

  // Writes a value to the DOM only when it changed (text changes cost a layout on the TV).
  Player.prototype.setPainted = function (key, node, prop, value) {
    if (this.painted[key] === value) return;
    this.painted[key] = value;
    if (prop === 'text') node.textContent = value;
    else node.style[prop] = value;
  };

  // The bar, a few times a second (timeupdate) or once a frame while scrubbing. Every moving part
  // is a transform: scaleX for the segment fills, translate for the head, tick and preview. Only the
  // segments whose fill changed are touched.
  Player.prototype.paintBar = function () {
    if (this.live) {
      this.setPainted('vis', this.bar, 'visibility', 'hidden');
      this.setPainted('el', this.elapsed, 'text', '');
      this.setPainted('note', this.note, 'text', '');
      this.setPainted('rem', this.remaining, 'text', '');
      return;
    }
    this.setPainted('vis', this.bar, 'visibility', '');
    var dur = this.durationSec();
    var sc = this.scrubState;
    var real = sc ? sc.real : this.shownPosition();
    var target = sc ? sc.target : real;
    var lo = Math.min(real, target);
    var hi = Math.max(real, target);
    for (var i = 0; i < this.segs.length; i++) {
      var n = this.segNodes[i];
      if (!n) break;
      this.setPainted('sa' + i, n.fill, 'transform', 'scaleX(' + L.fill(this.segs[i], lo).toFixed(4) + ')');
      this.setPainted('sb' + i, n.target, 'transform', 'scaleX(' + L.fill(this.segs[i], hi).toFixed(4) + ')');
    }
    var x = dur ? L.xAt(this.segs, target) : 0;
    this.setPainted('head', this.head, 'transform', 'translate3d(' + Math.round(x) + 'px,0,0)');
    if (sc) this.setPainted('tick', this.tick, 'transform', 'translate3d(' + Math.round(dur ? L.xAt(this.segs, real) : 0) + 'px,0,0)');

    // over the scrub target (or the pointer): a large time with the chapter under it, or, when the
    // server makes preview thumbnails, the frame over a time pill
    var at = sc ? target : this.hoverSec;
    if (at != null && dur) {
      var withThumb = this.preview.ok;
      var w = withThumb ? PREVIEW_W : TIME_ONLY_W;
      var px = PL.clamp(L.xAt(this.segs, at) - w / 2, 0, BAR_W - w);
      if (this.painted.pvmode !== withThumb) {
        this.painted.pvmode = withThumb;
        this.previewEl.classList.toggle('no-thumb', !withThumb);
      }
      this.setPainted('pvw', this.previewEl, 'width', w + 'px');
      this.setPainted('pv', this.previewEl, 'transform', 'translate3d(' + Math.round(px) + 'px,0,0)');
      // the label fades the title out when it rides over it (one layout read per title)
      if (this.textRight == null) this.textRight = Math.max(textWidth(this.title), textWidth(this.eyebrow));
      var over = px < this.textRight + 24;
      if (this.painted.over !== over) {
        this.painted.over = over;
        this.osd.classList.toggle('label-over-title', over);
      }
      this.setPainted('pvt', this.previewTime, 'text', PL.fmt.clock(at));
      var atChapter = this.chapters.length > 1 ? L.chapterAt(this.chapters, at) : -1;
      this.setPainted('pvc', this.previewChapter, 'text', !withThumb && atChapter >= 0 ? this.chapters[atChapter].title : '');
      this.setPainted('pvthumb', this.thumbBox, 'display', withThumb && this.preview.shown != null ? '' : 'none');
      if (withThumb) this.wantPreview(at);
    }

    var chapter = L.chapterAt(this.chapters, real);
    if (sc) {
      this.setPainted('el', this.elapsed, 'text', '');
      this.setPainted('note', this.note, 'text', L.scrubLine(real, target, this.chapters));
      this.setPainted('rem', this.remaining, 'text', dur ? '−' + PL.fmt.clock(Math.max(0, dur - target)) : '');
    } else {
      this.setPainted('el', this.elapsed, 'text', PL.fmt.clock(real));
      this.setPainted('note', this.note, 'text', chapter >= 0 && this.chapters.length > 1 ? ' · ' + this.chapters[chapter].title : '');
      var left = Math.max(0, dur - real);
      this.setPainted('rem', this.remaining, 'text', dur ? '−' + PL.fmt.clock(left) + ' · Ends at ' + endsAt(left) : '');
    }
  };

  // ---- Preview thumbnails: Plex's index frames for the part (only if the server makes them) --------

  Player.prototype.setupPreview = function () {
    var media = this.full && this.full.Media && (this.full.Media[this.mediaIndex] || this.full.Media[0]);
    var part = media && media.Part && media.Part[0];
    var has = !!part && /\bsd\b/.test(String(part.indexes || ''));
    this.preview = { part: has ? part.id : null, ok: has, want: null, loading: false, shown: null };
    this.thumbImg.removeAttribute('src');
  };

  // One frame at a time: while one loads, only the latest wanted time is kept, so a fast scrub asks
  // for a frame only as often as the server answers. Frames are 2 s apart (Plex's default).
  Player.prototype.wantPreview = function (sec) {
    var p = this.preview;
    if (!p.ok || !p.part) return;
    var ms = Math.max(0, Math.round(sec / 2) * 2000);
    if (ms === p.shown && !p.loading) return;
    p.want = ms;
    if (p.loading) return;
    this.loadPreview();
  };

  Player.prototype.loadPreview = function () {
    var self = this;
    var p = this.preview;
    var ms = p.want;
    p.want = null;
    if (ms == null || ms === p.shown) return;
    p.loading = true;
    var img = new Image();
    var part = p.part;
    img.onload = function () {
      if (self.preview !== p) return;
      p.loading = false;
      p.shown = ms;
      self.thumbImg.src = img.src;
      self.setPainted('pvthumb', self.thumbBox, 'display', '');
      if (p.want != null) self.loadPreview();
    };
    img.onerror = function () {
      if (self.preview !== p) return;
      p.loading = false;
      // no frame here: if none ever loaded the server has none, so fall back to the time alone
      if (p.shown == null) {
        p.ok = false;
        self.paintBar();
      } else if (p.want != null) {
        self.loadPreview();
      }
    };
    img.src = PL.plex.url('/library/parts/' + part + '/indexes/sd/' + ms);
  };

  // ---- Subtitles / Audio menus: a popover above the icon that opened it ----------------------------

  Player.prototype.openMenu = function (kind) {
    if (!this.full) return;
    var iconAt = this.icon(kind);
    if (iconAt < 0) return;
    this.iconIndex = iconAt;
    this.menu = { kind: kind, icon: iconAt, view: 'list', index: 0, rows: [] };
    this.renderMenu();
    this.setZone('menu');
    clearTimeout(this.osdTimer);
  };

  Player.prototype.menuRows = function () {
    var self = this;
    var m = this.menu;
    var media = this.full.Media && (this.full.Media[this.mediaIndex] || this.full.Media[0]);
    var part = media && media.Part && media.Part[0];
    var streams = streamsOf(this.full, this.mediaIndex);
    var pick = function (choice, apply) {
      return function () {
        self.closeMenu();
        if (!part) return;
        PL.plex.selectStreams(part.id, choice).then(function () {
          apply();
          self.onTracksChanged();
        }, function (err) { PL.toast(PL.errorMessage(err)); });
      };
    };
    if (m.view === 'size') {
      var cur = this.subSize();
      return Object.keys(SUB_SIZES).map(function (k) {
        return { label: SUB_SIZES[k], checked: k === cur, run: function () {
          PL.storage.set('subtitleSize', k);
          self.applySubSize();
          self.closeMenu();
        } };
      });
    }
    if (m.kind === 'audio') {
      var audio = streams.filter(function (s) { return s.streamType === 2; });
      return audio.map(function (s) {
        var a = L.audioLabel(s);
        return { label: a.label, sub: a.detail, checked: !!s.selected, run: pick({ audioStreamID: s.id }, function () {
          audio.forEach(function (x) { x.selected = x === s; });
        }) };
      });
    }
    var subs = streams.filter(function (s) { return s.streamType === 3; });
    var rows = [{ label: 'Off', checked: !subs.some(function (s) { return s.selected; }), run: pick({ subtitleStreamID: 0 }, function () {
      subs.forEach(function (x) { x.selected = false; });
    }) }];
    subs.forEach(function (s) {
      rows.push({
        label: L.subtitleLabel(s), sub: L.isPictureSub(s) ? 'Picture subtitles · the server burns them in' : '', checked: !!s.selected,
        run: pick({ subtitleStreamID: s.id }, function () { subs.forEach(function (x) { x.selected = x === s; }); }),
      });
    });
    rows.push({ rule: true });
    rows.push({ label: 'Size and style', link: true, run: function () { self.menuView('size'); } });
    return rows;
  };

  Player.prototype.menuView = function (view) {
    this.menu.view = view;
    this.renderMenu();
    this.paintZone();
  };

  Player.prototype.renderMenu = function () {
    var self = this;
    var m = this.menu;
    var el = this.menuEl;
    PL.clear(el);
    var box = PL.el('div', 'menu-box');
    var heading = m.view === 'size' ? 'Subtitle size' : m.kind === 'audio' ? 'Audio' : 'Subtitles';
    box.appendChild(PL.el('div', 'menu-head', heading));
    var clip = PL.el('div', 'menu-clip');
    var list = m.list = PL.el('div', 'menu-list');
    clip.appendChild(list);
    box.appendChild(clip);
    m.rows = this.menuRows();
    m.nodes = [];
    var y = 0;
    var focus = -1;
    m.rows.forEach(function (r) {
      if (r.rule) {
        list.appendChild(PL.el('div', 'menu-rule'));
        y += 17;
        return;
      }
      var n = PL.el('div', 'menu-row' + (r.sub ? ' two' : '') + (r.link ? ' link' : '') + (r.checked ? ' checked' : ''));
      var t = PL.el('div', 'menu-text');
      t.appendChild(PL.el('div', 'menu-label', r.label));
      if (r.sub) t.appendChild(PL.el('div', 'menu-sub', r.sub));
      n.appendChild(t);
      if (r.checked) n.appendChild(glyph('check', 28, 2.4));
      if (r.link) n.appendChild(glyph('chevron', 24, 2));
      var i = m.nodes.length;
      n.addEventListener('mouseenter', function () { if (pointing()) { m.index = i; self.paintMenu(); } });
      n.addEventListener('click', function (e) { e.stopPropagation(); m.index = i; self.pressMenu(); });
      list.appendChild(n);
      var h = r.sub ? 76 : 64;
      m.nodes.push({ node: n, row: r, top: y, h: h });
      if (r.checked && focus < 0) focus = i;
      y += h + 4;
    });
    m.height = y - 4;
    if (m.backTo != null) {
      m.index = m.backTo < 0 ? m.nodes.length - 1 : m.backTo;
      m.backTo = null;
    } else {
      m.index = focus >= 0 ? focus : 0;
    }
    var clipH = Math.min(m.height, MENU_MAX_LIST);
    clip.style.height = clipH + 'px';
    m.clipH = clipH;
    el.appendChild(box);
    // anchored over its icon, a caret pointing at it
    var n = this.icons.length;
    var center = 1824 - (n - 1 - m.icon) * 88 - 34;
    var left = PL.clamp(center - MENU_W + 58, 96, 1824 - MENU_W);
    box.style.left = left + 'px';
    var caret = PL.el('div', 'menu-caret');
    caret.style.left = (center - 11) + 'px';
    el.appendChild(caret);
    this.paintMenu();
  };

  Player.prototype.paintMenu = function () {
    var m = this.menu;
    if (!m) return;
    m.nodes.forEach(function (r, i) { r.node.classList.toggle('focused', i === m.index); });
    var r = m.nodes[m.index];
    if (!r || m.height <= m.clipH) return;
    // keep the focused row near the middle, starting the view on a whole row (no half-cut row under
    // the heading)
    var want = PL.clamp(r.top + r.h / 2 - m.clipH / 2, 0, m.height - m.clipH);
    var shift = 0;
    for (var i = 0; i < m.nodes.length && m.nodes[i].top <= want; i++) shift = m.nodes[i].top;
    if (want >= m.height - m.clipH) shift = m.height - m.clipH;
    PL.translate(m.list, 0, -shift);
  };

  Player.prototype.moveMenu = function (d) {
    var m = this.menu;
    m.index = PL.clamp(m.index + d, 0, m.nodes.length - 1);
    this.paintMenu();
  };

  Player.prototype.pressMenu = function () {
    var r = this.menu && this.menu.nodes[this.menu.index];
    if (r && r.row.run) r.row.run();
  };

  // Back in a menu: the size list returns to the subtitle list, else the menu closes.
  Player.prototype.menuBack = function () {
    if (this.menu && this.menu.view === 'size') {
      this.menu.backTo = -1; // the "Size and style" row, last in the list
      this.menuView('list');
      return;
    }
    this.closeMenu();
  };

  Player.prototype.closeMenu = function (quiet) {
    if (!this.menu) return;
    this.menu = null;
    PL.clear(this.menuEl);
    if (!quiet) this.showOsd('icons');
  };

  Player.prototype.subSize = function () {
    var v = PL.storage.get('subtitleSize', 'medium');
    return SUB_SIZES[v] ? v : 'medium';
  };

  Player.prototype.applySubSize = function () {
    var size = this.subSize();
    this.subEl.className = 'subs subs-' + size;
  };

  // ---- Tabs under the bar: Info, Chapters, Episodes ---------------------------------------------------

  Player.prototype.tabOpen = function () {
    return this.zone === 'tabs' || this.zone === 'cards';
  };

  Player.prototype.buildTabs = function () {
    var self = this;
    var list = [];
    if (!this.live && this.full) {
      list.push({ id: 'info', label: 'Info' });
      if (this.castFor(this.full).length) list.push({ id: 'cast', label: 'Cast' });
      if (this.chapters.length > 1) list.push({ id: 'chapters', label: 'Chapters' });
      if (this.full.type === 'episode' && this.full.parentRatingKey) list.push({ id: 'episodes', label: 'Episodes' });
    }
    if (list.map(function (t) { return t.id; }).join() === this.tabs.map(function (t) { return t.id; }).join() && this.tabsFor === this.full) return;
    this.tabsFor = this.full;
    PL.clear(this.tabRow);
    PL.clear(this.panel);
    this.tabs = list.map(function (t, i) {
      var n = PL.el('div', 'ptab', t.label);
      n.addEventListener('mouseenter', function () { if (pointing() && !self.osdHidden && !self.menu) self.focusTab(i); });
      n.addEventListener('click', function (e) { e.stopPropagation(); self.focusTab(i); });
      self.tabRow.appendChild(n);
      var pane = PL.el('div', 'pane');
      self.panel.appendChild(pane);
      return { id: t.id, label: t.label, node: n, pane: pane, cards: null, index: 0, first: 0, built: false };
    });
    var openId = this.tabOpen() && this.tabsIds ? this.tabsIds[this.tabIndex] : null;
    this.tabsIds = this.tabs.map(function (t) { return t.id; });
    var keep = openId ? this.tabsIds.indexOf(openId) : -1;
    this.tabIndex = PL.clamp(keep >= 0 ? keep : this.tabIndex, 0, Math.max(0, this.tabs.length - 1));
    if (openId) this.focusTab(this.tabIndex);
  };

  // ---- The Cast tab: the movie's roles, or an episode's guests then the show's cast -------------

  // The show's metadata (for its cast), fetched once per show per session.
  function showMeta(grandparentKey) {
    if (!showCasts[grandparentKey]) {
      showCasts[grandparentKey] = PL.plex.get('/library/metadata/' + grandparentKey).then(function (mc) {
        return (mc && mc.Metadata && mc.Metadata[0]) || null;
      }, function () {
        delete showCasts[grandparentKey]; // try again next time
        return null;
      });
    }
    return showCasts[grandparentKey];
  }

  Player.prototype.castFor = function (full) {
    if (!full) return [];
    return L.castList(full, full.type === 'episode' ? this.castShow : null);
  };

  // After playback has started: one small request for the show's cast (cached), then the tabs
  // gain Cast if there is anyone to show.
  Player.prototype.prefetchCast = function (full) {
    var self = this;
    this.castShow = null;
    if (full.type !== 'episode' || !full.grandparentRatingKey) return;
    showMeta(full.grandparentRatingKey).then(function (show) {
      if (self.full !== full || !show) return;
      self.castShow = show;
      var tab = self.tabs.filter(function (t) { return t.id === 'cast'; })[0];
      if (tab) {
        tab.built = false; // the list changed: rebuild on next open
        if (self.tabOpen() && self.tabs[self.tabIndex] === tab) self.fillTab(tab);
      }
      self.buildTabs();
      self.paintZone();
    });
  };

  Player.prototype.fillCast = function (tab) {
    var self = this;
    var people = this.castFor(this.full);
    PL.clear(tab.pane);
    var track = tab.track = PL.el('div', 'cast-track');
    tab.step = CAST_STEP;
    tab.visible = CAST_VISIBLE;
    tab.index = 0;
    tab.first = 0;
    // cards are made when they first come near the view (a show can list dozens of people)
    tab.cards = people.map(function (p, i) {
      var c = { node: null, run: function () {} }; // OK does nothing for now: no leaving mid-playback
      c.build = function () {
        // the details page's round people card, built lean for the player (no stacking contexts or
        // per-part transitions: those doubled the cost of a focus move on the TV)
        var n = c.node = PL.el('div', 'ccard');
        var art = PL.el('div', 'ccard-art');
        art.appendChild(PL.el('div', 'ccard-initials', initialsOf(p.name)));
        if (p.thumb) {
          var img = PL.el('img', 'ccard-img');
          img.onload = function () { img.classList.add('loaded'); };
          img.onerror = function () { img.style.visibility = 'hidden'; };
          img.src = PL.plex.image(p.thumb, CAST_GEO.w, CAST_GEO.h);
          art.appendChild(img);
        }
        art.appendChild(PL.el('div', 'ccard-rim'));
        n.appendChild(art);
        n.appendChild(PL.el('div', 'ccard-name', p.name));
        if (p.role) n.appendChild(PL.el('div', 'ccard-role', p.role));
        if (p.guest) n.appendChild(PL.el('div', 'ccard-guest', 'Guest star'));
        n.style.left = (i * CAST_STEP) + 'px';
        n.addEventListener('mouseenter', function () {
          if (!pointing() || self.osdHidden) return;
          tab.index = i;
          self.setZone('cards');
          self.paintCards(tab);
        });
        track.appendChild(n);
      };
      return c;
    });
    tab.pane.appendChild(track);
    this.paintCards(tab);
  };

  // Focus a tab: its row slides in under it (built the first time).
  Player.prototype.focusTab = function (i) {
    if (!this.tabs.length) return;
    this.tabIndex = PL.clamp(i, 0, this.tabs.length - 1);
    var self = this;
    this.tabs.forEach(function (t, j) { t.pane.classList.toggle('shown', j === self.tabIndex); });
    var tab = this.tabs[this.tabIndex];
    this.fillTab(tab);
    this.setZone('tabs');
    clearTimeout(this.osdTimer);
    this.prebuildTabs();
  };

  // While the tabs are up and the remote is idle, fill the other tabs' rows (hidden), so moving to
  // one only shows it.
  Player.prototype.prebuildTabs = function () {
    var self = this;
    clearTimeout(this.prebuildTimer);
    this.prebuildTimer = setTimeout(function () {
      if (!self.tabOpen() || self.state === 'stopped') return;
      if (Date.now() - (self.lastKeyAt || 0) < 200) { self.prebuildTabs(); return; }
      var next = self.tabs.filter(function (t) { return !t.built && t.id !== 'info'; })[0];
      if (!next) return;
      self.fillTab(next);
      self.prebuildTabs(); // one tab per idle moment
    }, 250);
  };

  Player.prototype.closeTab = function (quiet) {
    if (!this.tabOpen()) return;
    this.zone = 'bar';
    if (!quiet) this.showOsd('bar');
  };

  Player.prototype.fillTab = function (tab) {
    if (tab.id === 'info') {
      this.fillInfo(tab); // facts change with tracks and stream decisions: always fresh
      return;
    }
    if (tab.built) {
      if (tab.id === 'chapters') this.markCurrentChapter(tab);
      return;
    }
    tab.built = true;
    if (tab.id === 'chapters') this.fillChapters(tab);
    else if (tab.id === 'cast') this.fillCast(tab);
    else if (tab.id === 'episodes') this.fillEpisodes(tab);
  };

  Player.prototype.fillInfo = function (tab) {
    var self = this;
    var f = this.full;
    PL.clear(tab.pane);
    var wrap = PL.el('div', 'info');
    var col = PL.el('div', 'info-main');
    col.appendChild(PL.el('p', 'info-summary', f.summary || ''));
    var btn = PL.el('div', 'info-btn');
    btn.appendChild(glyph('restart', 24, 2.2));
    btn.appendChild(PL.el('span', '', 'Start from the beginning'));
    btn.addEventListener('mouseenter', function () { if (pointing() && !self.osdHidden) { tab.index = 0; self.setZone('cards'); } });
    btn.addEventListener('click', function (e) { e.stopPropagation(); self.restartFromBeginning(); });
    col.appendChild(btn);
    wrap.appendChild(col);
    var facts = PL.el('div', 'info-facts');
    this.infoFacts().forEach(function (row) {
      var r = PL.el('div', 'info-fact');
      r.appendChild(PL.el('span', 'info-key', row[0]));
      r.appendChild(PL.el('span', 'info-val', row[1]));
      facts.appendChild(r);
    });
    wrap.appendChild(facts);
    tab.pane.appendChild(wrap);
    tab.cards = [{ node: btn, run: function () { self.restartFromBeginning(); } }];
    tab.index = 0;
  };

  Player.prototype.infoFacts = function () {
    var f = this.full;
    var media = f.Media && (f.Media[this.mediaIndex] || f.Media[0]);
    var streams = streamsOf(f, this.mediaIndex);
    var audio = streams.filter(function (s) { return s.streamType === 2 && s.selected; })[0] ||
      streams.filter(function (s) { return s.streamType === 2; })[0];
    var sub = selectedSubtitle(f, this.mediaIndex);
    var rows = [];
    rows.push(['Playing', this.mode === 'transcode' ? 'Converting: ' + (this.convertReason || 'the server prepares the stream') : this.mode === 'direct' ? 'Direct Play (no conversion)' : 'Starting…']);
    var video = L.videoLabel(media);
    if (video) rows.push(['Video', video]);
    if (audio) {
      var a = L.audioLabel(audio);
      rows.push(['Audio', a.label + (a.detail ? ' · ' + a.detail : '')]);
    }
    rows.push(['Subtitles', sub ? L.subtitleLabel(sub) + (L.isPictureSub(sub) ? ' (picture, burned in)' : ' (text)') : 'Off']);
    return rows;
  };

  Player.prototype.restartFromBeginning = function () {
    this.closeTab(true);
    if (this.scrubState) this.scrubState = null;
    this.seekNow(0);
    if (this.state === 'paused') this.togglePause(true);
    this.paintState();
    this.showOsd('bar');
  };

  // A row of 320x180 cards that scrolls; only cards near the view load their image.
  Player.prototype.cardRow = function (tab, items) {
    var self = this;
    PL.clear(tab.pane);
    var track = tab.track = PL.el('div', 'cards-track');
    tab.cards = items.map(function (it, i) {
      var n = PL.el('div', 'pcard' + (it.now ? ' now' : ''));
      var art = PL.el('div', 'pcard-art');
      if (it.fallback) art.appendChild(PL.el('div', 'pcard-fallback', it.fallback));
      if (it.progress != null) {
        var bar = PL.el('div', 'pcard-progress');
        var fill = PL.el('div', 'pcard-progress-fill');
        fill.style.transform = 'scaleX(' + PL.clamp(it.progress, 0, 1).toFixed(3) + ')';
        bar.appendChild(fill);
        art.appendChild(bar);
        it.fillNode = fill;
      }
      art.appendChild(PL.el('div', 'pcard-rim'));
      n.appendChild(art);
      n.appendChild(PL.el('div', 'pcard-title', it.title));
      n.appendChild(PL.el('div', 'pcard-sub', it.sub || ''));
      n.addEventListener('mouseenter', function () { if (pointing() && !self.osdHidden) { tab.index = i; self.paintCards(tab); self.setZone('cards'); } });
      n.addEventListener('click', function (e) { e.stopPropagation(); tab.index = i; it.run(); });
      track.appendChild(n);
      return { node: n, art: art, img: it.img, loaded: false, run: it.run, item: it };
    });
    tab.pane.appendChild(track);
    tab.first = L.rowStart(Math.max(0, tab.index - 2), tab.index, tab.cards.length, ROW_VISIBLE);
    this.paintCards(tab);
  };

  Player.prototype.paintCards = function (tab) {
    if (!tab.cards || !tab.track) return;
    var step = tab.step || CARD_STEP;
    var visible = tab.visible || ROW_VISIBLE;
    tab.first = L.rowStart(tab.first, tab.index, tab.cards.length, visible);
    PL.translate(tab.track, -tab.first * step, 0);
    var later = [];
    for (var i = Math.max(0, tab.first - 1); i < Math.min(tab.cards.length, tab.first + visible + 2); i++) {
      var c = tab.cards[i];
      if (c.build && !c.node) {
        // cards entering the edge of the view are made after this key's frame
        if (tab.shownOnce) later.push(c);
        else c.build();
      }
      if (c.loaded || !c.img) continue;
      c.loaded = true;
      var img = PL.el('img', 'pcard-img');
      img.onload = function () { this.classList.add('loaded'); };
      img.src = c.img;
      c.art.insertBefore(img, c.art.firstChild);
    }
    var self = this;
    tab.shownOnce = true;
    if (later.length) {
      setTimeout(function () {
        later.forEach(function (c) { if (!c.node) c.build(); });
        self.paintCards(tab);
      }, 0);
    }
    tab.cards.forEach(function (c, j) {
      if (!c.node) return;
      c.node.classList.toggle('focused', self.zone === 'cards' && !self.osdHidden && j === tab.index);
      c.node.classList.toggle('gone', j < tab.first);
    });
  };

  Player.prototype.fillChapters = function (tab) {
    var self = this;
    var cur = L.chapterAt(this.chapters, this.shownPosition());
    var dur = this.durationSec();
    tab.index = Math.max(0, cur);
    this.cardRow(tab, this.chapters.map(function (c, i) {
      var end = self.chapters[i + 1] ? self.chapters[i + 1].start : dur;
      return {
        title: c.title + (i === cur ? ' · Now' : ''), sub: PL.fmt.clock(c.start), now: i === cur,
        img: c.thumb ? PL.plex.image(c.thumb, 320, 180) : null, fallback: c.thumb ? null : PL.fmt.clock(c.start),
        progress: i === cur && end > c.start ? (self.shownPosition() - c.start) / (end - c.start) : null,
        run: function () { self.jumpToChapter(c); },
      };
    }));
  };

  // Reopening Chapters after playback moved on: rebuild if the current chapter changed.
  Player.prototype.markCurrentChapter = function (tab) {
    var cur = L.chapterAt(this.chapters, this.shownPosition());
    var was = -1;
    (tab.cards || []).forEach(function (c, i) { if (c.item.now) was = i; });
    if (cur !== was) this.fillChapters(tab);
    else {
      tab.index = Math.max(0, cur);
      this.paintCards(tab);
    }
  };

  Player.prototype.jumpToChapter = function (c) {
    this.closeTab(true);
    this.seekNow(c.start);
    if (this.state === 'paused') this.togglePause(true);
    this.showOsd('bar');
  };

  Player.prototype.fillEpisodes = function (tab) {
    var self = this;
    var full = this.full;
    tab.pane.appendChild(PL.el('div', 'pane-note', 'Loading episodes…'));
    PL.plex.get('/library/metadata/' + full.parentRatingKey + '/children').then(function (mc) {
      if (self.full !== full) return;
      var eps = (mc && mc.Metadata) || [];
      var cur = indexOfKey(eps, full.ratingKey);
      tab.index = Math.max(0, cur);
      self.cardRow(tab, eps.map(function (ep, i) {
        var progress = ep.viewOffset && ep.duration ? ep.viewOffset / ep.duration : null;
        return {
          title: (ep.index != null ? ep.index + ' · ' : '') + (ep.title || '') + (i === cur ? ' · Now' : ''),
          sub: L.runtime(ep.duration), now: i === cur,
          img: ep.thumb ? PL.plex.image(ep.thumb, 320, 180) : null, fallback: ep.thumb ? null : 'E' + (ep.index != null ? ep.index : ''),
          progress: i === cur ? self.shownPosition() / (self.durationSec() || 1) : progress,
          run: function () { self.playEpisode(ep); },
        };
      }));
      self.paintZone();
    }, function (err) {
      tab.built = false;
      PL.clear(tab.pane);
      tab.pane.appendChild(PL.el('div', 'pane-note', PL.errorMessage(err)));
    });
  };

  Player.prototype.playEpisode = function (ep) {
    if (this.full && ep.ratingKey === this.full.ratingKey) {
      this.closeTab();
      return;
    }
    this.playNext(true, ep);
  };

  Player.prototype.moveTab = function (d) {
    this.focusTab(this.tabIndex + d);
  };

  Player.prototype.moveCard = function (d) {
    var tab = this.tabs[this.tabIndex];
    if (!tab || !tab.cards) return;
    tab.index = PL.clamp(tab.index + d, 0, tab.cards.length - 1);
    this.paintCards(tab);
  };

  Player.prototype.pressCard = function () {
    var tab = this.tabs[this.tabIndex];
    var c = tab && tab.cards && tab.cards[tab.index];
    if (c && c.run) c.run();
  };

  Player.prototype.hasCards = function () {
    var tab = this.tabs[this.tabIndex];
    return !!(tab && tab.cards && tab.cards.length);
  };

  // ---- Starting playback ---------------------------------------------------------------------

  Player.prototype.show = function () {
    var self = this;
    PL.app.backdrop.set(null, 'none');
    if (this.state === 'idle') {
      var other = PL.app.stack.some(function (sc) { return sc !== self && sc instanceof Player && sc.state !== 'stopped'; });
      if (other) {
        PL.warn('a player is already open: refusing to start another');
        this.state = 'stopped';
        setTimeout(function () { self.exit(); }, 0);
        return;
      }
      this.begin();
    } else if (this.resumeOnShow) {
      this.resumeOnShow = false;
      this.togglePause(true);
    }
  };

  Player.prototype.begin = function () {
    var self = this;
    if (this.state === 'stopped') return;
    if (this.live) {
      this.tune(this.live.channel);
      return;
    }
    var gen = ++this.gen;
    this.setStatus('Loading…', true);
    PL.plex.get('/library/metadata/' + this.item.ratingKey, { includeMarkers: 1, includeChapters: 1, checkFiles: 0 }).then(function (mc) {
      var full = mc && mc.Metadata && mc.Metadata[0];
      if (!full) throw new Error('This item is no longer on the server');
      if (gen !== self.gen) return;
      self.full = full;
      self.markers = parseMarkers(full);
      self.markerState = { introDone: {}, creditsHandled: false, pill: null };
      if (!full.Media || !full.Media[self.mediaIndex]) self.mediaIndex = 0;
      self.loadChapters(full);
      self.paintText();
      self.setupPreview();
      self.buildControls();
      if (self.queue) self.alignQueue(full);
      else if (full.type === 'episode') self.loadQueue(full);
      // resuming from a saved position: back up 5 s so the scene is recognisable
      self.start(self.startOffset > 0 ? Math.max(0, self.startOffset - 5000) : 0);
      self.prefetchCast(full);
    }).catch(function (err) { if (gen === self.gen) self.fail(err); });
  };

  Player.prototype.alignQueue = function (full) {
    var q = this.queue;
    var cur = q.items[q.index];
    if (cur && cur.ratingKey === full.ratingKey) return;
    for (var i = 0; i < q.items.length; i++) if (q.items[i].ratingKey === full.ratingKey) { q.index = i; return; }
  };

  Player.prototype.loadChapters = function (full) {
    this.chapters = (full.Chapter || []).map(function (c, i) {
      return {
        start: (c.startTimeOffset || 0) / 1000, end: (c.endTimeOffset || 0) / 1000,
        title: c.tag || ('Chapter ' + (i + 1)), thumb: c.thumb || null,
      };
    }).sort(function (a, b) { return a.start - b.start; });
  };

  Player.prototype.loadQueue = function (full) {
    var self = this;
    PL.plex.createPlayQueue(full).then(function (mc) {
      var items = mc.Metadata || [];
      var idx = mc.playQueueSelectedItemOffset || 0;
      for (var i = 0; i < items.length; i++) if (items[i].ratingKey === full.ratingKey) { idx = i; break; }
      if (self.full !== full) return; // another episode started meanwhile
      self.queue = { items: items, index: idx };
      self.buildControls();
    }, function (err) { PL.warn('play queue failed', err && err.message); });
  };

  Player.prototype.streamParams = function (offsetSec, transcode) {
    var kind = this.live ? 'none' : subtitleKind(selectedSubtitle(this.full, this.mediaIndex));
    var burn = kind === 'image';
    if (kind === 'embedded') transcode = true;
    if (!this.live && hasAlternateAudio(this.full, this.mediaIndex)) transcode = true;
    var p = {
      path: this.live ? this.liveKey : '/library/metadata/' + this.full.ratingKey,
      mediaIndex: this.live ? 0 : this.mediaIndex,
      partIndex: 0,
      protocol: 'hls',
      fastSeek: 1,
      directPlay: transcode || burn || this.live ? 0 : 1,
      directStream: 1,
      directStreamAudio: 1,
      videoQuality: 100,
      videoResolution: '3840x2160',
      maxVideoBitrate: 200000,
      location: 'lan',
      subtitleSize: 100,
      audioBoost: 100,
      // 'none' keeps a selected text subtitle away from the server (it would burn it in);
      // we draw text subtitles ourselves.
      subtitles: burn ? 'burn' : kind === 'embedded' ? 'auto' : this.live ? 'auto' : 'none',
      advancedSubtitles: kind === 'embedded' ? 'text' : undefined,
      session: this.session,
      'X-Plex-Session-Identifier': this.session,
      'X-Plex-Client-Profile-Name': 'Generic',
      'X-Plex-Client-Profile-Extra': kind === 'embedded' ? PROFILE_EXTRA_VTT : PROFILE_EXTRA,
    };
    if (offsetSec > 0) p.offset = Math.floor(offsetSec);
    return p;
  };

  // offsetMs: where to start. Asks the server how to play, then points the video at it.
  Player.prototype.start = function (offsetMs) {
    var self = this;
    if (this.state === 'stopped') return;
    this.teardownVideo();
    this.stopTranscode();
    var gen = ++this.gen;
    // Live TV: Plex binds the tuned stream to the session id sent with the tune, so playback must
    // reuse it (a different id gets "Failed to find consumer" and no segments).
    this.session = this.live && this.liveSession ? this.liveSession : PL.uuid();
    this.state = 'loading';
    this.lastReported = null;
    this.setStatus(this.live ? 'Starting ' + (this.live.channel.title || 'channel') + '…' : 'Loading…', true);
    var offsetSec = (offsetMs || 0) / 1000;
    this.lastOffsetSec = offsetSec;
    this.everStarted = true;
    this.seekReq = null;
    var transcode = this.retried;
    var params = this.streamParams(offsetSec, transcode);
    PL.plex.get('/video/:/transcode/universal/decision', params, { timeout: 30000 }).then(function (mc) {
      if (gen !== self.gen) return;
      var code = mc.generalDecisionCode;
      if (code && code >= 2000) throw new Error(mc.generalDecisionText || 'The server cannot play this item');
      var media = mc.Metadata && mc.Metadata[0] && mc.Metadata[0].Media && mc.Metadata[0].Media[0];
      var part = media && media.Part && media.Part[0];
      if (part && part.decision === 'directplay' && !self.live) {
        self.mode = 'direct';
        self.base = 0;
        self.directStartSec = offsetSec;
        self.video.src = PL.plex.url(part.key);
      } else {
        self.mode = 'transcode';
        self.base = self.live || !(offsetSec > 0) ? 0 : Math.floor(offsetSec);
        self.video.src = PL.plex.url('/video/:/transcode/universal/start.m3u8', params);
      }
      self.convertReason = self.mode === 'transcode' && !self.live ? self.reasonFor(part) : null;
      PL.log('play', self.mode, self.live ? 'live' : self.full.ratingKey, 'at', Math.round(offsetSec) + 's');
      if (!self.live) self.setupSubs();
      var p = self.video.play();
      if (p && p.catch) p.catch(function (e) { PL.warn('play() rejected', e && e.message); });
      self.startTimeline();
    }).catch(function (err) { if (gen === self.gen) self.fail(err); });
  };

  // Why the server converts this stream, for the Info tab.
  Player.prototype.reasonFor = function (part) {
    var kind = subtitleKind(selectedSubtitle(this.full, this.mediaIndex));
    if (kind === 'image') return 'picture subtitles are burned in';
    if (kind === 'embedded') return 'subtitles';
    if (hasAlternateAudio(this.full, this.mediaIndex)) return 'another audio track';
    if (this.retried) return 'the TV could not play the file';
    var streams = (part && part.Stream) || [];
    var v = streams.filter(function (s) { return s.streamType === 1; })[0];
    var a = streams.filter(function (s) { return s.streamType === 2; })[0];
    if (v && v.decision === 'transcode') return 'video format';
    if (a && a.decision === 'transcode') return 'audio format';
    return 'the file\'s container';
  };

  Player.prototype.startTimeline = function () {
    var self = this;
    clearInterval(this.timelineTimer);
    this.timelineTimer = setInterval(function () { self.report(true); }, TIMELINE_MS);
  };

  // force: send even if the state has not changed (the periodic heartbeat).
  Player.prototype.report = function (force, stateOverride, atSec) {
    var state = stateOverride || (this.state === 'playing' ? 'playing' : this.state === 'paused' ? 'paused' : 'buffering');
    if (!force && state === this.lastReported) return;
    this.lastReported = state;
    var params;
    if (this.live) {
      if (!this.liveMeta) return;
      params = { ratingKey: this.liveMeta.ratingKey, key: this.liveMeta.key, state: state, time: Math.round((atSec != null ? atSec : this.position()) * 1000) };
    } else {
      if (!this.full) return;
      params = {
        ratingKey: this.full.ratingKey,
        key: '/library/metadata/' + this.full.ratingKey,
        state: state,
        time: Math.round((atSec != null ? atSec : this.position()) * 1000),
        duration: this.full.duration || Math.round(this.durationSec() * 1000),
      };
      var qi = this.queue && this.queue.items[this.queue.index];
      if (qi && qi.ratingKey === this.full.ratingKey && qi.playQueueItemID) params.playQueueItemID = qi.playQueueItemID;
    }
    params['X-Plex-Session-Identifier'] = this.session;
    PL.plex.timeline(params).catch(function (err) { PL.warn('timeline failed', err && err.message); });
  };

  // ---- Subtitles (drawn by the app) ---------------------------------------------------------------

  Player.prototype.subtitleState = function () {
    var st = selectedSubtitle(this.full, this.mediaIndex);
    return { kind: subtitleKind(st), stream: st, audio: selectedAudioId(this.full, this.mediaIndex) };
  };

  // Called after every (re)start: loads cues for the selected text subtitle, if any.
  Player.prototype.setupSubs = function () {
    var want = this.subtitleState();
    var sub = this.subs;
    clearInterval(sub.timer);
    sub.timer = null;
    sub.segs = {};
    sub.timing = null;
    sub.audio = want.audio;
    var id = want.stream ? want.stream.id : null;
    // embedded cues belong to one HLS session (their timing is decided per session)
    if (sub.id !== id || sub.kind !== want.kind || want.kind === 'embedded') {
      sub.cues = [];
      this.showSubText('');
    }
    sub.kind = want.kind;
    sub.id = id;
    if (want.kind === 'external') this.loadExternalSubs(want.stream);
    else if (want.kind === 'embedded' && this.mode === 'transcode') this.pollHlsSubs();
  };

  Player.prototype.loadExternalSubs = function (stream) {
    var self = this;
    var gen = this.gen;
    if (this.subs.cues.length && this.subs.loadedId === stream.id) return;
    PL.http('GET', PL.plex.url(stream.key, { encoding: 'utf-8' }), { text: true, timeout: 20000 }).then(function (text) {
      if (gen !== self.gen || self.subs.id !== stream.id) return;
      self.subs.cues = parseSubtitles(text);
      self.subs.loadedId = stream.id;
      PL.log('subtitles', stream.codec, self.subs.cues.length, 'cues');
      self.renderSubs();
    }, function (err) { PL.warn('subtitle load failed', err && err.message); PL.toast('Could not load these subtitles'); });
  };

  // Embedded text subtitles arrive as WebVTT segments of the HLS session; fetch the ones around
  // the playhead every few seconds.
  Player.prototype.pollHlsSubs = function () {
    var self = this;
    var session = this.session;
    var tick = function () {
      if (self.session !== session || self.state === 'stopped') return;
      var dir = '/video/:/transcode/universal/session/' + session + '/vtt-base/';
      PL.http('GET', PL.plex.url(dir + 'index.m3u8'), { text: true, timeout: 8000 }).then(function (m3u8) {
        if (self.session !== session) return;
        var t = 0;
        var segs = [];
        var dur = 0;
        String(m3u8).split('\n').forEach(function (line) {
          line = line.trim();
          if (line.indexOf('#EXTINF:') === 0) dur = parseFloat(line.slice(8)) || 0;
          else if (line && line.charAt(0) !== '#') { segs.push({ name: line, start: t, end: t + dur }); t += dur; }
        });
        var now = self.video.currentTime || 0;
        segs.filter(function (sg) { return sg.end > now - 10 && sg.start < now + 40; }).forEach(function (sg) {
          self.fetchVttSegment(dir, sg, session);
        });
      }, function () { /* not ready yet */ });
    };
    tick();
    this.subs.timer = setInterval(tick, 4000);
  };

  Player.prototype.fetchVttSegment = function (dir, sg, session) {
    var self = this;
    var st = this.subs.segs[sg.name] || (this.subs.segs[sg.name] = { tries: 0, done: false, busy: false });
    if (st.done || st.busy || st.tries >= 4) return;
    st.busy = true;
    st.tries++;
    var base = this.base;
    PL.http('GET', PL.plex.url(dir + sg.name), { text: true, timeout: 8000 }).then(function (text) {
      st.busy = false;
      if (self.session !== session) return;
      var cues = parseSubtitles(text);
      if (!cues.length) return; // empty until the transcoder reaches it, or a silent stretch
      st.done = true;
      // Cue times are either relative to the stream (which starts at `base`) or to the file.
      // Decided once per session, from the first segment that has cues.
      if (self.subs.timing == null) {
        var relative = Math.abs(cues[0].start - sg.start) < Math.abs(cues[0].start - (base + sg.start));
        self.subs.timing = relative ? base : 0;
        PL.log('subtitle timing', relative ? 'relative, +' + base + 's' : 'absolute');
      }
      var add = self.subs.timing;
      var have = {};
      self.subs.cues.forEach(function (c) { have[c.start.toFixed(2) + c.text] = 1; });
      cues.forEach(function (c) {
        var cue = { start: c.start + add, end: c.end + add, text: c.text };
        if (!have[cue.start.toFixed(2) + cue.text]) self.subs.cues.push(cue);
      });
      self.subs.cues.sort(function (a, b) { return a.start - b.start; });
      self.renderSubs();
    }, function () { st.busy = false; });
  };

  Player.prototype.renderSubs = function () {
    var cues = this.subs.cues;
    if (this.subs.kind === 'none' || this.subs.kind === 'image' || !cues.length) {
      if (this.subs.shown) this.showSubText('');
      return;
    }
    var t = this.position();
    var lo = 0;
    var hi = cues.length - 1;
    var idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    var lines = [];
    for (var i = idx; i >= 0 && i > idx - 6; i--) {
      if (cues[i].end > t) lines.unshift(cues[i].text);
    }
    this.showSubText(lines.join('\n').split('\n').slice(0, 3).join('\n'));
  };

  Player.prototype.showSubText = function (text) {
    if (text === this.subs.shown) return;
    this.subs.shown = text;
    this.subEl.textContent = text;
    this.subEl.style.display = text ? 'block' : 'none';
  };

  // After the track sheet: switch text subtitles in place; restart only when the stream must change.
  Player.prototype.onTracksChanged = function () {
    if (this.state === 'stopped' || !this.full) return;
    var now = this.subtitleState();
    var old = this.subs;
    var restart = now.audio !== old.audio;
    if (now.kind === 'image' || old.kind === 'image') restart = restart || now.kind !== old.kind || (now.stream && now.stream.id) !== old.id;
    if (now.kind === 'embedded' && !(this.mode === 'transcode' && old.kind === 'embedded' && old.id === now.stream.id)) restart = true;
    if (restart) {
      this.start(this.intendedPosition() * 1000);
      return;
    }
    this.setupSubs();
    this.renderSubs();
  };

  // ---- Live TV -------------------------------------------------------------------------------

  // Releases the old channel's tuner session first (the owner's tuner has one stream), then tunes.
  // Plex binds the stream to the X-Plex-Session-Identifier sent here: playback must reuse the id the
  // tuner answers with (see start()).
  Player.prototype.tune = function (channel) {
    var self = this;
    if (this.state === 'stopped') return;
    clearTimeout(this.channelTimer);
    var playing = this.live.channel;
    if (this.liveTuned && playing && playing.identifier !== channel.identifier) this.lastChannel = playing;
    this.teardownVideo();
    this.stopTranscode();
    var released = this.releaseLive();
    var gen = ++this.gen;
    this.live.channel = channel;
    this.programme = '';
    this.liveMeta = null;
    this.liveTuned = false;
    this.state = 'loading';
    this.paintText();
    this.showOsd();
    if (this.liveOsd) this.liveOsd.onTune(channel);
    this.setStatus('Tuning ' + (channel.title || 'channel') + '…', true);
    var session = PL.uuid();
    this.liveSession = session;
    released.then(function () {
      if (gen !== self.gen) return null;
      return PL.plex.request('POST', '/livetv/dvrs/' + self.live.dvrKey + '/channels/' + encodeURIComponent(channel.identifier) + '/tune',
        { 'X-Plex-Session-Identifier': session }, { timeout: 45000 });
    }).then(function (mc) {
      if (!mc && gen !== self.gen) return;
      var sub = mc && mc.MediaSubscription && mc.MediaSubscription[0];
      var op = sub && sub.MediaGrabOperation && sub.MediaGrabOperation[0];
      var meta = op && op.Metadata;
      if (!meta || !meta.key) throw new Error('The tuner did not start this channel');
      if (gen !== self.gen) {
        self.releaseLiveMeta(meta);
        return;
      }
      self.liveMeta = meta;
      self.liveKey = meta.key;
      // the stream path names the consumer the server attached: /livetv/sessions/<uuid>/<id>/index.m3u8
      var part = meta.Media && meta.Media[0] && meta.Media[0].Part && meta.Media[0].Part[0];
      var m = part && /\/livetv\/sessions\/[^/]+\/([^/?]+)\//.exec(part.key || '');
      self.liveSession = m ? m[1] : session;
      self.liveUuid = meta.Media && meta.Media[0] && meta.Media[0].uuid;
      self.liveTuned = true;
      var now = sub.Timeline && sub.Timeline.Metadata && sub.Timeline.Metadata[0];
      if (now) self.programme = now.grandparentTitle ? now.grandparentTitle + ' · ' + now.title : now.title;
      self.paintText();
      self.start(0);
    }).catch(function (err) {
      if (gen !== self.gen) return;
      // an HTTP error from the tune is almost always a busy tuner or a dead stream
      if (err && err.status >= 400) err = new Error('Couldn\'t tune ' + (channel.title || 'this channel') + '. The tuner may be busy, or the channel is off air.');
      self.fail(err);
      if (self.liveOsd) self.liveOsd.onState();
    });
  };

  // CH+ / CH−: the banner shows the next channel at once; the tune waits for the presses to stop.
  Player.prototype.changeChannel = function (dir) {
    var list = this.live.channels || [];
    if (!list.length) return;
    var i = this.channelIndex();
    var next = list[((i < 0 ? 0 : i + dir) + list.length) % list.length];
    this.tuneChannel(next, 600);
  };

  Player.prototype.channelIndex = function () {
    var list = this.live.channels || [];
    var id = this.live.channel && this.live.channel.identifier;
    for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return i;
    return -1;
  };

  // Tunes `channel` after `delay` ms (more presses within it move on without tuning each one).
  Player.prototype.tuneChannel = function (channel, delay) {
    var self = this;
    if (this.state === 'stopped' || !channel) return;
    clearTimeout(this.channelTimer);
    if (!delay) {
      this.tune(channel);
      return;
    }
    if (this.liveTuned && this.live.channel && this.live.channel.identifier !== channel.identifier && !this.pendingFrom) {
      this.pendingFrom = this.live.channel;
    }
    this.live.channel = channel;
    this.programme = '';
    this.paintText();
    this.showOsd();
    if (this.liveOsd) this.liveOsd.onTune(channel);
    this.channelTimer = setTimeout(function () {
      // the channel that was playing when the presses began is the "last channel"
      var from = self.pendingFrom;
      self.pendingFrom = null;
      self.live.channel = from || self.live.channel;
      self.tune(channel);
    }, delay);
  };

  Player.prototype.releaseLiveMeta = function (meta) {
    var uuid = meta && meta.Media && meta.Media[0] && meta.Media[0].uuid;
    if (uuid) PL.plex.request('DELETE', '/transcode/sessions/' + uuid).catch(function () {});
  };

  // Ends the tuner session. Resolves when the server has answered (or after 2 s), so a new tune
  // doesn't race the old one for the tuner.
  Player.prototype.releaseLive = function () {
    if (!this.liveUuid) return Promise.resolve();
    var uuid = this.liveUuid;
    this.liveUuid = null;
    var req = PL.plex.request('DELETE', '/transcode/sessions/' + uuid).catch(function () {});
    return Promise.race([req, new Promise(function (resolve) { setTimeout(resolve, 2000); })]);
  };


  // ---- Seeking ---------------------------------------------------------------------------------

  Player.prototype.canSeek = function () {
    return !this.live && !!this.full && (this.state === 'playing' || this.state === 'paused');
  };

  // Goes to `target` straight away. Direct play sets the video's time; while a seek is still landing
  // the newest target waits for it (onSeeked), so quick taps add up instead of piling up seeks. A
  // server stream restarts at the target; taps closer than JUMP_RESTART_MS share one restart
  // (immediate: restart now, for a deliberate single seek such as OK after scrubbing).
  Player.prototype.seekNow = function (target, immediate) {
    var self = this;
    var dur = this.durationSec();
    target = dur > 0 ? PL.clamp(target, 0, Math.max(0, dur - 5)) : Math.max(0, target);
    if (this.mode === 'direct') {
      // the bar moves first: setting the video's time stalls the TV for ~100 ms, so the seek goes
      // out just after the next frame (and waits behind a seek that is still landing)
      this.jumpTarget = target;
      if (!this.flushPending) {
        this.flushPending = true;
        requestAnimationFrame(function () {
          setTimeout(function () {
            self.flushPending = false;
            self.flushJump();
          }, 0);
        });
      }
    } else if (immediate) {
      clearTimeout(this.jumpTimer);
      this.jumpTarget = null;
      this.start(target * 1000);
    } else {
      this.jumpTarget = target;
      clearTimeout(this.jumpTimer);
      this.jumpTimer = setTimeout(function () {
        var t = self.jumpTarget;
        self.jumpTarget = null;
        if (t != null && self.state !== 'stopped') self.start(t * 1000);
      }, JUMP_RESTART_MS);
    }
    this.paintSoon();
  };

  Player.prototype.flushJump = function () {
    var t = this.jumpTarget;
    if (t == null || this.mode !== 'direct' || this.state === 'stopped') return;
    var req = this.seekReq;
    if (req && req.seekedAt == null && Date.now() - req.at < 3000) return; // onSeeked sends it
    this.jumpTarget = null;
    this.directSeek(t);
  };

  Player.prototype.seekTo = function (sec) { this.seekNow(sec, true); };

  // Left/Right on the bar while playing: −10 s / +30 s, at once; repeated taps add up.
  Player.prototype.jump = function (delta) {
    if (!this.canSeek()) return;
    var from = this.shownPosition();
    var now = Date.now();
    this.lastJump = { from: from, at: now };
    this.hold = { dir: delta > 0 ? 1 : -1, since: now, last: now };
    this.lastSeekAt = now;
    this.showOsd('bar');
    this.seekNow(from + delta);
  };

  // The paused-look scrub: holding Left/Right while playing, or Left/Right while paused. The video
  // pauses; the bar keeps the real position (teal tick) and moves a target with a preview. OK jumps
  // there and plays, Back returns. A hold that follows a tap scrubs from before that tap.
  Player.prototype.scrubBegin = function (held) {
    var now = Date.now();
    var at = this.shownPosition();
    var lj = this.lastJump;
    var real = held && lj && now - lj.at < 1500 ? lj.from : at;
    if (this.mode !== 'direct' && this.jumpTarget != null) {
      // the stream restart for that tap hasn't gone out: drop it, nothing moved yet
      clearTimeout(this.jumpTimer);
      this.jumpTarget = null;
      real = this.position();
    }
    var playing = this.state === 'playing' && !this.video.paused;
    this.scrubState = { real: real, target: at, wasPlaying: playing };
    this.lastJump = null;
    if (playing) this.video.pause();
    this.paintState();
    this.showOsd('bar');
  };

  // A tap moves the target 10 s (quick taps 30 s, then 60 s); a held key moves it at a speed that
  // grows the longer it is held.
  Player.prototype.scrubStep = function (dir, held) {
    if (!this.canSeek()) return;
    if (!this.scrubState) this.scrubBegin(held);
    var now = Date.now();
    var h = this.hold;
    var delta;
    if (held && h && h.dir === dir && now - h.last < HOLD_GAP_MS) {
      delta = L.holdSpeed(now - h.since, this.durationSec()) * Math.min(250, now - h.last) / 1000;
      h.last = now;
    } else {
      this.seekPresses = now - this.lastSeekAt < 400 ? this.seekPresses + 1 : 0;
      delta = this.seekPresses > 8 ? 60 : this.seekPresses > 3 ? 30 : 10;
      this.hold = { dir: dir, since: now, last: now };
    }
    this.lastSeekAt = now;
    var s = this.scrubState;
    s.target = PL.clamp(s.target + dir * delta, 0, Math.max(0, this.durationSec() - 5));
    this.showOsd('bar');
    this.paintSoon();
  };

  Player.prototype.endScrub = function () {
    this.scrubState = null;
    this.hold = null;
    this.paintState();
    this.paintSoon();
  };

  Player.prototype.scrubCommit = function () {
    var s = this.scrubState;
    if (!s) return;
    this.endScrub();
    var moved = Math.abs(s.target - this.shownPosition()) >= 1;
    if (moved) this.seekNow(s.target, true);
    if (!moved || this.mode === 'direct') this.togglePause(true);
    this.showOsd('bar');
  };

  Player.prototype.scrubCancel = function () {
    var s = this.scrubState;
    if (!s) return;
    this.endScrub();
    var moved = Math.abs(this.shownPosition() - s.real) >= 1;
    if (moved) this.seekNow(s.real, true);
    if (s.wasPlaying && (!moved || this.mode === 'direct')) this.togglePause(true);
    this.showOsd('bar');
  };

  // webOS snaps direct-play seeks back to the previous keyframe. If a seek lands more than 1 s
  // early, seek once more by the shortfall (capped) so we land on the keyframe after the target.
  Player.prototype.directSeek = function (target) {
    this.seekReq = { target: target, retried: false, first: null, at: Date.now() };
    this.video.currentTime = target;
  };

  // The webOS pipeline reports the requested time on 'seeked', then resumes from the previous
  // keyframe (seen 6-10 s early). So the landing is judged on the playback that follows: if it
  // resumed more than 3 s short, seek once more, past the target by the shortfall (playbackRate
  // trick-play freezes on this TV, so exact landing is not possible). A jump that arrived while
  // this seek was landing goes out now.
  Player.prototype.onSeeked = function () {
    var req = this.seekReq;
    if (!req || this.mode !== 'direct') return;
    if (this.jumpTarget != null) {
      var t = this.jumpTarget;
      this.jumpTarget = null;
      this.directSeek(t);
      return;
    }
    req.seekedAt = Date.now();
    if (!this.osdHidden) this.paintBar();
  };

  Player.prototype.verifySeek = function () {
    var req = this.seekReq;
    if (!req || req.seekedAt == null || this.mode !== 'direct') return;
    var now = this.video.currentTime;
    var short = req.target - now;
    if (short > 3 && !req.retried) {
      req.retried = true;
      req.first = now;
      req.seekedAt = null;
      req.at = Date.now();
      var dur = this.durationSec();
      var retry = req.target + Math.min(12, short);
      if (dur) retry = Math.max(req.target, Math.min(retry, dur - 1));
      this.video.currentTime = retry;
      return;
    }
    if (Date.now() - req.seekedAt > 1500) {
      PL.log('seek', req.target.toFixed(1), (req.first == null ? now : req.first).toFixed(1), now.toFixed(1));
      this.seekReq = null;
    }
  };

  // ---- Markers: Skip Intro / Skip Credits ---------------------------------------------------------

  // The skip pill is a real button: it takes the remote's focus when it appears (OK skips), stays for
  // PILL_MS, and comes back whenever the controls are opened while the marker is playing.
  // markerState.pill: {kind: 'intro' | 'credits', id, start, target, shownAt, timedOut}
  Player.prototype.showPill = function (kind, label, start, target, id) {
    var st = this.markerState;
    st.pill = { kind: kind, id: id, start: start, target: target, shownAt: Date.now(), timedOut: false };
    this.pillLabel.textContent = label;
    if (this.mayTakeFocus()) this.zone = 'cta';
    this.paintZone();
  };

  // Skip / Up Next take the focus from the bar, but not while the remote is in use (a tap on the bar
  // must not land on the pill that just appeared).
  Player.prototype.mayTakeFocus = function () {
    return !this.osdHidden && this.zone === 'bar' && !this.scrubState && Date.now() - (this.lastKeyAt || 0) > 2000;
  };

  Player.prototype.pillShown = function () {
    var p = this.markerState && this.markerState.pill;
    return !!p && !this.upnextNext && (!p.timedOut || !this.osdHidden);
  };

  // The call to action on screen: the end card, else the skip pill.
  Player.prototype.cta = function () {
    return this.upnextNext ? 'endcard' : this.pillShown() ? 'pill' : null;
  };

  // Lit (white) while it has the remote's focus: always while the controls are hidden, and in the
  // controls' 'cta' zone. Hidden while a menu or a tab is open (CSS).
  Player.prototype.paintCta = function () {
    var vis = this.pillShown();
    this.pillVisible = vis;
    var focus = this.osdHidden || this.zone === 'cta';
    this.skip.classList.toggle('skip-hidden', !vis);
    this.pill.classList.toggle('focused', vis && focus);
    var ec = !!this.upnextNext;
    this.endcard.classList.toggle('endcard-hidden', !ec);
    this.el.classList.toggle('endcard-on', ec);
    this.ecWatch.classList.toggle('focused', ec && focus && this.ecIndex === 0);
    this.ecNext.classList.toggle('focused', ec && focus && this.ecIndex === 1);
    this.paintCtaLine();
  };

  // The teal line along the pill's bottom: how much of the intro (or credits) is left.
  Player.prototype.paintCtaLine = function () {
    var p = this.pillVisible && this.markerState && this.markerState.pill;
    if (!p) return;
    var end = p.kind === 'intro' ? p.target : this.durationSec();
    var f = end > p.start ? PL.clamp((end - this.position()) / (end - p.start), 0, 1) : 0;
    this.setPainted('pill-line', this.pillLine, 'transform', 'scaleX(' + f.toFixed(3) + ')');
  };

  Player.prototype.pressCta = function () {
    if (this.upnextNext) {
      if (this.ecIndex === 1) this.playNext();
      else this.watchCredits();
      return true;
    }
    return this.activatePill();
  };

  // Back (or Watch Credits) on the end card: keep watching; after the video has ended, leave.
  Player.prototype.watchCredits = function () {
    var ended = this.state === 'ended';
    this.hideUpNext();
    if (ended) this.exit();
  };

  Player.prototype.dismissCta = function () {
    if (this.upnextNext) this.watchCredits();
    else this.dismissPill();
  };

  Player.prototype.hidePill = function () {
    if (this.markerState) this.markerState.pill = null;
    this.paintZone();
  };

  // Back while only the pill is up: put it away until the controls are opened again.
  Player.prototype.dismissPill = function () {
    var p = this.markerState && this.markerState.pill;
    if (p) p.timedOut = true;
    this.paintZone();
  };

  Player.prototype.introAt = function (pos) {
    var m = this.markers;
    if (!m) return null;
    for (var i = 0; i < m.intros.length; i++) {
      if (pos >= m.intros[i].start && pos < m.intros[i].end - 1) return { id: i, start: m.intros[i].start, end: m.intros[i].end };
    }
    return null;
  };

  // Runs on every timeupdate (about 4 times a second).
  Player.prototype.checkMarkers = function () {
    var m = this.markers;
    var st = this.markerState;
    if (this.live || !m || !st || this.state !== 'playing' || this.scrubState) return;
    var pos = this.position();
    var now = Date.now();
    var pill = st.pill;
    var intro = this.introAt(pos);
    if (intro && !st.introDone[intro.id]) {
      if (setting('autoSkipIntro', false)) {
        st.introDone[intro.id] = true;
        this.seekTo(intro.end);
        PL.toast('Skipped intro', 2000);
        return;
      }
      if (!pill || pill.kind !== 'intro' || pill.id !== intro.id) this.showPill('intro', 'Skip Intro', intro.start, intro.end, intro.id);
      else if (!pill.timedOut && now - pill.shownAt > PILL_MS) { pill.timedOut = true; this.paintZone(); }
      return;
    }
    if (pill && pill.kind === 'intro') this.hidePill();

    var inCredits = m.creditsStart != null && pos >= m.creditsStart;
    if (!inCredits) {
      if (st.creditsHandled) {
        // seeked back out of the credits: allow them to trigger again
        st.creditsHandled = false;
        if (this.upnextNext && this.state === 'playing') this.hideUpNext();
        if (pill && pill.kind === 'credits') this.hidePill();
      }
      return;
    }
    if (st.creditsHandled) {
      if (pill && pill.kind === 'credits' && !pill.timedOut && now - pill.shownAt > PILL_MS) { pill.timedOut = true; this.paintZone(); }
      return;
    }
    st.creditsHandled = true;
    var next = this.nextItem();
    var auto = setting('autoSkipCredits', false);
    if (next) {
      if (auto) this.playNext();
      else this.showUpNext(next);
      return;
    }
    if (!m.creditsFromMarker) return;
    if (auto) this.finishCredits();
    else this.showPill('credits', 'Skip Credits', m.creditsStart, null, 0);
  };

  Player.prototype.finishCredits = function () {
    if (this.full) PL.plex.setWatched(this.full.ratingKey, true).catch(function () {});
    this.exit();
  };

  Player.prototype.activatePill = function () {
    var st = this.markerState;
    var p = st && st.pill;
    if (!p || !this.pillVisible) return false;
    this.hidePill();
    if (p.kind === 'intro') {
      st.introDone[p.id] = true;
      this.seekTo(p.target);
      if (!this.osdHidden) this.hideOsd();
    } else {
      this.skipCredits();
    }
    return true;
  };

  Player.prototype.skipCredits = function () {
    if (this.nextItem()) this.playNext();
    else this.finishCredits();
  };

  // Fast-forward (and the media "next" key): inside an intro it jumps to the intro's end, inside
  // marked end credits it does what Skip Credits does (Up Next or finish); otherwise +30 s.
  Player.prototype.skipForward = function () {
    if (!this.canSeek()) return;
    var m = this.markers;
    if (m && !this.scrubState) {
      var pos = this.intendedPosition();
      var intro = this.introAt(pos);
      if (intro) {
        this.markerState.introDone[intro.id] = true;
        this.hidePill();
        this.seekTo(intro.end);
        PL.toast('Skipped intro', 2000);
        return;
      }
      if (m.creditsFromMarker && m.creditsStart != null && pos >= m.creditsStart - 1) {
        this.hidePill();
        this.skipCredits();
        return;
      }
    }
    if (this.scrubState) this.scrubStep(1, false);
    else this.jump(30);
  };

  // ---- Ending, errors, next episode -----------------------------------------------------------

  Player.prototype.markWatchedIfDone = function (pos) {
    var dur = this.durationSec();
    if (this.live || !this.full || !dur || pos / dur < 0.9) return;
    PL.plex.setWatched(this.full.ratingKey, true).catch(function () {});
  };

  Player.prototype.nextItem = function () {
    var q = this.queue;
    return q && q.items[q.index + 1] ? q.items[q.index + 1] : null;
  };

  Player.prototype.onEnded = function () {
    if (this.live) {
      this.fail(new Error('The channel stopped'));
      return;
    }
    var dur = this.durationSec();
    this.report(true, 'stopped');
    this.markWatchedIfDone(dur);
    this.stopTranscode();
    clearInterval(this.timelineTimer);
    this.state = 'ended';
    this.hidePill();
    var next = this.nextItem();
    if (!next) {
      this.exit();
      return;
    }
    if (setting('autoSkipCredits', false)) {
      this.playNext();
      return;
    }
    if (!this.upnextNext) {
      this.showUpNext(next);
    } else {
      this.hideOsd();
      this.ecWatch.textContent = 'Close';
      this.paintZone();
    }
  };

  // The end card: shown at the end credits (video still playing) or when the video ends. "Next
  // Episode" has the focus and counts down (if autoplay is on); Watch Credits keeps playing.
  Player.prototype.showUpNext = function (next) {
    var self = this;
    var left = 10;
    var countdown = setting('autoplayNext', true);
    clearTimeout(this.upnextTimer);
    if (this.state === 'ended') this.hideOsd();
    if (this.markerState) this.markerState.pill = null;
    this.upnextNext = next;
    this.ecIndex = 1;
    if (this.mayTakeFocus()) this.zone = 'cta';
    var ep = episodeCode(next);
    this.ecLabel.textContent = 'Up next' + (ep ? ' · ' + ep : '');
    this.ecTitle.textContent = next.title || '';
    this.ecMeta.textContent = L.runtime(next.duration);
    PL.clear(this.ecThumb);
    var src = next.thumb && PL.plex.image(next.thumb, 320, 180);
    if (src) {
      var img = PL.el('img');
      img.src = src;
      this.ecThumb.appendChild(img);
    }
    this.ecWatch.textContent = this.state === 'ended' ? 'Close' : 'Watch Credits';
    this.ecCount.textContent = '';
    this.ecNext.classList.toggle('counting', countdown);
    this.ecLine.classList.remove('run');
    this.paintZone();
    if (!countdown) return;
    void this.ecLine.offsetWidth; // restart the line's transition from full
    this.ecLine.classList.add('run');
    var tick = function () {
      self.ecCount.textContent = 'in ' + left;
      if (left-- <= 0) {
        self.playNext();
        return;
      }
      self.upnextTimer = setTimeout(tick, 1000);
    };
    tick();
  };

  Player.prototype.hideUpNext = function () {
    clearTimeout(this.upnextTimer);
    if (!this.upnextNext) return;
    this.upnextNext = null;
    this.ecLine.classList.remove('run');
    this.paintZone();
  };

  // manual: the Next episode icon or an Episodes card, which can be pressed anywhere in the episode
  // (it only counts as watched past 90%); otherwise we are in the credits and it counts as watched.
  // pick: the episode to play (default: the next one in the queue).
  Player.prototype.playNext = function (manual, pick) {
    var next = pick || this.upnextNext || this.nextItem();
    this.hideUpNext();
    this.hidePill();
    if (!next) return this.exit();
    clearTimeout(this.jumpTimer);
    this.jumpTarget = null;
    this.scrubState = null;
    this.hold = null;
    this.closeMenu(true);
    this.closeTab(true);
    if (this.state !== 'ended') {
      var pos = this.intendedPosition();
      this.gen++;
      clearInterval(this.timelineTimer);
      this.report(true, 'stopped', pos);
      if (manual === true) this.markWatchedIfDone(pos);
      else if (this.full) PL.plex.setWatched(this.full.ratingKey, true).catch(function () {});
      this.teardownVideo();
      this.stopTranscode();
      PL.log(manual === true ? 'next episode (button) at' : 'next episode from credits at', Math.round(pos) + 's');
    }
    this.markers = null;
    this.markerState = null;
    this.mediaIndex = 0;
    this.chapters = [];
    clearInterval(this.subs.timer);
    this.showSubText(''); // before the reset: it skips text equal to what is shown
    this.subs = { kind: 'none', id: null, cues: [], shown: '', segs: {}, timer: null };
    this.everStarted = false;
    this.mode = null;
    this.base = 0;
    this.lastOffsetSec = 0;
    var qi = this.queue ? indexOfKey(this.queue.items, next.ratingKey) : -1;
    if (qi >= 0) this.queue.index = qi;
    else this.queue = null; // an episode outside the queue: begin() makes a new one
    this.item = next;
    this.full = null;
    this.retried = false;
    this.startOffset = pick && pick.viewOffset ? pick.viewOffset : 0;
    this.state = 'idle';
    this.iconIndex = 0;
    this.tabIndex = 0;
    this.buildControls();
    this.paintState();
    this.hideOsd();
    this.begin();
  };

  Player.prototype.onVideoError = function () {
    if (!this.video.getAttribute('src') || this.state === 'stopped' || this.state === 'error' || this.state === 'ended') return;
    var err = this.video.error;
    PL.warn('video error', err && err.code, this.mode);
    if (this.mode === 'direct' && !this.retried) {
      this.retried = true;
      this.start(this.intendedPosition() * 1000);
      return;
    }
    this.fail(new Error('This video could not be played on the TV' + (err ? ' (code ' + err.code + ')' : '')));
  };

  Player.prototype.fail = function (err) {
    PL.warn('playback failed', err && err.message);
    this.state = 'error';
    clearTimeout(this.jumpTimer);
    this.jumpTarget = null;
    this.endScrub();
    clearInterval(this.timelineTimer);
    this.teardownVideo();
    this.stopTranscode();
    this.setStatus(PL.errorMessage(err) + (this.live ? '  ·  Choose another channel, or press Back' : '  ·  Press Back to return'), false);
    PL.toast(PL.errorMessage(err));
  };

  // ---- Stopping --------------------------------------------------------------------------------

  Player.prototype.teardownVideo = function () {
    var v = this.video;
    if (!v.getAttribute('src')) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
  };

  Player.prototype.stopTranscode = function () {
    if (this.session && this.mode === 'transcode') {
      var session = this.session;
      PL.plex.get('/video/:/transcode/universal/stop', { session: session }).catch(function () {});
    }
  };

  Player.prototype.stop = function () {
    if (this.state === 'stopped') return;
    var wasPlaying = (this.everStarted || !!this.lastReported) && this.lastReported !== 'stopped';
    var pos = this.intendedPosition();
    this.gen++;
    clearInterval(this.timelineTimer);
    clearTimeout(this.osdTimer);
    clearTimeout(this.jumpTimer);
    clearTimeout(this.channelTimer);
    clearInterval(this.subs.timer);
    this.showSubText('');
    this.hideUpNext();
    this.hidePill();
    if (wasPlaying) {
      this.report(true, 'stopped', pos);
      this.markWatchedIfDone(pos);
    }
    this.state = 'stopped';
    this.teardownVideo();
    this.stopTranscode();
    this.releaseLive();
    if (this.liveOsd) {
      this.liveOsd.destroy();
      // the guide focuses the channel that was on
      if (PL.liveGuide && this.live.channel) PL.liveGuide.watching = this.live.channel.identifier;
    }
  };

  // Removes this player even if sheets are open above it.
  Player.prototype.exit = function () {
    this.stop();
    if (this.exited) return;
    this.exited = true;
    if (PL.app.stack.indexOf(this) === -1) return;
    while (PL.app.top() !== this) {
      if (!PL.app.pop()) return;
    }
    PL.app.pop();
  };

  Player.prototype.onHidden = function () {
    if (!this.exited) this.exit();
  };
  // Parked under another full screen: pause, and resume on show if it was playing.
  Player.prototype.hide = function () {
    this.resumeOnShow = this.state === 'playing' && !this.video.paused;
    if (this.resumeOnShow) this.video.pause();
  };
  Player.prototype.destroy = function () { this.stop(); };

  // ---- Keys -------------------------------------------------------------------------------------

  Player.prototype.togglePause = function (want) {
    var v = this.video;
    if (this.state !== 'playing' && this.state !== 'paused') return;
    var play = want == null ? v.paused : want;
    if (play) {
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      v.pause();
    }
    this.showOsd();
  };

  var KEY_NAMES = {};
  KEY_NAMES[K.LEFT] = 'left';
  KEY_NAMES[K.RIGHT] = 'right';
  KEY_NAMES[K.UP] = 'up';
  KEY_NAMES[K.DOWN] = 'down';
  KEY_NAMES[K.ENTER] = 'ok';
  // actions a held key repeats; everything else happens once per press
  var REPEATS = /^(jump-|scrub-|menu-up|menu-down|tab-|card-prev|card-next|icon-prev|icon-next|cta-prev|cta-next)/;

  // The remote: media keys here, everything else through the map in js/player-logic.js
  // (L.keyAction; the table is in docs/PLAYER-v2-design.md, "Remote").
  Player.prototype.key = function (code, e) {
    var repeat = !!(e && e.repeat);
    // a key-down with no key-up since the last one is the key being held (in case e.repeat isn't
    // set). Only real key-downs count: the Magic Remote's wheel arrives as synthetic keys with no
    // key-up.
    var real = !!e && e.type === 'keydown';
    this.lastKeyAt = Date.now();
    var held = repeat || (real && !!this.held[code]);
    if (real) this.held[code] = true;
    // a channel: every key goes to the live controls (tuning, failed or playing alike)
    if (this.liveOsd) return this.liveOsd.key(code, held);
    var back = PL.isBack(code);
    if (back && (this.state === 'error' || this.state === 'loading' || this.state === 'idle')) {
      if (held) return true;
      // a stream restart (seek, track change) is 'loading' too: close a menu or tab before leaving
      if (this.menu) this.menuBack();
      else if (this.tabOpen() && !this.osdHidden) this.closeTab();
      else this.exit();
      return true;
    }
    if (code === K.STOP) { this.exit(); return true; }
    if (this.state === 'error') return true;

    // media keys work the same whether the controls are up or not
    switch (code) {
      case K.PLAY_PAUSE:
        if (this.scrubState) this.scrubCommit();
        else if (this.upnextNext && this.state === 'ended') { if (!held) this.playNext(); }
        else if (!held) this.togglePause();
        return true;
      case K.PLAY:
        if (this.scrubState) this.scrubCommit();
        else if (this.upnextNext && this.state === 'ended') this.playNext();
        else this.togglePause(true);
        return true;
      case K.PAUSE: this.togglePause(false); return true;
      case K.FF:
      case K.NEXT_TRACK:
        if (this.live) this.showOsd();
        else if (this.upnextNext) { if (!held) this.playNext(); }
        else this.skipForward();
        return true;
      case K.REW:
      case K.PREV_TRACK:
        if (this.live) this.showOsd();
        else if (this.scrubState || held) this.scrubStep(-1, held);
        else this.jump(-10);
        return true;
      case K.CH_UP:
      case K.CH_DOWN:
        if (this.live) this.changeChannel(code === K.CH_UP ? 1 : -1);
        return true;
      case K.INFO:
        if (this.osdHidden) this.showOsd();
        else this.hideOsd();
        return true;
      default:
        break;
    }
    var name = back ? 'back' : KEY_NAMES[code];
    if (!name) return true;
    if (this.state === 'ended' && !this.upnextNext) return true;
    var action = L.keyAction({
      hidden: this.osdHidden, zone: this.zone, cta: this.cta(), live: !!this.live, playable: this.canSeek(),
      paused: this.state === 'paused', scrubbing: !!this.scrubState, held: held,
      hasIcons: this.icons.length > 0, hasTabs: this.tabs.length > 0, hasCards: this.hasCards(),
    }, name);
    if (!action || (held && !REPEATS.test(action))) {
      if (!this.osdHidden) this.showOsd();
      return true;
    }
    this.act(action, held);
    if (!this.osdHidden && action !== 'hide') this.showOsd();
    return true;
  };

  Player.prototype.act = function (action, held) {
    var tab = this.tabs[this.tabIndex];
    switch (action) {
      case 'exit': this.exit(); break;
      case 'hide': this.hideOsd(); break;
      case 'show': this.showOsd('bar'); break;
      case 'show-cta': this.showOsd('cta'); break;
      case 'jump-back': this.jump(-10); break;
      case 'jump-fwd': this.jump(30); break;
      case 'scrub-back': this.scrubStep(-1, held); break;
      case 'scrub-fwd': this.scrubStep(1, held); break;
      case 'commit': this.scrubCommit(); break;
      case 'cancel': this.scrubCancel(); break;
      case 'pause': this.togglePause(false); break;
      case 'play': this.togglePause(true); break;
      case 'zone-bar': this.closeTab(true); this.showOsd('bar'); break;
      case 'zone-icons': this.showOsd('icons'); break;
      case 'zone-cta': this.showOsd('cta'); break;
      case 'zone-tabs':
        if (this.zone === 'cards') this.showOsd('tabs');
        else this.focusTab(this.tabIndex);
        break;
      case 'zone-cards':
        this.showOsd('cards');
        if (tab) this.paintCards(tab);
        break;
      case 'icon-prev': this.iconIndex = Math.max(0, this.iconIndex - 1); this.showOsd('icons'); break;
      case 'icon-next': this.iconIndex = Math.min(this.icons.length - 1, this.iconIndex + 1); this.showOsd('icons'); break;
      case 'icon-press': if (this.icons[this.iconIndex]) this.icons[this.iconIndex].action(); break;
      case 'menu-up': this.moveMenu(-1); break;
      case 'menu-down': this.moveMenu(1); break;
      case 'menu-press': this.pressMenu(); break;
      case 'menu-back': this.menuBack(); break;
      case 'tab-prev': this.moveTab(-1); break;
      case 'tab-next': this.moveTab(1); break;
      case 'card-prev': this.moveCard(-1); break;
      case 'card-next': this.moveCard(1); break;
      case 'card-press': this.pressCard(); break;
      case 'cta-prev': this.ecIndex = 0; this.paintCta(); break;
      case 'cta-next': this.ecIndex = 1; this.paintCta(); break;
      case 'cta-press': this.pressCta(); break;
      case 'cta-dismiss': this.dismissCta(); break;
      default: break;
    }
  };

  // Releasing Left/Right ends a hold (a scrub stays until OK or Back).
  Player.prototype.keyUp = function (code) {
    delete this.held[code];
    if ((code === K.LEFT || code === K.RIGHT || code === K.REW || code === K.FF) && this.hold) this.hold = null;
  };

  screens.player = function (item, opts) { return new Player(item, opts); };
})();
