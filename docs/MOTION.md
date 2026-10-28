# Motion

How Plex Lite moves, and where the numbers come from.

The reference is PlxNative (github.com/GLinnik21/plx-native, GPL-3.0), a native Plex client for the
same TVs that feels noticeably smoother than ours. We studied its motion system and describe it here
in our own words. No code or assets were copied: Plex Lite is a web app on Chrome 53, so everything
below is reimplemented with CSS transitions and a little JS.

## What PlxNative does

**Every user-steered value is a critically-damped spring**, integrated per frame:

    w = sqrt(k)
    x(t) = target + (x0 + (v0 + w * x0) * t) * e^(-w * t)     (x0 = start - target)

A critically-damped spring never overshoots and keeps its velocity when the target moves mid-flight.
Pressing right three times quickly produces one continuous glide, not three restarts. That, more
than any single duration, is why it feels smooth.

Stiffness (k) per role:

| Role | k | 98% settle |
| --- | --- | --- |
| Focus pop (card scale) | 320 | 326 ms |
| Row / page scroll | 170 | 447 ms |
| Snap | 200 | 412 ms |
| Tab capsule glide (x and width) | 240 | 377 ms |
| Popovers / panels appearing (rise 20 px) | 300 | 337 ms |
| Press dip / release | 620 / 340 | 234 / 316 ms |

Other parameters:

- **Focus scale:** cards 1.07; episode cards 1.04 with a 6 px lift; text buttons 1.05. A press dips
  to 0.918 and commits after 120 ms (long press 500 ms).
- **Content crossfade** (changing the hero, swapping a section) is *timed*, not a spring, because
  it gates a state commit: fade out 70 ms, swap the content at opacity 0, fade in 140 ms.
- **Tab strip:** one selection plate per strip. On the top bar the plate *travels* with focus. On
  secondary strips (seasons) it *lands*: a plate that was off screen appears in place instead of
  sweeping across.
- **Glass:** real background blur is impossible over video, so the "glass" is a dark vertical
  gradient scrim (about 0.20 to 0.36 black), a hairline rim, and a brighter top edge.
- **Artwork:** art that arrives after its skeleton dissolves in; cached art is drawn at once.
  Skeleton shimmer period 1.5 s. When a row's contents change, surviving cards slide to their new
  slots and removed cards fade out in place.
- **Title logos:** Plex `clearLogo` images are sized to a *constant area* (about 72,000 px² in the
  hero, 14,580 px² compact) so wide and tall logos carry the same visual weight. They sit at the
  bottom of a reserved band and grow upward.

## How it maps onto Chrome 53

Chrome 53 has no spring timing function and no Web Animations composition, so each spring becomes a
CSS transition (`css/motion.css`):

- **Curve.** `--spring: cubic-bezier(0.2, 0.06, 0.22, 0.96)` was fitted numerically to the
  critically-damped step response over its 98% settle window (max error 0.007). The duration is that
  settle time, so one curve serves every stiffness: `--t-pop` 326 ms, `--t-scroll` 447 ms,
  `--t-cap` 377 ms, `--t-appear` 337 ms, `--t-out` / `--t-in` 70 / 140 ms.
- **Retargeting.** A CSS transition restarts from rest when its target changes, which feels like a
  stutter under key repeat. `ui.glide(el, owner)` adds a `.glide` class when the previous move was
  under 380 ms ago; `--glide: cubic-bezier(0.12, 0.5, 0.25, 1)` starts at speed, approximating the
  spring's carried velocity. Used by shelves, grids and the page stack.
- **One travelling capsule.** `ui.Glider` puts a plate (selected) and a cap (focused) behind the tab
  bar and the sub-nav chips. Pills have no background of their own; the capsule moves on
  `transform` + `width` over `--t-cap`. Its first placement, and a cap that was hidden, are applied
  instantly (the "lands" rule). Pill offsets are measured once and cached.
- **Section changes.** The old screen or mode fades out over 70 ms while the new one rises 10–14 px
  and fades in. The first rows of a fresh page rise in one after another (60 ms apart, at most four
  rows); the first two rows of a grid stagger by row and column. Every delay is capped at 320 ms, and
  the classes are removed on `animationend` so no compositing layer lingers.
