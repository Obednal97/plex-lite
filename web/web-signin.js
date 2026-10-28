// The web build's sign-in with Plex's own page (app.plex.tv/auth), used by the first-run screens
// (js/screens/firstrun.js). A strong PIN is fetched in advance, so the popup opens inside the click
// itself (browsers only allow popups then); Plex Lite polls the PIN until Plex hands over the
// sign-in. If popups are blocked, "Continue in this tab" signs in in this tab: Plex sends the
// browser back here and the sign-in finishes (the PIN waits in sessionStorage meanwhile). The token
// lands in this browser's localStorage only.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var PENDING = 'pl.pendingPin'; // sessionStorage (this tab): a PIN whose sign-in page took over the tab
  var w = PL.webSignin = {};
  var pin = null;      // the next strong PIN, ready for a click
  var opened = null;   // the PIN whose sign-in page is open
  var popup = null;
  var timer = null;
  var onMessage = null;

  function store(value) {
    try {
      if (value === undefined) {
        var raw = sessionStorage.getItem(PENDING);
        return raw ? JSON.parse(raw) : null;
      }
      if (value === null) sessionStorage.removeItem(PENDING);
      else sessionStorage.setItem(PENDING, JSON.stringify(value));
    } catch (e) { /* storage blocked */ }
    return null;
  }

  // Where Plex sends the browser after sign-in: a small page that closes the popup, or this app.
  function forwardUrl(inPopup) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return inPopup ? base + 'signed-in.html' : base;
  }

  // Keeps a fresh strong PIN ready (PINs expire; plex.tv says when). msg(text): problems reaching plex.tv.
  w.prepare = function (msg) {
    onMessage = msg || onMessage;
    if (pin && pin.readyUntil > Date.now()) return;
    clearTimeout(timer);
    PL.plex.createPin(true).then(function (p) {
      pin = p;
      var ms = PL.firstrunLogic.renewIn(p, 25 * 60 * 1000);
      pin.readyUntil = Date.now() + ms;
      if (onMessage) onMessage('');
      timer = setTimeout(function () { pin = null; w.prepare(); }, ms);
    }, function (err) {
      if (onMessage) onMessage(err && err.status === 429 ? 'plex.tv is busy. Trying again in a moment…' : 'Can’t reach plex.tv. Trying again…');
      timer = setTimeout(function () { w.prepare(); }, PL.firstrunLogic.retryIn(err));
    });
  };

  w.stop = function () {
    clearTimeout(timer);
    timer = null;
  };

  function openWindow(p) {
    var width = 600;
    var height = 720;
    var left = Math.max(0, Math.round((screen.width - width) / 2));
    var top = Math.max(0, Math.round((screen.height - height) / 2));
    try {
      return window.open(PL.plex.authUrl(p, forwardUrl(true)), 'plexlite-signin',
        'popup=yes,width=' + width + ',height=' + height + ',left=' + left + ',top=' + top);
    } catch (e) {
      return null;
    }
  }

  // Opens Plex's sign-in page in a popup: 'opened', 'blocked', or 'notReady' (no PIN yet: one is
  // on its way, so the next click works).
  w.open = function () {
    if (!pin) { w.prepare(); return 'notReady'; }
    var p = pin;
    popup = openWindow(p);
    if (!popup) { opened = p; return 'blocked'; }
    opened = p;
    pin = null;
    w.stop();
    return 'opened';
  };

  // "Show the Plex window": bring it forward, or open it again for the same PIN.
  w.show = function () {
    try {
      if (popup && !popup.closed) { popup.focus(); return 'shown'; }
    } catch (e) { /* cross-origin */ }
    if (!opened) return w.open();
    popup = openWindow(opened);
    return popup ? 'opened' : 'blocked';
  };

  w.current = function () { return opened; };

  // Popups blocked: sign in in this tab instead. Plex brings the browser back to the app.
  w.continueInTab = function () {
    var p = opened || pin;
    if (!p) { w.prepare(); return; }
    store({ id: p.id, code: p.code, at: Date.now() });
    location.assign(PL.plex.authUrl(p, forwardUrl(false)));
  };

  // A sign-in that went through Plex's page in this tab, returning now (else null).
  w.pending = function () {
    var back = store();
    if (back && Date.now() - back.at < 30 * 60 * 1000) return back;
    store(null);
    return null;
  };

  // Cancel, or the code instead: the open sign-in is dropped (and one that took over this tab).
  w.cancel = function () {
    w.closePopup();
    store(null);
  };

  w.closePopup = function () {
    try { if (popup && !popup.closed) popup.close(); } catch (e) { /* cross-origin or gone */ }
    popup = null;
    opened = null;
  };

  // The PIN expired: start again with a fresh one.
  w.forget = function () {
    w.closePopup();
    store(null);
    w.prepare();
  };

  w.done = function () {
    w.closePopup();
    store(null);
    w.stop();
    pin = null;
  };
})();
