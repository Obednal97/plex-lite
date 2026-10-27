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
        addressRow('Local server address', 'local', 'e.g. http://192.168.1.20:32400'),
        addressRow('Remote server address', 'remote', 'e.g. https://plex.example.com:32400'),
        toggle('Autoplay next episode', 'autoplayNext', true),
        toggle('Skip intros automatically', 'autoSkipIntro', false),
        toggle('Skip credits automatically', 'autoSkipCredits', false),
        { label: 'Frame-rate meter', value: PL.app.perf.on ? 'On' : 'Off', action: function () { PL.app.perf.toggle(); build(); } },
        { label: 'Refresh search index', value: '', action: function () { if (PL.fuzzy && PL.fuzzy.rebuild) { PL.fuzzy.rebuild(); PL.toast('Rebuilding the search index…'); } } },
        { label: 'Sign out', value: '', action: signOut },
        { label: 'About', value: 'Plex Lite ' + PL.VERSION, action: function () {} },
      ];
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
      var shift = Math.max(0, (index + 1) * 88 - 88 * 7);
      PL.translate(panel, 0, -shift);
      panelBox.classList.toggle('more', rows.length * 88 - shift > 658);
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
