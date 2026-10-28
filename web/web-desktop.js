// Laptop and desktop (docs/WEB.md, "Mouse and keyboard"): the Back [Esc] button, tooltips that name
// their key, the extra keys (/ Search, M mute, N next episode, ? shortcuts) and the "?" shortcuts
// overlay. Web build only, after web/web.js; the TV never loads it. ES2015 like the rest.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var K = PL.KEY;
  var web = PL.web;
  var app = PL.app;

  // 24-unit line glyphs (PL.glyph, js/screens/player.js)
  var G = {
    back: [['path', { d: 'M20 12H5' }], ['path', { d: 'M11 6l-6 6 6 6' }]],
    close: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  };
  web.glyph = function (def, size, weight) { return PL.glyph(def, size, weight || 2); };

  function pointerMode() { return PL.input.mode() === 'pointer'; }

  // Where a node is on the stage (stage px), whatever the window's scale and bars.
  web.stageRect = function (node) {
    var r = node.getBoundingClientRect();
    var a = document.getElementById('app').getBoundingClientRect();
    var s = PL.stageScale || 1;
    return { left: (r.left - a.left) / s, top: (r.top - a.top) / s, width: r.width / s, height: r.height / s };
  };

  // ---- Tooltips ----------------------------------------------------------------------------------

  // web.tip(node, text, key, place): hovering the node for a moment (mouse) shows the text and the
  // key that does the same, "Full screen [F]". place: 'below' (default) or 'above'. A node can
  // change its tip later with the same call. web.tip.show(node) / web.tip.hide() show one on demand
  // (a focused control in keyboard use).
  var tip = { el: null, text: null, key: null, node: null, timer: null };

  function tipEl() {
    if (tip.el) return tip.el;
    tip.el = PL.el('div', 'web-tip');
    tip.text = PL.el('span', 'web-tip-text');
    tip.el.appendChild(tip.text);
    document.getElementById('app').appendChild(tip.el);
    return tip.el;
  }

  web.tip = function (node, text, key, place) {
    node.setAttribute('data-tip', text);
    if (key) node.setAttribute('data-tip-key', key);
    else node.removeAttribute('data-tip-key');
    if (place) node.setAttribute('data-tip-at', place);
    if (tip.node === node && tip.el && tip.el.classList.contains('on')) showTip(node);
    return node;
  };

  function showTip(node) {
    var el = tipEl();
    tip.node = node;
    tip.text.textContent = node.getAttribute('data-tip');
    if (tip.key) el.removeChild(tip.key);
    tip.key = null;
    var key = node.getAttribute('data-tip-key');
    if (key) {
      tip.key = PL.keycap(key, 'web-tip-key');
      el.appendChild(tip.key);
    }
    el.classList.add('on');
    var r = web.stageRect(node);
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var x = PL.clamp(r.left + r.width / 2 - w / 2, 24, 1920 - 24 - w);
    var above = node.getAttribute('data-tip-at') === 'above';
    var y = above ? r.top - h - 14 : r.top + r.height + 14;
    el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  web.tip.show = showTip;
  web.tip.hide = function () {
    clearTimeout(tip.timer);
    tip.node = null;
    if (tip.el) tip.el.classList.remove('on');
  };

  function tipTarget(t) {
    while (t && t.nodeType === 1) {
      if (t.hasAttribute('data-tip')) return t;
      t = t.parentNode;
    }
    return null;
  }

  document.addEventListener('mouseover', function (e) {
    var node = tipTarget(e.target);
    if (node === tip.node) return;
    web.tip.hide();
    if (!node || PL.input.nav() !== 'pointer') return;
    tip.node = node;
    tip.timer = setTimeout(function () { if (tip.node === node && node.offsetParent) showTip(node); }, 450);
  }, true);
  document.addEventListener('mousedown', function () { web.tip.hide(); }, true);
  document.addEventListener('keydown', function () { if (tip.node && PL.input.nav() === 'pointer') web.tip.hide(); }, true);

  // ---- Back [Esc]: top left of every screen above the tab bar, with a mouse ----------------------

  // A screen can hide it while it has nothing on screen (the player while its controls are away:
  // screen.hideBack() -> true) or leave it out altogether (screen.noBack).
  var back = PL.el('div', 'web-back');
  back.appendChild(web.glyph(G.back, 30, 2.2));
  back.appendChild(PL.el('span', 'web-back-label', 'Back'));
  back.appendChild(PL.keycap('Back', 'web-back-key'));
  back.addEventListener('click', function (e) {
    e.stopPropagation();
    app.press(K.BACK);
  });

  web.updateBack = function () {
    var top = app.top();
    var on = pointerMode() && !!top && app.stack.length > 1 && !top.root && !top.noBack &&
      !(top.hideBack && top.hideBack());
    back.classList.toggle('on', on);
  };

  ['push', 'pop', 'replaceTop', 'setRoot'].forEach(function (name) {
    var orig = app[name];
    app[name] = function () {
      var out = orig.apply(this, arguments);
      web.tip.hide();
      web.updateBack();
      return out;
    };
  });
  PL.input.on(function () { web.updateBack(); });
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('app').appendChild(back);
    web.updateBack();
  });

  // ---- Keys: / Search, M mute, N next episode, ? the shortcuts ---------------------------------

  function typingIn(e) {
    var t = e.target;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function screenTypes() {
    var top = app.top();
    return !!(top && top.typesLetters && !app.tabsFocused);
  }

  // The screen under any overlays that plays video (the player, a live channel)
  function player() {
    for (var i = app.stack.length - 1; i >= 0; i--) if (app.stack[i].video) return app.stack[i];
    return null;
  }

  function goSearch() {
    var i = app.tabs.tabs.map(function (t) { return t.id; }).indexOf('search');
    if (i < 0 || !app.ready) return;
    while (app.stack.length > 1) if (!app.pop()) break;
    if (app.tabs.selected !== i || !(app.top() && app.top().typesLetters)) app.selectTab(i);
    else app.blurTabs();
  }

  // e.key where the browser has it, else the US layout's key codes
  function keyName(e) {
    if (e.key && e.key.length === 1) return e.key;
    if (e.keyCode === 191) return e.shiftKey ? '?' : '/';
    if (e.keyCode === 77) return e.shiftKey ? 'M' : 'm';
    if (e.keyCode === 78) return e.shiftKey ? 'N' : 'n';
    return '';
  }

  var taken = {};
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e) || !app.ready) return;
    var k = keyName(e);
    var act = null;
    if (k === '?') act = function () { web.shortcuts(); };
    else if (k === '/' && !screenTypes()) act = goSearch;
    else if ((k === 'm' || k === 'M') && !screenTypes() && player()) act = function () { web.playerKey(player(), 'mute'); };
    else if ((k === 'n' || k === 'N') && !screenTypes() && player()) act = function () { web.playerKey(player(), 'next'); };
    if (!act) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    taken[e.keyCode] = true;
    if (!e.repeat) act();
  }, true);
  window.addEventListener('keyup', function (e) {
    if (!taken[e.keyCode]) return;
    delete taken[e.keyCode];
    e.stopImmediatePropagation();
  }, true);

  // M and N on the player: the player's own (web/web-player.js) when it has them.
  web.playerKey = function (p, what) {
    if (p.webKey && p.webKey(what)) return;
    if (what === 'mute') {
      p.video.muted = !p.video.muted;
      PL.toast(p.video.muted ? 'Muted' : 'Sound on', 1500);
    } else if (what === 'next' && p.nextItem && p.nextItem() && p.playNext) {
      p.playNext(true);
    }
  };

  // ---- The "?" overlay: every key, grouped like the remote ----------------------------------------

  // [label, keys, new on the web]; keys: [cap, ...]; '~or' and '~/' are words between caps
  var GROUPS = [
    ['Everywhere', [
      ['Move', ['←', '↑', '↓', '→']],
      ['Select', ['Enter']],
      ['Back', ['Esc', '~or', '⌫']],
      ['More options (hold OK)', ['⇧', 'Enter']],
      ['Search', ['/'], true],
      ['Full screen', ['F']],
      ['This list', ['?'], true],
    ]],
    ['Watching', [
      ['Play / pause', ['Space']],
      ['Back 10 s / ahead 30 s', ['←', '~/', '→']],
      ['Rewind / fast-forward', [',', '~/', '.']],
      ['Subtitles and audio', ['↑']],
      ['Info, Cast, Chapters', ['↓']],
      ['Mute', ['M'], true],
      ['Next episode', ['N'], true],
    ]],
    ['Live TV', [
      ['Channel up / down', ['PgUp', '~/', 'PgDn']],
      ['Channel number', ['0–9']],
      ['Browse channels', ['B']],
      ['Favourite', ['Y']],
      ['Last channel', ['R']],
      ['Programme info', ['I']],
    ]],
  ];
  var MOUSE = [['Right-click', 'more options'], ['Double-click', 'full screen'], ['Click the bar', 'to jump'], ['Back button', 'on your mouse']];

  function shortcutsScreen() {
    var el = PL.el('div', 'web-keys-screen');
    el.appendChild(PL.el('div', 'web-keys-scrim'));
    var card = PL.el('div', 'web-keys');
    var close = PL.el('div', 'web-keys-close');
    close.appendChild(web.glyph(G.close, 30, 2.4));
    web.tip(close, 'Close', 'Back');
    card.appendChild(close);
    card.appendChild(PL.el('div', 'web-keys-title', 'Keyboard shortcuts'));
    card.appendChild(PL.el('div', 'web-keys-sub', 'The same keys as the TV remote: Enter is OK, Esc is Back, R G Y B are the coloured buttons.'));
    var cols = PL.el('div', 'web-keys-cols');
    GROUPS.forEach(function (g) {
      var col = PL.el('div', 'web-keys-col');
      col.appendChild(PL.el('div', 'web-keys-head', g[0]));
      g[1].forEach(function (row) {
        var r = PL.el('div', 'web-keys-row');
        var label = PL.el('span', 'web-keys-label', row[0]);
        if (row[2]) label.appendChild(PL.el('span', 'web-keys-new'));
        r.appendChild(label);
        var caps = PL.el('span', 'web-keys-caps');
        row[1].forEach(function (c) {
          caps.appendChild(c.charAt(0) === '~' ? PL.el('span', 'web-keys-or', c.slice(1)) : PL.el('span', 'keycap web-keycap', c));
        });
        r.appendChild(caps);
        col.appendChild(r);
      });
      cols.appendChild(col);
    });
    card.appendChild(cols);
    var mouse = PL.el('div', 'web-keys-mouse');
    mouse.appendChild(PL.el('span', 'web-keys-head', 'Mouse'));
    MOUSE.forEach(function (m, i) {
      if (i) mouse.appendChild(PL.el('span', 'web-keys-dot', '·'));
      var b = PL.el('span', 'web-keys-m');
      b.appendChild(PL.el('b', '', m[0]));
      b.appendChild(document.createTextNode(' ' + m[1]));
      mouse.appendChild(b);
    });
    card.appendChild(mouse);
    var foot = PL.el('div', 'web-keys-foot');
    var fl = PL.el('span', 'web-keys-footnew');
    fl.appendChild(PL.el('span', 'web-keys-new'));
    fl.appendChild(document.createTextNode('New on the web'));
    foot.appendChild(fl);
    var fr = PL.el('span', 'web-keys-footright', 'On-screen key hints: ');
    fr.appendChild(PL.el('b', '', PL.input.label(PL.input.setting())));
    fr.appendChild(document.createTextNode(' · change in Settings → Controls'));
    foot.appendChild(fr);
    card.appendChild(foot);
    el.appendChild(card);

    var screen = {
      el: el, overlay: true, noBack: true, shortcuts: true,
      // Esc, Back, Enter or ? close it; nothing reaches the screen underneath
      key: function (code) {
        if (PL.isBack(code) || code === K.ENTER) app.pop();
        return true;
      },
    };
    close.addEventListener('click', function (e) { e.stopPropagation(); if (app.top() === screen) app.pop(); });
    el.addEventListener('click', function (e) {
      if (e.target === el || e.target.classList.contains('web-keys-scrim')) { if (app.top() === screen) app.pop(); }
    });
    return screen;
  }

  // Opens the overlay, or closes it when it is open. A playing video keeps playing under it.
  web.shortcuts = function () {
    var top = app.top();
    if (top && top.shortcuts) {
      app.pop();
      return;
    }
    app.push(shortcutsScreen());
  };
})();
