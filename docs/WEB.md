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
| `web/web-desktop.js` | Laptop and desktop: the Back [Esc] button, tooltips that name their key, the `/` `M` `N` `?` keys and the `?` shortcuts overlay. |
| `web/web.js` | Who we are to Plex (browser and OS), the stage fitted to the window, keyboard and mouse for the remote's buttons, the browser's Back button, Chrome's local-network permission, Settings rows, ending sessions when the page goes away. |
| `web/web-player.js` | The player with a mouse: transport row, volume, full screen, tooltips, hiding after 3 s, M and N (see [Player with a mouse](#player-with-a-mouse)). |
| `web/web-cards.js` | Cards and rows with a mouse: hover cards with ▶ and "…", row arrows, the hero following the mouse (see [Cards and rows with a mouse](#cards-and-rows-with-a-mouse)). |
| `web/web-signin.js` | Plex's own sign-in page in a popup, for the first-run screens ([docs/FIRSTRUN.md](FIRSTRUN.md)). |
| `web/firstrun-web.css` | The first-run screens' full-window, responsive layout (phones included). |
| `web/fonts/` | Inter (OFL), the web build's typeface, self-hosted. |
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

The first-run screens (welcome, sign-in, Who's watching, PIN, connecting, errors) are drawn outside
the scaled stage, at the window's own size, with a layout for desktops, phones in either orientation
and ultrawide screens: see [docs/FIRSTRUN.md](FIRSTRUN.md).

**Sign in with Plex** asks plex.tv for a PIN and opens Plex's own sign-in page
(`app.plex.tv/auth`, with the PIN's code, this browser's client identifier and "Plex Lite" as the
product) in a popup. Plex Lite polls the PIN every 2 seconds until Plex hands over the sign-in, then
closes the popup. If the browser blocks the popup, Plex Lite says so and offers **Continue in this
tab**: Plex's page opens in the tab and sends the browser back afterwards, which finishes the sign-in
(the PIN waits in `sessionStorage`). **Use a code instead** shows the TV's four-character code for
plex.tv/link and a QR code that opens that page with the code filled in.

- Each browser is its own Plex device: a random client identifier in `localStorage`, shown in Plex as
  "Plex Lite (Chrome on macOS)" (product Plex Lite, platform the browser, device the OS).
- Plex Home: Who's watching? follows the sign-in when the account has profiles (PIN-protected ones
  ask for the PIN), and Settings → Profile opens it again.
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
asks to let the site "look for and connect to any device on your local network". Plex Lite explains
this first, and the request waits for Continue (Skip uses Remote Access). Allow it to stream
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

**The window.** The app is laid out 1920 px wide and scaled to the window's width
(`transform: scale` on the page, so text is redrawn at the final size). The stage's height follows the
window instead of being fixed at the TV's 1080: a 1440x900 window gets a 1920x1200 stage, a
1920x960 one 1920x960, so there are no bars. `web/web.js` sets it as `--stage-h` on `<html>` and
`PL.ui.SCREEN_H` (and fires `pl-stageresize` on `document` when it changes); `web/web.css` gives
everything that spans the screen that height (backdrops, screens, the player's video, the guide's
grid, sheets) and keeps the home hero where it sits on the TV. Limits: below 900 stage px (an
ultra-wide or very short window) the stage stays 900 tall with bars at the sides; taller than
1440 (narrower than 4:3) it falls back to the 1920x1080 stage fitted with bars; phones and narrow
windows get the touch layout instead ([Phones and tablets](#phones-and-tablets)).
The TV's stage is always 1920x1080.

**Mouse and keyboard.** With a mouse (`PL.input.mode()` is `pointer`):

- **Back [Esc]** sits at the top left of every screen above the tab bar (details, people, sheets,
  the player while its controls are up). In remote mode it isn't shown: the remote has Back.
- **Tooltips name the key** that does the same (`PL.web.tip(node, text, key)`: "Close [Esc]",
  "Full screen [F]").
- **Keys added on the web:** `/` goes to Search from anywhere, `?` opens the keyboard shortcuts
  (also Settings → Keyboard shortcuts; Esc, Enter or `?` close it), `M` mutes and `N` plays the next
  episode while watching. On Search these letters type. The arrows keep their remote meaning
  everywhere (they never change the volume).

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
| `/`, `?`, M, N | Search, the shortcuts, mute, next episode (web only) |

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

### Cards and rows with a mouse

In the mouse and keyboard mode (`web/web-cards.js`, `web/web-cards.css`), while the mouse is the last
input used:

- **A hovered card** lifts (1.07, with one shared shadow element, as the TV's focus shadow) and shows
  **▶** in the middle and **"…"** in the top-right corner. ▶ plays at once: a movie or episode
  resumes where it was left (or starts), a show plays what its details page would (the next
  episode on deck, else the first), a season its first unfinished episode. "…" (tooltip "More
  options [Right-click]") opens the same quick actions as hold OK or a right-click. Clicking the
  card itself opens its details, as before. Plex Lite has no watchlist or "add to" action yet, so there
  is no **+**. Only standard Plex cards get ▶ and "…" (movies, episodes, shows, seasons); channels,
  extras, people and plugin cards just lift.
- **Rows** show **›** at the right edge (over a fade) when there is more, and **‹** once scrolled;
  only while the mouse is over the row. Each click pages by the cards that fit whole (the card cut
  off at the edge leads the next page). Paging moves the row's own position, so the arrow keys carry
  on from the page on screen. A row scrolled past (dimmed) comes back up under the mouse.
- **The Recommended hero follows the card the mouse rests on**, as it follows the focus on the TV:
  after 350 ms on one card. Sweeping across a row, or leaving it, changes nothing.
- **The library grid** gets the lift, ▶ and "…", without arrows.
- **Details buttons** name what they do in a tooltip from their hint ("Shuffle all episodes" under
  Shuffle, "Play from the beginning" under From start).

Arrow keys, Enter or Tab bring the TV's focus plate back and hide all of this (`data-nav="keys"`);
the next mouse move brings it back. In remote mode (Settings → Controls, TV browsers) and touch mode
none of it appears, and the TV app never loads these files. The hooks wrap `PL.ui.Shelf`,
`PL.ui.Grid` and `PL.ui.ButtonRow` methods from the web layer; no shared file changes.

## Phones and tablets

Phones and tablets get their own layout instead of the scaled TV stage: one column on a phone
(under 600 px wide), two columns on a tablet, four bottom tabs (Movies, TV Shows, Live TV, Search),
the profile picture at the top right for Settings, rows that scroll sideways with the next card
peeking in, a Back chevron, sheets from the bottom, the system keyboard for Search, no key hints,
44 px touch targets and the screen's safe areas. It lives in `web/touch/` and is a separate layer:
the TV never loads it and the 1920x1080 screens are not reflowed. It reuses the shared Plex and
data code (`js/plex.js`, `js/ui.js`'s item helpers, `PL.liveGuide`, `PL.plugins`, `PL.az`...).

**When it takes over.** Windows under 1100 px wide (phones, portrait tablets, a narrow browser
window), and touch-first devices up to 1400 px (an iPad in landscape: the TV layout doesn't scroll
by touch). Wider windows and Settings → Controls → Remote keep the TV stage. It is decided again when
the window changes size or the Controls setting changes, but never while a stage screen (the
player) is open. Sign-in and the first-run screens stay as they are.

| File | What it does |
| --- | --- |
| `web/touch/manifest.json` | The layer's scripts and stylesheets, in load order (`tools/build-web.mjs` adds them after everything else). |
| `web/touch/logic.js` | Pure decisions, tested in `test/touch.test.mjs`: when to take over, phone or tablet, the tabs, Back at the top, image sizes, quick actions. |
| `web/touch/kit.js` | Building blocks (`PL.touch.ui`): icons, buttons, chips, poster and wide cards, shelves, the endless grid, top bar, Back bar. |
| `web/touch/shell.js` | Taking over from the stage, the tabs, a stack of pages per tab, Back, the hand-off to the player and other stage screens. |
| `web/touch/sheets.js` | Bottom sheets (a centred card on a tablet), a title's quick actions, toasts, confirmations. |
| `web/touch/screens/*.js` | The screens. A screen not built yet opens the TV's version on the stage. |
| `web/touch/live/` | Live TV (see [Live TV on phones and tablets](#live-tv-on-phones-and-tablets)). |

**How it sits on the app.** While the layer is in charge, the stage's root screen is a stand-in
that passes Back to the layer, `<html>` has the class `pl-touch` (the stage is hidden, the page
scrolls like a web page) and `t-phone` or `t-tablet` (and `t-short` on a phone on its side). The
layer wraps `PL.app.selectTab`, `setRoot`, `push`, `pop` and `replaceTop`; the wrappers pass straight
through unless the layer is wanted or in charge, so the laptop and TV paths never run them. A stage
screen pushed on top (the player, the TV guide) shows the stage again, scaled as before, until it
closes; then the layer comes back and the page refreshes its progress. The browser's Back button,
Android's Back and Esc go through `web/web.js` to the stand-in: a sheet closes, then a page pops,
then the top of another tab goes to the start tab, then the browser may leave the site.

**For the touch player and the phone guide (phases 3 and 4).**

```js
PL.touch.play(item, opts)   // plays a title; opts as PL.screens.player ({offset})
PL.touch.playLive(live)     // tunes a channel; live as js/screens/livetv.js playList builds it
PL.touch.screens.live()     // the Live TV tab's root page
```

Today `play` and `playLive` push the TV player on the stage. Replace them (and the Live TV tab's
page) and everything in the layer uses the new ones. A page is `{el, onShow({back}), onHide(),
destroy(), onReselect()}`; `PL.touch.push(page)`, `PL.touch.back()`, `PL.touch.sheet({...})`,
`PL.touch.menu(item)` and `PL.touch.toast(text)` are the rest of the shell.

**Long press.** `web/web.js` turns a 550 ms press into a `contextmenu` event (Android sends its own);
`PL.touch.ui.onHold` opens the title's quick actions from it, and the click at the end of the press
is swallowed. Every title also has a "…" button.

### Live TV on phones and tablets

The Live TV tab (board P4) uses the TV's guide data and rules unchanged (`js/livetv-data.js`,
`js/livetv-logic.js`, `js/livetv-browse.js`, `js/livetv-search.js`, the logo plates in `js/logos.js`);
only the screens are new.

| File | What it does |
| --- | --- |
| `live/logic.js` | Pure parts, tested in `test/touch-live.test.mjs`: the grid's sizes, which rows and hours to build, cell labels, the chips, Last watched, the number pad. |
| `live/parts.js` | `PL.touch.live`: watching (through `PL.touch.playLive`), Last watched, logo plates, a programme's details, the long-press actions, the filter sheet, Go to channel. |
| `live/grid.js` | The time grid. |
| `live/onnow.js` | On now as a feed. |
| `live/search.js` | Searching channels and programmes from the guide. |
| `live/guide.js` | The tab's page (`PL.touch.screens.live`). |
| `live/live.css` | Their styles. |

- **The page** is one scroller that scrolls both ways. The header (search, Go to channel, the filter
  and the profile), the chips and Last watched scroll away upwards and never sideways; the time ruler
  sticks under the status bar, the channel column (logo plate and number) sticks on the left, and a
  long programme keeps its title in view while it scrolls off to the left. All of that is
  `position: sticky`, so nothing waits on script while scrolling.
- **Chips:** Favourites, All, On now and the categories (Entertainment, Movies, Sport...). The filter
  button opens the TV's Browse rail as a sheet: the same choices with counts, the channel families,
  and the current choice narrowed by the other dimension (a category's families, a family's
  categories). A family gets its own chip while chosen. The choice is the TV guide's, saved per server.
- **Opens on Favourites** whenever there are some (the owner's choice, as on the TV), else on the
  last choice. With none, Favourites says how to add some.
- **Taps:** a programme on now plays (`PL.touch.playLive`, with the guide's filter as the channel
  list, so channel up/down stay inside it); a later one opens its details (art, time, synopsis,
  Watch the channel now, Favourite). A long press on a programme or a channel: Watch, Favourite,
  Details. A tap on a channel's logo plays it.
- **Last watched:** the channels watched most recently (per server, newest first), each a card with
  what is on now and a Play button. The player reports the channel that was on in
  `PL.liveGuide.watching` when it closes (the TV player already does), so a channel changed inside
  the player counts too.
- **On now** is the TV's On now wall as a feed: Favourites, then each category, shelves of 16:9
  cards that scroll sideways; a card's art and logo load only when it nears the screen.
- **Go to channel:** a number pad sheet. It shows the channel the digits mean (exact, starting with
  them, else the nearest, as on the TV) with what is on; Watch, or Show in guide (switching to All
  channels when the filter hides it).
- **Tablets** get bigger rows, wider half hours and a wider channel column; a phone on its side gets
  shorter rows.
- **Speed.** Rows are virtualised: only the rows in view plus six each way exist, each with the
  programmes of the hours in view plus one either side. Scrolling sideways adds and drops cells hour by
  hour and keeps the rest; new guide data rebuilds only the rows whose programmes changed; logo plates
  are made once per channel. Measured with 600 channels on an emulated iPhone (headless Chromium with
  the CPU slowed 4x, and WebKit): a vertical fling holds 60 fps with under 1.5 ms of script per frame
  and never shows an unbuilt row; scrolling sideways at 9,000 px/s keeps about 95% of frames under 20 ms.

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
- Phones and tablets: the touch player is still the TV's, scaled to the screen (see above).

## Building and deploying

```sh
node tools/build-web.mjs        # writes dist/web/
node tools/serve-web.mjs        # http://127.0.0.1:8940 with the vercel.json headers
```

Vercel builds every push: `main` goes to production (https://plexlite.vercel.app) and other
branches get preview deployments (behind Vercel's login). The project needs no environment variables.
