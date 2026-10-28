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
        // a browser on an https page can only use https addresses: one row, tried before discovery
        PL.isWeb ? null : addressRow('Local server address', 'local', 'e.g. http://192.168.0.10:32400'),
        addressRow(PL.isWeb ? 'Server address' : 'Remote server address', 'remote', 'e.g. https://plex.example.com:32400'),
        PL.isWeb ? PL.web.settingsRows(build) : null,
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
      // plugins this build can't run (the web build: ones with a TV background service) say why
      var unavailable = PL.plugins.unavailable.map(function (p) {
        return { label: 'Plugin · ' + p.name, value: 'TV app only', action: function () { PL.web.explainPlugin(p); } };
      });
      defs.splice(defs.length - 2, 0, pluginToggles, unavailable, externalPluginRows(), PL.plugins.settingsRows(build));
      defs = [].concat.apply([], defs).filter(Boolean);
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
      var browse = PL.pluginStore ? [{ label: 'Browse plugins', value: '', action: browsePlugins }] : [];
      return browse.concat(host.list().map(function (p) {
        var on = p.active && PL.plugins.isEnabled(p.id);
        var value = p.disabled ? 'Error' : !p.active ? (host.grants.get(p.id) ? 'Needs permission' : 'Off') : on ? (p.holdsToken ? 'On · Plex sign-in' : 'On') : 'Off';
        return { label: 'Plugin · ' + p.title, value: value, action: function () { externalPluginSheet(p); } };
      }));
    }

    var STATE_TEXT = { 'not-installed': 'Not installed', installed: 'Installed', connected: 'Connected' };

    // The catalogue (remote, cached or bundled): one row per plugin with its state.
    function browsePlugins() {
      var store = PL.pluginStore;
      PL.toast('Loading plugins…');
      store.loadCatalog().then(function (c) {
        var rows = c.plugins.map(function (e) {
          var st = store.state(e);
          var sub = !e.compatible && st.state === 'not-installed' ? e.needs
            : st.state === 'update-available' ? 'Update to ' + e.version : STATE_TEXT[st.state];
          if (PL.isWeb && e.kind === 'service') {
            return { label: e.name, sub: 'TV app only', action: function () { PL.web.explainPlugin({ name: e.name, reason: 'tv-service' }); } };
          }
          return { label: e.name, sub: sub, action: function () { catalogueEntrySheet(e); } };
        });
        if (!rows.length) rows.push({ label: 'No plugins available', sub: c.errors[0] || '', action: function () {} });
        var custom = store.catalogUrl() !== store.DEFAULT_URL;
        rows.push({ label: 'Catalogue address', sub: (custom ? store.catalogUrl() : 'Default') + ' · ' + c.source, action: editCatalogUrl });
        PL.app.push(screens.sheet([{ heading: 'Plugins', rows: rows }], { closeOnSelect: false }));
      });
    }

    function editCatalogUrl() {
      var store = PL.pluginStore;
      PL.app.push(screens.textEntry('Catalogue address', store.catalogUrl(), 'Leave empty for the default', function (value) {
        if (!store.setCatalogUrl(String(value || '').trim())) { PL.toast('Use an http(s) address'); return false; }
        PL.toast('Catalogue address saved');
        return true;
      }));
    }

    function catalogueEntrySheet(e) {
      var store = PL.pluginStore;
      var st = store.state(e);
      var parse = PL.pluginHost._internals.parsePermissions;
      var rows = parse({ permissions: e.permissions }).list.map(function (perm) {
        return { label: perm.text, sub: perm.risk === 'high' ? 'Sensitive' : '', action: function () {} };
      });
      if (!rows.length) rows.push({ label: 'Needs no permissions', action: function () {} });
      var actions = [];
      var run = function (fn) { return function () { PL.app.pop(); PL.app.pop(); fn(); }; };
      if (!e.compatible && st.state === 'not-installed') {
        actions.push({ label: e.needs, action: function () {} });
      } else if (st.state === 'not-installed' || st.state === 'update-available') {
        var label = st.state === 'not-installed' ? 'Install' : 'Update to ' + e.version;
        actions.push({ label: label, sub: e.kind === 'service' ? 'Also installs a background service' : '', action: run(function () { installPlugin(e); }) });
      } else if (st.state === 'installed') {
        actions.push({ label: 'Connect…', action: run(function () { connectPlugin(e.id, e.name); }) });
      } else {
        actions.push({ label: 'Manage', action: run(function () {
          var p = PL.pluginHost.list().filter(function (x) { return x.id === e.id; })[0];
          if (p) externalPluginSheet(p);
        }) });
      }
      if (st.installed) actions.push({ label: 'Remove', action: run(function () { removePlugin(e.id, e.name); }) });
      var head = e.name + ' ' + (st.installed && st.installed.version !== e.version ? st.installed.version + ' → ' : '') + e.version +
        (e.author ? ' · ' + e.author : '') + (e.description ? ' — ' + e.description : '');
      PL.app.push(screens.sheet([{ heading: head, rows: rows }, { heading: '', rows: actions }], { closeOnSelect: false, focus: rows.length }));
    }

    function installPlugin(e) {
      PL.pluginStore.install(e, function (status) { PL.toast(e.name + ': ' + status); }).then(function () {
        var rt = PL.pluginHost.runtimes[e.id];
        // an update that keeps all its grants is already running
        if (PL.pluginHost.definitions[e.id] && !PL.pluginHost.grants.missing(e.id, rt.manifest, rt.hash).length) {
          PL.toast(e.name + ' updated');
          refreshTabs();
          build();
          return;
        }
        connectPlugin(e.id, e.name);
      }, function (err) { PL.toast(e.name + ': ' + PL.errorMessage(err), 5000); build(); });
    }

    // Connect = consent, then on, then its own settings (e.g. a server address) if it has any.
    function connectPlugin(id, name) {
      PL.pluginStore.connect(id).then(function (on) {
        build();
        if (!on) { PL.toast(name + ' was not connected'); return; }
        PL.toast(name + ' is connected');
        refreshTabs();
        var def = PL.pluginHost.definitions[id];
        if (def && def.settingsRows) {
          def.settingsRows().then(function (list) {
            if (list.length) PL.app.push(screens.sheet([{ heading: name, rows: list.map(function (r) { return { label: r.label, sub: r.value, action: r.action }; }) }]));
          }, function () {});
        }
      }, function (err) { PL.toast(PL.errorMessage(err)); });
    }

    function removePlugin(id, name) {
      PL.pluginStore.remove(id).then(function (ok) {
        PL.toast(ok ? name + ' removed' : name + ' removed (its service could not be uninstalled)');
        refreshTabs();
        build();
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
        actions.push({ label: 'Connect…', action: function () { PL.app.pop(); connectPlugin(p.id, p.title); } });
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
      if (PL.pluginStore && PL.pluginStore.installed()[p.id]) {
        actions.push({ label: 'Uninstall', action: function () { PL.app.pop(); removePlugin(p.id, p.title); } });
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
        heading: PL.isWeb ? 'Sign out of Plex? This also clears Plex Lite\'s settings, favourites and plugins in this browser.' : 'Sign out of Plex?',
        rows: [
          { label: 'Sign out', action: function () {
            PL.plex.signOut(true);
            // the web build starts afresh, so nothing from the old session stays in memory
            if (PL.isWeb) location.reload();
            else PL.app.start();
          } },
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
