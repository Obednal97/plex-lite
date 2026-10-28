// Shared helpers. Written for Chrome 53 (webOS 4.5): ES2015, no async/await, no object spread,
// no Object.entries/values, no Promise.prototype.finally, no AbortController.
'use strict';

var PL = window.PL = window.PL || {};

PL.VERSION = '0.1.0';

// The platform: the TV app (webOS), or the web build (tools/build-web.mjs sets PL_PLATFORM to 'web'
// before this file loads; see docs/WEB.md). webOS-only paths check PL.isWeb and stay off on the web.
PL.isWeb = window.PL_PLATFORM === 'web';
// The web build scales the 1920x1080 stage to the window; measurements taken with
// getBoundingClientRect are divided by this to get stage pixels.
PL.stageScale = 1;

PL.KEY = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
  BACK: 461, ESC: 27, BACKSPACE: 8,
  PLAY: 415, PAUSE: 19, PLAY_PAUSE: 179, STOP: 413, FF: 417, REW: 412,
  NEXT_TRACK: 176, PREV_TRACK: 177, // keyboard and Bluetooth media keys (MediaTrackNext/Previous)
  RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
  CH_UP: 33, CH_DOWN: 34, INFO: 457,
  OK_LONG: -13, // synthesised by the app when OK is held (quick-actions menu)
};

PL.isBack = function (code) {
  return code === PL.KEY.BACK || code === PL.KEY.ESC || code === PL.KEY.BACKSPACE;
};

// The name of a remote button in on-screen hints ('OK', 'Back', 'Yellow', 'Hold OK'...). The web
// build swaps in keyboard or touch names as the input mode changes (PL.keyLabels, web/web-input.js).
PL.keyLabels = null;
PL.keyLabel = function (name) {
  return (PL.keyLabels && PL.keyLabels[name]) || name;
};

// A key hint's keycap. It keeps the button's name (data-key) so the web build can relabel it when
// the input mode changes (web/web-input.js); on the TV it simply shows the remote's name.
PL.keycap = function (name, cls) {
  var n = document.createElement('span');
  n.className = 'keycap' + (cls ? ' ' + cls : '');
  n.textContent = PL.keyLabel(name);
  n.setAttribute('data-key', name);
  return n;
};

// The input mode (docs/WEB.md, "Input modes"). The TV is always driven by its remote; the web build
// replaces this with web/web-input.js, which follows the mouse, touch and keyboard.
PL.input = {
  mode: function () { return 'remote'; },
  nav: function () { return document.body && document.body.classList.contains('pointer') ? 'pointer' : 'keys'; },
  hints: function () { return 'remote'; },
  setting: function () { return 'remote'; },
  on: function () {},
  off: function () {},
};

// Recent log lines are also kept in memory (PL.logs) so they can be read over DevTools, which
// Chrome 53 lets only one client attach to at a time.
PL.logs = [];

function keepLog(level, args) {
  var line = new Date().toISOString().slice(11, 23) + ' ' + level + ' ' + args.map(function (a) {
    return typeof a === 'string' ? a : (a && a.message) || JSON.stringify(a);
  }).join(' ');
  PL.logs.push(PL.redact ? PL.redact(line) : line);
  if (PL.logs.length > 300) PL.logs.splice(0, PL.logs.length - 300);
}

PL.log = function () {
  var args = Array.prototype.slice.call(arguments);
  keepLog('log', args);
  args.unshift('[PL]');
  console.log.apply(console, args);
};

PL.warn = function () {
  var args = Array.prototype.slice.call(arguments);
  keepLog('warn', args);
  args.unshift('[PL]');
  console.warn.apply(console, args);
};

window.addEventListener('error', function (e) {
  keepLog('error', [e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno]);
});

// el('div', 'cls', 'text') or el('div', {className, text, attrs, style}, [children])
PL.el = function (tag, opts, children) {
  var node = document.createElement(tag);
  if (typeof opts === 'string') {
    node.className = opts;
    if (typeof children === 'string') node.textContent = children;
    return node;
  }
  if (opts) {
    if (opts.className) node.className = opts.className;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { node.setAttribute(k, opts.attrs[k]); });
    if (opts.style) Object.keys(opts.style).forEach(function (k) { node.style[k] = opts.style[k]; });
  }
  if (children) children.forEach(function (c) { if (c) node.appendChild(c); });
  return node;
};

PL.clear = function (node) {
  while (node.firstChild) node.removeChild(node.firstChild);
};

PL.translate = function (node, x, y) {
  node.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
};

