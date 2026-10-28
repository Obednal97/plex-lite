// A person's page on a phone or tablet: their round photo and name over a soft glow of their work,
// then what Plex has with them, one poster grid per library (Movies, TV Shows...), newest first. As
// the TV's js/screens/person.js: one request per video library, filtered by actor, director or writer.
// person: a Plex tag {id, tag, role, thumb, filter} (Role / Director / Writer, or a search result).
// Web build only; modern JS (the TV never loads web/touch/).
'use strict';

(() => {
  if (!window.PL || !PL.isWeb || !PL.touch || !PL.touch.ui || !PL.touchDetailsLogic) return;
  const T = PL.touch;
  const ui = T.ui;
  const h = ui.h;
  const P = PL.ui;
  const D = PL.touchDetailsLogic;

  T.screens.person = (person) => {
    const name = person.tag || person.name || person.title || '';
    const id = D.personId(person);
    const filter = D.personFilter(person);
    const page = T.page('t-person');
    let alive = true;

    const bar = ui.backBar({ title: name });
    page.el.appendChild(bar);
    const head = h('header.t-person-head');
    const glow = h('div.t-person-glow');
    head.appendChild(glow);
    const photo = h('div.t-person-big');
    if (person.thumb) photo.appendChild(ui.img(ui.imageUrl(person.thumb, 160, 160), null, true));
    else photo.appendChild(h('span', { text: name.split(/\s+/).map((w) => w[0] || '').slice(0, 2).join('') || '?' }));
    head.appendChild(photo);
    const who = h('div.t-person-who');
    who.appendChild(h('h1.t-person-name', { text: name }));
    const summary = h('div.t-person-sum');
    who.appendChild(summary);
    head.appendChild(who);
    page.el.appendChild(head);
    const body = h('div.t-person-body', null, ui.spinner());
    page.el.appendChild(body);

    function load() {
      body.replaceChildren(ui.spinner());
      const sections = (PL.app.sections || []).filter((s) => s.type === 'movie' || s.type === 'show');
      if (id == null || !sections.length) {
        body.replaceChildren(ui.empty('Nothing with ' + (name || 'this person') + ' in your libraries'));
        return;
      }
      const params = (s) => {
        const p = { type: s.type === 'show' ? 2 : 1, sort: 'originallyAvailableAt:desc', 'X-Plex-Container-Size': 200, excludeFields: 'summary' };
        p[filter] = id;
        return p;
      };
      let failed = 0;
      Promise.all(sections.map((s) => PL.plex.get('/library/sections/' + s.key + '/all', params(s))
        .then((mc) => ({ section: s, items: mc.Metadata || [] }), (err) => { failed++; return { section: s, items: [], err }; })))
        .then((results) => {
          if (!alive) return;
          const found = results.filter((r) => r.items.length);
          const what = D.personSummary(results);
          const role = filter === 'director' ? 'Director' : filter === 'writer' ? 'Writer' : '';
          summary.textContent = [role, what].filter(Boolean).join(' · ');
          if (!found.length) {
            const err = failed === results.length ? results[0].err : null;
            body.replaceChildren(ui.empty(err ? PL.errorMessage(err) : 'Nothing with ' + (name || 'this person') + ' in your libraries'));
            if (err) body.appendChild(ui.button({ label: 'Try again', action: load }));
            return;
          }
          const first = found[0].items[0];
          const art = first && P.artPath(first);
          if (art) glow.replaceChildren(ui.img(P.ambient(art), null, true));
          body.replaceChildren(...found.map((r) => {
            const sec = h('section.t-person-sec');
            const hd = h('div.t-shelf-head');
            hd.appendChild(h('h2.t-shelf-title', { text: r.section.title }));
            hd.appendChild(h('span.t-person-count', { text: String(r.items.length) }));
            sec.appendChild(hd);
            const grid = h('div.t-grid.t-person-grid');
            r.items.forEach((it) => grid.appendChild(ui.poster(it, { caption: true })));
            sec.appendChild(grid);
            return sec;
          }));
        });
    }

    const onScroll = () => {
      const solid = head.getBoundingClientRect().bottom < 140;
      if (solid !== bar.classList.contains('t-solid')) bar.classList.toggle('t-solid', solid);
    };
    page.onShow = () => {
      window.addEventListener('scroll', onScroll, { passive: true });
      requestAnimationFrame(onScroll);
    };
    page.onHide = () => window.removeEventListener('scroll', onScroll);
    page.destroy = () => { alive = false; };
    page.title = name;
    load();
    return page;
  };
})();
