// Small screens: loading, message, sign-in, and the glass sheet (pickers and track menu).
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var K = PL.KEY;

  screens.loading = function (text) {
    var el = PL.el('div', 'loading-screen');
    var box = PL.el('div', 'loading');
    box.appendChild(PL.ui.spinner());
    box.appendChild(PL.el('div', '', text || 'Loading…'));
    el.appendChild(box);
    return {
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); },
      key: function (code) { return !PL.isBack(code); },
    };
  };

  // actions: [{label, kind, action}]
  screens.message = function (title, body, actions) {
    var el = PL.el('div', 'message-screen');
    var card = PL.el('div', 'center-card');
    card.appendChild(PL.el('h1', '', title));
    card.appendChild(PL.el('p', '', body));
    var row = new PL.ui.ButtonRow((actions || []).map(function (a) {
      return { label: a.label, kind: 'primary', action: a.action };
    }));
    card.appendChild(row.el);
    el.appendChild(card);
    row.setFocused(true);
    return {
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); },
      key: function (code) { return row.key(code); },
    };
  };

  // ---- Sign-in with a plex.tv/link code ------------------------------------------------------

  screens.signin = function (onDone) {
    var el = PL.el('div', 'signin-screen');
    var card = PL.el('div', 'center-card');
    card.appendChild(PL.el('div', 'signin-wait', 'On your phone or computer, go to'));
    card.appendChild(PL.el('div', 'signin-url', 'plex.tv/link'));
    var tiles = PL.el('div', 'code-tiles');
    card.appendChild(tiles);
    var status = PL.el('div', 'signin-wait');
    card.appendChild(status);
    el.appendChild(card);
    var pollTimer = null;
    var pinTimer = null;
    var alive = true;

    function setStatus(text, spinning) {
      PL.clear(status);
      if (spinning) status.appendChild(PL.ui.spinner());
      status.appendChild(document.createTextNode(text));
    }

    function newPin() {
      clearTimeout(pollTimer);
      clearTimeout(pinTimer);
      PL.clear(tiles);
      setStatus('Getting a code…', true);
      PL.plex.createPin().then(function (pin) {
        if (!alive) return;
        PL.clear(tiles);
        String(pin.code).split('').forEach(function (ch) { tiles.appendChild(PL.el('span', 'code-tile', ch)); });
        setStatus('and enter this code. Waiting for you to sign in…', true);
        // codes expire (about 15 minutes); get a fresh one before that
        pinTimer = setTimeout(newPin, 14 * 60 * 1000);
        poll(pin.id);
      }, function (err) {
        if (!alive) return;
        setStatus('Could not reach plex.tv (' + PL.errorMessage(err) + '). Retrying…', false);
        pinTimer = setTimeout(newPin, 5000);
      });
    }

    function poll(id) {
      pollTimer = setTimeout(function () {
        PL.plex.checkPin(id).then(function (token) {
          if (!alive) return;
          if (token) {
            clearTimeout(pinTimer);
            PL.plex.setToken(token);
            onDone();
          } else {
            poll(id);
          }
        }, function () { if (alive) poll(id); });
      }, 2000);
    }

    newPin();
    return {
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); },
      destroy: function () { alive = false; clearTimeout(pollTimer); clearTimeout(pinTimer); },
      key: function (code) { return !PL.isBack(code); },
    };
  };

  // ---- Quick actions for a card (hold OK) -------------------------------------------------------

  // Returns false for items without actions (people, extras, collections) so a normal select runs.
  screens.itemMenu = function (item, onDone) {
    var t = item && item.type;
    if (['movie', 'episode', 'show', 'season'].indexOf(t) === -1) return false;
    var rows = [];
    var play = function (offset) {
      return function () { PL.app.push(screens.player(item, { offset: offset })); };
    };
    var open = function (target) {
      return function () { PL.app.push(screens.details(target)); };
    };
    if (t === 'movie' || t === 'episode') {
      if (item.viewOffset > 0) {
        rows.push({ label: 'Resume from ' + PL.fmt.clock(item.viewOffset / 1000), action: play(item.viewOffset) });
        rows.push({ label: 'Play from beginning', action: play(0) });
      } else {
        rows.push({ label: 'Play', action: play(0) });
      }
    }
    var watched = PL.ui.isWatched(item);
    var partial = item.viewOffset > 0 || (item.viewedLeafCount > 0 && !watched);
    var mark = function (on) {
      return function () {
        PL.plex.setWatched(item.ratingKey, on).then(function () {
          if (on) {
            item.viewCount = (item.viewCount || 0) + 1;
            if (item.leafCount) item.viewedLeafCount = item.leafCount;
          } else {
            item.viewCount = 0;
            if (item.leafCount) item.viewedLeafCount = 0;
          }
          delete item.viewOffset;
          PL.toast(on ? 'Marked as watched' : 'Marked as unwatched');
          if (onDone) onDone();
        }, function (err) { PL.toast(PL.errorMessage(err)); });
      };
    };
    if (!watched) rows.push({ label: 'Mark as watched', action: mark(true) });
    if (watched || partial) rows.push({ label: 'Mark as unwatched', action: mark(false) });
    if (t === 'episode' && item.grandparentRatingKey) {
      rows.push({ label: 'Go to show', action: open({ ratingKey: item.grandparentRatingKey, type: 'show', title: item.grandparentTitle }) });
    }
    if (t === 'season' && item.parentRatingKey) {
      rows.push({ label: 'Go to show', action: open({ ratingKey: item.parentRatingKey, type: 'show', title: item.parentTitle }) });
    }
    var heading = t === 'episode' ? (item.grandparentTitle || '') + ' · ' + PL.fmt.episode(item) : (item.title || '');
    var shown = false;
    var finish = function (extra) {
      if (shown) return;
      shown = true;
      (extra || []).forEach(function (a) { rows.push({ label: a.label, action: a.run }); });
      rows.push({ label: 'Details', action: open(item) });
      PL.app.push(screens.sheet([{ heading: heading, rows: rows }], { focus: 0 }));
    };
    var extra = PL.plugins && PL.plugins.actions ? PL.plugins.actions(item) : null;
    if (extra && typeof extra.then === 'function') {
      // external (sandboxed) plugins answer asynchronously; don't keep the menu waiting long
      extra.then(finish, function () { finish(null); });
      setTimeout(function () { finish(null); }, 600);
    } else {
      finish(extra);
    }
    return true;
  };

  // ---- Text entry (uses the TV's own on-screen keyboard) ---------------------------------------

  // onDone(value) -> true to close, false to keep editing.
  screens.textEntry = function (title, initial, placeholder, onDone) {
    var el = PL.el('div', 'text-entry');
    el.appendChild(PL.el('div', 'page-title', title));
    var input = PL.el('input', { className: 'text-input', attrs: { type: 'url', spellcheck: 'false', autocomplete: 'off', placeholder: placeholder || '' } });
    input.value = initial || '';
    el.appendChild(input);
    el.appendChild(PL.el('div', 'text-hint', 'Press ' + PL.keyLabel('OK') + ' to save · ' + PL.keyLabel('Back') + ' to cancel'));
    var submit = function () {
      if (onDone(input.value) !== false) {
        input.blur();
        PL.app.pop();
      }
    };
    return {
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); setTimeout(function () { input.focus(); }, 300); },
      hide: function () { input.blur(); },
      key: function (code) {
        if (code === K.ENTER) { submit(); return true; }
        if (PL.isBack(code)) { input.blur(); PL.app.pop(); return true; }
        if (code === K.DOWN || code === K.UP) { input.focus(); return true; }
        return false;
      },
    };
  };

  // ---- Glass sheet -----------------------------------------------------------------------------

  // sections: [{heading, rows: [{label, sub, checked, action}]}]. Pushed as an overlay screen.
  // opts: {closeOnSelect (default true), focus: index of the row to focus first}
  screens.sheet = function (sections, opts) {
    opts = opts || {};
    var el = PL.el('div', 'sheet-host');
    var scrim = PL.el('div', 'sheet-scrim');
    var sheet = PL.el('div', 'sheet sheet-enter');
    var list = PL.el('div', 'sheet-list');
    sheet.appendChild(list);
    el.appendChild(scrim);
    el.appendChild(sheet);
    var rows = [];
    var y = 0;
    sections.forEach(function (sec) {
      if (sec.heading) {
        list.appendChild(PL.el('div', 'sheet-heading', sec.heading));
        y += 52;
      }
      sec.rows.forEach(function (r) {
        var n = PL.el('div', 'sheet-row' + (r.checked ? ' checked' : ''));
        n.appendChild(document.createTextNode(r.label));
        if (r.sub) n.appendChild(PL.el('span', 'sheet-sub', r.sub));
        list.appendChild(n);
        rows.push({ node: n, row: r, top: y });
        y += 64;
      });
    });
    var index = PL.clamp(opts.focus != null ? opts.focus : Math.max(0, rows.map(function (r) { return !!r.row.checked; }).indexOf(true)), 0, rows.length - 1);
    var viewH = 888 - 48;

    function paint() {
      rows.forEach(function (r, i) { r.node.classList.toggle('focused', i === index); });
      var r = rows[index];
      if (!r) return;
      var shift = Math.max(0, Math.min(r.top - viewH / 2, y - viewH));
      PL.translate(list, 0, -Math.max(0, shift));
    }

    rows.forEach(function (r, i) {
      r.node.addEventListener('click', function () { index = i; choose(); });
    });
    scrim.addEventListener('click', function () { PL.app.pop(); });

    function choose() {
      var r = rows[index];
      if (!r) return;
      if (opts.closeOnSelect !== false) PL.app.pop();
      if (r.row.action) r.row.action();
    }

    paint();
    return {
      el: el,
      overlay: true,
      show: function () { requestAnimationFrame(function () { sheet.classList.remove('sheet-enter'); }); },
      key: function (code) {
        if (code === K.UP || code === K.DOWN) {
          index = PL.clamp(index + (code === K.DOWN ? 1 : -1), 0, rows.length - 1);
          paint();
          return true;
        }
        if (code === K.ENTER) {
          choose();
          return true;
        }
        if (PL.isBack(code)) {
          PL.app.pop();
          return true;
        }
        return true;
      },
    };
  };

  // Audio and subtitle choice for a playable item (mediaIndex: the version being played); calls
  // onChange() after the server has the choice. only: 'audio' or 'subtitles' shows just that section.
  screens.trackSheet = function (item, onChange, mediaIndex, only) {
    var media = item.Media && (item.Media[mediaIndex || 0] || item.Media[0]);
    var part = media && media.Part && media.Part[0];
    if (!part) {
      PL.toast('No audio or subtitle options for this item');
      return;
    }
    var streams = part.Stream || [];
    var audio = streams.filter(function (s) { return s.streamType === 2; });
    var subs = streams.filter(function (s) { return s.streamType === 3; });
    var pick = function (choice, apply) {
      return function () {
        PL.plex.selectStreams(part.id, choice).then(function () {
          apply();
          if (onChange) onChange();
        }, function (err) { PL.toast(PL.errorMessage(err)); });
      };
    };
    var label = function (s) { return s.displayTitle || s.extendedDisplayTitle || s.language || ('Track ' + s.index); };
    var sections = [];
    if (audio.length && only !== 'subtitles') {
      sections.push({
        heading: 'Audio',
        rows: audio.map(function (s) {
          return {
            label: label(s), checked: !!s.selected,
            action: pick({ audioStreamID: s.id }, function () { audio.forEach(function (a) { a.selected = a === s; }); }),
          };
        }),
      });
    }
    var subRows = [{
      label: 'Off', checked: !subs.some(function (s) { return s.selected; }),
      action: pick({ subtitleStreamID: 0 }, function () { subs.forEach(function (x) { x.selected = false; }); }),
    }];
    subs.forEach(function (s) {
      subRows.push({
        label: label(s), sub: s.forced ? 'Forced' : '', checked: !!s.selected,
        action: pick({ subtitleStreamID: s.id }, function () { subs.forEach(function (x) { x.selected = x === s; }); }),
      });
    });
    if (only !== 'audio') sections.push({ heading: 'Subtitles', rows: subRows });
    PL.app.push(screens.sheet(sections));
  };
})();