PL.storage = {
  get: function (key, fallback) {
    try {
      var raw = localStorage.getItem('pl.' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set: function (key, value) {
    try { localStorage.setItem('pl.' + key, JSON.stringify(value)); } catch (e) { PL.warn('storage.set failed', key, e); }
  },
  del: function (key) {
    try { localStorage.removeItem('pl.' + key); } catch (e) { /* ignore */ }
  },
};

PL.uuid = function () {
  var b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = [];
  for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
  return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
    h.slice(8, 10).join('') + '-' + h.slice(10).join('');
};

PL.query = function (params) {
  return Object.keys(params)
    .filter(function (k) { return params[k] != null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
};

// XHR wrapper: resolves with parsed JSON (or text), rejects with Error{status}. The returned promise
// has .abort(); an aborted request rejects with err.aborted = true.
PL.http = function (method, url, opts) {
  opts = opts || {};
  // the web build, while the page unloads: fetch keepalive outlives the page (an XHR would be
  // cancelled), so "stopped" reports and transcode stops still reach the server
  if (PL.leaving && window.fetch) {
    var sent = fetch(url, { method: method, keepalive: true, credentials: 'omit', headers: { Accept: 'application/json' } })
      .then(function () { return null; });
    sent.abort = function () {};
    return sent;
  }
  var xhr = new XMLHttpRequest();
  var promise = new Promise(function (resolve, reject) {
    xhr.open(method, url, true);
    xhr.timeout = opts.timeout || 15000;
    xhr.setRequestHeader('Accept', 'application/json');
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { xhr.setRequestHeader(k, opts.headers[k]); });
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        var text = xhr.responseText;
        if (!text) return resolve(null);
        try {
          resolve(opts.text ? text : JSON.parse(text));
        } catch (e) {
          resolve(text);
        }
      } else {
        var err = new Error(method + ' ' + PL.redact(url) + ' -> HTTP ' + xhr.status);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = function () {
      var err = new Error(method + ' ' + PL.redact(url) + ' -> network error');
      err.status = 0;
      reject(err);
    };
    xhr.ontimeout = function () {
      var err = new Error(method + ' ' + PL.redact(url) + ' -> timed out');
      err.status = 0;
      err.timeout = true;
      reject(err);
    };
    xhr.onabort = function () {
      var err = new Error('aborted');
      err.aborted = true;
      reject(err);
    };
    xhr.send(opts.body || null);
  });
  promise.abort = function () { xhr.abort(); };
  return promise;
};

PL.redact = function (s) {
  return String(s).replace(/(X-Plex-Token=)[^&]+/g, '$1…');
};

// Runs fn at most once per animation frame, with the latest arguments.
PL.rafThrottle = function (fn) {
  var pending = false;
  var lastArgs = null;
  return function () {
    lastArgs = arguments;
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      fn.apply(null, lastArgs);
    });
  };
};

PL.debounce = function (fn, ms) {
  var t = null;
  var d = function () {
    var args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(null, args); }, ms);
  };
  d.cancel = function () { clearTimeout(t); };
  return d;
};

PL.clamp = function (v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
};

PL.fmt = {
  // 6150000 ms -> "1h 42m"
  duration: function (ms) {
    if (!ms) return '';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  },
  // seconds -> "1:02:03" / "2:03"
  clock: function (sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
  },
  episode: function (item) {
    if (item.parentIndex == null || item.index == null) return '';
    if (item.parentIndex === 0) return 'Special ' + item.index;
    return 'S' + item.parentIndex + ' · E' + item.index;
  },
  remaining: function (item) {
    if (!item.duration || !item.viewOffset) return '';
    return PL.fmt.duration(item.duration - item.viewOffset) + ' left';
  },
};

PL.toast = (function () {
  var node = null;
  var timer = null;
  return function (message, ms) {
    if (!node) {
      node = PL.el('div', 'toast');
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { node.classList.remove('show'); }, ms || 3500);
  };
})();

PL.errorMessage = function (err) {
  if (!err) return 'Something went wrong';
  if (err.status === 401) return 'Plex rejected the sign-in. Please sign in again.';
  if (err.timeout) return 'The Plex server took too long to answer.';
  if (err.status === 0) return 'Could not reach the Plex server.';
  // HTTP errors carry the request URL in their message: don't put that on screen
  if (err.status === 404) return 'This item is no longer on the server.';
  if (err.status >= 400) return 'The Plex server returned an error (HTTP ' + err.status + ').';
  return err.message || String(err);
};

PL.exitApp = function () {
  if (PL.isWeb) return; // a web page can't close itself; Back at the top just stays put
  if (window.PalmSystem && window.PalmSystem.platformBack) window.PalmSystem.platformBack();
  else window.close();
};
