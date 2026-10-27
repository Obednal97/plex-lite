# Plex Lite design language ("2030")

The goal: calm, art-first, legible from the couch, and cheap to draw on a 2019 TV (Chrome 53,
1.1 GHz Cortex-A55, weak GPU). The direction is what Netflix and Apple TV are converging on: less
chrome, more breathing room, bigger artwork, one unmistakable focus, and nothing that glows unless it
has focus. The implementation lives in `css/theme.css` (loaded last, over the component CSS) plus a
few layout constants in `js/ui.js` and `js/screens/library.js`.

## What we learned from PlxNative

PlxNative (a native Rust/GL Plex client for webOS, GPL-3.0) feels fresh for reasons that are
design decisions rather than technology. We studied its public docs and screenshots and took the
ideas, not the code:

- **The ground is mid-grey, not black.** Apple TV's shelf grey makes art pop and route changes feel
  soft; pure black makes everything look heavy (and on an IPS panel "black" is grey anyway).
- **Artwork is full-bleed** and text is protected by graded scrims (a left wedge plus a bottom ramp
  into the ground), not by boxes or chips behind text.
- **Fewer, larger cards.** Posters ~250 px wide, six per row; captions appear only under the focused
  card instead of under every card.
- **Focus is a "lit glass" edge** (thin bright rim, brighter crown on the top edge, a soft sheen) plus
  a gentle scale and one soft shadow. No thick coloured rings.
- **Landscape cards carry their title on the art** over a short bottom scrim.
- **Text never goes below 24 px** for product content (couch distance); type is a small fixed scale.
- **Chrome is quiet:** text tabs, one white plate for focus, glass only for floating things.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--ground` | `#2b2b2e` | page background everywhere except the player |
| `--ink` | `#050508` | scrims behind text on artwork |
| `--text` | `#f7fafc` | titles, focused labels |
| `--text-2` | `#b8bfcc` | meta lines, captions |
| `--text-3` | `#9499a3` | counts, tertiary |
| `--reading` | `#cdd3dd` | synopses |
| `--fill` / `--fill-hi` | white 10% / 20% | idle / selected controls on the ground |
| `--control` | `rgba(34,34,36,.92)` | idle buttons over artwork |
| `--rim` / `--rim-light` | white 14% / 28% | 1 px edges of floating glass |
| `--focus` / `--focus-ink` | `#f7fafc` / `#08080a` | the one focused fill and its text |
| `--resume` | `#fab82e` | progress bars (Plex amber) |

**Type scale** (TV font "LG Display"): 72 hero title · 48 page/search/OSD title · 32 row headings ·
28 meta, tabs, buttons, rows · 26 synopsis, card titles · 24 captions (floor) · 20–22 only for
badges and channel names. Weights 500/600/700.

**Spacing:** 8-pt grid (8/16/24/40/64). Safe margins 96 px left/right, 54 px top/bottom. Row
heading → cards: 60 px. Shelf pitch: posters 280, landscape 448, people 230.

**Radii:** cards 14 · pills/tabs/keys full · sheets 30 · rows 16.

**Elevation & focus:** at rest, cards have a 1 px 8% rim. Focused: scale 1.09 (1.13 for people
circles), lit-glass edge, and the single shared shadow `0 26px 50px rgba(0,0,0,.5)` that moves with
focus (never a shadow per card). Buttons, tabs, chips, keys, rows and sheet rows focus to a solid
white plate with dark text; nothing else on screen is that bright. The primary button is translucent
until it has focus.

**Motion:** `cubic-bezier(.2,.8,.2,1)`; 120 ms state, 200 ms focus pop, 260 ms scroll, 300 ms fades.
Transform and opacity only.

## Screen notes

- **Recommended:** full-bleed hero art of the focused item, title/meta/synopsis in a 760–860 px
  column, shelves below with headings in primary white.
- **Library:** borderless sub-nav and sort/filter tabs; 6 × 250 px posters, caption under focus.
- **Details:** full-bleed art; ratings and badges as 1 px keylines; dark capsule actions with Phosphor
  icons; borderless season tabs; episodes with titles on the art.
- **Search:** the query is the headline (48 px with an underline), not a boxed field; flat keys.
- **Live TV, Settings:** quiet rows on the ground (hairline separators), white plate on focus.
- **Sheets, toasts, Up Next:** lit glass (gradient fill + rim + soft shadow), opaque enough that
  no live blur is needed.
- **Player:** 48 px title, 6 px hairline rail, times at 24 px, deep bottom scrim only.

## Performance rules (unchanged)

No `backdrop-filter`, CSS grid, flex `gap`, `clamp()`; animate transform/opacity only; one shared
focus shadow; artwork is resized and pre-blurred by the Plex server; minimal DOM (virtualised
shelves and grid).
