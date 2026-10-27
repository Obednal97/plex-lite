# Plex Lite plugins, Phase 2: separately installed, sandboxed plugins

Status: design + working implementation on branch `plugins-v2` (wired into the Phase 1 registry,
Settings → Plugins, the tab bar and a plugin catalogue). Phase 1 (bundled, reviewed plugins in
`plugins/<id>/`, registered with `PL.plugins.register()`) ships on `main`. Phase 2 lets people install
plugins **from a catalogue, inside Plex Lite** without trusting them with the user's Plex account.

## Goals and non-goals

- A plugin written for Phase 1 should become an external plugin with minimal change: same
  `register({id, name, version, apiVersion, searchRows, shelfRows, actions, settingsRows})`, same
  `ctx` names. The one difference: in Phase 2 **every `ctx` call returns a Promise**.
- Installing a plugin must never silently grant access to the Plex token, other plugins' data, the
  network, or the TV.
- The weak TV (1.1 GHz Cortex-A55, Chrome 53, ~300 MB free) must not slow down because of plugins
  the user isn't using.
- Not a goal: plugins drawing arbitrary UI. They return data (shelves, actions, rows); Plex Lite
  renders it with its own components, so plugins can't spoof screens or slow rendering.

## Decisions (2026-10-27)

1. **The raw Plex token may be granted** (`plex:token`), but only through an explicit consent flagged
   **Sensitive**. It is re-asked on **every** plugin update (version or code hash change), revocable in
   Settings → Plugins ("Remove access"), and the plugins holding it are listed there ("On · Plex
   sign-in"). Plex Lite logs *which* plugin received it, never the token. Plugin storage, results and
   logs are scrubbed of it.
2. **Catalogue**: our own JSON list in this repo, `catalog/plugins.json`, pinning the SHA-256 of
   every version's code (and `.ipk` for service plugins).
3. **Plugins may add tabs and screens, declaratively.** A plugin declares tabs (`plexlitePlugin.tabs`
   in its catalogue entry) and returns screen *models* (shelves, grids, details-like pages, actions, sheets);
   Plex Lite renders them with its own components (`js/screens/plugin-screen.js`). No plugin-drawn DOM
   in the visible UI. Needs the `tabs` permission; at most **2 plugin tabs** in total.
4. **Discovery is catalogue-based** (decided later the same day): Plex Lite reads the catalogue and
   installs from Settings → Plugins → Browse plugins (Install / Connect / Update / Remove). The
   earlier design (plugins as separate IPKs found by Plex Lite's core service, elevated to root
   through Homebrew Channel to scan other packages) is **dropped**, along with the core service.

## Threat model

Assume a plugin may be malicious or compromised (its update could be). It must not be able to:

| Threat | Mitigation |
|---|---|
| Steal the Plex token (full account access) | Plugin runs in a sandboxed iframe with an opaque origin: no access to the app's `localStorage`, DOM or JS. The token is only handed over with the explicit, high-risk `plex:token` grant. Plex reads otherwise go through the host (`plex:read`), which adds the token itself, allows GET on a fixed path list only, strips `X-Plex-Token` params and scrubs the token from responses. |
| Exfiltrate data to its own server | Frame CSP `connect-src 'none'`: no direct XHR/fetch/WebSocket. Network goes through `ctx.fetch`, allowed only to origins the user granted (`network:<origin>` or `network:user` + an address the user typed). |
| Read other plugins' data | Storage is namespaced per plugin id on the host side (`plugin.<id>`), size-capped (64 KB). Each plugin gets its own frame. |
| Phish the user (fake sign-in screen) | Plugins can't draw UI. Labels are length-capped plain text, rendered by the host. |
| Navigate/replace the app, open popups, submit forms | iframe `sandbox="allow-scripts"` only (no `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-same-origin`); CSP `form-action 'none'; base-uri 'none'; frame-src 'none'`. |
| Track via images | Shelf images must be Plex paths (resized by the user's own Plex server) or http(s) URLs on an origin the plugin is allowed to contact. |
| Hang or flood the app | Per-call timeout (4 s), max 16 calls in flight, 256 KB message cap, results truncated (40 items/shelf, 3 shelves, 4 actions, 10 settings rows). After 5 consecutive failures the plugin is turned off with a toast. |
| Script injection via the inlined source | Plugin source is inlined into `srcdoc`; `</script` and `<!--` are escaped. |
| Swap code after the user approved it | Code is only installed if its SHA-256 matches the catalogue (checked in Plex Lite with a pure-JS SHA-256; WebCrypto isn't available to `file://` pages on Chrome 53). The installed copy lives in Plex Lite's own storage, and the hash is recorded with the grant. A changed hash keeps grants only if permissions are unchanged and the plugin doesn't hold the Plex sign-in (see Updates). |
| Compromised catalogue host | The catalogue URL is fixed by default (this repo) and only changeable in Settings. A changed catalogue can only offer code; every install still shows the consent sheet. Signing is the next step (see Distribution). |
| Escalate via its own background service | `service` permission (medium risk); the service id must start with the plugin id, and the host only calls that one. Plex Lite has no root path of its own any more. |

Residual risks: a plugin granted `plex:token` can do anything the account can, so the consent text
says so and it is marked "Sensitive". A plugin granted network access to its own origin can send
it whatever the user's Plex library reveals through `plex:read`. That is inherent and stated in
the consent sheet.

## Catalogue

`catalog/plugins.json` in this repo (schema 1):

```json
{
  "schema": 1,
  "updated": "2026-10-27",
  "plugins": [{
    "id": "com.example.plexlite.hello", "name": "Hello Shelf", "description": "…", "author": "…",
    "version": "1.0.0", "apiVersion": 1, "minAppVersion": "0.1.0", "homepage": "https://…",
    "kind": "web", "permissions": ["plex:read", "tabs"], "tabs": [{"id": "hello", "title": "Hello"}],
    "bundleUrl": "bundles/com.example.plexlite.hello-1.0.0.js", "sha256": "7dc619ce…"
  }]
}
```

- `kind: "web"`: `bundleUrl` + `sha256` of that one JS file (the plugin's `register()` code).
- `kind: "service"`: `ipkUrl` + `sha256` of the `.ipk` (an app package carrying the background service),
  plus `bundleUrl` + `bundleSha256` for the plugin code Plex Lite runs, and an optional `serviceId`
  (default `<id>.service`; must start with the id). Needs the `service` permission.
- Relative URLs resolve against the catalogue's own URL; only http(s) and plain relative paths (no
  `..`) are accepted. `tabs` is optional (max 2). Entries with a newer `apiVersion` or
  `minAppVersion` are listed but can't be installed. Bad entries are skipped, not fatal.
- Plex Lite fetches it from a configurable URL (Settings → Plugins → Browse plugins → Catalogue
  address; default `https://raw.githubusercontent.com/Obednal97/plex-lite/main/catalog/plugins.json`),
  caches the last good copy (`plugins.catalogCache`), and falls back to the copy bundled in the app
  (`catalog/` is in the IPK). The repo is private for now, so the bundled copy is what works today.
  When offline, the newer of the cache and the bundled copy (by `updated`) wins.
- **Publishing a web plugin**: `node tools/build-plugin.mjs examples/plugins/hello-shelf` copies the
  plugin's `plugin.js` to `catalog/bundles/<id>-<version>.js`, pins its SHA-256 and writes the entry
  from the plugin's `plugin.json`. A published version is immutable (rebuilding it with different code
  fails; bump the version).

## Install, connect, update, remove

`js/plugin-store.js` (`PL.pluginStore`):

| State | Means | Browse shows |
|---|---|---|
| not installed | no code stored | Install (or "Needs Plex Lite x.y.z") |
| installed | code stored and verified, not consented/on | Connect…, Remove |
| update available | catalogue version > installed version | Update to x.y.z, Remove |
| connected | consented and on | Manage, Remove |

- **Install (web)**: download the bundle (≤256 KB), check its SHA-256 against the catalogue, store it
  in `localStorage` (`plugins.bundle.<id>`, read back to catch quota failures; ≤1 MB for all plugins),
  record `plugins.installed[id]` (version, kind, hash, the manifest derived from the entry), then hand
  it to the host. It waits there until **Connect** = the consent sheet → on → the plugin's own settings
  (e.g. a server address) if it has any. Browse runs install + connect in one go.
- **Install (service)**: the same for the code, and before storing it Plex Lite calls Homebrew Channel:
  `luna://org.webosbrew.hbchannel.service/install {ipkUrl, ipkHash, subscribe: true}`. HBC 0.7.3
  downloads, checks the hash, installs, and replies several times (`{statusText, progress}` …
  `{finished: true}`); Plex Lite shows the status lines and cancels the subscription when finished.
  HBC documents this service for other homebrew apps on rooted TVs (Hearth calls it from its web app),
  so a dev-installed web app can call it. If HBC isn't there or refuses, nothing is stored.
- **Update**: the same as install over the existing copy; grants carry over unless the update asks for
  new permissions or the plugin holds the Plex sign-in (then it waits for consent again).
- **Remove**: stops the frame, revokes grants, deletes the code, the record and the plugin's storage;
  service plugins are also uninstalled through HBC (`uninstall {id}`).
- At start-up the host starts with `PL.pluginStore.installedBundles()`; frames still start lazily.

## Runtime isolation

One hidden iframe per plugin:

```html
<iframe sandbox="allow-scripts" srcdoc="…">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';
        connect-src 'none'; img-src 'none'; style-src 'none'; …">
  <script>/* js/plugin-sdk.js */</script><script>/* the plugin's entry */</script>
```

All of this is supported by Chrome 53: `srcdoc`, `sandbox`, CSP via `<meta>`, and `postMessage`
with structured clone. The SDK (`js/plugin-sdk.js`, ~4 KB) gives the plugin `PlexLitePlugin.register`
and a promise-based `ctx`. Functions in results (`action.run`, `row.action`, `item.onSelect`) stay
inside the frame under ids; the host invokes them by id (`invoke`). The host only accepts messages
whose `event.source` is that plugin's frame, validates every message, and sanitises every result.

### Cost on this TV, and the limits that follow

Without site isolation (Chrome 53), a sandboxed `srcdoc` frame lives in Plex Lite's renderer
process: a new document plus a V8 context. **Measured on the TV** (SDK + Hello Shelf, frame created
until the plugin's `register()` reached the host): **47–53 ms for the first frame, 32–37 ms for the
next ones** (3 rounds). Memory: WAM renderer RSS rose by +1, +8 and +15 MB for three frames across
three rounds, i.e. roughly 0.3–5 MB per frame — noisy because other activity on the TV moved RSS by
similar amounts (`performance.memory` is quantised to 10 MB steps on this build, so it can't resolve
it). Budget assumption: ~3 MB per live frame. To keep it negligible:

- **Lazy start**: a frame is created on a plugin's first hook call, not at boot. Start-up only
  reads the installed records.
- **At most 3 live frames** (least-recently-used are unloaded). **Idle unload** after 5 minutes.
- Hooks are only called where the app needs them, and the host already debounces search.
- Measure on the TV with `tools/tvdebug.mjs` (`performance.memory`, trace) before raising limits.

## Permissions and consent

| Permission | Risk | Consent text |
|---|---|---|
| `plex:read` | low | Read your Plex libraries (titles, artwork, watch progress) |
| `plex:token` | high (Sensitive) | Use your Plex sign-in (full access to your Plex account) |
| `network:<origin>` | medium | Contact `<host>` |
| `network:user` | medium | Contact a server address you enter |
| `service` | medium | Run its own background service on the TV |
| `tabs` | low | Add its own tab to Plex Lite (max 2 plugin tabs overall) |

- Always allowed: scoped storage, toasts, sheets (host-rendered), settings rows.
- **Connect** (after install, or Settings → Plugins → the plugin → Connect…) shows the consent sheet, which lists the
  permissions with "Allow" / "Don't allow" (`PL.pluginHost.consent`). The decision is stored in
  `PL.storage('pluginHost.grants')` as `{version, hash, granted, origins, denied}`.
- **Updates**: if the new version asks for nothing new, grants carry over (the new hash is recorded),
  except `plex:token`, which is re-asked on every update. If it adds a permission, only the new ones
  are asked about; until then the plugin stays inactive.
- **Settings → Plugins** shows "Browse plugins" and each installed plugin: status (Off / Needs
  permission / On / On · Plex sign-in), its permissions and whether each is allowed, and Connect…,
  Plugin settings, Turn off, Remove access (revokes every grant; it asks again on Connect) and
  Uninstall.
- `network:user`: when the user types an address in the plugin's settings, the host records that
  origin (`PL.pluginHost.allowOrigin`). The plugin can't add origins itself.

## Host capabilities (what `ctx` does in Phase 2)

| `ctx` call | Needs | Host behaviour |
|---|---|---|
| `ctx.plex.get(path, params)` | `plex:read` | GET only, path allow-list (sections, metadata, children, related, extras, collections, hubs, search); `X-Plex-*` params dropped; token added by the host and scrubbed from the result |
| `ctx.plexToken()` | `plex:token` | Returns the account token |
| `ctx.fetch(url, {method, headers, body})` | `network:*` | Origin must be granted; only content-type/accept/authorization/x-api-key headers; 10 s timeout; 1 MB cap; text result |
| `ctx.storage.get/set` | none | Per-plugin namespace, 64 KB |
| `ctx.toast(msg)` | none | 120 characters |
| `ctx.sheet(heading, rows)` | none | Host-rendered sheet; selecting a row calls the plugin's function |
| `ctx.service(method, params)` | `service` | Calls only the service named in the plugin's own manifest |

Items passed to plugins (e.g. `actions(item)`) are projected to plain facts (`ratingKey`, `type`,
`title`, `year`, `guid`, episode numbers, duration, progress). Never artwork URLs, which carry the token.
Without `plex:read`, a plugin only learns the item's type.

## Versioning and compatibility

- `apiVersion` (currently 1) in both the catalogue entry and `register()`. The host refuses plugins built
  for a newer API, and keeps supporting older ones for at least one major version.
- Additive changes (new hooks, new `ctx` methods) don't bump the version; the SDK tells the host
  which hooks a plugin implements (`ready` message).
- The plugin id in `register()` must equal the catalogue id (checked); otherwise the plugin is refused.
- `minAppVersion` in the catalogue keeps a plugin off older Plex Lite builds.

## Distribution

1. **Now**: `catalog/plugins.json` + `catalog/bundles/` in this repo, a copy bundled in the app.
2. **When the repo is public**: the default URL starts working; the bundled copy remains the offline
   fallback.
3. **Signing** (later): catalogue entries signed with a key embedded in Plex Lite (Ed25519 via a
   small JS implementation, since WebCrypto Ed25519 isn't in Chrome 53), so a compromised catalogue
   host can't push code even to users who accept its consent sheet.

### Overseerr as a service plugin (not done yet; the bundled Overseerr stays as is)

Overseerr needs a background service (session cookie, CORS), so it would be a `service` entry:

1. Package `plugins/overseerr/service/` as its own app IPK, id `com.bednal.plexlite.overseerr`, with
   the service `com.bednal.plexlite.overseerr.service` (today it ships inside Plex Lite as
   `com.bednal.plexlite.service`). Host the IPK on GitHub Releases and pin its SHA-256.
2. Port `plugins/overseerr/plugin.js` to the SDK: its `ctx.service(...)` calls carry over; its UI
   moves from DOM to declarative models (a `page` with Request actions, `settingsRows` for the server
   address and sign-in).
3. Entry: `kind: "service"`, `permissions: ["plex:read", "service"]`, `ipkUrl` + `sha256` (IPK),
   `bundleUrl` + `bundleSha256` (the SDK port), `serviceId`.
4. Drop it from the bundled plugins in the same release, migrating its settings.

## Migration from Phase 1

| Phase 1 (bundled) | Phase 2 (external) |
|---|---|
| `PL.plugins.register(def)` | `PlexLitePlugin.register(def)`, same shape |
| `ctx.storage.get(key)` may be synchronous | always returns a Promise |
| `ctx.plexToken()` | same name; needs the `plex:token` grant |
| network via `ctx.http` / `PL.http` | `ctx.fetch` (granted origins only) |
| plugin service via `ctx.service` | same; needs the `service` grant |
| trusted code in the app page | sandboxed frame; results sanitised |

`PL.pluginHost.activate()` wraps each external plugin in a Phase 1-shaped definition
(`toDefinition`) and registers it with `PL.plugins.register`, so the screens' existing hook
call sites work unchanged. Recommendation for Phase 1 authors: write hooks that return Promises
and treat `ctx` methods as async. Then the same code runs in both phases.

## On this branch

- `js/plugin-host.js`: permission parsing, grants and consent sheet, sandboxed frames, the RPC bridge,
  capabilities, sanitising, the Phase 1 adapter, lazy start, LRU, idle unload, auto-disable;
  `addRuntime`/`removeRuntime` for installs; `luna()` with multi-reply support (HBC install).
- `js/plugin-store.js`: catalogue load/parse/cache, install/update/remove/connect, state.
- `js/sha256.js`: pure-JS SHA-256 (tested against Node's crypto).
- `js/plugin-sdk.js`: the in-frame SDK. `js/screens/plugin-screen.js`: declarative screens.
- `catalog/plugins.json`, `catalog/bundles/`: the catalogue, with Hello Shelf published.
- `tools/build-plugin.mjs`: publishes a web plugin into the catalogue.
- `examples/plugins/hello-shelf` (published) and `examples/plugins/probe` (escape tests, unpublished).
- `test/plugin-host.test.mjs`: 28 Node tests (permissions, sanitising, Plex allow-list, RPC limits,
  end-to-end SDK ↔ host runs, SHA-256, catalogue parsing, tampered/oversized bundles and quota,
  install → connect → update → remove, Plex sign-in re-ask on update, HBC install/uninstall).

**Verified in a desktop browser** (`tools/devserver.mjs`): Settings → Browse plugins (bundled catalogue,
since the repo URL 404s) → Install → consent sheet (real key presses) → Hello tab and plugin settings →
reload (restored from storage, tab renders shelves) → a tampered update refused, 1.0.0 kept running →
Remove (tab, frame, grants and stored code gone). Earlier: the probe's escapes blocked (parent, top,
localStorage, cookies, direct XHR).

**On the TV**: frame start cost measured earlier (above). Not yet run there: the catalogue flow and
an HBC install of a service plugin (none is published yet).

## Open questions

1. Signing catalogue entries (Ed25519) on top of hash pinning.
2. Hosting: raw GitHub for the catalogue and bundles once the repo is public; GitHub Releases for
   service IPKs.
3. Unrooted TVs: web plugins work everywhere; service plugins need Homebrew Channel.
