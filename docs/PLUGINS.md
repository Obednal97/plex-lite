# Writing a Plex Lite plugin (Phase 1: bundled, reviewed)

Plugins add rows, actions and settings to Plex Lite without touching its screens. In Phase 1 every
plugin ships inside the app (`plugins/<id>/`) and is reviewed like any other code; there is no
download-and-install yet. Overseerr (`plugins/overseerr/`) is the worked example throughout.

## Folder layout

```
plugins/<id>/
  plugin.js          registers the plugin (loaded by index.html)
  <id>.css           optional styles (linked in index.html)
  service/           optional webOS JS service (Node on the TV)
    package.json     {"name": "<service id>", "main": "service.js"}
    services.json    {"id": "<service id>", "services": [{"name": "<service id>"}]}
    service.js
```

Add `<script src="plugins/<id>/plugin.js">` (before `js/app.js`) and the stylesheet link to
`index.html`. `tools/build-ipk.py` packages the web files into the app and any `service/` into
`./usr/palm/services/<service id>`, declaring it in `packageinfo.json`. A service id must start
with the app id (`com.bednal.plexlite.…`). Builds made with `--app-id` rewrite that prefix, so a
fork's services become `<its id>.…` automatically (README, "App id").

## register()

```js
'use strict';
(function () {
  PL.plugins.register({
    id: 'overseerr',            // [a-z0-9-], unique
    name: 'Overseerr',
    version: '1.0.0',
    apiVersion: 1,              // this document
    description: 'Request movies and shows that are not in your library.',
    services: ['com.bednal.plexlite.service'],   // optional
    web: true,                  // optional: runs in the web build without its services (see below)
    // hooks below are all optional
  });
})();
```

Invalid definitions are rejected and logged. Users can switch any plugin off under
**Settings → Plugin · <name>**; switched-off plugins get no hook calls.

## Hooks

Every hook runs isolated: an exception, a rejected promise or a promise that takes longer than 8 s
only drops that plugin's contribution (logged as `plugin <id> <hook> failed/timed out`). Keep hooks
cheap; the TV has a 1.1 GHz CPU and Chrome 53.

### settingsRows(ctx) → rows

Rows in Settings' Plugins group, after the plugins' On/Off rows. Call `ctx.refreshSettings()` after
changing state.

```js
settingsRows: function (ctx) {
  var cfg = ctx.storage.get('config', null);
  return [{
    label: 'Overseerr requests',
    value: cfg ? cfg.user.displayName : 'Not set up',
    action: function () { /* ctx.sheet(...) / ctx.textEntry(...) */ },
  }];
},
```

### searchRows(q, ctx) → Promise<shelf | [shelf] | null>

Shelves shown after Search's own results. Search debounces (450 ms) and drops stale answers, so a
hook only needs to answer the query it was given. Return `null` when there is nothing to show
(e.g. not configured).

```js
searchRows: function (q, ctx) {
  if (!ctx.storage.get('config', null)) return null;
  return api(ctx, 'GET', '/search?query=' + encodeURIComponent(q)).then(function (data) {
    return { id: 'requests', title: 'Request on Overseerr', kind: 'poster', items: data.results.map(toItem) };
  });
},
```

### searchIdleRows(ctx) → Promise<shelf | [shelf] | null>

Shelves for Search before anything is typed (next to the TV keyboard; under recent searches on
phones). Asked when Search shows with an empty query (and again after a minute), never while typing,
so Search's typing path is unaffected. Answer from a cache: Overseerr's Trending, Popular films and
Popular shows reuse the lists its Recommended rows loaded. A shelf's own `onSelect` is used when it
has one.

### shelfRows(section, ctx) → Promise<[shelf]>

Extra shelves on a library's Recommended view. `section` is the Plex section (`{key, type, title}`).
A shelf with `at: n` goes after the library's first `n` rows (Overseerr puts Trending after 2,
Popular after 4, Upcoming after 6); without it, after all of them. Rows placed at the same point keep
the plugins' order, and a library with fewer rows gets them at the end. They arrive after Plex's rows
and are put in without moving the focus off its row.

### actions(item, ctx) → [{label, icon?, run()}] | Promise<[…]>

Extra actions for a Plex item, shown as pills on its details page and in the hold-OK menu. Answer at
once when you can (no network calls for the common case; fetch in `run()`). An action that depends
on a lookup may answer with a promise: the details page adds the pills when it settles, but the
hold-OK menu waits only 600 ms for plugins, so answer within ~450 ms with what you know and keep the
lookup going into a cache for next time. Overseerr's "Request seasons" does this: a details page
passes the full item (with `Guid`s) and it waits up to 5 s; a list item gets 450 ms. A promise that
takes 8 s drops all of that plugin's actions.

