// First run: signing in, Who's watching, PIN, connecting to the server, and what went wrong
// (docs/FIRSTRUN.md, the boards in Direction A "Poster wall"). The decisions are in
// js/firstrun-logic.js; this file draws the views over the poster wall and runs the effects.
//
// On the TV the layer is a screen inside the 1920x1080 stage (css/firstrun.css). In the web build
// it sits outside the scaled stage, as a full-window layer with its own responsive CSS
// (web/firstrun-web.css; web/web.js leaves the stage unscaled while it shows). Popups and the
// local-network permission are the web build's (web/web-signin.js, PL.webSignin).
//
// Input is kept self-contained here: arrows move between whatever is focusable on the view (by
// position, so rows, columns, the keypad and a phone's 2x2 grid all work), OK/Enter acts, Back/Esc
// steps back through the flow, digits type a PIN, and the mouse or a finger acts directly.
'use strict';

(function () {
  var L = PL.firstrunLogic;
  var K = PL.KEY;
  var fr = PL.firstrun = {};
  var POLL_MS = 2000;

  // ---- Small parts --------------------------------------------------------------------------------

  var ICONS = {
    lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2.5 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
    arrowUpRight: [['path', { d: 'M7 17 17 7M9 7h8v8' }]],
    phone: [['rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2.5 }], ['path', { d: 'M11 18.5h2' }]],
    check: [['path', { d: 'M5 12.5 10 17.5 19 7.5' }]],
    x: [['path', { d: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5' }]],
    del: [['path', { d: 'M21 6.5H9.5L3.5 12l6 5.5H21z' }], ['path', { d: 'M12.5 9.5l5 5M17.5 9.5l-5 5' }]],
    home: [['path', { d: 'M3.5 11 12 4l8.5 7' }], ['path', { d: 'M5.5 9.5V20h13V9.5' }], ['path', { d: 'M9.5 15.5a3.5 3.5 0 0 1 5 0' }],
      ['circle', { cx: 12, cy: 18, r: 0.6, fill: 'currentColor' }]],
    server: [['rect', { x: 3.5, y: 4, width: 17, height: 6.5, rx: 1.8 }], ['rect', { x: 3.5, y: 13.5, width: 17, height: 6.5, rx: 1.8 }],
      ['path', { d: 'M7 7.25h.01M7 16.75h.01' }]],
    serverOff: [['rect', { x: 3.5, y: 4, width: 17, height: 6.5, rx: 1.8 }], ['rect', { x: 3.5, y: 13.5, width: 17, height: 6.5, rx: 1.8 }],
      ['path', { d: 'M7 7.25h.01M7 16.75h.01M2.5 2.5l19 19' }]],
    window: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 8.5h18M6 6.25h.01M8.5 6.25h.01' }]],
    windowOff: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 8.5h18M9 12l6 6M15 12l-6 6' }]],
    folderOff: [['path', { d: 'M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }],
      ['path', { d: 'M9.5 11.5l5 5M14.5 11.5l-5 5' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5.5M12 7.8h.01' }]],
    refresh: [['path', { d: 'M20 11.5A8 8 0 0 0 5.6 7M4 12.5A8 8 0 0 0 18.4 17' }], ['path', { d: 'M5 3.5V7h3.5M19 20.5V17h-3.5' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z' }]],
  };

  function icon(name, cls, weight) {
    var svg = PL.glyph(ICONS[name], 24, weight || 2);
    svg.setAttribute('class', 'fr-ic ' + (cls || ''));
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  var el = PL.el;

  function text(tag, cls, s) {
    return el(tag, cls, s);
  }

  // Text with **bold** runs (copy from the boards bolds a few words).
  function rich(tag, cls, s) {
    var n = el(tag, cls);
    String(s).split('**').forEach(function (part, i) {
      if (!part) return;
      n.appendChild(i % 2 ? el('b', '', part) : document.createTextNode(part));
    });
    return n;
  }

  function spinner() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'fr-spin');
    svg.setAttribute('aria-hidden', 'true');
    var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('cx', 12);
    ring.setAttribute('cy', 12);
    ring.setAttribute('r', 10);
    ring.setAttribute('class', 'fr-spin-ring');
    var arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arc.setAttribute('d', 'M12 2a10 10 0 0 1 10 10');
    arc.setAttribute('class', 'fr-spin-arc');
    svg.appendChild(ring);
    svg.appendChild(arc);
    return svg;
  }

  function status(s, busy) {
    var n = el('div', 'fr-status');
    if (busy !== false) n.appendChild(spinner());
    n.appendChild(el('span', 'fr-status-text', s));
    return n;
  }

  function wordmark() {
    var n = el('div', 'fr-brand');
    var img = el('img', 'fr-brand-mark');
    img.src = 'img/firstrun/mark.svg';
    img.alt = '';
    n.appendChild(img);
    var name = el('div', 'fr-brand-name', 'Plex ');
    name.appendChild(el('span', '', 'Lite'));
    n.appendChild(name);
    return n;
  }

  // b: {label, kind: 'primary' | 'glass' | 'text', icon, trail, action, id}
  function button(b) {
    var n = el('button', 'fr-btn fr-btn-' + (b.kind || 'glass') + ' fr-focusable');
    n.type = 'button';
    if (b.icon) n.appendChild(icon(b.icon, 'fr-btn-icon', 2.2));
    n.appendChild(el('span', 'fr-btn-label', b.label));
    if (b.trail) n.appendChild(icon(b.trail, 'fr-btn-trail', 2.4));
    n.plAction = b.action;
    if (b.id) n.setAttribute('data-id', b.id);
    return n;
  }

  // A row (or, on a phone, a column) of buttons with one white plate travelling between them
  // (ui.Glider in 2D mode: the same marks as the tab bar and the player's buttons).
  function actions(list, cls) {
    var row = el('div', 'fr-actions ' + (cls || ''));
    list.filter(Boolean).forEach(function (b) { row.appendChild(button(b)); });
    row.plGlider = new PL.ui.Glider(row, { twoD: true });
    return row;
  }

  var AVATAR_TINTS = 5;

  function avatar(user, i, big) {
    var a = el('div', 'fr-avatar fr-tint-' + (i % AVATAR_TINTS) + (big ? ' fr-avatar-big' : ''));
    a.appendChild(el('span', 'fr-avatar-initial', (user.title || '?').charAt(0).toUpperCase()));
    if (user.thumb && /^https:\/\//.test(user.thumb)) {
      var img = el('img', 'fr-avatar-img');
      img.alt = '';
      img.addEventListener('load', function () { a.classList.add('fr-has-img'); });
      img.src = user.thumb;
      a.appendChild(img);
    }
    if (user.protected) {
      var lock = el('div', 'fr-avatar-lock');
      lock.appendChild(icon('lock', '', 2.4));
      a.appendChild(lock);
    }
    return a;
  }

  // QR code (js/vendor/qrcodegen.js) as one SVG path; the white quiet zone is the tile around it.
  function qr(textValue) {
    var box = el('div', 'fr-qr');
    if (!window.qrcodegen) return box;
    var code;
    try {
      code = window.qrcodegen.QrCode.encodeText(textValue, window.qrcodegen.QrCode.Ecc.MEDIUM);
    } catch (e) {
      PL.warn('qr', e && e.message);
      return box;
    }
    var n = code.size;
    var d = [];
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) if (code.getModule(x, y)) d.push('M' + x + ' ' + y + 'h1v1h-1z');
    }
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + n + ' ' + n);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code for ' + textValue.replace(/^https:\/\//, ''));
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d.join(''));
    path.setAttribute('fill', '#0b0b0e');
    svg.appendChild(path);
    box.appendChild(svg);
    return box;
  }

  function codeTiles(code) {
    var n = el('div', 'fr-tiles');
    String(code || '    ').split('').forEach(function (ch) { n.appendChild(el('div', 'fr-tile', ch.trim() ? ch : '')); });
    n.setAttribute('aria-label', code ? 'Code ' + String(code).split('').join(' ') : 'Getting a code');
    return n;
  }

  function sheet(cls, children) {
    return el('div', { className: 'fr-sheet ' + (cls || '') }, children);
  }

  function badge(name, grey) {
    var b = el('div', 'fr-badge' + (grey ? ' fr-badge-grey' : ''));
    b.appendChild(icon(name, '', 1.9));
    return b;
  }

  function keycap(k, label) {
    var n = el('span', 'fr-keycap');
    n.appendChild(el('span', 'fr-keycap-key', PL.keyLabel(k)));
    n.appendChild(document.createTextNode(label));
    return n;
  }

  // ---- The flow --------------------------------------------------------------------------------------

  // opts: {view, firstRun, from: 'launch' | 'settings', onConnected (-> Promise: the app loads),
  //        users, error}
  function Flow(opts) {
    this.opts = opts;
    this.platform = PL.isWeb ? 'web' : 'tv';
    this.s = L.initial({ platform: this.platform, firstRun: opts.firstRun, from: opts.from, hasProfiles: !!(opts.users && opts.users.length > 1), view: opts.view });
    this.users = opts.users || [];
    this.account = '';
    this.alive = true;
    this.timers = {};
    this.seq = 0;   // view-bound work (polls, codes): a new view drops the old view's
    this.cseq = 0;  // connect attempts: Cancel, Back and Sign out drop the one under way
    this.external = false; // an ordinary launch: js/app.js's start drives the first connect
    this.focus = null;
    this.mounted = false;
    this.lna = null; // {resolve} while the explainer waits
    this.servers = [];
    this.notice = '';
  }

  Flow.prototype.timer = function (name, fn, ms) {
    clearTimeout(this.timers[name]);
    var self = this;
    this.timers[name] = setTimeout(function () { if (self.alive) fn(); }, ms);
  };

  Flow.prototype.stopTimers = function () {
    var t = this.timers;
    Object.keys(t).forEach(function (k) { clearTimeout(t[k]); });
  };

  // ---- Mounting: the layer and its place in the app's screen stack

  Flow.prototype.mount = function () {
    if (this.mounted) return;
    this.mounted = true;
    var self = this;
    var root = el('div', 'fr fr-' + this.platform);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Plex Lite');
    var wall = el('div', 'fr-wall');
    this.sharp = el('div', 'fr-wall-img fr-wall-sharp');
    this.soft = el('div', 'fr-wall-img fr-wall-soft');
    if (PL.storage.get('firstrun.drift', true) !== false) root.classList.add('fr-drift');
    wall.appendChild(this.sharp);
    wall.appendChild(this.soft);
    wall.appendChild(el('div', 'fr-veil'));
    wall.appendChild(el('div', 'fr-wedge'));
    wall.appendChild(el('div', 'fr-fade-bottom'));
    root.appendChild(wall);
    root.appendChild(wordmark());
    this.viewEl = el('div', 'fr-view');
    root.appendChild(this.viewEl);
    this.keysEl = el('div', 'fr-keys');
    root.appendChild(this.keysEl);
    this.root = root;

    // pointer: what the mouse moves onto takes the focus (not what a new view puts under a
    // resting pointer: browsers send a mouse event then too); a click acts
    var at = { x: -1, y: -1 };
    root.addEventListener('mousemove', function (e) {
      if (e.clientX === at.x && e.clientY === at.y) return;
      at.x = e.clientX;
      at.y = e.clientY;
      var t = e.target.closest ? e.target.closest('.fr-focusable') : null;
      if (t && t !== self.focus && root.contains(t)) self.setFocus(t, true);
    });
    root.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.fr-focusable') : null;
      if (!t || !root.contains(t)) return;
      e.preventDefault();
      self.setFocus(t, true);
      self.activate(t);
    });
    // keyboard focus (Tab) follows into the plate
    root.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('fr-focusable') && t !== self.focus) self.setFocus(t, true);
    });
    // the app turns wheel turns into arrow presses; here a tall view may scroll instead
    root.addEventListener('wheel', function (e) { e.stopPropagation(); });

    this.screen = {
      el: PL.isWeb ? el('div', 'fr-placeholder') : root,
      ownsBack: true,
      canBack: function () { return !!self.backTo(); },
      show: function () {
        PL.app.backdrop.set(null, 'none');
        if (PL.isWeb) self.attachWeb(true);
      },
      hide: function () { if (PL.isWeb) self.attachWeb(false); },
      destroy: function () { self.destroy(); },
      key: function (code, e) { return self.key(code, e); },
    };
    if (this.opts.from === 'settings') PL.app.push(this.screen);
    else PL.app.setRoot(this.screen);
    this.onResize = PL.rafThrottle(function () { self.relayout(); });
    window.addEventListener('resize', this.onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { self.relayout(); });
  };

  // The web build: the layer goes outside the scaled stage while it shows (web/web.js unscales).
  Flow.prototype.attachWeb = function (on) {
    if (!this.root) return;
    var html = document.documentElement;
    if (on) {
      if (this.root.parentNode !== document.body) document.body.appendChild(this.root);
      html.classList.add('fr-on');
    } else {
      if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
      html.classList.remove('fr-on');
    }
    if (PL.web && PL.web.fit) PL.web.fit();
  };

  Flow.prototype.destroy = function () {
    this.alive = false;
    this.stopTimers();
    if (this.lna) { this.lna.resolve('skip'); this.lna = null; }
    window.removeEventListener('resize', this.onResize);
    if (PL.webSignin) PL.webSignin.stop();
    if (PL.isWeb) this.attachWeb(false);
    if (cur === this) cur = null;
  };

  // Leaves the flow: the screen underneath (Settings) comes back, or the app's next root replaces it.
  Flow.prototype.close = function () {
    if (this.opts.from === 'settings' && PL.app.top() === this.screen) PL.app.pop();
    else this.destroy();
  };

  // ---- State changes

  Flow.prototype.dispatch = function (e) {
    var before = this.s;
    var next = L.next(before, e);
    if (next === before) return false;
    this.s = next;
    if (next.view !== before.view) this.render(before.view);
    else this.update(e);
    return true;
  };

  Flow.prototype.backTo = function () {
    if (this.s.view === 'connecting') return L.cancelTarget(this.s);
    if (this.opts.from === 'settings' && (this.s.view === 'profiles')) return 'close';
    return L.backTarget(this.s);
  };

  Flow.prototype.back = function () {
    var to = this.backTo();
    if (!to) return false;
    if (to === 'close') { this.close(); return true; }
    if (this.s.view === 'connecting') { this.cancelConnect(); return true; }
    if (this.s.view === 'lna') {
      // the request waiting for the explainer is dropped with it
      this.cseq++;
      this.restore(this.attempt);
      if (this.lna) { this.lna.resolve('skip'); this.lna = null; }
    }
    if (this.s.view === 'waiting' && PL.webSignin) {
      PL.webSignin.cancel();
      this.returning = null;
    }
    if (to === 'profiles' && this.users.length < 2) return false;
    this.dispatch({ type: 'BACK' });
    return true;
  };

  // ---- Rendering

  var WALL = {
    welcome: 'hero', waiting: 'side', code: 'side', blocked: 'soft', profiles: 'soft', pin: 'soft', lna: 'soft',
    connecting: 'soft', error: 'soft', servers: 'soft',
  };

  Flow.prototype.render = function (from) {
    var self = this;
    var v = this.s.view;
    this.mount();
    this.fitWeb();
    var root = this.root;
    root.className = root.className.replace(/\bfr-v-\S+|\bfr-m-\S+/g, '').replace(/\s+/g, ' ').trim() +
      ' fr-v-' + v + ' fr-m-' + WALL[v];
    // the new view replaces the old: out (70 ms), swap, rise in
    var old = this.viewEl.firstChild;
    this.building = true;
    var build = function () {
      self.building = false;
      PL.clear(self.viewEl);
      v = self.s.view;
      // a full-size page per view: it fades and rises in, while what's inside keeps its own placing
      var node = el('div', 'fr-page fr-page-' + v);
      node.appendChild(self.build(v));
      self.viewEl.appendChild(node);
      if (from) {
        node.classList.add('mode-in');
        setTimeout(function () { node.classList.remove('mode-in'); }, 520);
      }
      self.keys(v);
      if (v !== 'connecting' && v !== 'lna') self.external = false;
      self.focus = null;
      self.setFocus(self.firstFocus(v), false);
      self.enter(v, from);
    };
    if (old && from) {
      old.classList.add('mode-out');
      this.timer('swap', build, 80);
    } else {
      clearTimeout(this.timers.swap);
      build();
    }
  };

  // The web build: which layout fits the window (web/firstrun-web.css), and how far to zoom it.
  //   desk  the 1440x900 boards, zoomed by the window (0.7 to 1.45), the margin growing on wide screens
  //   stack portrait phones and tablets (the phone boards, zoomed up to 1.35 on a tablet)
  //   short phones in landscape (height 500 or less)
  Flow.prototype.fitWeb = function () {
    if (!PL.isWeb || !this.root) return;
    var w = document.documentElement.clientWidth || window.innerWidth;
    var h = document.documentElement.clientHeight || window.innerHeight;
    var layout = L.webLayout(w, h);
    var z = L.webZoom(layout, w, h);
    var root = this.root;
    ['desk', 'stack', 'short'].forEach(function (l) { root.classList.toggle('fr-l-' + l, l === layout); });
    root.classList.toggle('fr-wide', layout === 'desk' && w / h > 2);
    root.style.setProperty('--frz', String(z));
    root.style.setProperty('--frmx', Math.round(L.webMargin(layout, w, z)) + 'px');
    this.layout = layout;
  };

  Flow.prototype.relayout = function () {
    if (!this.root) return;
    this.fitWeb();
    var rows = this.root.querySelectorAll('.fr-actions');
    for (var i = 0; i < rows.length; i++) if (rows[i].plGlider) rows[i].plGlider.invalidate();
    this.paintFocus(true);
  };

  Flow.prototype.keys = function (v) {
    PL.clear(this.keysEl);
    if (this.platform !== 'tv') return;
    if (v === 'code') { this.keysEl.appendChild(keycap('OK', 'New code')); this.keysEl.appendChild(keycap('Back', 'Exit')); }
    if (v === 'profiles') {
      this.keysEl.appendChild(keycap('OK', 'Choose'));
      this.keysEl.appendChild(keycap('Back', this.opts.from === 'settings' ? 'Back' : 'Exit'));
    }
    if (v === 'pin') { this.keysEl.appendChild(keycap('0–9', 'Type the PIN')); this.keysEl.appendChild(keycap('Back', 'Choose someone else')); }
  };

  Flow.prototype.build = function (v) {
    return this['view_' + v]();
  };

  // ---- Views

  var COPY = {
    head: 'Your films and shows, front and centre.',
    sub: 'Sign in with your Plex account to watch everything on your Plex server.',
    trust: 'You sign in on Plex’s own page. Plex Lite never sees your password, and keeps its sign-in only in this browser.',
    credit1: 'Plex Lite is an independent app, not made by Plex, Inc.',
    credit2: 'Poster art: Blender Foundation open movies (CC BY, CC BY-SA) and public-domain classics.',
    creditShort: 'Not made by Plex, Inc. · Poster art: Blender Foundation (CC BY, CC BY-SA) and public domain.',
  };

  Flow.prototype.view_welcome = function () {
    var self = this;
    var v = el('div', 'fr-col fr-hero');
    v.appendChild(text('h1', 'fr-title fr-title-hero', COPY.head));
    v.appendChild(text('p', 'fr-lead', COPY.sub));
    v.appendChild(actions([
      { label: 'Sign in with Plex', kind: 'primary', trail: 'arrowUpRight', action: function () { self.signInWithPlex(); } },
      { label: 'Use a code instead', icon: 'phone', action: function () { self.dispatch({ type: 'USE_CODE' }); } },
    ]));
    var trust = el('div', 'fr-trust');
    trust.appendChild(icon('lock', 'fr-trust-icon', 2));
    trust.appendChild(el('span', '', COPY.trust));
    v.appendChild(trust);
    this.noticeEl = el('div', 'fr-notice', this.notice);
    this.notice = '';
    v.appendChild(this.noticeEl);
    var credit = el('div', 'fr-credit');
    credit.appendChild(el('span', 'fr-credit-long', COPY.credit1));
    credit.appendChild(el('br', 'fr-credit-long'));
    credit.appendChild(el('span', 'fr-credit-long', COPY.credit2));
    credit.appendChild(el('span', 'fr-credit-short', COPY.creditShort));
    var wrap = el('div', 'fr-view-welcome');
    wrap.appendChild(v);
    wrap.appendChild(credit);
    return wrap;
  };

  Flow.prototype.view_waiting = function () {
    var self = this;
    var back = this.returning;
    var v = el('div', 'fr-col');
    v.appendChild(rich('h1', 'fr-title', back ? 'Finishing signing in' : 'Finish signing in\nin the Plex window'));
    v.appendChild(text('p', 'fr-lead', back ? 'Plex sent you back here. This takes a moment.'
      : 'Plex’s sign-in page is open in a small window. Sign in there and this page carries on by itself.'));
    this.statusEl = status(back ? 'Finishing sign-in…' : 'Waiting for Plex…');
    v.appendChild(this.statusEl);
    v.appendChild(actions([
      back ? null : { label: 'Show the Plex window', kind: 'primary', icon: 'window', action: function () { self.showPopup(); } },
      { label: 'Use a code instead', icon: 'phone', action: function () { self.dispatch({ type: 'USE_CODE' }); } },
      { label: 'Cancel', kind: 'text', action: function () { self.back(); } },
    ]));
    if (!back) v.appendChild(rich('p', 'fr-note', 'Closed it by mistake? Choose **Show the Plex window** to open it again.'));
    return v;
  };

  Flow.prototype.view_blocked = function () {
    var self = this;
    return sheet('fr-card', [
      badge('windowOff', true),
      text('h2', 'fr-sheet-title', 'Your browser blocked the Plex window'),
      text('p', 'fr-sheet-body', 'That’s fine: you can sign in on Plex’s page in this tab instead, and come straight back here afterwards.'),
      actions([
        { label: 'Continue in this tab', kind: 'primary', action: function () { self.continueInTab(); } },
        { label: 'Use a code instead', action: function () { self.dispatch({ type: 'USE_CODE' }); } },
      ], 'fr-stack'),
    ]);
  };

  Flow.prototype.view_code = function () {
    var self = this;
    var tv = this.platform === 'tv';
    var wrap = el('div', 'fr-view-code');
    var v = el('div', 'fr-col');
    v.appendChild(text('h1', 'fr-title', tv ? 'Sign in to Plex Lite' : 'Sign in on another device'));
    var steps = el('ol', 'fr-steps');
    var s1 = el('li', 'fr-step');
    s1.appendChild(el('span', 'fr-step-n', '1'));
    s1.appendChild(rich('span', '', 'On your phone or computer, go to **plex.tv/link**'));
    var s2 = el('li', 'fr-step');
    s2.appendChild(el('span', 'fr-step-n', '2'));
    s2.appendChild(el('span', '', 'Enter this code'));
    steps.appendChild(s1);
    steps.appendChild(s2);
    v.appendChild(steps);
    // a phone is the device in hand: send them to a computer or tablet instead
    var phone = el('p', 'fr-steps-phone');
    phone.appendChild(document.createTextNode('On a computer or tablet, go to'));
    phone.appendChild(el('b', '', 'plex.tv/link'));
    phone.appendChild(document.createTextNode('and enter this code:'));
    v.appendChild(phone);
    this.tilesEl = codeTiles(this.code && this.code.code);
    v.appendChild(this.tilesEl);
    this.statusEl = status(tv ? 'Waiting for you to sign in… A new code appears if this one runs out.'
      : 'Waiting for the code… A new one appears if this one runs out.');
    v.appendChild(this.statusEl);
    if (!tv) {
      v.appendChild(actions([
        { label: 'Sign in with Plex instead', kind: 'primary', action: function () { self.signInWithPlex(); } },
        { label: 'Back', action: function () { self.back(); } },
      ]));
    }
    wrap.appendChild(v);
    // the TV has no welcome screen: the wall's credit sits here
    if (tv) wrap.appendChild(el('div', 'fr-credit fr-credit-tv', COPY.creditShort));
    this.qrWrap = el('div', 'fr-qr-holder');
    this.qrWrap.appendChild(qr(L.linkUrl(this.code && this.code.code)));
    wrap.appendChild(sheet('fr-qr-card', [
      this.qrWrap,
      text('div', 'fr-qr-title', 'Or scan with your phone'),
      rich('div', 'fr-qr-text', tv ? 'Opens plex.tv/link\nwith the code filled in.' : 'The camera opens plex.tv/link\nwith this code filled in.'),
    ]));
    return wrap;
  };

  Flow.prototype.view_profiles = function () {
    var self = this;
    var v = el('div', 'fr-who');
    v.appendChild(text('h1', 'fr-who-title', 'Who’s watching?'));
    var row = el('div', 'fr-profiles');
    this.users.forEach(function (u, i) {
      var cell = el('button', 'fr-profile fr-focusable');
      cell.type = 'button';
      cell.setAttribute('aria-label', u.title + (u.protected ? ', PIN' : ''));
      cell.appendChild(avatar(u, i));
      cell.appendChild(el('span', 'fr-pname', u.title));
      var note = L.profileNote(u);
      cell.appendChild(el('span', 'fr-pnote', note));
      cell.plAction = function () { self.pick(u); };
      cell.plIndex = i;
      row.appendChild(cell);
    });
    v.appendChild(row);
    var foot = el('div', 'fr-who-foot');
    foot.appendChild(el('p', 'fr-who-note', this.opts.from === 'settings' ? 'Pick who’s watching on this ' + (PL.isWeb ? 'browser.' : 'TV.')
      : 'You can switch profiles any time in Settings.'));
    foot.appendChild(actions([
      this.opts.from === 'settings' ? { label: 'Back', action: function () { self.close(); } } : null,
      { label: 'Not you? Sign out', action: function () { self.signOut(); } },
    ]));
    v.appendChild(foot);
    return v;
  };

  Flow.prototype.view_pin = function () {
    var self = this;
    var u = this.s.user || { title: '' };
    var v = el('div', 'fr-pin');
    var side = el('div', 'fr-pin-side');
    side.appendChild(avatar(u, Math.max(0, this.users.indexOf(u)), true));
    side.appendChild(text('h1', 'fr-pin-title', 'Enter ' + u.title + '’s PIN'));
    this.dotsEl = el('div', 'fr-dots');
    this.dotsEl.setAttribute('aria-live', 'polite');
    for (var i = 0; i < L.PIN_LENGTH; i++) this.dotsEl.appendChild(el('span', 'fr-dot'));
    side.appendChild(this.dotsEl);
    this.pinHelp = el('p', 'fr-pin-help', 'Type the four digits, or use the keypad. Forgotten it? Whoever runs this Plex Home can change it in Plex’s settings.');
    side.appendChild(this.pinHelp);
    side.appendChild(actions([{ label: 'Choose someone else', action: function () { self.back(); } }], 'fr-pin-other'));
    v.appendChild(side);
    var pad = el('div', 'fr-keypad');
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].forEach(function (k) {
      if (!k) { pad.appendChild(el('span', 'fr-key fr-key-gap')); return; }
      var key = el('button', 'fr-key fr-focusable');
      key.type = 'button';
      if (k === 'del') {
        key.appendChild(icon('del', '', 1.9));
        key.setAttribute('aria-label', 'Delete');
      } else {
        key.textContent = k;
      }
      key.setAttribute('data-key', k);
      key.plAction = function () { self.pinKey(k); };
      pad.appendChild(key);
    });
    v.appendChild(pad);
    return v;
  };

  Flow.prototype.view_lna = function () {
    var self = this;
    var head = el('div', 'fr-sheet-head');
    head.appendChild(badge('home'));
    head.appendChild(el('div', 'fr-eyebrow', 'One more step'));
    var info = el('div', 'fr-info');
    info.appendChild(icon('info', 'fr-info-icon', 2));
    info.appendChild(el('span', '', 'If you choose Block, Plex Lite still works. It connects through Plex Remote Access instead, which can be slower. You can change this later in Settings.'));
    return sheet('fr-lna', [
      head,
      rich('h2', 'fr-sheet-title fr-title-lna', 'Play straight from\nyour server at home'),
      rich('p', 'fr-sheet-body', (PL.web && PL.web.browser ? PL.web.browser.name : 'Your browser') +
        ' will ask whether this site may look for devices on your local network. Choose **Allow** and Plex Lite streams directly from your Plex server when you’re at home.'),
      info,
      actions([
        { label: 'Continue', kind: 'primary', action: function () { self.lnaChoice('allow'); } },
        { label: 'Skip for now', action: function () { self.lnaChoice('skip'); } },
      ], 'fr-lna-actions'),
    ]);
  };

  Flow.prototype.view_connecting = function () {
    var self = this;
    var head = el('div', 'fr-sheet-head');
    head.appendChild(badge('server'));
    var t = el('div', 'fr-conn-head');
    t.appendChild(el('div', 'fr-conn-small', 'Connecting to'));
    this.serverNameEl = el('div', 'fr-conn-name', this.s.server || 'your Plex server');
    t.appendChild(this.serverNameEl);
    head.appendChild(t);
    this.stepsEl = el('div', 'fr-conn-steps');
    this.connNote = rich('div', 'fr-conn-note', 'Changed your mind? Allow it under **Settings › Local network access** and Plex Lite switches to your home network by itself.');
    var target = L.cancelTarget(this.s);
    var kids = [head, this.stepsEl, this.connNote];
    if (target || this.opts.from === 'settings') kids.push(actions([{ label: 'Cancel', action: function () { self.cancelConnect(); } }], 'fr-conn-actions'));
    var sh = sheet('fr-conn', kids);
    this.paintRoutes(sh);
    return sh;
  };

  var ROUTE_DETAIL = {
    lan: { trying: 'Looking for the server at home…', ok: 'Connected at home', none: 'No address at home', fail: 'No answer at home',
      timeout: 'No answer at home', refused: 'The server turned this device away', skipped: 'Skipped for now, so Plex Lite won’t look for the server at home.' },
    remote: { trying: 'Connecting over the internet…', ok: 'Connected over the internet', none: 'Not turned on for this server', fail: 'No answer',
      timeout: 'No answer', refused: 'The server turned this device away' },
    relay: { trying: 'Connecting through Plex’s relay…', ok: 'Connected through Plex’s relay', none: 'Not available', fail: 'No answer', timeout: 'No answer',
      refused: 'The server turned this device away' },
  };

  function stepRow(state, title, detail) {
    var row = el('div', 'fr-step-row fr-step-' + state);
    var mark = el('div', 'fr-step-mark');
    if (state === 'busy') mark.appendChild(spinner());
    else if (state === 'done') mark.appendChild(icon('check', '', 2.6));
    else if (state === 'skip') mark.appendChild(icon('x', '', 2.4));
    row.appendChild(mark);
    var body = el('div', 'fr-step-body');
    body.appendChild(el('div', 'fr-step-title', title));
    if (detail) body.appendChild(el('div', 'fr-step-detail', detail));
    row.appendChild(body);
    return row;
  }

  Flow.prototype.paintRoutes = function (sheetEl) {
    if (!this.stepsEl) return;
    var r = this.s.routes || {};
    var steps = this.stepsEl;
    PL.clear(steps);
    var who = this.s.user ? this.s.user.title : this.account || (PL.storage.get('profile', null) || {}).title;
    steps.appendChild(stepRow('done', who ? 'Signed in as ' + who : 'Signed in', ''));
    var any = false;
    ['lan', 'remote', 'relay'].forEach(function (k) {
      var st = r[k];
      if (!st || (k === 'relay' && (st === 'none'))) return;
      if (k !== 'lan' && st === 'none' && r.lan === 'ok') return;
      any = true;
      var state = st === 'ok' ? 'done' : st === 'trying' ? 'busy' : 'skip';
      var detail = (ROUTE_DETAIL[k] && ROUTE_DETAIL[k][st]) || '';
      if (k === 'lan' && st === 'blocked') {
        detail = 'Blocked in ' + (PL.web && PL.web.browser ? PL.web.browser.name : 'this browser') + ', so Plex Lite won’t look for the server at home.';
      }
      steps.appendChild(stepRow(state, L.routeLabel(k), detail));
    });
    if (!any) steps.appendChild(stepRow('busy', 'Finding your server', 'Asking plex.tv where it is…'));
    var lanOff = r.lan === 'blocked' || r.lan === 'skipped';
    if (this.connNote) this.connNote.classList.toggle('fr-hidden', !(lanOff && PL.isWeb));
    if (this.serverNameEl && this.s.server) this.serverNameEl.textContent = this.s.server;
    if (sheetEl) return;
    this.relayout();
  };

  Flow.prototype.view_error = function () {
    var self = this;
    var e = this.s.error || { sheet: 'unreachable' };
    var server = e.server || 'Your server';
    var hasProfiles = this.users.length > 1;
    var out;
    if (e.sheet === 'noServer') {
      out = sheet('fr-card fr-err', [
        badge('server', true),
        text('h2', 'fr-sheet-title', 'No Plex server on this account'),
        text('p', 'fr-sheet-body', 'Your Plex account doesn’t have a server yet, and nobody has shared one with you. Set up Plex Media Server on a computer or NAS, or ask a friend to share a library, then try again.'),
        actions([
          { label: 'Try again', kind: 'primary', icon: 'refresh', action: function () { self.retry(); } },
          { label: 'Sign out', action: function () { self.signOut(); } },
        ], 'fr-stack'),
      ]);
    } else if (e.sheet === 'noLibraries') {
      var who = this.s.user && !this.s.user.admin ? this.s.user.title : '';
      out = sheet('fr-card fr-err', [
        badge('folderOff', true),
        text('h2', 'fr-sheet-title', who ? who + ' can’t see any libraries' : 'No libraries to show'),
        text('p', 'fr-sheet-body', who ? 'This profile hasn’t been given any libraries on ' + server + ' yet. Whoever runs this Plex Home can share some with it in Plex’s settings.'
          : 'Plex Lite shows film and TV libraries, and ' + server + ' has none this account can see. Add one in Plex Media Server, then try again.'),
        actions([
          hasProfiles ? { label: 'Choose another profile', kind: 'primary', action: function () { self.dispatch({ type: 'CHOOSE_PROFILE' }); } } : null,
          { label: 'Try again', kind: hasProfiles ? 'glass' : 'primary', icon: hasProfiles ? null : 'refresh', action: function () { self.retry(); } },
          hasProfiles ? null : { label: 'Sign out', action: function () { self.signOut(); } },
        ], 'fr-stack'),
      ]);
    } else if (e.sheet === 'plexTv') {
      out = sheet('fr-card fr-err', [
        badge('globe', true),
        text('h2', 'fr-sheet-title', 'Can’t reach plex.tv'),
        text('p', 'fr-sheet-body', 'Plex Lite asks plex.tv where your server is. Check this ' + (PL.isWeb ? 'device’s' : 'TV’s') + ' internet connection, then try again.'),
        actions([
          { label: 'Try again', kind: 'primary', icon: 'refresh', action: function () { self.retry(); } },
          { label: 'Sign out', action: function () { self.signOut(); } },
        ], 'fr-stack'),
      ]);
    } else {
      var secure = e.code === 'NO_SECURE_ADDRESS';
      var rows = el('div', 'fr-tried');
      L.triedRows(e.routes, false).forEach(function (r) {
        var row = el('div', 'fr-tried-row');
        var where = el('span', 'fr-tried-where');
        where.appendChild(el('span', 'fr-long', r.label));
        where.appendChild(el('span', 'fr-short', L.routeLabel(r.kind, true)));
        row.appendChild(where);
        var val = el('span', 'fr-tried-result');
        val.appendChild(el('span', 'fr-long', r.value));
        val.appendChild(el('span', 'fr-short', L.routeResult(r.kind, (e.routes || {})[r.kind] || 'none', true)));
        row.appendChild(val);
        rows.appendChild(row);
      });
      var known = !!e.routes && !secure;
      var hint = known ? L.triedHint(e.routes) : '';
      out = sheet('fr-err fr-err-wide', [
        badge('serverOff', true),
        text('h2', 'fr-sheet-title', secure ? server + ' needs a secure address' : known ? server + ' isn’t answering' : 'Couldn’t connect to ' + (e.server || 'your server')),
        text('p', 'fr-sheet-body', secure ? 'A browser can only use secure (https) connections. In Plex, open Settings › Network and set Secure connections to Preferred, then try again.'
          : known ? 'Plex Lite found your server but couldn’t reach it from here. Check that the computer running Plex Media Server is switched on and awake.'
            : 'Something went wrong while connecting' + (e.detail ? ': ' + e.detail : '.') + ' Try again in a moment.'),
        known ? rows : null,
        hint ? el('div', 'fr-tried-hint', hint) : null,
        actions([
          { label: 'Try again', kind: 'primary', icon: 'refresh', action: function () { self.retry(); } },
          e.servers > 1 ? { label: 'Choose another server', action: function () { self.chooseServer(); } } : null,
          { label: 'Sign out', kind: 'text', action: function () { self.signOut(); } },
        ], 'fr-err-actions'),
      ].filter(Boolean));
    }
    return out;
  };

  Flow.prototype.view_servers = function () {
    var self = this;
    return sheet('fr-card', [
      badge('server'),
      text('h2', 'fr-sheet-title', 'Choose a server'),
      actions(this.servers.map(function (s) {
        return { label: s.name + (s.owned ? '' : ' (shared)'), action: function () { self.useServer(s.clientIdentifier); } };
      }).concat([{ label: 'Back', kind: 'text', action: function () { self.back(); } }]), 'fr-stack'),
    ]);
  };

  // ---- Partial updates (the view stays)

  Flow.prototype.update = function (e) {
    if (this.building) return; // the new view draws from the state when it's built
    if (this.s.view === 'pin') this.paintPin(e);
    if (this.s.view === 'connecting') this.paintRoutes();
  };

  Flow.prototype.paintPin = function (e) {
    var dots = this.dotsEl ? this.dotsEl.children : [];
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('fr-dot-on', i < this.s.pin.length);
    var wrong = this.s.pinError;
    this.pinHelp.textContent = wrong === 'failed' ? 'Plex couldn’t check the PIN just now. Try again.'
      : wrong ? 'That PIN isn’t right. Try again, or choose someone else.'
        : 'Type the four digits, or use the keypad. Forgotten it? Whoever runs this Plex Home can change it in Plex’s settings.';
    this.pinHelp.classList.toggle('fr-pin-wrong', !!wrong);
    if (e && e.type === 'PIN_WRONG') {
      var d = this.dotsEl;
      d.classList.remove('fr-shake');
      d.offsetWidth; // restart the animation
      d.classList.add('fr-shake');
    }
  };

  // ---- Focus

  Flow.prototype.focusables = function () {
    var list = this.viewEl.querySelectorAll('.fr-focusable');
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i].offsetWidth) out.push(list[i]);
    return out;
  };

  Flow.prototype.firstFocus = function (v) {
    var f = this.focusables();
    if (v === 'profiles') {
      var i = L.firstFocus(this.users, (PL.storage.get('profile', null) || {}).uuid);
      return f[i] || f[0];
    }
    if (v === 'pin') return this.viewEl.querySelector('[data-key="5"]');
    // connecting: nothing is chosen for you (an arrow reaches Cancel; Back cancels)
    if (v === 'connecting') return null;
    var primary = this.viewEl.querySelector('.fr-btn-primary');
    return primary || f[0] || null;
  };

  Flow.prototype.setFocus = function (node, fromPointer) {
    if (!node) return;
    if (this.focus && this.focus !== node) this.focus.classList.remove('focused');
    this.focus = node;
    node.classList.add('focused');
    if (PL.isWeb && !fromPointer && document.activeElement !== node && node.focus) {
      try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
    }
    this.paintFocus(false);
  };

  // The plate goes to the focused button's row; other rows lose theirs.
  Flow.prototype.paintFocus = function () {
    if (!this.root) return;
    var rows = this.root.querySelectorAll('.fr-actions');
    var focus = this.focus;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var nodes = [];
      for (var j = 0; j < row.children.length; j++) if (row.children[j].classList.contains('fr-btn')) nodes.push(row.children[j]);
      var at = nodes.indexOf(focus);
      if (row.plGlider && PL.glideTo) PL.glideTo(row.plGlider, nodes, at);
    }
  };

  function centre(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // The nearest focusable in the arrow's direction, by position on screen.
  Flow.prototype.move = function (code) {
    var list = this.focusables();
    if (!this.focus || list.indexOf(this.focus) === -1) {
      this.setFocus(this.firstFocus(this.s.view) || list[0], false);
      return true;
    }
    var from = this.focus.getBoundingClientRect();
    var c = centre(from);
    var best = null;
    var bestScore = Infinity;
    list.forEach(function (n) {
      if (n === this.focus) return;
      var r = n.getBoundingClientRect();
      var p = centre(r);
      var dx = p.x - c.x;
      var dy = p.y - c.y;
      var along;
      var across;
      if (code === K.LEFT) { if (r.right > from.left + 1 && dx >= -1) return; along = -dx; across = Math.abs(dy); }
      else if (code === K.RIGHT) { if (r.left < from.right - 1 && dx <= 1) return; along = dx; across = Math.abs(dy); }
      else if (code === K.UP) { if (r.bottom > from.top + 1 && dy >= -1) return; along = -dy; across = Math.abs(dx); }
      else { if (r.top < from.bottom - 1 && dy <= 1) return; along = dy; across = Math.abs(dx); }
      if (along <= 0) return;
      var score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = n; }
    }, this);
    if (best) this.setFocus(best, false);
    return true;
  };

  Flow.prototype.activate = function (node) {
    // the outgoing view's buttons do nothing while it fades out
    if (this.building || !node || !this.viewEl.contains(node)) return;
    if (node.plAction) node.plAction();
  };

  Flow.prototype.key = function (code) {
    if (!this.alive) return false;
    var v = this.s.view;
    if (v === 'pin') {
      var d = L.digitFromKey(code);
      if (d != null) { this.pinKey(d); return true; }
      if (code === K.BACKSPACE) {
        if (this.s.pin) this.pinKey('del');
        return true;
      }
    }
    if (PL.isBack(code)) {
      if (this.back()) return true;
      // nowhere to go back to: the TV app exits, the browser stays
      if (this.opts.from === 'settings') { this.close(); return true; }
      return this.platform === 'web';
    }
    if (code === K.LEFT || code === K.RIGHT || code === K.UP || code === K.DOWN) return this.move(code);
    if (code === K.ENTER) {
      if (v === 'code' && this.platform === 'tv') { this.newCode(); return true; }
      this.activate(this.focus);
      return true;
    }
    return false;
  };

  // ---- Effects when a view opens

  Flow.prototype.enter = function (v, from) {
    var self = this;
    var seq = ++this.seq;
    clearTimeout(this.timers.poll);
    clearTimeout(this.timers.pin);
    if (v !== 'waiting' && v !== 'welcome' && v !== 'code' && PL.webSignin) PL.webSignin.stop();
    if (v === 'welcome' && PL.webSignin) PL.webSignin.prepare(function (msg) { self.say(msg); });
    if (v === 'waiting') {
      var p = this.returning || (PL.webSignin && PL.webSignin.current());
      if (p) this.poll(p, seq);
    }
    if (v === 'code') {
      if (PL.webSignin) PL.webSignin.cancel(); // a popup left open from Waiting is no longer polled
      this.newCode();
    }
    // (back from the explainer, the connect that asked is still under way)
    if (v === 'connecting' && from !== 'connecting' && from !== 'lna' && !this.external) this.connect();
    if (v === 'pin') this.paintPin(null);
  };

  Flow.prototype.say = function (msg) {
    if (this.noticeEl) this.noticeEl.textContent = msg || '';
  };

  // ---- Signing in

  Flow.prototype.signInWithPlex = function () {
    var w = PL.webSignin;
    if (!w) return;
    // the popup must open inside this click (browsers allow popups only then): the PIN is ready
    var r = w.open();
    this.returning = null;
    if (r === 'opened') this.dispatch({ type: 'POPUP_OPENED' });
    else if (r === 'blocked') this.dispatch({ type: 'POPUP_BLOCKED' });
    else {
      var msg = 'Getting ready… choose Sign in with Plex again in a moment.';
      if (this.s.view !== 'welcome') {
        this.notice = msg;
        this.dispatch({ type: 'SHOW', view: 'welcome' });
      } else {
        this.say(msg);
      }
    }
  };

  Flow.prototype.showPopup = function () {
    var r = PL.webSignin && PL.webSignin.show();
    if (r === 'blocked') this.dispatch({ type: 'POPUP_BLOCKED' });
  };

  Flow.prototype.continueInTab = function () {
    if (PL.webSignin) PL.webSignin.continueInTab();
  };

  // Polls one PIN until plex.tv hands over the sign-in, the PIN expires or the view changes.
  // gen: the link code's generation (a new code drops the old one's answers).
  Flow.prototype.poll = function (p, seq, gen) {
    var self = this;
    var current = function () { return seq === self.seq && self.alive && (gen == null || gen === self.codeGen); };
    this.timer('poll', function () {
      if (!current()) return;
      PL.plex.checkPin(p.id).then(function (token) {
        if (!current()) return;
        if (token) self.signedIn(token);
        else self.poll(p, seq, gen);
      }, function (err) {
        if (!current()) return;
        if (err && err.status === 404) {
          // the PIN expired
          if (self.s.view === 'code') { self.newCode(); return; }
          if (PL.webSignin) PL.webSignin.forget();
          self.returning = null;
          self.notice = 'That sign-in timed out. Choose Sign in with Plex to try again.';
          self.dispatch({ type: 'SHOW', view: 'welcome' });
          return;
        }
        if (self.statusEl) self.setStatus(err && err.status === 429 ? 'plex.tv is busy. Trying again in a moment…' : 'Can’t reach plex.tv. Trying again…', true);
        self.timer('poll', function () { if (current()) self.poll(p, seq, gen); }, L.retryIn(err) - POLL_MS);
      });
    }, POLL_MS);
  };

  Flow.prototype.setStatus = function (msg, busy) {
    if (!this.statusEl) return;
    var t = this.statusEl.querySelector('.fr-status-text');
    if (t) t.textContent = msg;
    var sp = this.statusEl.querySelector('.fr-spin');
    if (sp) sp.style.visibility = busy === false ? 'hidden' : '';
  };

  // A fresh four-character code for plex.tv/link (and the QR code), renewed before it expires.
  Flow.prototype.newCode = function () {
    var self = this;
    var seq = this.seq;
    var gen = this.codeGen = (this.codeGen || 0) + 1;
    clearTimeout(this.timers.poll);
    clearTimeout(this.timers.pin);
    if (this.tilesEl) this.tilesEl.classList.add('fr-tiles-wait');
    PL.plex.createPin(false).then(function (p) {
      if (seq !== self.seq || gen !== self.codeGen || !self.alive || self.s.view !== 'code') return;
      self.code = p;
      var tiles = codeTiles(p.code);
      tiles.classList.add('fr-tiles-new');
      if (self.tilesEl && self.tilesEl.parentNode) self.tilesEl.parentNode.replaceChild(tiles, self.tilesEl);
      self.tilesEl = tiles;
      if (self.qrWrap) {
        PL.clear(self.qrWrap);
        self.qrWrap.appendChild(qr(L.linkUrl(p.code)));
      }
      self.setStatus(self.platform === 'tv' ? 'Waiting for you to sign in… A new code appears if this one runs out.'
        : 'Waiting for the code… A new one appears if this one runs out.', true);
      self.timer('pin', function () { if (self.s.view === 'code') self.newCode(); }, L.renewIn(p, 14 * 60 * 1000));
      self.poll(p, seq, gen);
    }, function (err) {
      if (seq !== self.seq || gen !== self.codeGen || !self.alive) return;
      self.setStatus(err && err.status === 429 ? 'plex.tv is busy. Trying again in a moment…' : 'Can’t reach plex.tv. Trying again…', false);
      self.timer('pin', function () { self.newCode(); }, L.retryIn(err));
    });
  };

  Flow.prototype.signedIn = function (token) {
    var self = this;
    clearTimeout(this.timers.poll);
    clearTimeout(this.timers.pin);
    if (PL.webSignin) PL.webSignin.done();
    this.returning = null;
    PL.plex.setToken(token);
    PL.storage.del('profile');
    var users = PL.plex.homeUsers().then(null, function () { return []; });
    var me = PL.plex.user().then(null, function () { return null; });
    Promise.all([users, me]).then(function (res) {
      if (!self.alive) return;
      self.users = res[0] || [];
      self.account = (res[1] && (res[1].title || res[1].username)) || '';
      self.currentUuid = (res[1] && res[1].uuid) || null;
      self.dispatch({ type: 'SIGNED_IN', users: self.users });
    });
  };

  // ---- Who's watching and PIN

  // A profile without a PIN switches straight away (the connecting sheet shows while it does); the
  // owner keeps the account's own sign-in.
  Flow.prototype.pick = function (u) {
    this.chosen = u.protected ? null : { user: u, token: null };
    this.dispatch({ type: 'PICK', user: u });
  };

  Flow.prototype.pinKey = function (k) {
    var self = this;
    if (!this.dispatch({ type: 'PIN_KEY', key: k }) || !this.s.pinBusy) return;
    var u = this.s.user;
    var pin = this.s.pin;
    var seq = this.seq;
    PL.plex.switchToken(u, pin).then(function (token) {
      if (seq !== self.seq || !self.alive) return;
      self.chosen = { user: u, token: token };
      self.dispatch({ type: 'PIN_OK' });
    }, function (err) {
      if (seq !== self.seq || !self.alive) return;
      self.dispatch({ type: L.isWrongPin(err) ? 'PIN_WRONG' : 'PIN_FAILED' });
    });
  };

  // ---- Connecting

  // The switch (when a profile was picked), then the server, then the app's own start. The token
  // and server in use before are put back if the attempt fails or is dropped: a profile's sign-in
  // is only kept once its server has connected (all or nothing).
  Flow.prototype.connect = function () {
    var self = this;
    var plex = PL.plex;
    var seq = ++this.cseq;
    var chosen = this.chosen;
    var attempt = this.attempt = { prev: { token: plex.token, server: plex.server }, chosen: chosen, seq: seq };
    var current = function () { return seq === self.cseq && self.alive; };
    var onRoute = function (route, st, resource) {
      if (!current()) return;
      self.dispatch({ type: 'ROUTE', kind: route, status: st, server: resource && resource.name });
    };
    var switched = Promise.resolve(null);
    if (chosen && L.needsSwitch(chosen.user, this.currentUuid)) {
      switched = (chosen.token ? Promise.resolve(chosen.token) : plex.switchToken(chosen.user)).then(null, function (err) {
        if (err) err.plexTv = true; // plex.tv refused or couldn't be reached: not the server
        throw err;
      });
    }
    var force = !!(chosen || this.s.firstRun || this.retried || this.prefer);
    var server = plex.server;
    if (server && !force) this.dispatch({ type: 'CONNECTING', server: server.name });
    switched.then(function (token) {
      if (!current()) throw { cancelled: true };
      if (token) plex.token = token;
      return plex.ensureServer(force, {
        onRoute: onRoute, prefer: self.prefer,
        isCurrent: function () { return current() && (self.s.view === 'connecting' || self.s.view === 'lna'); },
      });
    }).then(function (srv) {
      if (!current()) throw { cancelled: true };
      self.dispatch({ type: 'ROUTE', kind: plex.routeOf(srv.kind), status: 'ok', server: srv.name });
      return self.opts.onConnected ? self.opts.onConnected(srv) : null;
    }).then(function () {
      // (the app's start replaces this screen as it shows the first tab, so alive may be false here)
      if (seq !== self.cseq) { self.restore(attempt); return; }
      if (chosen) {
        plex.setToken(plex.token);
        plex.keepProfile(chosen.user);
        self.currentUuid = chosen.user.uuid;
      }
      self.attempt = null;
      self.finished();
    }, function (err) {
      self.restore(attempt);
      if (err && err.cancelled) return;
      if (!current()) return;
      PL.warn('first run: connect failed', err && (err.code || err.message));
      // plex.tv no longer accepts the sign-in: sign in again
      if (err && err.status === 401 && err.plexTv && !chosen) {
        plex.signOut();
        self.dispatch({ type: 'SIGN_OUT' });
        return;
      }
      if (err && err.code === 'NO_SERVER') err.servers = 0;
      var e = L.classify(err);
      e.detail = PL.errorMessage(err);
      self.dispatch({ type: 'FAILED', error: e });
    });
  };

  // Puts back the token and server from before an attempt that didn't finish.
  Flow.prototype.restore = function (attempt) {
    var plex = PL.plex;
    if (!attempt || attempt.restored || !attempt.chosen) return;
    attempt.restored = true;
    plex.token = attempt.prev.token;
    if (attempt.prev.server) {
      plex.useServer(attempt.prev.server);
    } else {
      plex.server = null;
      PL.storage.del('server');
    }
  };

  Flow.prototype.finished = function () {
    this.chosen = null;
    if (this.opts.from === 'settings') {
      this.close();
      PL.app.start();
      return;
    }
    // the app has set its first tab as the root, which took this screen away already
    if (this.alive) this.destroy();
  };

  Flow.prototype.cancelConnect = function () {
    var to = L.cancelTarget(this.s);
    this.cseq++;
    this.restore(this.attempt);
    if (this.opts.from === 'settings' && !to) { this.close(); return; }
    if (!to) return;
    if (to !== 'profiles') { PL.plex.signOut(); this.users = []; }
    this.dispatch({ type: 'CANCEL' });
  };

  Flow.prototype.retry = function () {
    this.retried = true;
    this.dispatch({ type: 'RETRY' });
  };

  Flow.prototype.chooseServer = function () {
    var self = this;
    PL.plex.listServers().then(function (list) {
      if (!self.alive) return;
      self.servers = list;
      self.dispatch({ type: 'CHOOSE_SERVER' });
    }, function (err) { PL.toast(PL.errorMessage(err)); });
  };

  Flow.prototype.useServer = function (id) {
    this.prefer = id;
    this.dispatch({ type: 'RETRY' });
  };

  Flow.prototype.signOut = function () {
    this.seq++;
    this.cseq++;
    PL.plex.signOut(true);
    if (PL.isWeb) { location.reload(); return; }
    this.users = [];
    this.chosen = null;
    if (this.opts.from === 'settings') { this.close(); PL.app.start(); return; }
    this.dispatch({ type: 'SIGN_OUT' });
  };

  // ---- Local network (web)

  Flow.prototype.askLna = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (self.lna) self.lna.resolve('skip');
      self.lna = { resolve: resolve };
      self.dispatch({ type: 'LNA_ASK' });
    });
  };

  Flow.prototype.lnaChoice = function (choice) {
    if (choice === 'skip') PL.storage.set('lnaSkipped', true);
    var l = this.lna;
    this.lna = null;
    // the request waits for this: Continue lets it go (and Chrome asks); Skip leaves home alone
    this.s = L.next(this.s, { type: 'CONNECTING' });
    this.render('lna');
    if (l) l.resolve(choice === 'allow' ? 'asked' : 'skip');
  };

  // ---- Entry points ------------------------------------------------------------------------------

  var cur = null;

  fr.current = function () { return cur; };

  // The app's start (js/app.js): signs in if needed, then connects. onConnected() -> Promise loads
  // the app (sections, tabs); its errors (no libraries, turned away) show here too. An ordinary
  // launch keeps the stage's loading screen and only brings the layer up when it has something to
  // ask or say.
  fr.run = function (onConnected) {
    if (cur) cur.destroy();
    var pending = PL.webSignin && PL.webSignin.pending();
    if (!PL.plex.token) {
      cur = new Flow({ firstRun: true, onConnected: onConnected });
      if (pending) {
        cur.returning = pending;
        cur.s = L.next(cur.s, { type: 'SHOW', view: 'waiting' });
      }
      cur.render(null);
      return cur;
    }
    // signed in: connect behind the stage's loading screen
    var flow = cur = new Flow({ firstRun: false, onConnected: onConnected, view: 'connecting' });
    flow.external = true;
    flow.s.server = PL.plex.server ? PL.plex.server.name : '';
    PL.app.setRoot(PL.screens.loading('Connecting to your Plex server…'));
    var seq = ++flow.cseq;
    PL.plex.ensureServer(false, {
      isCurrent: function () { return flow.alive && seq === flow.cseq; },
      onRoute: function (route, st, resource) {
        if (flow.mounted) flow.dispatch({ type: 'ROUTE', kind: route, status: st, server: resource && resource.name });
        else flow.s = L.next(flow.s, { type: 'ROUTE', kind: route, status: st, server: resource && resource.name });
      },
    }).then(function (srv) {
      if (!flow.alive || seq !== flow.cseq) return null;
      if (flow.mounted) flow.dispatch({ type: 'ROUTE', kind: PL.plex.routeOf(srv.kind), status: 'ok', server: srv.name });
      return onConnected(srv);
    }).then(function () {
      if (flow.alive && seq === flow.cseq) flow.finished();
    }, function (err) {
      if (!flow.alive || seq !== flow.cseq) return;
      PL.warn('start failed', err && (err.code || err.message));
      if (err && err.status === 401 && (err.plexTv || !err.server)) {
        PL.plex.signOut();
        fr.run(onConnected);
        return;
      }
      var e = L.classify(err);
      e.detail = PL.errorMessage(err);
      flow.s = L.next(flow.s, { type: 'FAILED', error: e });
      flow.render(null);
    });
    return flow;
  };

  // Settings › Profile: Who's watching again (with PINs). Back returns to Settings unchanged.
  var picking = false;
  fr.pickProfile = function () {
    if (picking || (cur && cur.alive && cur.opts.from === 'settings')) return Promise.resolve();
    picking = true;
    var me = PL.plex.user().then(null, function () { return null; });
    return Promise.all([PL.plex.homeUsers(), me]).then(function (res) {
      picking = false;
      var users = res[0];
      if (users.length < 2) { PL.toast('This Plex account has no other profiles'); return; }
      if (cur && cur.alive) cur.close();
      cur = new Flow({ from: 'settings', view: 'profiles', users: users, onConnected: null });
      cur.s.hasProfiles = true;
      // whose sign-in is in use now: that profile needs no switch
      cur.currentUuid = (res[1] && res[1].uuid) || null;
      cur.render(null);
    }, function (err) {
      picking = false;
      PL.toast(PL.errorMessage(err));
    });
  };

  // plex.lanGate (js/plex.js) in the web build: the explainer before the first local request.
  // Shown in the open flow, or over the stage's loading screen on an ordinary launch.
  fr.askLna = function (opts) {
    if (opts && opts.quiet) return Promise.resolve('skip');
    // the attempt that asked was dropped (Back, Cancel): nothing to explain
    if (opts && opts.isCurrent && !opts.isCurrent()) return Promise.resolve('skip');
    var flow = cur;
    if (!flow || !flow.alive) return Promise.resolve('skip');
    if (!flow.mounted) flow.render(null);
    return flow.askLna();
  };
})();
