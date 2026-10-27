# Plex Lite plugins, Phase 2: separately installed, sandboxed plugins

Status: design + working prototype on branch `plugins-v2`. Phase 1 (bundled, reviewed plugins in
`plugins/<id>/`, registered with `PL.plugins.register()`) ships on `main`. Phase 2 lets people install
plugins **as their own packages** without trusting them with the user's Plex account.

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
| Swap code after the user approved it | The host records the entry's SHA-256 with the grant; catalogue installs pin hashes. A changed hash keeps grants only if permissions are unchanged (see Updates). |
| Escalate via its own background service | `service` permission (medium risk) and the host only calls the service id the plugin's own manifest names. |

Residual risks: a plugin granted `plex:token` can do anything the account can, so the consent text
says so and it is marked "Sensitive". A plugin granted network access to its own origin can send
it whatever the user's Plex library reveals through `plex:read`. That is inherent and stated in
the consent sheet.

## Packaging

A plugin is an ordinary webOS web app package (`.ipk`) with an extra block in `appinfo.json`:

```json
{
  "id": "com.example.plexlite.hello",
  "version": "1.0.0",
  "type": "web",
  "main": "index.html",
  "title": "Hello Shelf",
  "plexlitePlugin": {
    "apiVersion": 1,
    "entry": "plugin.js",
    "permissions": ["plex:read", "network:https://api.example.com"],
    "service": "com.example.plexlite.hello.service",
    "description": "What it adds, shown in Plex Lite's plugin list"
  }
}
```

- Installs with Homebrew Channel or dev install like any app (no new install path to maintain). Its
  `index.html` just says "This is a Plex Lite plugin. Open Plex Lite → Settings → Plugins".
- `examples/plugins/build-plugin-ipk.py <dir>` builds the package and prints the entry's SHA-256.
- Optional background service (for plugins like Overseerr that need cookies or long-lived
  sessions) ships in the same package under `./usr/palm/services/<id>`.

Alternative considered: plugins as a JS file in a catalogue, downloaded by Plex Lite at runtime
(no separate install). It's simpler for users but means Plex Lite downloads and runs code, and
breaks Homebrew Channel's install, update and uninstall model. Kept as a later option (see
Distribution).

## Discovery at start-up

Checked on the TV: WAM only lets a web app read its own folder plus a fixed allow-list
(`/etc/wam/security_policy.conf`), so **Plex Lite's page cannot read another app's files**. And
`applicationManager/listApps` returns each app's `folderPath` but not custom `appinfo` keys. So
discovery goes through **Plex Lite's own JS service** (the one Phase 1 adds for Overseerr; Node
v0.12.2 on webOS 4.5, so ES5):

- `listPlugins {}` → ids of installed apps whose `appinfo.json` has a `plexlitePlugin` block (scans
  `/media/developer/apps/usr/palm/applications`).
- `readPlugin {id}` → `{appinfo, source, sha256}`. Rejects bad ids and entry paths that leave the
  plugin's folder, and caps the source at 512 KB.

Reference implementation: `service-lib/plugin-loader.js` (tested). The page side is
`PL.pluginHost.serviceLoader(callService)`. For desktop work, `PL.pluginHost.devLoader()` reads
unpacked plugins from `examples/plugins/` (open the app with `?plugins=dev`).

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
process. Each one is a new document plus a V8 context: estimated ~1.5–3 MB idle, plus the plugin's
own allocations, and 50–150 ms to parse the SDK and a typical plugin on the A55. This is an
estimate; it can't be measured on the TV without taking the foreground. To keep it negligible:

- **Lazy start**: a frame is created on a plugin's first hook call, not at boot. Discovery only
  reads manifests.
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

- Always allowed: scoped storage, toasts, sheets (host-rendered), settings rows.
- **First enable** (Settings → Plugins → the plugin) shows the consent sheet, which lists the
  permissions with "Allow" / "Don't allow" (`PL.pluginHost.consent`). The decision is stored in
  `PL.storage('pluginHost.grants')` as `{version, hash, granted, origins, denied}`.
