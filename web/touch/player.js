// The touch player for phones and tablets (docs/WEB.md, "The touch player"; boards P3, P3b, L1):
// PL.touch.play and PL.touch.playLive open it. It is the TV player (js/screens/player.js, PL.Player)
// with a phone's controls: the stream decisions, timeline reports, resume, subtitles and audio,
// chapters, Skip Intro / Credits, the end card's timing, Live TV tuning and the session stop on
// pagehide all stay the TV player's; this file only draws and reads fingers.
//
//   tap: controls up / down (tap the centre button to pause); they hide after 4 s while playing
//   double-tap left / right third: back 10 s / ahead 30 s, each extra tap one more step (a ripple
//     shows the running total)
//   drag along the bar: scrub, a time label riding the finger (no preview frames); drag sideways on
//     the picture with the controls up: a finer scrub; pull down: close; pinch: fill / fit
//   top bar: close, title, Subtitles, Audio, AirPlay, picture in picture, full screen, lock
//   bottom: the bar (one segment per chapter), times and "Ends at", tabs (Chapters, Cast, Info,
//     Episodes): under the picture in portrait, over it in landscape
//
// Full screen: the element Fullscreen API (Android, iPad) with landscape locked on phones, else on
// iPhone the native player (webkitEnterFullscreen), whose subtitles come from a text track filled
// with the cues the player already draws. The screen stays awake while playing (Wake Lock).
// It sits on the stage's stack (so Back, pagehide and "one player at a time" work as for the TV
// player) but draws over the touch layer (touchOverlay: web/touch/shell.js keeps the layer in charge
// underneath). Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui || !PL.Player) return;
  const T = PL.touch;
  const h = T.ui.h;
  const Player = PL.Player;
  const base = Player.prototype;
  const U = Player.util;
  const L = PL.playerLogic;
  const G = PL.touchPlayerLogic;
  const LL = PL.liveLogic;
  const GUIDE = PL.liveGuide;
  const K = PL.KEY;
  const BAR_GAP = 4;
  const UNLOCK_MS = 2500;
  const PIP = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document;

  // ---- Glyphs (24-unit line icons, PL.glyph's format) ------------------------------------------------

  const GL = {
    down: [['path', { d: 'M5 9l7 7 7-7' }]],
    cc: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }], ['path', { d: 'M10.5 10a2.2 2.2 0 1 0 0 4M17 10a2.2 2.2 0 1 0 0 4' }]],
    audio: [['path', { d: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2' }]],
    rotate: [['rect', { x: 7, y: 3, width: 10, height: 18, rx: 2.5 }], ['path', { d: 'M3 9a9 9 0 0 1 3-4M21 15a9 9 0 0 1-3 4' }]],
    full: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
    fullExit: [['path', { d: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' }]],
    pip: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ['rect', { x: 12, y: 11, width: 6.5, height: 5.5, rx: 1.2 }]],
    airplay: [['path', { d: 'M7 17H5.5A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5H17' }], ['path', { d: 'M12 14.5l5 6H7z' }]],
    lock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2.5 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }]],
    unlock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2.5 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 7.6-1.8' }]],
    back10: [['path', { d: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3' }], ['path', { d: 'M4 3.5v3.7h3.7' }]],
    fwd30: [['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }], ['path', { d: 'M20 3.5v3.7h-3.7' }]],
    pause: { fill: true, parts: [['rect', { x: 6, y: 4.5, width: 4, height: 15, rx: 1.2 }], ['rect', { x: 14, y: 4.5, width: 4, height: 15, rx: 1.2 }]] },
    play: { fill: true, parts: [['path', { d: 'M7 4.5v15l12.5-7.5z' }]] },
    skip: { fill: true, parts: [['path', { d: 'M3 5.5v13l9-6.5z' }], ['path', { d: 'M12 5.5v13l9-6.5z' }]] },
    next: { fill: true, parts: [['path', { d: 'M4 5.5v13l10-6.5z' }], ['rect', { x: 16, y: 5, width: 3.2, height: 14, rx: 1 }]] },
    chUp: [['path', { d: 'M6 15l6-6 6 6' }]],
    chDown: [['path', { d: 'M6 9l6 6 6-6' }]],
    live: { fill: true, parts: [['path', { d: 'M4 5.5v13l9-6.5z' }], ['rect', { x: 15, y: 5.5, width: 3.4, height: 13, rx: 1 }]] },
    restart: [['path', { d: 'M4 12a8 8 0 1 0 2.5-5.8' }], ['path', { d: 'M4 4v4.5h4.5' }]],
    star: [['path', { d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z' }]],
    starOn: { fill: true, parts: [['path', { d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z' }]] },
    list: [['path', { d: 'M8 6.5h12M8 12h12M8 17.5h12' }], ['path', { d: 'M4 6.5h.5M4 12h.5M4 17.5h.5' }]],
  };
  const glyph = (name, size, weight) => PL.glyph(GL[name], size || 22, weight || 2);

  // A round glass button (44 px). opts: {cls, label, glyph, size, on}
  function roundBtn(name, label, onTap, cls) {
    const b = h('button.tp-btn' + (cls ? '.' + cls : ''), { type: 'button', 'aria-label': label });
    b.appendChild(glyph(name, 20));
    b.addEventListener('click', (e) => { e.stopPropagation(); onTap(b, e); });
    return b;
  }

  // ⟲10 / 30⟳: the arrow with the step written inside it.
  function stepBtn(dir, onTap) {
    const b = h('button.tp-step', { type: 'button', 'aria-label': dir < 0 ? 'Back 10 seconds' : 'Ahead 30 seconds' });
    const ic = h('span.tp-step-ic');
    ic.appendChild(glyph(dir < 0 ? 'back10' : 'fwd30', 40, 1.8));
    ic.appendChild(h('span.tp-step-n', { text: dir < 0 ? String(G.STEP_BACK) : String(G.STEP_FWD) }));
    b.appendChild(ic);
    b.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
    return b;
  }

  const setGlyph = (btn, name, size, weight) => {
    const old = btn.querySelector('svg');
    const g = PL.glyph(GL[name], size || 20, weight || 2);
    if (old) old.replaceWith(g);
    else btn.appendChild(g);
  };

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ---- The player ----------------------------------------------------------------------------------------

  function TouchPlayer(item, opts) {
    Player.call(this, item, opts);
    if (this.liveOsd) this.adoptLive();
  }
  const TP = TouchPlayer.prototype = Object.create(base);
  TP.constructor = TouchPlayer;
  TP.touchOverlay = true; // web/touch/shell.js: the layer stays in charge underneath

  // ---- DOM: the TV player's video, status and subtitles, our controls around them ----------------------

  TP.build = function () {
    const self = this;
    // the TV player's elements and its media listeners (seek, rebase, playing / pause, markers, end);
    // bindPointer (below) skips the Magic Remote's handlers
    base.build.call(this);
    const root = this.el;
    // only the video, status and subtitles are kept: the TV's controls are replaced by ours
    Array.from(root.children).forEach((n) => { if (n !== this.video && n !== this.status && n !== this.subEl) n.remove(); });
    root.classList.add('tp');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Player');
    const t = this.t = {
      up: false, land: false, locked: false, tapState: null, tapTimer: null, drag: null, pan: null, pinch: null,
      paneOpen: false, segNodes: null, barW: 0, fill: false, wakeLock: null, wakeWanted: false, airplay: false,
      track: null, trackKeys: null, trackFor: null, trackCount: -1, nativeFull: false, quietUntil: 0, listeners: [],
      chapterShown: -2, lastLivePaint: 0, leaving: false,
    };
    this.hider = G.hideTimer({
      schedule: (fn, ms) => setTimeout(fn, ms), cancel: (id) => clearTimeout(id),
      check: () => this.hideState(), hide: () => this.hideChrome(),
    });

    const v = this.video;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('x-webkit-airplay', 'allow');
    v.disableRemotePlayback = false;

    // the picture: a 16:9 band in portrait, the whole screen in landscape
    const frame = this.frame = h('div.tp-frame');
    frame.appendChild(v);
    frame.appendChild(this.subEl);
    this.ripples = { '-1': this.ripple(-1), 1: this.ripple(1) };
    frame.appendChild(this.ripples['-1'].el);
    frame.appendChild(this.ripples[1].el);
    root.appendChild(frame);

    // fingers on the picture
    const surface = this.surface = h('div.tp-surface');
    root.appendChild(surface);
    this.bindSurface(surface);
    root.appendChild(h('div.tp-scrim'));
    root.appendChild(this.status); // over the picture
    this.status.classList.add('tp-status');

    // ---- the controls (fade together) ----
    const chrome = this.chrome = h('div.tp-chrome');
    const top = h('div.tp-top');
    top.appendChild(roundBtn('down', 'Close', () => this.exit(), 'tp-close'));
    const titles = h('div.tp-titles');
    this.eyebrow = h('div.tp-eyebrow');
    this.title = h('div.tp-title');
    titles.appendChild(this.eyebrow);
    titles.appendChild(this.title);
    top.appendChild(titles);
    this.actions = h('div.tp-actions');
    top.appendChild(this.actions);
    chrome.appendChild(top);

    const centre = this.centre = h('div.tp-centre');
    this.backBtn = stepBtn(-1, () => this.stepSeek(-1));
    this.playBtn = h('button.tp-play', { type: 'button', 'aria-label': 'Pause' });
    this.playBtn.appendChild(glyph('pause', 32));
    this.playBtn.addEventListener('click', (e) => { e.stopPropagation(); this.tapPlay(); });
    this.fwdBtn = stepBtn(1, () => this.stepSeek(1));
    centre.appendChild(this.backBtn);
    centre.appendChild(this.playBtn);
    centre.appendChild(this.fwdBtn);
    chrome.appendChild(centre);
    root.appendChild(chrome);

    // ---- under the picture (portrait) / along the bottom (landscape) ----
    const under = this.under = h('div.tp-under');
    const barBlock = this.barBlock = h('div.tp-barblock');
    const bar = this.barEl = h('div.tp-bar');
    this.segRow = h('div.tp-segs');
    this.headEl = h('div.tp-head');
    this.labelEl = h('div.tp-label');
    this.labelTime = h('div.tp-label-time');
    this.labelChapter = h('div.tp-label-ch');
    this.labelEl.appendChild(this.labelTime);
    this.labelEl.appendChild(this.labelChapter);
    bar.appendChild(this.segRow);
    bar.appendChild(this.headEl);
    bar.appendChild(this.labelEl);
    const hit = h('div.tp-barhit', { role: 'slider', 'aria-label': 'Position' });
    bar.appendChild(hit);
    this.bindBar(hit);
    barBlock.appendChild(bar);
    const times = h('div.tp-times');
    this.timeLeft = h('span.tp-time-left');
    this.timeNow = h('span.tp-time-now');
    this.timeNote = h('span.tp-time-note');
    this.timeLeft.appendChild(this.timeNow);
    this.timeLeft.appendChild(this.timeNote);
    this.timeRight = h('span.tp-time-right');
    times.appendChild(this.timeLeft);
    times.appendChild(this.timeRight);
    barBlock.appendChild(times);
    // Live TV: channels and Go live under the programme's bar
    this.liveRow = h('div.tp-liverow');
    barBlock.appendChild(this.liveRow);
    under.appendChild(barBlock);
    const tabsRow = h('div.tp-tabsrow');
    this.tabRow = h('div.tp-tabs', { role: 'tablist' });
    tabsRow.appendChild(this.tabRow);
    this.nextBtn = h('button.tp-next', { type: 'button', hidden: true }, [glyph('next', 16), h('span', { text: 'Next episode' })]);
    this.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playNext(true); });
    tabsRow.appendChild(this.nextBtn);
    under.appendChild(tabsRow);
    this.panel = h('div.tp-panel');
    under.appendChild(this.panel);
    root.appendChild(under);
    // a touch on the tabs or their rows keeps the controls up
    under.addEventListener('pointerdown', () => this.pokeHide(), true);
    under.addEventListener('scroll', () => this.pokeHide(), { capture: true, passive: true });

    // ---- Skip Intro / Skip Credits (the TV player decides when; these are its elements now) ----
    this.skip = h('div.tp-skip.skip-hidden');
    this.pill = h('button.tp-pill', { type: 'button' });
    this.pill.appendChild(glyph('skip', 18));
    this.pillLabel = h('span');
    this.pill.appendChild(this.pillLabel);
    this.pillLine = h('span.tp-pill-line');
    this.pill.appendChild(this.pillLine);
    this.pill.addEventListener('click', (e) => { e.stopPropagation(); this.activatePill(); });
    this.skip.appendChild(this.pill);
    root.appendChild(this.skip);

    // ---- the end card (Up Next) ----
    const ec = this.endcard = h('div.tp-endcard.endcard-hidden');
    const ecTop = h('div.tp-ec-top');
    this.ecThumb = h('div.tp-ec-thumb');
    const ecText = h('div.tp-ec-text');
    this.ecLabel = h('div.tp-ec-label');
    this.ecTitle = h('div.tp-ec-title');
    this.ecMeta = h('div.tp-ec-meta');
    ecText.appendChild(this.ecLabel);
    ecText.appendChild(this.ecTitle);
    ecText.appendChild(this.ecMeta);
    ecTop.appendChild(this.ecThumb);
    ecTop.appendChild(ecText);
    ec.appendChild(ecTop);
    const ecBtns = h('div.tp-ec-btns');
    this.ecWatch = h('button.tp-ec-btn', { type: 'button', text: 'Watch Credits' });
    this.ecNext = h('button.tp-ec-btn.tp-ec-next', { type: 'button' });
    this.ecNext.appendChild(glyph('play', 16));
    this.ecNext.appendChild(h('span', { text: 'Next Episode' }));
    this.ecCount = h('span.tp-ec-count');
    this.ecNext.appendChild(this.ecCount);
    this.ecLine = h('span.tp-ec-line');
    this.ecNext.appendChild(this.ecLine);
    ecBtns.appendChild(this.ecWatch);
    ecBtns.appendChild(this.ecNext);
    ec.appendChild(ecBtns);
    root.appendChild(ec);
    this.ecGlider = { invalidate() {} }; // the TV's travelling focus mark: nothing to measure here
    this.ecWatch.addEventListener('click', (e) => { e.stopPropagation(); this.ecIndex = 0; this.pressCta(); });
    this.ecNext.addEventListener('click', (e) => { e.stopPropagation(); this.ecIndex = 1; this.pressCta(); });

    // ---- locked: everything hides; a tap shows the unlock button for a moment ----
    this.unlockBtn = h('button.tp-unlock', { type: 'button', 'aria-label': 'Unlock' }, [glyph('unlock', 20), h('span', { text: 'Tap to unlock' })]);
    this.unlockBtn.addEventListener('click', (e) => { e.stopPropagation(); this.setLocked(false); });
    root.appendChild(this.unlockBtn);

    // no long-press menus, callouts or text selection on the player
    root.addEventListener('contextmenu', (e) => { e.preventDefault(); });

    // the picture's own events, for our controls
    const on = (name, fn) => v.addEventListener(name, fn);
    on('playing', () => { this.wake(true); this.paintState(); });
    on('pause', () => { this.wake(false); this.paintState(); });
    on('ended', () => this.wake(false));
    on('timeupdate', () => this.onTick());
    on('loadedmetadata', () => { this.buildIcons(); this.buildSegments(); });
    on('durationchange', () => this.buildSegments());
    on('webkitbeginfullscreen', () => { t.nativeFull = true; this.nativeSubs(); });
    on('webkitendfullscreen', () => {
      t.nativeFull = false;
      this.nativeSubs();
      // back from the native player: it may have paused, and the controls should say so
      this.paintState();
      this.showChrome();
    });
    on('enterpictureinpicture', () => this.buildIcons());
    on('leavepictureinpicture', () => this.buildIcons());
    on('webkitpresentationmodechanged', () => this.buildIcons());
    if (window.WebKitPlaybackTargetAvailabilityEvent) {
      on('webkitplaybacktargetavailabilitychanged', (e) => {
        const ok = e.availability === 'available';
        if (ok !== t.airplay) { t.airplay = ok; this.buildIcons(); }
      });
      on('webkitcurrentplaybacktargetiswirelesschanged', () => this.buildIcons());
    }
    const listen = (target, name, fn, opt) => { target.addEventListener(name, fn, opt); t.listeners.push([target, name, fn, opt]); };
    listen(window, 'resize', PL.rafThrottle(() => this.layout()));
    listen(window, 'orientationchange', () => setTimeout(() => this.layout(), 120));
    listen(document, 'visibilitychange', () => { if (!document.hidden && t.wakeWanted) this.wake(true); });
    const fsChange = () => this.onFullscreen();
    listen(document, 'fullscreenchange', fsChange);
    listen(document, 'webkitfullscreenchange', fsChange);
    this.paintSoon = PL.rafThrottle(() => self.paintBar());
    this.layout();
  };

  // the TV's Magic Remote handlers: not on a touch screen (synthetic mouse events after a tap would
  // bring the controls straight back)
  TP.bindPointer = function () {};
  TP.setupPreview = function () { this.preview = { part: null, ok: false, want: null, loading: false, shown: null }; };

  // A double-tap ripple for one side: a shade, the running total, and rings where the finger lands.
  TP.ripple = function (dir) {
    const el = h('div.tp-ripple.' + (dir < 0 ? 'tp-ripple-back' : 'tp-ripple-fwd'));
    const label = h('div.tp-ripple-label');
    const ic = h('span.tp-ripple-ic');
    ic.appendChild(glyph(dir < 0 ? 'back10' : 'fwd30', 30, 1.8));
    label.appendChild(ic);
    const text = h('span.tp-ripple-text');
    label.appendChild(text);
    el.appendChild(label);
    return { el, text };
  };

  // ---- Mounting: over the touch layer, not on the scaled stage ----------------------------------------------

  TP.show = function () {
    if (!this.t.mounted) {
      this.t.mounted = true;
      // app.push put it on the stage's layer; it draws over the touch layer (sheets stay above it)
      T.root.insertBefore(this.el, T.layer);
      this.unlockMedia();
      this.layout();
      this.showChrome();
    }
    base.show.call(this);
  };

  // iOS plays sound only from a tap: the tap that opened the player is spent by the time the server
  // has answered, so the element is started (and allowed) now, while the tap is still being handled.
  TP.unlockMedia = function () {
    const v = this.video;
    try {
      v.load();
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* not allowed: play() will try again */ }
  };

  // ---- Layout: portrait or landscape, phone or tablet ----------------------------------------------------

  TP.layout = function () {
    const t = this.t;
    if (!t || this.state === 'stopped') return;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const land = G.landscape(w, hgt);
    const changed = land !== t.land || t.laidOut !== true;
    t.land = land;
    t.laidOut = true;
    this.el.style.setProperty('--tp-h', hgt + 'px');
    this.el.classList.toggle('tp-land', land);
    this.el.classList.toggle('tp-port', !land);
    if (changed) {
      if (!land) t.paneOpen = false;
      this.buildIcons();
      this.buildTabs(true);
    }
    // the bar's segments are laid out in px for its width
    requestAnimationFrame(() => {
      if (this.state === 'stopped') return;
      if (this.barEl.clientWidth !== t.barW) this.buildSegments();
      this.paintPane();
    });
  };

  // ---- The controls: up, down, the timer ---------------------------------------------------------------

  TP.hideState = function () {
    const t = this.t;
    return {
      playing: this.state === 'playing' && !this.video.paused,
      scrubbing: !!t.drag,
      sheet: !!(T.sheets && T.sheets.count()),
      pane: t.land && t.paneOpen,
      endcard: !!this.upnextNext,
      error: this.state === 'error',
    };
  };

  TP.mayAutoHide = function () { return G.mayHide(this.hideState()); };
  TP.pokeHide = function () { if (this.t.up && !this.t.locked) this.hider.poke(this.hideState()); };

  TP.showChrome = function () {
    const t = this.t;
    if (t.locked) { this.flashUnlock(); return; }
    if (!t.up) {
      t.up = true;
      this.osdHidden = false;
      this.el.classList.add('tp-up');
      this.paintText();
      this.paintBar();
      this.paintCta();
      // a channel's "behind live" grows while paused, when the video sends no timeupdate
      if (this.live) {
        clearInterval(t.liveTimer);
        t.liveTimer = setInterval(() => { if (t.up && this.state !== 'stopped') this.paintLive(); }, 1000);
      }
    }
    this.pokeHide();
  };

  TP.hideChrome = function () {
    const t = this.t;
    this.hider.cancel();
    if (!t.up) return;
    if (this.state === 'error') return; // Close must stay reachable
    t.up = false;
    this.osdHidden = true;
    clearInterval(t.liveTimer);
    this.el.classList.remove('tp-up');
    if (t.land && t.paneOpen) this.openPane(false);
    this.paintCta();
  };

  // The TV player calls these when playback starts, pauses, tunes or seeks. A double-tap seek
  // restarts a server stream, which would bring the controls up: not while the ripple shows.
  TP.showOsd = function () {
    if (Date.now() < this.t.quietUntil && this.t.up === false) return;
    this.showChrome();
  };
  TP.hideOsd = function () { this.hideChrome(); };
  TP.setZone = function () { this.showChrome(); };
  TP.toggleChrome = function () {
    if (this.t.up) this.hideChrome();
    else this.showChrome();
  };

  // focus zones are a remote's idea: here only the Skip / Up Next state needs painting
  TP.paintZone = function () {
    this.paintCta();
    this.pokeHide();
  };

  TP.paintState = function () {
    const paused = this.state === 'paused' || (this.video.paused && this.state === 'playing');
    const want = paused || this.state === 'ended' ? 'play' : 'pause';
    if (this.t.playGlyph !== want) {
      this.t.playGlyph = want;
      setGlyph(this.playBtn, want, 32);
      this.playBtn.setAttribute('aria-label', want === 'play' ? 'Play' : 'Pause');
    }
    this.el.classList.toggle('tp-paused', paused);
    this.el.classList.toggle('tp-scrubbing', !!this.t.drag);
    this.pokeHide();
  };

  TP.tapPlay = function () {
    if (this.state === 'ended' && this.upnextNext) { this.playNext(); return; }
    if (this.state === 'error' && this.live) { this.tune(this.live.channel); return; }
    this.togglePause();
  };

  // ⟲10 / 30⟳ buttons (the remote's Left / Right). Live: within the pause buffer.
  TP.stepSeek = function (dir) {
    if (this.liveOsd) {
      const buf = this.liveOsd.buffer();
      if (buf) this.liveOsd.jump(dir < 0 ? -G.STEP_BACK : G.STEP_FWD);
      return;
    }
    this.jump(dir < 0 ? -G.STEP_BACK : G.STEP_FWD);
  };

  // ---- Fingers on the picture: taps, double taps, pull down, fine scrub, pinch ---------------------------

  TP.bindSurface = function (s) {
    const t = this.t;
    const pointers = new Map();
    s.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { s.setPointerCapture(e.pointerId); } catch (err) { /* gone already */ }
      if (pointers.size === 2) {
        // a second finger: a pinch, not a tap or a pan
        const [a, b] = Array.from(pointers.values());
        t.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), done: false };
        this.endPan(true);
        t.press = null;
        return;
      }
      if (pointers.size > 2) return;
      t.press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now(), kind: null };
    });
    s.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (t.pinch && pointers.size >= 2) {
        const [a, b] = Array.from(pointers.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!t.pinch.done && Math.abs(d - t.pinch.d0) > 40) {
          t.pinch.done = true;
          this.setFill(d > t.pinch.d0);
        }
        return;
      }
      const pr = t.press;
      if (!pr || pr.id !== e.pointerId || t.locked) return;
      const dx = e.clientX - pr.x;
      const dy = e.clientY - pr.y;
      if (pr.kind == null) {
        const canScrub = !this.live && this.canSeek() && this.durationSec() > 0;
        pr.kind = G.panKind(dx, dy, t.up && canScrub);
        if (pr.kind === 'side') this.beginDrag(this.shownPosition());
        if (pr.kind === 'down') this.el.classList.add('tp-pulling');
      }
      if (pr.kind === 'down') {
        const d = Math.max(0, dy);
        pr.lastDy = d;
        pr.v = (d - (pr.prevDy || 0)) / Math.max(1, e.timeStamp - (pr.prevT || e.timeStamp - 16));
        pr.prevDy = d;
        pr.prevT = e.timeStamp;
        this.el.style.transform = 'translate3d(0,' + Math.round(d) + 'px,0)';
      } else if (pr.kind === 'side' && t.drag) {
        t.drag.target = G.fineScrub(t.drag.from, dx, Math.max(1, t.barW), this.durationSec());
        t.drag.x = L.xAt(this.segs, t.drag.target);
        this.paintSoon();
      }
    });
    const up = (e, cancelled) => {
      pointers.delete(e.pointerId);
      if (t.pinch) {
        if (!pointers.size) t.pinch = null;
        return;
      }
      const pr = t.press;
      if (!pr || pr.id !== e.pointerId) return;
      t.press = null;
      if (pr.kind === 'down') {
        this.el.classList.remove('tp-pulling');
        if (!cancelled && G.closes(pr.lastDy || 0, pr.v || 0)) {
          this.exit();
        } else {
          this.el.classList.add('tp-spring');
          this.el.style.transform = '';
          setTimeout(() => this.el.classList.remove('tp-spring'), 260);
        }
        return;
      }
      if (pr.kind === 'side') {
        this.endDrag(!cancelled);
        return;
      }
      if (pr.kind || cancelled || Date.now() - pr.at > 600) return;
      this.onTap(e.clientX, e.clientY);
    };
    s.addEventListener('pointerup', (e) => up(e, false));
    s.addEventListener('pointercancel', (e) => up(e, true));
    // The browser's click after a tap would land on whatever the tap just showed (the play button
    // under the finger): the surface acts on pointerup, so it cancels the click. Double-tap zoom
    // belongs to the page, not here.
    s.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    s.addEventListener('dblclick', (e) => e.preventDefault());
  };

  // An abandoned pan (a second finger came): put things back.
  TP.endPan = function (cancel) {
    const pr = this.t.press;
    if (!pr) return;
    if (pr.kind === 'down') {
      this.el.classList.remove('tp-pulling');
      this.el.style.transform = '';
    }
    if (pr.kind === 'side') this.endDrag(!cancel);
  };

  // A tap: through the accumulator (web/touch/player-logic.js). Double taps seek only where there
  // is something to seek in (not a channel without a pause buffer).
  TP.onTap = function (x, y) {
    const t = this.t;
    if (t.locked) { this.flashUnlock(); return; }
    const rect = this.surface.getBoundingClientRect();
    const seekable = this.liveOsd ? !!this.liveOsd.buffer() : this.canSeek();
    const r = G.tap(t.tapState, { t: Date.now(), x: seekable ? x - rect.left : rect.width / 2, width: rect.width });
    t.tapState = r.state;
    clearTimeout(t.tapTimer);
    const act = r.act;
    if (act.type === 'toggle') {
      this.toggleChrome();
      return;
    }
    if (act.type === 'wait') {
      t.tapTimer = setTimeout(() => this.settleTap(), act.ms);
      return;
    }
    // a seek: one step now, the ripple shows the streak's total
    this.tapSeek(act.dir, act.step, act.total, x, y);
    t.tapTimer = setTimeout(() => this.settleTap(), G.STREAK_MS);
  };

  TP.settleTap = function () {
    const t = this.t;
    const s = G.settle(t.tapState, Date.now());
    t.tapState = s.state;
    if (s.act === 'toggle') this.toggleChrome();
    else if (s.act === 'end') this.endRipple();
    else if (s.state) t.tapTimer = setTimeout(() => this.settleTap(), 60);
  };

  TP.tapSeek = function (dir, step, total, x, y) {
    const t = this.t;
    t.quietUntil = Date.now() + 2500;
    if (this.liveOsd) {
      const lo = this.liveOsd;
      if (lo.buffer()) lo.jump(dir * step);
    } else if (this.canSeek()) {
      // shownPosition counts a seek still landing, so quick taps add up
      this.lastSeekAt = Date.now();
      this.seekNow(this.shownPosition() + dir * step);
    }
    const other = this.ripples[-dir];
    other.el.classList.remove('on');
    const r = this.ripples[dir];
    r.text.textContent = G.seekLabel(dir, total);
    r.el.classList.add('on');
    // a ring where the finger landed
    const rr = r.el.getBoundingClientRect();
    const ring = h('span.tp-ring');
    ring.style.left = Math.round(x - rr.left) + 'px';
    ring.style.top = Math.round(Math.max(rr.top, Math.min(rr.bottom, y)) - rr.top) + 'px';
    r.el.appendChild(ring);
    setTimeout(() => ring.remove(), 650);
    r.el.classList.remove('pulse');
    void r.el.offsetWidth;
    r.el.classList.add('pulse');
  };

  TP.endRipple = function () {
    this.ripples[-1].el.classList.remove('on');
    this.ripples[1].el.classList.remove('on');
  };

  // Pinch out: the picture fills the screen (cropped); pinch in: it fits again.
  TP.setFill = function (on) {
    if (on === this.t.fill) return;
    this.t.fill = on;
    this.el.classList.toggle('tp-fill', on);
    PL.toast(on ? 'Fill the screen' : 'Fit to screen', 1200);
  };

  // ---- The bar: drag to scrub, with the time riding the finger ---------------------------------------------

  TP.bindBar = function (hit) {
    const t = this.t;
    const at = (e) => {
      const r = this.barEl.getBoundingClientRect();
      return { x: e.clientX - r.left, w: r.width };
    };
    hit.addEventListener('pointerdown', (e) => {
      if (this.live || !this.canSeek() || !t.up || t.locked) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.stopPropagation();
      try { hit.setPointerCapture(e.pointerId); } catch (err) { /* */ }
      const p = at(e);
      this.beginDrag(this.shownPosition());
      t.drag.bar = true;
      t.drag.id = e.pointerId;
      this.moveDrag(p.x, p.w);
    });
    hit.addEventListener('pointermove', (e) => {
      if (!t.drag || !t.drag.bar || t.drag.id !== e.pointerId) return;
      const p = at(e);
      this.moveDrag(p.x, p.w);
    });
    const end = (e, ok) => {
      if (!t.drag || !t.drag.bar || t.drag.id !== e.pointerId) return;
      this.endDrag(ok);
    };
    hit.addEventListener('pointerup', (e) => end(e, true));
    hit.addEventListener('pointercancel', (e) => end(e, false));
    hit.addEventListener('click', (e) => e.stopPropagation());
  };

  TP.beginDrag = function (from) {
    this.t.drag = { from, target: from, x: L.xAt(this.segs, from) };
    this.hider.cancel();
    this.paintState();
    this.paintBar();
  };

  TP.moveDrag = function (x, w) {
    const d = this.t.drag;
    d.target = G.scrubSec(L, this.segs, x, w, this.durationSec());
    d.x = Math.max(0, Math.min(w, x));
    this.paintSoon();
  };

  // ok: jump to the target (a tap on the bar jumps there too); else stay where it was
  TP.endDrag = function (ok) {
    const d = this.t.drag;
    if (!d) return;
    this.t.drag = null;
    if (ok && Math.abs(d.target - d.from) >= 1 && this.canSeek()) this.seekNow(d.target, true);
    this.paintState();
    this.paintBar();
    this.pokeHide();
  };

  // ---- Painting the bar and times ------------------------------------------------------------------------

  TP.buildSegments = function () {
    const t = this.t;
    if (!t || !this.segRow) return;
    const w = this.barEl.clientWidth;
    t.barW = w;
    const dur = this.durationSec();
    this.segs = L.segments(this.live ? [] : this.chapters, dur, Math.max(1, w), BAR_GAP);
    this.segRow.replaceChildren();
    t.segNodes = this.segs.map((s) => {
      const n = h('div.tp-seg');
      n.style.left = s.left + 'px';
      n.style.width = s.w + 'px';
      const fill = h('div.tp-seg-fill');
      n.appendChild(fill);
      this.segRow.appendChild(n);
      return fill;
    });
    Object.keys(this.painted).forEach((k) => { if (/^tps\d/.test(k)) delete this.painted[k]; });
    this.paintBar();
  };

  TP.paintBar = function () {
    if (this.live) { this.paintLive(); return; }
    const t = this.t;
    if (!t || !t.segNodes) return;
    const dur = this.durationSec();
    const d = t.drag;
    const at = d ? d.target : this.shownPosition();
    const set = (k, n, p, v) => this.setPainted(k, n, p, v);
    for (let i = 0; i < this.segs.length; i++) {
      if (!t.segNodes[i]) break;
      set('tps' + i, t.segNodes[i], 'transform', 'scaleX(' + L.fill(this.segs[i], at).toFixed(4) + ')');
    }
    const x = d && d.bar ? d.x : dur ? L.xAt(this.segs, at) : 0;
    set('tphead', this.headEl, 'transform', 'translate3d(' + Math.round(x) + 'px,0,0)');
    const chapter = this.chapters.length > 1 ? L.chapterAt(this.chapters, at) : -1;
    const chTitle = chapter >= 0 ? this.chapters[chapter].title : '';
    if (d) {
      set('tplt', this.labelTime, 'text', PL.fmt.clock(at));
      set('tplc', this.labelChapter, 'text', chTitle);
      const lw = this.labelEl.offsetWidth || 80;
      set('tplx', this.labelEl, 'transform', 'translate3d(' + Math.round(G.labelLeft(x, lw, t.barW, 6)) + 'px,0,0)');
    }
    set('tpnow', this.timeNow, 'text', dur || at ? PL.fmt.clock(at) : '');
    set('tpnote', this.timeNote, 'text', chTitle ? ' · ' + chTitle : '');
    const left = Math.max(0, dur - at);
    set('tprem', this.timeRight, 'text', dur ? '−' + PL.fmt.clock(left) + ' · ' + (t.land ? 'Ends at ' : 'Ends ') + U.endsAt(left) : '');
  };

  // A few times a second while playing (the TV player's timeupdate does the rest).
  TP.onTick = function () {
    const t = this.t;
    if (this.live) {
      const now = Date.now();
      if (t.up && now - t.lastLivePaint > 900) { t.lastLivePaint = now; this.paintLive(); }
      return;
    }
    if (t.drag && !this.osdHidden) this.paintBar();
    // the current chapter's card follows playback (portrait shows the row all the time)
    const tab = this.tabs[this.tabIndex];
    if (tab && tab.id === 'chapters' && tab.built && this.chapters.length > 1) {
      const cur = L.chapterAt(this.chapters, this.shownPosition());
      if (cur !== t.chapterShown) this.markChapter(tab, cur);
    }
  };

  TP.paintText = function () {
    if (!this.eyebrow) return;
    if (this.live) { this.paintLive(); return; }
    const f = this.full || this.item || {};
    if (f.type === 'episode') {
      const ep = U.episodeCode(f);
      this.eyebrow.textContent = (f.grandparentTitle || '') + (ep ? ' · ' + ep : '');
    } else {
      this.eyebrow.textContent = f.year ? String(f.year) : '';
    }
    this.title.textContent = f.title || '';
  };

  // ---- Top-right buttons -----------------------------------------------------------------------------

  TP.fsKind = function () {
    const d = document;
    const el = d.documentElement;
    if ((d.fullscreenEnabled || d.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen)) return 'element';
    if (typeof this.video.webkitEnterFullscreen === 'function') return 'native';
    return null;
  };
  const elementFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  TP.pipKind = function () {
    const v = this.video;
    if (PIP && document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function') return 'std';
    if (typeof v.webkitSupportsPresentationMode === 'function' && typeof v.webkitSetPresentationMode === 'function' &&
      v.webkitSupportsPresentationMode('picture-in-picture')) return 'webkit';
    return null;
  };
  TP.inPip = function () {
    const v = this.video;
    return (PIP && document.pictureInPictureElement === v) || v.webkitPresentationMode === 'picture-in-picture';
  };

  TP.buildIcons = function () {
    const t = this.t;
    if (!t || !this.actions) return;
    this.icons = []; // the TV's round icons (remote focus): none here
    const list = [];
    const v = this.video;
    if (t.airplay) list.push(['airplay', 'AirPlay', () => { try { v.webkitShowPlaybackTargetPicker(); } catch (e) { /* */ } }, v.webkitCurrentPlaybackTargetIsWireless]);
    if (this.live) {
      const c = this.live.channel;
      const fav = !!(c && GUIDE && GUIDE.isFavourite(c.identifier));
      if (c && GUIDE) list.push([fav ? 'starOn' : 'star', fav ? 'Remove from Favourites' : 'Add to Favourites', () => this.liveOsd.favourite(c), fav]);
      if ((this.live.channels || []).length > 1) list.push(['list', 'Channels', () => this.channelSheet()]);
    } else if (this.full) {
      const streams = U.streamsOf(this.full, this.mediaIndex);
      if (streams.some((s) => s.streamType === 3)) list.push(['cc', 'Subtitles', () => this.trackSheet('subtitles'), false, () => this.trackSheet('size')]);
      if (streams.filter((s) => s.streamType === 2).length > 1) list.push(['audio', 'Audio', () => this.trackSheet('audio')]);
    }
    const tablet = document.documentElement.classList.contains('t-tablet');
    if (this.pipKind() && (t.land || tablet)) list.push(['pip', 'Picture in picture', () => this.togglePip(), this.inPip()]);
    const fs = this.fsKind();
    if (fs) {
      const full = elementFull();
      list.push([full ? 'fullExit' : t.land || fs === 'native' && !isIOS ? 'full' : 'rotate', full ? 'Exit full screen' : 'Full screen', () => this.toggleFullscreen()]);
    }
    if (t.land) list.push(['lock', 'Lock', () => this.setLocked(true)]);
    const sig = list.map((x) => x[0] + (x[3] ? '+' : '')).join();
    if (sig === t.iconSig) return;
    t.iconSig = sig;
    this.actions.replaceChildren();
    list.forEach(([name, label, run, on, hold]) => {
      const b = roundBtn(name, label, run, on ? 'on' : '');
      if (hold) b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.plHandled = true; hold(); });
      this.actions.appendChild(b);
    });
  };

  // Subtitles, Audio or the subtitle size, as a sheet (the TV's menu rows: same choices, same calls).
  TP.trackSheet = function (kind) {
    if (!this.full) return;
    const rowsFor = (k, view) => {
      this.menu = { kind: k, view, index: 0, rows: [] };
      const rows = base.menuRows.call(this);
      this.menu = null;
      return rows.filter((r) => !r.rule && !r.link).map((r) => ({
        label: r.label, sub: r.sub || '', checked: !!r.checked,
        action: () => { r.run(); this.afterTracks(); },
      }));
    };
    let opts;
    if (kind === 'audio') opts = { title: 'Audio', rows: rowsFor('audio', 'list') };
    else if (kind === 'size') opts = { title: 'Subtitle size', rows: rowsFor('subtitles', 'size') };
    else opts = { title: 'Subtitles', sections: [{ rows: rowsFor('subtitles', 'list') }, { heading: 'Size', rows: rowsFor('subtitles', 'size') }] };
    opts.cls = 'tp-sheet';
    opts.onClose = () => setTimeout(() => this.pokeHide());
    this.hider.cancel();
    T.sheet(opts);
  };

  // after a track change: the Info tab's facts and the buttons may differ
  TP.afterTracks = function () {
    const info = this.tabs.filter((x) => x.id === 'info')[0];
    if (info) info.built = false;
    setTimeout(() => { this.paintPane(); this.nativeSubs(); }, 400);
  };
  TP.closeMenu = function () { this.menu = null; };
  TP.openMenu = function (kind) { this.trackSheet(kind); };

  TP.toggleFullscreen = function () {
    const kind = this.fsKind();
    const d = document;
    if (kind === 'element') {
      if (elementFull()) {
        const exit = d.exitFullscreen || d.webkitExitFullscreen;
        if (exit) { const p = exit.call(d); if (p && p.catch) p.catch(() => {}); }
        return;
      }
      // the whole page, so the sheets (Subtitles, Audio) still show above the player
      const el = d.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      let p;
      try { p = req.call(el, { navigationUI: 'hide' }); } catch (e) { p = null; }
      Promise.resolve(p).then(() => this.lockLandscape(), () => PL.toast('This browser wouldn\'t go full screen'));
      return;
    }
    if (kind === 'native') {
      const v = this.video;
      if (!(v.readyState >= 1)) { PL.toast('Full screen is ready once the video starts'); return; }
      this.t.nativeFull = true;
      this.nativeSubs();
      try { v.webkitEnterFullscreen(); } catch (e) { this.t.nativeFull = false; this.nativeSubs(); PL.toast('Full screen isn\'t available here'); }
    }
  };

  // A phone in full screen turns to landscape (where the browser allows it: Android Chrome).
  TP.lockLandscape = function () {
    const v = this.video;
    const wide = !(v.videoWidth && v.videoHeight) || v.videoWidth >= v.videoHeight;
    if (!wide || !screen.orientation || typeof screen.orientation.lock !== 'function') return;
    if (!document.documentElement.classList.contains('t-phone') && Math.min(screen.width, screen.height) >= 600) return;
    screen.orientation.lock('landscape').then(() => { this.t.oriLocked = true; }, () => {});
  };

  TP.onFullscreen = function () {
    if (!elementFull() && this.t.oriLocked) {
      this.t.oriLocked = false;
      try { screen.orientation.unlock(); } catch (e) { /* */ }
    }
    this.buildIcons();
    this.layout();
  };

  TP.togglePip = function () {
    const v = this.video;
    const kind = this.pipKind();
    const fail = () => PL.toast('Picture in picture isn\'t available right now');
    if (kind === 'std') {
      const p = document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture();
      if (p && p.catch) p.catch(fail);
    } else if (kind === 'webkit') {
      try { v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'); } catch (e) { fail(); }
    }
  };

  // ---- Subtitles in the iPhone's native full screen ---------------------------------------------------------

  // Our subtitles are drawn over the picture, which the native player covers. While it shows, the
  // same cues go into a text track on the video (which it draws); inline, the track is off.
  TP.nativeSubs = function () {
    const t = this.t;
    const v = this.video;
    const sub = this.subs;
    // Safari's own subtitle track (the TV player draws from it): the native player shows it as it is
    if (sub.inband) {
      sub.inband.mode = t.nativeFull ? 'showing' : 'hidden';
      if (t.track) t.track.mode = 'disabled';
      return;
    }
    const text = sub.kind === 'external' || sub.kind === 'embedded';
    const want = t.nativeFull && text && sub.cues.length > 0;
    if (!t.track && !want) return;
    if (!t.track) {
      try {
        t.track = v.addTextTrack('subtitles', 'Subtitles', '');
        t.track.plOwn = true; // the TV player keeps other tracks off (Safari's in-stream rendition)
      } catch (e) { return; }
      t.trackKeys = new Set();
    }
    const off = this.mode === 'transcode' ? this.base : 0;
    const sig = sub.id + '|' + off + '|' + (sub.kind === 'embedded' ? this.session : '');
    if (t.trackFor !== sig) {
      Array.from(t.track.cues || []).forEach((c) => { try { t.track.removeCue(c); } catch (e) { /* */ } });
      t.trackKeys.clear();
      t.trackFor = sig;
      t.trackCount = -1;
    }
    if (want && t.trackCount !== sub.cues.length) {
      t.trackCount = sub.cues.length;
      const Cue = window.VTTCue || window.TextTrackCue;
      sub.cues.forEach((c) => {
        const k = c.start.toFixed(2) + c.text;
        if (t.trackKeys.has(k) || c.end - off <= 0) return;
        t.trackKeys.add(k);
        try { t.track.addCue(new Cue(Math.max(0, c.start - off), c.end - off, c.text)); } catch (e) { /* */ }
      });
    }
    t.track.mode = want ? 'showing' : 'disabled';
  };

  TP.renderSubs = function () {
    base.renderSubs.call(this);
    if (this.t && this.t.nativeFull && this.t.trackCount !== this.subs.cues.length) this.nativeSubs();
  };

  // ---- Lock (landscape, L1): nothing reacts until unlocked --------------------------------------------------

  TP.setLocked = function (on) {
    const t = this.t;
    t.locked = on;
    this.el.classList.toggle('tp-locked', on);
    if (on) {
      this.hideChrome();
      this.flashUnlock();
      PL.toast('Locked. Tap the screen, then the lock, to unlock.', 2200);
    } else {
      clearTimeout(t.unlockTimer);
      this.el.classList.remove('tp-unlock-on');
      this.showChrome();
    }
  };

  TP.flashUnlock = function () {
    const t = this.t;
    this.el.classList.add('tp-unlock-on');
    clearTimeout(t.unlockTimer);
    t.unlockTimer = setTimeout(() => this.el.classList.remove('tp-unlock-on'), UNLOCK_MS);
  };

  // ---- Tabs: Chapters, Cast, Info, Episodes -------------------------------------------------------------------

  TP.tabOpen = function () { return this.t ? !this.t.land || this.t.paneOpen : false; };

  TP.buildTabs = function (force) {
    const t = this.t;
    if (!t || !this.tabRow) return;
    const ids = [];
    if (!this.live && this.full) {
      ids.push('info');
      if (this.castFor(this.full).length) ids.push('cast');
      if (this.chapters.length > 1) ids.push('chapters');
      if (this.full.type === 'episode' && this.full.parentRatingKey) ids.push('episodes');
    }
    const order = G.tabOrder(ids, t.land);
    const next = !this.live && !!this.nextItem();
    this.nextBtn.hidden = !next;
    const sig = order.join() + '|' + t.land;
    if (!force && sig === t.tabSig && this.tabsFor === this.full) return;
    const was = this.tabs[this.tabIndex] && this.tabs[this.tabIndex].id;
    t.tabSig = sig;
    this.tabsFor = this.full;
    const LABEL = { info: 'Info', cast: 'Cast', chapters: 'Chapters', episodes: 'Episodes' };
    this.tabRow.replaceChildren();
    this.panel.replaceChildren();
    const old = {};
    this.tabs.forEach((x) => { old[x.id] = x; });
    this.tabs = order.map((id, i) => {
      const n = h('button.tp-tab', { type: 'button', role: 'tab', text: LABEL[id] });
      n.addEventListener('click', (e) => { e.stopPropagation(); this.pickTab(i); });
      this.tabRow.appendChild(n);
      // a pane already filled for this item keeps its content
      const keep = old[id] && old[id].for === this.full ? old[id] : null;
      const pane = keep ? keep.pane : h('div.tp-pane');
      this.panel.appendChild(pane);
      return { id, label: LABEL[id], node: n, pane, built: keep ? keep.built : false, for: this.full, cards: keep ? keep.cards : null };
    });
    const keepAt = was ? order.indexOf(was) : -1;
    this.tabIndex = keepAt >= 0 ? keepAt : 0;
    if (t.land && keepAt < 0) t.paneOpen = false;
    this.el.classList.toggle('tp-has-tabs', this.tabs.length > 0);
    this.paintPane();
  };

  // Portrait: the tab's row shows under it. Landscape: a tap opens the tab over the picture, a tap
  // on the open one closes it.
  TP.pickTab = function (i) {
    const t = this.t;
    if (t.land && t.paneOpen && i === this.tabIndex) { this.openPane(false); return; }
    this.tabIndex = i;
    if (t.land) this.openPane(true);
    else this.paintPane();
    this.pokeHide();
  };

  TP.openPane = function (on) {
    this.t.paneOpen = on;
    this.paintPane();
    this.pokeHide();
  };

  TP.focusTab = function (i) { this.pickTab(i); };
  TP.closeTab = function () { if (this.t && this.t.land && this.t.paneOpen) this.openPane(false); };

  TP.paintPane = function () {
    const t = this.t;
    if (!t) return;
    const showing = this.tabs.length && (!t.land || t.paneOpen);
    this.el.classList.toggle('tp-pane-open', !!(t.land && t.paneOpen));
    this.tabs.forEach((x, j) => {
      const on = j === this.tabIndex && showing;
      x.node.classList.toggle('on', on);
      x.node.setAttribute('aria-selected', String(on));
      x.pane.hidden = !on;
    });
    const tab = this.tabs[this.tabIndex];
    if (showing && tab && (!tab.built || tab.id === 'info')) this.fillTab(tab);
  };

  TP.fillTab = function (tab) {
    tab.built = true;
    tab.pane.replaceChildren();
    if (tab.id === 'info') this.fillInfoT(tab);
    else if (tab.id === 'chapters') this.fillChaptersT(tab);
    else if (tab.id === 'cast') this.fillCastT(tab);
    else if (tab.id === 'episodes') this.fillEpisodesT(tab);
  };

  const row = () => h('div.tp-row');

  // a 16:9 card: art (or a big label), title, sub, optional progress
  function card(o) {
    const n = h('button.tp-card' + (o.now ? '.now' : ''), { type: 'button' });
    const art = h('span.tp-card-art');
    if (o.img) {
      const img = T.ui.img(o.img, 'tp-card-img');
      art.appendChild(img);
    } else {
      art.appendChild(h('span.tp-card-alt', { text: o.fallback || '' }));
    }
    if (o.progress != null) {
      const p = h('span.tp-card-prog');
      const f = h('span.tp-card-prog-fill');
      f.style.transform = 'scaleX(' + Math.max(0, Math.min(1, o.progress)).toFixed(3) + ')';
      p.appendChild(f);
      art.appendChild(p);
    }
    n.appendChild(art);
    n.appendChild(h('span.tp-card-title', { text: o.title }));
    n.appendChild(h('span.tp-card-sub', { text: o.sub || '' }));
    n.addEventListener('click', (e) => { e.stopPropagation(); o.run(); });
    return n;
  }

  TP.fillChaptersT = function (tab) {
    const r = row();
    const dur = this.durationSec();
    const cur = L.chapterAt(this.chapters, this.shownPosition());
    tab.cards = this.chapters.map((c, i) => {
      const n = card({
        title: (i + 1) + ' · ' + c.title, sub: PL.fmt.clock(c.start), now: i === cur,
        img: c.thumb ? PL.plex.image(c.thumb, 320, 180) : null, fallback: PL.fmt.clock(c.start),
        run: () => this.jumpToChapter(c),
      });
      r.appendChild(n);
      return n;
    });
    void dur;
    tab.pane.appendChild(r);
    this.t.chapterShown = cur;
    this.scrollToCard(r, tab.cards[cur], false);
  };

  // the current chapter's card gets the ring (and comes into view if the row is idle)
  TP.markChapter = function (tab, cur) {
    this.t.chapterShown = cur;
    (tab.cards || []).forEach((n, i) => n.classList.toggle('now', i === cur));
    const r = tab.pane.firstChild;
    if (r && !tab.pane.hidden && Date.now() - (this.t.rowTouched || 0) > 4000) this.scrollToCard(r, tab.cards[cur], true);
  };

  // The current card second in the row (the one before it shows in full, as on board P3).
  TP.scrollToCard = function (r, n, smooth) {
    if (!r || !n) return;
    const at = n.previousElementSibling || n;
    requestAnimationFrame(() => {
      const left = at.offsetLeft - parseFloat(getComputedStyle(r).paddingLeft || 0);
      r.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
    });
  };

  TP.fillCastT = function (tab) {
    const r = h('div.tp-row.tp-cast');
    this.castFor(this.full).forEach((p) => {
      const n = h('div.tp-person');
      const photo = h('span.tp-person-photo');
      photo.appendChild(h('span.tp-person-initials', { text: U.initialsOf(p.name) }));
      if (p.thumb) {
        const img = T.ui.img(PL.plex.image(p.thumb, 144, 144), 'tp-person-img');
        img.addEventListener('error', () => img.remove(), { once: true });
        photo.appendChild(img);
      }
      n.appendChild(photo);
      n.appendChild(h('span.tp-person-name', { text: p.name }));
      if (p.role) n.appendChild(h('span.tp-person-role', { text: p.role }));
      if (p.guest) n.appendChild(h('span.tp-person-guest', { text: 'Guest star' }));
      r.appendChild(n);
    });
    tab.pane.appendChild(r);
  };

  TP.fillInfoT = function (tab) {
    const f = this.full;
    const wrap = h('div.tp-info');
    if (f.summary) wrap.appendChild(h('p.tp-info-summary', { text: f.summary }));
    const btn = h('button.t-btn.tp-info-btn', { type: 'button' }, [glyph('restart', 18), h('span.t-btn-label', { text: 'Start from the beginning' })]);
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.restartFromBeginning(); });
    wrap.appendChild(btn);
    const facts = h('dl.tp-facts');
    this.infoFacts().forEach(([k, v]) => {
      facts.appendChild(h('dt', { text: k }));
      facts.appendChild(h('dd', { text: v }));
    });
    wrap.appendChild(facts);
    tab.pane.appendChild(wrap);
  };

  TP.fillEpisodesT = function (tab) {
    const full = this.full;
    tab.pane.appendChild(h('div.tp-note', { text: 'Loading episodes…' }));
    PL.plex.get('/library/metadata/' + full.parentRatingKey + '/children').then((mc) => {
      if (this.full !== full || this.state === 'stopped') return;
      const eps = (mc && mc.Metadata) || [];
      const cur = eps.map((x) => x.ratingKey).indexOf(full.ratingKey);
      const r = row();
      tab.cards = eps.map((ep, i) => {
        const n = card({
          title: (ep.index != null ? ep.index + ' · ' : '') + (ep.title || ''), sub: i === cur ? 'Now playing' : L.runtime(ep.duration),
          now: i === cur, img: ep.thumb ? PL.plex.image(ep.thumb, 320, 180) : null, fallback: 'E' + (ep.index != null ? ep.index : ''),
          progress: i === cur ? null : ep.viewOffset && ep.duration ? ep.viewOffset / ep.duration : null,
          run: () => this.playEpisode(ep),
        });
        r.appendChild(n);
        return n;
      });
      tab.pane.replaceChildren(r);
      this.scrollToCard(r, tab.cards[cur], false);
    }, (err) => {
      tab.built = false;
      tab.pane.replaceChildren(h('div.tp-note', { text: PL.errorMessage(err) }));
    });
  };

  // ---- Skip Intro / Up Next ------------------------------------------------------------------------------------

  TP.paintCta = function () {
    if (!this.skip) return;
    const vis = this.pillShown();
    this.pillVisible = vis;
    this.skip.classList.toggle('skip-hidden', !vis);
    const ec = !!this.upnextNext;
    this.endcard.classList.toggle('endcard-hidden', !ec);
    this.el.classList.toggle('endcard-on', ec);
    this.paintCtaLine();
  };

  TP.mayTakeFocus = function () { return false; };

  // ---- Live TV: the same player, with the live controls ------------------------------------------------------

  // The TV's live controls (js/screens/live-osd.js) keep the logic (buffer, behind live, Go live,
  // start over, favourites, last channel); their drawing is ours.
  TP.adoptLive = function () {
    const lo = this.liveOsd;
    lo.el.remove();
    lo.showBanner = () => this.showOsd();
    lo.hide = () => {};
    lo.armHide = () => {};
    lo.onTime = () => {};
    lo.buildIcons = () => {};
    lo.paintBanner = () => this.paintLive();
    this.el.classList.add('tp-live');
    this.buildIcons();
    this.paintLive();
  };

  // Channel up / down, from the list the guide gave (web/touch/screens/live.js or the phone guide).
  TP.liveNeighbour = function (dir) {
    const list = this.live.channels || [];
    if (list.length < 2) return null;
    const i = this.channelIndex();
    return list[((i < 0 ? 0 : i + dir) + list.length) % list.length];
  };

  TP.paintLive = function () {
    const lo = this.liveOsd;
    if (!lo || !this.eyebrow) return;
    const t = this.t;
    const c = this.live.channel || {};
    const behind = lo.behindLive();
    const isLive = LL.isLive(behind);
    const tuning = this.state === 'loading' || this.state === 'idle';
    const failed = this.state === 'error';
    const pill = failed ? 'NO SIGNAL' : tuning ? 'TUNING' : isLive ? 'LIVE' : LL.behindLabel(behind);
    const eb = pill + '|' + c.vcn + '|' + c.title;
    if (t.liveEb !== eb) {
      t.liveEb = eb;
      this.eyebrow.replaceChildren(h('span.tp-livepill' + (isLive && !tuning && !failed ? '' : '.off'), { text: pill }),
        document.createTextNode((c.vcn ? c.vcn + '  ' : '') + (c.title || '')));
    }
    const ai = lo.airings();
    const a = ai.now;
    this.setPainted('tplt', this.title, 'text', a ? a.title : this.programme || c.title || '');
    // the programme's bar: aired (light), where we are (teal), the live edge (a tick)
    const hasTimes = !!(a && a.e > a.b);
    if (!t.liveBar) {
      this.segRow.replaceChildren();
      const avail = h('div.tp-live-avail');
      const fill = h('div.tp-live-fill');
      const edge = h('div.tp-live-edge');
      [avail, fill, edge].forEach((n) => this.segRow.appendChild(n));
      t.liveBar = { avail, fill, edge };
      t.segNodes = null;
    }
    const w = this.barEl.clientWidth || 1;
    const now = Math.floor(Date.now() / 1000);
    if (hasTimes) {
      const pos = LL.progress(a, ai.at);
      const edgeP = LL.progress(a, now);
      const buf = lo.buffer();
      const from = buf ? Math.max(0, LL.progress(a, now - (buf.end - buf.start))) : pos;
      this.setPainted('tplf', t.liveBar.fill, 'transform', 'scaleX(' + pos.toFixed(4) + ')');
      this.setPainted('tpla', t.liveBar.avail, 'transform', 'translate3d(' + Math.round(from * w) + 'px,0,0) scaleX(' + Math.max(0, edgeP - from).toFixed(4) + ')');
      this.setPainted('tple', t.liveBar.edge, 'transform', 'translate3d(' + Math.round(edgeP * w) + 'px,0,0)');
      this.setPainted('tphead', this.headEl, 'transform', 'translate3d(' + Math.round(pos * w) + 'px,0,0)');
      this.setPainted('tpnow', this.timeNow, 'text', LL.clock(a.b) + ' – ' + LL.clock(a.e));
      this.setPainted('tpnote', this.timeNote, 'text', ' · ' + (isLive ? LL.span(a.e - now) + ' left' : LL.behindText(behind)));
    } else {
      this.setPainted('tpnow', this.timeNow, 'text', failed ? '' : tuning ? 'Tuning…' : 'No guide information');
      this.setPainted('tpnote', this.timeNote, 'text', '');
    }
    this.el.classList.toggle('tp-no-times', !hasTimes);
    const next = ai.next;
    this.setPainted('tprem', this.timeRight, 'text', next ? 'Next ' + LL.clock(next.b) + ' ' + next.title : '');
    // ⟲10 / 30⟳ only with a pause buffer; ahead is greyed at the live edge
    const buf = lo.buffer();
    this.el.classList.toggle('tp-live-seek', !!buf);
    this.fwdBtn.disabled = !buf || isLive;
    this.paintLiveRow(isLive && !failed, tuning);
    this.buildIcons();
  };

  TP.paintLiveRow = function (isLive, tuning) {
    const t = this.t;
    const prev = this.liveNeighbour(-1);
    const next = this.liveNeighbour(1);
    const sig = [prev && prev.identifier, next && next.identifier, isLive, tuning].join('|');
    if (t.liveRowSig === sig) return;
    t.liveRowSig = sig;
    const r = this.liveRow;
    r.replaceChildren();
    const chBtn = (c, dir) => {
      const b = h('button.tp-ch' + (dir < 0 ? '.tp-ch-prev' : '.tp-ch-next'), { type: 'button', 'aria-label': dir < 0 ? 'Channel down' : 'Channel up' });
      b.appendChild(glyph(dir < 0 ? 'chDown' : 'chUp', 18));
      b.appendChild(h('span.tp-ch-label', { text: (c.vcn ? c.vcn + ' ' : '') + (c.title || '') }));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.changeChannel(dir); });
      return b;
    };
    if (prev) r.appendChild(chBtn(prev, -1));
    if (!isLive && !tuning) {
      const go = h('button.tp-golive', { type: 'button' }, [glyph('live', 16), h('span', { text: 'Go live' })]);
      go.addEventListener('click', (e) => { e.stopPropagation(); this.liveOsd.goLive(); });
      r.appendChild(go);
    }
    if (next) r.appendChild(chBtn(next, 1));
  };

  // CH+ / CH−: the TV player's (the banner shows the channel at once, the tune waits for the taps
  // to stop).
  TP.tuneChannel = function (channel, delay) {
    base.tuneChannel.call(this, channel, delay);
    this.t.liveEb = null;
    this.paintLive();
  };

  // The channels, now and next, to pick one.
  TP.channelSheet = function () {
    const list = this.live.channels || [];
    const cur = this.live.channel && this.live.channel.identifier;
    const rows = list.map((c) => {
      const nn = GUIDE ? GUIDE.nowNext(c.identifier) : {};
      return {
        label: (c.vcn ? c.vcn + '  ' : '') + (c.title || ''), sub: nn && nn.now ? LL.programme(nn.now).title : '',
        checked: c.identifier === cur, action: () => { if (c.identifier !== cur) this.tuneChannel(c, 0); },
      };
    });
    this.hider.cancel();
    T.sheet({ title: this.live.label || 'Channels', rows, cls: 'tp-sheet', onClose: () => setTimeout(() => this.pokeHide()) });
  };

  // ---- Wake lock --------------------------------------------------------------------------------------------

  TP.wake = function (on) {
    const t = this.t;
    t.wakeWanted = on && this.state !== 'stopped';
    if (!t.wakeWanted) {
      const l = t.wakeLock;
      t.wakeLock = null;
      if (l) l.release().catch(() => {});
      return;
    }
    if (t.wakeLock || t.wakePending || !navigator.wakeLock || document.hidden) return;
    t.wakePending = true;
    navigator.wakeLock.request('screen').then((l) => {
      t.wakePending = false;
      if (!t.wakeWanted) { l.release().catch(() => {}); return; }
      t.wakeLock = l;
      l.addEventListener('release', () => { if (t.wakeLock === l) t.wakeLock = null; });
    }, () => { t.wakePending = false; });
  };

  // ---- Keys (a tablet's keyboard) and Back ----------------------------------------------------------------

  TP.key = function (code) {
    if (PL.isBack(code)) { this.back(); return true; }
    if (this.state === 'stopped') return true;
    if (code === K.STOP) { this.exit(); return true; }
    if (this.state === 'error') return true;
    const t = this.t;
    if (t.locked) { this.flashUnlock(); return true; }
    switch (code) {
      case K.PLAY_PAUSE: case K.PLAY: case K.PAUSE:
        if (this.upnextNext && this.state === 'ended') this.playNext();
        else this.togglePause(code === K.PLAY ? true : code === K.PAUSE ? false : undefined);
        return true;
      case K.LEFT: case K.REW: this.stepSeek(-1); this.showChrome(); return true;
      case K.RIGHT: case K.FF:
        if (!this.live && code === K.FF) this.skipForward();
        else this.stepSeek(1);
        this.showChrome();
        return true;
      case K.CH_UP: case K.CH_DOWN:
        if (this.live) this.changeChannel(code === K.CH_UP ? 1 : -1);
        return true;
      case K.UP: case K.DOWN: case K.INFO: case K.ENTER:
        this.toggleChrome();
        return true;
      default:
        return true;
    }
  };
  TP.keyUp = function () {};

  // Back: a sheet closes, then a landscape tab, then the player.
  TP.back = function () {
    const t = this.t;
    if (T.sheets && T.sheets.count()) { T.sheets.closeTop(); return; }
    if (t.locked) { this.flashUnlock(); return; }
    if (t.land && t.paneOpen) { this.openPane(false); return; }
    this.exit();
  };

  // ---- Leaving ----------------------------------------------------------------------------------------------

  TP.stop = function () {
    const t = this.t;
    if (t && this.state !== 'stopped') {
      clearTimeout(t.tapTimer);
      clearTimeout(t.unlockTimer);
      clearInterval(t.liveTimer);
      this.hider.cancel();
      t.drag = null;
      this.wake(false);
      if (this.inPip()) {
        try {
          if (document.exitPictureInPicture && document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
          else this.video.webkitSetPresentationMode('inline');
        } catch (e) { /* */ }
      }
      t.listeners.forEach(([target, name, fn, opt]) => target.removeEventListener(name, fn, opt));
      t.listeners = [];
    }
    base.stop.call(this);
    if (t) this.wake(false);
  };

  // Closing slides the player away; then it leaves the stage's stack like the TV player.
  TP.exit = function () {
    const t = this.t;
    if (this.exited || t.leaving) return;
    t.leaving = true;
    this.stop();
    if (elementFull()) {
      const d = document;
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      try { const p = exit && exit.call(d); if (p && p.catch) p.catch(() => {}); } catch (e) { /* */ }
    }
    if (t.oriLocked) { try { screen.orientation.unlock(); } catch (e) { /* */ } }
    if (T.sheets) T.sheets.closeAll();
    this.el.classList.add('tp-leaving');
    setTimeout(() => base.exit.call(this), 200);
  };

  // An error: the message, and the controls stay up so Close (and for a channel, the others) can be
  // reached.
  TP.fail = function (err) {
    base.fail.call(this, err);
    this.statusText.textContent = PL.errorMessage(err);
    this.showChrome();
    if (this.live) this.paintLive();
  };

  // ---- Opening ----------------------------------------------------------------------------------------------

  T.Player = TouchPlayer;
  T.play = (item, opts) => PL.app.push(new TouchPlayer(item, opts || {}));
  // live: {label, dvrKey, channel, channels, index} (web/touch/screens/live.js, the phone guide)
  T.playLive = (live) => PL.app.push(new TouchPlayer(null, { live }));
})();
