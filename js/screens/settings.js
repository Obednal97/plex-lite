// Settings: server connection, frame-rate meter, sign out, about.
'use strict';

(function () {
  var screens = PL.screens = PL.screens || {};
  var K = PL.KEY;

  var KIND_LABEL = {
    'lan-http': 'Local network', lan: 'Local network (secure)', remote: 'Remote', relay: 'Plex relay',
    'manual-local': 'Local address', 'manual-remote': 'Remote address',
  };

  screens.settings = function () {
    var el = PL.el('div', 'settings');
    var title = PL.el('div', 'page-title', 'Settings');
    title.style.left = '460px';
    el.appendChild(title);
    var panelBox = PL.el('div', 'panel');
    var panel = PL.el('div', 'panel-rows');
    panelBox.appendChild(panel);
    el.appendChild(panelBox);
    var index = 0;
    var area = 'panel';
    var rows = [];

    function server() { return PL.plex.server || {}; }

    function toggle(label, key, dflt) {
      var on = !!PL.storage.get(key, dflt);
      return { label: label, value: on ? 'On' : 'Off', action: function () { PL.storage.set(key, !on); build(); } };
    }

    function build() {
      var s = server();
      var defs = [
        { label: 'Profile', value: (PL.storage.get('profile', null) || { title: 'Account owner' }).title, action: pickProfile },
        { label: 'Server', value: (s.name || '—') + ' · ' + (KIND_LABEL[s.kind] || 'Unknown'), action: reconnect },
        addressRow('Local server address', 'local', 'e.g. http://192.168.0.10:32400'),
        addressRow('Remote server address', 'remote', 'e.g. https://plex.example.com:32400'),
        toggle('Autoplay next episode', 'autoplayNext', true),
        toggle('Skip intros automatically', 'autoSkipIntro', false),
        toggle('Skip credits automatically', 'autoSkipCredits', false),
        toggle('Surprise Me: include watched', 'surprise.includeWatched', false),
        toggle('Surprise Me: autoplay countdown', 'surprise.autoplay', true),
        { label: 'Frame-rate meter', value: PL.app.perf.on ? 'On' : 'Off', action: function () { PL.app.perf.toggle(); build(); } },
        { label: 'Refresh search index', value: '', action: function () { if (PL.fuzzy && PL.fuzzy.rebuild) { PL.fuzzy.rebuild(); PL.toast('Rebuilding the search index…'); } } },
        { label: 'Sign out', value: '', action: signOut },
        { label: 'About', value: 'Plex Lite ' + PL.VERSION, action: function () {} },
      ];
      // Plugins: an On/Off row per installed plugin, then the enabled plugins' own rows; all before
      // Sign out / About.
      var pluginToggles = PL.plugins.list().filter(function (p) { return !p.external; }).map(function (p) {
        return {
          label: 'Plugin · ' + p.name,
          value: p.enabled ? 'On' : 'Off',
          action: function () {
            PL.plugins.setEnabled(p.id, !p.enabled);
            PL.toast(p.name + (p.enabled ? ' turned off' : ' turned on'));
            build();
          },
        };
      });
      defs.splice(defs.length - 2, 0, pluginToggles, externalPluginRows(), PL.plugins.settingsRows(build));
      defs = [].concat.apply([], defs);
      PL.clear(panel);
      rows = defs.map(function (d, i) {
        var n = PL.el('div', 'row', d.label);
        if (d.value) n.appendChild(PL.el('span', 'row-value', d.value));
        n.addEventListener('click', function () { index = i; d.action(); });
        panel.appendChild(n);
        return { node: n, def: d };
      });
      paint();
    }

    // the panel shows ~8 rows; longer lists scroll to keep the focused row in view
    function paint() {
      rows.forEach(function (r, i) { r.node.classList.toggle('focused', area === 'panel' && !PL.app.tabsFocused && i === index); });
      // ~7.5 rows show (690 px panel), so a half row always peeks under the fade
      var shift = Math.max(0, (index + 1) * 84 - 84 * 7);
      PL.translate(panel, 0, -shift);
      panelBox.classList.toggle('more', rows.length * 84 - shift > 630);
    }

    function reconnect() {
      PL.toast('Finding your server…');
      PL.plex.ensureServer(true).then(function (s) {
        PL.toast('Connected to ' + s.name + ' (' + (KIND_LABEL[s.kind] || s.kind) + ')');
        build();
      }, function (err) { PL.toast(PL.errorMessage(err)); });
    }

    // Optional fixed addresses, tried before automatic discovery (local first, then remote).
    function addressRow(label, which, example) {
      var current = PL.plex.manual()[which];
      return {
        label: label, value: current || 'Automatic',
        action: function () {
          PL.app.push(screens.sheet([{
            heading: label,
            rows: [
              { label: current ? 'Change address' : 'Set an address', action: function () { editAddress(label, which, example); } },
              { label: 'Use automatic discovery', checked: !current, action: function () { saveAddress(which, ''); } },
            ],
          }]));
        },
      };
    }

    function editAddress(label, which, example) {
      PL.app.push(screens.textEntry(label, PL.plex.manual()[which], example, function (value) {
        var uri;
        try { uri = PL.plex.normalizeUri(value); } catch (e) { PL.toast(e.message); return false; }
        PL.toast('Checking ' + uri + '…');
        PL.plex.connectUri(uri, 'manual-' + which).then(function () {
          saveAddress(which, uri);
        }, function (err) { PL.toast('No Plex server at that address (' + PL.errorMessage(err) + ')', 5000); });
        return true;
      }));
    }

    function saveAddress(which, uri) {
      var m = PL.plex.manual();
      m[which] = uri;
      PL.storage.set('manualServer', m);
      PL.plex.ensureServer(true).then(function (s) {
        PL.toast('Connected to ' + s.name + ' (' + (KIND_LABEL[s.kind] || s.kind) + ')');
        build();
      }, function (err) { PL.toast(PL.errorMessage(err)); build(); });
    }

    // Separately installed (sandboxed) plugins: status row → a sheet with permissions, enable
    // (consent), its own settings, turn off, and remove access.
    function externalPluginRows() {
      var host = PL.pluginHost;
      if (!host || !host.list || !host.grants) return [];
      return host.list().map(function (p) {
        var on = p.active && PL.plugins.isEnabled(p.id);
        var value = p.disabled ? 'Error' : !p.active ? (host.grants.get(p.id) ? 'Needs permission' : 'Off') : on ? (p.holdsToken ? 'On · Plex sign-in' : 'On') : 'Off';
        return { label: 'Plugin · ' + p.title, value: value, action: function () { externalPluginSheet(p); } };
      });
    }

    function refreshTabs() {
      var current = PL.app.tabs.tabs[PL.app.tabs.selected];
      PL.app.buildTabs();
      var ids = PL.app.tabs.tabs.map(function (t) { return t.id; });
      PL.app.tabs.selected = Math.max(0, ids.indexOf(current && current.id));
      PL.app.tabs.paint();
    }

    function externalPluginSheet(p) {
      var host = PL.pluginHost;
      var rows = p.permissions.map(function (perm) {
        var allowed = p.granted.indexOf(perm.id) !== -1;
        return { label: perm.text, sub: (perm.risk === 'high' ? 'Sensitive · ' : '') + (allowed ? 'Allowed' : 'Not allowed'), action: function () {} };
      });
      if (!p.permissions.length) rows.push({ label: 'Needs no permissions', action: function () {} });
      var actions = [];
      if (!p.active) {
        actions.push({ label: 'Enable…', action: function () {
          PL.app.pop();
          host.enable(p.id).then(function (def) {
            if (def) { PL.plugins.setEnabled(p.id, true); PL.toast(p.title + ' is on'); refreshTabs(); }
            build();
          }, function (err) { PL.toast(PL.errorMessage(err)); });
        } });
      } else {
        var on = PL.plugins.isEnabled(p.id);
        if (on) {
          actions.push({ label: 'Plugin settings', action: function () {
            PL.app.pop();
            var def = host.definitions[p.id];
            def.settingsRows().then(function (list) {
              if (!list.length) { PL.toast(p.title + ' has no settings'); return; }
              PL.app.push(screens.sheet([{ heading: p.title, rows: list.map(function (r) { return { label: r.label, sub: r.value, action: r.action }; }) }]));
            }, function (err) { PL.toast(PL.errorMessage(err)); });
          } });
        }
        actions.push({ label: on ? 'Turn off' : 'Turn on', action: function () {
          PL.app.pop();
          PL.plugins.setEnabled(p.id, !on);
          refreshTabs();
          build();
        } });
        actions.push({ label: 'Remove access', sub: p.holdsToken ? 'Takes back your Plex sign-in' : '', action: function () {
          PL.app.pop();
          host.revoke(p.id);
          PL.toast(p.title + ': access removed');
          refreshTabs();
          build();
        } });
      }
      PL.app.push(screens.sheet([
        { heading: p.title + ' ' + (p.version || '') + (p.description ? ' — ' + p.description : ''), rows: rows },
        { heading: '', rows: actions },
      ], { closeOnSelect: false, focus: rows.length }));
    }

    function pickProfile() {
      PL.plex.homeUsers().then(function (users) {
        if (users.length < 2) { PL.toast('This Plex account has no other profiles'); return; }
        var current = (PL.storage.get('profile', null) || {}).uuid;
        PL.app.push(screens.sheet([{
          heading: 'Who\'s watching?',
          rows: users.map(function (u) {
            return {
              label: u.title, sub: u.protected ? 'PIN' : (u.admin ? 'Owner' : ''), checked: current ? u.uuid === current : !!u.admin,
              action: function () {
                if (u.protected) { PL.toast('PIN-protected profiles are not supported yet'); return; }
                PL.toast('Switching to ' + u.title + '…');
                PL.plex.switchUser(u).then(function () { PL.app.start(); }, function (err) { PL.toast(PL.errorMessage(err)); });
              },
            };
          }),
        }]));
      }, function (err) { PL.toast(PL.errorMessage(err)); });
    }

    function signOut() {
      PL.app.push(screens.sheet([{
        heading: 'Sign out of Plex?',
        rows: [
          { label: 'Sign out', action: function () { PL.plex.signOut(); PL.app.start(); } },
          { label: 'Cancel', action: function () {} },
        ],
      }], { focus: 1 }));
    }

    build();
    return {
      root: true,
      el: el,
      show: function () { PL.app.backdrop.set(null, 'none'); build(); },
      focusFromTabs: function () { area = 'panel'; paint(); },
      onTabsFocus: function () { paint(); },
      key: function (code) {
        if (code === K.UP) {
          if (index === 0) { PL.app.focusTabs(); paint(); return true; }
          index--;
          paint();
          return true;
        }
        if (code === K.DOWN) {
          index = Math.min(rows.length - 1, index + 1);
          paint();
          return true;
        }
        if (code === K.ENTER) {
          rows[index].def.action();
          return true;
        }
        return code === K.LEFT || code === K.RIGHT;
      },
    };
  };
})();
