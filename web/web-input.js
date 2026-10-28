// Input mode for the web build (docs/WEB.md, "Input modes"): which way the person is driving
// Plex Lite (a remote or D-pad, a mouse and keyboard, or touch), so the page can show the right
// controls and hints. Loaded only by the web build, after js/app.js and before web/web.js. The TV
// never loads it: there PL.input is core.js's stub, always "remote". ES2015 like the rest.
//
//   PL.input.mode()     'remote' | 'pointer' | 'touch'   the layout and controls to show
//   PL.input.nav()      'keys' | 'pointer' | 'touch'     the last kind of input used
//   PL.input.hints()    'remote' | 'keys' | 'none'       how key hints are written
//   PL.input.setting()  'auto' | 'remote' | 'touch' | 'pointer'   Settings -> Controls
//   PL.input.set(v)     saves the setting (per browser) and applies it
//   PL.input.on(fn) / PL.input.off(fn)   fn({mode, nav, prevMode, prevNav}) after every change
//   <html data-input="remote|pointer|touch" data-nav="keys|pointer|touch">, and a
//   'pl-inputchange' event on document with the same detail.
'use strict';

(function () {
  if (!PL.isWeb) return;

  var root = document.documentElement;
  var SETTINGS = ['auto', 'remote', 'touch', 'pointer'];
  var LABELS = { auto: 'Automatic', remote: 'Remote', touch: 'Touch', pointer: 'Mouse & keyboard' };
  // TV and console browsers: their remotes send arrow keys, whatever they say about the pointer
  var TV_UA = /Web0S|webOS|Tizen|SMART-TV|SmartTV|HbbTV|NetCast|BRAVIA|Viera|AFT[A-Z]|CrKey|PlayStation|Xbox|Nintendo/i;
  // a mouse event this soon after a touch is the browser's emulation of the tap, not a mouse
  var TOUCH_GHOST_MS = 1000;
  // a mouse has to travel this far (CSS px) to count: a still cursor gets mousemove events when the
  // page moves under it
  var MOVE_PX = 8;

  // ---- The starting mode ------------------------------------------------------------------------

  // env: {ua, mq(query) -> bool}. When unsure: remote (the focus plate always works).
  function startMode(env) {
    if (TV_UA.test(env.ua || '')) return 'remote';
    if (env.mq('(hover: none) and (pointer: coarse)')) return 'touch';
    if (env.mq('(hover: hover) and (pointer: fine)')) return 'pointer';
    return 'remote';
  }

  function mq(query) {
    try { return !!(window.matchMedia && window.matchMedia(query).matches); } catch (e) { return false; }
  }

  // ---- State --------------------------------------------------------------------------------------

  var saved = PL.storage.get('input', 'auto');
  var state = {
    setting: SETTINGS.indexOf(saved) >= 0 ? saved : 'auto',
    detected: startMode({ ua: navigator.userAgent, mq: mq }),
    // a TV or console browser: its pointer (a Magic Remote, a gamepad's cursor) is the remote's
    tv: TV_UA.test(navigator.userAgent || ''),
    mode: null,
    nav: null,
    last: null, // the last touch or mouse input: 'touch' | 'pointer'
  };
  var listeners = [];

  function navFor(mode) { return mode === 'remote' ? 'keys' : mode; }

  function hints() {
    if (state.mode === 'remote') return 'remote';
    return state.nav === 'touch' ? 'none' : 'keys';
  }

  // ---- Key names in hints -------------------------------------------------------------------------

  var KEYBOARD = {
    OK: 'Enter', Back: 'Esc', Red: 'R', Green: 'G', Yellow: 'Y', Blue: 'B', Info: 'I', 'Play/Pause': 'Space',
    'CH ±': 'PgUp/PgDn', 'Hold OK': 'Shift+Enter', 'Hold OK on': 'Shift+Enter on', 'hold OK on': 'Shift+Enter on',
  };
  var MOUSE = { 'Hold OK': 'Right-click', 'Hold OK on': 'Right-click', 'hold OK on': 'right-click' };
  var TOUCH = { OK: 'Tap', 'Hold OK': 'Long-press', 'Hold OK on': 'Long-press', 'hold OK on': 'long-press' };

  function labels() {
    var h = hints();
    if (h === 'remote') return null;
    if (h === 'none') return TOUCH;
    var out = {};
    Object.keys(KEYBOARD).forEach(function (k) { out[k] = KEYBOARD[k]; });
    if (state.nav === 'pointer') Object.keys(MOUSE).forEach(function (k) { out[k] = MOUSE[k]; });
    return out;
  }

  // Keycaps made with PL.keycap carry the button's name (data-key) and are relabelled in place.
  function relabel() {
    PL.keyLabels = labels();
    var caps = document.querySelectorAll('.keycap[data-key]');
    for (var i = 0; i < caps.length; i++) {
      var text = PL.keyLabel(caps[i].getAttribute('data-key'));
      if (caps[i].textContent !== text) caps[i].textContent = text;
    }
  }

  // ---- Applying a change --------------------------------------------------------------------------

  function apply(mode, nav) {
    var prevMode = state.mode;
    var prevNav = state.nav;
    if (mode === prevMode && nav === prevNav) return;
    state.mode = mode;
    state.nav = nav;
    root.setAttribute('data-input', mode);
    root.setAttribute('data-nav', nav);
    // body.pointer (js/app.js): hover shows focus and the D-pad focus plate is hidden
    if (PL.app && PL.app.pointer) PL.app.pointer.set(nav !== 'keys');
    relabel();
    var detail = { mode: mode, nav: nav, prevMode: prevMode, prevNav: prevNav };
    listeners.slice().forEach(function (fn) {
      try { fn(detail); } catch (e) { PL.warn('input listener failed', e && e.message); }
    });
    var ev;
    try { ev = new CustomEvent('pl-inputchange', { detail: detail }); } catch (e) { ev = null; }
    if (ev) document.dispatchEvent(ev);
  }

  function pinned() { return state.setting !== 'auto'; }

  // The last input used: a touch switches to touch, a real mouse to pointer (unless the setting pins
  // the mode); keys only bring up the focus plate and key hints, never a different layout.
  function used(kind) {
    var mode = state.mode;
    if (kind !== 'keys') state.last = kind;
    if (!pinned() && kind !== 'keys' && !(state.tv && kind === 'pointer')) mode = kind;
    apply(mode, kind);
  }

  // the mouse is already in charge: nothing to switch
  function mouseInCharge() {
    return state.nav === 'pointer' && (pinned() || state.tv || state.mode === 'pointer');
  }

  // ---- Listening ----------------------------------------------------------------------------------

  var lastTouchAt = -Infinity;
  var anchor = null; // where the mouse was first seen since the last switch away from it

  function touched() {
    lastTouchAt = Date.now();
    anchor = null;
    if (state.nav === 'touch' && (pinned() || state.mode === 'touch')) return;
    used('touch');
  }

  // A click, a wheel or a move far enough: a mouse or trackpad (not the browser's copy of a tap).
  function mouseUsed() {
    if (Date.now() - lastTouchAt < TOUCH_GHOST_MS) return;
    anchor = null;
    if (mouseInCharge()) return;
    used('pointer');
  }

  function moved(x, y) {
    if (mouseInCharge()) return;
    if (Date.now() - lastTouchAt < TOUCH_GHOST_MS) return;
    if (!anchor) {
      anchor = { x: x, y: y };
      return;
    }
    if (Math.abs(x - anchor.x) + Math.abs(y - anchor.y) >= MOVE_PX) mouseUsed();
  }

  // arrows, Enter, Tab, Page Up/Down: the keys that move or press the focus
  var NAV_KEYS = { 9: 1, 13: 1, 33: 1, 34: 1, 37: 1, 38: 1, 39: 1, 40: 1 };

  function typingIn(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function keyed(e) {
    if (!NAV_KEYS[e.keyCode] || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
    anchor = null;
    if (state.nav !== 'keys') used('keys');
  }

  function listen() {
    var opts = { capture: true, passive: true };
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') touched();
      else if (e.pointerType === 'mouse') mouseUsed();
    }, opts);
    // browsers without pointer events
    document.addEventListener('touchstart', touched, opts);
    // a pen hovering sends mouse events too: with pointer events only a mouse's moves count
    if (window.PointerEvent) {
      document.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') moved(e.clientX, e.clientY); }, opts);
    } else {
      document.addEventListener('mousemove', function (e) { moved(e.clientX, e.clientY); }, opts);
    }
    // a wheel or a trackpad swipe: only mice and trackpads send them
    document.addEventListener('wheel', mouseUsed, opts);
    document.addEventListener('keydown', keyed, true);
  }

  // ---- The API ------------------------------------------------------------------------------------

  PL.input = {
    mode: function () { return state.mode; },
    nav: function () { return state.nav; },
    hints: hints,
    setting: function () { return state.setting; },
    detected: function () { return state.detected; },
    set: function (value) {
      if (SETTINGS.indexOf(value) < 0) return;
      state.setting = value;
      PL.storage.set('input', value);
      // back to Automatic: what was used last (a touch or a mouse), else what the browser said
      var mode = value !== 'auto' ? value
        : state.last && !(state.tv && state.last === 'pointer') ? state.last : state.detected;
      apply(mode, navFor(mode));
    },
    on: function (fn) { if (listeners.indexOf(fn) < 0) listeners.push(fn); },
    off: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    label: function (value) { return LABELS[value]; },
    // for tests
    startMode: startMode,
  };

  // Settings -> Controls (web/web.js puts the row in Settings): Auto / Remote / Touch / Mouse & keyboard.
  PL.input.settingsRow = function (rebuild) {
    var value = state.setting === 'auto' ? 'Automatic (' + LABELS[state.mode] + ')' : LABELS[state.setting];
    return {
      label: 'Controls', value: value, action: function () {
        var row = function (v, text) {
          return { label: text, checked: state.setting === v, action: function () { PL.input.set(v); if (rebuild) rebuild(); } };
        };
        PL.app.push(PL.screens.sheet([{
          heading: 'Controls',
          rows: [
            row('auto', 'Automatic'),
            row('remote', 'Remote'),
            row('pointer', 'Mouse & keyboard'),
            row('touch', 'Touch'),
          ],
        }]));
      },
    };
  };

  var first = state.setting === 'auto' ? state.detected : state.setting;
  apply(first, navFor(first));
  listen();
  // js/app.js sets up body.pointer at DOMContentLoaded: put ours back on it
  document.addEventListener('DOMContentLoaded', function () {
    if (PL.app && PL.app.pointer) PL.app.pointer.set(state.nav !== 'keys');
  });
})();
