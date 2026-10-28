// First run (sign-in, Who's watching, PIN, the local-network explainer, connecting, errors): the
// decisions, with no DOM, so test/firstrun.test.mjs can run them in Node. js/screens/firstrun.js
// draws the views and runs the effects (plex.tv calls, polling, connecting). docs/FIRSTRUN.md has
// the flow. ES2015 for Chrome 53 like the rest.
'use strict';

(function () {
  var PL = window.PL = window.PL || {};
  var L = PL.firstrunLogic = {};

  // ---- Views ---------------------------------------------------------------------------------------

  // welcome    web only: Sign in with Plex (popup) or Use a code instead           board A
  // waiting    web: Plex's sign-in window is open, polling                          A1
  // blocked    web: the browser blocked the popup                                   A8
  // code       plex.tv/link code + QR (the TV's sign-in)                            A2, T1
  // profiles   Who's watching? (Plex Home)                                          A3, T2
  // pin        a protected profile's PIN                                            A4
  // lna        web: before Chrome's local-network prompt                            A5
  // connecting finding and reaching the server                                     A6
  // error      the server can't be used: error.code says which sheet               A7, A8
  // servers    another server on the account
  L.VIEWS = ['welcome', 'waiting', 'blocked', 'code', 'profiles', 'pin', 'lna', 'connecting', 'error', 'servers'];

  // ctx: {platform: 'web' | 'tv', firstRun: bool (signing in now), from: 'launch' | 'settings',
  //       hasProfiles: bool, view}
  L.initial = function (ctx) {
    var s = {
      platform: ctx.platform === 'tv' ? 'tv' : 'web',
      firstRun: !!ctx.firstRun,
      from: ctx.from || 'launch',
      hasProfiles: !!ctx.hasProfiles,
      view: ctx.view || null,
      user: null,
      pin: '',
      pinError: false,
      pinBusy: false,
      shake: 0,
      routes: null,
      error: null,
    };
    if (!s.view) s.view = L.signInView(s.platform);
    return s;
  };

  // The TV can't open Plex's sign-in page: it signs in with a code.
  L.signInView = function (platform) {
    return platform === 'tv' ? 'code' : 'welcome';
  };

  function copy(s, changes) {
    var out = {};
    Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    Object.keys(changes).forEach(function (k) { out[k] = changes[k]; });
    return out;
  }

  // Where Back (Esc, the remote's Back, the browser's Back) goes from each view; null: nowhere
  // inside the flow (the TV app exits, the browser leaves the page, Settings gets the screen back).
  L.backTarget = function (s) {
    switch (s.view) {
      case 'waiting':
      case 'blocked':
        return 'welcome';
      case 'code':
        return s.platform === 'web' ? 'welcome' : null;
      case 'pin':
        return 'profiles';
      case 'servers':
        return 'error';
      case 'profiles':
        return null;
      case 'lna':
      case 'connecting':
      case 'error':
        return s.hasProfiles && s.firstRun ? 'profiles' : null;
      default:
        return null;
    }
  };

  // Cancel on the connecting sheet: back to the profiles, or (just signed in, no profiles) out to
  // the sign-in screen. On an ordinary launch with no profiles there is nothing to go back to.
  L.cancelTarget = function (s) {
    if (s.hasProfiles && (s.firstRun || s.from === 'settings')) return 'profiles';
    if (s.firstRun) return L.signInView(s.platform);
    return null;
  };

  // ---- Transitions ---------------------------------------------------------------------------------

  // event: {type, ...}. Returns the next state (the same object when nothing changes).
  L.next = function (s, e) {
    switch (e.type) {
      case 'BACK': {
        var to = L.backTarget(s);
        if (!to) return s;
        return copy(s, { view: to, pin: '', pinError: false, pinBusy: false });
      }
      case 'POPUP_OPENED':
        return copy(s, { view: 'waiting' });
      case 'POPUP_BLOCKED':
        return copy(s, { view: 'blocked' });
      case 'USE_CODE':
        return copy(s, { view: 'code' });
      case 'CANCEL': {
        var c = s.view === 'connecting' ? L.cancelTarget(s) : L.backTarget(s);
        if (!c) return s;
        return copy(s, { view: c, pin: '', pinError: false, pinBusy: false, routes: null });
      }
      case 'SIGNED_IN':
        // users: the account's Plex Home profiles ([] when it has none)
        if (L.needsPicker(e.users)) return copy(s, { view: 'profiles', hasProfiles: true, firstRun: true });
        return copy(s, { view: 'connecting', firstRun: true, hasProfiles: false, routes: null });
      case 'PICK':
        if (e.user && e.user.protected) return copy(s, { view: 'pin', user: e.user, pin: '', pinError: false, pinBusy: false });
        return copy(s, { view: 'connecting', user: e.user, routes: null });
      case 'PIN_KEY': {
        if (s.view !== 'pin' || s.pinBusy) return s;
        var p = L.pinStep(s.pin, e.key);
        if (p.pin === s.pin && !p.submit) return s;
        return copy(s, { pin: p.pin, pinError: p.pin ? false : s.pinError, pinBusy: p.submit });
      }
      case 'PIN_WRONG':
        // the dots shake (transform only), clear, and say so
        return copy(s, { pin: '', pinBusy: false, pinError: true, shake: s.shake + 1 });
      case 'PIN_FAILED':
        // plex.tv couldn't check it: keep the screen, let them try again
        return copy(s, { pin: '', pinBusy: false, pinError: 'failed' });
      case 'PIN_OK':
        return copy(s, { view: 'connecting', pinBusy: false, routes: null });
      case 'LNA_ASK':
        return copy(s, { view: 'lna' });
      case 'CONNECTING':
        return copy(s, { view: 'connecting', routes: s.view === 'connecting' ? s.routes : null, server: e.server || s.server });
      case 'ROUTE': {
        var r = copy(s.routes || {}, {});
        r[e.kind] = e.status;
        return copy(s, { routes: r, server: e.server || s.server });
      }
      case 'FAILED':
        return copy(s, { view: 'error', error: e.error });
      case 'RETRY':
        return copy(s, { view: 'connecting', routes: null });
      case 'SIGN_OUT':
        return copy(s, { view: L.signInView(s.platform), user: null, hasProfiles: false, firstRun: true, error: null, routes: null, pin: '', pinBusy: false });
      case 'CHOOSE_PROFILE':
        return copy(s, { view: 'profiles', pin: '', pinError: false, pinBusy: false });
      case 'CHOOSE_SERVER':
        return copy(s, { view: 'servers' });
      case 'SHOW':
        return copy(s, { view: e.view });
      default:
        return s;
    }
  };

  // ---- Who's watching ------------------------------------------------------------------------------

  // The picker only appears when the account has Plex Home profiles to choose between.
  L.needsPicker = function (users) {
    return !!(users && users.length > 1);
  };

  // Which profile has the focus first: the one used last on this device, else the owner.
  L.firstFocus = function (users, rememberedUuid) {
    var i;
    for (i = 0; i < users.length; i++) if (rememberedUuid && users[i].uuid === rememberedUuid) return i;
    for (i = 0; i < users.length; i++) if (users[i].admin) return i;
    return 0;
  };

  // A profile needs a switch on plex.tv unless it is the one the current sign-in already belongs to
  // (currentUuid) and has no PIN. Anyone else, the owner included, switches: the token in use may
  // be another profile's.
  L.needsSwitch = function (user, currentUuid) {
    return !(user && currentUuid && user.uuid === currentUuid && !user.protected);
  };

  // A line under the name: Owner, PIN (or Kids for a managed child account)
  L.profileNote = function (user) {
    if (user.admin) return 'Owner';
    if (user.protected) return 'PIN';
    return '';
  };

  // ---- PIN -----------------------------------------------------------------------------------------

  L.PIN_LENGTH = 4;

  // key: '0'-'9' or 'del'. Digits after the fourth are ignored; the fourth submits.
  L.pinStep = function (pin, key) {
    pin = pin || '';
    if (key === 'del') return { pin: pin.slice(0, -1), submit: false };
    if (!/^[0-9]$/.test(String(key)) || pin.length >= L.PIN_LENGTH) return { pin: pin, submit: false };
    var next = pin + key;
    return { pin: next, submit: next.length === L.PIN_LENGTH };
  };

  // A digit from a key code: the number row, the keypad, and the remote's number keys.
  L.digitFromKey = function (code) {
    if (code >= 48 && code <= 57) return String(code - 48);
    if (code >= 96 && code <= 105) return String(code - 96);
    return null;
  };

  // plex.tv answers a wrong PIN on /home/users/<uuid>/switch with 401 or 403 (and 422 has been
  // seen); anything else (no connection, 5xx) means it couldn't check it.
  L.isWrongPin = function (err) {
    return !!err && (err.status === 401 || err.status === 403 || err.status === 422);
  };

  // ---- Local network (Chrome's permission, web only) -----------------------------------------------

  // What to do before the first request to the server's local address:
  //   'ask'   show the explainer; the request waits for Continue (or Skip)
  //   'allow' go ahead (granted, or a browser without the permission)
  //   'skip'  don't look at home: denied ('blocked'), skipped before, or no local address
  // o: {platform, state: 'granted'|'denied'|'prompt'|null, hasLocal, skipped}
  L.lnaDecision = function (o) {
    if (o.platform !== 'web' || !o.hasLocal) return 'allow';
    if (o.state === 'granted' || o.state == null) return 'allow';
    if (o.state === 'denied') return 'blocked';
    return o.skipped ? 'skip' : 'ask';
  };

  // The permission's names, newest first (Chrome renamed it; loopback-network covers 127.0.0.1 and
  // localhost addresses only, so it decides nothing for a server elsewhere on the network).
  L.LNA_NAMES = ['local-network-access', 'local-network'];

  // ---- Errors --------------------------------------------------------------------------------------

  // Error codes from js/plex.js (err.code) and the sheet each one gets.
  L.ERRORS = {
    NO_SERVER: 'noServer',         // the account has no server and none is shared with it
    UNREACHABLE: 'unreachable',    // found, but no route answered (err.routes says which failed how)
    NO_SECURE_ADDRESS: 'unreachable',
    NO_LIBRARIES: 'noLibraries',   // connected, but this profile can see no film or TV library
    NO_ACCESS: 'noLibraries',      // the server turned this profile away (401/403)
    PLEX_TV: 'plexTv',             // plex.tv itself can't be reached
  };

  // err -> {code, sheet, server, routes, servers}
  L.classify = function (err) {
    var code = err && err.code;
    if (!code || !L.ERRORS[code]) {
      if (err && (err.status === 401 || err.status === 403) && err.server) code = 'NO_ACCESS';
      else if (err && err.plexTv) code = 'PLEX_TV';
      else code = 'UNREACHABLE';
    }
    return {
      code: code,
      sheet: L.ERRORS[code],
      server: (err && err.server) || '',
      routes: (err && err.routes) || null,
      servers: (err && err.servers) || 0,
      message: (err && err.message) || '',
    };
  };

  // A route's result in words, for the "what was tried" rows (A7) and the connecting sheet (A6).
  // status: 'ok' | 'trying' | 'timeout' | 'fail' | 'refused' | 'none' | 'blocked' | 'skipped' |
  //         'insecure' | undefined (not tried)
  var RESULT = {
    lan: { none: 'No address at home', blocked: 'Blocked in this browser', skipped: 'Skipped', insecure: 'No secure address' },
    remote: { none: 'Not turned on for this server', insecure: 'No secure address' },
    relay: { none: 'Not available', insecure: 'Not available' },
  };
  var SHORT = { remote: { none: 'Turned off' } };

  L.routeLabel = function (kind, short) {
    if (kind === 'lan') return 'Home network';
    if (kind === 'remote') return short ? 'Remote Access' : 'Plex Remote Access';
    return 'Plex relay';
  };

  L.routeResult = function (kind, status, short) {
    var own = (short && SHORT[kind] && SHORT[kind][status]) || (RESULT[kind] && RESULT[kind][status]);
    if (own) return own;
    switch (status) {
      case 'ok': return 'Connected';
      case 'trying': return 'Trying…';
      case 'refused': return 'Turned this device away';
      case 'timeout':
      case 'fail': return 'No answer';
      default: return 'Not tried';
    }
  };

  // The rows of the error sheet, in order. Relay is only listed when it was tried or offered.
  L.triedRows = function (routes, short) {
    routes = routes || {};
    var rows = [];
    ['lan', 'remote', 'relay'].forEach(function (k) {
      if (k === 'relay' && (!routes.relay || routes.relay === 'none')) return;
      rows.push({ kind: k, label: L.routeLabel(k, short), value: L.routeResult(k, routes[k] || 'none', short) });
    });
    return rows;
  };

  // A hint under the rows when Remote Access would have helped.
  L.triedHint = function (routes) {
    if (routes && routes.remote === 'none') return 'Away from home? Turn on Remote Access in the server’s Plex settings.';
    if (routes && (routes.lan === 'blocked' || routes.lan === 'skipped')) return 'At home? Allow local network access for this site, then try again.';
    return '';
  };

  // ---- The web layout ------------------------------------------------------------------------------

  // web/firstrun-web.css: 'short' (a phone in landscape), 'stack' (portrait phones and tablets, and
  // narrow windows), else 'desk' (the 1440x900 boards).
  L.webLayout = function (w, h) {
    if (h <= 500 && w > h) return 'short';
    if (w < 700 || (w < 1024 && h > w)) return 'stack';
    return 'desk';
  };

  function clampTo(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // How far to zoom the layout's own board sizes for this window.
  L.webZoom = function (layout, w, h) {
    var z;
    if (layout === 'stack') z = clampTo(Math.min(w / 390, h / 844), 1, 1.35);
    else if (layout === 'short') z = clampTo(Math.min(w / 844, h / 390), 1, 1.2); // never below: 44 px targets
    else z = clampTo(Math.min(w / 1440, h / 900), 0.7, 1.45);
    return Math.round(z * 1000) / 1000;
  };

  // The left margin on the desktop layout, in zoomed pixels: 96 up to the board's width, growing on
  // wider windows (the ultrawide board: 160 px at 2560x1080).
  L.webMargin = function (layout, w, z) {
    if (layout !== 'desk') return 24;
    var room = w / z - 1440;
    return room > 0 ? 96 + room * 0.054 : 96;
  };

  // ---- Link codes ----------------------------------------------------------------------------------

  // plex.tv/link fills in the code from ?token= (its link form reads that parameter, and keeps it
  // through Plex's sign-in), so scanning the QR code needs no typing.
  L.linkUrl = function (code) {
    return code ? 'https://plex.tv/link/?token=' + encodeURIComponent(code) : 'https://plex.tv/link';
  };

  // How long before a PIN expires to fetch the next one: plex.tv says (expiresIn, seconds).
  L.renewIn = function (pin, fallbackMs) {
    var s = pin && Number(pin.expiresIn);
    return s > 60 ? (s - 30) * 1000 : fallbackMs;
  };

  // plex.tv's own errors: 429 asks us to slow down.
  L.retryIn = function (err) {
    return err && err.status === 429 ? 30000 : 5000;
  };
})();
