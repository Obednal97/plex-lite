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
| `--resume` | `#5ad6e2` | progress bars (brand teal, matches the icon) |

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
  The A–Z rail (title sort only) lives in the 94 px right of the last column: 27 letters at a 26 px
  pitch in 20 px `--text-2` (one of the few places below the 24 px floor, like badges), empty letters
  at 30% opacity. The current letter sits on a soft `--fill-hi` pill; when the rail has focus that
  pill becomes the white plate, like every other focused control. A jump flashes the letter (or a
  number key's group, the chosen letter lit) in a lit-glass tile for a moment.
- **Details:** full-bleed art; ratings and badges as 1 px keylines; dark capsule actions with Phosphor
  icons; borderless season tabs; episodes with titles on the art.
- **Search:** the query is the headline (48 px with an underline), not a boxed field; flat keys.
  With Live TV, two rows follow Movies & Shows (local, so they never move when the server's People
  and Episodes arrive): **Channels**, 360×202 quiet tiles with the guide's light logo plate, the
  number top right (teal ★ for favourites), the name and what's on now over a teal progress line;
  **On TV**, landscape programme cards with the title on the art, a red LIVE pill (or the start
  time) top left and a small logo plate top right (`css/search-tv.css`). When the query is about
  channels (a word of a channel's name or a channel number starts with it, and no library title is
  exactly it), Channels and On TV go above Movies & Shows; On TV stays in view without scrolling.
- **Channel logo plates** (guide, Search): light by default; a logo that would be lost on it (white,
  silver or pale on a transparent background, with little that is dark) gets a dark `#3b3e46` plate
  with a hairline rim. Each logo is sampled once in a 32×16 canvas (Plex sends CORS headers);
  mid-grey if it can't be read (`js/logos.js`, `css/logos.css`).
- **Settings:** quiet rows on the ground (hairline separators), white plate on focus.
- **Live TV** (spec and remote tables in [LIVETV-v2-design.md](LIVETV-v2-design.md)): a two-hour time
  grid on the plain ground, six channels down. The focused programme's details sit above it like a small
  hero (red LIVE pill, 48 px title, a two-line synopsis, 400×225 art at the right); a ruler with a teal
  "now" pill and a 2 px teal now line. Cells are quiet `rgba(255,255,255,.06)` tiles (on-now ones a little
  lighter) with 26 px titles; the focused cell is the white plate. Channel logos sit on a light plate,
  as on the player. Number entry is a lit-glass tile over the art. The live player keeps player v2's
  bottom block (scrim, eyebrow, 64 px title, round icons, keycap hints) with a logo plate, a programme
  bar (aired / position / live edge) instead of the seek bar, and "Next …" on the right; the mini guide
  is a column of rows over a left wedge scrim while the picture keeps playing.
- **Sheets, toasts, Up Next:** lit glass (gradient fill + rim + soft shadow), opaque enough that
  no live blur is needed.
- **Player** (Apple TV app first, Netflix second; spec and remote table in
  [PLAYER-v2-design.md](PLAYER-v2-design.md)): nothing on screen while watching. Any key raises one
  bottom block over a 520 px ink scrim: eyebrow (year, or "Show · S1 E2") and a 64 px title, round
  68 px icons on the right (Subtitles, Audio when there is more than one track, Next episode; the focus is one white disc that travels between them), the
  bar, the times, and text tabs (Info, Cast, Chapters, Episodes). The bar is the main control: one
  segment per chapter with 6 px gaps, 6 px at rest, 10 px with a white head when focused, filled in
  `--resume`; Left/Right jump −10 s / +30 s at once. Paused or scrubbing: a 30% veil, a 12 px bar,
  a teal tick at the real position, a time label riding the target (48 px time and the chapter
  on a dark plate with a caret; Plex's index frame with a white rim instead, on servers that make
  preview thumbnails), "Paused at 9:13 · jumping to Chapter 5" and
  `[OK] Jump here` `[Back] Return` hints. Subtitles and Audio open a 540 px lit-glass menu over
  their icon (with a caret) while the video plays; "Size and style" swaps in Small / Medium /
  Large. A tab slides the block up 292 px for a row of 320×180 cards (or the Info synopsis and
  facts). Skip Intro / Skip Credits is an 80 px white pill bottom right with a teal line for the
  time left, over a corner scrim; the end card (Up next, title, runtime, still, Watch Credits and
  a counting-down Next Episode) sits in the same corner. Both rise 210 px above the icons when the
  controls open and step aside while a menu or tab is open. Layout, bottom up: tabs 44, times 112,
  bar 165, title and icons 214, menus 306.

## Performance rules (unchanged)

No `backdrop-filter`, CSS grid, flex `gap`, `clamp()`; animate transform/opacity only; one shared
focus shadow; artwork is resized and pre-blurred by the Plex server; minimal DOM (virtualised
shelves and grid).
