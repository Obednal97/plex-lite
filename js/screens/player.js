// Video player: library items (direct play or server stream) and Live TV channels.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var K = PL.KEY;
  var SCRUB_W = 1728;
  var BUBBLE_W = 240;
  var OSD_HIDE_MS = 4000;
  var SEEK_COMMIT_MS = 800;   // after the last tap (or key release) the seek goes to the TV
  var SEEK_HOLD_MS = 1500;    // fallback commit while a key is down, in case its key-up never comes
  var HOLD_GAP_MS = 600;      // key-downs closer than this without a key-up count as a held key
  var TIMELINE_MS = 10000;

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
    this.subs = { kind: 'none', id: null, cues: [], shown: '', segs: {}, timer: null };
    this.gen = 0;
    this.state = 'idle';
    this.mode = null;
    this.base = 0;
    this.session = null;
    this.queue = opts.queue && opts.queue.items && opts.queue.items.length ? opts.queue : null;
    this.retried = false;
    this.pendingSeek = null;
    this.seekPresses = 0;
    this.lastSeekAt = 0;
    this.lastReported = null;
    this.osdHidden = true;
    this.zone = 'bar';        // what the remote steers while the overlay is up: 'bar' | 'buttons' | 'pill'
    this.held = {};           // keys down without a key-up yet
    this.hold = null;         // {dir, since, last} while Left/Right is held on the bar
    this.hoverSec = null;     // pointer over the bar: the time under it
    this.painted = {};        // last values written to the DOM, so unchanged ones aren't rewritten
    this.build();
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

    // The overlay: title, the seek bar with times, and a row of buttons.
    var osd = this.osd = PL.el('div', 'osd faded');
    osd.appendChild(PL.el('div', 'osd-shade'));
    var text = this.osdText = PL.el('div', 'osd-text');
    this.eyebrow = PL.el('div', 'osd-eyebrow');
    this.title = PL.el('div', 'osd-title');
    text.appendChild(this.eyebrow);
    text.appendChild(this.title);
    osd.appendChild(text);

    var scrub = this.scrub = PL.el('div', 'scrub');
    var track = PL.el('div', 'scrub-track');
    this.bufferBar = PL.el('div', 'scrub-buffer');
    this.playedBar = PL.el('div', 'scrub-played');
    this.ticks = PL.el('div', 'scrub-ticks');
    [this.bufferBar, this.playedBar, this.ticks].forEach(function (n) { track.appendChild(n); });
    scrub.appendChild(track);
    this.head = PL.el('div', 'scrub-head');
    this.head.appendChild(PL.el('div', 'scrub-thumb'));
    scrub.appendChild(this.head);
    this.bubble = PL.el('div', 'scrub-bubble');
    this.bubbleTime = PL.el('span', 'scrub-bubble-time');
    this.bubbleDelta = PL.el('span', 'scrub-bubble-delta');
    this.bubble.appendChild(this.bubbleTime);
    this.bubble.appendChild(this.bubbleDelta);
    scrub.appendChild(this.bubble);
    var hit = PL.el('div', 'scrub-hit');
    scrub.appendChild(hit);
    osd.appendChild(scrub);

    var times = PL.el('div', 'osd-times');
    this.elapsed = PL.el('span', 'left');
    this.remaining = PL.el('span', 'right');
    times.appendChild(this.elapsed);
    times.appendChild(this.remaining);
    osd.appendChild(times);

    this.row = new PL.ui.ButtonRow([]);
    this.row.el.classList.add('osd-buttons');
    osd.appendChild(this.row.el);

    this.subEl = PL.el('div', 'subs');
    el.appendChild(this.subEl);
    el.appendChild(osd);

    this.upnext = PL.el('div', 'upnext upnext-hidden');
    this.upnextLabel = PL.el('div', 'upnext-label');
    this.upnextTitle = PL.el('div', 'upnext-title');
    var upBtn = PL.el('div', 'upnext-btn');
    upBtn.appendChild(PL.ui.icon('play'));
    upBtn.appendChild(PL.el('span', '', 'Play next episode'));
    this.upnextHint = PL.el('div', 'upnext-hint', 'Back to keep watching');
    [this.upnextLabel, this.upnextTitle, upBtn, this.upnextHint].forEach(function (n) { self.upnext.appendChild(n); });
    el.appendChild(this.upnext);
    this.upnext.addEventListener('click', function () { if (self.upnextNext) self.playNext(); });

    this.pill = PL.el('div', 'skip-pill skip-pill-hidden');
    this.pill.appendChild(PL.ui.icon('skip'));
    this.pillLabel = PL.el('span', '', '');
    this.pill.appendChild(this.pillLabel);
    el.appendChild(this.pill);
    this.pillVisible = false;
    this.pill.addEventListener('click', function (e) { e.stopPropagation(); self.activatePill(); });

    this.paintSoon = PL.rafThrottle(function () { self.paintScrub(); });
    this.bindPointer(hit);

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
      self.paintPlayButton();
      // a new stream or a resume brings the overlay up; recovering from a stall doesn't
      if (was !== 'playing' || !self.osdHidden) self.showOsd();
    });
    on('pause', function () {
      if (v.ended || (self.state !== 'playing' && self.state !== 'paused')) return;
      self.state = 'paused';
      self.report();
      self.paintPlayButton();
      self.showOsd();
    });
    on('waiting', function () {
      if (self.state === 'playing') self.setStatus('', true);
    });
    on('timeupdate', function () {
      self.verifySeek();
      if (!self.osdHidden) self.paintScrub();
      self.renderSubs();
      self.checkMarkers();
    });
    on('progress', function () { if (!self.osdHidden) self.paintScrub(); });
    on('ended', function () { self.onEnded(); });
    on('error', function () { self.onVideoError(); });
  };

  // Magic Remote / mouse: moving wakes the overlay, the bar seeks where it is clicked and shows the
  // time under the pointer, the buttons and the skip pill click (their hover look is CSS).
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
      return dur ? PL.clamp((e.clientX - rect.left) / rect.width, 0, 1) * dur : null;
    };
    hit.addEventListener('mouseenter', function () { rect = hit.getBoundingClientRect(); });
    hit.addEventListener('mousemove', function (e) {
      if (self.live || self.osdHidden) return;
      self.hoverSec = secAt(e);
      self.scrub.classList.add('hovering');
      self.osd.classList.add('scrubbing');
      self.paintSoon();
    });
    hit.addEventListener('mouseleave', function () {
      self.hoverSec = null;
      self.scrub.classList.remove('hovering');
      if (self.pendingSeek == null) self.osd.classList.remove('scrubbing');
      self.paintSoon();
    });
    hit.addEventListener('click', function (e) {
      e.stopPropagation();
      if (self.live || !self.full || self.osdHidden || (self.state !== 'playing' && self.state !== 'paused')) return;
      var sec = secAt(e);
      if (sec == null) return;
      self.pendingSeek = PL.clamp(sec, 0, Math.max(0, self.durationSec() - 5));
      self.commitSeek();
    });
  };

  // ---- Status / OSD --------------------------------------------------------------------------

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

  // Shows the overlay (or keeps it up) and re-arms the auto-hide while playing. zone: where the
  // remote lands; by default the skip pill when it is showing, else the seek bar.
  Player.prototype.showOsd = function (zone) {
    var self = this;
    var wasHidden = this.osdHidden;
    if (wasHidden) {
      this.osdHidden = false;
      this.osd.classList.remove('faded');
      this.el.classList.add('osd-open');
      this.subEl.classList.add('subs-raised');
      this.zone = zone || (this.ctaShown() ? 'pill' : 'bar');
    } else if (zone) {
      this.zone = zone;
    }
    this.paintPill();
    this.paintZone();
    if (wasHidden) this.paintScrub();
    clearTimeout(this.osdTimer);
    if (this.state === 'playing' && this.pendingSeek == null) {
      this.osdTimer = setTimeout(function () {
        // a sheet (subtitles, chapters) is open over the player: keep the overlay for its return
        if (PL.app.top() !== self && self.state !== 'stopped') self.showOsd();
        else self.hideOsd();
      }, OSD_HIDE_MS);
    }
  };

  Player.prototype.hideOsd = function () {
    clearTimeout(this.osdTimer);
    if (this.osdHidden) return;
    this.osdHidden = true;
    this.osd.classList.add('faded');
    this.el.classList.remove('osd-open');
    this.hoverSec = null;
    this.scrub.classList.remove('hovering');
    if (this.pendingSeek == null) this.endScrubLook();
    this.subEl.classList.remove('subs-raised');
    this.zone = 'bar';
    this.paintPill();
    this.paintZone();
  };

  Player.prototype.paintZone = function () {
    var up = !this.osdHidden;
    this.scrub.classList.toggle('focused', up && this.zone === 'bar' && !this.live);
    this.row.setFocused(up && this.zone === 'buttons');
  };

  // Play/Pause, Back 10 s, Forward 30 s, then Subtitles, Audio, Chapters and Next episode when the
  // item has them. Rebuilt when the item, its play queue or its chapters change.
  Player.prototype.buildButtons = function () {
    var self = this;
    var list = [];
    if (!this.live && this.full) {
      var streams = streamsOf(this.full, this.mediaIndex);
      var subs = streams.filter(function (s) { return s.streamType === 3; });
      var audio = streams.filter(function (s) { return s.streamType === 2; });
      var tracks = function (only) {
        return function () { screens.trackSheet(self.full, function () { self.onTracksChanged(); }, self.mediaIndex, only); };
      };
      list.push({ id: 'play', icon: 'pause', label: 'Pause', action: function () { self.togglePause(); } });
      list.push({ id: 'back', icon: 'back', label: '10 s', action: function () { self.scrubBy(-10, SEEK_COMMIT_MS); } });
      list.push({ id: 'forward', icon: 'forward', label: '30 s', action: function () { self.scrubBy(30, SEEK_COMMIT_MS); } });
      if (subs.length) list.push({ id: 'subs', icon: 'tracks', label: 'Subtitles', action: tracks('subtitles') });
      if (audio.length > 1) list.push({ id: 'audio', icon: 'audio', label: 'Audio', action: tracks('audio') });
      if (this.chapters.length > 1) list.push({ id: 'chapters', icon: 'chapters', label: 'Chapters', action: function () { self.openChapters(); } });
      if (this.nextItem()) list.push({ id: 'next', icon: 'next', label: 'Next episode', action: function () { self.playNext(true); } });
    }
    var was = this.row.buttons && this.row.buttons[this.row.index];
    var keep = was ? list.map(function (b) { return b.id; }).indexOf(was.id) : -1;
    this.row.index = keep >= 0 ? keep : 0;
    this.row.setButtons(list);
    this.paintedPaused = null;
    this.paintPlayButton();
    if (!list.length && this.zone === 'buttons') this.zone = 'bar';
    this.paintZone();
  };

  Player.prototype.paintPlayButton = function () {
    var b = this.row.buttons && this.row.buttons[0];
    if (!b || b.id !== 'play') return;
    var paused = this.state === 'paused';
    if (this.paintedPaused === paused) return;
    this.paintedPaused = paused;
    var n = this.row.nodes[0];
    PL.clear(n);
    n.appendChild(PL.ui.icon(paused ? 'play' : 'pause'));
    n.appendChild(PL.el('span', 'btn-label', paused ? 'Play' : 'Pause'));
  };

  Player.prototype.paintText = function () {
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
      var ep = PL.fmt.episode(f);
      this.eyebrow.textContent = (f.grandparentTitle || '') + (ep ? ' · ' + ep : '');
    } else {
      this.eyebrow.textContent = f.year ? String(f.year) : '';
    }
    this.title.textContent = f.title || '';
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

  // Writes a value to the DOM only when it changed (text changes cost a layout on the TV).
  Player.prototype.setPainted = function (key, node, prop, value) {
    if (this.painted[key] === value) return;
    this.painted[key] = value;
    if (prop === 'text') node.textContent = value;
    else node.style[prop] = value;
  };

  // The bar, at most a few times a second (timeupdate) or once a frame while scrubbing. Every
  // moving part is a transform: scaleX for the fills, translate for the head and the bubble.
  Player.prototype.paintScrub = function () {
    if (this.live) {
      this.setPainted('vis', this.scrub, 'visibility', 'hidden');
      this.setPainted('el', this.elapsed, 'text', '');
      this.setPainted('rem', this.remaining, 'text', '');
      return;
    }
    this.setPainted('vis', this.scrub, 'visibility', '');
    var dur = this.durationSec();
    // while a stream (re)starts currentTime is 0 and base may be stale: show where it is going
    var now = this.state === 'loading' ? this.intendedPosition() : this.position();
    var pos = this.pendingSeek != null ? this.pendingSeek : now;
    var frac = dur ? PL.clamp(pos / dur, 0, 1) : 0;
    var b = this.video.buffered;
    var bufEnd = b && b.length ? b.end(b.length - 1) + (this.mode === 'transcode' ? this.base : 0) : 0;
    this.setPainted('played', this.playedBar, 'transform', 'scaleX(' + frac.toFixed(4) + ')');
    this.setPainted('buf', this.bufferBar, 'transform', 'scaleX(' + (dur ? PL.clamp(bufEnd / dur, 0, 1) : 0).toFixed(3) + ')');
    var x = Math.round(frac * SCRUB_W);
    this.setPainted('head', this.head, 'transform', 'translate3d(' + x + 'px,0,0)');
    var hover = this.hoverSec != null && this.pendingSeek == null;
    if (this.pendingSeek != null || hover) {
      var at = hover ? this.hoverSec : pos;
      var bx = Math.round((dur ? PL.clamp(at / dur, 0, 1) : 0) * SCRUB_W);
      bx = PL.clamp(bx, BUBBLE_W / 2, SCRUB_W - BUBBLE_W / 2) - BUBBLE_W / 2;
      this.setPainted('bubble', this.bubble, 'transform', 'translate3d(' + bx + 'px,0,0)');
      this.setPainted('btime', this.bubbleTime, 'text', PL.fmt.clock(at));
      var d = Math.round(at - now);
      this.setPainted('bdelta', this.bubbleDelta, 'text', hover || Math.abs(d) < 1 ? '' : (d > 0 ? '+' : '−') + PL.fmt.clock(Math.abs(d)));
    }
    // the times stay on the real position (the bubble shows the target), so a held key only
    // rewrites the bubble's text
    this.setPainted('el', this.elapsed, 'text', PL.fmt.clock(now));
    var left = Math.max(0, dur - now);
    this.setPainted('rem', this.remaining, 'text', dur ? '−' + PL.fmt.clock(left) + '  ·  Ends at ' + endsAt(left) : '');
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
      self.buildButtons();
      if (self.queue) self.alignQueue(full);
      else if (full.type === 'episode') self.loadQueue(full);
      // resuming from a saved position: back up 5 s so the scene is recognisable
      self.start(self.startOffset > 0 ? Math.max(0, self.startOffset - 5000) : 0);
    }).catch(function (err) { if (gen === self.gen) self.fail(err); });
  };

  Player.prototype.alignQueue = function (full) {
    var q = this.queue;
    var cur = q.items[q.index];
    if (cur && cur.ratingKey === full.ratingKey) return;
    for (var i = 0; i < q.items.length; i++) if (q.items[i].ratingKey === full.ratingKey) { q.index = i; return; }
  };

  Player.prototype.loadChapters = function (full) {
    var dur = (full.duration || 0) / 1000;
    this.chapters = (full.Chapter || []).map(function (c, i) {
      return { start: (c.startTimeOffset || 0) / 1000, end: (c.endTimeOffset || 0) / 1000, title: c.tag || ('Chapter ' + (i + 1)) };
    }).sort(function (a, b) { return a.start - b.start; });
    PL.clear(this.ticks);
    if (!dur) return;
    var self = this;
    this.chapters.forEach(function (c) {
      if (c.start < 1 || c.start >= dur) return;
      var t = PL.el('div', 'scrub-tick');
      t.style.transform = 'translate3d(' + Math.round(c.start / dur * SCRUB_W) + 'px,0,0)';
      self.ticks.appendChild(t);
    });
  };

  Player.prototype.openChapters = function () {
    var self = this;
    var pos = this.position();
    var current = 0;
    this.chapters.forEach(function (c, i) { if (pos >= c.start) current = i; });
    PL.app.push(screens.sheet([{
      heading: 'Chapters',
      rows: this.chapters.map(function (c, i) {
        return {
          label: c.title, sub: PL.fmt.clock(c.start), checked: i === current,
          action: function () { if (self.state !== 'stopped') self.seekTo(c.start); },
        };
      }),
    }], { focus: current }));
  };

  Player.prototype.loadQueue = function (full) {
    var self = this;
    PL.plex.createPlayQueue(full).then(function (mc) {
      var items = mc.Metadata || [];
      var idx = mc.playQueueSelectedItemOffset || 0;
      for (var i = 0; i < items.length; i++) if (items[i].ratingKey === full.ratingKey) { idx = i; break; }
      self.queue = { items: items, index: idx };
      if (self.full === full) self.buildButtons();
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
      PL.log('play', self.mode, self.live ? 'live' : self.full.ratingKey, 'at', Math.round(offsetSec) + 's');
      if (!self.live) self.setupSubs();
      var p = self.video.play();
      if (p && p.catch) p.catch(function (e) { PL.warn('play() rejected', e && e.message); });
      self.startTimeline();
    }).catch(function (err) { if (gen === self.gen) self.fail(err); });
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

  Player.prototype.tune = function (channel) {
    var self = this;
    if (this.state === 'stopped') return;
    this.teardownVideo();
    this.stopTranscode();
    this.releaseLive();
    var gen = ++this.gen;
    this.live.channel = channel;
    this.programme = '';
    this.liveMeta = null;
    this.state = 'loading';
    this.paintText();
    this.showOsd();
    this.setStatus('Tuning ' + (channel.title || 'channel') + '…', true);
    var session = PL.uuid();
    this.liveSession = session;
    PL.plex.request('POST', '/livetv/dvrs/' + this.live.dvrKey + '/channels/' + encodeURIComponent(channel.identifier) + '/tune',
      { 'X-Plex-Session-Identifier': session }, { timeout: 45000 }).then(function (mc) {
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
      var now = sub.Timeline && sub.Timeline.Metadata && sub.Timeline.Metadata[0];
      if (now) self.programme = now.grandparentTitle ? now.grandparentTitle + ' · ' + now.title : now.title;
      self.paintText();
      self.start(0);
    }).catch(function (err) { if (gen === self.gen) self.fail(err); });
  };

  Player.prototype.changeChannel = function (dir) {
    var list = this.live.channels || [];
    if (!list.length) return;
    var self = this;
    this.live.index = ((this.live.index || 0) + dir + list.length) % list.length;
    this.live.channel = list[this.live.index];
    this.programme = '';
    this.paintText();
    this.showOsd();
    clearTimeout(this.channelTimer);
    this.channelTimer = setTimeout(function () { self.tune(self.live.channel); }, 600);
  };

  Player.prototype.releaseLiveMeta = function (meta) {
    var uuid = meta && meta.Media && meta.Media[0] && meta.Media[0].uuid;
    if (uuid) PL.plex.request('DELETE', '/transcode/sessions/' + uuid).catch(function () {});
  };

  Player.prototype.releaseLive = function () {
    if (this.liveUuid) {
      PL.plex.request('DELETE', '/transcode/sessions/' + this.liveUuid).catch(function () {});
      this.liveUuid = null;
    }
  };

  // ---- Seeking ---------------------------------------------------------------------------------

  // Moves the seek target by delta seconds without seeking yet: the TV can only land on keyframes
  // and a stream restart is slow, so presses add up and one seek goes out commitMs after the last.
  Player.prototype.scrubBy = function (delta, commitMs) {
    if (this.live || !this.full || (this.state !== 'playing' && this.state !== 'paused')) return;
    var self = this;
    var dur = this.durationSec();
    var from = this.pendingSeek != null ? this.pendingSeek : this.intendedPosition();
    this.pendingSeek = PL.clamp(from + delta, 0, Math.max(0, dur - 5));
    this.scrub.classList.add('seeking');
    this.osd.classList.add('scrubbing');
    this.showOsd();
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(function () { self.commitSeek(); }, commitMs);
    this.paintSoon();
  };

  // Left/Right on the bar. A tap moves 10 s (quick taps 30 s, then 60 s). Holding the key moves at
  // a speed that grows the longer it is held; the seek goes out when the key is released.
  Player.prototype.scrubKey = function (code, repeat) {
    var dir = code === K.RIGHT ? 1 : -1;
    var now = Date.now();
    var h = this.hold;
    var delta;
    if (h && h.dir === dir && repeat && now - h.last < HOLD_GAP_MS) {
      var held = now - h.since;
      var dur = this.durationSec();
      var speed = held < 1000 ? 20 : held < 3000 ? 60 : held < 5000 ? Math.max(120, dur / 40) : Math.max(240, dur / 15);
      delta = speed * Math.min(250, now - h.last) / 1000;
      h.last = now;
    } else {
      this.seekPresses = now - this.lastSeekAt < 400 ? this.seekPresses + 1 : 0;
      delta = this.seekPresses > 8 ? 60 : this.seekPresses > 3 ? 30 : 10;
      this.hold = { dir: dir, since: now, last: now };
    }
    this.lastSeekAt = now;
    this.scrubBy(dir * delta, SEEK_HOLD_MS);
  };

  Player.prototype.endScrubLook = function () {
    this.scrub.classList.remove('seeking');
    if (this.hoverSec == null) this.osd.classList.remove('scrubbing');
  };

  Player.prototype.cancelSeek = function () {
    clearTimeout(this.seekTimer);
    this.pendingSeek = null;
    this.hold = null;
    this.endScrubLook();
    this.showOsd();
  };

  Player.prototype.commitSeek = function () {
    clearTimeout(this.seekTimer);
    var target = this.pendingSeek;
    this.pendingSeek = null;
    this.hold = null;
    this.endScrubLook();
    if (target == null) return;
    if (this.mode === 'direct') {
      this.directSeek(target);
      this.showOsd();
    } else {
      this.start(target * 1000);
    }
  };

  // webOS snaps direct-play seeks back to the previous keyframe. If a seek lands more than 1 s
  // early, seek once more by the shortfall (capped) so we land on the keyframe after the target.
  Player.prototype.directSeek = function (target) {
    this.seekReq = { target: target, retried: false, first: null };
    this.video.currentTime = target;
  };

  // The webOS pipeline reports the requested time on 'seeked', then resumes from the previous
  // keyframe (seen 6-10 s early). So the landing is judged on the playback that follows: if it
  // resumed more than 3 s short, seek once more, past the target by the shortfall (playbackRate
  // trick-play freezes on this TV, so exact landing is not possible).
  Player.prototype.onSeeked = function () {
    var req = this.seekReq;
    if (!req || this.mode !== 'direct') return;
    req.seekedAt = Date.now();
    if (!this.osdHidden) this.paintScrub();
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

  // ---- Markers: skip intro / credits ------------------------------------------------------------

  // The skip pill is a real button: it takes the remote's focus when it appears (OK or Right skips),
  // stays for PILL_MS, and comes back whenever the overlay is opened while the marker is playing.
  // markerState.pill: {kind: 'intro' | 'credits', id, target, shownAt, timedOut}
  Player.prototype.showPill = function (kind, label, target, id) {
    var st = this.markerState;
    st.pill = { kind: kind, id: id, target: target, shownAt: Date.now(), timedOut: false };
    this.pillLabel.textContent = label;
    // take the focus unless the remote is busy in the button row
    if (!this.osdHidden && this.zone !== 'buttons' && this.pendingSeek == null) this.zone = 'pill';
    this.paintPill();
    this.paintZone();
  };

  // The "call to action" in the corner: Up Next during the credits, else the skip pill.
  Player.prototype.ctaShown = function () {
    return this.upnextNext ? 'upnext' : this.pillVisible ? 'pill' : null;
  };

  // Paints the skip pill and the Up Next button: lit (white) while they have the remote's focus,
  // which is always when the overlay is hidden, and in the overlay's 'pill' zone.
  Player.prototype.paintPill = function () {
    var p = this.markerState && this.markerState.pill;
    var vis = !!p && !this.upnextNext && (!p.timedOut || !this.osdHidden);
    this.pillVisible = vis;
    if (!this.ctaShown() && this.zone === 'pill') {
      this.zone = 'bar';
      this.paintZone();
    }
    var lit = this.osdHidden || this.zone === 'pill';
    this.pill.classList.toggle('skip-pill-hidden', !vis);
    this.pill.classList.toggle('focused', vis && lit);
    this.upnext.classList.toggle('upnext-dim', !lit);
  };

  Player.prototype.activateCta = function () {
    if (this.upnextNext) {
      this.playNext();
      return true;
    }
    return this.activatePill();
  };

  Player.prototype.hidePill = function () {
    if (this.markerState) this.markerState.pill = null;
    this.paintPill();
  };

  // Back while only the pill is up: put it away until the overlay is opened again.
  Player.prototype.dismissPill = function () {
    var p = this.markerState && this.markerState.pill;
    if (p) p.timedOut = true;
    this.paintPill();
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
    if (this.live || !m || !st || this.state !== 'playing' || this.pendingSeek != null) return;
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
      if (!pill || pill.kind !== 'intro' || pill.id !== intro.id) this.showPill('intro', 'Skip Intro', intro.end, intro.id);
      else if (!pill.timedOut && now - pill.shownAt > PILL_MS) { pill.timedOut = true; this.paintPill(); }
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
      if (pill && pill.kind === 'credits' && !pill.timedOut && now - pill.shownAt > PILL_MS) { pill.timedOut = true; this.paintPill(); }
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
    else this.showPill('credits', 'Skip Credits', null, 0);
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
    if (this.live || !this.full || (this.state !== 'playing' && this.state !== 'paused')) return;
    var m = this.markers;
    if (m && this.pendingSeek == null) {
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
    this.scrubBy(30, SEEK_COMMIT_MS);
  };

  Player.prototype.seekTo = function (sec) {
    if (this.mode === 'direct') this.directSeek(sec);
    else this.start(sec * 1000);
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
    if (!this.upnextNext) this.showUpNext(next);
    else this.upnextHint.textContent = 'Back to stop';
  };

  // Shown at the end credits (video still playing) or when the video ends.
  Player.prototype.showUpNext = function (next) {
    var self = this;
    var left = 10;
    var countdown = setting('autoplayNext', true);
    clearTimeout(this.upnextTimer);
    if (this.state === 'ended') this.hideOsd();
    this.hidePill();
    this.upnextNext = next;
    // like the skip pill, it takes the focus unless the remote is busy in the button row
    if (!this.osdHidden && this.zone !== 'buttons' && this.pendingSeek == null) this.zone = 'pill';
    this.paintPill();
    this.paintZone();
    this.upnextTitle.textContent = (PL.fmt.episode(next) ? PL.fmt.episode(next) + ' · ' : '') + (next.title || '');
    this.upnextHint.textContent = this.state === 'ended' ? 'Back to stop' : 'Back to keep watching';
    var tick = function () {
      self.upnextLabel.textContent = 'Up next in ' + left;
      if (left-- <= 0) {
        self.playNext();
        return;
      }
      self.upnextTimer = setTimeout(tick, 1000);
    };
    this.upnext.classList.remove('upnext-hidden');
    if (countdown) tick();
    else this.upnextLabel.textContent = 'Up next';
  };

  Player.prototype.hideUpNext = function () {
    clearTimeout(this.upnextTimer);
    this.upnextNext = null;
    this.upnext.classList.add('upnext-hidden');
    this.paintPill();
  };

  // manual: the Next episode button, which can be pressed anywhere in the episode (it only counts
  // as watched past 90%); otherwise we are in the credits and it counts as watched.
  Player.prototype.playNext = function (manual) {
    var next = this.upnextNext || this.nextItem();
    this.hideUpNext();
    this.hidePill();
    if (!next) return this.exit();
    clearTimeout(this.seekTimer);
    this.pendingSeek = null;
    this.endScrubLook();
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
    PL.clear(this.ticks);
    clearInterval(this.subs.timer);
    this.subs = { kind: 'none', id: null, cues: [], shown: '', segs: {}, timer: null };
    this.showSubText('');
    this.everStarted = false;
    this.lastOffsetSec = 0;
    this.queue.index++;
    this.item = next;
    this.full = null;
    this.retried = false;
    this.startOffset = 0;
    this.state = 'idle';
    this.row.index = 0;
    this.buildButtons();
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
    clearTimeout(this.seekTimer);
    this.pendingSeek = null;
    this.hold = null;
    this.endScrubLook();
    clearInterval(this.timelineTimer);
    this.teardownVideo();
    this.stopTranscode();
    this.setStatus(PL.errorMessage(err) + '  ·  Press Back to return', false);
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
    clearTimeout(this.seekTimer);
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

  // Key map (README "Player"): see the comments on each branch.
  Player.prototype.key = function (code, e) {
    var repeat = !!(e && e.repeat);
    // a key-down with no key-up since the last one is the key being held (in case e.repeat isn't set)
    var held = repeat || !!this.held[code];
    this.held[code] = true;
    // the episode has ended and Up Next is counting down: play it now, or leave
    if (this.upnextNext && this.state === 'ended') {
      if (PL.isBack(code) || code === K.STOP) {
        this.hideUpNext();
        this.exit();
      } else if (!repeat && (code === K.ENTER || code === K.RIGHT || code === K.PLAY || code === K.PLAY_PAUSE || code === K.FF || code === K.NEXT_TRACK)) {
        this.playNext();
      }
      return true;
    }
    // Back: cancel a scrub, hide the overlay, dismiss Up Next or the skip pill, then leave
    if (PL.isBack(code)) {
      if (this.state === 'error' || this.state === 'loading') this.exit();
      else if (this.pendingSeek != null) this.cancelSeek();
      else if (!this.osdHidden) this.hideOsd();
      else if (this.upnextNext) this.hideUpNext();
      else if (this.pillVisible) this.dismissPill();
      else this.exit();
      return true;
    }
    if (code === K.STOP) { this.exit(); return true; }
    if (this.state === 'error') return true;

    // media keys work the same whether the overlay is up or not
    switch (code) {
      case K.PLAY_PAUSE:
        if (this.pendingSeek != null) this.commitSeek();
        else if (!repeat) this.togglePause();
        return true;
      case K.PLAY: this.togglePause(true); return true;
      case K.PAUSE: this.togglePause(false); return true;
      case K.FF:
      case K.NEXT_TRACK:
        if (this.live) this.showOsd();
        else if (this.upnextNext) { if (!repeat) this.playNext(); }
        else this.skipForward();
        return true;
      case K.REW:
      case K.PREV_TRACK:
        if (this.live) this.showOsd();
        else this.scrubBy(-10, SEEK_COMMIT_MS);
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
    var arrow = code === K.LEFT || code === K.RIGHT || code === K.UP || code === K.DOWN;
    if (code !== K.ENTER && !arrow) return true;

    // Overlay hidden: OK or Right press the skip pill / Up Next when one is up; Left/Right start
    // scrubbing; anything else just brings the overlay up.
    if (this.osdHidden) {
      if (this.ctaShown() && (code === K.ENTER || code === K.RIGHT)) {
        if (!repeat) this.activateCta();
        return true;
      }
      if ((code === K.LEFT || code === K.RIGHT) && !this.live && this.full) {
        this.showOsd('bar');
        this.scrubKey(code, held);
        return true;
      }
      if (!repeat) this.showOsd();
      return true;
    }
    this.showOsd();

    // the skip pill / Up Next, above the bar on the right
    if (this.zone === 'pill') {
      if (code === K.ENTER || code === K.RIGHT) {
        if (!repeat) this.activateCta();
      } else if (code === K.DOWN || code === K.LEFT) {
        this.showOsd('bar');
      }
      return true;
    }
    if (this.zone === 'buttons') {
      if (code === K.UP) this.showOsd('bar');
      else if (code === K.ENTER) { if (!repeat) this.row.press(); }
      else if (code === K.LEFT || code === K.RIGHT) this.row.key(code);
      return true;
    }
    // the seek bar
    switch (code) {
      case K.LEFT:
      case K.RIGHT:
        if (!this.live) this.scrubKey(code, held);
        break;
      case K.ENTER:
        if (this.pendingSeek != null) this.commitSeek();
        else if (!repeat) this.togglePause();
        break;
      case K.DOWN:
        if (this.row.buttons.length) {
          if (this.pendingSeek != null) this.commitSeek();
          this.showOsd('buttons');
        }
        break;
      case K.UP:
        if (this.ctaShown()) this.showOsd('pill');
        break;
      default:
        break;
    }
    return true;
  };

  // Releasing Left/Right after scrubbing sends the seek (after a short pause, so taps add up).
  Player.prototype.keyUp = function (code) {
    delete this.held[code];
    if ((code === K.LEFT || code === K.RIGHT) && this.pendingSeek != null && this.hold) {
      var self = this;
      this.hold = null;
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(function () { self.commitSeek(); }, SEEK_COMMIT_MS);
    }
  };

  screens.player = function (item, opts) { return new Player(item, opts); };
})();