- **Updates**: if the new version asks for nothing new, grants carry over (the new hash is recorded).
  If it adds a permission, only the new ones are asked about; until then the plugin stays inactive.
- `network:user`: when the user types an address in the plugin's settings, the host records that
  origin (`PL.pluginHost.allowOrigin`). The plugin can't add origins itself.
- Settings → Plugins lists every installed plugin with its permissions, a toggle, and "Remove
  access" (revokes grants and stops it).

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

- `apiVersion` (currently 1) in both the manifest and `register()`. The host refuses plugins built
  for a newer API, and keeps supporting older ones for at least one major version.
- Additive changes (new hooks, new `ctx` methods) don't bump the version; the SDK tells the host
  which hooks a plugin implements (`ready` message).
- The plugin id in `register()` must equal the package id (checked); otherwise the plugin is refused.

## Distribution

1. **Now**: build an `.ipk` with `build-plugin-ipk.py` and install it through Homebrew Channel (dev
   install) or `tools/deploy.sh`-style scripts.
2. **Catalogue** (proposed): a JSON list Plex Lite can show under Settings → Plugins → Browse:
   `{id, title, version, ipkUrl, ipkSha256, entrySha256, permissions, source, author}`. Plex Lite
   installs through Homebrew Channel's install service and verifies `ipkSha256` (and, after install,
   `entrySha256` via `readPlugin`) before enabling. A plugin whose hash doesn't match the catalogue
   is refused.
3. **Signing** (later): catalogue entries signed with a key embedded in Plex Lite (Ed25519 via a
   small JS implementation, since WebCrypto Ed25519 isn't in Chrome 53), so a compromised catalogue
   host can't push code.
4. The Homebrew Channel repo itself could list plugins (they're normal apps), with the
   `plexlitePlugin` block marking them.

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

## Prototype on this branch

- `js/plugin-host.js`: discovery (dev and service loaders), permission parsing, grants and consent
  sheet, sandboxed frames, the RPC bridge, capabilities, sanitising, the Phase 1 adapter, lazy start,
  LRU, idle unload and auto-disable.
- `js/plugin-sdk.js`: the in-frame SDK.
- `examples/plugins/hello-shelf`: a "Hello from a plugin" shelf, a "Say hello" action (scoped
  storage + toast) and a settings row.
- `examples/plugins/probe`: tries to escape (parent, top, localStorage, cookies, direct XHR,
  ungranted capabilities) and reports the results.
- `examples/plugins/build-plugin-ipk.py`: builds a plugin `.ipk`.
- `service-lib/plugin-loader.js`: reference service methods.
- `test/plugin-host.test.mjs`: 17 Node tests (permissions, sanitising, Plex allow-list, RPC limits,
  end-to-end SDK ↔ host runs of the example plugins, the service loader).

**Verified in a desktop browser** (`tools/devserver.mjs`, `?plugins=dev`): Hello Shelf's shelf loads
from the real library through `plex:read` with no token in anything the plugin returned. The action runs and
its toast shows. The probe's escape attempts are all blocked: parent/top/localStorage/cookies blocked by the
sandbox, direct XHR blocked by CSP, and capabilities refused without grants.

Not yet done: wiring into Phase 1's `PL.plugins` and the Settings → Plugins screen (after rebasing
on main); the service methods in the real Plex Lite service; and on-TV measurements of frame cost.

## Open questions

1. Should `plex:token` exist at all? Overseerr's sign-in needs the raw token. An alternative is a
   narrow host capability (`plex:signin-to <origin>`: the host posts the token to one granted origin
   and never reveals it to the plugin). That is safer, but each such flow has to be built in.
2. Catalogue ownership: our own catalogue JSON (with hash pinning) or the Homebrew Channel repo?
3. Should external plugins be able to add tabs or screens (beyond shelves, actions and settings)?
   This design deliberately says no for now.
