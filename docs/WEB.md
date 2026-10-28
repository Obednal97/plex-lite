# Plex Lite on the web

Plex Lite also runs in a desktop browser: **https://plexlite.vercel.app**. Sign in with Plex and
it shows the libraries, Live TV and everything else from your own Plex Media Server, as on the TV.
It is the same code as the TV app with a thin web layer on top, built by `tools/build-web.mjs` and
hosted on Vercel.

## How it works

**One codebase, two targets.** The web build loads `web/env.js` first, which sets
`window.PL_PLATFORM = 'web'`; `js/core.js` turns that into `PL.isWeb`. Every webOS-only path checks
it and stays off on the web (luna calls and `PalmServiceBridge`, plugin services and their IPKs,
leaving the app, the TV's "app hidden ends playback" rule). The TV build loads nothing from `web/`,
and on the TV `PL.isWeb` is false, so it behaves exactly as before.

| File | What it does |
| --- | --- |
| `web/env.js` | Marks the platform. |
| `web/web-input.js` | The input mode: remote, mouse and keyboard, or touch (see [Input modes](#input-modes)). |
| `web/web.js` | Who we are to Plex (browser and OS), the 1920x1080 stage scaled to the window, keyboard and mouse for the remote's buttons, the browser's Back button, Chrome's local-network permission, Settings rows, ending sessions when the page goes away. |
| `web/web-player.js` | The player with a mouse: transport row, volume, full screen, tooltips, hiding after 3 s, M and N (see [Player with a mouse](#player-with-a-mouse)). |
| `web/web-signin.js` | The sign-in screen (Plex's own sign-in page, or a plex.tv/link code). |
| `web/web-media.js` | What this browser can decode, the client profile for the Plex transcoder, HLS through hls.js or the browser. |
| `web/plugin-frame.html` | The sandboxed frame external plugins run in (see [Plugins](#plugins)). |
| `web/signed-in.html` | Where Plex's sign-in popup lands; it closes itself. |
| `web/vendor/hls.js/` | hls.js 1.7.3 (light build, Apache-2.0), unmodified. |
| `tools/build-web.mjs` | Copies the app and `web/` to `dist/web/`, rewrites `index.html` (no inline scripts, web scripts added, cache-busting `?v=` hashes) and fails if the page would break the Content-Security-Policy. |
| `vercel.json` | Build command, output directory and the security headers. |
| `tools/serve-web.mjs` | Serves `dist/web` locally with the `vercel.json` headers. |

Shared code stays ES2015 for the TV's Chrome 53, and `node tools/check.mjs` checks `web/*.js` by the
same rules (only `web/vendor/` is skipped).

## Signing in

**Sign in with Plex** asks plex.tv for a PIN and opens Plex's own sign-in page
(`app.plex.tv/auth`, with the PIN's code, this browser's client identifier and "Plex Lite" as the
product) in a popup. Plex Lite polls the PIN every 2 seconds until Plex hands over the sign-in, then
closes the popup. If the browser blocks the popup, the same page opens in the tab and Plex sends the
browser back to Plex Lite afterwards, which finishes the sign-in (the PIN waits in
`sessionStorage`). **Use a link code** shows the TV's four-character code for plex.tv/link, for
signing in from another device.

- Each browser is its own Plex device: a random client identifier in `localStorage`, shown in Plex as
  "Plex Lite (Chrome on macOS)" (product Plex Lite, platform the browser, device the OS).
- Plex Home profiles switch under Settings → Profile, as on the TV (not PIN-protected ones yet).
- The Plex token is kept in this browser's `localStorage` and sent only to plex.tv and to your Plex
  servers, in the query string as Plex's own web app does. It never reaches Vercel or any other server.
- **Sign out** removes everything Plex Lite stored in the browser (sign-in, server, settings,
  favourites, the search index, plugins) and starts again as a new device. The device stays listed
  under plex.tv → Authorized Devices until you remove it there.

## Connecting to your server

A page served over https can only talk to https addresses (the browser blocks plain http as mixed
content), so the web build uses the server's https `*.plex.direct` addresses from plex.tv and never
the TV's plain-http LAN address. The order is the TV's: local first, then Plex Remote Access, then the
Plex relay. Away from home the local address fails and Remote Access (or the relay) is used. A
server address typed in under Settings must start with `https://`.

**What the server allows.** Measured against Plex Media Server 1.43.5 with an `Origin` of a
non-Plex web site:

- The server reflects the page's origin in `Access-Control-Allow-Origin` (with `Vary: Origin`) on
  every address (local, remote and relay), and answers preflights with
  `Access-Control-Allow-Methods: POST, GET, OPTIONS, DELETE, PUT, HEAD` and the requested headers.
  So library browsing, images, HLS playlists and segments, subtitles, timeline reports, track
  changes (PUT) and Live TV tuner release (DELETE) all work from the browser. Plex Lite sends its
  `X-Plex-*` values in the query string, so most requests are simple and need no preflight at all.
- It does not answer the old Private Network Access preflight (`Access-Control-Allow-Private-Network`).
  Chrome no longer uses it; see below.
- plex.tv sends `Access-Control-Allow-Origin: *` for its API (PINs, resources, users, Home).

**Local network access (Chrome 142 and later).** A public web site that reaches a device on your
home network needs your permission: the first time Plex Lite tries the server's local address, Chrome
asks to let the site "look for and connect to any device on your local network". Allow it to stream
straight from the server at home. Until then, or if you block it, Plex Lite uses Remote Access or the
relay. When you allow it later, Plex Lite moves to the local address by itself. Settings → Local
network access shows the state and how to change it (site settings, the icon left of the address).
Firefox and Safari don't ask in the same way.

## Playback

The browser direct plays a file only when it can decode all of it; everything else goes through the
Plex universal transcoder as HLS. `web/web-media.js` asks the browser (`canPlayType`) what it plays:

| | Chrome | Firefox | Safari |
| --- | --- | --- | --- |
| Containers it direct plays | MP4/MOV, WebM, MKV | MP4/MOV, WebM, MKV | MP4/MOV, WebM |
| Video | H.264, VP9, AV1 (HEVC where the OS decodes it) | H.264, HEVC (macOS/Windows), VP9, AV1 | H.264, HEVC, VP9, AV1 |
| Audio | AAC, MP3, Opus, FLAC | AAC, MP3, Opus, FLAC | AAC, MP3, FLAC, AC3, E-AC3 |
| HLS | hls.js | hls.js | built in |

(As measured on macOS; the build checks at run time, so other systems report their own.)

- The decision call carries a client profile built from that list: direct play only for those
  containers and codecs, otherwise HLS with H.264 video (copied when the source is 8-bit H.264,
  converted otherwise) and stereo AAC. HEVC that the browser can't direct play is converted to H.264,
  which costs the server more than the TV did; DTS, E-AC3 and TrueHD audio are converted to AAC.
- On the Plex relay the stream is limited to 720p at 2 Mbit/s; on the LAN and Remote Access it is
  the original quality.
- Resume, timeline reporting (Plex's dashboard, Continue Watching), watched state, audio and
  subtitle choice, chapters, Skip Intro and Skip Credits, the end card and the next episode work as
  on the TV. Text subtitles are drawn by Plex Lite (external files are fetched, embedded ones arrive
  as WebVTT next to the stream); picture subtitles (PGS, VobSub) are burned in by the server.
- Plex's HLS playlist covers the whole file and starts at the resume point, and browsers count in
  the file's time, where the TV counts from the start of the stream; the player adjusts once the video
  says which.
- **Live TV** tunes, plays and changes channel as on the TV, through hls.js (Safari: built in), with
  the guide, Browse, banner, mini guide and favourites. Pausing plays on from the stream's buffer and
  the banner shows how far behind live you are.
- **Leaving.** Closing the tab, reloading or going to another site reports the playback stopped and
  stops the transcode session (requests sent with `fetch` keepalive on `pagehide`); a Live TV tuner is
  released. A background tab keeps playing (the TV ends playback when the app is hidden; a browser
  doesn't). Seeking restarts the stream, as on the TV, and the old session is reported stopped.

## Input modes

The web build works out how it is being driven and shows the controls and hints for that
(`web/web-input.js`). There are three modes:

| Mode | When | What it shows |
| --- | --- | --- |
| `remote` | TV and console browsers, and whenever the browser doesn't say | The white focus plate, D-pad moves, hints with the remote's names (OK, Back), as on the TV. |
| `pointer` | A mouse or trackpad (`(hover: hover) and (pointer: fine)`) | Hover instead of the focus plate; hints as keyboard keys (Enter, Esc). |
| `touch` | A touch screen (`(hover: none) and (pointer: coarse)`) | No focus plate and no key hints. |

**Starting mode.** A TV or console user agent (webOS, Tizen, HbbTV, Fire TV, PlayStation...) is
`remote`. Otherwise the media queries above pick `touch` or `pointer`, and anything else is `remote`:
when unsure, remote, because the focus plate always works, and the first touch or mouse move
switches over anyway. The TV app never loads this file: it is always `remote` and sets nothing on
`<html>`.

**Switching by the last input used.** A touch switches to `touch`. A real mouse move switches to
`pointer`: the mouse has to travel 8 px, mouse events within a second of a touch are ignored
(browsers send them after a tap), and a pen hovering doesn't count. A click or the wheel counts at
once. On a TV or console browser a cursor (a Magic Remote, a gamepad's pointer) only hides the focus
plate, as on the TV: the mode stays `remote`. Arrow keys, Enter, Tab and Page
Up/Down bring up the focus plate and keyboard hints but **never change the layout**: a laptop
stays in the mouse layout, a tablet with a keyboard stays in the touch layout until the next touch.
Other keys (Space, letters) and keys typed into a field change nothing.

**Settings → Controls** pins the mode: Automatic (the default), Remote, Mouse & keyboard or Touch,
kept in this browser's `localStorage` (`pl.input`). Pinned, the layout no longer switches; the last
input still decides whether the focus plate shows. Going back to Automatic picks what was used last
(a touch or a mouse), else the starting mode.

### The contract (for the rest of the web layer)

```js
PL.input.mode()     // 'remote' | 'pointer' | 'touch': the layout and controls to show
PL.input.nav()      // 'keys' | 'pointer' | 'touch': the last kind of input used
PL.input.hints()    // 'remote' | 'keys' | 'none': how key hints are written
PL.input.setting()  // 'auto' | 'remote' | 'pointer' | 'touch' (Settings -> Controls)
PL.input.set(value) // save the setting and apply it
PL.input.on(fn)     // fn({mode, nav, prevMode, prevNav}) after every change; PL.input.off(fn)
```

- `<html data-input="remote|pointer|touch" data-nav="keys|pointer|touch">` carries the same two
  values for CSS, and `document` gets a `pl-inputchange` event (`e.detail` as above) after each change.
- `body.pointer` (the Magic Remote's class in `js/app.js`: hover shows focus, the focus plate is
  hidden) is on whenever `nav` isn't `keys`.
- `hints()` is `remote` in remote mode, `none` when the last input was a touch (outside remote mode),
  else `keys`. With `none`, CSS hides the hint rows (`.osd-hints`, `.lb-hints`). Text built on the
  spot ("Press OK to save") keeps the names it was built with.
- **Key hints relabel themselves.** Build a keycap with `PL.keycap(name)` (`'OK'`, `'Back'`,
  `'CH ±'`...): it keeps the button's name in `data-key` and its text is rewritten when the mode
  changes: OK, Enter or Tap; Back or Esc; Hold OK, Shift+Enter, Right-click or Long-press.
  `PL.keyLabel(name)` gives the current name for text built on the spot.
- Shared code may call any of these anywhere: on the TV `js/core.js` provides a stub with the same
  methods that always answers `remote` (and `nav()` from `body.pointer`); `set()` does nothing.

## Keyboard, mouse and window

The app is laid out at 1920x1080 and scaled to fit the window, centred, with black bars where the
window's shape differs (`transform: scale` on the page, so text is redrawn at the final size).

| Key | Remote button |
| --- | --- |
| Arrows | Arrows |
| Enter | OK (hold it for quick actions) |
| Esc, Backspace (not while typing), the browser's Back button | Back |
| Shift+Enter, the context-menu key, right-click, a long press | Hold OK (quick actions) |
| Space | Play / pause |
| `,` and `.` | Rewind / fast-forward |
| Page Up / Page Down | Channel up / down, page through grids |
| R, G, Y, B | Red, Green, Yellow, Blue |
| I | Info |
| F | Full screen (also Settings → Full screen) |
| 0–9 | Number keys |

On the Search screen letters and Space type instead. The mouse works like the Magic Remote: hover
focuses, click selects, the wheel moves between rows (a trackpad needs a short swipe per step). The
key hints on screen use these names (Enter, Esc, Y, right-click) in the mouse and keyboard mode, and
the remote's names in remote mode ([Input modes](#input-modes)). The browser's Back button goes back
inside the app; at the top level with the tab bar focused, Back leaves the site as usual.

### Player with a mouse

In the mouse and keyboard mode (`web/web-player.js`, `web/web-player.css`; remote mode and the TV
are unchanged) the player adds what a laptop or desktop expects:

- **Back [Esc]** at the top left, which leaves the player. Esc leaves too while the mouse is in use
  (it closes an open menu or tab first); after an arrow key it hides the controls first, as on the TV.
- **A transport row** under the bar: play/pause, back 10 s, ahead 30 s, and the volume (a mute
  button and a slider you click or drag; kept per browser). **Full screen** joins the round icons
  (Subtitles, Audio, Next episode). Every control has a tooltip that names its key: "Pause [Space]",
  "Back 10 s [←]", "Ahead 30 s [→]", "Mute [M]", "Next episode [N]", "Full screen [F]".
- **The bar**: hovering shows the time (and chapter) under the pointer with a line where a click
  would jump; a click jumps there.
- **The picture**: a click plays or pauses (closing an open menu or tab instead); a double-click
  goes full screen.
- **Idle**: while playing, the controls, the Back button and the cursor go after 3 s without a mouse
  move. They stay while paused, while the mouse is over the controls (or Back), or while a menu is open.
- **Keys**: M mutes, N plays the next episode; the arrows keep the remote's meaning (they never change
  the volume), Space and F as above. After an arrow key the player looks as on the TV: the focus marks
  come back, the transport row steps aside, a row of key hints shows what the keys do where the focus
  is ("← → Move · ↓ Back to the bar · Space Pause · ? Shortcuts"), and a focused icon shows its
  tooltip with Enter ("Subtitles [Enter]"). A mouse move brings the transport row back.
- **The first time** the player opens with a mouse in a browser, a strip at the top shows the main
  keys ("Esc Back · Space Pause · ← → −10 s / +30 s · ? All shortcuts"); it fades after 6 s or on a
  click (`pl.tip.firstPlay` in `localStorage`).
- **Live TV** keeps its own banner and guide; it gets the Back button, the 3 s hiding of the banner and
  cursor, M to mute and a double-click for full screen.

**Phones and tablets.** Not designed for yet. In portrait the whole TV layout shrinks to the
screen's width, so it is usable (tap is click, a long press is hold OK, pinch to zoom) but small. A
proper mobile layout would need: a layout that reflows below ~900 px (one-column details page,
a smaller hero, two or three posters across, a bottom tab bar instead of the top pill), touch scrolling
of rows and grids instead of focus-driven translation, a touch player (tap to show controls, drag the
bar, double-tap to skip), larger hit targets, no hover-only focus, and testing on iOS Safari (native
HLS only, no Media Source) and Android Chrome.

## Plugins

- **External web plugins** (Settings → Browse plugins, e.g. Hello Shelf) work. The page's
  Content-Security-Policy forbids inline scripts, and a `srcdoc` frame would inherit it, so on the web
  each plugin runs in `web/plugin-frame.html`: a sandboxed frame without `allow-same-origin` (an opaque
  origin with no access to the app's storage or page) and its own policy allowing inline script but
  no network, images, styles or frames. The app sends it the plugin's document by `postMessage`.
  A plugin's network permission is subject to that server's CORS like any web page.
- **Service plugins** (catalogue entries of kind "service") need a webOS background service; the web
  build shows them as "TV app only". A bundled plugin that has its own browser path says so with
  `web: true` in its definition (docs/PLUGINS.md) and runs on the web without its services.
- **Overseerr / Seerr** works on the web when Overseerr is set up for it: on the TV it goes through
  its webOS service, in the browser `plugins/overseerr/seerr-web.js` calls your Overseerr straight from
  the page (the build adds it after `seerr.js`; the TV never loads it). A browser allows that only if

  1. **Plex Lite is on the same site as Overseerr**: a subdomain of the same domain
     (`plexlite.example.com` next to `overseerr.example.com`), because Overseerr keeps its sign-in in
     a `SameSite=Lax` cookie that browsers send only to pages on the same site; and
  2. **Overseerr's reverse proxy allows that origin with credentials and answers preflights**
     (Overseerr itself sends no CORS headers and answers `OPTIONS` with 405), and Overseerr's CSRF
     protection is off (the default).

  So it can't work on https://plexlite.vercel.app (no one's Overseerr is on that site); deploy your
  own copy on your own subdomain. Setup, proxy examples (Nginx / Nginx Proxy Manager, Cloudflare
  Worker), Overseerr's settings and what Plex Lite shows when something is missing:
  [OVERSEERR.md, "On the web"](OVERSEERR.md#on-the-web). Other ways considered and not built: CORS
  for a foreign site with the cookie rewritten to `SameSite=None` (Chrome only; Safari and Firefox
  block third-party cookies), or a proxy on Vercel that signs in for you (your Plex token and
  Overseerr session would pass through it).

## Security

- **Content-Security-Policy** (`vercel.json`): `default-src 'self'; script-src 'self'; style-src
  'self'`, no inline script or eval anywhere; images and media from `https:` (Plex servers have
  per-server `*.plex.direct` names and you may type your own https address), `blob:` for hls.js's
  media source and worker; `connect-src 'self' https:` (below); `frame-src 'self'` (the plugin
  frame); `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`,
  `upgrade-insecure-requests`.
- **Why `connect-src 'self' https:`.** The page calls addresses that differ for every user: each Plex
  server has its own `*.plex.direct` name, a server address can be typed in, and the Overseerr
  plugin calls the Overseerr address the user types in. A policy is one static header for every
  visitor (and every domain the deployment is served on), so it can't list them, and CSP has no
  "same site as this page" source. `https:` is the narrowest rule that still works: plain `http:`,
  `ws:` and other schemes stay blocked (a page served over https couldn't use them anyway), and what
  the page can *read* from another server is still decided by that server's CORS, which is what keeps
  Overseerr closed to sites it doesn't allow. The defence against injected code is `script-src
  'self'` with no inline script, not `connect-src`. If you deploy your own copy for one household you
  can tighten it in `vercel.json` to your addresses, for example `connect-src 'self' https://plex.tv
  https://*.plex.tv https://*.plex.direct https://overseerr.example.com
  https://raw.githubusercontent.com` (the last one is the plugin catalogue). That breaks a server
  address typed in under Settings and plugins with network permission unless you add their hosts.
- Also: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  (Plex URLs carry the token, so no page address leaks either), HSTS,
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` (keeps the sign-in popup working),
  `Cross-Origin-Resource-Policy: same-origin` and a `Permissions-Policy` that turns off camera,
  microphone, location, payment and device APIs.
- The site has no server code and no environment variables or secrets. Logs redact the token.

## Limits

- Service plugins: TV app only. Overseerr / Seerr: only where Plex Lite is on the same site as
  Overseerr and Overseerr's proxy allows it (see above); not on plexlite.vercel.app.
- Formats the browser can't decode are converted by the server (more load than the TV, which direct
  plays HEVC 10-bit and E-AC3). Audio is stereo.
- Text subtitles are drawn by Plex Lite, as on the TV (no styling from ASS/SSA).
- PIN-protected Plex Home profiles aren't supported (same as the TV).
- The server's local address needs Chrome's local-network permission; without it streams go through
  Remote Access or the relay.
- No Chromecast/AirPlay, no picture-in-picture button, no offline downloads.
- Phones: usable but not designed for (see above).

## Building and deploying

```sh
node tools/build-web.mjs        # writes dist/web/
node tools/serve-web.mjs        # http://127.0.0.1:8940 with the vercel.json headers
```

Vercel builds every push: `main` goes to production (https://plexlite.vercel.app) and other
branches get preview deployments (behind Vercel's login). The project needs no environment variables.