- **Images.** `ui.fadeInImage` skips the fade when the image is already decoded; otherwise the image
  starts at opacity 0 and scale 1.035 and settles in. The class is removed on load, so no layer is
  left behind.
- **Hero.** The backdrop crossfades (360 ms) as soon as focus lands; the text block does the 70/140
  out-swap-in, deduped so the same item never re-animates.
- **Title logos.** `ui.titleArt` requests the clearLogo as PNG through the transcoder, sizes it to
  the area budget inside a reserved box (hero 760×120, details 760×200, compact 520×96), and fades
  it in. It falls back to the text title on error or after 2.5 s. The box is reserved up front and
  the logo and text are absolutely positioned within it, so nothing below moves when the logo
  arrives.

- **A–Z rail.** The rail's letters never restyle. One marker element carries the letter: it slides on
  `transform` (240 ms) and switches between the soft pill and the focus plate by cross-fading two
  children on `opacity`; the letter underneath it fades out. A jump (`ui.Grid.jumpTo`) does *not*
  scroll across the gap, which would mean animating past hundreds of rows: the grid and the focus
  shadow land at once (`.instant` for two frames), the new rows appear as placeholder frames in the
  same frame and fade up from 25% over 140 ms, and posters dissolve in as they arrive. The jump fetches just
  the 36 titles it draws in one request (`Grid.loadWindow`) and holds the page prefetch until they're
  in, so the TV parses half the JSON before the cards show.
- **Player.** The controls fade (250 ms) as one layer. The rail's fills are `scaleX` transforms
  written at most four times a second (on `timeupdate`) while the controls are up, and not at all
  while they are hidden; while scrubbing, one write per frame (`PL.rafThrottle`). The head and the
  time bubble move by `translate3d`, the rail thickens with `scaleY`, and the skip pill and Up Next
  rise with `translate3d` when the controls open. Values are only written when they change, so an
  unchanged clock costs no layout, and while scrubbing only the bubble's text changes (the times
  stay on the real position). Measured on the TV (webOS 4.5, direct-play HEVC): controls up and
  idle 16.7 ms a frame; holding Right to scrub 17-20 ms average, p95 17-33 ms.

- **Focus marks (player and live controls).** Text never scales with focus. Chrome 53 paints a
  scaled element into its parent's layer at rest but draws it as a layer of its own while its
  transform animates, so text that scales is drawn two ways: on the TV a tab's label visibly jumped
  as its pop started and again as it landed (screen captures of the slowed transition: up to 220 of
  255 levels on 1,348 pixels between the last moving frame and the settled one, against 16 between
  the two frames before). So the focus is a mark that moves, and labels stay still: the round icons
  share one white disc and the tabs one capsule (and the open tab one plate), all `ui.Glider`, as on
  the tab bar; the subtitle and audio menus have one plate that travels with the list on the same
  spring (`--t-cap`); the end card's two buttons share a capsule; Info's button and the Skip pill
  light a plate behind the label (opacity, plus a 1.05 pop for Info); the mini guide has a still
  plate in the focus slot that the rows glide under. Labels switch ink as the mark reaches them,
  timed to when it covers them half way: 140 ms after a 90 ms delay on the tabs and the end card
  (as on the tab bar), 120 ms after 50 ms for the icons' and the menu's shorter hops, 100 ms after
  10 ms in the mini guide (its rows glide on `--ease`), 60 ms after 70 ms over an in-place plate,
  and at once when a hidden mark lands (it appears in place, so a delay would leave a blank plate). Only artwork
  pops (chapter and episode stills 1.08 from their centre, cast circles 1.13; their shadows fade), and it carries
  `will-change: transform` while focused, so it is a layer for as long as it is scaled and is drawn
  the same way moving and at rest. A card that loses focus drops its layer at scale 1, where both
  ways draw the same pixels.

Only `transform` and `opacity` animate (plus the capsule's `width`, a single small element). Rows
use `top` for placement so the entrance animations can own `transform`.
