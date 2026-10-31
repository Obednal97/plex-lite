// Home Assistant plugin: sends playback events (js/plugins.js, onPlayback) to a Home Assistant
// webhook, so an automation there can dim the lights while a film plays ("Movie mode") and bring
// them back on pause or stop. The lights logic lives in Home Assistant; this only reports.
// Notes, and the Home Assistant side: plugins/home-assistant/README.md.
//
// Transport: a form-encoded POST (a CORS "simple" request: no preflight, so it reaches Home
// Assistant from the TV's file:// page and from Nabu Casa's cloudhook relay alike), sent with
// fetch in no-cors mode: it resolves when a server answered and rejects when nothing did. Home
// Assistant answers 200 to every webhook call (even an unknown id), so "answered" is all anyone
// can know from here.
'use strict';

(function () {
  var HA = PL.homeAssistant = {};

  var DEFAULTS = { movieMode: true, trigger: 'films-shows', delaySec: 5 };
  HA.TRIGGERS = [
    { id: 'films', label: 'Films only', types: ['movie'] },
    { id: 'films-shows', label: 'Films and shows', types: ['movie', 'episode'] },
    { id: 'everything', label: 'Everything, including Live TV', types: ['movie', 'episode', 'live', 'clip'] },
  ];
  HA.DELAYS = [0, 5, 15];
  HA.LOCAL_TIMEOUT_MS = 1500;     // the local route, when a remote one can take over
  HA.TIMEOUT_MS = 8000;           // a route with nothing to fall back to, and the remote one
  HA.REMEMBER_MS = 10 * 60 * 1000; // how long the route that worked is tried first

  var START = ['play', 'resume'];
  var END = ['pause', 'stop', 'ended'];

  // ---- Settings ----------------------------------------------------------------------------------

  HA.config = function (ctx) {
    var c = ctx.storage.get('config', null) || {};
    return {
      localUrl: c.localUrl || '',
      remoteUrl: c.remoteUrl || '',
      movieMode: c.movieMode !== undefined ? !!c.movieMode : DEFAULTS.movieMode,
      trigger: HA.TRIGGERS.some(function (t) { return t.id === c.trigger; }) ? c.trigger : DEFAULTS.trigger,
      delaySec: HA.DELAYS.indexOf(c.delaySec) !== -1 ? c.delaySec : DEFAULTS.delaySec,
    };
  };

  HA.save = function (ctx, changes) {
    var c = HA.config(ctx);
    Object.keys(changes).forEach(function (k) { c[k] = changes[k]; });
    ctx.storage.set('config', c);
    return c;
  };

  // value -> a clean webhook URL, or throws an Error saying what is wrong.
  //   local:  http(s)://<host>[:port]/api/webhook/<id> (a bare host gets http:// in front)
  //   remote: https://<host>/api/webhook/<id>, or a Nabu Casa cloudhook https://hooks.nabu.casa/<id>
  HA.parseWebhook = function (value, which) {
    var v = String(value || '').trim().replace(/\/+$/, '');
    if (!v) throw new Error('Enter the webhook URL');
    if (which === 'local' && !/^[a-z]+:\/\//i.test(v)) v = 'http://' + v;
    var m = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?(\/[^?#\s]*)?$/i.exec(v);
    if (!m) throw new Error('That isn\'t a web address. It looks like http://homeassistant.local:8123/api/webhook/…');
    var scheme = m[1].toLowerCase();
    var host = m[2].toLowerCase();
    var path = m[4] || '';
    if (which === 'remote' && scheme !== 'https') throw new Error('The remote webhook URL has to start with https://');
    var nabu = host === 'hooks.nabu.casa';
    if (nabu && which === 'local') throw new Error('That is a Nabu Casa address: use it as the remote webhook URL');
    var ok = nabu ? /^\/[A-Za-z0-9_-]{8,}$/.test(path) : /^\/api\/webhook\/[A-Za-z0-9_.-]{1,200}$/.test(path);
    if (!ok) {
      throw new Error(nabu ? 'That isn\'t a whole Nabu Casa webhook URL' : 'A webhook URL ends in /api/webhook/ and the webhook id');
    }
    return scheme + '://' + host + (m[3] || '') + path;
  };

  // Shown in Settings: the host only, never the id (anyone with it can trigger the hook).
  HA.mask = function (url) {
    var m = /^https?:\/\/([^/]+)\//.exec(url || '');
    return m ? m[1] : '';
  };

  // ---- Routes ------------------------------------------------------------------------------------

  // The routes to try, in order. The TV: local first (unless the remote one worked last time, in the
  // last 10 minutes), then remote. A browser: an https page can only call the remote (https) one.
  HA.routes = function (cfg, memo, now, isWeb) {
    if (isWeb) return cfg.remoteUrl ? ['remote'] : [];
    var list = [];
    if (cfg.localUrl) list.push('local');
    if (cfg.remoteUrl) list.push('remote');
    if (list.length === 2 && memo && memo.route === 'remote' && memo.until > now) list.reverse();
    return list;
  };

  HA.usable = function (cfg, isWeb) { return HA.routes(cfg, null, 0, isWeb).length > 0; };

  // A playback event as form fields Home Assistant's webhook trigger reads as trigger.data.<field>
  // (all strings), plus the whole event as JSON in "payload" (trigger.data.payload | from_json).
  HA.formBody = function (ev) {
    var it = ev.item || {};
    var f = {
      source: 'plexlite', event: ev.event, at: ev.at, position_ms: ev.positionMs,
      kind: it.kind, type: it.type, title: it.title, show_title: it.showTitle, season: it.season, episode: it.episode,
      year: it.year, duration_ms: it.durationMs, content_rating: it.contentRating, genres: (it.genres || []).join(', '),
      is_kids: it.isKids ? 'true' : 'false', channel: it.channel, live_category: it.liveCategory,
      payload: JSON.stringify(ev),
    };
    return Object.keys(f).filter(function (k) { return f[k] != null && f[k] !== ''; }).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(String(f[k]));
    }).join('&');
  };

  // One POST. Resolves once a server answered; rejects on no answer (or none within timeoutMs).
  HA.post = function (url, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function (fn, v) { if (!done) { done = true; clearTimeout(timer); fn(v); } };
      var timer = setTimeout(function () { finish(reject, new Error('no answer')); }, timeoutMs);
      var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (typeof fetch === 'function') {
        // no-cors: the answer can't be read (and needn't be); a network failure still rejects.
        // keepalive lets the last "stop" out while a browser tab closes.
        var opts = { method: 'POST', mode: 'no-cors', credentials: 'omit', headers: headers, body: body };
        if (PL.leaving) opts.keepalive = true;
        fetch(url, opts).then(function () { finish(resolve); }, function () { finish(reject, new Error('no answer')); });
        return;
      }
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', headers['Content-Type']);
      x.onload = function () { finish(resolve); };
      // without CORS on the answer an XHR can't tell "refused" from "sent": count it as not reached
      x.onerror = function () { finish(reject, new Error('no answer')); };
      x.send(body);
    });
  };

  // Tries the routes in order; resolves {route}. memo ({route, until}) is updated in place.
  HA.deliver = function (cfg, ev, memo, deps) {
    deps = deps || {};
    var post = deps.post || HA.post;
    var now = deps.now ? deps.now() : Date.now();
    var isWeb = deps.isWeb != null ? deps.isWeb : !!PL.isWeb;
    var routes = HA.routes(cfg, memo, now, isWeb);
    if (!routes.length) return Promise.reject(new Error(isWeb ? 'Add a remote webhook URL to use this in a browser' : 'Not set up'));
    var body = HA.formBody(ev);
    var attempt = function (i) {
      var route = routes[i];
      var url = route === 'local' ? cfg.localUrl : cfg.remoteUrl;
      var timeout = route === 'local' && i < routes.length - 1 ? HA.LOCAL_TIMEOUT_MS : HA.TIMEOUT_MS;
      return post(url, body, timeout).then(function () {
        memo.route = route;
        memo.until = (deps.now ? deps.now() : Date.now()) + HA.REMEMBER_MS;
        return { route: route };
      }, function () {
        if (i + 1 < routes.length) return attempt(i + 1);
        memo.route = null;
        throw new Error(routes.length > 1 ? 'No answer, local or remote' : 'No answer from Home Assistant');
      });
    };
    return attempt(0);
  };

  // ---- Movie mode: which events go out ------------------------------------------------------------

  // deps: {config() -> cfg, send(ev) -> Promise, hidden() -> bool, setTimeout, clearTimeout}
  // Sends "play"/"resume" when matching content starts and the lights aren't down already, and
  // "pause"/"stop"/"ended" (after the delay) when they are. A start within the delay cancels the
  // pending one: nothing at all goes out, so a quick pause or the next episode doesn't flash the lights.
  HA.MovieMode = function (deps) {
    this.deps = deps;
    this.dimmed = false;
    this.pending = null; // {ev, timer}
  };

  HA.MovieMode.prototype.matches = function (cfg, item) {
    var t = HA.TRIGGERS.filter(function (x) { return x.id === cfg.trigger; })[0];
    return !!t && !!item && t.types.indexOf(item.type) !== -1;
  };

  HA.MovieMode.prototype.flush = function () {
    var p = this.pending;
    if (!p) return;
    this.pending = null;
    (this.deps.clearTimeout || clearTimeout)(p.timer);
    this.dimmed = false;
    this.deps.send(p.ev);
  };

  HA.MovieMode.prototype.onEvent = function (ev) {
    var d = this.deps;
    var cfg = d.config();
    // switched off while the lights are down: they still come back up
    if (!cfg.movieMode && !(this.dimmed && END.indexOf(ev.event) !== -1)) return;
    var self = this;
    if (START.indexOf(ev.event) !== -1) {
      if (!this.matches(cfg, ev.item)) return; // a pending restore carries on
      if (this.pending) {
        (d.clearTimeout || clearTimeout)(this.pending.timer);
        this.pending = null;
        return; // the lights never came back up: nothing to do
      }
      if (this.dimmed) return;
      this.dimmed = true;
      d.send(ev);
      return;
    }
    if (END.indexOf(ev.event) === -1 || !this.dimmed) return;
    if (this.pending) {
      // a stop after a pause: the stop is what goes out, when the pause's wait is over
      this.pending.ev = ev;
      if (d.hidden && d.hidden()) this.flush();
      return;
    }
    var wait = cfg.delaySec * 1000;
    this.pending = { ev: ev, timer: null };
    if (!wait || (d.hidden && d.hidden())) {
      this.flush();
      return;
    }
    this.pending.timer = (d.setTimeout || setTimeout)(function () { self.flush(); }, wait);
  };

  // ---- The plugin ----------------------------------------------------------------------------------

  function clock(at) {
    var t = new Date(at);
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return two(t.getHours()) + ':' + two(t.getMinutes());
  }

  HA.lastSentLine = function (st) {
    return st && st.last ? st.last.event + ' · ' + clock(st.last.at) + ' · ' + st.last.route : '';
  };

  var memo = { route: null, until: 0 };
  HA._memo = memo;
  var plugCtx = null;

  function status(ctx) { return ctx.storage.get('status', null) || {}; }

  function send(ctx, ev) {
    var cfg = HA.config(ctx);
    var out = {};
    Object.keys(ev).forEach(function (k) { out[k] = ev[k]; });
    out.source = 'plexlite';
    return HA.deliver(cfg, out, memo).then(function (r) {
      var st = status(ctx);
      st.last = { event: ev.event, at: Date.now(), route: r.route };
      ctx.storage.set('status', st);
      return r;
    }, function (err) {
      // during playback: logged and kept for the settings page, never shown over the picture
      var st = status(ctx);
      st.error = { message: err.message, at: Date.now() };
      ctx.storage.set('status', st);
      ctx.warn('could not send ' + ev.event + ': ' + err.message);
      throw err;
    });
  }

  var mode = new HA.MovieMode({
    config: function () { return plugCtx ? HA.config(plugCtx) : { movieMode: false }; },
    send: function (ev) { if (plugCtx) send(plugCtx, ev).then(null, function () {}); },
    hidden: function () { return !!PL.leaving || (typeof document !== 'undefined' && !!document.hidden); },
  });
  HA._mode = mode;

  function refresh(ctx) { if (ctx.refreshSettings) ctx.refreshSettings(); }

  function reopen(ctx, focus) {
    refresh(ctx);
    // after the sheet or text entry that called us has closed
    setTimeout(function () { openPage(ctx, focus); }, 0);
  }

  function editUrl(ctx, which, focus) {
    var cfg = HA.config(ctx);
    var local = which === 'local';
    ctx.textEntry(local ? 'Local webhook URL' : 'Remote webhook URL (optional)', local ? cfg.localUrl : cfg.remoteUrl,
      local ? 'e.g. http://homeassistant.local:8123/api/webhook/…' : 'e.g. https://hooks.nabu.casa/… · empty for none',
      function (value) {
        var change = {};
        if (!String(value || '').trim()) {
          change[local ? 'localUrl' : 'remoteUrl'] = '';
        } else {
          try { change[local ? 'localUrl' : 'remoteUrl'] = HA.parseWebhook(value, which); } catch (e) { ctx.toast(e.message, 5000); return false; }
        }
        HA.save(ctx, change);
        memo.route = null;
        reopen(ctx, focus);
        return true;
      });
  }

  function choose(ctx, heading, options, current, apply, focus) {
    ctx.sheet([{
      heading: heading,
      rows: options.map(function (o) {
        return { label: o.label, checked: o.id === current, action: function () { apply(o.id); reopen(ctx, focus); } };
      }),
    }]);
  }

  function delayLabel(s) { return s ? s + ' seconds' : 'At once'; }

  function sendTest(ctx) {
    var ev = { event: 'test', at: Date.now(), item: { type: 'movie', kind: 'movie', title: 'Plex Lite test', genres: [], isKids: false }, positionMs: 0 };
    ctx.toast('Sending a test to Home Assistant…');
    send(ctx, ev).then(function (r) {
      ctx.toast('Home Assistant answered (' + r.route + '). Check that your automation ran.', 5000);
      refresh(ctx);
    }, function (err) {
      ctx.toast(err.message, 5000);
      refresh(ctx);
    });
  }

  function openPage(ctx, focus) {
    var cfg = HA.config(ctx);
    var st = status(ctx);
    var rows = [];
    var i = function () { return rows.length; };
    if (PL.isWeb && !cfg.remoteUrl) {
      // a browser (an https page) can't call Home Assistant on the local network
      rows.push({ label: 'Add a remote webhook URL', sub: 'To use this in a browser', action: function () { editUrl(ctx, 'remote', 0); } });
    }
    var at = i();
    rows.push({ label: 'Local webhook URL', sub: cfg.localUrl ? HA.mask(cfg.localUrl) : 'Not set', action: function () { editUrl(ctx, 'local', at); } });
    var ar = i();
    rows.push({ label: 'Remote webhook URL', sub: cfg.remoteUrl ? HA.mask(cfg.remoteUrl) : 'Optional', action: function () { editUrl(ctx, 'remote', ar); } });
    var am = i();
    rows.push({
      label: 'Movie mode', sub: cfg.movieMode ? 'On' : 'Off',
      checked: cfg.movieMode, action: function () { HA.save(ctx, { movieMode: !cfg.movieMode }); reopen(ctx, am); },
    });
    var aw = i();
    var trig = HA.TRIGGERS.filter(function (t) { return t.id === cfg.trigger; })[0];
    rows.push({
      label: 'Dim the lights for', sub: trig.label,
      action: function () { choose(ctx, 'Dim the lights for', HA.TRIGGERS, cfg.trigger, function (id) { HA.save(ctx, { trigger: id }); }, aw); },
    });
    var ad = i();
    rows.push({
      label: 'Lights up after a pause', sub: delayLabel(cfg.delaySec),
      action: function () {
        choose(ctx, 'Lights up again after a pause', HA.DELAYS.map(function (s) { return { id: s, label: delayLabel(s) }; }), cfg.delaySec,
          function (s) { HA.save(ctx, { delaySec: s }); }, ad);
      },
    });
    rows.push({ label: 'Send a test', action: function () { if (HA.usable(cfg, PL.isWeb)) sendTest(ctx); else ctx.toast(PL.isWeb ? 'Add a remote webhook URL first' : 'Add the local webhook URL first'); } });
    if (st.last) rows.push({ label: 'Last sent', sub: HA.lastSentLine(st), action: function () {} });
    if (st.error) rows.push({ label: 'Last error', sub: st.error.message + ' · ' + clock(st.error.at), action: function () {} });
    ctx.sheet([{ heading: 'Home Assistant', rows: rows }], { focus: focus || 0 });
  }

  HA.settingsValue = function (cfg, isWeb) {
    if (!cfg.localUrl && !cfg.remoteUrl) return 'Not set up';
    if (isWeb && !cfg.remoteUrl) return 'Needs a remote URL';
    return cfg.movieMode ? 'Movie mode on' : 'Movie mode off';
  };

  PL.plugins.register({
    id: 'home-assistant',
    name: 'Home Assistant',
    version: '1.0.0',
    apiVersion: 1,
    description: 'Movie mode: tells Home Assistant when something plays, pauses or stops, so it can dim the lights.',
    settingsRows: function (ctx) {
      plugCtx = ctx;
      return [{ label: 'Home Assistant', value: HA.settingsValue(HA.config(ctx), PL.isWeb), action: function () { openPage(ctx); } }];
    },
    onPlayback: function (ev, ctx) {
      plugCtx = ctx;
      mode.onEvent(ev);
    },
  });
})();
