// Settings on a phone or tablet (docs/WEB.md, "Phones and tablets"): the profile picture at the top
// right of every tab opens it. It is a stack of sheets, not a page: who's signed in and Switch
// profile, the libraries and plugin tabs that have no tab of their own, the server, playback,
// Controls and the other browser settings, plugins (installed, the catalogue, Overseerr's web
// path), About and Sign out. Everything the TV's Settings offers in a browser, from the same shared
// code (PL.plex, PL.input, PL.web, PL.plugins, PL.pluginHost, PL.pluginStore).
//
// Plugins and parts of the web layer open the TV's own sheets and text entry (PL.screens.sheet,
// PL.screens.textEntry, PL.web.info) and close them with PL.app.pop(). While the layer shows, those
// open here as touch sheets instead (see "The stage's sheets, as touch sheets" below), so a plugin's
// settings, the consent sheet and Overseerr's explanations work without the TV stage.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  const PL = window.PL = window.PL || {};

  // ---- Pure decisions (test/touch-settings.test.mjs) -------------------------------------------------

  const KIND = {
    'lan-http': 'Local network', lan: 'Local network', remote: 'Remote Access', relay: 'Plex relay',
    'manual-local': 'Your local address', 'manual-remote': 'Your server address',
  };
  const KIND_LINE = {
    'lan-http': 'Connected over your local network', lan: 'Connected over your local network',
    remote: 'Connected through Plex Remote Access', relay: 'Connected through the Plex relay (slower, limited quality)',
    'manual-local': 'Connected to the address you set', 'manual-remote': 'Connected to the address you set',
  };
  const CONTROL_LABEL = { auto: 'Automatic', touch: 'Touch', pointer: 'Mouse & keyboard', remote: 'Remote' };
  const CONTROLS = [
    { id: 'auto', sub: 'Follows what you use: touch, or a mouse and keyboard' },
    { id: 'touch', sub: 'This layout, made for phones and tablets' },
    { id: 'pointer', sub: 'Hover, right-click and keyboard shortcuts' },
    { id: 'remote', sub: 'The TV layout, for a remote or a D-pad' },
  ];
  const STATE_TEXT = { 'not-installed': 'Not installed', installed: 'Installed', connected: 'Connected' };

  const hostOf = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');

  PL.touchSettingsLogic = {
    // how the server is reached: 'Local network', 'Remote Access', 'Plex relay', ...
    connection: (kind) => KIND[kind] || 'Unknown',
    connectionLine: (kind) => KIND_LINE[kind] || 'Not connected',

    // Settings -> Controls: the row's value, and each choice with what it does on this screen.
    // env: {width, detected, wanted(env) (PL.touchLogic.wanted)}
    controlsValue: (setting, mode) => (setting === 'auto' ? 'Automatic (' + (CONTROL_LABEL[mode] || 'Touch') + ')' : CONTROL_LABEL[setting] || 'Automatic'),
    controls: (setting, env) => CONTROLS.map((c) => {
      const tv = env && env.wanted ? !env.wanted({ width: env.width, setting: c.id, detected: env.detected }) : c.id === 'remote';
      return { id: c.id, label: CONTROL_LABEL[c.id], sub: c.sub + (tv ? ' · switches to the TV layout' : ''), checked: setting === c.id, tv };
    }),

    // An installed (sandboxed) plugin's state, as the TV's Settings words it.
    // p: PL.pluginHost.list() entry; enabled: PL.plugins.isEnabled(id); asked: it has a grant record
    externalValue: (p, enabled, asked) => (p.disabled ? 'Error'
      : !p.active ? (asked ? 'Needs permission' : 'Off')
      : enabled ? (p.holdsToken ? 'On · Plex sign-in' : 'On') : 'Off'),

    // A catalogue entry's row. st: PL.pluginStore.state(entry). Service plugins can't run in a browser.
    catalogueRow: (e, st, isWeb) => {
      if (isWeb && e.kind === 'service') return { tvOnly: true, sub: 'TV app only' };
      const sub = !e.compatible && st.state === 'not-installed' ? e.needs
        : st.state === 'update-available' ? 'Update to ' + e.version : STATE_TEXT[st.state] || '';
      return { tvOnly: false, sub: st.busy ? 'Installing…' : sub };
    },

    // What an entry's sheet offers, in order: [{id: 'needs'|'install'|'update'|'connect'|'manage'|'remove', label, sub}]
    entryActions: (e, st) => {
      const out = [];
      if (st.busy) return [{ id: 'busy', label: 'Installing…' }];
      if (!e.compatible && st.state === 'not-installed') out.push({ id: 'needs', label: e.needs || 'Not compatible' });
      else if (st.state === 'not-installed') out.push({ id: 'install', label: 'Install', sub: e.kind === 'service' ? 'Also installs a background service' : '' });
      else if (st.state === 'update-available') out.push({ id: 'update', label: 'Update to ' + e.version, sub: e.kind === 'service' ? 'Also installs a background service' : '' });
      else if (st.state === 'installed') out.push({ id: 'connect', label: 'Connect…', sub: 'Asks for its permissions, then turns it on' });
      else out.push({ id: 'manage', label: 'Manage' });
      if (st.installed) out.push({ id: 'remove', label: 'Remove' });
      return out;
    },

    // "1.0.0 · Author", or "0.9.0 → 1.0.0 · Author" when an update is waiting
    entryLine: (e, st) => [(st.installed && st.installed.version !== e.version ? st.installed.version + ' → ' : '') + e.version, e.author]
      .filter(Boolean).join(' · '),

    // Plex Home profiles as rows. current: the active profile's uuid (none: the account owner)
    profiles: (users, current) => (users || []).map((u) => ({
      user: u,
      label: u.title || u.username || 'Profile',
      sub: u.protected ? 'PIN · not supported yet' : u.admin ? 'Owner' : u.restricted ? 'Managed' : '',
      checked: current ? u.uuid === current : !!u.admin,
      locked: !!u.protected,
    })),

    // Text entry: the keyboard for an address, else plain text
    inputType: (title, placeholder, initial) => (/address|url|server/i.test(String(title || '')) || /^\s*e\.g\.\s*https?:|^https?:/i.test(String(placeholder || ''))
      || /^https?:\/\//i.test(String(initial || '')) ? 'url' : 'text'),

    // A text sheet above the on-screen keyboard. iOS (and Chrome on Android by default) lay the
    // keyboard over the page without resizing it, so a sheet fixed to the bottom would sit under it.
    // env: {layoutH (documentElement.clientHeight), vvH, vvTop (visualViewport), tablet}
    // -> null (no keyboard) | {bottom} (phone: the sheet's bottom edge) | {top} (tablet: the card's
    // centre), with maxHeight.
    keyboardFit: (env) => {
      const hidden = Math.round(env.layoutH - env.vvH - env.vvTop);
      if (!(hidden > 80)) return null;
      const maxHeight = Math.max(160, Math.round(env.vvH - 16));
      return env.tablet ? { top: Math.round(env.vvTop + env.vvH / 2), maxHeight } : { bottom: hidden, maxHeight };
    },

    // Overseerr on the web: this page's site and Overseerr's (siteOf: seerr-web.js W.siteOf)
    sameSite: (pageHost, url, siteOf) => {
      const mine = siteOf(pageHost);
      const theirs = url ? siteOf(hostOf(url)) : null;
      return { mine, theirs, same: !!theirs && mine === theirs };
    },
  };

  if (!PL.isWeb || !PL.touch || !PL.touch.ui || !PL.app || !PL.screens) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const app = PL.app;
  const S = PL.touchSettingsLogic;
  const REPO = 'https://github.com/Obednal97/plex-lite';

  const openUrl = (url) => { try { window.open(url, '_blank', 'noopener'); } catch (e) { /* blocked */ } };

  // ---- Sheets of rows that repaint in place --------------------------------------------------------------

  // Every open list sheet; a change anywhere repaints them all (a toggle, a sign-in, an install).
  const live = [];
  const refreshAll = () => live.slice().forEach((s) => s.refresh());
  T.onProfile(() => refreshAll());

  function avatar(p, cls) {
    const n = h('span.' + cls);
    if (p && p.thumb) n.appendChild(ui.img(p.thumb, null, true));
    else n.appendChild(h('span', { text: ((p && p.title) || '?').slice(0, 1).toUpperCase() }));
    return n;
  }

  // r: {label, sub, value, icon, avatar, checked, toggle, next, link, danger, tone, close, action}.
  // No action and no toggle: a line of information. close: the sheet closes before the action runs.
  function row(r, sheet) {
    const still = !r.action;
    const n = h((still ? 'div' : 'button') + '.t-sheet-row' + (r.checked ? '.on' : '') + (r.danger ? '.t-danger' : '')
      + (still ? '.ts-static' : '') + (r.tone ? '.ts-' + r.tone : ''), still ? null : { type: 'button' });
    if (r.avatar) n.appendChild(avatar(r.avatar, 'ts-row-avatar'));
    else if (r.icon) n.appendChild(ui.icon(r.icon, 't-sheet-icon'));
    const text = h('span.t-sheet-text', null, h('span.t-sheet-label', { text: r.label }));
    if (r.sub) text.appendChild(h('span.t-sheet-rowsub', { text: r.sub }));
    n.appendChild(text);
    if (r.value) n.appendChild(h('span.t-sheet-value', { text: r.value }));
    if (r.toggle != null) {
      n.setAttribute('role', 'switch');
      n.setAttribute('aria-checked', String(!!r.toggle));
      n.appendChild(h('span.ts-switch' + (r.toggle ? '.on' : ''), null, h('span.ts-knob')));
    } else if (r.checked) {
      n.appendChild(ui.icon('check', 't-sheet-tick'));
    } else if (r.link) {
      n.appendChild(ui.icon('external', 't-sheet-next'));
    } else if (r.next) {
      n.appendChild(ui.icon('chevron', 't-sheet-next'));
    }
    if (r.checked != null && r.toggle == null && !still) {
      n.setAttribute('role', 'menuitemradio');
      n.setAttribute('aria-checked', String(!!r.checked));
    }
    if (!still) {
      n.addEventListener('click', () => {
        if (r.close && sheet.entry) sheet.entry.close(() => r.action(n));
        else r.action(n);
      });
    }
    return n;
  }

  // model: {top: node, intro, sections: [{heading, rows, note}], buttons: [ui.button opts]}
  function render(model, sheet) {
    const out = [];
    if (model.intro) out.push(h('p.ts-intro', { text: model.intro }));
    if (model.top) out.push(model.top);
    (model.sections || []).forEach((sec) => {
      const rows = sec ? (sec.rows || []).filter(Boolean) : [];
      if (!rows.length && !(sec && sec.note)) return;
      if (sec.heading) out.push(h('div.t-sheet-heading' + (sec.heading.length > 26 ? '.ts-heading-long' : ''), { text: sec.heading }));
      if (rows.length) {
        const list = h('div.t-sheet-list');
        rows.forEach((r) => list.appendChild(row(r, sheet)));
        out.push(list);
      }
      if (sec.note) out.push(h('p.ts-note', { text: sec.note }));
    });
    if (model.buttons && model.buttons.length) {
      const b = h('div.ts-buttons');
      model.buttons.forEach((x) => b.appendChild(ui.button(x)));
      out.push(b);
    }
    return out;
  }

  // opts: {title, build() -> model, cls, onClose, still (not repainted by refreshAll: a text field
  // keeps its focus and keyboard)}. Returns {entry, refresh(), close(then)}.
  function listSheet(opts) {
    const wrap = h('div.ts-body');
    const nested = T.sheets.count() > 0;
    const sheet = { entry: null, opts };
    sheet.refresh = () => {
      if (sheet.entry && sheet.entry.closing) return;
      // keep the scroll position across a repaint
      const body = sheet.entry && sheet.entry.body;
      const y = body ? body.scrollTop : 0;
      wrap.replaceChildren(...render(opts.build(), sheet));
      if (body) body.scrollTop = y;
    };
    sheet.close = (then) => { if (sheet.entry) sheet.entry.close(then); };
    sheet.refresh();
    sheet.entry = T.sheet({
      title: opts.title,
      content: wrap,
      cls: 'ts-sheet' + (nested ? '.ts-nested' : '') + (opts.cls ? '.' + opts.cls : ''),
      onClose: () => {
        const i = live.indexOf(sheet);
        if (i >= 0) live.splice(i, 1);
        if (opts.onClose) opts.onClose();
      },
    });
    if (!opts.still) live.push(sheet);
    // a sheet on top of another has a Back chevron (Back, a tap outside or a drag also close it)
    const head = sheet.entry.card.querySelector('.t-sheet-head');
    if (head) {
      head.classList.add('ts-head');
      if (nested) {
        const back = ui.button({ kind: 'round', icon: 'back', label: 'Back', action: () => sheet.close() });
        // the heading is also the sheet's drag handle (sheets.js), which captures the pointer: not here
        back.addEventListener('pointerdown', (e) => e.stopPropagation());
        head.insertBefore(back, head.firstChild);
      }
    }
    return sheet;
  }

  // A text field with the system keyboard. opts: {title, intro, value, placeholder, type, saveLabel,
  // onSave(value, {say(text, bad), close()}), sections (rows under the field)}
  function textSheet(opts) {
    const type = opts.type || 'url';
    const input = h('input.ts-input', {
      type, placeholder: opts.placeholder || '', autocomplete: 'off', 'aria-label': opts.title,
    });
    input.value = opts.value || '';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', type === 'url' ? 'none' : 'sentences');
    input.setAttribute('autocorrect', type === 'url' ? 'off' : 'on');
    input.setAttribute('enterkeyhint', 'done');
    if (type === 'url') input.setAttribute('inputmode', 'url');
    const msg = h('div.ts-msg', { role: 'status', 'aria-live': 'polite' });
    const say = (text, bad) => { msg.textContent = text || ''; msg.classList.toggle('ts-bad', !!bad); };
    let sheet = null;
    const api = { say, close: () => { input.blur(); sheet.close(); } };
    const save = () => opts.onSave(input.value, api);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); save(); }
    });
    const field = h('div.ts-field', null, [input, msg]);
    const buttons = [
      { label: opts.saveLabel || 'Save', kind: 'primary', action: save },
      { label: 'Cancel', kind: 'glass', action: () => api.close() },
    ];
    // the app's toasts (a plugin's "That isn't an address") would sit under the keyboard: repeat them here
    // (only the toast itself is watched: this sheet's own message line changing mustn't wake it)
    let lastToast = null;
    let watchedToast = null;
    const toastWatch = new MutationObserver(() => {
      const t = document.querySelector('body > .toast');
      if (t && t !== watchedToast) {
        watchedToast = t;
        toastWatch.observe(t, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      }
      const text = t && t.classList.contains('show') ? t.textContent : '';
      if (!text || text === lastToast) return;
      lastToast = text;
      say(text, /n't|not|no |must|error|fail|use an/i.test(text));
    });
    sheet = listSheet({
      title: opts.title,
      cls: 'ts-text',
      still: true,
      build: () => ({ intro: opts.intro, top: field, buttons, sections: opts.sections ? opts.sections() : [] }),
      onClose: () => { toastWatch.disconnect(); if (opts.onClose) opts.onClose(); },
    });
    toastWatch.observe(document.body, { childList: true });
    watchedToast = document.querySelector('body > .toast');
    if (watchedToast) {
      lastToast = watchedToast.classList.contains('show') ? watchedToast.textContent : null;
      toastWatch.observe(watchedToast, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    // keep the field and its buttons above the on-screen keyboard
    const vv = window.visualViewport;
    if (vv) {
      const card = sheet.entry.card;
      const fit = () => {
        const f = S.keyboardFit({
          layoutH: document.documentElement.clientHeight, vvH: vv.height, vvTop: vv.offsetTop,
          tablet: document.documentElement.classList.contains('t-tablet'),
        });
        card.classList.toggle('ts-kb', !!f);
        card.style.bottom = f && f.bottom != null ? f.bottom + 'px' : '';
        card.style.top = f && f.top != null ? f.top + 'px' : '';
        card.style.maxHeight = f ? f.maxHeight + 'px' : '';
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
      const prev = sheet.opts.onClose;
      sheet.opts.onClose = () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); if (prev) prev(); };
    }
    // straight away, inside the tap that opened it, so the keyboard comes up (iOS needs that)
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    if (input.value && type === 'url') { try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* type=url */ } }
    sheet.input = input;
    sheet.say = say;
    return sheet;
  }

  // ---- The stage's sheets, as touch sheets ----------------------------------------------------------------

  // Plugins (ctx.sheet, ctx.textEntry, the consent sheet in js/plugin-host.js), the Controls row
  // (web/web-input.js) and the explanations in web/web.js (PL.web.info) push the TV's sheet and text
  // entry onto the stage, and close them with PL.app.pop(). While the layer shows, they open here
  // instead: PL.screens.sheet / textEntry return a stand-in that app.push opens as a touch sheet, and
  // PL.app.pop() closes the newest of those sheets. Anything else (and anything while a stage screen
  // is open, like the player) goes through untouched.
  const bridged = [];
  const bridging = () => !!(T.visible && app.stack.length === 1 && app.stack[0] && app.stack[0].touchStandIn);
  const standIn = (open) => ({ el: h('div'), touchBridge: open });
  const track = (s) => {
    bridged.push(s);
    const prev = s.opts.onClose;
    s.opts.onClose = () => {
      const i = bridged.indexOf(s);
      if (i >= 0) bridged.splice(i, 1);
      if (prev) prev();
    };
    return s;
  };

  // sections: [{heading, rows: [{label, sub, checked, action}]}]; opts: {closeOnSelect (true)}
  function stageSheet(sections, opts) {
    const keep = opts.closeOnSelect === false;
    const list = sections || [];
    const title = (list[0] && list[0].heading) || '';
    return track(listSheet({
      title: title || null,
      build: () => ({
        sections: list.map((sec, i) => ({
          heading: i === 0 ? '' : sec.heading,
          rows: (sec.rows || []).map((r) => ({
            label: r.label, sub: r.sub, checked: r.checked ? true : undefined, close: !keep,
            tone: /^Sensitive/.test(r.sub || '') ? 'sensitive' : null,
            action: () => { if (r.action) r.action(); },
          })),
        })),
      }),
    }));
  }

  function stageText(title, initial, placeholder, onDone) {
    return track(textSheet({
      title, value: initial,
      placeholder: String(placeholder || '').replace(/ · .*$/, ''),
      intro: / · /.test(placeholder || '') ? String(placeholder).replace(/^.* · /, '').replace(/^./, (c) => c.toUpperCase()) : null,
      type: S.inputType(title, placeholder, initial),
      onSave: (value, sheet) => { if (onDone(value) !== false) sheet.close(); },
    }));
  }

  // web/web.js's explanation card: [[label, text]] lines, Done, and extra buttons
  function infoSheet(heading, lines, extra) {
    let s = null;
    s = track(listSheet({
      title: heading,
      build: () => ({
        sections: [{ rows: (lines || []).map((l) => ({ label: l[0], sub: l[1] })) }],
        buttons: [{ label: 'Done', kind: 'primary', action: () => s.close() }]
          .concat((extra || []).map((x) => ({ label: x.label, kind: 'glass', action: () => x.action() }))),
      }),
    }));
    return s;
  }

  const realSheet = PL.screens.sheet;
  const realText = PL.screens.textEntry;
  PL.screens.sheet = function (sections, opts) {
    if (!bridging()) return realSheet.apply(this, arguments);
    return standIn(() => stageSheet(sections, opts || {}));
  };
  PL.screens.textEntry = function (title, initial, placeholder, onDone) {
    if (!bridging()) return realText.apply(this, arguments);
    return standIn(() => stageText(title, initial, placeholder, onDone));
  };
  const realPush = app.push;
  const realPop = app.pop;
  app.push = function (screen) {
    if (screen && screen.touchBridge) { screen.touchBridge(); return undefined; }
    return realPush.apply(this, arguments);
  };
  app.pop = function () {
    if (bridged.length && bridging()) { bridged[bridged.length - 1].close(); return true; }
    return realPop.apply(this, arguments);
  };
  if (PL.web && PL.web.info) {
    const realInfo = PL.web.info;
    PL.web.info = function (heading, lines, extra) {
      if (!bridging()) return realInfo.apply(this, arguments);
      infoSheet(heading, lines, extra);
      return undefined;
    };
  }

  // ---- Profile ---------------------------------------------------------------------------------------

  let homeUsers = null; // the last list seen, for the Switch profile row

  function profileCard() {
    const p = T.profile || {};
    const saved = PL.storage.get('profile', null);
    return h('div.ts-profile', null, [
      avatar(p, 'ts-profile-pic'),
      h('div.ts-profile-text', null, [
        h('div.ts-profile-name', { text: p.title || (saved && saved.title) || 'Plex account' }),
        h('div.ts-profile-sub', { text: saved ? 'Plex Home profile' : 'Account owner' }),
      ]),
    ]);
  }

  function profilesSheet() {
    let users = null;
    let err = null;
    const s = listSheet({
      title: 'Who\'s watching?',
      build: () => {
        if (err) return { sections: [{ rows: [{ label: PL.errorMessage(err) }] }] };
        if (!users) return { top: ui.spinner() };
        if (users.length < 2) return { sections: [{ rows: [{ label: 'This Plex account has no other profiles' }] }] };
        const current = (PL.storage.get('profile', null) || {}).uuid;
        const rows = S.profiles(users, current).map((p) => ({
          label: p.label, sub: p.sub, checked: p.checked, tone: p.locked ? 'locked' : null,
          avatar: { thumb: p.user.thumb || null, title: p.label },
          action: () => switchTo(p.user, p.checked),
        }));
        return {
          sections: [{
            rows,
            note: users.some((u) => u.protected) ? 'PIN-protected profiles aren\'t supported yet (the TV app doesn\'t support them either).' : null,
          }],
        };
      },
    });
    PL.plex.homeUsers().then((list) => { users = list; homeUsers = list; s.refresh(); refreshAll(); }, (e) => { err = e; s.refresh(); });
  }

  function switchTo(u, current) {
    if (current) return;
    if (u.protected) { T.toast('PIN-protected profiles are not supported yet'); return; }
    T.toast('Switching to ' + u.title + '…');
    // as the TV: the new profile's token and server, then the app starts again (the layer rebuilds)
    PL.plex.switchUser(u).then(() => {
      T.sheets.closeAll();
      app.start();
    }, (err) => T.toast(PL.errorMessage(err)));
  }

  // ---- Server --------------------------------------------------------------------------------------------

  function connected(s) { T.toast('Connected to ' + s.name + ' (' + S.connection(s.kind) + ')'); }

  function reconnect() {
    T.toast('Finding your server…');
    PL.plex.ensureServer(true).then((s) => { connected(s); refreshAll(); }, (err) => { T.toast(PL.errorMessage(err), 5000); refreshAll(); });
  }

  function serverSheet() {
    let servers = null;
    const s = listSheet({
      title: 'Server',
      build: () => {
        const cur = PL.plex.server || {};
        const manual = PL.plex.manual();
        const pinned = !!(manual.local || manual.remote);
        const others = servers && servers.length > 1 ? servers.map((r) => ({
          label: r.name, sub: (r.owned ? 'Yours' : 'Shared with you') + (r.presence === false ? ' · offline' : ''),
          checked: r.clientIdentifier === cur.machineId, icon: 'tv',
          action: pinned || r.clientIdentifier === cur.machineId ? null : () => useServer(r),
        })) : [];
        return {
          intro: S.connectionLine(cur.kind),
          sections: [
            { rows: [
              { label: 'Server', value: cur.name || '—' },
              { label: 'Connection', value: S.connection(cur.kind) },
              { label: 'Find the server again', sub: 'Looks for the quickest way to reach it', icon: 'restart', action: reconnect },
            ] },
            { heading: 'Your servers', rows: others,
              note: others.length && pinned ? 'Your server address is tried first: set it back to Automatic to switch servers.' : null },
            { heading: 'Address', rows: [
              { label: 'Server address', value: manual.remote || 'Automatic', next: true, action: addressSheet },
            ], note: 'Optional: an https address Plex Lite tries before it finds your server by itself.' },
          ],
        };
      },
    });
    PL.plex.listServers().then((list) => { servers = list; s.refresh(); }, () => {});
  }

  function useServer(r) {
    T.toast('Connecting to ' + r.name + '…');
    PL.plex.connect(r).then((server) => {
      PL.plex.useServer(server);
      T.sheets.closeAll();
      // its libraries differ: start again, as after switching profile
      app.start();
    }, (err) => T.toast(PL.errorMessage(err), 5000));
  }

  // One address on the web (a browser can only use https), tried before discovery. Same checks as the TV.
  function addressSheet() {
    const which = 'remote';
    const current = PL.plex.manual()[which];
    const text = textSheet({
      title: 'Server address',
      intro: 'In a browser the address must start with https://. Plex Lite checks that it is your Plex server before it saves it.',
      value: current,
      placeholder: 'e.g. https://plex.example.com:32400',
      saveLabel: 'Check and save',
      onSave: (value, sheet) => {
        let uri;
        try { uri = PL.plex.normalizeUri(value); } catch (e) { sheet.say(e.message, true); return; }
        if (!uri) { saveAddress(which, ''); sheet.close(); return; }
        sheet.say('Checking ' + uri + '…');
        PL.plex.connectUri(uri, 'manual-' + which).then(() => {
          saveAddress(which, uri);
          sheet.close();
        }, (err) => sheet.say('No Plex server at that address (' + PL.errorMessage(err) + ')', true));
      },
      sections: () => [{ rows: [{
        label: 'Use automatic discovery', checked: !PL.plex.manual()[which],
        action: () => { saveAddress(which, ''); text.close(); },
      }] }],
    });
  }

  function saveAddress(which, uri) {
    const m = PL.plex.manual();
    m[which] = uri;
    PL.storage.set('manualServer', m);
    refreshAll();
    PL.plex.ensureServer(true).then((s) => { connected(s); refreshAll(); }, (err) => { T.toast(PL.errorMessage(err), 5000); refreshAll(); });
  }

  // ---- Controls and the browser ------------------------------------------------------------------------

  function controlsSheet() {
    listSheet({
      title: 'Controls',
      build: () => ({
        sections: [{
          rows: S.controls(PL.input.setting(), {
            width: document.documentElement.clientWidth || window.innerWidth, detected: PL.input.detected(), wanted: PL.touchLogic.wanted,
          }).map((c) => ({
            label: c.label, sub: c.sub, checked: c.checked, close: true,
            action: () => {
              PL.input.set(c.id);
              // Remote (or a mouse on a wide screen): the shell hands over to the TV layout
              if (c.tv) T.toast('TV layout. To come back: Settings → Controls', 5000);
              refreshAll();
            },
          })),
          note: 'Saved in this browser.',
        }],
      }),
    });
  }

  const fullscreenOk = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  document.addEventListener('fullscreenchange', refreshAll);
  document.addEventListener('webkitfullscreenchange', refreshAll);

  // ---- Plugins -----------------------------------------------------------------------------------------

  const store = () => PL.pluginStore;
  const host = () => PL.pluginHost;
  const pluginName = (id) => (PL.plugins.list().filter((p) => p.id === id)[0] || {}).name || id;

  // The stage's tab bar (used again if the window gets wide): plugins may add or remove tabs.
  function refreshTabs() {
    if (!app.tabs || !app.sections) return;
    const current = app.tabs.tabs[app.tabs.selected];
    app.buildTabs();
    const ids = app.tabs.tabs.map((t) => t.id);
    app.tabs.selected = Math.max(0, ids.indexOf(current && current.id));
    app.tabs.paint();
  }

  function pluginsSheet() {
    listSheet({
      title: 'Plugins',
      build: () => {
        const H = host();
        const bundled = PL.plugins.list().filter((p) => !p.external).map((p) => ({
          label: p.name, sub: p.description, toggle: p.enabled,
          action: () => {
            PL.plugins.setEnabled(p.id, !p.enabled);
            T.toast(p.name + (p.enabled ? ' turned off' : ' turned on'));
            refreshTabs();
            refreshAll();
          },
        }));
        const external = H && H.list && H.grants ? H.list().map((p) => ({
          label: p.title, sub: p.description, next: true,
          value: S.externalValue(p, PL.plugins.isEnabled(p.id), !!H.grants.get(p.id)),
          action: () => manageSheet(p.id),
        })) : [];
        const tvOnly = PL.plugins.unavailable.map((p) => ({ label: p.name, value: 'TV app only', next: true, action: () => PL.web.explainPlugin(p) }));
        const rows = bundled.concat(external, tvOnly);
        return {
          sections: [
            { heading: 'Installed', rows: rows.length ? rows : [{ label: 'No plugins yet' }] },
            { heading: 'More', rows: store() ? [{ label: 'Browse plugins', sub: 'The Plex Lite plugin catalogue', icon: 'grid', next: true, action: catalogueSheet }] : [] },
          ],
        };
      },
    });
  }

  // A sandboxed plugin: its permissions, connect (consent), its own settings, on/off, remove access, uninstall.
  function manageSheet(id) {
    const find = () => (host().list().filter((x) => x.id === id)[0]);
    const first = find();
    if (!first) return;
    listSheet({
      title: first.title + (first.version ? ' ' + first.version : ''),
      build: () => {
        const p = find();
        if (!p) return { sections: [{ rows: [{ label: 'Removed' }] }] };
        const perms = p.permissions.map((perm) => {
          const allowed = p.granted.indexOf(perm.id) !== -1;
          return { label: perm.text, sub: (perm.risk === 'high' ? 'Sensitive · ' : '') + (allowed ? 'Allowed' : 'Not allowed'), tone: perm.risk === 'high' ? 'sensitive' : null };
        });
        if (!perms.length) perms.push({ label: 'Needs no permissions' });
        const actions = [];
        if (!p.active) {
          actions.push({ label: 'Connect…', sub: 'Asks for its permissions, then turns it on', icon: 'plus', action: () => connectPlugin(p.id, p.title) });
        } else {
          const on = PL.plugins.isEnabled(p.id);
          if (on) actions.push({ label: 'Plugin settings', icon: 'gear', next: true, action: () => externalSettings(p) });
          actions.push({ label: 'On', toggle: on, action: () => { PL.plugins.setEnabled(p.id, !on); refreshTabs(); refreshAll(); } });
          actions.push({
            label: 'Remove access', sub: p.holdsToken ? 'Takes back your Plex sign-in' : 'It asks again before it runs',
            action: () => { host().revoke(p.id); T.toast(p.title + ': access removed'); refreshTabs(); refreshAll(); },
          });
        }
        if (store() && store().installed()[p.id]) {
          actions.push({ label: 'Uninstall', danger: true, action: () => confirmRemove(p.id, p.title) });
        }
        return { intro: p.description, sections: [{ heading: 'Permissions', rows: perms }, { rows: actions }] };
      },
    });
  }

  function externalSettings(p) {
    const def = host().definitions[p.id];
    if (!def || !def.settingsRows) { T.toast(p.title + ' has no settings'); return; }
    def.settingsRows().then((list) => {
      if (!list.length) { T.toast(p.title + ' has no settings'); return; }
      listSheet({ title: p.title, build: () => ({ sections: [{ rows: list.map((r) => ({ label: r.label, sub: r.value, close: true, action: () => r.action() })) }] }) });
    }, (err) => T.toast(PL.errorMessage(err)));
  }

  // Connect = consent (the host's own sheet, opened here as a touch sheet), then on, then its settings.
  function connectPlugin(id, name) {
    store().connect(id).then((on) => {
      refreshAll();
      if (!on) { T.toast(name + ' was not connected'); return; }
      T.toast(name + ' is connected');
      refreshTabs();
      refreshAll();
      const def = host().definitions[id];
      if (def && def.settingsRows) {
        def.settingsRows().then((list) => {
          if (list.length) listSheet({ title: name, build: () => ({ sections: [{ rows: list.map((r) => ({ label: r.label, sub: r.value, close: true, action: () => r.action() })) }] }) });
        }, () => {});
      }
    }, (err) => T.toast(PL.errorMessage(err)));
  }

  function installPlugin(e) {
    const p = store().install(e, (status) => T.toast(e.name + ': ' + status));
    refreshAll(); // "Installing…"
    p.then(() => {
      const H = host();
      const rt = H.runtimes[e.id];
      // an update that keeps all its grants is already running
      if (H.definitions[e.id] && rt && !H.grants.missing(e.id, rt.manifest, rt.hash).length) {
        T.toast(e.name + ' updated');
        refreshTabs();
        refreshAll();
        return;
      }
      refreshAll();
      connectPlugin(e.id, e.name);
    }, (err) => { T.toast(e.name + ': ' + PL.errorMessage(err), 5000); refreshAll(); });
  }

  function confirmRemove(id, name) {
    T.confirm('Remove ' + name + '?', 'Its code, permissions and saved data go from this browser.', 'Remove', true).then((yes) => {
      if (!yes) return;
      store().remove(id).then((ok) => {
        T.toast(ok ? name + ' removed' : name + ' removed (its service could not be uninstalled)');
        refreshTabs();
        refreshAll();
      });
    });
  }

  function catalogueSheet() {
    let cat = null;
    const load = () => {
      cat = null;
      s.refresh();
      store().loadCatalog().then((c) => { cat = c; s.refresh(); });
    };
    const s = listSheet({
      title: 'Browse plugins',
      build: () => {
        if (!cat) return { top: ui.spinner() };
        const st = store();
        const rows = cat.plugins.map((e) => {
          const c = S.catalogueRow(e, st.state(e), PL.isWeb);
          if (c.tvOnly) return { label: e.name, sub: e.description, value: 'TV app only', next: true, action: () => PL.web.explainPlugin({ name: e.name, reason: 'tv-service' }) };
          return { label: e.name, sub: c.sub, next: true, action: () => entrySheet(e) };
        });
        if (!rows.length) rows.push({ label: 'No plugins available', sub: cat.errors[0] || '' });
        const custom = st.catalogUrl() !== st.DEFAULT_URL;
        return {
          sections: [
            { rows },
            { heading: 'Catalogue', rows: [{ label: 'Catalogue address', sub: (custom ? st.catalogUrl() : 'Default') + ' · ' + cat.source, next: true, action: () => editCatalogUrl(load) }] },
          ],
        };
      },
    });
    load();
  }

  function editCatalogUrl(reload) {
    const st = store();
    textSheet({
      title: 'Catalogue address',
      value: st.catalogUrl() === st.DEFAULT_URL ? '' : st.catalogUrl(),
      placeholder: 'Leave empty for the default',
      onSave: (value, sheet) => {
        if (!st.setCatalogUrl(String(value || '').trim())) { sheet.say('Use an http(s) address', true); return; }
        T.toast('Catalogue address saved');
        sheet.close();
        reload();
      },
    });
  }

  // A catalogue entry: what it does, the permissions it asks for (sensitive ones marked), and what can
  // be done with it now.
  function entrySheet(e) {
    const parse = host()._internals.parsePermissions;
    listSheet({
      title: e.name,
      build: () => {
        const st = store().state(e);
        const perms = parse({ permissions: e.permissions }).list.map((perm) => ({
          label: perm.text, sub: perm.risk === 'high' ? 'Sensitive' : '', tone: perm.risk === 'high' ? 'sensitive' : null,
        }));
        if (!perms.length) perms.push({ label: 'Needs no permissions' });
        const act = {
          install: () => installPlugin(e),
          update: () => installPlugin(e),
          connect: () => connectPlugin(e.id, e.name),
          manage: () => manageSheet(e.id),
          remove: () => confirmRemove(e.id, e.name),
        };
        const ICON = { install: 'plus', update: 'restart', connect: 'plus', manage: 'gear' };
        const actions = S.entryActions(e, st).map((a) => ({
          label: a.label, sub: a.sub, icon: ICON[a.id], danger: a.id === 'remove', next: a.id === 'manage', action: act[a.id] || null,
        }));
        return {
          intro: [S.entryLine(e, st), e.description].filter(Boolean).join(' — '),
          sections: [{ heading: 'It can', rows: perms }, { rows: actions }],
        };
      },
    });
  }

  // Overseerr in a browser: what it needs (docs/OVERSEERR.md, "On the web") and how this page stands.
  function overseerrWebSheet() {
    const W = PL.overseerr.web;
    let s = null;
    s = listSheet({
      title: 'Overseerr on the web',
      build: () => {
        const cfg = PL.storage.get('plugin.overseerr.config', null);
        const url = cfg && cfg.url;
        const site = S.sameSite(location.host, url, W.siteOf);
        const problem = W.problem;
        return {
          intro: 'In a browser, Plex Lite calls your Overseerr straight from this page. The browser allows that only when both of these are true.',
          sections: [
            { rows: [
              { label: 'Plex Lite is on the same site as Overseerr', sub: 'A subdomain of the same domain, like plexlite.example.com next to overseerr.example.com: Overseerr keeps its sign-in in a SameSite=Lax cookie, which browsers only send back to pages on the same site' },
              { label: 'Overseerr\'s reverse proxy allows this page', sub: 'CORS for ' + location.origin + ' with credentials, and it answers the browser\'s preflight (OPTIONS) itself. Overseerr\'s CSRF protection stays off (the default)' },
            ] },
            { heading: 'Here', rows: [
              { label: 'This page', value: site.mine },
              url ? { label: 'Your Overseerr', value: site.theirs, sub: site.same ? 'Same site: the sign-in can work' : 'Another site: the browser won\'t keep Overseerr\'s sign-in', tone: site.same ? null : 'warn' }
                : { label: 'Your Overseerr', value: 'Not set up' },
              problem && problem.explain ? { label: problem.explain.title, sub: 'The last problem Plex Lite saw', tone: 'warn', next: true, action: () => W.explain(null, problem) } : null,
            ] },
            { rows: [
              { label: 'Not on plexlite.vercel.app', sub: 'No one\'s Overseerr is on that site: deploy your own copy on your own subdomain' },
              { label: 'Or use the TV app', sub: 'It talks to Overseerr directly and needs none of this' },
            ] },
          ],
          buttons: [
            { label: 'Done', kind: 'primary', action: () => s.close() },
            { label: 'Setup guide', kind: 'glass', icon: 'external', action: () => W.openGuide() },
          ],
        };
      },
    });
  }

  // ---- About, sign out ---------------------------------------------------------------------------------

  function aboutSheet() {
    listSheet({
      title: 'About',
      build: () => ({
        top: h('div.ts-about', null, [
          h('img.ts-about-mark', { src: 'web/touch/mark.svg', alt: '', draggable: false }),
          h('div.ts-about-name', null, ['Plex ', h('span', { text: 'Lite' })]),
          h('div.ts-about-ver', { text: 'Version ' + PL.VERSION }),
        ]),
        sections: [{ rows: [
          { label: 'Open source', sub: 'github.com/Obednal97/plex-lite', icon: 'external', link: true, action: () => openUrl(REPO) },
          { label: 'What\'s new', sub: 'The changelog', icon: 'sparkle', link: true, action: () => openUrl(REPO + '/blob/main/CHANGELOG.md') },
          { label: 'Licences', icon: 'info', next: true, action: licencesSheet },
        ], note: 'Plex is a trademark of Plex, Inc. Plex Lite is not affiliated with or endorsed by Plex.' }],
      }),
    });
  }

  function licencesSheet() {
    listSheet({
      title: 'Licences',
      build: () => ({
        sections: [
          { rows: [{ label: 'Plex Lite', sub: 'MIT licence', link: true, action: () => openUrl(REPO + '/blob/main/LICENSE') }] },
          { heading: 'Built with', rows: [
            { label: 'hls.js', sub: 'Apache-2.0 · video streaming in the browser' },
            { label: 'Phosphor Icons', sub: 'MIT · the TV layout\'s icons' },
            { label: 'TMDB', sub: 'Overseerr shows poster images from TMDB. This product uses TMDB images but is not endorsed or certified by TMDB' },
            { label: 'All third-party notices', link: true, action: () => openUrl(REPO + '/blob/main/THIRD-PARTY-NOTICES.md') },
          ] },
        ],
      }),
    });
  }

  function signOut() {
    T.confirm('Sign out of Plex?', 'This also clears Plex Lite\'s settings, favourites and plugins in this browser.', 'Sign out', true).then((yes) => {
      if (!yes) return;
      // as the web build's Settings: everything goes, and the page starts afresh
      PL.plex.signOut(true);
      location.reload();
    });
  }

  // ---- Opening things from Settings -----------------------------------------------------------------------

  function openLibrary(section) {
    T.push(T.screens.library ? T.screens.library(section) : T.stagePage(() => PL.screens.library(section)));
  }

  // A plugin tab is a TV screen (js/screens/plugin-screen.js): it shows on the stage until Back.
  function openPluginTab(t) {
    T.sheets.closeAll();
    app.push(PL.screens.pluginScreen({ plugin: t.plugin, tab: t.id }, { title: t.title }));
  }

  // ---- The first sheet -------------------------------------------------------------------------------------

  const stored = (label, key, dflt, sub) => ({
    label, sub, toggle: !!PL.storage.get(key, dflt),
    action: () => { PL.storage.set(key, !PL.storage.get(key, dflt)); refreshAll(); },
  });

  function mainModel() {
    const s = PL.plex.server || {};
    const more = (T.more || []).map((sec) => ({ label: sec.title, icon: sec.type === 'movie' ? 'film' : 'tv', next: true, action: () => openLibrary(sec) }));
    const tabs = (PL.plugins.tabs ? PL.plugins.tabs() : []).map((t) => ({
      label: t.title, sub: 'From ' + pluginName(t.plugin), icon: 'sparkle', next: true, action: () => openPluginTab(t),
    }));
    const profiles = homeUsers ? (homeUsers.length > 1 ? homeUsers.length + ' profiles' : 'Only this one') : '';
    const device = [
      { label: 'Controls', value: S.controlsValue(PL.input.setting(), PL.input.mode()), sub: 'Remote switches to the TV layout', next: true, action: controlsSheet },
      PL.web ? { label: 'Local network access', value: PL.web.lnaLabel(), next: true, action: () => PL.web.explainLna() } : null,
      fullscreenOk() ? { label: 'Full screen', toggle: isFull(), action: () => { PL.web.toggleFullscreen(); setTimeout(refreshAll, 400); } } : null,
      PL.input.detected() !== 'touch' && PL.web ? { label: 'Keyboard and mouse', sub: 'Shortcuts', next: true, action: () => PL.web.explainKeys() } : null,
      PL.fuzzy && PL.fuzzy.rebuild ? { label: 'Refresh search index', sub: 'If Search misses new titles', action: () => { PL.fuzzy.rebuild(); T.toast('Rebuilding the search index…'); } } : null,
    ];
    // bundled plugins' own rows (Overseerr), then Overseerr's web requirements
    const pluginRows = PL.plugins.settingsRows(refreshAll).map((r) => ({ label: r.label, value: r.value, icon: 'sparkle', next: true, action: () => r.action() }));
    const seerr = PL.overseerr && PL.overseerr.web && PL.plugins.list().some((p) => p.id === 'overseerr' && p.enabled);
    if (seerr) {
      const problem = PL.overseerr.web.problem;
      pluginRows.push({
        label: 'Overseerr on the web', sub: problem && problem.explain ? problem.explain.title : 'Needs Overseerr on the same site as this page',
        tone: problem ? 'warn' : null, icon: 'info', next: true, action: overseerrWebSheet,
      });
    }
    const installed = PL.plugins.list().length + PL.plugins.unavailable.length
      + (host() && host().list ? host().list().filter((p) => !p.active).length : 0);
    return {
      top: profileCard(),
      sections: [
        { rows: [{ label: 'Switch profile', icon: 'person', value: profiles, next: true, action: profilesSheet }] },
        { heading: 'Browse', rows: more.concat(tabs) },
        { heading: 'Server', rows: [{ label: s.name || 'Not connected', sub: S.connection(s.kind), icon: 'tv', next: true, action: serverSheet }] },
        { heading: 'Playback', rows: [
          stored('Autoplay next episode', 'autoplayNext', true),
          stored('Skip intros automatically', 'autoSkipIntro', false),
          stored('Skip credits automatically', 'autoSkipCredits', false),
        ] },
        { heading: 'Surprise Me', rows: [
          stored('Include watched titles', 'surprise.includeWatched', false),
          stored('Autoplay countdown', 'surprise.autoplay', true),
        ] },
        { heading: 'This device', rows: device },
        { heading: 'Plugins', rows: pluginRows.concat([{ label: 'Plugins', value: installed ? String(installed) : '', sub: 'Installed plugins and the catalogue', icon: 'grid', next: true, action: pluginsSheet }]) },
        { heading: 'About', rows: [
          { label: 'Plex Lite', value: PL.VERSION, icon: 'info', next: true, action: aboutSheet },
          { label: 'Sign out', icon: 'signout', danger: true, action: signOut },
        ] },
      ],
    };
  }

  T.screens.settings = () => {
    if (live.length) return live[0];
    const s = listSheet({ title: 'Settings', cls: 'ts-main', build: mainModel });
    PL.plex.homeUsers().then((list) => { homeUsers = list; refreshAll(); }, () => {});
    return s;
  };
})();
