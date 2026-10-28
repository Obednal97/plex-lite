# First run: signing in, Who's watching, connecting

Plex Lite's first screens, on the TV and on the web: the poster-wall design ("Direction A").
A dimmed, slowly drifting wall of free-licence posters sits behind every step: sharp on the welcome
and sign-in screens, a pre-blurred copy behind the later ones.

| File | |
| --- | --- |
| `js/firstrun-logic.js` | The decisions, with no DOM: views and transitions (a reducer), Back, the PIN rules, the local-network gate, error codes to sheets, the web layout and zoom. Tested in `test/firstrun.test.mjs`. |
| `js/screens/firstrun.js` | Draws the views and runs the effects: link codes and polling, Plex Home profiles and PINs, connecting with a row per route, the errors. Its own small input model (below). |
| `css/firstrun.css` | Looks and the desktop board's sizes, plus the TV's (T1, T2). Chrome 53 rules, like the rest of the TV's CSS. |
| `web/firstrun-web.css` | The web build's full-window, responsive layout. Modern CSS: the TV never loads it, and `tools/check.mjs` lets it off. |
| `web/web-signin.js` | Plex's own sign-in page in a popup (or this tab when popups are blocked). |
| `img/firstrun/` | The wall (`wall.jpg` 2400 px, `wall-phone.jpg`, the blurred `wall-soft.jpg`) from `tools/make-wall.mjs`, and the wordmark. |
| `js/vendor/qrcodegen.js` | Project Nayuki's QR code generator (MIT), compiled to ES2015. |
| `web/fonts/` | Inter (OFL), the web build's typeface. The TV keeps LG Display. |

## The flow

```
web:  Welcome ──Sign in with Plex──▶ Waiting (popup) ─┐      popup blocked ─▶ "Continue in this tab" / code
         └────Use a code instead───▶ Code + QR ───────┤
TV:                                  Code + QR ───────┤
                                                       ▼
                        Who's watching? (Plex Home only) ──▶ PIN (protected profiles)
                                                       ▼
                 [web] local-network explainer (when the browser would ask) ──▶ Connecting ──▶ the app
                                                                                  └─▶ errors
```

- **Welcome** (web): a strong PIN is fetched in advance, so the popup opens inside the click.
  Popups blocked: a card offers "Continue in this tab" (Plex sends the browser back and the sign-in
  finishes) or the code. A PIN that expires while waiting returns to Welcome with a note.
- **Code** (A2, T1): plex.tv/link and a four-character code, renewed before it expires. The QR code
  opens `https://plex.tv/link/?token=<code>`: plex.tv's link form fills the code in from `?token=`
  (and keeps it through Plex's own sign-in), so scanning needs only a tap on Link. On the TV, OK asks
  for a new code and Back exits. On a phone the QR is left out (the phone is the device in hand).
- **Who's watching?** (A3, T2): only when the account has Plex Home profiles; remembered on each
  browser or TV; Settings → Profile opens it again (Back returns to Settings unchanged). The owner
  keeps the account's sign-in; other profiles switch (`plex.switchToken`).
- **PIN** (A4): digits by keyboard, the remote's number keys or the keypad. The fourth digit submits;
  a wrong PIN shakes the dots (transform only), clears them and says so. Back returns to the picker.
- **Local network** (A5, web): before the first request to the server's local address, when the
  browser reports the permission as `prompt` (`local-network-access`, else `local-network`). That
  request waits for Continue (then Chrome asks) or Skip (Remote Access; remembered, and Settings →
  Local network access can look again). Not shown when it is granted or denied, or for a background
  check (`plex.lanGate`).
- **Connecting** (A6): "Signed in as …", then a row per route (home network, Remote Access, relay)
  as `plex.connect` reports them. An ordinary launch keeps the stage's loading screen and only brings
  the layer up to ask (A5) or to say what went wrong.
- **Errors** (A7, A8): `plex.ensureServer` and the app's start reject with `err.code`:
  `NO_SERVER`, `UNREACHABLE` (with `err.routes`: each route's result), `NO_SECURE_ADDRESS` (web),
  `NO_LIBRARIES` / `NO_ACCESS` (this profile sees no film or TV library, or the server turned it
  away), and plex.tv failures carry `err.plexTv`. Each sheet has Try again and a way out (another
  server, another profile, sign out).

## Back

Back (Esc, Backspace outside the PIN, the remote's Back, the browser's Back button) steps back
through the flow: Waiting, the blocked card and the code return to Welcome on the web; the PIN
returns to the picker; an error returns to the picker on a first run with profiles. Where there is
nothing to go back to, the TV app exits and the browser leaves the page.

## Input

Self-contained in `js/screens/firstrun.js`, deliberately simple (another design covers the rest of the
app's web input): arrows move to the nearest focusable in that direction by position (rows, columns,
the keypad, a phone's 2×2 grid), Enter/OK acts, a mouse move or a tap focuses and a click acts (a view
that appears under a resting pointer doesn't steal the focus), Tab follows. Buttons are real
`<button>`s. One white plate travels between the buttons of a row or column (`ui.Glider` with its
`twoD` option, `PL.glideTo`, the motion tokens in `css/motion.css`); avatars grow 1.09 with a white
rim, labels never scale. Touch targets are at least 44 px.

Worth sharing with the rest of the app later: the positional arrow navigation, the "real mouse
movement only" hover rule, and the 2D glider.

## The web layout

The layer sits outside the scaled 1920×1080 stage (`html.fr-on`: `web/web.js` leaves the stage
unscaled and hidden while it shows). `PL.firstrunLogic.webLayout` picks one of three layouts and
`webZoom` a zoom factor:

| Layout | When | |
| --- | --- | --- |
| `desk` | otherwise | The 1440×900 boards, zoomed 0.7 to 1.45 by the window; the margin widens on wide screens (ultrawide 2560×1080: 160 px). |
| `stack` | portrait below 1024 px wide, or under 700 px | Phones: the welcome block at the bottom; codes, profiles (2×2), PIN and the sheets in one column with the buttons at the bottom; tablets zoom it up to 1.35. |
| `short` | landscape, 500 px tall or less | A compact left column on the welcome screen; other views scroll. |

## The TV

The same views in the stage, ES2015 and Chrome 53 CSS (no flex gap, grid, clamp or backdrop-filter;
transform and opacity animations only). T1 and T2 have their own sizes; the PIN, connecting and error
sheets use the desktop sizes at 1.25×. The wall is one layer drifting by `translate3d` over 90 s;
`PL.storage` key `firstrun.drift` (`false`) turns the drift off, for measuring its cost on the TV.

## The wall and its credits

`tools/make-wall.mjs` composes the wall from the demo library's posters (`tools/demo`, Blender open
movies under CC BY / CC BY-SA and public-domain classics) with ImageMagick. The welcome screen
credits them in a line and THIRD-PARTY-NOTICES.md lists each poster. Images: `wall.jpg` 442 KB,
`wall-phone.jpg` 140 KB (phones), `wall-soft.jpg` 12 KB. Inter: 48 KB (Latin; Latin Extended 85 KB,
fetched only for those characters).
