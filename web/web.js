// The web build's platform glue (docs/WEB.md): who we are to Plex, the stage fitted to the
// window, keyboard and mouse equivalents of the remote's buttons, the browser's Back button,
// Chrome's local-network permission, and ending server sessions when the page goes away.
// Loaded only by the web build (tools/build-web.mjs), after js/app.js. ES2015 like the rest.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var K = PL.KEY;
  var web = PL.web = {};

  // ---- Who we are to Plex (dashboard, Authorized Devices) -------------------------------------

  web.browser = (function () {
    var ua = navigator.userAgent;
    var m;
    var name = 'Browser';
    var version = '';
    if ((m = /Edg\/(\d+)/.exec(ua))) { name = 'Edge'; version = m[1]; }
    else if ((m = /Firefox\/(\d+)/.exec(ua))) { name = 'Firefox'; version = m[1]; }
    else if ((m = /(?:Chrome|CriOS)\/(\d+)/.exec(ua))) { name = 'Chrome'; version = m[1]; }
    else if ((m = /Version\/(\d+)[\d.]* .*Safari/.exec(ua))) { name = 'Safari'; version = m[1]; }
    var os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
      : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Web';
    return { name: name, version: version, os: os };
  })();

  PL.plex.device = {
    platform: web.browser.name,
    platformVersion: web.browser.version,
    device: web.browser.os,
    deviceName: 'Plex Lite (' + web.browser.name + ' on ' + web.browser.os + ')',
  };

  // On-screen key names follow the input mode: web/web-input.js sets PL.keyLabels.

  // ---- The stage: 1920 px wide, as tall as the window (docs/WEB.md, "The window") ---------------

  // The layout is 1920 stage px wide, scaled to the window's width, and its height follows the
  // window (--stage-h, PL.ui.SCREEN_H): no bars. Wider than 1920x900 (ultra-wide, or a short
  // window) the stage stays 900 tall with bars at the sides; narrower than 4:3 it falls back to the
  // 1920x1080 stage letterboxed (phones and narrow windows get web/touch/ instead).
  var MIN_H = 900;
  var MAX_H = 1440;
  web.stage = { w: 1920, h: 1080, scale: 1 };

  // The layout viewport, not innerWidth: a phone's browser zooms out to show the 1920 px body
  // before it is scaled, which makes innerWidth that wide too.
  function fit() {
    // the first-run screens draw outside the stage, at the window's own size (js/screens/firstrun.js)
    if (document.documentElement.classList.contains('fr-on')) {
      document.body.style.transform = '';
      return;
    }
    var w = document.documentElement.clientWidth || window.innerWidth;
    var h = document.documentElement.clientHeight || window.innerHeight;
    var s = w / 1920;
    var H = h / s;
    if (H < MIN_H) {
      H = MIN_H;
      s = h / MIN_H;
    } else if (H > MAX_H) {
      H = 1080;
      s = Math.min(w / 1920, h / 1080);
    }
    H = Math.round(H);
    var x = Math.round((w - 1920 * s) / 2);
    var y = Math.max(0, Math.round((h - H * s) / 2));
    var changed = H !== web.stage.h;
    web.stage = { w: 1920, h: H, scale: s };
    PL.stageScale = s;
    if (PL.ui) PL.ui.SCREEN_H = H;
    document.documentElement.style.setProperty('--stage-h', H + 'px');
    document.body.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
    if (changed) {
      var ev;
      try { ev = new CustomEvent('pl-stageresize', { detail: { h: H } }); } catch (e) { ev = null; }
      if (ev) document.dispatchEvent(ev);
    }
  }
  web.fit = fit;
  window.addEventListener('resize', PL.rafThrottle(fit));
  fit(); // this script runs at the end of <body>: scale before the first layout
  document.addEventListener('DOMContentLoaded', fit);

  web.toggleFullscreen = function () {
    var d = document;
    var el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else if (el.requestFullscreen || el.webkitRequestFullscreen) {
      var p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      if (p && p.catch) p.catch(function () { PL.toast('This browser wouldn\'t go full screen'); });
    }
  };

  // ---- Keyboard ------------------------------------------------------------------------------

  // Keyboard keys for the remote's buttons. Letters are left alone where the screen types them
  // (Search) and in text fields; browser shortcuts (Ctrl, Cmd, Alt) are never taken.
  var MAP = {};
  MAP[82] = K.RED; // R
  MAP[71] = K.GREEN; // G
  MAP[89] = K.YELLOW; // Y
  MAP[66] = K.BLUE; // B
  MAP[73] = K.INFO; // I
  MAP[32] = K.PLAY_PAUSE; // Space
  MAP[178] = K.STOP; // MediaStop
  MAP[188] = K.REW; // ,
  MAP[190] = K.FF; // .

  function typingIn(e) {
    var t = e.target;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function screenTypes() {
    var top = PL.app.top();
    return !!(top && top.typesLetters && !PL.app.tabsFocused);
  }

  PL.app.mapKey = function (e) {
    var code = e.keyCode;
    if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e)) return code;
    if (screenTypes() && ((code >= 65 && code <= 90) || code === 32 || code === 188 || code === 190)) return code;
    return MAP[code] || code;
  };

  // Hold OK: Shift+Enter or the context-menu key. F: full screen. These run before the app's own
  // key handling (window capture comes before document capture). A key whose key-down was taken
  // here has its key-up taken too, and only then.
  var taken = {};
  // keys that toggle something: a held key's auto-repeat would flip it on and off
  var NO_REPEAT = { 32: 1, 82: 1, 71: 1, 89: 1, 66: 1, 73: 1 };
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e)) return;
    var code = e.keyCode;
    var take = function () {
      e.preventDefault();
      e.stopImmediatePropagation();
      taken[code] = true;
    };
    if ((code === K.ENTER && e.shiftKey) || code === 93) {
      take();
      if (!e.repeat) PL.app.longPress();
      return;
    }
    if (code === 70 && !screenTypes()) {
      take();
      if (!e.repeat) web.toggleFullscreen();
      return;
    }
    if (e.repeat && NO_REPEAT[code] && !screenTypes()) take();
  }, true);
  window.addEventListener('keyup', function (e) {
    if (!taken[e.keyCode]) return;
    delete taken[e.keyCode];
    e.stopImmediatePropagation();
  }, true);

  // ---- Mouse and touch: right-click or a long press is hold OK ----------------------------------

  // Cards handle their own right-click (js/ui.js, they know which title was clicked); anywhere
  // else it acts on what has the focus, which in pointer mode follows the mouse.
  document.addEventListener('contextmenu', function (e) {
    if (typingIn(e)) return;
    e.preventDefault();
    if (!e.plHandled && PL.app.longPress()) e.plHandled = true;
    lastHold.handled = !!e.plHandled;
    lastHold.at = Date.now();
  });

  // A press held for 550 ms (the TV's hold-OK time) sends a contextmenu to what is under it; the
  // click that follows the release is swallowed if the hold did something.
  var HOLD_MS = 550;
  var lastHold = { at: 0, handled: false };
  var press = null;
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || typingIn(e)) return;
    var target = e.target;
    var x = e.clientX;
    var y = e.clientY;
    clearTimeout(press && press.timer);
    press = {
      x: x, y: y, fired: false,
      timer: setTimeout(function () {
        // a native contextmenu (Android's long-press) already did it
        if (Date.now() - lastHold.at < 800) { press.fired = lastHold.handled; return; }
        var ev;
        try {
          ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
        } catch (err) { return; }
        target.dispatchEvent(ev);
        press.fired = lastHold.handled;
      }, HOLD_MS),
    };
  }, true);
  var cancelPress = function () { if (press) clearTimeout(press.timer); };
  document.addEventListener('pointermove', function (e) {
    if (press && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 12) cancelPress();
  }, true);
  document.addEventListener('pointerup', cancelPress, true);
  document.addEventListener('pointercancel', cancelPress, true);
  document.addEventListener('click', function (e) {
    if (press && press.fired) {
      press = null;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ---- The browser's Back button (and a mouse's back button) is the remote's Back --------------

  // One history entry is kept above the page. Back pops it: the app goes back a step and the entry
  // is put back. At the top level with the tab bar focused it is not put back, so the next Back
  // leaves the site as usual.
  var armed = false;
  function arm() {
    if (armed) return;
    armed = true;
    try { history.pushState({ pl: 1 }, ''); } catch (e) { armed = false; }
  }
  window.addEventListener('popstate', function () {
    armed = false;
    var app = PL.app;
    var top = app.top();
    // the first-run screens step back through their own flow, then leave the site
    if (top && top.ownsBack) {
      if (!top.canBack()) { history.back(); return; }
      app.press(K.BACK);
      arm();
      return;
    }
    // the top level: this Back leaves the site (the entry it popped was only ours)
    if (app.stack.length <= 1 && (app.tabsFocused || !(app.top() && app.top().root))) {
      history.back();
      return;
    }
    app.press(K.BACK);
    arm();
  });
  var push = PL.app.push;
  PL.app.push = function () {
    arm();
    return push.apply(this, arguments);
  };
  document.addEventListener('keydown', function () { arm(); }, true);
  document.addEventListener('pointerdown', function () { arm(); }, true);

  // ---- Local network access (Chrome 142+) --------------------------------------------------------

  // A public site that reaches a device on the local network (the Plex server at home, through its
  // *.plex.direct address) needs the user's permission: Chrome asks once, on the first such request.
  // Until it's allowed, Plex Lite uses Remote Access or the relay; when it's allowed later, it moves
  // to the local address. state: 'granted' | 'denied' | 'prompt' | null (no such permission here).
  web.lna = { state: null, status: null };
  // settles once the browser has said what the permission is (or that it has none)
  var lnaKnown;
  web.lnaReady = new Promise(function (resolve) { lnaKnown = resolve; });
  setTimeout(function () { lnaKnown(); }, 1500);
  function watchLna() {
    if (!navigator.permissions || !navigator.permissions.query) { lnaKnown(); return; }
    var names = PL.firstrunLogic.LNA_NAMES;
    var tryName = function (i) {
      if (i >= names.length) { lnaKnown(); return; }
      var q;
      try { q = navigator.permissions.query({ name: names[i] }); } catch (e) { tryName(i + 1); return; }
      q.then(function (status) {
        web.lna.status = status;
        web.lna.state = status.state;
        lnaKnown();
        status.onchange = function () {
          web.lna.state = status.state;
          PL.log('local network access', status.state);
          if (status.state === 'granted') PL.storage.del('lnaSkipped');
          onLnaChange(status.state);
        };
      }, function () { tryName(i + 1); });
    };
    tryName(0);
  }

  // Before the first request to the server's local address (js/plex.js lanGate): the explainer
  // (board A5) when Chrome would ask, so Chrome's own prompt comes with a reason. Skipped when the
  // permission is already granted or denied, or the explainer was skipped before (Settings, Local
  // network access, asks again). o.quiet: a background check, which never asks.
  web.lnaAsk = false;
  PL.plex.lanGate = function (resource, o) {
    return web.lnaReady.then(function () {
      if (web.lnaAsk && web.lna.state === 'prompt') return 'allow';
      var d = PL.firstrunLogic.lnaDecision({
        platform: 'web', state: web.lna.state, hasLocal: true, skipped: !!PL.storage.get('lnaSkipped', false),
      });
      if (d !== 'ask') return d;
      return PL.firstrun.askLna(o);
    });
  };

  function onLnaChange(state) {
    var s = PL.plex.server;
    if (!PL.app.ready || !s) {
      // allowed while Plex Lite was still connecting: look again once it has started
      setTimeout(function () { if (web.lna.state === state) onLnaChange(state); }, 2000);
      return;
    }
    if (state === 'granted' && (s.kind === 'remote' || s.kind === 'relay')) {
      PL.plex.ensureServer(true).then(function (server) {
        if (server.kind === 'lan') PL.toast('Now streaming over your local network');
      }, function () {});
    } else if (state === 'denied' && s.kind === 'lan') {
      PL.plex.ensureServer(true).then(function () {
        PL.toast('Local network access is off: using Plex Remote Access');
      }, function () {});
    }
  }
  watchLna();

  web.lnaLabel = function () {
    switch (web.lna.state) {
      case 'granted': return 'Allowed';
      case 'denied': return 'Blocked';
      case 'prompt': return PL.storage.get('lnaSkipped', false) ? 'Skipped' : 'Not asked yet';
      default: return 'Not needed here';
    }
  };

  // ---- Settings rows (js/screens/settings.js shows them on the web) --------------------------------

  web.settingsRows = function (rebuild) {
    var full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    return [
      PL.input.settingsRow(rebuild),
      { label: 'Local network access', value: web.lnaLabel(), action: explainLna },
      { label: 'Full screen', value: full ? 'On' : 'Off', action: function () {
        web.toggleFullscreen();
        setTimeout(rebuild, 400);
      } },
      { label: 'Keyboard shortcuts', value: '?', action: function () { web.shortcuts(); } },
    ];
  };

  // A card of explanations: a title, then each line as a label with its text under it. Enter or
  // Back closes it.
  // An explanation card: [[label, text]] rows, Done, and any extra buttons ([{label, action}]).
  function sheet(heading, lines, extra) {
    var el = PL.el('div', 'web-info-screen');
    var card = PL.el('div', 'center-card web-info');
    card.appendChild(PL.el('h1', '', heading));
    var list = PL.el('div', 'web-info-list');
    lines.forEach(function (l) {
      var row = PL.el('div', 'web-info-row');
      row.appendChild(PL.el('div', 'web-info-label', l[0]));
      if (l[1]) row.appendChild(PL.el('div', 'web-info-text', l[1]));
      list.appendChild(row);
    });
    card.appendChild(list);
    var row = new PL.ui.ButtonRow([{ label: 'Done', kind: 'primary', action: function () { PL.app.pop(); } }].concat(extra || []));
    row.setFocused(true);
    card.appendChild(PL.el('div', { className: 'web-signin-buttons' }, [row.el]));
    el.appendChild(card);
    PL.app.push({
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); },
      key: function (code) { return PL.isBack(code) ? false : row.key(code) || true; },
    });
  }

  function explainLna() {
    var s = PL.plex.server || {};
    var lines = [['Now connected', s.kind === 'lan' ? 'over your local network' : s.kind === 'relay' ? 'through the Plex relay' : 'through Plex Remote Access']];
    if (web.lna.state === 'denied') {
      lines.push(['Blocked for this site', 'To stream directly at home: site settings (the icon left of the address), Local network access, Allow; then reload']);
    } else if (web.lna.state === 'prompt') {
      lines.push(['Not asked yet', 'At home, the browser asks to let this site reach devices on your local network: allow it to stream straight from your server']);
      // skipped on the first run: ask now (Chrome's prompt follows the next request at home)
      if (s.kind !== 'lan') {
        sheet('Local network access', lines.concat([['Away from home', 'Plex Lite uses Plex Remote Access, else the Plex relay (slower, limited quality)']]), [{
          label: 'Look for my server at home',
          action: function () {
            PL.app.pop();
            PL.storage.del('lnaSkipped');
            web.lnaAsk = true;
            PL.plex.ensureServer(true).then(function (server) {
              web.lnaAsk = false;
              PL.toast(server.kind === 'lan' ? 'Now streaming over your local network' : 'Still using ' + (server.kind === 'relay' ? 'the Plex relay' : 'Plex Remote Access'));
            }, function () { web.lnaAsk = false; });
          },
        }]);
        return;
      }
    } else if (web.lna.state === 'granted') {
      lines.push(['Allowed', 'At home, Plex Lite streams straight from your server']);
    } else {
      lines.push(['This browser doesn\'t ask', 'It reaches your server at home directly when it can']);
    }
    lines.push(['Away from home', 'Plex Lite uses Plex Remote Access, else the Plex relay (slower, limited quality)']);
    web.info('Local network access', lines);
  }

  // The explanations go through web.info, so the phone and tablet layer (web/touch/) can show them
  // as its own sheets.
  web.info = sheet;
  web.explainLna = explainLna;

  web.explainPlugin = function (p) {
    web.info(p.name + ' works in the TV app only', [
      ['It runs a background service on the TV', 'A browser can\'t run one'],
      ['Use it on the TV', 'It works there as before'],
    ]);
  };

  // ---- Leaving the page: end playback and transcode sessions ------------------------------------

  // Requests made while the page unloads go out with fetch keepalive (core.js PL.http), which the
  // browser finishes after the page is gone.
  window.addEventListener('pagehide', function () {
    PL.leaving = true;
    PL.app.stack.slice().forEach(function (s) { if (s.onPageHide) s.onPageHide(); });
  });
  // back from the back/forward cache: a player stopped on the way out closes
  window.addEventListener('pageshow', function (e) {
    PL.leaving = false;
    if (!e.persisted) return;
    PL.app.stack.slice().forEach(function (s) { if (s.state === 'stopped' && s.exit) s.exit(); });
  });
})();
