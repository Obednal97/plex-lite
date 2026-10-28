// The phone and tablet layer's shell (docs/WEB.md, "Phones and tablets"): when it takes over from
// the 1920x1080 TV stage, the bottom tabs, a stack of pages per tab, Back (the chevron, the
// browser's Back, Esc), and the hand-off to the player (PL.touch.play, the touch player in
// web/touch/player.js) and to stage screens it doesn't have its own version of yet.
//
// How it sits on the app (js/app.js): while the layer is in charge, the stage's root screen is a
// stand-in (an empty screen that passes Back to the layer), the stage is hidden (html.pl-touch) and
// the page scrolls like a web page. A stage screen pushed on top (the player, the guide) shows the
// stage again until it is closed. Every hook below passes straight through unless the layer is
// wanted (narrow windows and touch tablets) or in charge, so the laptop and TV paths never run it.
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.app) return;
  const app = PL.app;
  const L = PL.touchLogic;
  const T = PL.touch = PL.touch || { screens: {} };
  const ui = T.ui;
  const h = ui.h;
  const html = document.documentElement;

  T.engaged = false; // the stage's root is our stand-in
  T.visible = false; // ... and nothing of the stage's is on top of it
  T.tabs = [];
  T.more = [];       // libraries without a tab of their own
  T.tab = null;      // the current tab: {id, label, icon, section, stack: [page], button}
  T.profile = null;  // {title, thumb}

  // ---- When the layer is wanted ---------------------------------------------------------------------

  const width = () => html.clientWidth || window.innerWidth;
  const height = () => html.clientHeight || window.innerHeight;
  T.wanted = () => L.wanted({ width: width(), setting: PL.input.setting(), detected: PL.input.detected() });

  function applyLayout() {
    const lay = L.layout(width(), height());
    html.classList.toggle('t-phone', lay.kind === 'phone');
    html.classList.toggle('t-tablet', lay.kind === 'tablet');
    html.classList.toggle('t-short', lay.short);
    T.kind = lay.kind;
  }

  // ---- DOM ---------------------------------------------------------------------------------------------

  const rootEl = h('div.t-root', { id: 'touch' });
  const pagesEl = h('main.t-pages');
  const tabbarEl = h('nav.t-tabbar', { 'aria-label': 'Sections' });
  rootEl.appendChild(pagesEl);
  rootEl.appendChild(tabbarEl);
  // the stage's mouse wheel turns wheel steps into arrow keys and cancels scrolling: not here
  rootEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  // Back at the top of the start tab leaves the stage's tab bar "focused" (js/app.js focusTabs),
  // which web/web.js reads as "the next Back leaves the site". Any touch here means the person is
  // still using the page: clear it, so a later Back closes a sheet or a page instead.
  rootEl.addEventListener('pointerdown', () => { if (app.tabsFocused) app.blurTabs(true); }, true);
  T.root = rootEl;
  T.layer = h('div.t-layer'); // sheets, menus: above the pages and the tab bar
  rootEl.appendChild(T.layer);

  function mount() {
    if (!rootEl.parentNode) document.body.appendChild(rootEl);
  }

  // ---- The stage's stand-in ------------------------------------------------------------------------------

  function standIn() {
    return {
      el: h('div.t-standin'),
      root: true,
      touchStandIn: true,
      show() { app.backdrop.set(null, 'none'); },
      // Back from the keyboard (Esc), the browser (web/web.js) or a remote: ours to handle. Not
      // handled at the top of the start tab, so the next Back leaves the site as on the stage.
      key(code) { return PL.isBack(code) ? T.back() : false; },
    };
  }

  // Shows the layer or the stage, from what is on the stage's stack. A screen of the layer's own
  // (touchOverlay: the touch player) covers the layer instead: the layer stays in charge under it,
  // its pages keep their place, and nothing of the stage shows.
  function sync() {
    const st = app.stack;
    const ours = !!(st[0] && st[0].touchStandIn);
    T.engaged = ours;
    const covered = ours && st.length > 1 && st.slice(1).every((s) => s.touchOverlay);
    setVisible(ours && (st.length === 1 || covered));
    setCovered(covered);
  }

  T.covered = false;
  function setCovered(on) {
    if (on === T.covered) return;
    T.covered = on;
    const top = topPage();
    if (on) {
      if (top) top.scrollY = window.scrollY;
      closeAllSheets();
      html.classList.add('t-covered');
      return;
    }
    html.classList.remove('t-covered');
    // back from the player: the page shows its progress again
    if (T.visible && top) {
      restoreScroll(top);
      if (top.onShow) top.onShow({ back: true });
    }
  }

  function setVisible(on) {
    if (on === T.visible) return;
    T.visible = on;
    if (on) {
      mount();
      applyLayout();
      html.classList.add('pl-touch');
      const top = topPage();
      if (top) {
        restoreScroll(top);
        if (top.onShow) top.onShow({ back: true });
      }
    } else {
      const top = topPage();
      if (top) top.scrollY = window.scrollY;
      closeAllSheets();
      html.classList.remove('pl-touch');
      window.scrollTo(0, 0);
      // the stage scales itself to the window again (web/web.js fit)
      window.dispatchEvent(new Event('resize'));
    }
  }

  // ---- Hooks on the stage (pass-through unless the layer is wanted or in charge) ---------------------------

  const real = { selectTab: app.selectTab, setRoot: app.setRoot, push: app.push, pop: app.pop, replaceTop: app.replaceTop };

  app.selectTab = function (i) {
    if (!T.wanted()) return real.selectTab.apply(this, arguments);
    const stageTab = app.tabs.tabs[i];
    app.tabs.selected = i;
    app.tabs.index = i;
    app.blurTabs(true);
    app.setRoot(standIn());
    engage(stageTab && stageTab.id);
  };

  ['setRoot', 'push', 'pop', 'replaceTop'].forEach((name) => {
    app[name] = function () {
      const out = real[name].apply(this, arguments);
      if (T.engaged || (app.stack[0] && app.stack[0].touchStandIn)) {
        sync();
        // back from a stage screen: the window may have changed size meanwhile
        if (app.stack.length === 1) decide();
      }
      return out;
    };
  });

  // ---- Taking over and handing back --------------------------------------------------------------------

  // What the tabs were built for: a new sign-in, profile, server or library list starts afresh.
  let builtFor = null;

  function engage(stageId) {
    mount();
    const sig = [PL.plex.token, PL.plex.server && PL.plex.server.machineId, app.hasLiveTv]
      .concat(app.sections.map((s) => s.key + s.type)).join('|');
    if (sig !== builtFor) {
      builtFor = sig;
      buildTabs();
      loadProfile();
      selectTab(L.startTab(T.tabs, stageId));
    } else if (!T.tab) {
      selectTab(L.startTab(T.tabs, stageId));
    }
    sync();
  }

  // Back to the TV stage (the window got wide): the stage builds the tab we were on.
  function disengage() {
    const ids = app.tabs.tabs.map((t) => t.id);
    const want = T.tab ? ids.indexOf(T.tab.id) : -1;
    real.selectTab.call(app, want >= 0 ? want : app.tabs.selected);
    sync();
  }

  // On resize (and rotation): swap layers only when nothing is open on the stage.
  const decide = PL.debounce(() => {
    applyLayout();
    if (app.stack.length !== 1 || !app.ready) return;
    const want = T.wanted();
    if (want && !T.engaged && app.tabs.tabs.length) {
      app.blurTabs(true);
      real.setRoot.call(app, standIn());
      engage(app.tabs.tabs[app.tabs.selected] && app.tabs.tabs[app.tabs.selected].id);
    } else if (!want && T.engaged) {
      disengage();
    }
  }, 200);
  window.addEventListener('resize', () => { if (T.visible) applyLayout(); decide(); });
  // scrolled: the status bar gets a solid band behind it (at the top the hero runs under it)
  let scrolled = false;
  window.addEventListener('scroll', () => {
    const on = T.visible && window.scrollY > 8;
    if (on !== scrolled) { scrolled = on; html.classList.toggle('t-scrolled', on); }
  }, { passive: true });
  // Settings -> Controls pinned to Remote (the TV layout) or back
  PL.input.on(() => decide());
  // a stage screen closed while the window changed: look again once it's gone
  T.recheck = decide;

  // ---- Tabs ------------------------------------------------------------------------------------------

  function buildTabs() {
    T.tabs.forEach((t) => t.stack.forEach(destroyPage));
    pagesEl.replaceChildren();
    const { tabs, more } = L.tabs(app.sections, app.hasLiveTv);
    T.more = more;
    T.tab = null;
    T.tabs = tabs.map((t) => Object.assign({}, t, { stack: [] }));
    tabbarEl.replaceChildren();
    tabbarEl.classList.toggle('t-tabbar-many', T.tabs.length > 4);
    T.tabs.forEach((t, i) => {
      const b = h('button.t-tab', { type: 'button', on: { click: () => selectTab(i) } }, [ui.icon(t.icon), h('span.t-tab-label', { text: t.label })]);
      t.button = b;
      tabbarEl.appendChild(b);
    });
  }

  function makeRoot(tab) {
    if (tab.section) return T.screens.library ? T.screens.library(tab.section) : stagePage(() => PL.screens.library(tab.section));
    if (tab.id === 'livetv') return T.screens.live ? T.screens.live() : stagePage(() => PL.screens.livetv());
    return T.screens.search ? T.screens.search() : stagePage(() => PL.screens.search());
  }

  function selectTab(i) {
    const tab = T.tabs[i];
    if (!tab) return;
    if (tab === T.tab) {
      // the tab you are on: back to its top, then to the top of the page
      if (tab.stack.length > 1) {
        while (tab.stack.length > 1) destroyPage(tab.stack.pop());
        showPage(tab.stack[0], 'pop');
        window.scrollTo(0, 0);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const top = topPage();
        if (top && top.onReselect) top.onReselect();
      }
      return;
    }
    const prev = topPage();
    if (prev) hidePage(prev);
    closeAllSheets();
    T.tab = tab;
    T.tabs.forEach((t) => {
      t.button.classList.toggle('on', t === tab);
      if (t === tab) t.button.setAttribute('aria-current', 'page');
      else t.button.removeAttribute('aria-current');
    });
    if (!tab.stack.length) tab.stack.push(makeRoot(tab));
    showPage(topPage(), 'tab');
    app.blurTabs(true);
  }
  T.selectTab = (id) => selectTab(T.tabs.map((t) => t.id).indexOf(id));
  T.tabIndex = () => T.tabs.indexOf(T.tab);

  // ---- Pages --------------------------------------------------------------------------------------------

  // A page: {el, onShow({back}), onHide(), destroy(), onReselect(), title}. T.page() makes one.
  T.page = (cls, opts) => Object.assign({ el: h('div.t-page' + (cls ? '.' + cls : '')) }, opts || {});

  const topPage = () => (T.tab ? T.tab.stack[T.tab.stack.length - 1] : null);
  T.top = topPage;

  function restoreScroll(page) {
    const y = page.scrollY || 0;
    window.scrollTo(0, y);
    // the page may still be laying out its rows
    if (y) requestAnimationFrame(() => window.scrollTo(0, y));
  }

  function showPage(page, how) {
    if (!page.el.parentNode) pagesEl.appendChild(page.el);
    page.el.hidden = false;
    page.el.classList.remove('t-enter-push', 't-enter-pop');
    if (how === 'push' || how === 'pop') {
      void page.el.offsetWidth;
      page.el.classList.add(how === 'push' ? 't-enter-push' : 't-enter-pop');
    }
    if (how === 'push') window.scrollTo(0, 0);
    else restoreScroll(page);
    if (page.onShow && T.visible) page.onShow({ back: how === 'pop' });
  }

  function hidePage(page) {
    page.scrollY = window.scrollY;
    page.el.hidden = true;
    if (page.onHide) page.onHide();
  }

  function destroyPage(page) {
    if (page.onHide && !page.el.hidden) page.onHide();
    if (page.destroy) page.destroy();
    page.el.remove();
  }

  // Opens a page on the current tab.
  T.push = (page) => {
    if (!T.tab) return;
    closeAllSheets();
    const prev = topPage();
    if (prev) hidePage(prev);
    T.tab.stack.push(page);
    showPage(page, 'push');
    app.blurTabs(true);
  };

  // Swaps the top page (a reveal handing over to what it revealed).
  T.replace = (page) => {
    if (!T.tab) return;
    if (T.tab.stack.length > 1) {
      destroyPage(T.tab.stack.pop());
      // the page underneath keeps the scroll it had (T.push would save the current one)
      const under = topPage();
      const y = under.scrollY;
      T.push(page);
      under.scrollY = y;
      return;
    }
    T.push(page);
  };

  // Back: a sheet closes, a page pops, the top of another tab goes to the start tab.
  // Returns false at the top of the start tab (the browser may leave the site).
  T.back = () => {
    if (closeTopSheet()) return true;
    if (!T.tab) return false;
    const start = L.startTab(T.tabs, T.startId);
    const act = L.backAction(T.tab.stack.length, T.tabIndex(), start);
    if (act === 'pop') {
      destroyPage(T.tab.stack.pop());
      showPage(topPage(), 'pop');
      return true;
    }
    if (act === 'start') {
      selectTab(start);
      return true;
    }
    return false;
  };

  // A stage screen the layer has no version of yet, shown on the stage (it closes back to here).
  function stagePage(make) {
    const page = T.page('t-stagepage');
    page.el.appendChild(ui.spinner());
    let opened = false;
    page.onShow = () => {
      // back from the stage screen: this placeholder has done its job
      if (opened) { setTimeout(() => { if (topPage() === page) T.back(); }); return; }
      opened = true;
      app.push(make());
    };
    return page;
  }
  T.stagePage = stagePage;

  // ---- Opening things ------------------------------------------------------------------------------------

  // A title, person or collection: its touch page, else the stage's.
  T.open = (item) => {
    if (!item) return;
    if (item.type === 'collection' && T.screens.collection) return T.push(T.screens.collection(item));
    if (item.type === 'person' && T.screens.person) return T.push(T.screens.person(item));
    if (T.screens.details) return T.push(T.screens.details(item));
    app.push(PL.screens.details(item));
  };

  T.openPerson = (person) => {
    if (T.screens.person) T.push(T.screens.person(person));
    else app.push(PL.screens.person(person));
  };

  // ---- Playback: the hand-off to the player ---------------------------------------------------------------

  // The TV player on the stage, until web/touch/player.js replaces these two with the touch player
  // (same arguments as PL.screens.player). Closing it comes back here and the page refreshes (onShow).
  T.play = (item, opts) => app.push(PL.screens.player(item, opts || {}));
  // live: {label, dvrKey, channel, channels, index} (js/screens/livetv.js playList)
  T.playLive = (live) => app.push(PL.screens.player(null, { live }));

  // ---- The profile (the avatar) -----------------------------------------------------------------------------

  const profileListeners = [];
  // -> a function that removes it
  T.onProfile = (fn) => {
    profileListeners.push(fn);
    return () => {
      const i = profileListeners.indexOf(fn);
      if (i >= 0) profileListeners.splice(i, 1);
    };
  };
  function setProfile(p) {
    T.profile = p;
    profileListeners.slice().forEach((fn) => { try { fn(p); } catch (e) { PL.warn('touch profile listener', e && e.message); } });
  }
  function loadProfile() {
    const saved = PL.storage.get('profile', null);
    setProfile({ title: saved ? saved.title : '', thumb: null });
    PL.plex.user().then((u) => {
      const name = (saved && saved.title) || u.title || u.username || '';
      // a Home profile's own picture is in the Home users list; the account's is on the user
      setProfile({ title: name, thumb: saved ? null : (u.thumb || null) });
      if (saved) {
        PL.plex.homeUsers().then((users) => {
          const me = users.filter((x) => x.uuid === saved.uuid)[0];
          if (me && me.thumb) setProfile({ title: name, thumb: me.thumb });
        }, () => {});
      }
    }, () => {});
  }

  T.openSettings = () => {
    if (T.screens.settings) T.screens.settings();
    else app.push(PL.screens.settings());
  };

  // ---- Sheets (web/touch/sheets.js fills these in) -------------------------------------------------------------

  function closeTopSheet() { return !!(T.sheets && T.sheets.closeTop()); }
  function closeAllSheets() { if (T.sheets) T.sheets.closeAll(); }

  // ---- Stage key handling while the layer shows --------------------------------------------------------------

  // Enter on a focused control clicks it (the stage's key handler doesn't prevent that); arrows are
  // the stage's, but it only prevents their scrolling: Page Up/Down and Space scroll here as usual.
  T.startId = null;
  const prevStart = app.startTab;
  app.startTab = function () {
    const i = prevStart.apply(this, arguments);
    T.startId = app.tabs.tabs[i] && app.tabs.tabs[i].id;
    return i;
  };
})();
