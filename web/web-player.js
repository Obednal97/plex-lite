// The player with a mouse (docs/WEB.md, "Player with a mouse"): laptop and desktop controls on top
// of the TV player (js/screens/player.js) and the live controls (js/screens/live-osd.js).
//
// Only in the mouse and keyboard mode (PL.input.mode() === 'pointer'), following mode changes live:
//   - a transport row under the bar (play/pause, back 10 s, ahead 30 s, volume with mute) and a
//     full screen button among the round icons; tooltips that name the key ("Pause [Space]");
//   - the controls and the cursor hide after 3 s of stillness while playing (not while paused or
//     while the mouse is over the controls), and the Back [Esc] button (web/web-desktop.js) with them;
//   - a click on the picture plays or pauses, a double-click goes full screen;
//   - M mutes, N plays the next episode (PL.web.playerKey -> player.webKey);
//   - after a navigation key (PL.input.nav() === 'keys') the TV's focus marks come back with key
//     hints, and the mouse-only transport row steps aside (CSS on <html data-nav>);
//   - the first time the player opens with a mouse, a strip of the main keys (PL.storage
//     'tip.firstPlay').
// Remote mode (and the TV, which never loads this file) is left exactly as it was. Every player is
// made through PL.screens.player, so the wrapper below extends each one; the prototype is patched
// once, on the first. Web build only. ES2015 like the rest.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var web = PL.web;
  var app = PL.app;
  var L = PL.playerLogic;

  var HIDE_MS = 3000;      // controls and cursor, mouse in use and playing
  var CLICK_MS = 260;      // a click on the picture waits this long for a second one (double-click)
  var STRIP_MS = 6000;     // the first-play strip
  var VOLUME_KEY = 'web.volume';

  var G = {
    back10: [['path', { d: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3' }], ['path', { d: 'M4 3.5v3.7h3.7' }]],
    fwd30: [['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }], ['path', { d: 'M20 3.5v3.7h-3.7' }]],
    volHigh: [['path', { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z' }], ['path', { d: 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11' }]],
    volLow: [['path', { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z' }], ['path', { d: 'M15.5 9a4 4 0 0 1 0 6' }]],
    volOff: [['path', { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z' }], ['path', { d: 'M16 9.5l5 5M21 9.5l-5 5' }]],
    full: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
    fullExit: [['path', { d: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' }]],
  };

  function pointerMode() { return PL.input.mode() === 'pointer'; }
  // the mouse layout with the mouse in use (D3), or after a navigation key (D3k)
  function mouseNav() { return pointerMode() && PL.input.nav() === 'pointer'; }
  function keysNav() { return pointerMode() && PL.input.nav() === 'keys'; }
  function isFull() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

  function hasClassUp(node, stop, classes) {
    while (node && node !== stop && node.nodeType === 1) {
      for (var i = 0; i < classes.length; i++) if (node.classList.contains(classes[i])) return true;
      node = node.parentNode;
    }
    return false;
  }

  // what a click or a double-click on these does is theirs, not the picture's
  var CONTROLS = ['web-transport', 'osd-icons', 'bar', 'osd-tabs', 'osd-panel', 'osd-menu', 'menu-box', 'skip-pill',
    'endcard-body', 'web-firstplay', 'live-icons', 'live-guide', 'live-entry', 'lb'];
  // the mouse over these keeps the controls up
  var HOT = ['web-transport', 'osd-icons', 'bar-hit', 'osd-tabs', 'osd-panel', 'osd-menu', 'skip-pill', 'endcard-body',
    'web-firstplay', 'live-icons', 'live-guide'];

  function button(cls, def, size, weight) {
    var n = PL.el('div', 'web-tbtn ' + cls);
    if (def) n.appendChild(PL.glyph(def, size, weight || 1.8));
    return n;
  }

  function setGlyph(node, def, size, weight) {
    var old = node.querySelector('.glyph');
    var g = PL.glyph(def, size, weight || 1.8);
    if (old) node.replaceChild(g, old);
    else node.appendChild(g);
  }

  function savedVolume() {
    var v = PL.storage.get(VOLUME_KEY, null);
    return v && typeof v.v === 'number' ? { v: PL.clamp(v.v, 0, 1), muted: !!v.muted } : null;
  }

  // ---- The transport row: play/pause, -10 / +30, volume (mouse only) -----------------------------

  function buildTransport(p) {
    var w = p.web;
    var row = w.transport = PL.el('div', 'web-transport');
    var play = w.play = button('web-play', null);
    play.appendChild(PL.glyph('pause', 30));
    var back = button('web-skip', G.back10, 44, 1.8);
    back.appendChild(PL.el('span', 'web-skip-n', '10'));
    var fwd = button('web-skip', G.fwd30, 44, 1.8);
    fwd.appendChild(PL.el('span', 'web-skip-n', '30'));
    var vol = w.volBtn = button('web-volbtn', G.volHigh, 32, 2);
    var slider = w.slider = PL.el('div', 'web-vol');
    var track = PL.el('div', 'web-vol-track');
    w.volFill = PL.el('div', 'web-vol-fill');
    w.volKnob = PL.el('div', 'web-vol-knob');
    track.appendChild(w.volFill);
    slider.appendChild(track);
    slider.appendChild(w.volKnob);
    [play, back, fwd, vol, slider].forEach(function (n) { row.appendChild(n); });

    web.tip(back, 'Back 10 s', '←', 'above');
    web.tip(fwd, 'Ahead 30 s', '→', 'above');
    web.tip(slider, 'Volume', null, 'above');

    var click = function (node, fn) {
      node.addEventListener('click', function (e) {
        e.stopPropagation();
        fn();
        web.tip.hide();
      });
    };
    click(play, function () {
      if (p.scrubState) p.scrubCommit();
      else p.togglePause();
    });
    click(back, function () { p.jump(-10); });
    click(fwd, function () { p.jump(30); });
    click(vol, function () { toggleMute(p); });
    slider.addEventListener('click', function (e) { e.stopPropagation(); });

    // drag (or click) along the slider; the controls stay up while dragging
    var drag = function (x) {
      var r = track.getBoundingClientRect();
      var v = r.width ? PL.clamp((x - r.left) / r.width, 0, 1) : 0;
      p.video.volume = v;
      p.video.muted = v === 0;
      saveVolume(p);
    };
    var move = function (e) { drag(e.clientX); };
    var up = function () {
      w.dragging = false;
      slider.classList.remove('dragging');
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      p.showOsd();
    };
    slider.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      w.dragging = true;
      slider.classList.add('dragging');
      web.tip.hide();
      drag(e.clientX);
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
    w.endDrag = up;

    p.upper.appendChild(row);
    paintPlay(p);
    paintVolume(p);
  }

  function paintPlay(p) {
    var w = p.web;
    if (!w.play) return;
    var paused = p.video.paused || p.state === 'paused' || !!p.scrubState;
    if (w.playShown !== paused) {
      w.playShown = paused;
      setGlyph(w.play, paused ? 'play' : 'pause', 30);
      w.play.classList.toggle('is-play', paused);
    }
    web.tip(w.play, paused ? 'Play' : 'Pause', 'Play/Pause', 'above');
  }

  function paintVolume(p) {
    var w = p.web;
    if (!w.volBtn) return;
    var v = p.video;
    var level = v.muted ? 0 : v.volume;
    var g = level === 0 ? 'off' : level < 0.5 ? 'low' : 'high';
    if (w.volGlyph !== g) {
      w.volGlyph = g;
      setGlyph(w.volBtn, g === 'off' ? G.volOff : g === 'low' ? G.volLow : G.volHigh, 32, 2);
    }
    w.volFill.style.transform = 'scaleX(' + level.toFixed(3) + ')';
    PL.translate(w.volKnob, Math.round(level * 112), 0);
    web.tip(w.volBtn, v.muted || level === 0 ? 'Unmute' : 'Mute', 'M', 'above');
  }

  function saveVolume(p) {
    PL.storage.set(VOLUME_KEY, { v: Math.round(p.video.volume * 100) / 100, muted: p.video.muted });
  }

  function toggleMute(p) {
    var v = p.video;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else {
      v.muted = true;
    }
    saveVolume(p);
  }

  // ---- The full screen button: last of the round icons, in the mouse and keyboard mode ------------

  function paintFullIcon(p) {
    var fs = p.web.fsIcon;
    if (!fs) return;
    var on = isFull();
    if (p.web.fsShown !== on) {
      p.web.fsShown = on;
      var old = fs.node.querySelector('.glyph');
      var g = PL.glyph(on ? G.fullExit : G.full, 32, 1.8);
      if (old) fs.node.replaceChild(g, old);
      else fs.node.appendChild(g);
    }
    fs.label = on ? 'Exit full screen' : 'Full screen';
    fs.node.setAttribute('aria-label', fs.label);
  }

  // Adds or removes the full screen icon after the player has (re)built its icons.
  function syncFullIcon(p) {
    if (p.live) return;
    var at = p.icon('fullscreen');
    var want = pointerMode() && !!p.full;
    if (want && at < 0) {
      var n = PL.el('div', 'round web-round-full');
      var entry = { id: 'fullscreen', node: n, action: function () { web.toggleFullscreen(); }, label: 'Full screen' };
      var i = p.icons.length;
      n.addEventListener('mouseenter', function () {
        if (!document.body.classList.contains('pointer') || p.osdHidden || p.menu) return;
        p.iconIndex = p.icon('fullscreen');
        p.setZone('icons');
      });
      n.addEventListener('click', function (e) {
        e.stopPropagation();
        p.iconIndex = p.icon('fullscreen');
        p.setZone('icons');
        entry.action();
      });
      p.iconRow.appendChild(n);
      p.icons.push(entry);
      p.web.fsIcon = entry;
      p.web.fsShown = null;
      paintFullIcon(p);
      if (p.web.restoreFs) p.iconIndex = i;
    } else if (!want && at >= 0) {
      var gone = p.icons.splice(at, 1)[0];
      if (gone.node.parentNode) gone.node.parentNode.removeChild(gone.node);
      p.web.fsIcon = null;
      p.iconIndex = PL.clamp(p.iconIndex, 0, Math.max(0, p.icons.length - 1));
    }
    p.web.restoreFs = false;
    if (p.iconGlider) p.iconGlider.invalidate();
    tipIcons(p);
  }

  var ICON_KEYS = { next: 'N', fullscreen: 'F' };

  // Each round icon's tooltip: with the mouse, its own key (if it has one); focused from the
  // keyboard, Enter.
  function tipIcons(p) {
    var keys = PL.input.nav() === 'keys';
    p.icons.forEach(function (ic) {
      var label = ic.label || ic.node.getAttribute('aria-label') || '';
      web.tip(ic.node, label, keys ? 'OK' : ICON_KEYS[ic.id] || null, 'above');
    });
  }

  // ---- Key hints under the controls after a key press (D3k) ----------------------------------------

  function hintSpec(p) {
    if (!keysNav() || p.osdHidden || p.scrubState || p.liveOsd || p.state === 'ended') return null;
    var space = [['Play/Pause'], p.video.paused ? 'Play' : 'Pause'];
    var help = [['?'], 'Shortcuts'];
    switch (p.zone) {
      case 'icons': return [[['←', '→'], 'Move'], [['↓'], 'Back to the bar'], space, help];
      case 'menu': return [[['↑', '↓'], 'Move'], [['OK'], 'Choose'], [['Back'], 'Close']];
      case 'bar': {
        var up = null;
        if (p.icons.length) {
          up = p.icon('subtitles') >= 0 || p.icon('audio') >= 0 ? 'Subtitles and audio' : 'More';
        }
        return [[['←', '→'], p.state === 'paused' ? 'Seek' : '−10 s / +30 s'], up ? [['↑'], up] : null, space, help];
      }
      default: return null; // tabs and cards fill the bottom; Skip and the end card have their own
    }
  }

  function paintHints(p) {
    var w = p.web;
    if (!w.hints) return;
    var spec = hintSpec(p);
    var sig = spec ? JSON.stringify(spec) : '';
    if (sig === w.hintSig) return;
    w.hintSig = sig;
    PL.clear(w.hints);
    w.hints.classList.toggle('empty', !spec);
    (spec || []).forEach(function (h) {
      if (!h) return;
      var item = PL.el('span', 'web-hint');
      h[0].forEach(function (k, i) {
        var cap = PL.keycap(k, 'web-keycap');
        if (i) cap.classList.add('web-keycap-next');
        item.appendChild(cap);
      });
      item.appendChild(PL.el('span', 'web-hint-label', h[1]));
      w.hints.appendChild(item);
    });
  }

  // A focused icon names itself and its key (Enter), as the mouse's tooltip would.
  function paintFocusTip(p) {
    var w = p.web;
    var ic = !p.osdHidden && (p.zone === 'icons') && p.icons[p.iconIndex];
    if (keysNav() && ic && app.top() === p) {
      if (w.tipNode === ic.node && w.tipLabel === ic.label) return;
      web.tip(ic.node, ic.label || ic.node.getAttribute('aria-label') || '', 'OK', 'above');
      web.tip.show(ic.node);
      w.tipNode = ic.node;
      w.tipLabel = ic.label;
    } else if (w.tipNode) {
      web.tip.hide();
      w.tipNode = null;
    }
  }

  // ---- The first-play strip (D3): the main keys, once per browser -----------------------------------

  function showStrip(p) {
    if (p.live || p.web.strip || !pointerMode() || PL.storage.get('tip.firstPlay', false)) return;
    PL.storage.set('tip.firstPlay', true);
    var wrap = PL.el('div', 'web-firstplay');
    var strip = PL.el('div', 'web-firstplay-strip');
    var item = function (keys, label) {
      keys.forEach(function (k, i) {
        var cap = PL.keycap(k, 'web-keycap');
        if (i) cap.classList.add('web-keycap-next');
        strip.appendChild(cap);
      });
      strip.appendChild(PL.el('span', 'web-firstplay-label', label));
    };
    item(['Back'], 'Back');
    item(['Play/Pause'], 'Pause');
    item(['←', '→'], '−10 s / +30 s');
    item(['?'], 'All shortcuts');
    wrap.appendChild(strip);
    p.el.appendChild(wrap);
    p.web.strip = wrap;
    var dismiss = function () {
      clearTimeout(p.web.stripTimer);
      wrap.classList.remove('on');
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 400);
    };
    strip.addEventListener('click', function (e) {
      e.stopPropagation();
      dismiss();
    });
    void wrap.offsetWidth;
    wrap.classList.add('on');
    p.web.stripTimer = setTimeout(dismiss, STRIP_MS);
  }

  // ---- Idle: controls away while playing -> cursor and Back away too --------------------------------

  function sync(p) {
    var w = p.web;
    if (!w) return;
    var playing = p.state === 'playing';
    var hidden = p.liveOsd ? p.liveOsd.view === 'none' : p.osdHidden;
    var idle = pointerMode() && playing && hidden;
    if (idle !== w.idle) {
      w.idle = idle;
      p.el.classList.toggle('web-idle', idle);
      if (app.top() === p) web.updateBack();
    }
  }

  // The Back button fades with the controls rather than blinking out (web-desktop.css .away).
  var updateBack = web.updateBack;
  web.updateBack = function () {
    updateBack.apply(this, arguments);
    var b = document.querySelector('.web-back');
    if (!b) return;
    var top = app.top();
    var away = !!(top && top.web && top.web.player && pointerMode() && app.stack.length > 1 && top.hideBack && top.hideBack());
    if (away) b.classList.add('on');
    b.classList.toggle('away', away);
  };

  // ---- Patching the player's prototype (once) ---------------------------------------------------------

  function patchPlayer(P) {
    if (P.webPatched) return;
    P.webPatched = true;

    var wrap = function (name, after) {
      var orig = P[name];
      P[name] = function () {
        var out = orig.apply(this, arguments);
        if (this.web) after.call(this, out, arguments);
        return out;
      };
    };

    // controls stay up while the mouse is over them
    var mayAutoHide = P.mayAutoHide;
    P.mayAutoHide = function () {
      return mayAutoHide.call(this) && !(this.web && mouseNav() && (this.web.hot || this.web.dragging));
    };

    // the mouse: 3 s instead of the remote's 5
    var showOsd = P.showOsd;
    P.showOsd = function () {
      var before = this.osdTimer;
      var out = showOsd.apply(this, arguments);
      var self = this;
      if (this.web && !this.liveOsd && this.osdTimer !== before && mouseNav()) {
        clearTimeout(this.osdTimer);
        this.osdTimer = setTimeout(function () {
          if (self.state === 'stopped') return;
          if (self.mayAutoHide()) self.hideOsd();
          else self.showOsd();
        }, HIDE_MS);
      }
      if (this.web) sync(this);
      return out;
    };

    wrap('hideOsd', function () { sync(this); });
    wrap('paintState', function () {
      paintPlay(this);
      sync(this);
      paintHints(this);
    });
    wrap('paintZone', function () {
      paintHints(this);
      paintFocusTip(this);
    });
    var buildIcons = P.buildIcons;
    P.buildIcons = function () {
      // the player keeps the focus on an icon it rebuilds, but doesn't know this one
      if (this.web) this.web.restoreFs = !!this.icons[this.iconIndex] && this.icons[this.iconIndex].id === 'fullscreen';
      var out = buildIcons.apply(this, arguments);
      if (this.web) syncFullIcon(this);
      return out;
    };
    wrap('show', function () {
      if (app.top() === this) web.updateBack();
    });

    // the hover line under the pointer on the bar
    wrap('paintBar', function () {
      var t = this.web.tick;
      if (!t || this.hoverSec == null || this.live) return;
      var dur = this.durationSec();
      var x = dur ? L.xAt(this.segs, this.hoverSec) : 0;
      PL.translate(t, x, 0);
    });

    // Back with the mouse in use leaves the player (its controls show only because the mouse
    // moved). A menu or tab closes first with Esc; the Back button (and the browser's) leaves at once.
    var key = P.key;
    P.key = function (code, e) {
      if (this.web && PL.isBack(code) && pointerMode() && this.state !== 'stopped') {
        var fromButton = !e || !e.type;
        var live = this.liveOsd;
        if (fromButton) {
          this.exit();
          return true;
        }
        if (mouseNav() && !(e && e.repeat)) {
          if (live ? live.view === 'banner' : !this.osdHidden && !this.scrubState && (this.zone === 'bar' || this.zone === 'icons')) {
            this.exit();
            return true;
          }
        }
      }
      return key.apply(this, arguments);
    };

    var stop = P.stop;
    P.stop = function () {
      var out = stop.apply(this, arguments);
      if (this.web) teardown(this);
      return out;
    };

    // M and N (web/web-desktop.js): mute, and the next episode
    P.webKey = function (what) {
      if (!this.web) return false;
      if (what === 'mute') {
        toggleMute(this);
        if (mouseNav() && !this.liveOsd) this.showOsd();
        else PL.toast(this.video.muted ? 'Muted' : 'Sound on', 1500);
        return true;
      }
      if (what === 'next') {
        if (this.live) return false;
        if (this.state === 'stopped' || this.state === 'error') return true;
        if (this.upnextNext || this.nextItem()) this.playNext(true);
        else PL.toast('No next episode', 1500);
        return true;
      }
      return false;
    };

    // web/web-desktop.js: Back hides with the controls (the player only fades it, see updateBack)
    P.hideBack = function () { return !!(this.web && this.web.idle); };
  }

  function patchLive(O) {
    if (O.webPatched) return;
    O.webPatched = true;
    var setView = O.setView;
    O.setView = function () {
      var out = setView.apply(this, arguments);
      if (this.p.web) sync(this.p);
      return out;
    };
    var armHide = O.armHide;
    O.armHide = function () {
      var before = this.hideTimer;
      var out = armHide.apply(this, arguments);
      var self = this;
      var w = this.p.web;
      if (!w || !mouseNav()) return out;
      if (w.hot && this.view === 'banner') {
        clearTimeout(this.hideTimer);
      } else if (this.hideTimer !== before) {
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(function () {
          if (w.hot) return;
          if (self.view === 'banner' && self.p.state === 'playing' && PL.liveLogic.isLive(self.behindLive())) self.hide();
        }, HIDE_MS);
      }
      return out;
    };
  }

  // ---- Each player --------------------------------------------------------------------------------------

  function extend(p) {
    var w = p.web = { player: true, idle: null, hot: false, dragging: false, hintSig: null };
    var el = p.el;

    if (!p.live) {
      buildTransport(p);
      w.hints = PL.el('div', 'web-osd-keys empty');
      p.osd.appendChild(w.hints);
      w.tick = PL.el('div', 'web-hover-tick');
      p.bar.appendChild(w.tick);
    }

    var stored = savedVolume();
    if (stored) {
      p.video.volume = stored.v;
      p.video.muted = stored.muted;
    }
    w.onVolume = function () { paintVolume(p); };
    p.video.addEventListener('volumechange', w.onVolume);
    p.video.addEventListener('play', function () { paintPlay(p); });
    p.video.addEventListener('pause', function () { paintPlay(p); });
    p.video.addEventListener('playing', function () {
      if (!w.started) {
        w.started = true;
        showStrip(p);
      }
    });

    // a still cursor gets mousemove events when what is under it changes (the controls fading):
    // only real moves wake the controls
    var last = { x: -1, y: -1 };
    el.addEventListener('mousemove', function (e) {
      if (e.screenX === last.x && e.screenY === last.y) {
        e.stopImmediatePropagation();
        return;
      }
      last.x = e.screenX;
      last.y = e.screenY;
    }, true);

    // the mouse over the controls (or the Back button) keeps them up
    w.onOver = function (e) {
      var t = e.target;
      var hot = (el.contains(t) && hasClassUp(t, el, HOT)) || hasClassUp(t, document.body, ['web-back']);
      if (hot === w.hot) return;
      w.hot = hot;
      if (hot || !mouseNav() || p.state === 'stopped') return;
      // left the controls: count the 3 s from now
      if (p.liveOsd) {
        if (p.liveOsd.view === 'banner') p.liveOsd.armHide();
      } else if (!p.osdHidden) {
        p.showOsd();
      }
    };
    document.addEventListener('mouseover', w.onOver, true);

    // with the mouse, hovering a tab only lights it; a click opens it (the TV's pointer opens on
    // hover, which slides the whole block up under a passing mouse)
    p.tabRow.addEventListener('mouseenter', function (e) {
      if (e.target !== p.tabRow && mouseNav() && !p.tabOpen()) e.stopPropagation();
    }, true);
    // the mouse leaving the icons hands the focus back to the bar
    p.iconRow.addEventListener('mouseleave', function () {
      if (mouseNav() && p.zone === 'icons' && !p.menu && !p.osdHidden) p.setZone('bar');
    });

    // a click on the picture plays or pauses (after waiting out a double-click); a double-click
    // goes full screen
    el.addEventListener('click', function (e) {
      if (!pointerMode() || hasClassUp(e.target, el, CONTROLS)) return;
      clearTimeout(w.clickTimer);
      if (e.detail > 1 || p.live) return;
      w.clickTimer = setTimeout(function () {
        if (p.state === 'stopped' || app.top() !== p) return;
        if (p.menu) p.closeMenu();
        else if (p.tabOpen() && !p.osdHidden) p.closeTab();
        else if (p.scrubState) p.scrubCancel();
        else if (p.state === 'playing' || p.state === 'paused') p.togglePause();
      }, CLICK_MS);
    });
    el.addEventListener('dblclick', function (e) {
      if (!pointerMode() || hasClassUp(e.target, el, CONTROLS)) return;
      clearTimeout(w.clickTimer);
      e.preventDefault();
      web.toggleFullscreen();
    });

    w.onFull = function () { paintFullIcon(p); tipIcons(p); };
    document.addEventListener('fullscreenchange', w.onFull);
    document.addEventListener('webkitfullscreenchange', w.onFull);

    // the mode can change at any moment (Settings -> Controls, a touch, a key)
    w.onInput = function (d) {
      if (p.state === 'stopped') return;
      if (d.mode !== d.prevMode && !p.live) {
        syncFullIcon(p);
        p.paintZone();
      }
      if (d.nav !== d.prevNav) {
        tipIcons(p);
        // keys took over: the time under a still mouse goes
        if (d.nav === 'keys' && p.hoverSec != null) {
          p.hoverSec = null;
          p.osd.classList.remove('hovering');
          p.paintBar();
        }
        // back to the remote's timing (5 s) or to the mouse's (3 s)
        if (!p.liveOsd && !p.osdHidden) p.showOsd();
      }
      sync(p);
      paintHints(p);
      paintFocusTip(p);
    };
    PL.input.on(w.onInput);

    if (p.liveOsd) patchLive(Object.getPrototypeOf(p.liveOsd));
    sync(p);
  }

  function teardown(p) {
    var w = p.web;
    if (w.tornDown) return;
    w.tornDown = true;
    clearTimeout(w.clickTimer);
    clearTimeout(w.stripTimer);
    if (w.dragging && w.endDrag) w.endDrag();
    PL.input.off(w.onInput);
    document.removeEventListener('mouseover', w.onOver, true);
    document.removeEventListener('fullscreenchange', w.onFull);
    document.removeEventListener('webkitfullscreenchange', w.onFull);
    if (w.tipNode) web.tip.hide();
    w.idle = false;
    p.el.classList.remove('web-idle');
  }

  var make = PL.screens.player;
  PL.screens.player = function () {
    var p = make.apply(this, arguments);
    patchPlayer(Object.getPrototypeOf(p));
    extend(p);
    return p;
  };
})();
