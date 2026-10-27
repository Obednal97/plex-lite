// App shell: screen stack, tab bar, backdrop, key dispatch, boot.
'use strict';

(function () {
  var app = PL.app = {
    stack: [],
    sections: [],
    tabsFocused: false,
  };

  // ---- Backdrop: one fixed layer behind every screen, cross-fading between two images --------

  function Backdrop(root) {
    this.el = PL.el('div', 'backdrop');
    this.imgs = [PL.el('img', 'backdrop-img'), PL.el('img', 'backdrop-img')];
    this.front = 0;
    this.url = null;
    this.mode = 'none';
    var self = this;
    this.imgs.forEach(function (img) { self.el.appendChild(img); });
    this.el.appendChild(PL.el('div', 'backdrop-shade'));
    root.appendChild(this.el);
  }

  // mode: 'ambient' (blurred, full screen) | 'hero' (sharp, top right) | 'detail' (sharp, full) | 'none'
  Backdrop.prototype.set = function (url, mode) {
    if (mode && mode !== this.mode) {
      this.el.className = 'backdrop backdrop-' + mode;
      this.mode = mode;
    }
    if (url === this.url) return;
    this.url = url;
    var back = this.imgs[1 - this.front];
    var front = this.imgs[this.front];
    var self = this;
    if (!url) {
      front.classList.remove('shown');
      back.classList.remove('shown');
      return;
    }
    back.onload = function () {
      if (self.url !== url) return;
      back.classList.add('shown');
      front.classList.remove('shown');
      self.front = 1 - self.front;
    };
    back.onerror = function () { if (self.url === url) front.classList.remove('shown'); };
    back.src = url;
  };

  Backdrop.prototype.dim = function (level) {
    this.el.style.opacity = String(level);
  };

  // ---- Tab bar ---------------------------------------------------------------------------------

  function TabBar(root) {
    this.el = PL.el('div', 'tabbar');
    this.pill = PL.el('div', 'tabbar-pill');
    this.el.appendChild(this.pill);
    root.appendChild(this.el);
    this.tabs = [];
    this.index = 0;
    this.selected = 0;
  }

  TabBar.prototype.setTabs = function (tabs) {
    PL.clear(this.pill);
    this.glider = new PL.ui.Glider(this.pill);
    this.tabs = tabs;
    var self = this;
    this.nodes = tabs.map(function (t, i) {
      var n = PL.el('div', 'tab', t.label);
      n.addEventListener('click', function () { self.index = i; app.selectTab(i); });
      self.pill.appendChild(n);
      return n;
    });
    this.paint();
  };

  // Labels only change colour; one plate (the tab you are on, moves on OK) and one bright capsule
  // (focus, follows Left/Right) travel underneath them.
  TabBar.prototype.paint = function () {
    var self = this;
    this.nodes.forEach(function (n, i) {
      n.classList.toggle('focused', app.tabsFocused && i === self.index);
      n.classList.toggle('selected', i === self.selected);
    });
    var rects = this.glider && this.glider.measure(this.nodes);
    if (!rects) return;
    this.glider.plate(rects[this.selected]);
    this.glider.cap(app.tabsFocused ? rects[this.index] : null);
  };

  TabBar.prototype.show = function (on) {
    this.el.classList.toggle('hidden', !on);
    if (on && this.glider && !this.glider.rects) this.paint();
  };

  TabBar.prototype.key = function (code) {
    var K = PL.KEY;
    if (code === K.LEFT || code === K.RIGHT) {
      var next = PL.clamp(this.index + (code === K.RIGHT ? 1 : -1), 0, this.tabs.length - 1);
      if (next !== this.index) {
        this.index = next;
        this.paint();
      }
      return true;
    }
    if (code === K.ENTER) {
      app.selectTab(this.index);
      return true;
    }
    if (code === K.DOWN) {
      app.blurTabs();
      return true;
    }
    return code === K.UP;
  };

  // ---- Screens -----------------------------------------------------------------------------------

  // A screen: {el, key(code, event) -> bool, show(), hide(), destroy(), focusFromTabs(),
  //            root: bool (shows the tab bar)}

  app.top = function () {
    return app.stack[app.stack.length - 1];
  };

  function enter(screen) {
    var el = screen.el;
    el.classList.add('screen', 'screen-enter');
    app.layer.appendChild(el);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove('screen-enter'); }); });
    app.tabs.show(!!screen.root);
    if (screen.show) screen.show();
  }

  function park(screen) {
    if (screen.hide) screen.hide();
    screen.el.classList.add('screen-parked');
  }

  function unpark(screen) {
    screen.el.classList.remove('screen-parked');
    app.tabs.show(!!screen.root);
    if (screen.show) screen.show();
  }

  app.push = function (screen) {
    app.blurTabs(true);
    var prev = app.top();
    if (prev && !screen.overlay) park(prev);
    app.stack.push(screen);
    enter(screen);
    if (screen.overlay && prev) app.tabs.show(!!prev.root);
  };

  app.pop = function () {
    if (app.stack.length <= 1) return false;
    var screen = app.stack.pop();
    if (screen.hide) screen.hide();
    if (screen.destroy) screen.destroy();
    if (screen.el.parentNode) screen.el.parentNode.removeChild(screen.el);
    if (screen.overlay) app.tabs.show(!!app.top().root);
    else unpark(app.top());
    return true;
  };

  // Tab switches cross-fade: the old page fades out (70 ms) while the new one rises in.
  app.setRoot = function (screen) {
    while (app.stack.length) {
      var s = app.stack.pop();
      if (s.hide) s.hide();
      if (s.destroy) s.destroy();
      var old = s.el;
      if (old.parentNode) {
        old.classList.add('screen-leave');
        setTimeout(function (el) { return function () { if (el.parentNode) el.parentNode.removeChild(el); }; }(old), 90);
      }
    }
    app.stack.push(screen);
    enter(screen);
  };

  app.focusTabs = function () {
    if (!app.top() || !app.top().root) return false;
    app.tabsFocused = true;
    app.tabs.index = app.tabs.selected;
    app.tabs.paint();
    app.tabs.el.classList.add('tabbar-active');
    if (app.top().onTabsFocus) app.top().onTabsFocus();
    return true;
  };

  app.blurTabs = function (silent) {
    if (!app.tabsFocused) return;
    app.tabsFocused = false;
    app.tabs.paint();
    app.tabs.el.classList.remove('tabbar-active');
    if (!silent && app.top() && app.top().focusFromTabs) app.top().focusFromTabs();
  };

  app.selectTab = function (i) {
    var tab = app.tabs.tabs[i];
    if (!tab) return;
    app.tabs.selected = i;
    app.tabs.index = i;
    app.blurTabs(true);
    app.setRoot(tab.make());
    app.tabs.paint();
  };

  // ---- Keys --------------------------------------------------------------------------------------

  var fastTimer = null;

  // OK on screens with cards acts on release, so holding it (550 ms) can open the quick-actions menu.
  var ok = { down: false, long: false, timer: null };

  function okWanted(e) {
    var s = app.top();
    var t = e.target;
    return s && s.longPress && !app.tabsFocused && !(t && t.tagName === 'INPUT');
  }

  function okPress() {
    handleKey({ keyCode: PL.KEY.ENTER, target: document.body, repeat: false, preventDefault: function () {} });
  }

  function onKeyUp(e) {
    if (e.keyCode !== PL.KEY.ENTER || !ok.down) return;
    ok.down = false;
    clearTimeout(ok.timer);
    if (!ok.long) okPress();
    e.preventDefault();
  }

  function onKey(e) {
    if (e.keyCode === PL.KEY.ENTER && (ok.down || okWanted(e))) {
      e.preventDefault();
      if (e.repeat || ok.down) return;
      ok.down = true;
      ok.long = false;
      ok.timer = setTimeout(function () {
        ok.long = true;
        var s = app.top();
        var handled = s && s.longPress && s.key && s.key(PL.KEY.OK_LONG);
        if (!handled) okPress();
      }, 550);
      return;
    }
    var t0 = performance.now();
    handleKey(e);
    var ms = performance.now() - t0;
    if (ms > 30) PL.log('slow key', e.keyCode, Math.round(ms) + 'ms');
  }

  function handleKey(e) {
    var code = e.keyCode;
    if (e.repeat) {
      document.body.classList.add('fast');
      clearTimeout(fastTimer);
      fastTimer = setTimeout(function () { document.body.classList.remove('fast'); }, 160);
    }
    var t = e.target;
    var typing = t && t.tagName === 'INPUT';
    if (typing && code === PL.KEY.BACKSPACE) return; // deletes a character, not "back"
    if (typing && !PL.isBack(code) && code !== PL.KEY.DOWN && code !== PL.KEY.UP && code !== PL.KEY.ENTER) return;
    if (code === PL.KEY.BLUE && !typing) {
      perf.toggle();
      e.preventDefault();
      return;
    }
    var screen = app.top();
    var handled = false;
    if (app.tabsFocused) {
      if (PL.isBack(code)) {
        PL.exitApp();
        handled = true;
      } else {
        handled = app.tabs.key(code);
      }
    } else if (screen && screen.key) {
      handled = screen.key(code, e);
    }
    if (!handled && PL.isBack(code)) {
      if (app.stack.length > 1) app.pop();
      else if (!(screen && screen.root && app.focusTabs())) PL.exitApp();
      handled = true;
    }
    if (handled || (code >= 37 && code <= 40)) e.preventDefault();
  }

  // ---- Performance overlay (Blue button) ---------------------------------------------------

  var perf = {
    el: null,
    on: false,
    frames: 0,
    worst: 0,
    last: 0,
    windowStart: 0,
    toggle: function () {
      perf.on = !perf.on;
      PL.storage.set('perf', perf.on);
      perf.apply();
    },
    apply: function () {
      if (!perf.el) {
        perf.el = PL.el('div', 'perf');
        document.body.appendChild(perf.el);
      }
      perf.el.style.display = perf.on ? 'block' : 'none';
      if (perf.on) {
        perf.last = perf.windowStart = performance.now();
        perf.frames = 0;
        perf.worst = 0;
        requestAnimationFrame(perf.tick);
      }
    },
    tick: function (now) {
      if (!perf.on) return;
      perf.frames++;
      perf.worst = Math.max(perf.worst, now - perf.last);
      perf.last = now;
      if (now - perf.windowStart >= 1000) {
        var fps = Math.round(perf.frames * 1000 / (now - perf.windowStart));
        var heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB' : '';
        perf.el.textContent = fps + ' fps · worst ' + Math.round(perf.worst) + 'ms · ' + heap + ' · ' + document.getElementsByTagName('*').length + ' nodes';
        perf.frames = 0;
        perf.worst = 0;
        perf.windowStart = now;
      }
      requestAnimationFrame(perf.tick);
    },
  };
  app.perf = perf;

  // ---- Boot --------------------------------------------------------------------------------------

  app.message = function (title, body, actions) {
    return PL.screens.message(title, body, actions);
  };

  app.buildTabs = function () {
    var tabs = [{ id: 'search', label: 'Search', make: function () { return PL.screens.search(); } }];
    app.sections.forEach(function (s) {
      tabs.push({ id: 'section.' + s.key, label: s.title, make: function () { return PL.screens.library(s); } });
    });
    if (app.hasLiveTv) tabs.push({ id: 'livetv', label: 'Live TV', make: function () { return PL.screens.livetv(); } });
    tabs.push({ id: 'settings', label: 'Settings', make: function () { return PL.screens.settings(); } });
    app.tabs.setTabs(tabs);
  };

  // Launch always opens on TV Shows (the most visual first screen), else the first library, else Search.
  app.startTab = function () {
    var tabs = app.tabs.tabs;
    var shows = app.sections.filter(function (s) { return s.type === 'show'; })[0];
    var want = shows ? 'section.' + shows.key : (app.sections[0] ? 'section.' + app.sections[0].key : 'search');
    var i = tabs.map(function (t) { return t.id; }).indexOf(want);
    return i >= 0 ? i : 0;
  };

  app.start = function () {
    app.ready = false;
    if (!PL.plex.token) {
      app.setRoot(PL.screens.signin(function () { app.start(); }));
      return;
    }
    app.setRoot(PL.screens.loading('Connecting to your Plex server…'));
    PL.plex.ensureServer().then(function () {
      var dvrs = PL.plex.get('/livetv/dvrs', null, { timeout: 6000 }).then(function (mc) {
        return !!(mc && mc.Dvr && mc.Dvr.length);
      }, function () { return false; });
      return Promise.all([PL.plex.sections(), dvrs]);
    }).then(function (res) {
      app.sections = res[0];
      app.hasLiveTv = res[1];
      app.buildTabs();
      app.selectTab(app.startTab());
      app.ready = true;
      launch.run();
      // one-time tip so the hold-OK quick actions are discoverable
      if (!PL.storage.get('tip.holdOk', false)) {
        setTimeout(function () {
          if (!app.ready || !app.top() || !app.top().longPress) return;
          PL.toast('Tip: hold OK on any title for more options', 6000);
          PL.storage.set('tip.holdOk', true);
        }, 5000);
      }
      // load the search index as soon as the first screen has drawn (cached copies load in slices)
      if (PL.fuzzy) setTimeout(function () { PL.fuzzy.ensure(); }, 1500);
    }).then(null, function (err) {
      PL.warn('start failed', err && err.message);
      if (err && err.status === 401) {
        PL.plex.signOut();
        app.start();
        return;
      }
      app.setRoot(app.message('Can\'t reach Plex', PL.errorMessage(err), [
        { label: 'Try again', kind: 'primary', action: app.start },
        { label: 'Sign out', action: function () { PL.plex.signOut(); app.start(); } },
      ]));
    });
  };

  app.init = function () {
    var root = document.getElementById('app');
    app.backdrop = new Backdrop(root);
    app.layer = PL.el('div', 'screens');
    root.appendChild(app.layer);
    app.tabs = new TabBar(root);
    app.tabs.show(false);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) return;
      app.stack.slice().forEach(function (s) { if (s.onHidden) s.onHidden(); });
    });
    perf.on = !!PL.storage.get('perf', false);
    if (perf.on) perf.apply();
    pointer.init();
    launch.init();
    PL.plex.init();
    app.start();
  };

  // ---- Pointer (Magic Remote, phone-as-remote) ------------------------------------------------

  // In pointer mode hover shows focus (CSS) and clicks act; the keyboard focus ring is hidden so
  // there is only one highlight. Arrow keys switch back. Wheel steps between rows like Up/Down.
  var pointer = {
    on: false,
    set: function (on) {
      if (on === pointer.on) return;
      pointer.on = on;
      document.body.classList.toggle('pointer', on);
    },
    init: function () {
      // webOS tells us when the cursor appears/disappears; mousemove covers desktops
      document.addEventListener('cursorStateChange', function (e) {
        pointer.set(!!(e.detail && e.detail.visibility));
      });
      var last = 0;
      document.addEventListener('mousemove', function () {
        var now = Date.now();
        if (now - last < 100) return;
        last = now;
        pointer.set(true);
      });
      document.addEventListener('keydown', function (e) {
        if (e.keyCode >= 37 && e.keyCode <= 40) pointer.set(false);
      }, true);
      var wheelAt = 0;
      document.addEventListener('wheel', function (e) {
        e.preventDefault();
        var now = Date.now();
        if (now - wheelAt < 180) return;
        wheelAt = now;
        var horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        var code = horizontal ? (e.deltaX > 0 ? PL.KEY.RIGHT : PL.KEY.LEFT) : (e.deltaY > 0 ? PL.KEY.DOWN : PL.KEY.UP);
        handleKey({ keyCode: code, target: document.body, preventDefault: function () {} });
      });
    },
  };
  app.pointer = pointer;

  // ---- Launch parameters ({ratingKey, action: 'details' | 'play'}) ----------------------------

  // Other apps (the Hearth launcher's Continue Watching row) open a title directly. Params arrive at
  // launch (PalmSystem.launchParams) or later via webOSRelaunch; they wait until the app is ready.
  var launch = {
    pending: null,
    init: function () {
      launch.take(window.PalmSystem && window.PalmSystem.launchParams);
      document.addEventListener('webOSRelaunch', function (e) {
        launch.take(e.detail);
        launch.run();
      });
    },
    take: function (raw) {
      var p = raw;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
      if (p && p.ratingKey && /^\d+$/.test(String(p.ratingKey))) launch.pending = p;
    },
    seq: 0,
    run: function () {
      var p = launch.pending;
      if (!p || !app.ready || !PL.plex.server) return;
      launch.pending = null;
      var seq = ++launch.seq;
      while (app.stack.length > 1) app.pop();
      if (p.action === 'play') {
        PL.plex.metadata(String(p.ratingKey)).then(function (item) {
          // a newer deep link (or a restart) won the race
          if (seq !== launch.seq || !app.ready || app.stack.length > 1) return;
          app.push(PL.screens.player(item, { offset: item.viewOffset || 0 }));
        }, function (err) { PL.toast(PL.errorMessage(err)); });
      } else {
        app.push(PL.screens.details({ ratingKey: String(p.ratingKey), type: 'movie' }));
      }
    },
  };

  document.addEventListener('DOMContentLoaded', app.init);
})();
