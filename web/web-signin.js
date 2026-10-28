// The web build's sign-in screen (replaces js/screens/common.js's plex.tv/link screen there).
// "Sign in with Plex" is Plex's own page (app.plex.tv/auth) for a PIN this browser asked for: it
// opens in a popup, or in this tab if popups are blocked, and the app polls the PIN until Plex hands
// over the sign-in. "Use a link code" is the TV's flow: a four-character code typed in at
// plex.tv/link on any device. The token lands in this browser's localStorage only.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var screens = PL.screens;
  var K = PL.KEY;
  var POLL_MS = 2000;
  var PENDING = 'pendingPin'; // sessionStorage (this tab): a PIN whose sign-in page took over the tab

  function pending(value) {
    try {
      if (value === undefined) {
        var raw = sessionStorage.getItem('pl.' + PENDING);
        return raw ? JSON.parse(raw) : null;
      }
      if (value === null) sessionStorage.removeItem('pl.' + PENDING);
      else sessionStorage.setItem('pl.' + PENDING, JSON.stringify(value));
    } catch (e) { /* storage blocked */ }
    return null;
  }

  // plex.tv's errors in words (PL.errorMessage speaks of "the Plex server"), and how long to wait
  // before asking again: longer when plex.tv says it's getting too many requests.
  function tvProblem(err) {
    if (err && err.status === 429) return { text: 'plex.tv is busy. Trying again in a moment…', ms: 30000 };
    var why = !err || !err.status ? 'no connection' : 'HTTP ' + err.status;
    return { text: 'Could not reach plex.tv (' + why + '). Retrying…', ms: 5000 };
  }

  // Where Plex sends the browser after sign-in: a small page that closes the popup, or this app.
  function forwardUrl(popup) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return popup ? base + 'signed-in.html' : base;
  }

  screens.signin = function (onDone) {
    var el = PL.el('div', 'signin-screen');
    var card = PL.el('div', 'center-card web-signin');
    el.appendChild(card);
    var alive = true;
    var timers = { poll: null, pin: null };
    var pin = null;      // the strong PIN for app.plex.tv/auth
    var popup = null;
    var view = 'start';
    var row = null;
    var status = null;

    function setStatus(text, spinning) {
      if (!status) return;
      PL.clear(status);
      if (spinning) status.appendChild(PL.ui.spinner());
      status.appendChild(document.createTextNode(text));
    }

    function stopTimers() {
      clearTimeout(timers.poll);
      clearTimeout(timers.pin);
    }

    function finish(token) {
      stopTimers();
      pending(null);
      try { if (popup && !popup.closed) popup.close(); } catch (e) { /* cross-origin or gone */ }
      PL.plex.setToken(token);
      onDone();
    }

    // Polls one PIN until Plex reports a token, the PIN expires or the screen goes away.
    function poll(p) {
      clearTimeout(timers.poll);
      timers.poll = setTimeout(function () {
        if (!alive) return;
        PL.plex.checkPin(p.id).then(function (token) {
          if (!alive) return;
          if (token) finish(token);
          else poll(p);
        }, function (err) {
          if (!alive) return;
          // 404: the PIN expired
          if (err && err.status === 404) {
            pending(null);
            if (view === 'code') { newLinkPin(); return; }
            setStatus('That sign-in timed out. Choose Sign in with Plex to try again.', false);
            freshPin();
            return;
          }
          if (err && err.status === 429) { clearTimeout(timers.poll); timers.poll = setTimeout(function () { poll(p); }, 15000); return; }
          poll(p);
        });
      }, POLL_MS);
    }

    // PINs expire (Plex says when); a fresh one is fetched shortly before.
    function expiry(p, fallbackMs) {
      var s = p && Number(p.expiresIn);
      return s > 60 ? (s - 30) * 1000 : fallbackMs;
    }

    function freshPin() {
      clearTimeout(timers.pin);
      return PL.plex.createPin(true).then(function (p) {
        if (!alive) return null;
        pin = p;
        timers.pin = setTimeout(function () { if (view === 'start') freshPin(); }, expiry(p, 25 * 60 * 1000));
        return p;
      }, function (err) {
        if (!alive) return null;
        var t = tvProblem(err);
        setStatus(t.text, false);
        timers.pin = setTimeout(freshPin, t.ms);
        return null;
      });
    }

    function openPlex() {
      var p = pin;
      if (!p) {
        setStatus('Getting ready…', true);
        freshPin().then(function (got) { if (got) setStatus('Ready: choose Sign in with Plex again.', false); });
        return;
      }
      var w = 600;
      var h = 720;
      var left = Math.max(0, Math.round((screen.width - w) / 2));
      var top = Math.max(0, Math.round((screen.height - h) / 2));
      try {
        popup = window.open(PL.plex.authUrl(p, forwardUrl(true)), 'plexlite-signin',
          'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top);
      } catch (e) {
        popup = null;
      }
      if (!popup) {
        // popups blocked: sign in in this tab; Plex brings the browser back here afterwards
        pending({ id: p.id, code: p.code, at: Date.now() });
        location.assign(PL.plex.authUrl(p, forwardUrl(false)));
        return;
      }
      clearTimeout(timers.pin); // keep this PIN while its page is open
      setStatus('Waiting for you to sign in in the Plex window. Closed it? Choose Sign in with Plex again.', true);
      poll(p);
    }

    function newLinkPin() {
      clearTimeout(timers.poll);
      clearTimeout(timers.pin);
      var tiles = card.querySelector('.code-tiles');
      if (tiles) PL.clear(tiles);
      setStatus('Getting a code…', true);
      PL.plex.createPin(false).then(function (p) {
        if (!alive || view !== 'code') return;
        var t = card.querySelector('.code-tiles');
        PL.clear(t);
        String(p.code).split('').forEach(function (ch) { t.appendChild(PL.el('span', 'code-tile', ch)); });
        setStatus('and enter this code. Waiting for you to sign in…', true);
        timers.pin = setTimeout(newLinkPin, expiry(p, 14 * 60 * 1000));
        poll(p);
      }, function (err) {
        if (!alive || view !== 'code') return;
        var t = tvProblem(err);
        setStatus(t.text, false);
        timers.pin = setTimeout(newLinkPin, t.ms);
      });
    }

    function render() {
      PL.clear(card);
      stopTimers();
      if (view === 'code') {
        card.appendChild(PL.el('div', 'signin-wait', 'On a phone or computer, go to'));
        card.appendChild(PL.el('div', 'signin-url', 'plex.tv/link'));
        card.appendChild(PL.el('div', 'code-tiles'));
        status = PL.el('div', 'signin-wait');
        card.appendChild(status);
        row = new PL.ui.ButtonRow([{ label: 'Sign in with Plex instead', kind: 'primary', action: function () { show('start'); } }]);
        card.appendChild(PL.el('div', { className: 'web-signin-buttons' }, [row.el]));
        row.setFocused(true);
        newLinkPin();
        return;
      }
      card.appendChild(PL.el('h1', '', 'Sign in to Plex'));
      card.appendChild(PL.el('p', '', 'Plex Lite connects to your Plex server with your Plex account. ' +
        'Your sign-in stays in this browser, and you can sign out under Settings.'));
      row = new PL.ui.ButtonRow([
        { label: 'Sign in with Plex', kind: 'primary', action: openPlex },
        { label: 'Use a link code', action: function () { show('code'); } },
      ]);
      card.appendChild(PL.el('div', { className: 'web-signin-buttons' }, [row.el]));
      status = PL.el('div', 'signin-wait');
      card.appendChild(status);
      row.setFocused(true);
      var back = pending();
      if (back && Date.now() - back.at < 30 * 60 * 1000) {
        // returning from Plex's page in this tab
        pin = back;
        setStatus('Finishing sign-in…', true);
        poll(back);
      } else {
        pending(null);
        freshPin();
      }
    }

    function show(v) {
      view = v;
      render();
    }

    render();
    return {
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); },
      destroy: function () { alive = false; stopTimers(); },
      key: function (code) {
        if (PL.isBack(code)) {
          if (view === 'code') { show('start'); return true; }
          return false;
        }
        if (code === K.UP || code === K.DOWN) return true;
        return row ? row.key(code) || true : true;
      },
    };
  };
})();
