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

Rows appended to Settings (before Sign out). Call `ctx.refreshSettings()` after changing state.

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

### shelfRows(section, ctx) → Promise<[shelf]>

Extra shelves on a library's Recommended view. `section` is the Plex section (`{key, type, title}`).

### actions(item, ctx) → [{label, icon?, run()}]

Extra actions for a Plex item, shown as pills on its details page and in the hold-OK menu. Must be
synchronous and fast (no network calls here; fetch in `run()`).

```js
actions: function (item, ctx) {
  if (item.type !== 'movie') return [];
  return [{ label: 'Find similar on Overseerr', icon: 'versions', run: function () { /* … */ } }];
},
```

### onSelect(item, ctx)

OK on an item from one of the plugin's shelves. A shelf can also carry its own `onSelect(item, ctx)`.

### Shelves and items

A shelf is `{id, title, kind: 'poster' | 'wide', items, makeCard?, onSelect?}`. Items need
`ratingKey` (unique), `title`, and optionally `year`, `thumb`/`art` (image URLs; they are resized by
the Plex server), `summary`. Use a custom `type` (Overseerr uses `'request'`) so core actions such as
Play don't apply to them. `makeCard(item, kind, geo)` may start from `ctx.ui.makeCard` and add a
badge with `ctx.ui.badge(node, className, text)`.

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
| `plexToken()` | the Plex account token; explicit so it can be permissioned later |
| `service(method, params, serviceId?)` | calls one of the plugin's own `services` over the Luna bus |

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
  hash. Example: `examples/plugins/hello-shelf`.
- **Service plugin** (needs a background service, like Overseerr): an `.ipk` with the service, installed
  by Plex Lite through Homebrew Channel (`ipkUrl` + `sha256`), plus a web bundle for the hooks
  (`bundleUrl` + `bundleSha256`). How Overseerr would move there: PLUGINS-v2-design.md → Distribution.

Writing hooks that return Promises and treating `ctx` calls as asynchronous lets the same plugin code
move from bundled to external.

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

- **Settings:** "Overseerr requests" → set the address → signs in with the Plex token through the
  service ("Sign in with Plex").
- **Search:** `searchRows` queries `/api/v1/search`, hides titles already available, badges
  Requested / Processing / Partly available.
- **onSelect:** a sheet to request a movie, all/remaining seasons or a single season
  (`POST /api/v1/request`).