```js
actions: function (item, ctx) {
  if (item.type !== 'movie') return [];
  return [{ label: 'Find similar on Overseerr', icon: 'versions', run: function () { /* … */ } }];
},
```

### badges(item, ctx) → Promise<[{label, tone?}]>

Up to two keyline badges added to a details page's meta line once they're known (e.g. Overseerr's
"Downloading 45%"). `tone: 'accent'` draws it in the accent colour. `item` is the full Plex item
(movie, show or episode, with `Guid`s). Called on every details page, so answer from a cache.

### onSelect(item, ctx)

OK on an item from one of the plugin's shelves. A shelf can also carry its own `onSelect(item, ctx)`.

### onPlayback(event, ctx)

What the player is doing, for plugins that react to it (the Home Assistant plugin dims the lights).
Fire-and-forget: the player never waits for it, and its return value is ignored.

| `event.event` | when |
|---|---|
| `play` | a new item started playing: the video is rendering, not just loading (also the next episode after Up Next, and a new channel) |
| `pause` / `resume` | the viewer paused or resumed (also when another full screen covers the player). A seek or a scrub sends nothing |
| `stop` | playback ended early: the viewer left the player, it failed, a Next episode press early in an episode, or another channel was tuned |
| `ended` | it finished: the video ended, Skip Credits, or Up Next from the credits (then `play` for the next one) |
| `buffering-start` / `buffering-end` | a stall of more than 2 s while playing (waiting for a seek doesn't count) |

```js
{
  event: 'play',
  at: 1761940800000,          // ms since 1970
  positionMs: 0,              // null for Live TV
  item: {
    type: 'movie',            // 'movie' | 'episode' | 'live' | 'clip' (trailers and extras)
    kind: 'movie',            // 'movie' | 'series' | 'live' | null (clips)
    title: 'Sintel',          // the episode's own title; Live TV: the programme, else the channel
    showTitle: 'Caminandes',  // episodes: the show, season and episode numbers
    season: 1, episode: 2,
    year: 2010, durationMs: 888000, contentRating: 'PG-13',   // when Plex has them
    genres: ['Animation', 'Fantasy'],                        // up to 3, may be empty
    isKids: false,
    channel: 'Open Movie Channel',                           // Live TV only
    liveCategory: 'movie',    // Live TV only: 'sports' | 'news' | 'kids' | 'movie' | 'series' | null
  },
}
```

- **Nothing identifies the server or the account**: no rating keys, paths, image URLs, file names,
  tokens, server names or profile.
- **`isKids`** is true when the content rating is one for children (`G`, `U`, `Uc`, `TV-Y`, `TV-Y7`,
  `TV-Y7-FV`, `TV-G`, and `PG` for films; a country prefix like `gb/` is ignored), the library's name
  says Kids or Children, a genre is Children or Kids, or a Live TV programme is in the guide's Kids
  category.
- **`liveCategory`** is the Live TV guide's own category (docs/LIVETV-browse-design.md): from the
  programme's genres, else the channel's category in the loaded guide, else the channel's name.
  Entertainment and documentaries count as `series`; music, shopping and religious channels are `null`.
- Everything comes from metadata the player already has: no requests are made for an event.
- **Delivery**: the player only queues the event; plugins get it about 200 ms later in a timer of
  their own, in order, never in the task that handled a key press. Each plugin gets its own copy. A
  plugin that throws, rejects or never answers is logged and changes nothing for playback or the other
  plugins. While the page goes away (the TV app leaving the foreground, a browser tab closing) the
  queue is delivered at once, because timers may not run after that.
- Keep it cheap and asynchronous: it still runs on the TV's one main thread. Do network calls without
  waiting on them in the hook, and debounce (a pause followed by a resume a second later is common).
- **External plugins** need the `playback` permission ("See what you're watching and when it plays or
  pauses", medium risk) in their catalogue entry and the user's consent. They get the same fields
  (strings capped). Only plugins that ask for it are woken: a sandboxed plugin's frame starts on its
  first event, which costs ~50 ms on the TV once, after the `play` has been delivered.

```js
PL.plugins.register({
  id: 'now-playing-log', name: 'Now playing', version: '1.0.0', apiVersion: 1,
  onPlayback: function (ev, ctx) {
    if (ev.event !== 'play') return;
    ctx.log('playing', ev.item.kind, ev.item.title, ev.item.genres.join(', '));
  },
});
```

### Shelves and items

A shelf is `{id, title, kind: 'poster' | 'wide', items, makeCard?, onSelect?, at?}`. Items need
`ratingKey` (unique), `title`, and optionally `year`, `thumb`/`art` (image URLs; they are resized by
the Plex server), `summary`. Use a custom `type` (Overseerr uses `'request'`) so core actions such as
Play don't apply to them. `makeCard(item, kind, geo)` may start from `ctx.ui.makeCard` and add a
badge with `ctx.ui.badge(node, className, text)`. The phone and tablet layout doesn't use `makeCard`:
give an item `badge: {label, tone?}` (a short word: posters are ~100 px wide there; tones `accent`,
`status-2` amber, `status-3` blue, `status-4` green) and it is drawn on the card.

## ctx

| member | what it is |
|---|---|
| `id` | the plugin id |
| `ui` | `el`, `makeCard`, `badge`, `icon` (Phosphor names in `js/icons.js`) |
| `sheet(sections, opts)` | opens a glass picker sheet (`[{heading, rows: [{label, sub, checked, action}]}]`) |
| `textEntry(title, initial, placeholder, onDone)` | text input using the TV keyboard; `onDone(value)` returns `false` to keep editing |
| `toast(text, ms?)` | short message |
| `log`, `warn` | prefixed with the plugin id |
| `storage.get/set/del` | localStorage scoped to `plugin.<id>.*` |
| `http(method, url, opts)` | the app's XHR helper (abortable promise) |
| `plexToken()` | the active profile's Plex token; explicit so it can be permissioned later |
| `profile()` | the active Plex Home profile `{uuid, title, admin}` (`admin`: the Home's owner, the one profile Plex never restricts), or `null` for the account owner |
| `plex.metadata(ratingKey)`, `plex.children(ratingKey)`, `plex.image(path, w, h)` | read-only lookups on the connected server |
| `openItem(item)` | opens the details page for a Plex item (`{ratingKey, type, title}`); the touch layout's page on phones and tablets |
| `push(screen)`, `pop()`, `backdrop(url)` | bundled plugins only: push a screen object (`{el, show, hide, key, destroy}`) built from `ctx.ui` (which also has `spinner`, `fadeInImage`, `KEY`, `isBack`) |
| `service(method, params, serviceId?)` | calls one of the plugin's own `services` over the Luna bus |

**Services on the web.** The web build ([WEB.md](WEB.md)) has no webOS services: a plugin with
`services` is listed as "TV app only" there, unless its definition has `web: true`, which says it
has a browser path of its own and doesn't call `ctx.service` on the web (`ctx.service` rejects there).
Overseerr does this: `plugins/overseerr/seerr-web.js`, loaded only by the web build, answers the same
methods as its service (see [OVERSEERR.md](OVERSEERR.md#on-the-web)).

## Tabs and screens (declarative)

A plugin can add up to two tabs (two plugin tabs in total across all plugins). It never draws UI:
it returns a *model* and Plex Lite renders it with its own components, so the look and performance
stay consistent.

```js
PL.plugins.register({
  id: 'trending', name: 'Trending', version: '1.0.0', apiVersion: 1,
  tabs: [{ id: 'main', title: 'Trending' }],
  screen: function (tabId, ctx) {
    return Promise.resolve({
      type: 'shelves',                       // or 'grid' ({items}) or 'page' (details-like)
      shelves: [{ title: 'This week', kind: 'poster', items: [
        { title: 'Some film', year: 2026, thumb: '/library/metadata/1/thumb/1', ratingKey: '1' },
        { title: 'Not in Plex', thumb: 'https://…', onSelect: function () {
          return { type: 'page', title: 'Not in Plex', summary: '…',
                   actions: [{ label: 'Request', icon: 'check', run: function () { /* … */ } }] };
        } },
      ] }],
    });
  },
});
```

Items with a numeric `ratingKey` open Plex Lite's details page; an `onSelect` may return another model,
which is pushed as a new screen. Catalogue (external) plugins declare their tabs in their catalogue
entry (`tabs`) and need the `tabs` permission; see [PLUGINS-v2-design.md](PLUGINS-v2-design.md).

## Bundled vs external plugins

Bundled plugins (this document) are reviewed code shipped inside Plex Lite. External plugins are
listed in the catalogue (`catalog/plugins.json`) and installed from Settings → Plugins → Browse
plugins: Plex Lite downloads the code, checks its pinned SHA-256, asks for consent and runs it
sandboxed with explicit permissions. Plex sign-in (the raw token) is a **Sensitive** permission,
re-asked on every update and revocable in Settings → Plugins.

- **Web plugin** (most plugins): one JS file using `PlexLitePlugin.register({...})` with the same hooks.
  Put `plugin.js` + `plugin.json` (the catalogue entry without `bundleUrl`/`sha256`) in a folder and
  run `node tools/build-plugin.mjs <folder>`; it copies the code to `catalog/bundles/` and pins the
  hash. Example: `examples/plugins/hello-shelf` (an example for plugin authors: it isn't published in the
  catalogue, and neither is any other example or test plugin).
- **Service plugin** (needs a background service, like Overseerr): an `.ipk` with the service, installed
  by Plex Lite through Homebrew Channel (`ipkUrl` + `sha256`), plus a web bundle for the hooks
  (`bundleUrl` + `bundleSha256`). How Overseerr would move there: PLUGINS-v2-design.md → Distribution.

Writing hooks that return Promises and treating `ctx` calls as asynchronous lets the same plugin code
move from bundled to external.

External plugins can add at most two tabs between them (titles up to 18 characters); they sit before
Settings in the tab bar. Installed plugins start lazily (in their frame) and are unloaded when idle,
so having one installed doesn't slow down browsing.

## Services (when the web app can't do it alone)

Overseerr needs one because its session cookie is `HttpOnly; SameSite=Lax`: the app (a `file://`
page) can sign in but can never send the cookie back. `service/service.js` signs in with the Plex
token, keeps the cookie and proxies `/api/v1/*` to that one server.

- Node on webOS 4.5 is **v0.12**: ES5 only (`var`, `function`, no arrow functions, `new Buffer`).
- `var Service = require('webos-service'); var service = new Service('<service id>');`
  then `service.register('<method>', function (msg) { msg.respond({returnValue: true, …}); });`
- Errors: `msg.respond({returnValue: false, errorCode: 'x', errorText: 'human message'})`.
- Keep state in memory and, if needed, a `0600` file under `/tmp`.
- Only talk to the server the user configured; validate every path/argument the app sends.

## Web code constraints (Chrome 53)

ES2015 only: no `async`/`await`, object spread, `Object.entries/values`, `Promise.prototype.finally`,
`AbortController`; CSS without grid, flex `gap`, `clamp()`/`min()`/`max()`, `aspect-ratio`,
`backdrop-filter`. Animate only `transform`/`opacity`. Run `node tools/check.mjs` (it scans
`plugins/` too).

## Review checklist

- [ ] `register()` has id, name, version, `apiVersion: 1`; every hook tolerates being called often.
- [ ] Never logs, toasts, stores in the repo or sends anywhere unexpected: Plex tokens, cookies,
      API keys, personal server addresses. Personal settings live only in `ctx.storage` on the TV.
- [ ] `ctx.plexToken()` is only sent to the service the user configured, over https.
- [ ] Network calls happen in `searchRows`/`shelfRows`/`run`, never in `actions`/`settingsRows`.
- [ ] Items use a custom `type` and unique `ratingKey`s.
- [ ] Services are ES5, validate inputs, and talk only to the configured host.
- [ ] `node tools/check.mjs` passes; tested on the TV (the hook works, and switching the plugin off
      removes it cleanly).

## Overseerr in brief

Full notes: [OVERSEERR.md](OVERSEERR.md).

- **Settings:** "Overseerr" opens the plugin's page (a pushed screen; on phones a touch page): sign in,
  Your requests, Downloads, the discover rows switch. Each Plex Home profile has its own session.
- **Search:** `searchRows` queries `/api/v1/search`, hides titles already available, badges
  Requested / Processing / Partly available / Downloading n%.
- **onSelect:** a sheet to request a movie, all/remaining seasons or a single season
  (`POST /api/v1/request`).
- **Discover:** `shelfRows` (Trending, Popular, Upcoming with `at`) and `searchIdleRows`.
- **Request seasons:** `actions` on show and season pages (a promise until the lookup is cached).
- **Downloading:** `shelfRows` (a Downloading shelf), `badges` (details) and a Downloading screen.
- **Report a problem:** `actions` (details pill + hold-OK) → `POST /api/v1/issue`.

## Home server helper plugins in brief

Full notes: [HOME-HELPER.md](HOME-HELPER.md). Three bundled plugins share one setting, Settings →
Plugins → **Home server helper** (`plugins/home-helper/`, which also provides `PL.homeHelper` to other
bundled plugins, Overseerr's Downloading included):

- **What's coming** (`plugins/whats-coming/`): `shelfRows` ("New episodes this week", "Films arriving
  soon"), `badges` ("3 episodes missing") and `actions` ("Search for missing episodes").
- **Subtitles** (`plugins/bazarr/`): `actions` ("Subtitles…": find missing subtitles, fix their timing)
  and `badges` ("No English subtitles").
